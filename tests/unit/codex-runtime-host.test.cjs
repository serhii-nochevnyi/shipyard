'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const {
  EFFORTS,
  createCodexCliLauncher,
  createCodexRuntimeHost,
  observedSelection,
  parseNativeCodexTranscript,
  parseNativeParentSpawn,
  parseNativeChildTranscript,
  installedGsdAgent,
  signerProtectionPaths,
  signerPermissionProfileArgs,
  parseCodexStream,
  probeCodexRuntime,
} = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const { launchAgent } = require('../../plugins/delivery-pipeline/scripts/codex-agent.cjs');
const { createCodexDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');

const SCOPE = {
  run_id: 'run-37-04',
  ticket: 'T-37-04',
  phase: 37,
  worktree: '/tmp/shipyard-t3704',
  runtime: 'codex',
  provider: 'openai',
};

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'],
  supportedEfforts: EFFORTS,
  observedModel: true,
  observedEffort: true,
};

const EXEC_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-exec.jsonl';
const PARENT_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';
const CHILD_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-child.jsonl';
const PARENT_ID = '01a0e224-6642-7f20-b2a3-68b283d429b9';
const CHILD_ID = '01a0e224-80bb-7d33-b57d-8c44061ac85d';
const CAPTURED_TASK = 'Reply with the single word OK and take no other action.';
const CAPTURED_SHA256 = 'de94a486861cedd3587db16ba051e5c5bf80e0ab05fa44ed50ad48688e6f8b4c';

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>|<TMP>/g,
      (token) => (values[token] === undefined ? token : JSON.stringify(values[token]).slice(1, -1))))
    .join('\n') + '\n';
}

function stream(session = '11111111-1111-4111-8111-111111111111') {
  return captured(EXEC_FIXTURE, { '<SESSION-1>': session });
}

function sessionTranscript(session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  return transformJsonl(captured(PARENT_FIXTURE, { '<SESSION-2>': session }), (record) => {
    if (record.type === 'session_meta') record.payload.model_provider = provider;
    if (record.type === 'turn_context') Object.assign(record.payload, { model, effort });
    if (record.payload?.type === 'task_complete') record.payload.last_agent_message = 'OK';
    if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
      record.payload.content.forEach(block => { block.text = 'OK'; });
    return record;
  });
}

function writeSession(codeHome, session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  const date = new Date();
  const directory = path.join(codeHome, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-' + Date.now() + '-' + session + '.jsonl');
  fs.writeFileSync(file, sessionTranscript(session, model, effort, provider));
  return file;
}

function childFor(output, code = 0, pid = 24037, input = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(value) { input.push(String(value)); },
    end() {},
  };
  child.pid = pid;
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  });
  return child;
}

function probe() {
  return {
    schema: 'shipyard.codex-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable: 'codex',
    runtime_version: '0.155.1',
    capabilities,
  };
}

function staticContent(resolution = { model: 'gpt-6.1-sol', effort: 'high' }) {
  return [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
    '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "base"',
    'name = "shipyard-inv-research"',
    'model = "' + resolution.model + '"',
    'model_reasoning_effort = "' + resolution.effort + '"',
    'sandbox_mode = "read-only"',
    "developer_instructions = '''",
    'Follow the scoped research contract.',
    "'''",
    '',
  ].join('\n');
}

function recordedTypedSession() {
  const ids = { '<SESSION-2>': PARENT_ID, '<SESSION-6>': CHILD_ID };
  const parentRaw = captured(PARENT_FIXTURE, ids);
  const recorded = captured(CHILD_FIXTURE, ids);
  const elided = recorded.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((record) => record.type === 'response_item' && record.payload.role === 'developer')
    .payload.content[0].text;
  const instructions = elided + '\n';
  const childRaw = recorded.replace(JSON.stringify(elided), JSON.stringify(instructions));
  return { parentRaw, childRaw, parent: PARENT_ID, child: CHILD_ID, instructions };
}

function transformJsonl(raw, transform) {
  return raw.split('\n').filter(Boolean).map((line) => JSON.stringify(transform(JSON.parse(line)))).join('\n') + '\n';
}

function relayChild(codeHome, parentRaw, childRaw, options = {}) {
  const input = options.input || [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = options.pid || 24050;
  child.stdin = {
    write(value) { input.push(String(value)); },
    end() {
      const sent = input.join('');
      const task = { file: /^TASK_FILE=(.*)$/m.exec(sent)[1], sha256: /^TASK_SHA256=(.*)$/m.exec(sent)[1] };
      const now = new Date();
      const directory = path.join(codeHome, 'sessions', String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'rollout-' + PARENT_ID + '.jsonl'), parentRaw);
      if (childRaw !== null) {
        const replay = childRaw.split('<TMP>').join(JSON.stringify(task.file).slice(1, -1));
        fs.writeFileSync(path.join(directory, 'rollout-' + CHILD_ID + '.jsonl'),
          options.mutate ? options.mutate(replay, task) : replay);
      }
      if (options.onTask) options.onTask(task);
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(stream(PARENT_ID)));
        child.emit('close', 0, null);
      });
    },
  };
  return child;
}

suite('codex-runtime-host — native launch and independent evidence');

