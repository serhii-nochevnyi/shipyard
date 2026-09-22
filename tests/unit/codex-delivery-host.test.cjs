'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const {
  createCodexDeliveryHost,
  parseCliArguments,
  readRequestFile,
  requestValue,
} = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportedSelections: [
    { model: 'gpt-6-luna', effort: 'max' },
    { model: 'gpt-6-sol', effort: 'high' },
  ],
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-delivery-'));
  const agentDir = path.join(root, 'agents');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  const resolution = policy.resolveDispatch({ runtime: 'codex', role: 'research' });
  const file = resolution.agent_file;
  const content = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + resolution.policy_version + '"',
    '# shipyard-policy-hash = "' + resolution.policy_hash + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "' + resolution.rung + '"',
    'name = "' + file.replace(/\.toml$/, '') + '"',
    'model = "' + resolution.model + '"',
    'model_reasoning_effort = "' + resolution.effort + '"',
    'sandbox_mode = "read-only"',
    "developer_instructions = '''",
    'Follow the scoped research role.',
    "'''",
    '',
  ].join('\n');
  const fileDigest = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(agentDir, file), content);
  fs.writeFileSync(path.join(agentDir, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    agent_files: [file],
    agent_digests: { [file]: fileDigest },
  }));
  const scope = {
    run_id: 'run-codex-delivery-test', ticket: 'T-38-04', phase: 38,
    worktree: root, runtime: 'codex', provider: 'openai',
  };
  const calls = [];
  const host = {
    scope,
    capabilities,
    recorder: () => true,
    launch(selection, context) {
      calls.push({ method: 'dynamic', selection, context });
      return application(selection, context);
    },
    launchStatic(selection, context) {
      calls.push({ method: 'static', selection, context });
      return application(selection, context);
    },
    launchTypedGsd(selection, context) {
      calls.push({ method: 'typed', selection, context });
      return application(selection, context);
    },
  };
  return { root, agentDir, scope, host, calls, file, fileDigest };
}

function application(selection, context) {
  return {
    launch_id: 'codex-delivery-test',
    applied_model: selection.model,
    applied_effort: selection.reasoning_effort,
    observed_model: selection.model,
    observed_effort: selection.reasoning_effort,
    ...(selection.agent_file ? { agent_file_digest: selection.agent_file_digest } : {}),
    ...(context.gsd_role ? { gsd_role: context.gsd_role, gsd_launch_mechanism: 'typed-gsd-callback' } : {}),
  };
}

function delivery(f) {
  return createCodexDeliveryHost({
    scope: f.scope,
    host: f.host,
    capabilities,
    agentDir: f.agentDir,
    agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
    env: {},
  });
}

function clean(f) {
  fs.rmSync(f.root, { recursive: true, force: true });
}

suite('codex-delivery-host — scoped production dispatch');

test('dynamic executor resolves Luna/max through the boundary with worktree write access', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({
      role: 'executor',
      dispatch_id: 'codex-delivery-executor',
      context: { prompt: 'Implement the scoped ticket.' },
    });
    const call = f.calls[0];
    assert.equal(call.method, 'dynamic');
    assert.equal(call.selection.model, 'gpt-6-luna');
    assert.equal(call.selection.reasoning_effort, 'max');
    assert.equal(call.context.sandbox_mode, 'workspace-write');
    assert.equal(call.context.run_id, f.scope.run_id);
    assert.equal(call.context.worktreePath, f.scope.worktree);
    assert.equal(call.context.prompt, 'Implement the scoped ticket.');
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6-luna');
    assert.equal(result.receipt.applied_effort, 'max');
  } finally { clean(f); }
});

