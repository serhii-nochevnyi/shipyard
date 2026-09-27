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

const SCOPE = {
  run_id: 'run-37-04',
  ticket: 'T-37-04',
  phase: 37,
  worktree: '/tmp/shipyard-t3704',
  runtime: 'codex',
  provider: 'openai',
};

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
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

function staticContent(resolution = { model: 'gpt-6-sol', effort: 'high' }) {
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
        writeSession(options.env.CODEX_HOME, '33333333-3333-4333-8333-333333333333', 'gpt-6-sol', 'high');
        return childFor(stream('33333333-3333-4333-8333-333333333333'), 0, 24039, input);
      },
    });
    const content = staticContent();
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    await launch('ticket contract', {
      model: 'gpt-6-sol',
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
        model: 'gpt-6-sol',
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
    assert.equal(result.receipt.applied_model, 'gpt-6-luna');
    assert.equal(result.receipt.applied_effort, 'max');
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
      fs.mkdirSync(path.join(codeHome, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(codeHome, 'agents', 'gsd-plan-checker.toml'), ROLE_TOML(instructions));
      const launch = createCodexCliLauncher({
        scope: { ...SCOPE, worktree: path.join(root, 'worktree') }, capabilities,
        taskDir: path.join(root, 'tasks'), env: { CODEX_HOME: codeHome },
        spawn: () => relayChild(codeHome, timeoutOnly, childTranscript),
      });
      return await launch(CAPTURED_TASK, TYPED);
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
});

done();
