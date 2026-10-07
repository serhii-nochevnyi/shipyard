'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const dispatch = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { defaultRunStoreDir, readRequestFile } = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');

const HOST = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
const CAPTURED_SHA256 = 'de94a486861cedd3587db16ba051e5c5bf80e0ab05fa44ed50ad48688e6f8b4c';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=t',
    '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function captured(relativePath, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>/g, (token) => values[token] || token))
    .join('\n') + '\n';
}

function fixtureData(gsdRole) {
  const parent = '01a0e224-6642-7f20-b2a3-68b283d429b9';
  const childId = '01a0e224-80bb-7d33-b57d-8c44061ac85d';
  const ids = { '<SESSION-2>': parent, '<SESSION-6>': childId };
  const childRaw = captured('tests/fixtures/captured/codex-agent-stream-child.jsonl', ids);
  const parentRaw = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', ids);
  const execRaw = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': parent });
  const records = childRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const elided = records.find((record) => record.type === 'response_item'
    && record.payload.role === 'developer').payload.content[0].text;
  const instructions = elided + '\n';
  const raw = childRaw.replace(JSON.stringify(elided), JSON.stringify(instructions));
  const transform = (source) => source.split('\n').filter(Boolean).map((line) => {
    const record = JSON.parse(line);
    if (record.type === 'turn_context') {
      record.payload.model = 'gpt-6.1-sol';
      record.payload.effort = 'high';
    }
    if (record.type === 'response_item' && record.payload.name === 'spawn_agent') {
      const args = JSON.parse(record.payload.arguments);
      args.agent_type = gsdRole;
      args.model = 'gpt-6.1-sol';
      args.reasoning_effort = 'high';
      record.payload.arguments = JSON.stringify(args);
    }
    if (record.type === 'session_meta' && record.payload.parent_thread_id === parent) {
      record.payload.agent_role = gsdRole;
      record.payload.source.subagent.thread_spawn.agent_role = gsdRole;
    }
    if (record.type === 'event_msg' && record.payload.type === 'task_complete') {
      const artifactPaths = gsdRole === 'gsd-phase-researcher'
        ? ['.planning/phases/45-detached-contract/45-RESEARCH.md']
        : gsdRole === 'gsd-planner' ? ['.planning/phases/45-detached-contract/45-01-PLAN.md'] : [];
      record.payload.last_agent_message = JSON.stringify({
        schema: 'shipyard.codex-decompose-output.v1', artifact_paths: artifactPaths,
      });
    }
    return JSON.stringify(record);
  }).join('\n') + '\n';
  return {
    parent, childId, instructions,
    parentRaw: transform(parentRaw), childRaw: transform(raw),
    execRaw,
  };
}