test('production runtime host receives the scoped prompt and records native model evidence', async () => {
  const f = fixture();
  const codeHome = path.join(f.root, 'codex-home');
  const session = '44444444-4444-4444-8444-444444444444';
  const received = [];
  const transcript = [
    { type: 'session_meta', payload: { id: session, session_id: session, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'max' } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  const output = [
    { type: 'thread.started', thread_id: session },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 6, output_tokens: 2 } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  try {
    const result = await createCodexDeliveryHost({
      scope: f.scope,
      capabilities,
      probe: {
        status: 'available', executable: 'codex', runtime_version: '0.155.1',
        capabilities: { ...capabilities, cliVersion: '0.155.1' },
      },
      env: { CODEX_HOME: codeHome },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      transcriptDir: path.join(f.root, 'transcripts'),
      spawn: (_executable, _args, options) => {
        const date = new Date();
        const directory = path.join(options.env.CODEX_HOME, 'sessions', String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'rollout-' + Date.now() + '-' + session + '.jsonl'), transcript);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write(value) { received.push(String(value)); }, end() {} };
        child.pid = 45678;
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(output));
          child.emit('close', 0, null);
        });
        return child;
      },
    }).run({ role: 'executor', context: { prompt: 'Edit the scoped file.' } });
    assert.ok(received.join('').includes('Edit the scoped file.'));
    assert.equal(result.receipt.applied_model, 'gpt-6-luna');
    assert.equal(result.receipt.applied_effort, 'max');
    assert.equal(result.receipt.runtime_evidence.native_session_evidence.session_id, session);
  } finally { clean(f); }
});

test('generated static role uses its immutable file and declared read-only sandbox', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Inspect the scoped plan.' } });
    const call = f.calls[0];
    assert.equal(call.method, 'static');
    assert.equal(call.selection.agent_file, f.file);
    assert.equal(call.selection.model, 'gpt-6-sol');
    assert.equal(call.selection.reasoning_effort, 'high');
    assert.equal(call.selection.sandbox_mode, 'read-only');
    assert.equal(result.receipt.agent_file_digest, f.fileDigest);
    assert.equal(result.receipt.compliance, 'verified');
  } finally { clean(f); }
});

test('typed GSD delivery goes through the host-owned typed callback', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({
      role: 'decomposition',
      gsd_role: 'gsd-planner',
      context: { prompt: 'Create the approved phase plan.' },
    });
    assert.equal(f.calls[0].method, 'typed');
    assert.equal(f.calls[0].selection.model, 'gpt-6-sol');
    assert.equal(f.calls[0].selection.reasoning_effort, 'high');
    assert.equal(result.receipt.gsd_launch_mechanism, 'typed-gsd-callback');
  } finally { clean(f); }
});

test('scope, provider crossover, inherited selection, and stale static output refuse before launch', async () => {
  const f = fixture();
  try {
    const host = delivery(f);
    await assert.rejects(() => host.run({ role: 'executor', context: { prompt: 'Do work', model: 'gpt-6-sol' } }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
    await assert.rejects(() => host.run({ role: 'executor', model: 'gpt-6-luna', context: { prompt: 'Do work' } }),
      (error) => error.code === 'INVALID_INPUT');
    await assert.rejects(() => host.run({ role: 'executor', context: { prompt: 'Do work', sandbox_mode: 'read-only' } }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
    fs.appendFileSync(path.join(f.agentDir, f.file), '# changed after manifest\n');
    await assert.rejects(() => host.run({ role: 'research', context: { prompt: 'Inspect.' } }),
      (error) => error.code === 'STALE_GENERATED_AGENT');
    assert.equal(f.calls.length, 0);
    assert.throws(() => createCodexDeliveryHost({
      scope: { ...f.scope, provider: 'anthropic' }, host: f.host,
    }), (error) => error.code === 'RUNTIME_PROVIDER_MISMATCH');
  } finally { clean(f); }
});

test('CLI request parsing accepts only a bounded args file and explicit scope', () => {
  const f = fixture();
  const argsFile = path.join(f.root, 'request.json');
  try {
    assert.equal(parseCliArguments(['--args-file', argsFile]), argsFile);
    assert.throws(() => parseCliArguments(['--args-file', argsFile, '--role', 'executor']),
      (error) => error.code === 'INVALID_INPUT');
    fs.writeFileSync(argsFile, JSON.stringify({ scope: f.scope, role: 'executor', context: { prompt: 'Run.' } }));
    const parsed = readRequestFile(argsFile);
    assert.deepEqual(parsed.launch, { role: 'executor', context: { prompt: 'Run.' } });
    assert.throws(() => requestValue({ role: 'executor', model: 'gpt-6-luna' }),
      (error) => error.code === 'INVALID_INPUT');
  } finally { clean(f); }
});

done();