test('signer permission profile denies host signing paths and preserves the selected baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-signer-sandbox-'));
  try {
    const customGpg = path.join(root, 'custom gpg home');
    const socket = path.join(root, 'ssh agent.sock');
    const protectedPaths = signerProtectionPaths({ GNUPGHOME: customGpg, SSH_AUTH_SOCK: socket }, root);
    assert.ok(protectedPaths.includes(path.resolve(customGpg)));
    assert.ok(protectedPaths.includes(path.resolve(path.join(os.homedir(), '.gnupg'))));
    assert.ok(protectedPaths.includes(path.resolve(path.join(os.homedir(), '.ssh'))));
    assert.ok(protectedPaths.includes(path.resolve(socket)));
    const writable = signerPermissionProfileArgs(protectedPaths, 'workspace-write');
    assert.ok(writable.includes('default_permissions="shipyard-runtime"'));
    assert.ok(writable.includes('permissions.shipyard-runtime.extends=":workspace"'));
    assert.ok(writable.includes('permissions.shipyard-runtime.filesystem={'
      + protectedPaths.map((entry) => JSON.stringify(entry) + '=\"deny\"').join(',') + '}'));
    const readonly = signerPermissionProfileArgs(protectedPaths, 'read-only');
    assert.ok(readonly.includes('permissions.shipyard-runtime.extends=":read-only"'));
    assert.throws(() => signerPermissionProfileArgs([], 'workspace-write'), (error) => error.code === 'SIGNER_ISOLATION_UNAVAILABLE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parses thread and completed-turn evidence', () => {
  const parsed = parseCodexStream(stream());
  const native = parseNativeCodexTranscript(sessionTranscript(parsed.session_id), parsed.session_id);
  assert.equal(parsed.session_id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(observedSelection(parsed, 'gpt-6-luna', 'max', {
    model: 'gpt-6-luna', effort: 'max',
  }, native), {
    model: 'gpt-6-luna',
    effort: 'max',
    source: 'codex-native-session-transcript',
  });
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.usage_records, 1);
  assert.deepEqual(native.models, ['gpt-6-luna']);
  assert.deepEqual(native.efforts, ['max']);
});

test('native transcript evidence is session-bound and ignores unrelated nested model fields', () => {
  const session = '22222222-2222-4222-8222-222222222222';
  const parsed = parseNativeCodexTranscript(sessionTranscript(session), session);
  assert.deepEqual(parsed.selections, [{ model: 'gpt-6-luna', effort: 'max' }]);
  assert.throws(() => parseNativeCodexTranscript(sessionTranscript('33333333-3333-4333-8333-333333333333'), session),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeCodexTranscript(sessionTranscript(session, 'gpt-6-sol', 'high'), session)
    && observedSelection(parseCodexStream(stream(session)), 'gpt-6-luna', 'max', { model: 'gpt-6-luna', effort: 'max' },
      parseNativeCodexTranscript(sessionTranscript(session, 'gpt-6-sol', 'high'), session)),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeCodexTranscript(sessionTranscript(session, 'gpt-6-luna', 'max', 'anthropic'), session),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
});

test('Codex launcher passes explicit model and reasoning effort to exec', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-runtime-'));
  const calls = [];
  const input = [];
  const codeHome = path.join(root, 'codex-home');
  const prompt = 'run the scoped task\nwith its acceptance criteria';
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root },
      capabilities,
      transcriptDir: path.join(root, 'transcripts'),
      env: {
        CODEX_HOME: codeHome,
        OPENAI_API_KEY: 'ignored-test-key',
        CODEX_API_KEY: 'ignored-test-key',
        ANTHROPIC_API_KEY: 'ignored-anthropic-key',
        ANTHROPIC_AUTH_TOKEN: 'ignored-anthropic-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'ignored-claude-token',
      },
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        writeSession(options.env.CODEX_HOME, '22222222-2222-4222-8222-222222222222');
        return childFor(stream('22222222-2222-4222-8222-222222222222'), 0, 24038, input);
      },
    });
    const result = await launch(prompt, {
      model: 'gpt-6-luna',
      effort: 'max',
      sandbox_mode: 'workspace-write',
      dispatch_id: 'dispatch-codex-1',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'codex');
    assert.deepEqual(calls[0].args.slice(0, 2), ['exec', '--json']);
    assert.ok(calls[0].args.includes('--model'));
    assert.ok(calls[0].args.includes('gpt-6-luna'));
    assert.ok(calls[0].args.includes('--config'));
    assert.ok(calls[0].args.includes('model_reasoning_effort="max"'));
    assert.ok(calls[0].args.includes('model_provider="openai"'));
    assert.ok(calls[0].args.includes('forced_login_method="chatgpt"'));
    assert.ok(!calls[0].args.includes('--sandbox'));
    assert.ok(calls[0].args.includes('default_permissions="shipyard-runtime"'));
    assert.ok(calls[0].args.includes('permissions.shipyard-runtime.extends=":workspace"'));
    assert.ok(result.runtime_evidence.sandbox_evidence.protected_paths.length >= 2);
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(calls[0].options.env.CODEX_API_KEY, undefined);
    assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(calls[0].args.includes('--cd'));
    assert.equal(calls[0].options.cwd, root);
    assert.equal(input.join(''), prompt);
    assert.equal(result.session_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(result.process_id, 24038);
    assert.equal(result.runtime_evidence.dispatch_id, 'dispatch-codex-1');
    assert.equal(result.runtime_evidence.stream_evidence.format, 'jsonl');
    assert.equal(result.runtime_evidence.native_session_evidence.provider, 'openai');
    assert.equal(result.runtime_evidence.native_session_evidence.models[0], 'gpt-6-luna');
    assert.equal(result.runtime_evidence.native_session_evidence.efforts[0], 'max');
    assert.ok(fs.existsSync(result.runtime_evidence.transcript.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex native pid persistence precedes stdin and failed persistence kills the child', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-pid-'));
  const input = [];
  let killed = false;
  try {
    const launch = createCodexCliLauncher({ scope: { ...SCOPE, worktree: root }, capabilities,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
      spawn: () => {
        const child = childFor('', 0, 24038, input);
        child.kill = () => { killed = true; };
        return child;
      } });
    await assert.rejects(launch('task', { model: 'gpt-6-luna', effort: 'max',
      sandbox_mode: 'workspace-write', dispatch_id: 'dispatch-pid-failure',
      onProcessSpawned(pid) {
        assert.equal(pid, 24038);
        assert.deepEqual(input, []);
        throw Object.assign(new Error('private pid checkpoint failed'), { code: 'CHECKPOINT_FAILED' });
      } }), { code: 'CHECKPOINT_FAILED' });
    assert.equal(killed, true);
    assert.deepEqual(input, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('host-owned additional protected paths deny the finalization state root and cannot be overridden by a launch request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-state-deny-'));
  const calls = [];
  const codeHome = path.join(root, 'codex-home');
  const stateRoot = path.join(root, 'host-state', 'finalization');
  const attackerPath = path.join(root, 'attacker-injected-path');
  fs.mkdirSync(stateRoot, { recursive: true });
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root },
      capabilities,
      transcriptDir: null,
      env: { CODEX_HOME: codeHome },
      additionalProtectedPaths: [stateRoot],
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        writeSession(options.env.CODEX_HOME, '55555555-5555-4555-8555-555555555555');
        return childFor(stream('55555555-5555-4555-8555-555555555555'), 0, 24041);
      },
    });
    const result = await launch('run the scoped task', {
      model: 'gpt-6-luna',
      effort: 'max',
      sandbox_mode: 'workspace-write',
      dispatch_id: 'dispatch-codex-state-1',
      additionalProtectedPaths: [attackerPath],
      protectedPaths: [],
    });
    assert.equal(calls.length, 1);
    const filesystemArg = calls[0].args.find((value) => value.startsWith('permissions.shipyard-runtime.filesystem='));
    assert.ok(filesystemArg.includes(JSON.stringify(fs.realpathSync(stateRoot)) + '="deny"'));
    assert.ok(!filesystemArg.includes('attacker-injected-path'));
    assert.ok(result.runtime_evidence.sandbox_evidence.protected_paths.includes(fs.realpathSync(stateRoot)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('static launcher consumes the immutable generated instructions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-static-'));
  const input = [];
  const rootPath = path.join(os.tmpdir(), 'shipyard-codex-static-' + crypto.randomUUID());
  const codeHome = path.join(rootPath, 'codex-home');
  fs.mkdirSync(rootPath, { recursive: true });
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root },
      capabilities,
      transcriptDir: null,
      env: { CODEX_HOME: codeHome },
      spawn: (_executable, args, options) => {
        assert.ok(args.includes('--model'));
        writeSession(options.env.CODEX_HOME, '33333333-3333-4333-8333-333333333333', 'gpt-6.1-sol', 'high');
        return childFor(stream('33333333-3333-4333-8333-333333333333'), 0, 24039, input);
      },
    });
    const content = staticContent();
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    await launch('ticket contract', {
      model: 'gpt-6.1-sol',
      effort: 'high',
      sandbox_mode: 'read-only',
      agent_file: 'shipyard-inv-research.toml',
      agent_file_digest: digest,
      agent_file_content: content,
      dispatch_id: 'dispatch-static-1',
    });
    assert.ok(input.join('').startsWith('Follow the scoped research contract.'));
    await assert.rejects(
      () => launch('ticket contract', {
        model: 'gpt-6.1-sol',
        effort: 'high',
        sandbox_mode: 'read-only',
        agent_file: 'shipyard-inv-research.toml',
        agent_file_digest: '0'.repeat(64),
        agent_file_content: content,
        dispatch_id: 'dispatch-static-2',
      }),
      (error) => error.code === 'STALE_GENERATED_AGENT',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

test('read-only judgment roles can write only their evidence file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-evidence-'));
  const codeHome = path.join(root, 'codex-home');
  const content = staticContent();
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  const calls = [];
  let count = 0;
  try {
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root }, capabilities, transcriptDir: null,
      env: { CODEX_HOME: codeHome },
      spawn: (_executable, args, options) => {
        calls.push(args);
        const session = count++ === 0
          ? '44444444-4444-4444-8444-444444444444'
          : '55555555-5555-4555-8555-555555555555';
        writeSession(options.env.CODEX_HOME, session, 'gpt-6.1-sol', 'high');
        return childFor(stream(session), 0, 24040 + count, []);
      },
    });
    for (const [agentFile, evidenceName] of [
      ['shipyard-drift-check.toml', '.shipyard-drift-evidence.md'],
      ['shipyard-arch-review-critical.toml', '.shipyard-arch-review-evidence.md'],
    ]) {
      const result = await launch('judge', {
        model: 'gpt-6.1-sol', effort: 'high', sandbox_mode: 'read-only',
        agent_file: agentFile, agent_file_digest: digest, agent_file_content: content,
        dispatch_id: 'dispatch-evidence-' + count,
      });
      const filesystem = calls.at(-1).find((value) => value.startsWith('permissions.shipyard-runtime.filesystem='));
      assert.ok(calls.at(-1).includes('permissions.shipyard-runtime.extends=":read-only"'));
      assert.ok(filesystem.includes(JSON.stringify(path.join(root, evidenceName)) + '="write"'));
      assert.equal(result.runtime_evidence.sandbox_evidence.evidence_write_path, path.join(root, evidenceName));
    }
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.shipyard-drift-evidence.md'));
    await assert.rejects(() => launch('judge', {
      model: 'gpt-6.1-sol', effort: 'high', sandbox_mode: 'read-only',
      agent_file: 'shipyard-drift-check.toml', agent_file_digest: digest,
      agent_file_content: content, dispatch_id: 'dispatch-evidence-symlink',
    }), (error) => error.code === 'INVALID_INPUT');
    assert.equal(calls.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('controller-owned host binds run identity and returns process evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-host-'));
  const session = '11111111-1111-4111-8111-111111111111';
  const ownerCalls = [];
  const controller = {
    assertOwner(runId) { ownerCalls.push(runId); },
  };
  const host = createCodexRuntimeHost({
    scope: { ...SCOPE, worktree: root },
    probe: probe(),
    controller,
    recorder: () => true,
    env: { CODEX_HOME: path.join(root, 'codex-home') },
    spawn: (_executable, _args, options) => {
      writeSession(options.env.CODEX_HOME, session);
      return childFor(stream(session), 0, 24040);
    },
    transcriptDir: null,
  });
  const result = await host.launch(
    { model: 'gpt-6-luna', reasoning_effort: 'max', sandbox_mode: 'workspace-write' },
    { run_id: SCOPE.run_id, dispatch_id: 'dispatch-host-1', prompt: 'scoped prompt' },
  );
  assert.equal(host.scope.run_id, SCOPE.run_id);
  assert.equal(result.runtime_evidence.run_id, SCOPE.run_id);
  assert.equal(result.runtime_evidence.provider, 'openai');
  assert.equal(result.observed_model, 'gpt-6-luna');
  assert.equal(result.observed_effort, 'max');
  assert.deepEqual(ownerCalls, [SCOPE.run_id, SCOPE.run_id, SCOPE.run_id]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('host reports unavailable capability without fabricating a receipt', () => {
  const unavailable = [];
  assert.throws(
    () => createCodexRuntimeHost({
      scope: SCOPE,
      probe: { status: 'unavailable', reason: 'runtime_missing' },
      controller: { markUnavailable(runId, input) { unavailable.push([runId, input.reason]); } },
      recorder: () => true,
    }),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0][0], SCOPE.run_id);
});