function mockCodexScript() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex 0.157.1\\n'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') {
  process.stdout.write('--json --model --config --cd --ignore-user-config\\n'); process.exit(0);
}
if (args[0] !== 'exec') { process.stderr.write('unexpected Codex invocation\\n'); process.exit(2); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const task = /^TASK_FILE=(.*)$/m.exec(input);
  const sha = /^TASK_SHA256=(.*)$/m.exec(input);
  if (!task || !sha) { process.stderr.write('missing task relay\\n'); process.exit(2); }
  const data = (name) => fs.readFileSync(path.join(process.env.MOCK_DATA_DIR, name), 'utf8');
  const codexHome = process.env.CODEX_HOME;
  const now = new Date();
  const sessions = path.join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(sessions, { recursive: true });
  const parent = data('parent.jsonl');
  const child = data('child.jsonl').split('<TMP>').join(JSON.stringify(task[1]).slice(1, -1))
    .split('__CAPTURED_SHA256__').join(sha[1]);
  fs.writeFileSync(path.join(sessions, 'rollout-__PARENT_SESSION__.jsonl'), parent);
  fs.writeFileSync(path.join(sessions, 'rollout-__CHILD_SESSION__.jsonl'), child);
  const phaseDir = path.join(process.cwd(), '.planning', 'phases', '45-detached-contract');
  fs.writeFileSync(path.join(phaseDir, '45-01-PLAN.md'), '# Detached plan\\n');
  if (process.env.MOCK_MUTATE_CONTEXT === '1') fs.appendFileSync(path.join(phaseDir, 'CONTEXT.md'), 'foreign mutation\\n');
  setTimeout(() => process.stdout.write(data('exec.jsonl')), 600);
});
`;
}

function createFixture({ installPlanner = true, includeDispatchId = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-decompose-wait-'));
  const rootPath = path.join(base, 'worktree');
  fs.mkdirSync(rootPath, { recursive: true });
  const root = fs.realpathSync(rootPath);
  const home = path.join(base, 'home');
  const codexHome = path.join(home, 'codex');
  const bin = path.join(base, 'bin');
  const graph = path.join(root, '.planning', 'graph');
  const phase = path.join(root, '.planning', 'phases', '45-detached-contract');
  const dataDir = path.join(base, 'mock-data');
  fs.mkdirSync(phase, { recursive: true });
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'shipyard'), { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'agents'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(phase, 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(root, 'source.cjs'), "'use strict';\n");
  fs.writeFileSync(path.join(root, '.gitignore'), '.planning/graph/\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'detached contract fixture');

  const gsdRole = 'gsd-planner';
  const data = fixtureData(gsdRole);
  fs.writeFileSync(path.join(dataDir, 'parent.jsonl'), data.parentRaw);
  fs.writeFileSync(path.join(dataDir, 'child.jsonl'), data.childRaw);
  fs.writeFileSync(path.join(dataDir, 'exec.jsonl'), data.execRaw);
  fs.writeFileSync(path.join(bin, 'codex'), mockCodexScript()
    .replaceAll('__PARENT_SESSION__', data.parent)
    .replaceAll('__CHILD_SESSION__', data.childId)
    .replaceAll('__CAPTURED_SHA256__', CAPTURED_SHA256), { mode: 0o755 });

  const capabilityFile = path.join(codexHome, 'shipyard', 'codex-capabilities.json');
  fs.writeFileSync(capabilityFile, JSON.stringify({
    supportedModels: ['gpt-6-luna', 'gpt-6.1-sol'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportedSelections: [{ model: 'gpt-6.1-sol', effort: 'high' }],
  }));
  if (installPlanner) {
    fs.writeFileSync(path.join(codexHome, 'agents', 'gsd-planner.toml'),
      'name = "gsd-planner"\ndescription = "Installed GSD gsd-planner"\nsandbox_mode = "workspace-write"\n'
      + "developer_instructions = '''\n" + data.instructions + "'''\n");
  }

  const preload = path.join(base, 'account-home.cjs');
  fs.writeFileSync(preload, "const os = require('node:os'); const original = os.userInfo; os.userInfo = (...args) => ({ ...original(...args), homedir: process.env.HOME });\n");
  const env = {
    NODE_OPTIONS: '--require=' + preload,
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: bin + path.delimiter + process.env.PATH,
    SHIPYARD_GRAPH_DIR: graph,
    MOCK_DATA_DIR: dataDir,
  };
  const request = path.join(base, 'request.json');
  const scope = {
    run_id: 'run-decompose-wait-' + crypto.randomBytes(5).toString('hex'),
    ticket: 'T-45-11', phase: 45, worktree: root, runtime: 'codex', provider: 'openai',
  };
  const dispatchId = installPlanner ? 'decompose-success-' + crypto.randomBytes(4).toString('hex')
    : 'decompose-refusal-' + crypto.randomBytes(4).toString('hex');
  const requestBody = { scope, gsd_role: gsdRole, prompt: 'Plan this phase.' };
  if (includeDispatchId) requestBody.dispatch_id = dispatchId;
  fs.writeFileSync(request, JSON.stringify(requestBody));
  return {
    base, root, home, codexHome, graph, env, request, dispatchId, data, scope,
    stateDir: path.join(home, '.local', 'state', 'shipyard', 'dispatch'),
    clean() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

function launch(f, detached = true, env = f.env) {
  return spawnSync(process.execPath, [HOST, ...(detached ? ['--detach'] : []), '--args-file', f.request], {
    cwd: f.root, env, encoding: 'utf8', timeout: 15000,
  });
}

function waitOptions(f) {
  return {
    stateDir: f.stateDir,
    timeoutMs: 15000,
    intervalMs: 10,
    clock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    recordWakeEvent() {},
  };
}

function retainedCallerAccounting(f, id, options = {}) {
  const planningHost = require('../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs');
  const stream = path.join(f.graph, overhead.STREAM_NAME);
  const before = fs.existsSync(stream) ? fs.readFileSync(stream) : null;
  const accounting = planningHost.readWaitAccounting({ scope: f.scope, dispatchId: id, graphDir: f.graph }, {
    testStateRoot: path.join(f.home, '.local', 'state', 'shipyard', 'codex-decompose'), ...options,
  });
  assert.equal(accounting.missing_evidence, null);
  assert.equal(accounting.run_id, f.scope.run_id);
  assert.equal(accounting.dispatch_id, id);
  assert.equal(accounting.graph_dir, f.graph);
  assert.ok(!accounting.sink.startsWith(f.root + path.sep));
  assert.ok(accounting.parent_rows.length > 0, 'real blocking waiter retains external parent rows');
  assert.ok(accounting.parent_rows.every(row => row.dispatch_id === id && row.run_id === f.scope.run_id
    && row.actor === 'parent' && row.stage === 'wait_poll' && row.counts.polls === 1
    && row.counts.model_turns === null && row.provider_tokens === null));
  assert.deepEqual(fs.existsSync(stream) ? fs.readFileSync(stream) : null, before, 'reporting leaves graph bytes unchanged');
  assert.ok(!overhead.readStream(f.graph).rows.some(row => row.actor === 'parent'));
  return accounting;
}

for (const includeDispatchId of [true, false]) {
test(`detached decomposition preserves ${includeDispatchId ? 'explicit' : 'omitted'} dispatch identity through wait`, async () => {
  const f = createFixture({ includeDispatchId });
  let childPid;
  try {
    const requestedDispatchId = includeDispatchId ? f.dispatchId : null;
    const launched = launch(f);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stderr, '');
    const handoff = JSON.parse(launched.stdout.trim());
    f.dispatchId = handoff.dispatch_id;
    if (requestedDispatchId !== null) assert.equal(handoff.dispatch_id, requestedDispatchId);
    assert.equal(handoff.dispatch_id, f.dispatchId);
    assert.equal(handoff.wait,
      `node ${path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs')} wait --dispatch ${f.dispatchId}`);

    const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, f.dispatchId, 'record.json'), 'utf8'));
    childPid = record.pid;
    assert.equal(fs.statSync(path.join(f.stateDir, f.dispatchId)).mode & 0o777, 0o700);
    assert.deepEqual(Object.keys(record).sort(), [
      'dispatch_id', 'ticket', 'role', 'runtime', 'graph_dir', 'pid', 'result', 'log', 'started_at',
    ].sort(), 'statusOnce depends on every delivered record.json field');
    assert.equal(record.dispatch_id, f.dispatchId);
    assert.equal(record.ticket, 'T-45-11');
    assert.equal(record.role, 'gsd-planner');
    assert.equal(record.runtime, 'codex');
    assert.equal(record.graph_dir, f.graph);
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
    assert.equal(path.basename(record.result), 'result.jsonl');
    assert.ok(fs.existsSync(record.log));
    const childRequestFile = path.join(f.stateDir, f.dispatchId, 'args.json');
    assert.equal(fs.statSync(childRequestFile).mode & 0o777, 0o600);
    const validatedChildRequest = readRequestFile(childRequestFile);
    assert.equal(validatedChildRequest.launch.dispatch_id, f.dispatchId);
    const live = dispatch.statusOnce(f.dispatchId, { stateDir: f.stateDir });
    assert.equal(live.status, 'running', 'the detached host pid remains live while the stub runtime executes');

    const waited = await dispatch.waitOnce(f.dispatchId, waitOptions(f));
    assert.equal(waited.status, 'exited-ok', fs.readFileSync(record.log, 'utf8'));
    assert.equal(waited.exit_code, 0);
    assert.equal(waited.result.receipt.compliance, 'verified');
    assert.equal(waited.result.receipt.gsd_role, 'gsd-planner');
    assert.equal(waited.result.receipt.dispatch_id, f.dispatchId);
    assert.equal(waited.result.receipt.requested_model, 'gpt-6.1-sol');
    assert.equal(waited.result.receipt.requested_effort, 'high');
    assert.equal(waited.result.receipt.observed_model, 'gpt-6.1-sol');
    assert.equal(waited.result.receipt.observed_effort, 'high');
    const childStoreDir = defaultRunStoreDir(f.scope,
      path.join(f.home, '.local', 'state', 'shipyard', 'codex-decompose'));
    const childRecorder = createDurableRecorder(path.join(path.dirname(childStoreDir), 'receipts'));
    const childReservation = childRecorder.getReservation(f.dispatchId);
    assert.equal(childReservation.dispatch_id, record.dispatch_id);
    assert.equal(childReservation.recorded, true);
    assert.equal(childRecorder.getVerifiedRecord(f.dispatchId).receipt.dispatch_id, f.dispatchId);

    const foregroundEnv = { ...f.env, HOME: path.join(f.base, 'foreground-home') };
    delete foregroundEnv.SHIPYARD_GRAPH_DIR;
    fs.rmSync(path.join(f.root, '.planning', 'phases', '45-detached-contract', '45-01-PLAN.md'));
    const foregroundRequest = path.join(f.base, 'foreground-request.json');
    const requestBody = JSON.parse(fs.readFileSync(f.request, 'utf8'));
    fs.writeFileSync(foregroundRequest, JSON.stringify({ ...requestBody, dispatch_id: f.dispatchId }));
    const foreground = spawnSync(process.execPath, [HOST, '--args-file', foregroundRequest], {
      cwd: f.root, env: foregroundEnv, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(foreground.status, 0, foreground.stderr);
    const foregroundResult = JSON.parse(foreground.stdout.trim());
    for (const field of ['compliance', 'gsd_role', 'requested_model', 'requested_effort',
      'dispatch_id', 'applied_model', 'applied_effort', 'observed_model', 'observed_effort']) {
      assert.equal(waited.result.receipt[field], foregroundResult.receipt[field],
        `detached and foreground receipts agree on ${field}`);
    }
    const foregroundStoreDir = defaultRunStoreDir(f.scope,
      path.join(foregroundEnv.HOME, '.local', 'state', 'shipyard', 'codex-decompose'));
    const foregroundRecorder = createDurableRecorder(path.join(path.dirname(foregroundStoreDir), 'receipts'));
    assert.equal(foregroundRecorder.getReservation(f.dispatchId).dispatch_id, f.dispatchId);
    assert.equal(foregroundRecorder.getVerifiedRecord(f.dispatchId).receipt.dispatch_id, f.dispatchId);
    assert.equal(foregroundResult.receipt.runtime_evidence.native_child_evidence.agent_role,
      waited.result.receipt.runtime_evidence.native_child_evidence.agent_role);

    const childRow = overhead.readStream(f.graph).rows.find((row) => row.actor === 'child');
    assert.ok(childRow, 'the verified detached child records model evidence');
    assert.equal(childRow.dispatch_id, f.dispatchId);
    assert.equal(childRow.model, waited.result.receipt.observed_model);
    assert.equal(childRow.effort, waited.result.receipt.observed_effort);
    assert.equal(childRow.requested_model, waited.result.receipt.requested_model);
    assert.equal(childRow.observed_model, waited.result.receipt.observed_model);
    const report = overhead.report({ graphDir: f.graph });
    assert.equal(report.verdict, 'inconclusive');
    assert.equal(Object.keys(report).some((key) => /percent/i.test(key)), false);

    let tick = 0;
    const timedOut = await dispatch.waitOnce(f.dispatchId, {
      ...waitOptions(f), pidLive: () => true, timeoutMs: 20, intervalMs: 10,
      clock: () => tick, sleep: async (ms) => { tick += ms; },
    });
    assert.equal(timedOut.status, 'running');
    assert.equal(timedOut.exit_code, 3);
  } finally {
    if (childPid && dispatch.pidLive(childPid)) {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
    }
    f.clean();
  }
});
}

