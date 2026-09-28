'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { codexStaticVariants } = require('../../plugins/delivery-pipeline/scripts/gsd-tune.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const { createPlanningWriterLease } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');
const {
  createCodexDecomposeHost, defaultRunStoreDir, parseCliArguments, parseRecoverArguments, readRequestFile, requestValue, runCli,
} = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportedSelections: [{ model: 'gpt-6-sol', effort: 'high' }],
};

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=t',
    '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function headRevision(root) {
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

function researchVariant(rung) {
  return codexStaticVariants(2).find((variant) => variant.role === 'research' && variant.rung === rung);
}

function gsdAgentToml(role, instructions) {
  const sandbox = role === 'gsd-plan-checker' ? 'read-only'
    : role === 'gsd-phase-researcher'
      ? codexStaticVariants(2).find((variant) => variant.role === 'research').sandbox : 'workspace-write';
  return 'name = "' + role + '"\ndescription = "Installed GSD ' + role + '"\nsandbox_mode = "' + sandbox + '"\n'
    + "developer_instructions = '''\n" + instructions + "\n'''\n";
}

function writeArtifacts(root, gsdRole) {
  const phaseDir = path.join(root, '.planning', 'phases', '38-codex-decompose');
  if (gsdRole === 'gsd-phase-researcher') fs.writeFileSync(path.join(phaseDir, '38-RESEARCH.md'), '# Research\n');
  if (gsdRole === 'gsd-planner') fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Plan\n');
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-decompose-')));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-decompose-state-'));
  const codexHome = path.join(root, 'codex-home');
  const agentDir = path.join(codexHome, 'agents');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  fs.mkdirSync(path.join(root, '.planning', 'phases', '38-codex-decompose'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'phases', '38-codex-decompose', 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(root, 'source.cjs'), "'use strict';\n");
  fs.writeFileSync(path.join(root, '.gitignore'), 'codex-home/\nreceipts/\n*request.json\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  for (const role of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
    fs.writeFileSync(path.join(agentDir, role + '.toml'),
      gsdAgentToml(role, 'Perform the exact installed ' + role + ' role.'));
  }
  const resolved = policy.resolveDispatch({ runtime: 'codex', role: 'research' });
  const variant = researchVariant(resolved.rung);
  const researchContent = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + resolved.policy_version + '"',
    '# shipyard-policy-hash = "' + resolved.policy_hash + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "' + resolved.rung + '"',
    'name = "shipyard-inv-research"',
    'model = "' + variant.model + '"',
    'model_reasoning_effort = "' + variant.effort + '"',
    'sandbox_mode = "' + variant.sandbox + '"',
    "developer_instructions = '''",
    'Follow the generated research policy.',
    "'''",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(agentDir, resolved.agent_file), researchContent);
  const researchDigest = crypto.createHash('sha256').update(researchContent).digest('hex');
  fs.writeFileSync(path.join(agentDir, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id,
    policy_version: resolved.policy_version,
    policy_hash: resolved.policy_hash,
    agent_files: [resolved.agent_file],
    agent_digests: { [resolved.agent_file]: researchDigest },
  }));
  const scope = {
    run_id: 'run-codex-decompose-test', ticket: 'T-38-04', phase: 38,
    worktree: root, runtime: 'codex', provider: 'openai',
  };
  const calls = [];
  const state = { write: writeArtifacts };
  const host = {
    scope, capabilities,
    recorder: createDurableRecorder(path.join(stateRoot, 'receipts')),
    async launchTypedGsd(selection, context) {
      calls.push({ selection, context });
      state.write(root, context.gsd_role);
      return {
        launch_id: 'codex-decompose-' + calls.length,
        applied_model: selection.model,
        applied_effort: selection.reasoning_effort,
        observed_model: selection.model,
        observed_effort: selection.reasoning_effort,
        gsd_role: context.gsd_role,
        gsd_launch_mechanism: 'typed-gsd-callback',
      };
    },
  };
  return {
    root, stateRoot, codexHome, agentDir, scope, host, calls, researchDigest, state,
    create: (over = {}) => createCodexDecomposeHost({
      scope, host, env: { CODEX_HOME: codexHome }, agentDir, sealRoot: path.join(stateRoot, 'sealed'),
      agentManifest: path.join(agentDir, '.shipyard-manifest.json'), ...over,
    }),
    clean: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

for (const [gsdRole, logicalRole, sandbox] of [
  ['gsd-phase-researcher', 'research', 'workspace-write'],
  ['gsd-planner', 'decomposition', 'workspace-write'],
  ['gsd-plan-checker', 'decomposition', 'read-only'],
]) {
  test(gsdRole + ' resolves and records one typed ADR-014 launch', async () => {
    const f = fixture();
    try {
      const result = await f.create().run({ gsd_role: gsdRole, prompt: 'Plan this phase.' });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].selection.model, 'gpt-6-sol');
      assert.equal(f.calls[0].selection.reasoning_effort, 'high');
      assert.equal(f.calls[0].selection.sandbox_mode || f.calls[0].context.sandbox_mode, sandbox);
      assert.equal(f.calls[0].context.gsd_role, gsdRole);
      assert.equal(f.calls[0].context.provider, 'openai');
      assert.equal(result.receipt.role, logicalRole);
      assert.equal(result.receipt.gsd_role, gsdRole);
      assert.equal(result.receipt.gsd_launch_mechanism, 'typed-gsd-callback');
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.applied_model, 'gpt-6-sol');
      assert.equal(result.receipt.applied_effort, 'high');
      if (logicalRole === 'research') {
        assert.match(f.calls[0].context.prompt, /^Follow the generated research policy\./);
        assert.equal(result.receipt.agent_file_digest, f.researchDigest);
        assert.equal(f.calls[0].selection.agent_file_content, undefined);
        assert.equal(result.schema, 'shipyard.research-result.v1');
        assert.equal(result.artifact_path, path.join(f.root, '.planning', 'phases', '38-codex-decompose', '38-RESEARCH.md'));
        const entries = JSON.parse(fs.readFileSync(result.artifact_index.path, 'utf8')).entries;
        assert.deepEqual(entries.map((entry) => entry.path), [result.artifact_path]);
        assert.equal(entries[0].sha256, crypto.createHash('sha256').update('# Research\n').digest('hex'));
        assert.equal(path.relative(f.root, result.artifact_index.path).startsWith('..'), true);
      } else if (gsdRole === 'gsd-planner') {
        assert.equal(f.calls[0].context.prompt, 'Plan this phase.');
        assert.equal(result.schema, 'shipyard.decomposition-result.v1');
        assert.equal(result.plan_count, 2);
        assert.match(result.artifact_index.sha256, /^[a-f0-9]{64}$/);
      } else {
        assert.equal(f.calls[0].context.prompt, 'Plan this phase.');
      }
    } finally { f.clean(); }
  });
}

