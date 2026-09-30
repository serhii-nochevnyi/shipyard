'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const dispatch = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
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
      record.payload.model = 'gpt-6-sol';
      record.payload.effort = 'high';
    }
    if (record.type === 'response_item' && record.payload.name === 'spawn_agent') {
      const args = JSON.parse(record.payload.arguments);
      args.agent_type = gsdRole;
      args.model = 'gpt-6-sol';
      args.reasoning_effort = 'high';
      record.payload.arguments = JSON.stringify(args);
    }
    if (record.type === 'session_meta' && record.payload.parent_thread_id === parent) {
      record.payload.agent_role = gsdRole;
      record.payload.source.subagent.thread_spawn.agent_role = gsdRole;
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
    supportedModels: ['gpt-6-luna', 'gpt-6-sol'],
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportedSelections: [{ model: 'gpt-6-sol', effort: 'high' }],
  }));
  if (installPlanner) {
    fs.writeFileSync(path.join(codexHome, 'agents', 'gsd-planner.toml'),
      'name = "gsd-planner"\ndescription = "Installed GSD gsd-planner"\nsandbox_mode = "workspace-write"\n'
      + "developer_instructions = '''\n" + data.instructions + "'''\n");
  }

  const env = {
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
    base, root, home, codexHome, graph, env, request, dispatchId, data,
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

test('detached decomposition result follows deliver-dispatch wait and refusal never becomes JSON', async () => {
  const f = createFixture({ includeDispatchId: false });
  let childPid;
  try {
    const launched = launch(f);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stderr, '');
    const handoff = JSON.parse(launched.stdout.trim());
    f.dispatchId = handoff.dispatch_id;
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
    const live = dispatch.statusOnce(f.dispatchId, { stateDir: f.stateDir });
    assert.equal(live.status, 'running', 'the detached host pid remains live while the stub runtime executes');

    const waited = await dispatch.waitOnce(f.dispatchId, waitOptions(f));
    assert.equal(waited.status, 'exited-ok', fs.readFileSync(record.log, 'utf8'));
    assert.equal(waited.exit_code, 0);
    assert.equal(waited.result.receipt.compliance, 'verified');
    assert.equal(waited.result.receipt.gsd_role, 'gsd-planner');
    assert.equal(waited.result.receipt.dispatch_id, f.dispatchId);
    assert.equal(waited.result.receipt.requested_model, 'gpt-6-sol');
    assert.equal(waited.result.receipt.requested_effort, 'high');
    assert.equal(waited.result.receipt.observed_model, 'gpt-6-sol');
    assert.equal(waited.result.receipt.observed_effort, 'high');

    const foregroundEnv = { ...f.env, HOME: path.join(f.base, 'foreground-home') };
    delete foregroundEnv.SHIPYARD_GRAPH_DIR;
    const foreground = launch(f, false, foregroundEnv);
    assert.equal(foreground.status, 0, foreground.stderr);
    const foregroundResult = JSON.parse(foreground.stdout.trim());
    for (const field of ['compliance', 'gsd_role', 'requested_model', 'requested_effort',
      'applied_model', 'applied_effort', 'observed_model', 'observed_effort']) {
      assert.equal(waited.result.receipt[field], foregroundResult.receipt[field],
        `detached and foreground receipts agree on ${field}`);
    }
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
      try { process.kill(childPid, 'SIGTERM'); } catch { /* already exited */ }
    }
    f.clean();
  }
});

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
      try { process.kill(childPid, 'SIGTERM'); } catch { /* already exited */ }
    }
    f.clean();
  }
});