test('detached host refusal has no JSON result and wait reports exited-failed', async () => {
  const f = createFixture({ installPlanner: false });
  let childPid;
  try {
    const launched = launch(f);
    assert.equal(launched.status, 0, launched.stderr);
    const handoff = JSON.parse(launched.stdout.trim());
    childPid = JSON.parse(fs.readFileSync(path.join(f.stateDir, handoff.dispatch_id, 'record.json'), 'utf8')).pid;
    const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, handoff.dispatch_id, 'record.json'), 'utf8'));
    const waited = await dispatch.waitOnce(handoff.dispatch_id, waitOptions(f));
    assert.equal(waited.status, 'exited-failed');
    assert.equal(waited.exit_code, 1);
    assert.equal(waited.result, undefined);
    assert.equal(fs.readFileSync(record.result, 'utf8').trim(), '',
      'a host refusal must not add a JSON line to result.jsonl');
    assert.match(fs.readFileSync(record.log, 'utf8'), /STALE_GSD_AGENT|installed GSD role/i);
  } finally {
    if (childPid && dispatch.pidLive(childPid)) {
      try { process.kill(childPid, 'SIGTERM'); } catch {}
    }
    f.clean();
  }
});

function planningRequest(f) {
  const { buildContextPacket } = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const { execFileSync } = require('node:child_process');
  const sourceRevision = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const subject = 'phase=45;input=detached-contract';
  const contextPacket = buildContextPacket({ root: f.root, role: 'decomposition', subject,
    sourceRevision, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: [] }, acceptance: [], verification: [], requiredRefs: ['source.cjs'],
    roleContext: { adr_refs: [{ path: 'source.cjs' }], requirements: [{ path: 'source.cjs' }],
      research_refs: [], context: { phase: 45, input: 'detached-contract' } } });
  const request = JSON.parse(fs.readFileSync(f.request, 'utf8'));
  fs.writeFileSync(f.request, JSON.stringify({ ...request, subject, sourceRevision,
    contextPacket, contextPacketRequired: true }), { mode: 0o600 });
  return contextPacket;
}