test('researcher and planner writes outside their contained paths refuse with every path named', async () => {
  for (const gsdRole of ['gsd-phase-researcher', 'gsd-planner']) {
    const f = fixture();
    try {
      f.state.write = (root, role) => {
        writeArtifacts(root, role);
        fs.appendFileSync(path.join(root, 'source.cjs'), '// extra\n');
        fs.writeFileSync(path.join(root, 'stray.md'), 'stray\n');
      };
      await assert.rejects(() => f.create().run({ gsd_role: gsdRole, prompt: 'Research.' }), (error) =>
        error.code === 'CONTAINMENT_VIOLATION' && /source\.cjs/.test(error.message) && /stray\.md/.test(error.message));
    } finally { f.clean(); }
  }
});

test('the researcher artifact path is computed by the host and a missing artifact refuses', async () => {
  const f = fixture();
  try {
    f.state.write = () => {};
    await assert.rejects(() => f.create().run({ gsd_role: 'gsd-phase-researcher', prompt: 'Research.' }),
      (error) => error.code === 'MISSING_ARTIFACT');
  } finally { f.clean(); }
});

test('generated research variant and GSD researcher are workspace-write; plan-checker stays read-only', () => {
  const f = fixture();
  try {
    for (const variant of codexStaticVariants(2).filter((entry) => entry.role === 'research')) {
      assert.equal(variant.sandbox, 'workspace-write');
    }
    assert.match(fs.readFileSync(path.join(f.agentDir, 'gsd-phase-researcher.toml'), 'utf8'),
      /sandbox_mode = "workspace-write"/);
    assert.match(fs.readFileSync(path.join(f.agentDir, 'gsd-plan-checker.toml'), 'utf8'),
      /sandbox_mode = "read-only"/);
  } finally { f.clean(); }
});

test('unsupported role, injected selection and foreign scope refuse before launch', async () => {
  const f = fixture();
  try {
    const host = f.create();
    for (const request of [
      { gsd_role: 'gsd-executor', prompt: 'Run.' },
      { gsd_role: 'gsd-planner', prompt: 'Run.', model: 'gpt-6-luna' },
      { gsd_role: 'gsd-planner', prompt: 'Run.', config_file: '/tmp/foreign.toml' },
      { gsd_role: 'gsd-planner', prompt: 'Run.', context: { provider: 'anthropic' } },
    ]) {
      await assert.rejects(() => host.run(request), (error) =>
        ['UNSUPPORTED_ROLE', 'INVALID_INPUT'].includes(error.code));
    }
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.create({ scope: { ...f.scope, provider: 'anthropic' } }),
      (error) => error.code === 'RUNTIME_PROVIDER_MISMATCH');
  } finally { f.clean(); }
});