test('probe requires the real CLI surface and explicit host capability evidence', () => {
  const calls = [];
  const result = probeCodexRuntime({
    capabilities,
    spawnSync: (command, args) => {
      calls.push([command, args]);
      if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.155.1\n', stderr: '' };
      return { status: 0, stdout: '--json --model --config --cd --ignore-user-config', stderr: '' };
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.runtime_version, 'codex-cli 0.155.1');
  assert.deepEqual(calls, [['codex', ['--version']], ['codex', ['exec', '--help']]]);
  const missing = probeCodexRuntime({
    capabilities: null,
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'capability_evidence_missing');
});

test('launchAgent sends dynamic selection through the adapter boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-agent-launch-'));
  try {
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({}));
    const host = {
      capabilities,
      recorder: () => true,
      launch(selection, context) {
        return {
          launch_id: 'host-launch-1',
          applied_model: selection.model,
          applied_effort: selection.reasoning_effort,
          observed_model: selection.model,
          observed_effort: selection.reasoning_effort,
          context_dispatch_id: context.dispatch_id,
        };
      },
    };
    const result = launchAgent('executor', {
      cwd: root,
      capabilities,
      host,
      dispatch_id: 'dispatch-agent-1',
      context: { prompt: 'execute the scoped ticket' },
    });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6.1-sol');
    assert.equal(result.receipt.applied_effort, 'low');
    assert.equal(result.receipt.launch_id, 'host-launch-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recorded CLI 0.157.1 parent proves an explicit native typed spawn', () => {
  const { parentRaw: raw, parent } = recordedTypedSession();
  const value = parseNativeParentSpawn(raw, parent, 'gsd-plan-checker', 'gpt-6-luna', 'low');
  assert.equal(value.parent_thread_id, parent);
  assert.equal(value.task_name, 'gsd_task');
  const records = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const waitCall = records.find((record) => record.type === 'response_item'
    && record.payload.type === 'function_call' && record.payload.name === 'wait_agent');
  const waitOutput = records.find((record) => record.type === 'response_item'
    && record.payload.type === 'function_call_output' && record.payload.call_id === waitCall.payload.call_id);
  const secondWait = structuredClone(waitCall);
  secondWait.payload.id = 'wait-call-recheck';
  secondWait.payload.call_id = 'wait-recheck';
  const secondOutput = structuredClone(waitOutput);
  secondOutput.payload.id = 'wait-output-recheck';
  secondOutput.payload.call_id = 'wait-recheck';
  assert.equal(parseNativeParentSpawn([...records, secondWait, secondOutput].map((record) => JSON.stringify(record)).join('\n'),
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'low').task_name, 'gsd_task');
  const withWaitOutput = (output) => transformJsonl(raw, (record) => {
    if (record.type === 'response_item' && record.payload.call_id === waitCall.payload.call_id
        && record.payload.type === 'function_call_output') record.payload.output = output;
    return record;
  });
  assert.equal(parseNativeParentSpawn(withWaitOutput('{"message":"Wait timed out.","timed_out":true}'),
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'low').task_name, 'gsd_task');
  for (const bad of ['{"message":"Wait completed."}', '{"timed_out":"false"}', 'not json', '[]']) {
    assert.throws(() => parseNativeParentSpawn(withWaitOutput(bad), parent, 'gsd-plan-checker', 'gpt-6-luna', 'low'),
      (error) => error.code === 'RUNTIME_EVIDENCE_INVALID');
  }
  assert.throws(() => parseNativeParentSpawn(raw.split('\n').filter((line) => !line.includes(waitCall.payload.call_id)
    || line.includes('"wait_agent"')).join('\n'), parent, 'gsd-plan-checker', 'gpt-6-luna', 'low'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  assert.throws(() => parseNativeParentSpawn(raw, parent, 'gsd-planner', 'gpt-6-luna', 'low'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeParentSpawn(raw, parent, 'gsd-plan-checker', 'gpt-6-sol', 'max'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeParentSpawn(raw + raw.split('\n').filter((line) => line.includes('"spawn_agent"'))[0] + '\n',
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'low'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  assert.throws(() => parseNativeParentSpawn(raw.split('\n').filter((line) => !line.includes('"wait_agent"')).join('\n'),
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'low'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  assert.throws(() => parseNativeParentSpawn(transformJsonl(raw, (record) => {
    if (record.type === 'response_item' && record.payload.name === 'spawn_agent') {
      const args = JSON.parse(record.payload.arguments);
      args.fork_turns = 'all';
      record.payload.arguments = JSON.stringify(args);
    }
    return record;
  }), parent, 'gsd-plan-checker', 'gpt-6-luna', 'low'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
});

test('recorded CLI child proves task identity and exact developer instructions', () => {
  const { parentRaw, childRaw, parent, child, instructions } = recordedTypedSession();
  const spawnEvidence = parseNativeParentSpawn(parentRaw, parent, 'gsd-plan-checker', 'gpt-6-luna', 'low');
  const agent = {
    file: '/tmp/codex-home/agents/gsd-plan-checker.toml', sha256: 'a'.repeat(64),
    instructions, instructions_sha256: crypto.createHash('sha256').update(instructions).digest('hex'),
  };
  const observed = parseNativeChildTranscript(childRaw, child, parent, 'gsd-plan-checker',
    'gpt-6-luna', 'low', agent, spawnEvidence);
  assert.equal(observed.task_path, '/root/gsd_task');
  assert.equal(observed.agent_instructions_digest, agent.instructions_sha256);
  const reject = (raw, expectedParent = parent, expectedRole = 'gsd-plan-checker', expectedEffort = 'low', evidence = spawnEvidence) =>
    assert.throws(() => parseNativeChildTranscript(raw, child, expectedParent, expectedRole,
      'gpt-6-luna', expectedEffort, agent, evidence),
    (error) => ['RUNTIME_EVIDENCE_MISMATCH', 'RUNTIME_EVIDENCE_INVALID', 'RUNTIME_EVIDENCE_MISSING'].includes(error.code));
  reject(childRaw, 'other-parent');
  reject(childRaw, parent, 'gsd-planner');
  reject(childRaw, parent, 'gsd-plan-checker', 'high');
  reject(childRaw + childRaw.split('\n')[0] + '\n');
  reject(childRaw.split('\n').filter((line) => !line.includes('"task_complete"')).join('\n'));
  reject(childRaw, parent, 'gsd-plan-checker', 'low', { ...spawnEvidence, task_path: '/root/foreign' });
  reject(transformJsonl(childRaw, (record) => {
    if (record.type === 'response_item' && record.payload.role === 'developer'
        && record.payload.content[0]?.text === instructions) {
      record.payload.content[0].text += 'tampered';
    }
    return record;
  }));
  reject(transformJsonl(childRaw, (record) => {
    if (record.type === 'response_item' && record.payload.role === 'developer'
        && record.payload.content[0]?.text === instructions) record.payload.role = 'assistant';
    return record;
  }));
  reject(transformJsonl(childRaw, (record) => {
    if (record.type === 'response_item' && record.payload.role === 'developer'
        && record.payload.content[0]?.text === instructions) {
      record.payload.content.push({ type: 'input_text', text: instructions });
    }
    return record;
  }));
});

const ROLE_TOML = (instructions) => 'name = "gsd-plan-checker"\ndescription = "Plan checker"\nsandbox_mode = "read-only"\ndeveloper_instructions = \'\'\'\n' + instructions + "'''\n";
const TYPED = { model: 'gpt-6-luna', effort: 'low', sandbox_mode: 'read-only', gsd_role: 'gsd-plan-checker' };

test('typed launch pins a prevalidated GSD file and accepts matching native child evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-typed-'));
  const codeHome = path.join(root, 'codex-home');
  const agents = path.join(codeHome, 'agents');
  const roleFile = path.join(agents, 'gsd-plan-checker.toml');
  const { parent, child, parentRaw, childRaw, instructions } = recordedTypedSession();
  const calls = [];
  try {
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(roleFile, ROLE_TOML(instructions));
    const agent = installedGsdAgent('gsd-plan-checker', { CODEX_HOME: codeHome });
    assert.equal(agent.file, roleFile);
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root }, capabilities, taskDir: root + '-tasks', env: {
        CODEX_HOME: codeHome, GNUPGHOME: '/tmp/secret-gpg', GPG_TTY: '/tmp/tty',
        SSH_AUTH_SOCK: '/tmp/ssh.sock', ANTHROPIC_API_KEY: 'test-secret', OPENAI_API_KEY: 'test-secret',
      },
      spawn: (_executable, args, options) => {
        calls.push({ args, options });
        return relayChild(codeHome, parentRaw, childRaw);
      },
    });
    const result = await launch(CAPTURED_TASK, TYPED);
    assert.equal(result.gsd_role, 'gsd-plan-checker');
    assert.equal(result.runtime_evidence.native_child_evidence.session_id, child);
    assert.equal(result.runtime_evidence.native_child_evidence.parent_thread_id, parent);
    assert.equal(result.runtime_evidence.native_child_evidence.task_path, '/root/gsd_task');
    assert.equal(result.runtime_evidence.native_child_evidence.task_relay.sha256, CAPTURED_SHA256);
    assert.equal(result.runtime_evidence.native_child_evidence.agent_file_digest, agent.sha256);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('agents.gsd-plan-checker.config_file=' + JSON.stringify(roleFile)));
    assert.ok(calls[0].args.includes('features.multi_agent=true'));
    assert.ok(calls[0].args.includes('features.multi_agent_v2=false'));
    assert.equal(calls[0].options.env.GNUPGHOME, undefined);
    assert.equal(calls[0].options.env.GPG_TTY, undefined);
    assert.equal(calls[0].options.env.SSH_AUTH_SOCK, undefined);
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
    fs.appendFileSync(roleFile, 'model = "gpt-6-sol"\n');
    assert.throws(() => installedGsdAgent('gsd-plan-checker', { CODEX_HOME: codeHome }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
  } finally {
    fs.rmSync(root + '-tasks', { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typed launch accepts a completed native child after timeout-only parent waits', async () => {
  const { child, parentRaw, childRaw, instructions } = recordedTypedSession();
  const timeoutOnly = transformJsonl(parentRaw, (record) => {
    if (record.type === 'response_item' && record.payload.type === 'function_call_output'
        && /timed_out/.test(String(record.payload.output))) {
      record.payload.output = '{"message":"Wait timed out.","timed_out":true}';
    }
    return record;
  });
  assert.ok(!timeoutOnly.includes('"timed_out\\":false'));
  const runLaunch = async (childTranscript) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-timeout-'));
    const codeHome = path.join(root, 'codex-home');
    try {
      fs.mkdirSync(path.join(root, 'worktree'));
      fs.mkdirSync(path.join(codeHome, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(codeHome, 'agents', 'gsd-plan-checker.toml'), ROLE_TOML(instructions));
      const launch = createCodexCliLauncher({
        scope: { ...SCOPE, worktree: path.join(root, 'worktree') }, capabilities,
        taskDir: path.join(root, 'tasks'), env: { CODEX_HOME: codeHome },
        spawn: () => relayChild(codeHome, timeoutOnly, childTranscript),
      });
      let started;
      const result = await launch(CAPTURED_TASK, {
        ...TYPED, onSessionStarted(value) { started = value; },
      });
      assert.deepStrictEqual(result.runtime_evidence.sandbox_evidence, started.runtime_launch.sandbox_evidence);
      return result;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const result = await runLaunch(childRaw);
  assert.equal(result.runtime_evidence.native_child_evidence.session_id, child);
  await assert.rejects(runLaunch(null));
  const lines = childRaw.split('\n');
  const completion = lines.find((line) => /task_complete/.test(line));
  assert.ok(completion);
  await assert.rejects(runLaunch(lines.concat(completion).join('\n')));
});

test('typed launch relays the task by host-owned file path and digest outside the worktree', async () => {
  const { parentRaw, childRaw, instructions } = recordedTypedSession();
  const runRelay = async (options = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-relay-'));
    const worktree = path.join(root, 'worktree');
    const taskDir = path.join(root, 'state', 'tasks');
    const codeHome = path.join(root, 'codex-home');
    const input = [];
    const observed = {};
    try {
      fs.mkdirSync(path.join(codeHome, 'agents'), { recursive: true });
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(codeHome, 'agents', 'gsd-plan-checker.toml'), ROLE_TOML(instructions));
      assert.throws(() => createCodexCliLauncher({ scope: { ...SCOPE, worktree }, capabilities,
        taskDir: path.join(worktree, 'tasks') }), (error) => error.code === 'INVALID_STATE_DIR');
      const launch = createCodexCliLauncher({
        scope: { ...SCOPE, worktree }, capabilities, taskDir, env: { CODEX_HOME: codeHome },
        spawn: () => relayChild(codeHome, parentRaw, childRaw, {
          input,
          mutate: options.mutate,
          onTask(task) {
            Object.assign(observed, task, {
              real: fs.realpathSync(task.file), mode: fs.statSync(task.file).mode & 0o777,
              body: fs.readFileSync(task.file, 'utf8'),
            });
            if (options.onTask) options.onTask(task);
          },
        }),
      });
      let outcome;
      try { outcome = { result: await launch(CAPTURED_TASK, { ...TYPED, dispatch_id: 'd-1' }) }; }
      catch (error) { outcome = { error }; }
      assert.equal(observed.mode, 0o600);
      assert.equal(observed.body, CAPTURED_TASK);
      assert.equal(observed.sha256, CAPTURED_SHA256);
      assert.equal(path.dirname(observed.real), fs.realpathSync(taskDir));
      assert.ok(!observed.real.startsWith(fs.realpathSync(worktree) + path.sep));
      assert.ok(input.join('').includes('TASK_FILE=' + observed.file + '\n'));
      assert.ok(!input.join('').includes(CAPTURED_TASK));
      assert.ok(input.join('').includes('filesystem read-only'));
      assert.ok(input.join('').includes('inline python -c or node -e'));
      assert.ok(input.join('').includes('Do not use shell heredocs, create temporary files'));
      assert.ok(input.join('').includes('first small standalone output'));
      assert.ok(input.join('').includes('separate FIRST text item'));
      assert.ok(!fs.existsSync(observed.file));
      return outcome;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const happy = await runRelay();
  assert.equal(happy.error, undefined);
  assert.equal(happy.result.runtime_evidence.native_child_evidence.task_relay.sha256, CAPTURED_SHA256);
  const onToolCall = (edit) => (raw) => transformJsonl(raw, (record) => {
    if (record.type === 'response_item' && record.payload.type === 'custom_tool_call') edit(record.payload);
    return record;
  });
  const tampered = {
    'first tool call reading TASK_FILE': { mutate: (raw, task) => onToolCall((item) => {
      item.input = item.input.split(task.file).join(task.file.slice(0, -3));
    })(raw) },
    'TASK_SHA256 in child tool output': { mutate: (raw) => raw.split(CAPTURED_SHA256 + '  ').join('0'.repeat(64) + '  ') },
    'unchanged task file': { onTask: (task) => fs.appendFileSync(task.file, 'shortened\n') },
    '/root agent_message to /root/gsd_task': { mutate: (raw) => raw.split('\n')
      .filter((line) => !line.includes('"type":"agent_message"')).join('\n') },
    'first tool call reading TASK_FILE ': { mutate: (raw, task) => onToolCall((item) => {
      item.input = item.input.split(task.file).join(path.join(path.dirname(task.file), 'other.md'));
    })(raw) },
  };
  for (const [missing, options] of Object.entries(tampered)) {
    const outcome = await runRelay(options);
    assert.ok(outcome.error, missing);
    assert.equal(outcome.error.code, 'TASK_RELAY_UNVERIFIED', missing + ': ' + outcome.error.message);
    assert.ok(outcome.error.details.missing.includes(missing.trim()), missing + ': ' + outcome.error.message);
  }
  for (const field of ['parent_thread_id', 'agent_role']) {
    const outcome = await runRelay({ mutate: (raw) => transformJsonl(raw, (record) => {
      if (record.type === 'session_meta') {
        record.payload.source.subagent.thread_spawn[field] = 'foreign';
      }
      return record;
    }) });
    assert.equal(outcome.error.code, 'RUNTIME_EVIDENCE_MISMATCH', field);
    assert.equal(outcome.result, undefined);
  }
});

test('actual typed host and adapter retain all-deny launch/completion evidence', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-typed-profile-')));
  const worktree = path.join(root, 'worktree');
  const codeHome = path.join(root, 'codex-home');
  const { parentRaw, childRaw, instructions } = recordedTypedSession();
  let started;
  try {
    fs.mkdirSync(worktree);
    assert.equal(fs.existsSync(path.join(worktree, '.git')), false);
    fs.mkdirSync(path.join(codeHome, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(codeHome, 'agents', 'gsd-plan-checker.toml'), ROLE_TOML(instructions));
    const graph = path.join(worktree, '.planning', 'graph');
    const archive = path.join(worktree, '.shipyard-role-artifacts');
    const authority = path.join(root, 'role-artifact-authority');
    const staging = path.join(root, '.git', 'shipyard-role-archive-staging');
    const resolution = { ...policy.resolveDispatch({
      runtime: 'codex', role: 'decomposition', dispatch_id: 'typed-profile',
    }), gsd_role: 'gsd-plan-checker' };
    const matchingSelection = (raw) => transformJsonl(raw, (record) => {
      if (record.type === 'turn_context') {
        Object.assign(record.payload, { model: resolution.model, effort: resolution.effort });
      }
      if (record.type === 'response_item' && record.payload.type === 'function_call'
          && record.payload.name === 'spawn_agent') {
        const args = JSON.parse(record.payload.arguments);
        Object.assign(args, { model: resolution.model, reasoning_effort: resolution.effort });
        record.payload.arguments = JSON.stringify(args);
      }
      return record;
    });
    const host = createCodexRuntimeHost({
      scope: { ...SCOPE, worktree }, probe: probe(), controller: { assertOwner() {} },
      recorder: () => true, taskDir: path.join(root, 'tasks'),
      env: { CODEX_HOME: codeHome }, additionalProtectedPaths: [authority, staging, graph, archive],
      spawn: () => relayChild(codeHome, matchingSelection(parentRaw), matchingSelection(childRaw)),
    });
    const context = { run_id: SCOPE.run_id, prompt: CAPTURED_TASK, sandbox_mode: 'read-only',
      onSessionStarted(value) { started = value; } };
    const receipt = await createCodexDispatchAdapter({ host }).launch(resolution, context);
    assert.equal(receipt.gsd_role, 'gsd-plan-checker');
    assert.equal(receipt.gsd_launch_mechanism, 'typed-gsd-callback');
    assert.deepStrictEqual(receipt.runtime_evidence.sandbox_evidence, started.runtime_launch.sandbox_evidence);
    const sandbox = receipt.runtime_evidence.sandbox_evidence;
    if (Object.hasOwn(sandbox, 'read_only_protected_paths')) {
      assert.deepStrictEqual(sandbox.read_only_protected_paths, []);
    }
    assert.ok(receipt.runtime_evidence.command.args.includes('permissions.shipyard-runtime.filesystem={'
      + sandbox.protected_paths.map((entry) => JSON.stringify(entry) + '=\"deny\"').join(',') + '}'));
    for (const denied of [authority, staging, graph, archive]) {
      assert.ok(sandbox.protected_paths.includes(denied));
    }

    const applied = { ...receipt, runtime_evidence: receipt.runtime_evidence };
    const validate = (value) => createCodexDispatchAdapter({
      host: { ...host, launchTypedGsd() { return value; } },
    }).launch(resolution, context);
    const clone = () => JSON.parse(JSON.stringify(applied));
    const filesystem = (value, reads = [], permission = 'read') => {
      const evidence = value.runtime_evidence;
      const rules = evidence.sandbox_evidence.protected_paths.map((entry) =>
        JSON.stringify(entry) + '=' + JSON.stringify(reads.includes(entry) ? permission : 'deny'));
      const index = evidence.command.args.findIndex((entry) => entry.startsWith('permissions.shipyard-runtime.filesystem='));
      evidence.command.args[index] = 'permissions.shipyard-runtime.filesystem={' + rules.join(',') + '}';
      evidence.command_digest = crypto.createHash('sha256').update(JSON.stringify(evidence.command.args)).digest('hex');
    };
    const readProfile = () => {
      const value = clone();
      value.runtime_evidence.sandbox_evidence.read_only_protected_paths = [graph, archive];
      filesystem(value, [graph, archive]);
      return value;
    };
    const positive = readProfile();
    assert.deepStrictEqual(validate(positive).runtime_evidence, positive.runtime_evidence);
    const legacyAllDeny = clone();
    delete legacyAllDeny.runtime_evidence.sandbox_evidence.read_only_protected_paths;
    assert.deepStrictEqual(validate(legacyAllDeny).runtime_evidence, legacyAllDeny.runtime_evidence);
    const explicitAllDeny = clone();
    explicitAllDeny.runtime_evidence.sandbox_evidence.read_only_protected_paths = [];
    assert.deepStrictEqual(validate(explicitAllDeny).runtime_evidence, explicitAllDeny.runtime_evidence);

    const rejects = (name, edit, base = readProfile) => {
      const value = base();
      edit(value.runtime_evidence.sandbox_evidence, value);
      assert.throws(() => validate(value), (error) => error.code === 'MISSING_RECEIPT', name);
    };
    for (const invalid of [null, false, {}, 'read', [null], [graph, graph], [archive, archive],
      [path.join(worktree, 'foreign')], [authority], [staging], [graph + '/child'],
      [path.join(root, '.planning', 'graph')], [worktree + '/.planning/../.planning/graph']]) {
      rejects('malformed or foreign read metadata: ' + JSON.stringify(invalid), (sandbox, value) => {
        sandbox.read_only_protected_paths = invalid;
        if (Array.isArray(invalid) && invalid.every((entry) => typeof entry === 'string')) {
          for (const entry of invalid) if (!sandbox.protected_paths.includes(entry)) sandbox.protected_paths.push(entry);
          filesystem(value, invalid);
        }
      });
    }
    rejects('missing read metadata', (sandbox) => { delete sandbox.read_only_protected_paths; });
    rejects('explicit undefined read metadata', (sandbox) => {
      sandbox.read_only_protected_paths = undefined;
    }, clone);
    rejects('incomplete read metadata', (sandbox) => { sandbox.read_only_protected_paths = [graph]; });
    rejects('missing protected metadata', (sandbox) => { delete sandbox.protected_paths; });
    rejects('duplicate protected metadata', (sandbox, value) => {
      sandbox.protected_paths.push(graph); filesystem(value, [graph, archive]);
    });
    rejects('missing protected membership', (sandbox, value) => {
      sandbox.protected_paths = sandbox.protected_paths.filter((entry) => entry !== graph);
      filesystem(value, [graph, archive]);
    });
    rejects('malformed protected metadata', (sandbox) => { sandbox.protected_paths.push(null); });
    for (const denied of [authority, staging]) {
      rejects('missing private denial: ' + denied, (sandbox) => {
        sandbox.protected_paths = sandbox.protected_paths.filter((entry) => entry !== denied);
      });
      rejects('weakened private denial: ' + denied, (_sandbox, value) => {
        filesystem(value, [graph, archive, denied]);
      });
    }
    rejects('unknown profile metadata', (sandbox) => { sandbox.permissions = 'write'; });
    rejects('unknown profile', (sandbox) => { sandbox.profile = 'caller-runtime'; });
    rejects('weakened parent', (sandbox, value) => {
      sandbox.base_profile = ':workspace';
      const args = value.runtime_evidence.command.args;
      args[args.findIndex((entry) => entry.startsWith('permissions.shipyard-runtime.extends='))]
        = 'permissions.shipyard-runtime.extends=":workspace"';
    });
    rejects('read metadata with deny command', (_sandbox, value) => filesystem(value));
    rejects('write instead of read', (_sandbox, value) => filesystem(value, [graph, archive], 'write'));
    for (const prefix of ['default_permissions=', 'permissions.shipyard-runtime.extends=', 'permissions.shipyard-runtime.filesystem=']) {
      rejects('duplicate ' + prefix, (_sandbox, value) => {
        const args = value.runtime_evidence.command.args;
        args.push('--config', args.find((entry) => entry.startsWith(prefix)));
      });
      rejects('missing ' + prefix, (_sandbox, value) => {
        const args = value.runtime_evidence.command.args;
        args.splice(args.findIndex((entry) => entry.startsWith(prefix)) - 1, 2);
      });
    }
    for (const denied of [worktree, path.join(worktree, '.planning'), path.parse(worktree).root]) {
      const stronger = clone();
      stronger.runtime_evidence.sandbox_evidence.protected_paths.push(denied);
      filesystem(stronger);
      assert.deepStrictEqual(validate(stronger).runtime_evidence, stronger.runtime_evidence);
      rejects('read below stronger denial: ' + denied, (sandbox, value) => {
        sandbox.protected_paths.push(denied); filesystem(value, [graph, archive]);
      });
    }
    rejects('noncanonical denial cannot hide an enclosing deny', (sandbox, value) => {
      sandbox.protected_paths.push(worktree + '/.planning/..');
      filesystem(value, [graph, archive]);
    });
    rejects('nonexistent read worktree', (_sandbox, value) => {
      value.runtime_evidence.worktree = path.join(root, 'missing');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual launcher refuses a nonexistent worktree without requiring Git for existing fixtures', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-missing-worktree-')));
  const worktree = path.join(root, 'missing');
  try {
    await assert.rejects(async () => {
      const launch = createCodexCliLauncher({
        scope: { ...SCOPE, worktree }, capabilities,
        executable: process.execPath, taskDir: path.join(root, 'tasks'),
      });
      await launch('fixture', { model: 'gpt-6.1-sol', effort: 'low', sandbox_mode: 'workspace-write' });
    }, (error) => ((error.code === 'ENOENT' || error.code === 'ENOTDIR') && error.path === worktree)
      || (error.code === 'RUNTIME_UNAVAILABLE'
        && ['ENOENT', 'ENOTDIR'].some((code) => error.message
          === 'codex-runtime-host: Codex process failed: spawn ' + process.execPath + ' ' + code)));
    assert.equal(fs.existsSync(worktree), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const transport of ['function', 'custom'])
for (const [materialBytes, tamper] of [[1996419, null], [2553953, null], [1996419, 'missing-read'], [1996419, 'truncated'], [1996419, 'source-drift'], [1996419, 'wrong-echo'], [1996419, 'after-complete'], [1996419, 'foreign-completion'], [1996419, 'failed-read'], [1996419, 'surplus-output'], [1996419, 'known-count-early-asset'], [1996419, 'known-count-complete'], [1996419, 'duplicate-read'], [1996419, 'overlapping-read']].concat(transport === 'custom'
  ? [[1996419, 'unsafe-wrapper']] : [])) test('fixture: ' + transport + ' ' + (tamper || 'complete') + ' ' + materialBytes + '-byte input traverses delivery, static native relay and fresh consumer', async () => {
  const { execFileSync } = require('node:child_process');
  const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const { createCodexDeliveryHost } = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const { codexStaticVariants } = require('../../plugins/delivery-pipeline/scripts/gsd-tune.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'complete-input-fixture-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'complete-input-store-')));
  const scope = { ...SCOPE, worktree: root, run_id: 'complete-input-' + materialBytes };
  const material = 'BEGIN COMPLETE INPUT\n' + 'é'.repeat(Math.floor((materialBytes - 43) / 2))
    + 'x'.repeat((materialBytes - 43) % 2) + '\nEND COMPLETE INPUT!!\n';
  try {
    assert.equal(Buffer.byteLength(material), materialBytes);
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, '.planning/config.json'), '{}');
    for (const args of [['init', '-q'],
      ['config', '--local', 'user.name', 'Shipyard Test'],
      ['config', '--local', 'user.email', 'shipyard-test@example.invalid'],
      ['add', '-A'], ['commit', '-qm', 'fixture']])
      execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args]);
    const agents = path.join(store, 'agents'); fs.mkdirSync(agents, { mode: 0o700 });
    const variants = codexStaticVariants().filter(value => value.role === 'integrator');
    const agentDigests = {};
    for (const variant of variants) {
      const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
        '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
        '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "integrator"',
        '# shipyard-policy-rung = "' + variant.rung + '"', 'name = "' + variant.file.replace(/\.toml$/, '') + '"',
        'model = "' + variant.model + '"', 'model_reasoning_effort = "' + variant.effort + '"',
        'sandbox_mode = "workspace-write"', "developer_instructions = '''",
        'GENERATED INTEGRATOR INSTRUCTIONS', "'''", ''].join('\n');
      fs.writeFileSync(path.join(agents, variant.file), content);
      agentDigests[variant.file] = require('node:crypto').createHash('sha256').update(content).digest('hex');
    }
    const agentManifest = path.join(agents, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
      policy_hash: policy.POLICY_HASH, agent_files: Object.keys(agentDigests), agent_digests: agentDigests }));
    const finiteFixture = ['known-count-early-asset', 'known-count-complete', 'duplicate-read', 'overlapping-read'].includes(tamper);
    let fileInputContext;
    if (finiteFixture) {
      const selection = policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals: { inputTokens: Math.ceil(materialBytes / 4) } });
      const instructions = collector.instructionEvidence(agents, selection.agent_file, agentManifest);
      const parts = material.match(/[\s\S]{1,5000}/gu);
      fileInputContext = collector.prepareFileInput(scope, parts, { role: 'integrator', dispatchId: 'complete-input-dispatch',
        storageRoot: store, generatedInstructionBytes: instructions.generated_instruction_bytes,
        binding: { agent_file: selection.agent_file, agent_path: path.join(agents, selection.agent_file),
          agent_sha256: instructions.sha256, installed_files: instructions.installed_files, policy_hash: selection.policy_hash } });
      const checked = collector.verifyFileInput(fileInputContext);
      assert.ok(Math.ceil(checked.manifest_bytes.length / fileInputContext.input_bundle.chunk_bytes) > 7);
      assert.deepEqual(Buffer.concat(checked.material), Buffer.from(material));
      assert.equal(policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals: { inputTokens: fileInputContext.inputTokens } }).agent_file, selection.agent_file);
    }
    let consumed, stdin, launchedArgs;
    const home = path.join(store, 'codex-home');
    const nativeOptions = { scope, capabilities, env: { CODEX_HOME: home },
      transcriptDir: path.join(store, 'transcripts'), spawn(executable, args) {
        launchedArgs = args;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 24037;
        child.stdin = { write(text) { stdin = text; }, end() {
          try {
            const manifestPath = /^INPUT_MANIFEST=(.*)$/m.exec(stdin)[1];
            const manifest = JSON.parse(fs.readFileSync(manifestPath));
            const bundle = { manifest_path: manifestPath, manifest_sha256: /^INPUT_MANIFEST_SHA256=(.*)$/m.exec(stdin)[1],
              total_bytes: manifest.accounting.material_bytes, asset_count: manifest.assets.length,
              chunk_bytes: manifest.chunk_bytes, max_chunk_reads: manifest.max_chunk_reads,
              manifest_identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'mode'].map(key => [key, fs.statSync(manifestPath)[key]])) };
            consumed = collector.verifyFileInput(bundle, { sealed: true });
            assert.deepEqual(Buffer.concat(consumed.material), Buffer.from(material));
            const selectedModel = args[args.indexOf('--model') + 1];
            const selectedEffort = args.find(value => value.startsWith('model_reasoning_effort=')).split('"')[1];
            const session = '11111111-1111-4111-8111-111111111111';
            const native = writeSession(home, session, selectedModel, selectedEffort);
            const assets = [{ path: manifestPath, bytes: consumed.manifest_bytes },
              ...manifest.assets.map((asset, index) => ({ path: asset.path, bytes: consumed.material[index] }))];
            const templates = captured(PARENT_FIXTURE).split('\n').filter(Boolean).map(JSON.parse);
            const response = templates.find(record => record.type === 'response_item');
            const wrap = payload => ({ ...structuredClone(response), payload });
            const records = [];
            let ordinal = 0;
            for (const asset of assets) for (let index = 0; index < Math.ceil(asset.bytes.length / manifest.chunk_bytes); index++) {
              const cmd = "dd if='" + asset.path + "' bs=" + manifest.chunk_bytes + ' skip=' + index + ' count=1 2>/dev/null | base64';
              const callId = 'fixture-read-' + ordinal++;
              const encoded = asset.bytes.subarray(index * manifest.chunk_bytes, (index + 1) * manifest.chunk_bytes).toString('base64');
              if (transport === 'custom') records.push(wrap({
                type: 'custom_tool_call', name: 'exec', call_id: callId,
                input: 'text(await tools.exec_command(' + JSON.stringify({ cmd, max_output_tokens: 10000 }) + '));',
              }), wrap({ type: 'custom_tool_call_output', call_id: callId,
                output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' },
                  { type: 'input_text', text: JSON.stringify({ chunk_id: callId, wall_time_seconds: 0.1,
                    exit_code: 0, output: encoded }) }],
              }));
              else records.push(wrap({ type: 'function_call', name: 'exec_command', call_id: callId,
                arguments: JSON.stringify({ cmd }) }), wrap({ type: 'function_call_output', call_id: callId,
                output: JSON.stringify({ exit_code: 0, output: encoded }) }));
            }
            if (finiteFixture) {
              const manifestCount = Math.ceil(consumed.manifest_bytes.length / manifest.chunk_bytes);
              assert.ok(consumed.manifest_bytes.subarray(0, manifest.chunk_bytes).includes(Buffer.from('"manifest_bytes":' + consumed.manifest_bytes.length)));
              const checksum = JSON.stringify({ sha256: require('node:crypto').createHash('sha256').update(consumed.manifest_bytes).digest('hex'), chunk_count: manifestCount });
              assert.equal(JSON.parse(checksum).sha256, bundle.manifest_sha256);
              const checksumProgram = 'const fs=require("node:fs"),crypto=require("node:crypto");const bytes=fs.readFileSync(' + JSON.stringify(manifestPath) + ');console.log(JSON.stringify({sha256:crypto.createHash("sha256").update(bytes).digest("hex"),chunk_count:Math.ceil(bytes.length/' + manifest.chunk_bytes + ')}));';
              const cmd = "node -e '" + checksumProgram.replaceAll("'", "'\\''") + "'";
              const checksumRecords = transport === 'custom'
                ? [wrap({ type: 'custom_tool_call', name: 'exec', call_id: 'fixture-checksum',
                  input: 'text(await tools.exec_command(' + JSON.stringify({ cmd, max_output_tokens: 10000 }) + '));' }),
                wrap({ type: 'custom_tool_call_output', call_id: 'fixture-checksum', output: [
                  { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' },
                  { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: checksum }) }] })]
                : [wrap({ type: 'function_call', name: 'exec_command', call_id: 'fixture-checksum', arguments: JSON.stringify({ cmd }) }),
                  wrap({ type: 'function_call_output', call_id: 'fixture-checksum', output: JSON.stringify({ exit_code: 0, output: checksum }) })];
              if (tamper === 'known-count-early-asset') records.splice(14, records.length - 14, ...records.slice(manifestCount * 2, manifestCount * 2 + 2));
              if (tamper === 'duplicate-read') {
                const duplicate = structuredClone(records.slice(0, 2));
                duplicate.forEach(record => { record.payload.call_id = 'fixture-duplicate'; });
                records.splice(2, 0, ...duplicate);
              }
              if (tamper === 'overlapping-read') records.splice(1, 0, records.splice(2, 1)[0]);
              records.unshift(...checksumRecords);
            }
            if (tamper === 'missing-read') records.pop();
            if (tamper === 'unsafe-wrapper') records[0].payload.input += '\ntext("untrusted extra statement");';
            if (tamper === 'failed-read' || tamper === 'surplus-output') {
              if (transport === 'custom') {
                const block = records.at(-1).payload.output[1];
                const captured = JSON.parse(block.text);
                block.text = JSON.stringify(tamper === 'failed-read'
                  ? { ...captured, exit_code: 1 } : { ...captured, output: captured.output + 'AAAA' });
              } else records.at(-1).payload.output = JSON.stringify({
                exit_code: tamper === 'failed-read' ? 1 : 0,
                output: JSON.parse(records.at(-1).payload.output).output + (tamper === 'surplus-output' ? 'AAAA' : ''),
              });
            }
            if (tamper === 'truncated') {
              if (transport === 'custom') {
                const block = records.at(-1).payload.output[1];
                block.text = JSON.stringify({ ...JSON.parse(block.text), output: 'truncated' });
              } else records.at(-1).payload.output = records.at(-1).payload.output.slice(0, 8);
            }
            if (tamper === 'source-drift') fs.writeFileSync(path.join(root, '.planning/config.json'), '{"tampered":true}');

            const output = transformJsonl(stream(session), record => {
              if (record.type === 'item.completed' && record.item.type === 'agent_message') record.item.text = JSON.stringify({
                input_manifest_sha256: tamper === 'wrong-echo' ? 'f'.repeat(64) : bundle.manifest_sha256,
                input_material_bytes: bundle.total_bytes, input_asset_count: bundle.asset_count, input_chunk_reads: consumed.chunk_reads,
              });
              return record;
            });
            const resultText = output.split('\n').filter(Boolean).map(JSON.parse).find(record => record.item?.type === 'agent_message').item.text;
            const parentRecords = fs.readFileSync(native, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
            for (const record of parentRecords) if (record.payload?.type === 'task_complete') record.payload.last_agent_message = tamper === 'foreign-completion' ? 'foreign result' : resultText;
            for (const record of parentRecords) if (record.payload?.type === 'message' && record.payload.phase === 'final_answer') record.payload.content.forEach(block => { block.text = resultText; });
            const boundary = parentRecords.findIndex(record => (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
              || (record.payload?.type === 'item_completed' && record.payload.item?.phase === 'final_answer'));
            parentRecords.splice(tamper === 'after-complete' ? parentRecords.length : boundary, 0, ...records);
            fs.writeFileSync(native, parentRecords.map(JSON.stringify).join('\n') + '\n');
            process.nextTick(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0, null); });
          } catch (error) { process.nextTick(() => child.emit('error', error)); }
        } };
        return child;
      } };
    const host = createCodexRuntimeHost({ ...nativeOptions, probe: probe(),
      recorderDir: path.join(store, 'receipts') });
    const run = () => createCodexDeliveryHost({ scope, host, agentDir: agents, agentManifest, storageRoot: store, fileInputContext })
      .run({ role: 'integrator', ...(fileInputContext ? { signals: { inputTokens: fileInputContext.inputTokens } } : {}), context: fileInputContext
        ? { prompt: fileInputContext.prompt, input_transport: 'host-files', input_bundle: fileInputContext.input_bundle }
        : { prompt: material }, dispatch_id: 'complete-input-dispatch' });
    if (tamper && tamper !== 'known-count-complete') {
      await assert.rejects(run, error => tamper === 'source-drift'
        ? error.code === 'RUNTIME_EVIDENCE_INVALID' && /current source or policy changed/.test(error.message)
        : tamper === 'known-count-early-asset'
          ? error.code === 'RUNTIME_EVIDENCE_MISMATCH' && /reordered, duplicated or exceeds its budget/.test(error.message)
          : ['RUNTIME_EVIDENCE_MISMATCH', 'STALE_CONTEXT'].includes(error.code));
      assert.equal(host.recorder.getVerifiedRecord('complete-input-dispatch'), null);
      return;
    }
    let result;
    await assert.doesNotReject(async () => { result = await run(); },
      'complete input must traverse the supported ' + transport + ' tool ABI');
    assert.ok(stdin.startsWith('GENERATED INTEGRATOR INSTRUCTIONS\n\n'));
    assert.ok(Buffer.byteLength(stdin) < collector.FILE_LIMITS.relay + 100);
    assert.equal(result.receipt.runtime_evidence.input_transport, 'host-files');
    const accounting = result.receipt.runtime_evidence.input_accounting;
    assert.equal(accounting.material_bytes, materialBytes);
    assert.equal(accounting.generated_instruction_bytes, Buffer.byteLength('GENERATED INTEGRATOR INSTRUCTIONS\n\n'));
    assert.equal(result.signals.inputTokens, Math.ceil(Object.values(accounting).reduce((sum, bytes) => sum + bytes, 0) / 4));
    assert.equal(launchedArgs[launchedArgs.indexOf('--model') + 1], result.receipt.applied_model);
    const descriptor = result.receipt.runtime_evidence.input_bundle;
    const inputFile = path.join(store, 'fresh-input.json'); fs.writeFileSync(inputFile, JSON.stringify(descriptor));
    const output = execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))});
      const fs=require('node:fs'); const v=c.verifyFileInput(JSON.parse(fs.readFileSync(process.argv[1])),{sealed:true});
      process.stdout.write(require('node:crypto').createHash('sha256').update(Buffer.concat(v.material)).digest('hex'));`, inputFile], { encoding: 'utf8' });
    assert.equal(output, require('node:crypto').createHash('sha256').update(material).digest('hex'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});

for (const tamper of [null, 'missing', 'missing-start', 'missing-final', 'duplicate', 'duplicate-start', 'duplicate-final', 'reordered', 'foreign-turn', 'foreign-final', 'altered-final', 'divergent-cli', 'late-cli', 'altered-transcript']) {
  test('non-typed runtime completion carries original final: ' + (tamper || 'genuine'), async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-native-final-'));
    const home = path.join(root, 'codex-home');
    const session = '77777777-7777-4777-8777-777777777777';
    let completed;
    let restoreRead = () => {};
    try {
      const host = createCodexRuntimeHost({ scope: { ...SCOPE, worktree: root }, probe: probe(),
        controller: { assertOwner() {} }, recorder: () => true, env: { CODEX_HOME: home }, transcriptDir: null,
        spawn: () => {
          const file = writeSession(home, session);
          const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
          const at = records.findIndex(record => record.payload?.type === 'task_complete');
          if (tamper === 'missing') records.splice(at, 1);
          if (tamper === 'missing-start') records.splice(records.findIndex(record => record.payload?.type === 'task_started'), 1);
          if (tamper === 'missing-final') records.splice(records.findIndex(record => record.payload?.phase === 'final_answer'), 1);
          if (tamper === 'duplicate') records.push(records[at]);
          if (tamper === 'duplicate-start') records.push(records.find(record => record.payload?.type === 'task_started'));
          if (tamper === 'duplicate-final') records.push(records.find(record => record.payload?.phase === 'final_answer'));
          if (tamper === 'foreign-final') records.find(record => record.payload?.phase === 'final_answer')
            .payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign';
          if (tamper === 'reordered') records.unshift(records.splice(at, 1)[0]);
          if (tamper === 'foreign-turn') records[at].payload.turn_id = 'foreign';
          if (tamper === 'altered-final') records.find(record => record.payload?.phase === 'final_answer').payload.content[0].text = 'altered';
          fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
          if (tamper === 'altered-transcript') {
            const originalRead = fs.readFileSync;
            let reads = 0;
            fs.readFileSync = function (target, ...args) {
              if (target === file && ++reads === 2) fs.appendFileSync(file, '\n');
              return originalRead.call(this, target, ...args);
            };
            restoreRead = () => { fs.readFileSync = originalRead; };
          }
          let output = stream(session);
          if (tamper === 'divergent-cli') output = output.replace('"text":"OK"', '"text":"other"');
          if (tamper === 'late-cli') {
            const cli = output.split('\n').filter(Boolean).map(JSON.parse);
            cli.push(cli.splice(2, 1)[0]);
            output = cli.map(JSON.stringify).join('\n') + '\n';
          }
          return childFor(output);
        },
      });
      const launch = () => host.launch({ model: 'gpt-6-luna', reasoning_effort: 'max', sandbox_mode: 'workspace-write' },
        { run_id: SCOPE.run_id, dispatch_id: 'native-final', prompt: 'Return OK.', onCompleted(value) { completed = value; } });
      if (tamper) {
        await assert.rejects(launch, error => /^RUNTIME_EVIDENCE_/.test(error.code));
        assert.equal(completed, undefined);
      } else {
        const result = await launch();
        assert.equal(completed.last_agent_message, 'OK');
        assert.equal(completed.session_id, result.session_id);
        assert.equal(completed.runtime_evidence.native_session_evidence.session_id, session);
      }
    } finally { restoreRead(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('fixture: original 128 KiB capacity refuses; independently wrapped output admits complete ordered reads', async () => {
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const { execFileSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-subject-')));
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-capacity-')));
  const home = path.join(store, 'native');
  const scope = { ...SCOPE, worktree: root };
  const options = { role: 'arch-review', dispatchId: 'reader-tracer', storageRoot: store,
    binding: { policy_hash: policy.POLICY_HASH, ticket_set: ['T-49-01', 'T-49-02'], base: 'exact-base', instructions: 'exact-pin' } };
  const material = ['x'.repeat(128 * 1024 - 1) + '€' + 'é'.repeat(70000),
    ...Array.from({ length: 600 }, (_, ordinal) => 'source ordinal ' + ordinal + ' €'), 'short terminal €'];
  const result = 'reader complete';
  const session = '11111111-1111-4111-8111-111111111111';
  try {
    fs.mkdirSync(path.join(root, '.planning'));
    fs.writeFileSync(path.join(root, '.planning/config.json'), '{}');
    for (const argv of [['init', '-q'], ['config', '--local', 'user.name', 'Shipyard Test'],
      ['config', '--local', 'user.email', 'shipyard-test@example.invalid'],
      ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']])
      execFileSync('git', argv, { cwd: root, stdio: 'pipe' });
    const native = writeSession(home, session, 'gpt-6-luna', 'max');
    const original = fs.readFileSync(native, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const response = original.find(record => record.type === 'response_item');
    const wrap = payload => ({ ...structuredClone(response), payload });
    const transcript = (prepared, chunkBytes, wrapped = false) => {
      const checked = collector.verifyFileInput(prepared);
      const assets = [{ path: prepared.input_bundle.manifest_path, bytes: checked.manifest_bytes },
        ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
      const reads = [];
      for (const asset of assets) for (let index = 0; index < Math.ceil(asset.bytes.length / chunkBytes); index++) {
        const id = 'read-' + reads.length;
        const cmd = "dd if='" + asset.path + "' bs=" + chunkBytes + ' skip=' + index + ' count=1 2>/dev/null | base64';
        const base64 = asset.bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64');
        const encoded = wrapped ? base64.match(/.{1,76}/g).join('\n') + '\n' : base64;
        reads.push(wrap({ type: 'custom_tool_call', name: 'exec', call_id: id,
          input: 'text(await tools.exec_command(' + JSON.stringify({ cmd, max_output_tokens: 10000 }) + '));' }),
        wrap({ type: 'custom_tool_call_output', call_id: id, output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' },
          { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: encoded }) }] }));
      }
      const records = structuredClone(original);
      for (const record of records) {
        if (record.payload?.type === 'task_complete') record.payload.last_agent_message = result;
        if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
          record.payload.content.forEach(block => { block.text = result; });
      }
      const boundary = records.findIndex(record => record.payload?.phase === 'final_answer'
        || record.payload?.item?.phase === 'final_answer');
      records.splice(boundary, 0, ...reads);
      return records;
    };
    const encode = records => records.map(JSON.stringify).join('\n') + '\n';
    const legacy = collector.prepareFileInput(scope, material, options);
    const legacyChecked = runtime.verifyFileConsumption(legacy, encode(transcript(legacy, 8192)), options.dispatchId, result);
    assert.deepEqual(legacyChecked.material, material.map(value => Buffer.from(value)));
    assert.equal(legacyChecked.chunk_reads, Math.ceil(legacyChecked.manifest_bytes.length / 8192)
      + legacyChecked.material.reduce((sum, bytes) => sum + Math.ceil(bytes.length / 8192), 0));
    assert.throws(() => runtime.measureReaderCapacity({ native_session_evidence: {} }, legacy),
      error => error.code === 'READER_CAPACITY_UNSUPPORTED');
    fs.writeFileSync(native, encode(transcript(legacy, 128 * 1024)));
    const verified = await runtime.verifyCompletedNativeLaunch({ session_id: session,
      selection: { model: 'gpt-6-luna', effort: 'max' }, env: { CODEX_HOME: home }, resultText: result });
    const insufficientCapacity = runtime.measureReaderCapacity(verified, legacy);
    assert.equal(insufficientCapacity.contract.chunk_bytes, 128 * 1024);
    const observedBound = insufficientCapacity.contract.output_budget_bytes;
    const encodedRangeBytes = 4 * Math.ceil(128 * 1024 / 3);
    const requiredBound = encodedRangeBytes + 2 * Math.ceil(encodedRangeBytes / 76) + 4096;
    assert.equal(observedBound, 179006);
    assert.equal(requiredBound, 183460);
    assert.equal(insufficientCapacity.contract.output_budget_bytes, observedBound);
    assert.throws(() => collector.prepareFileInput(scope, material, { ...options, readerCapacity: insufficientCapacity }),
      error => error.code === 'READER_CAPACITY_UNSUPPORTED'
        && error.refusal.limiting_field === 'encoded_range_envelope_bytes'
        && error.refusal.observed === observedBound && error.refusal.required === requiredBound);
    const wrappedHome = path.join(store, 'wrapped-native');
    const wrappedNative = writeSession(wrappedHome, session, 'gpt-6-luna', 'max');
    const wrappedOriginal = encode(transcript(legacy, 128 * 1024, true));
    fs.writeFileSync(wrappedNative, wrappedOriginal);
    const wrappedVerified = await runtime.verifyCompletedNativeLaunch({ session_id: session,
      selection: { model: 'gpt-6-luna', effort: 'max' }, env: { CODEX_HOME: wrappedHome }, resultText: result });
    const capacity = runtime.measureReaderCapacity(wrappedVerified, legacy);
    const prospectiveManifest = { ...legacy.manifest, chunk_bytes: 128 * 1024, transport: capacity.contract };
    const schedule = collector.preflightReaderSchedule(prospectiveManifest, legacyChecked.manifest_bytes.length);
    assert.ok(schedule.largest_envelope_bytes <= capacity.contract.output_budget_bytes);
    assert.equal(fs.readFileSync(native, 'utf8'), encode(transcript(legacy, 128 * 1024)));
    assert.equal(fs.readFileSync(wrappedNative, 'utf8'), wrappedOriginal);
    const admitted = collector.prepareFileInput(scope, material, { ...options, readerCapacity: capacity });
    assert.equal(admitted.manifest.schema, 'shipyard.host-file-input.v2');
    assert.ok(admitted.manifest.accounting.manifest_bytes > 128 * 1024);
    assert.ok(admitted.prompt.includes('bs=131072'));
    assert.ok(admitted.prompt.includes('READER_TRANSPORT='));
    const admittedSchedule = collector.preflightReaderSchedule(admitted.manifest,
      collector.verifyFileInput(admitted).manifest_bytes.length);
    assert.ok(admittedSchedule.largest_envelope_bytes <= capacity.contract.output_budget_bytes);
    const complete = transcript(admitted, 128 * 1024, true);
    const checked = runtime.verifyFileConsumption(admitted, encode(complete), options.dispatchId, result);
    assert.deepEqual(checked.material, material.map(value => Buffer.from(value)));
    assert.ok(checked.chunk_reads < legacyChecked.chunk_reads);
    assert.ok(checked.output_bytes > checked.encoded_bytes);
    assert.ok(checked.transport_accounting.outer_output_bytes > checked.transport_accounting.nested_output_bytes);
    const reconstructed = complete.filter(record => record.payload?.type === 'custom_tool_call_output')
      .map(record => Buffer.from(JSON.parse(record.payload.output[1].text).output, 'base64'));
    assert.equal(checked.chunk_reads, reconstructed.length);
    assert.equal(checked.chunk_reads, admitted.manifest.ranges.length);
    assert.equal(checked.transport_accounting.raw_bytes, reconstructed.reduce((sum, bytes) => sum + bytes.length, 0));
    assert.ok(reconstructed.some(bytes => bytes.length === 128 * 1024));
    assert.deepEqual(reconstructed.at(-1), Buffer.from('short terminal €'));
    assert.deepEqual(Buffer.concat(reconstructed), Buffer.concat([checked.manifest_bytes, ...checked.material]));
    for (const mutate of [
      records => records.splice(records.findIndex(r => r.payload?.type === 'custom_tool_call_output'), 1),
      records => { const i = records.findIndex(r => r.payload?.type === 'custom_tool_call'); records.splice(i + 2, 0, structuredClone(records[i + 1])); },
      records => { const outputs = records.filter(r => r.payload?.type === 'custom_tool_call_output'); [outputs[0].payload.output, outputs[1].payload.output] = [outputs[1].payload.output, outputs[0].payload.output]; },
      records => { const output = records.find(r => r.payload?.type === 'custom_tool_call_output'); output.payload.output[1].text = JSON.stringify({ exit_code: 1, output: '' }); },
      records => { const output = records.find(r => r.payload?.type === 'custom_tool_call_output'); output.payload.output[1].text = JSON.stringify({ exit_code: 0, output: 'hash/count only' }); },
      records => { const output = records.find(r => r.payload?.type === 'custom_tool_call_output'); const envelope = JSON.parse(output.payload.output[1].text); envelope.output = envelope.output.slice(0, -4); output.payload.output[1].text = JSON.stringify(envelope); },
      records => { const call = records.find(r => r.payload?.type === 'custom_tool_call'); call.payload.internal_chat_message_metadata_passthrough = { turn_id: 'foreign' }; },
      records => { const call = records.find(r => r.payload?.type === 'custom_tool_call'); call.payload.input = call.payload.input.replace('10000', '9999'); },
      records => { const output = records.find(r => r.payload?.type === 'custom_tool_call_output'); const envelope = JSON.parse(output.payload.output[1].text); envelope.output += 'AAAA'; output.payload.output[1].text = JSON.stringify(envelope); },
      records => { const i = records.findIndex(r => r.payload?.type === 'custom_tool_call_output'); records.push(records.splice(i, 1)[0]); },
      records => { const i = records.findIndex(r => r.payload?.type === 'custom_tool_call'); records.splice(i + 1, 0, records.splice(i + 2, 1)[0]); },
      records => { const call = records.find(r => r.payload?.type === 'custom_tool_call'); call.payload.input = call.payload.input.replace('skip=0', 'skip=1'); },
      records => { const calls = records.filter(r => r.payload?.type === 'custom_tool_call'); calls[1].payload.call_id = calls[0].payload.call_id; },
    ]) {
      const altered = structuredClone(complete); mutate(altered);
      assert.throws(() => runtime.verifyFileConsumption(admitted, encode(altered), options.dispatchId, result),
        error => ['RUNTIME_EVIDENCE_MISMATCH', 'READER_CAPACITY_UNSUPPORTED'].includes(error.code));
    }
    for (const changes of [{ dispatchId: 'foreign' }, { role: 'integrator' }, { binding: { base: 'foreign' } },
      { readerCapacity: JSON.parse(JSON.stringify(capacity)) }])
      assert.throws(() => collector.prepareFileInput(scope, material, { ...options, readerCapacity: capacity, ...changes }),
        error => error.code === 'READER_CAPACITY_UNSUPPORTED');
    const truncated = transcript(legacy, 128 * 1024);
    const output = truncated.find(record => record.payload?.type === 'custom_tool_call_output');
    output.payload.output[1].text = JSON.stringify({ exit_code: 0, output: 'truncated' });
    fs.writeFileSync(wrappedNative, encode(truncated));
    const incomplete = await runtime.verifyCompletedNativeLaunch({ session_id: session,
      selection: { model: 'gpt-6-luna', effort: 'max' }, env: { CODEX_HOME: wrappedHome }, resultText: result });
    assert.throws(() => runtime.measureReaderCapacity(incomplete, legacy),
      error => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
    assert.throws(() => collector.prepareFileInput(scope, material, { ...options, readerCapacity: capacity }),
      error => error.code === 'RUNTIME_EVIDENCE_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

done();
