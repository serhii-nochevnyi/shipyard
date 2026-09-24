'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const {
  createCodexDecomposeHost, defaultRunStoreDir, parseCliArguments, readRequestFile, requestValue, runCli,
} = require('../../plugins/delivery-pipeline/scripts/codex-decompose-host.cjs');

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportedSelections: [{ model: 'gpt-6-sol', effort: 'high' }],
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-decompose-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-decompose-state-'));
  const codexHome = path.join(root, 'codex-home');
  const agentDir = path.join(codexHome, 'agents');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  for (const role of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
    fs.writeFileSync(path.join(agentDir, role + '.toml'), [
      'name = "' + role + '"',
      'description = "Installed GSD ' + role + '"',
      'sandbox_mode = "' + (role === 'gsd-planner' ? 'workspace-write' : 'read-only') + '"',
      "developer_instructions = '''",
      'Perform the exact installed ' + role + ' role.',
      "'''",
      '',
    ].join('\n'));
  }
  const resolved = policy.resolveDispatch({ runtime: 'codex', role: 'research' });
  const researchContent = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + resolved.policy_version + '"',
    '# shipyard-policy-hash = "' + resolved.policy_hash + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "' + resolved.rung + '"',
    'name = "shipyard-inv-research"',
    'model = "gpt-6-sol"',
    'model_reasoning_effort = "high"',
    'sandbox_mode = "read-only"',
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
  const host = {
    scope, capabilities,
    recorder: createDurableRecorder(path.join(root, 'receipts')),
    async launchTypedGsd(selection, context) {
      calls.push({ selection, context });
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
    root, stateRoot, codexHome, agentDir, scope, host, calls, researchDigest,
    create: (over = {}) => createCodexDecomposeHost({
      scope, host, env: { CODEX_HOME: codexHome }, agentDir,
      agentManifest: path.join(agentDir, '.shipyard-manifest.json'), ...over,
    }),
    clean: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

for (const [gsdRole, logicalRole, sandbox] of [
  ['gsd-phase-researcher', 'research', 'read-only'],
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
      } else {
        assert.equal(f.calls[0].context.prompt, 'Plan this phase.');
      }
    } finally { f.clean(); }
  });
}

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
    assert.equal(fs.readdirSync(path.join(f.root, 'receipts')).filter((name) => name.startsWith('record-')).length, 0);
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

for (const gsdRole of ['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker']) {
test('production ' + gsdRole + ' reaches its native child and records session evidence', async () => {
  const f = fixture();
  const parent = '01a0ce68-961a-72d1-b55e-d293ab9d19f4';
  const childId = '01a0ce68-afef-7bc2-baa6-b1ae8d6ce121';
  const fixtureRoot = path.join(__dirname, '..', 'fixtures');
  const childRaw = fs.readFileSync(path.join(fixtureRoot, 'codex-agent-child-0.155.1.jsonl'), 'utf8');
  const parentRaw = fs.readFileSync(path.join(fixtureRoot, 'codex-agent-parent-0.155.1.jsonl'), 'utf8');
  const records = childRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const instructions = records.find((record) => record.type === 'response_item'
    && record.payload.role === 'developer').payload.content[0].text;
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
  const calls = [];
  try {
    fs.writeFileSync(path.join(f.agentDir, gsdRole + '.toml'),
      'name = "' + gsdRole + '"\ndescription = "Installed GSD role"\nsandbox_mode = "'
      + (gsdRole === 'gsd-planner' ? 'workspace-write' : 'read-only') + '"\n'
      + "developer_instructions = '''\n" + instructions + "'''\n");
    const file = path.join(f.root, 'cli-request.json');
    fs.writeFileSync(file, JSON.stringify({ scope: f.scope, gsd_role: gsdRole, prompt: 'Check this phase plan.' }));
    const output = [];
    const result = await runCli(['--args-file', file], { write(value) { output.push(value); } }, {
      env: { CODEX_HOME: f.codexHome },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      testStateRoot: f.stateRoot,
      leaseTtlMs: 120,
      heartbeatMs: 20,
      probe: { status: 'available', executable: 'codex', runtime_version: '0.155.1', capabilities },
      spawn: (_executable, args, options) => {
        calls.push({ args, options });
        const now = new Date();
        const dir = path.join(f.codexHome, 'sessions', String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'rollout-' + parent + '.jsonl'), transform(parentRaw));
        fs.writeFileSync(path.join(dir, 'rollout-' + childId + '.jsonl'), transform(childRaw));
        const process = new EventEmitter();
        process.stdout = new EventEmitter();
        process.stderr = new EventEmitter();
        process.stdin = { write() {}, end() {} };
        process.pid = 38004;
        setTimeout(() => {
          process.stdout.emit('data', Buffer.from([
            { type: 'thread.started', thread_id: parent },
            { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } },
          ].map((record) => JSON.stringify(record)).join('\n') + '\n'));
          process.emit('close', 0, null);
        }, 170);
        return process;
      },
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
      probe: { status: 'available', executable: 'codex', runtime_version: '0.155.1', capabilities },
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