test('missing or conflicting installed role refuses before launch and receipt', async () => {
  const f = fixture();
  try {
    const file = path.join(f.agentDir, 'gsd-planner.toml');
    fs.appendFileSync(file, 'model = "gpt-6-luna"\n');
    await assert.rejects(() => f.create().run({ gsd_role: 'gsd-planner', prompt: 'Plan.' }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
    assert.equal(f.calls.length, 0);
    fs.unlinkSync(file);
    await assert.rejects(() => f.create().run({ gsd_role: 'gsd-planner', prompt: 'Plan.' }),
      (error) => error.code === 'STALE_GSD_AGENT');
    assert.equal(f.calls.length, 0);
  } finally { f.clean(); }
});

test('stale generated research handoff refuses before launch', async () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.agentDir, 'shipyard-inv-research.toml'), '# changed\n');
    await assert.rejects(() => f.create().run({ gsd_role: 'gsd-phase-researcher', prompt: 'Research.' }),
      (error) => error.code === 'STALE_GENERATED_AGENT');
    assert.equal(f.calls.length, 0);
  } finally { f.clean(); }
});

test('contradictory native child evidence never becomes a durable receipt', async () => {
  const f = fixture();
  try {
    f.host.requireRuntimeEvidence = true;
    const launch = f.host.launchTypedGsd;
    f.host.launchTypedGsd = async (selection, context) => ({
      ...await launch(selection, context),
      session_id: 'parent-session',
      runtime_evidence: { native_child_evidence: {
        agent_role: 'gsd-phase-researcher', parent_thread_id: 'parent-session',
        agent_file: path.join(f.agentDir, 'gsd-phase-researcher.toml'),
        agent_file_digest: '0'.repeat(64), provider: 'openai',
      } },
    });
    await assert.rejects(() => f.create().run({ gsd_role: 'gsd-planner', prompt: 'Plan.' }),
      (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
    assert.equal(fs.readdirSync(path.join(f.stateRoot, 'receipts')).filter((name) => name.startsWith('record-')).length, 0);
  } finally { f.clean(); }
});

test('CLI accepts only a bounded scope and typed request file', () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    assert.equal(parseCliArguments(['--args-file', file]), file);
    assert.deepEqual(readRequestFile(file).launch, requestValue({ gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    assert.throws(() => parseCliArguments(['--args-file', file, '--module', 'foreign']),
      (error) => error.code === 'INVALID_INPUT');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.', host: './foreign.cjs' }));
    assert.throws(() => readRequestFile(file), (error) => error.code === 'INVALID_INPUT');
    fs.writeFileSync(file, JSON.stringify({ scope: { ...f.scope, module: './foreign.cjs' },
      gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    assert.throws(() => readRequestFile(file), (error) => error.code === 'INVALID_INPUT');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner',
      prompt: 'Plan.', runStoreDir: path.join(f.root, 'runs') }));
    assert.throws(() => readRequestFile(file), (error) => error.code === 'INVALID_INPUT');
  } finally { f.clean(); }
});

test('spawning with bad argv exits 1, keeps the first stderr line, and appends a hint line', () => {
  const scriptPath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n');
  assert.equal(lines[0], 'codex-decompose-host: codex-decompose-host: usage: codex-decompose-host.cjs --args-file <json>');
  assert.match(lines[1], /^hint\[INVALID_INPUT\]: /);
});

test('default run controller state is outside the model worktree and keyed to it', () => {
  const f = fixture();
  try {
    const storeDir = defaultRunStoreDir(f.scope, f.stateRoot);
    assert.equal(path.relative(f.root, storeDir).startsWith('..'), true);
    assert.match(storeDir, /[a-f0-9]{64}[/\\]runs$/);
    assert.throws(() => defaultRunStoreDir(f.scope, path.join(f.root, '.planning')),
      (error) => error.code === 'INVALID_STATE_DIR');
  } finally { f.clean(); }
});

const CAPTURED_SHA256 = 'de94a486861cedd3587db16ba051e5c5bf80e0ab05fa44ed50ad48688e6f8b4c';

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>/g, (token) => values[token] || token))
    .join('\n') + '\n';
}

function manualClock(start) {
  let value = start;
  const clock = () => value;
  clock.advance = (ms) => { value += ms; };
  return clock;
}