for (const includeDispatchId of [true, false]) {
  test(`supported planning caller blocks and measures the original ${includeDispatchId ? 'explicit' : 'generated'} dispatch`, () => {
    const f = createFixture({ includeDispatchId });
    try {
      const contextPacket = planningRequest(f);
      const planning = spawnSync(process.execPath, [path.resolve(__dirname,
        '../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs'), '--args-file', f.request],
      { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
      assert.equal(planning.status, 0, planning.stderr);
      const result = JSON.parse(planning.stdout.trim());
      assert.equal(result.status, 'completed');
      const id = result.receipt.dispatch_id;
      if (includeDispatchId) assert.equal(id, f.dispatchId);
      const records = fs.readdirSync(f.stateDir);
      assert.deepEqual(records, [id], 'one original detached child');
      const copied = JSON.parse(fs.readFileSync(path.join(f.stateDir, id, 'args.json'), 'utf8'));
      assert.equal(copied.dispatch_id, id);
      assert.ok(copied.prompt.includes(JSON.stringify(contextPacket)));
      const accounting = retainedCallerAccounting(f, id);
      const rows = [...accounting.child_rows, ...accounting.parent_rows];
      const parent = accounting.parent_rows;
      assert.ok(parent.length > 0, 'real blocking waiter emits parent rows');
      assert.ok(parent.every((row) => row.dispatch_id === id && row.run_id === f.scope.run_id
        && row.stage === 'wait_poll' && row.counts.polls === 1));
      const child = rows.find((row) => row.actor === 'child');
      assert.equal(child.dispatch_id, id);
      assert.equal(child.counts.model_turns, null);
      assert.equal(accounting.report.verdict, 'inconclusive');
    } finally { f.clean(); }
  });
}

test('actual caller timeout resumes the original child with frozen context and authentic receipt', async () => {
  const f = createFixture();
  let childPid;
  try {
    planningRequest(f);
    const planningHost = require('../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs');
    const host = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
    let launches = 0;
    let parentArgs;
    const options = { stateDir: f.stateDir, env: f.env,
      testStateRoot: path.join(f.home, '.local', 'state', 'shipyard', 'codex-decompose'),
      runHost: async (argv, stdout, opts) => {
        launches++;
        parentArgs = argv[2];
        return host.runCli(argv, stdout, opts);
      } };
    await assert.rejects(() => planningHost.runCli(['--args-file', f.request], { write() {} }, {
      ...options, waitOptions: { timeoutMs: 1, intervalMs: 1 } }),
    (error) => error.code === 'DISPATCH_TIMEOUT' && error.dispatch_id === f.dispatchId);
    childPid = JSON.parse(fs.readFileSync(path.join(f.stateDir, f.dispatchId, 'record.json'), 'utf8')).pid;
    assert.equal(fs.existsSync(parentArgs), false);
    const context = path.join(f.root, '.planning', 'phases', '45-detached-contract', 'CONTEXT.md');
    const frozen = fs.readFileSync(context);
    let output = '';
    const completed = await planningHost.runCli(['--args-file', f.request], { write(chunk) { output += chunk; } }, {
      ...options, waitOptions: waitOptions(f) });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.receipt.dispatch_id, f.dispatchId);
    assert.equal(launches, 1);
    assert.deepEqual(fs.readFileSync(context), frozen);
    const accounting = retainedCallerAccounting(f, f.dispatchId, options);
    const rows = [...accounting.child_rows, ...accounting.parent_rows];
    assert.ok(rows.some((row) => row.actor === 'parent'));
    const before = rows.length;
    const repeated = await planningHost.runCli(['--args-file', f.request], { write() {} }, options);
    assert.equal(repeated.receipt.dispatch_id, f.dispatchId);
    assert.equal(launches, 1);
    const repeatedAccounting = retainedCallerAccounting(f, f.dispatchId, options);
    assert.equal(repeatedAccounting.child_rows.length + repeatedAccounting.parent_rows.length, before,
      'terminal re-wait adds no observer');
    assert.deepEqual(repeatedAccounting.parent_rows, accounting.parent_rows);
    // Keep the authentic stored receipt intact while testing a foreign readable result.
    const resultFile = path.join(f.stateDir, f.dispatchId, 'result.jsonl');
    fs.writeFileSync(resultFile, JSON.stringify({ ...completed,
      receipt: { ...completed.receipt, observed_model: 'foreign-model' } }) + '\n');
    await assert.rejects(() => planningHost.runCli(['--args-file', f.request], { write() {} }, options),
      (error) => error.code === 'UNVERIFIED_RECEIPT');
    assert.equal(launches, 1);
  } finally {
    if (childPid && dispatch.pidLive(childPid)) { try { process.kill(childPid, 'SIGTERM'); } catch {} }
    f.clean();
  }
});

test('actual planning child refuses mutation of frozen context without a completion receipt', () => {
  const f = createFixture();
  try {
    planningRequest(f);
    const context = path.join(f.root, '.planning', 'phases', '45-detached-contract', 'CONTEXT.md');
    const original = fs.readFileSync(context, 'utf8');
    const planning = spawnSync(process.execPath, [path.resolve(__dirname,
      '../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs'), '--args-file', f.request],
    { cwd: f.root, env: { ...f.env, MOCK_MUTATE_CONTEXT: '1' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(planning.status, 1);
    assert.equal(planning.stdout, '');
    const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, f.dispatchId, 'record.json'), 'utf8'));
    assert.match(fs.readFileSync(record.log, 'utf8'), /phase delta|declaration|foreign/i);
    assert.equal(fs.readFileSync(record.result, 'utf8'), '');
    assert.equal(fs.readFileSync(context, 'utf8'), original + 'foreign mutation\n',
      'the refusal retains the original mutation evidence');
  } finally { f.clean(); }
});
