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

function stream(session = '11111111-1111-4111-8111-111111111111') {
  return [
    { type: 'thread.started', thread_id: session },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function sessionTranscript(session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  return [
    { type: 'session_meta', payload: { id: session, session_id: session, model_provider: provider } },
    { type: 'turn_context', payload: { model, effort } },
    { type: 'response_item', payload: { item: { model: 'gpt-6-astra', effort: 'low' } } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
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
  const parentRaw = fs.readFileSync(path.join(__dirname, '../fixtures/codex-agent-parent-0.155.1.jsonl'), 'utf8');
  const childRaw = fs.readFileSync(path.join(__dirname, '../fixtures/codex-agent-child-0.155.1.jsonl'), 'utf8');
  const parent = '01a0ce68-961a-72d1-b55e-d293ab9d19f4';
  const child = '01a0ce68-afef-7bc2-baa6-b1ae8d6ce121';
  const instructions = childRaw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((record) => record.type === 'response_item' && record.payload.role === 'developer')
    .payload.content[0].text;
  return { parentRaw, childRaw, parent, child, instructions };
}

function transformJsonl(raw, transform) {
  return raw.split('\n').filter(Boolean).map((line) => JSON.stringify(transform(JSON.parse(line)))).join('\n') + '\n';
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

test('recorded CLI 0.155.1 parent proves an explicit native typed spawn', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../fixtures/codex-agent-parent-0.155.1.jsonl'), 'utf8');
  const parent = '01a0ce68-961a-72d1-b55e-d293ab9d19f4';
  const value = parseNativeParentSpawn(raw, parent, 'gsd-plan-checker', 'gpt-6-luna', 'max');
  assert.equal(value.parent_thread_id, parent);
  assert.equal(value.task_name, 'plan_checker_ready');
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
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'max').task_name, 'plan_checker_ready');
  assert.throws(() => parseNativeParentSpawn(raw, parent, 'gsd-planner', 'gpt-6-luna', 'max'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeParentSpawn(raw, parent, 'gsd-plan-checker', 'gpt-6-sol', 'max'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  assert.throws(() => parseNativeParentSpawn(raw + raw.split('\n').filter((line) => line.includes('"spawn_agent"'))[0] + '\n',
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'max'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  assert.throws(() => parseNativeParentSpawn(raw.split('\n').filter((line) => !line.includes('"wait_agent"')).join('\n'),
    parent, 'gsd-plan-checker', 'gpt-6-luna', 'max'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  assert.throws(() => parseNativeParentSpawn(transformJsonl(raw, (record) => {
    if (record.type === 'response_item' && record.payload.name === 'spawn_agent') {
      const args = JSON.parse(record.payload.arguments);
      args.fork_turns = 'all';
      record.payload.arguments = JSON.stringify(args);
    }
    return record;
  }), parent, 'gsd-plan-checker', 'gpt-6-luna', 'max'),
  (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
});

test('recorded CLI child proves task identity and exact developer instructions', () => {
  const { parentRaw, childRaw, parent, child, instructions } = recordedTypedSession();
  const spawnEvidence = parseNativeParentSpawn(parentRaw, parent, 'gsd-plan-checker', 'gpt-6-luna', 'max');
  const agent = {
    file: '/tmp/codex-home/agents/gsd-plan-checker.toml', sha256: 'a'.repeat(64),
    instructions, instructions_sha256: crypto.createHash('sha256').update(instructions).digest('hex'),
  };
  const observed = parseNativeChildTranscript(childRaw, child, parent, 'gsd-plan-checker',
    'gpt-6-luna', 'max', agent, spawnEvidence);
  assert.equal(observed.task_path, '/root/plan_checker_ready');
  assert.equal(observed.agent_instructions_digest, agent.instructions_sha256);
  const reject = (raw, expectedParent = parent, expectedRole = 'gsd-plan-checker', expectedEffort = 'max', evidence = spawnEvidence) =>
    assert.throws(() => parseNativeChildTranscript(raw, child, expectedParent, expectedRole,
      'gpt-6-luna', expectedEffort, agent, evidence),
    (error) => ['RUNTIME_EVIDENCE_MISMATCH', 'RUNTIME_EVIDENCE_INVALID', 'RUNTIME_EVIDENCE_MISSING'].includes(error.code));
  reject(childRaw, 'other-parent');
  reject(childRaw, parent, 'gsd-planner');
  reject(childRaw, parent, 'gsd-plan-checker', 'high');
  reject(childRaw + childRaw.split('\n')[0] + '\n');
  reject(childRaw.split('\n').filter((line) => !line.includes('"task_complete"')).join('\n'));
  reject(childRaw, parent, 'gsd-plan-checker', 'max', { ...spawnEvidence, task_path: '/root/foreign' });
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

test('typed launch pins a prevalidated GSD file and accepts matching native child evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-typed-'));
  const codeHome = path.join(root, 'codex-home');
  const agents = path.join(codeHome, 'agents');
  const roleFile = path.join(agents, 'gsd-plan-checker.toml');
  const { parent, child, parentRaw, childRaw, instructions } = recordedTypedSession();
  const calls = [];
  try {
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(roleFile, 'name = "gsd-plan-checker"\ndescription = "Plan checker"\nsandbox_mode = "read-only"\ndeveloper_instructions = \'\'\'\n' + instructions + "'''\n");
    const agent = installedGsdAgent('gsd-plan-checker', { CODEX_HOME: codeHome });
    assert.equal(agent.file, roleFile);
    const launch = createCodexCliLauncher({
      scope: { ...SCOPE, worktree: root }, capabilities, env: {
        CODEX_HOME: codeHome, GNUPGHOME: '/tmp/secret-gpg', GPG_TTY: '/tmp/tty',
        SSH_AUTH_SOCK: '/tmp/ssh.sock', ANTHROPIC_API_KEY: 'test-secret', OPENAI_API_KEY: 'test-secret',
      },
      spawn: (_executable, args, options) => {
        calls.push({ args, options });
        const directory = path.join(codeHome, 'sessions', String(new Date().getFullYear()),
          String(new Date().getMonth() + 1).padStart(2, '0'), String(new Date().getDate()).padStart(2, '0'));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'rollout-' + parent + '.jsonl'), parentRaw);
        fs.writeFileSync(path.join(directory, 'rollout-' + child + '.jsonl'), childRaw);
        return childFor(stream(parent), 0, 24050);
      },
    });
    const result = await launch('Check the scoped plan', {
      model: 'gpt-6-luna', effort: 'max', sandbox_mode: 'read-only', gsd_role: 'gsd-plan-checker',
    });
    assert.equal(result.gsd_role, 'gsd-plan-checker');
    assert.equal(result.runtime_evidence.native_child_evidence.session_id, child);
    assert.equal(result.runtime_evidence.native_child_evidence.task_path, '/root/plan_checker_ready');
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