function manualHeartbeat() {
  let tick = null;
  return {
    scheduler: Object.freeze({
      start(fn, _ms) {
        tick = fn;
        return () => { tick = null; };
      },
    }),
    fire() {
      assert.equal(typeof tick, 'function', 'heartbeat scheduler must be started before firing');
      tick();
    },
  };
}

function buildNativeChildFixture(gsdRole) {
  const parent = '01a0e224-6642-7f20-b2a3-68b283d429b9';
  const childId = '01a0e224-80bb-7d33-b57d-8c44061ac85d';
  const ids = { '<SESSION-2>': parent, '<SESSION-6>': childId };
  const recorded = captured('tests/fixtures/captured/codex-agent-stream-child.jsonl', ids);
  const parentRaw = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', ids);
  const execRaw = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': parent });
  const records = recorded.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const elided = records.find((record) => record.type === 'response_item'
    && record.payload.role === 'developer').payload.content[0].text;
  const instructions = elided + '\n';
  const childRaw = recorded.replace(JSON.stringify(elided), JSON.stringify(instructions));
  const transform = (raw) => raw.split('\n').filter(Boolean).map((line) => {
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
  return { parent, childId, instructions, parentRaw, childRaw, execRaw, transform };
}

function attachFakeSpawn(f, gsdRole, fixtureData, onSpawn) {
  const { parent, childId, parentRaw, childRaw, execRaw, transform } = fixtureData;
  const calls = [];
  const spawn = (_executable, args, options) => {
    calls.push({ args, options });
    writeArtifacts(f.root, gsdRole);
    if (onSpawn) onSpawn();
    const sent = [];
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.stdin = {
      write(value) { sent.push(String(value)); },
      end() {
        const task = /^TASK_FILE=(.*)$/m.exec(sent.join(''))[1];
        const sha256 = /^TASK_SHA256=(.*)$/m.exec(sent.join(''))[1];
        const now = new Date();
        const dir = path.join(f.codexHome, 'sessions', String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'rollout-' + parent + '.jsonl'), transform(parentRaw));
        fs.writeFileSync(path.join(dir, 'rollout-' + childId + '.jsonl'), transform(childRaw)
          .split('<TMP>').join(JSON.stringify(task).slice(1, -1)).split(CAPTURED_SHA256).join(sha256));
      },
    };
    process.pid = 38004;
    setTimeout(() => {
      process.stdout.emit('data', Buffer.from(execRaw));
      process.emit('close', 0, null);
    }, 170);
    return process;
  };
  return { spawn, calls };
}

for (const gsdRole of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
test('production ' + gsdRole + ' reaches its native child and records session evidence', async () => {
  const f = fixture();
  const fixtureData = buildNativeChildFixture(gsdRole);
  const { parent, childId, instructions } = fixtureData;
  const clock = manualClock(Date.now());
  const heartbeat = manualHeartbeat();
  try {
    fs.writeFileSync(path.join(f.agentDir, gsdRole + '.toml'), gsdAgentToml(gsdRole, instructions.replace(/\n$/, '')));
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: gsdRole, prompt: 'Check this phase plan.' }));
    const output = [];
    const { spawn, calls } = attachFakeSpawn(f, gsdRole, fixtureData, () => {
      clock.advance(50);
      heartbeat.fire();
    });
    const result = await runCli(['--args-file', file], { write(value) { output.push(value); } }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      testStateRoot: f.stateRoot,
      leaseTtlMs: 1000,
      now: clock,
      heartbeat: heartbeat.scheduler,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
      spawn,
    });
    const storeDir = defaultRunStoreDir(f.scope, f.stateRoot);
    const status = createRunController({ storeDir })
      .status(f.scope.run_id);
    assert.ok(fs.existsSync(path.join(storeDir, 'runs.json')));
    assert.ok(fs.existsSync(path.join(path.dirname(storeDir), 'receipts')));
    assert.ok(fs.existsSync(path.join(path.dirname(storeDir), 'transcripts')));
    assert.equal(fs.existsSync(path.join(f.root, '.planning', 'graph', 'runs')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.planning', 'graph', 'receipts')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.planning', 'graph', 'transcripts')), false);
    assert.equal(status.state, 'completed');
    assert.equal(status.owner.status, 'completed');
    assert.ok(status.owner.heartbeat_at > status.owner.acquired_at);
    assert.equal(status.scope.dispatch.dispatch_id, result.receipt.dispatch_id);
    assert.equal(status.scope.dispatch.model, 'gpt-6-sol');
    assert.equal(status.scope.dispatch.effort, 'high');
    assert.equal(status.scope.runtime.runtime, 'codex');
    assert.equal(status.scope.runtime.provider, 'openai');
    assert.equal(result.receipt.runtime_evidence.run_id, f.scope.run_id);
    assert.equal(result.receipt.runtime_evidence.ticket, f.scope.ticket);
    assert.equal(result.receipt.runtime_evidence.phase, f.scope.phase);
    assert.equal(result.receipt.runtime_evidence.worktree, f.scope.worktree);
    assert.equal(JSON.parse(output.join('')).receipt.dispatch_id, result.receipt.dispatch_id);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('agents.' + gsdRole + '.config_file='
      + JSON.stringify(path.join(f.agentDir, gsdRole + '.toml'))));
    assert.equal(result.receipt.applied_model, 'gpt-6-sol');
    assert.equal(result.receipt.applied_effort, 'high');
    assert.equal(result.receipt.runtime_evidence.native_child_evidence.session_id, childId);
    assert.equal(result.receipt.runtime_evidence.native_child_evidence.parent_thread_id, parent);
    assert.equal(result.receipt.runtime_evidence.native_child_evidence.agent_role, gsdRole);
    if (gsdRole === 'gsd-plan-checker') {
      assert.ok(calls[0].args.includes('permissions.shipyard-runtime.extends=":read-only"'));
      assert.match(fs.readFileSync(path.join(f.agentDir, gsdRole + '.toml'), 'utf8'),
        /sandbox_mode = "read-only"/);
    }
  } finally { f.clean(); }
});
}

test('advancing the injected clock past the lease TTL with no heartbeat still refuses with LEASE_EXPIRED', async () => {
  const f = fixture();
  const gsdRole = 'gsd-planner';
  const fixtureData = buildNativeChildFixture(gsdRole);
  const clock = manualClock(Date.now());
  const heartbeat = manualHeartbeat();
  try {
    fs.writeFileSync(path.join(f.agentDir, gsdRole + '.toml'),
      gsdAgentToml(gsdRole, fixtureData.instructions.replace(/\n$/, '')));
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: gsdRole, prompt: 'Check this phase plan.' }));
    const { spawn } = attachFakeSpawn(f, gsdRole, fixtureData, () => {
      clock.advance(5000);
    });
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      testStateRoot: f.stateRoot,
      leaseTtlMs: 1000,
      now: clock,
      heartbeat: heartbeat.scheduler,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
      spawn,
    }), (error) => error.code === 'LEASE_EXPIRED');
    const storeDir = defaultRunStoreDir(f.scope, f.stateRoot);
    const status = createRunController({ storeDir, now: clock }).status(f.scope.run_id);
    assert.notEqual(status.state, 'completed');
    assert.equal(status.owner.status, 'expired');
  } finally { f.clean(); }
});

test('standalone CLI records a failed owned run after launch preflight refusal', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    fs.appendFileSync(path.join(f.agentDir, 'gsd-planner.toml'), 'model = "gpt-6-luna"\n');
    const output = [];
    await assert.rejects(() => runCli(['--args-file', file], { write(value) { output.push(value); } }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      testStateRoot: f.stateRoot,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
    }), (error) => error.code === 'CONFLICTING_OVERRIDE');
    const status = createRunController({ storeDir: defaultRunStoreDir(f.scope, f.stateRoot) })
      .status(f.scope.run_id);
    assert.equal(status.state, 'failed');
    assert.equal(status.owner.status, 'failed');
    assert.deepEqual(output, []);
  } finally { f.clean(); }
});

test('standalone CLI owns runtime unavailability and fails the run', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      testStateRoot: f.stateRoot,
      probe: { status: 'unavailable', reason: 'runtime_missing' },
    }), (error) => error.code === 'RUNTIME_UNAVAILABLE');
    const status = createRunController({ storeDir: defaultRunStoreDir(f.scope, f.stateRoot) })
      .status(f.scope.run_id);
    assert.equal(status.state, 'failed');
    assert.equal(status.owner.status, 'failed');
    assert.equal(status.scope.runtime.provider, 'openai');
  } finally { f.clean(); }
});

test('a second session planning the same worktree and phase is refused with WRITER_LEASED before any model launch', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    const leaseStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-'));
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-codex-decompose');
    const writerLease = createPlanningWriterLease({ worktree: f.root, phaseDir, stateRoot: leaseStateRoot });
    writerLease.acquire({ owner: 'other-session', base_revision: headRevision(f.root) });
    let spawnCalls = 0;
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      testStateRoot: f.stateRoot,
      writerLease,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
      spawn: () => { spawnCalls += 1; throw new Error('spawn should not be called'); },
    }), (error) => error.code === 'WRITER_LEASED');
    assert.equal(spawnCalls, 0);
  } finally { f.clean(); }
});

test('different phases in the same worktree do not contend for the planning writer lease', async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    const leaseStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-'));
    const otherPhaseLease = createPlanningWriterLease({
      worktree: f.root, phaseDir: path.join(f.root, '.planning', 'phases', '39-other-codex-decompose'), stateRoot: leaseStateRoot,
    });
    otherPhaseLease.acquire({ owner: 'holder-of-phase-39', base_revision: headRevision(f.root) });
    const phase38Lease = createPlanningWriterLease({
      worktree: f.root, phaseDir: path.join(f.root, '.planning', 'phases', '38-codex-decompose'), stateRoot: leaseStateRoot,
    });
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      testStateRoot: f.stateRoot,
      writerLease: phase38Lease,
      probe: { status: 'unavailable', reason: 'runtime_missing' },
    }), (error) => error.code === 'RUNTIME_UNAVAILABLE');
  } finally { f.clean(); }
});

test('a lease takeover before sealing refuses with WRITER_FENCED and seals nothing', async () => {
  const f = fixture();
  try {
    let clock = 1_000;
    const leaseStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-'));
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-codex-decompose');
    const writerLease = createPlanningWriterLease({
      worktree: f.root, phaseDir, stateRoot: leaseStateRoot, now: () => clock, ttlMs: 100,
    });
    const leaseHandle = writerLease.acquire({ owner: 'run-a', base_revision: headRevision(f.root) });
    const snapshot = writerLease.snapshotTree();
    const launch = f.host.launchTypedGsd;
    f.host.launchTypedGsd = async (selection, context) => {
      clock += 500;
      writerLease.acquire({ owner: 'intruder', base_revision: headRevision(f.root) });
      return launch(selection, context);
    };
    await assert.rejects(() => f.create({
      lease: { writerLease, token: leaseHandle.token, epoch: leaseHandle.epoch, snapshot },
    }).run({ gsd_role: 'gsd-planner', prompt: 'Plan.' }), (error) => error.code === 'WRITER_FENCED');
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'sealed', 'decomposition-index')), false);
  } finally { f.clean(); }
});

test('a foreign edit to the phase directory mid-run refuses with FOREIGN_EDIT, naming the path', async () => {
  const f = fixture();
  try {
    const leaseStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-'));
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-codex-decompose');
    const writerLease = createPlanningWriterLease({ worktree: f.root, phaseDir, stateRoot: leaseStateRoot });
    const leaseHandle = writerLease.acquire({ owner: 'run-a', base_revision: headRevision(f.root) });
    const snapshot = writerLease.snapshotTree();
    const launch = f.host.launchTypedGsd;
    f.host.launchTypedGsd = async (selection, context) => {
      fs.writeFileSync(path.join(phaseDir, 'stray.md'), 'stray\n');
      return launch(selection, context);
    };
    await assert.rejects(() => f.create({
      lease: { writerLease, token: leaseHandle.token, epoch: leaseHandle.epoch, snapshot },
    }).run({ gsd_role: 'gsd-planner', prompt: 'Plan.' }),
      (error) => error.code === 'FOREIGN_EDIT' && /stray\.md/.test(error.message));
    assert.equal(fs.existsSync(path.join(f.stateRoot, 'sealed', 'decomposition-index')), false);
  } finally { f.clean(); }
});

test('the planning writer lease releases on success and on failure so a following run acquires immediately', async () => {
  const f = fixture();
  const fixtureData = buildNativeChildFixture('gsd-planner');
  const clock = manualClock(Date.now());
  const heartbeat = manualHeartbeat();
  try {
    fs.writeFileSync(path.join(f.agentDir, 'gsd-planner.toml'), gsdAgentToml('gsd-planner', fixtureData.instructions.replace(/\n$/, '')));
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: 'gsd-planner', prompt: 'Plan this phase.' }));
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-codex-decompose');
    const successStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-success-'));
    const successLease = createPlanningWriterLease({ worktree: f.root, phaseDir, stateRoot: successStateRoot });
    const { spawn } = attachFakeSpawn(f, 'gsd-planner', fixtureData, () => { clock.advance(50); heartbeat.fire(); });
    const result = await runCli(['--args-file', file], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      testStateRoot: f.stateRoot,
      writerLease: successLease,
      leaseTtlMs: 1000,
      now: clock,
      heartbeat: heartbeat.scheduler,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
      spawn,
    });
    assert.equal(result.receipt.compliance, 'verified');
    assert.doesNotThrow(() => successLease.acquire({ owner: 'a-following-run', base_revision: headRevision(f.root) }));

    const failureStateRoot = fs.mkdtempSync(path.join(f.stateRoot, 'lease-state-failure-'));
    const failureLease = createPlanningWriterLease({ worktree: f.root, phaseDir, stateRoot: failureStateRoot });
    const failureScope = { ...f.scope, run_id: 'run-codex-decompose-test-failure' };
    const failureFile = path.join(f.root, 'cli-request-failure.json');
    fs.writeFileSync(failureFile, JSON.stringify({ scope: failureScope, gsd_role: 'gsd-planner', prompt: 'Plan.' }));
    fs.appendFileSync(path.join(f.agentDir, 'gsd-planner.toml'), 'model = "gpt-6-luna"\n');
    await assert.rejects(() => runCli(['--args-file', failureFile], { write() {} }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      testStateRoot: f.stateRoot,
      writerLease: failureLease,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
    }), (error) => error.code === 'CONFLICTING_OVERRIDE');
    assert.doesNotThrow(() => failureLease.acquire({ owner: 'a-following-run', base_revision: headRevision(f.root) }));
  } finally { f.clean(); }
});

function timedOutWaits(raw) {
  return raw.split('\n').filter(Boolean).map((line) => {
    const record = JSON.parse(line);
    if (record.type === 'response_item' && record.payload.type === 'function_call_output'
        && /timed_out/.test(String(record.payload.output))) {
      record.payload.output = '{"message":"Wait timed out.","timed_out":true}';
    }
    return JSON.stringify(record);
  }).join('\n') + '\n';
}

async function recoverySetup(gsdRole, { exitCode = 0 } = {}) {
  const f = fixture();
  const fixtureData = buildNativeChildFixture(gsdRole);
  fixtureData.parentRaw = timedOutWaits(fixtureData.parentRaw);
  fs.writeFileSync(path.join(f.agentDir, gsdRole + '.toml'),
    gsdAgentToml(gsdRole, fixtureData.instructions.replace(/\n$/, '')));
  const file = path.join(f.root, 'cli-request.json');
  fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: gsdRole, prompt: 'Check this phase plan.' }));
  const { spawn } = attachFakeSpawn(f, gsdRole, fixtureData);
  const wrapped = exitCode === 0 ? spawn : (...args) => {
    const child = spawn(...args);
    const emit = child.emit.bind(child);
    child.emit = (event, ...rest) => emit(event, ...(event === 'close' ? [exitCode, null] : rest));
    return child;
  };
  const base = {
    env: { CODEX_HOME: f.codexHome }, agentDir: f.agentDir,
    agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'), testStateRoot: f.stateRoot,
    probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
  };
  const dispatchId = 'dispatch-recover-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(file, JSON.stringify({
    scope: f.scope, gsd_role: gsdRole, prompt: 'Check this phase plan.', dispatch_id: dispatchId,
  }));
  let live = null;
  let liveError = null;
  try { live = await runCli(['--args-file', file], { write() {} }, { ...base, spawn: wrapped }); }
  catch (error) { liveError = error; }
  const hostState = path.dirname(defaultRunStoreDir(f.scope, f.stateRoot));
  const receipts = path.join(hostState, 'receipts');
  const recordFile = path.join(receipts, 'record-' + crypto.createHash('sha256').update(dispatchId).digest('hex') + '.json');
  const spawned = [];
  const recover = (id = dispatchId) => runCli(['recover', '--dispatch', id, '--args-file', file], { write() {} },
    { ...base, spawn: (...args) => { spawned.push(args); throw new Error('recovery must not spawn'); } });
  return { f, fixtureData, dispatchId, live, liveError, receipts, recordFile, hostState, spawned, recover, file };
}

function simulateCrashBeforeRecord(setup) {
  assert.ok(fs.existsSync(setup.recordFile), 'live run recorded its receipt');
  fs.rmSync(setup.recordFile);
  assert.deepEqual(createDurableRecorder(setup.receipts).getReservation(setup.dispatchId),
    { dispatch_id: setup.dispatchId, reserved_at: createDurableRecorder(setup.receipts).getReservation(setup.dispatchId).reserved_at, recorded: false });
}

function sessionFiles(f) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else found.push(full);
    }
  };
  walk(path.join(f.codexHome, 'sessions'));
  return found;
}

for (const gsdRole of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
test('recover rebuilds the original ' + gsdRole + ' receipt from a timed-out parent wait without spawning', async () => {
  const setup = await recoverySetup(gsdRole);
  try {
    assert.equal(setup.liveError, null);
    simulateCrashBeforeRecord(setup);
    const result = await setup.recover();
    assert.equal(setup.spawned.length, 0);
    assert.equal(result.recovered, true);
    assert.equal(result.recovered_output, 'OK');
    assert.equal(result.receipt.dispatch_id, setup.dispatchId);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.gsd_role, gsdRole);
    assert.equal(result.receipt.launch_id, setup.live.receipt.launch_id);
    assert.equal(result.receipt.runtime_evidence.native_child_evidence.session_id,
      setup.live.receipt.runtime_evidence.native_child_evidence.session_id);
    assert.equal(result.receipt.runtime_evidence.native_session_evidence.sha256,
      setup.live.receipt.runtime_evidence.native_session_evidence.sha256);
    const recorder = createDurableRecorder(setup.receipts);
    assert.equal(recorder.getReservation(setup.dispatchId).recorded, true);
    assert.equal(recorder.getVerifiedRecord(setup.dispatchId).receipt.dispatch_id, setup.dispatchId);
    await assert.rejects(setup.recover(), (error) => error.code === 'RECOVERY_ALREADY_RECORDED');
    assert.equal(setup.spawned.length, 0);
  } finally { setup.f.clean(); }
});
}

test('recover refuses a dispatch with no reservation and one already recorded', async () => {
  const setup = await recoverySetup('gsd-planner');
  try {
    await assert.rejects(setup.recover(), (error) => error.code === 'RECOVERY_ALREADY_RECORDED');
    fs.writeFileSync(setup.file, JSON.stringify({ scope: setup.f.scope, gsd_role: 'gsd-planner', prompt: 'x' }));
    await assert.rejects(setup.recover('dispatch-never-reserved'), (error) => error.code === 'RECOVERY_NO_RESERVATION');
    assert.equal(setup.spawned.length, 0);
  } finally { setup.f.clean(); }
});

const refusals = [
  ['missing child transcript', 'RECOVERY_EVIDENCE_MISSING', (s) => {
    fs.rmSync(sessionFiles(s.f).find((file) => file.includes(s.fixtureData.childId)));
  }],
  ['child without task_complete', 'RECOVERY_EVIDENCE_INCOMPLETE', (s) => {
    const child = sessionFiles(s.f).find((file) => file.includes(s.fixtureData.childId));
    fs.writeFileSync(child, fs.readFileSync(child, 'utf8').split('\n').filter((line) => !line.includes('task_complete')).join('\n'));
  }],
  ['parent transcript digest changed', 'RECOVERY_ARTIFACT_ALTERED', (s) => {
    const parent = sessionFiles(s.f).find((file) => file.includes(s.fixtureData.parent));
    fs.appendFileSync(parent, '\n');
  }],
  ['artifact digest changed', 'RECOVERY_ARTIFACT_ALTERED', (s) => {
    fs.appendFileSync(path.join(s.f.root, '.planning', 'phases', '38-codex-decompose', '38-01-PLAN.md'), 'tampered\n');
  }],
  ['live child pid', 'RECOVERY_UNKNOWN_LIVE', (s) => {
    const dir = path.join(s.hostState, 'launches');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.completed.pid = process.pid;
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  }],
  ['missing launch record', 'RECOVERY_EVIDENCE_MISSING', (s) => {
    fs.rmSync(path.join(s.hostState, 'launches'), { recursive: true, force: true });
  }],
];
for (const [name, code, mutate] of refusals) {
test('recover refuses ' + name + ' with ' + code + ' and records nothing', async () => {
  const setup = await recoverySetup('gsd-planner');
  try {
    assert.equal(setup.liveError, null);
    simulateCrashBeforeRecord(setup);
    mutate(setup);
    await assert.rejects(setup.recover(), (error) => error.code === code);
    assert.equal(fs.existsSync(setup.recordFile), false);
    assert.equal(createDurableRecorder(setup.receipts).getReservation(setup.dispatchId).recorded, false);
    assert.equal(setup.spawned.length, 0);
  } finally { setup.f.clean(); }
});
}

test('a host killed before the child completes refuses recovery with RECOVERY_EVIDENCE_INCOMPLETE', async () => {
  const setup = await recoverySetup('gsd-planner', { exitCode: 1 });
  try {
    assert.ok(setup.liveError);
    assert.equal(fs.existsSync(setup.recordFile), false);
    assert.equal(createDurableRecorder(setup.receipts).getReservation(setup.dispatchId).recorded, false);
    await assert.rejects(setup.recover(), (error) => error.code === 'RECOVERY_EVIDENCE_INCOMPLETE');
    assert.equal(fs.existsSync(setup.recordFile), false);
  } finally { setup.f.clean(); }
});

test('recover argv is exact', () => {
  assert.deepEqual(parseRecoverArguments(['recover', '--dispatch', 'd-1', '--args-file', 'x.json']),
    { dispatchId: 'd-1', file: path.resolve('x.json') });
  assert.throws(() => parseRecoverArguments(['recover', '--dispatch', 'd-1']), (error) => error.code === 'INVALID_INPUT');
});
