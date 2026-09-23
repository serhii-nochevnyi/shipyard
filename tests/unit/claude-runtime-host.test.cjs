'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  EFFORTS,
  createClaudeCliLauncher,
  createClaudeRuntimeHost,
  observedSelection,
  parseClaudeStream,
  probeClaudeRuntime,
} = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
const { CLAUDE_MODEL_ALIASES } = require('../../plugins/delivery-pipeline/scripts/runtime-adapters.cjs');
const { capture: captureSessionStart } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');

const SESSION = '11111111-1111-4111-8111-111111111111';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-assistant-session.jsonl');
const SCOPE = {
  run_id: 'run-38-02',
  ticket: 'T-38-02',
  phase: 38,
  worktree: '/tmp/shipyard-t3802',
  runtime: 'claude',
  provider: 'anthropic',
};

function stream(session = SESSION) {
  return [
    { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5', effort: 'high' },
    { type: 'assistant', session_id: session, message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 4 } }, effort: 'high' },
    { type: 'result', session_id: session, model: 'claude-opus-5', effort: 'high', result: 'done' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function childFor(output, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.pid = 24038;
  process.nextTick(() => {
    if (output) child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  });
  return child;
}

function fixtureRecords() {
  return fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function typedFixtureRecords(role) {
  return [
    ...fixtureRecords().map((record) => {
      if (record.type !== 'assistant') return record;
      const { agentSetting, ...rest } = record;
      return rest;
    }),
    { type: 'agent-setting', sessionId: SESSION, agentSetting: role },
  ];
}

function writeSession(root, records, session = SESSION, project = 'project-a') {
  const directory = path.join(root, project);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${session}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function captureConfiguredSessionStart(args, transcriptPath, agentType) {
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  const worktree = settings.sandbox.filesystem.allowWrite[0];
  const hook = settings.hooks.SessionStart[0].hooks[0];
  const hookArgs = hook.args;
  const value = (name) => hookArgs[hookArgs.indexOf(name) + 1];
  captureSessionStart({
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: value('--expected-session'),
    transcript_path: transcriptPath,
    ...(agentType ? { agent_type: agentType } : {}),
    cwd: worktree,
  }, {
    evidenceFile: value('--evidence-file'),
    expectedSession: value('--expected-session'),
    ...(hookArgs.includes('--expected-agent') ? { expectedAgent: value('--expected-agent') } : {}),
  });
}

function probe() {
  return {
    schema: 'shipyard.claude-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable: 'claude',
    runtime_version: '2.1.280',
    capabilities: {
      supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
      supportedEfforts: EFFORTS,
      observedModel: true,
      observedEffort: true,
      assistantTranscriptEvidence: true,
      restrictedTools: true,
      sandboxedBash: true,
    },
  };
}

suite('claude-runtime-host — exact-session selection and scoped launch');

test('stream identifies the process session but does not establish model or effort', () => {
  const parsed = parseClaudeStream(stream());
  assert.equal(parsed.session_id, SESSION);
  assert.equal(parsed.assistant_count, 1);
  assert.equal(parsed.usage_count, 1);
});

test('only matching assistant transcript records establish Opus 5.5 and effort', () => {
  const selected = observedSelection(fixtureRecords(), SESSION, 'claude-opus-5-5', 'low');
  assert.deepEqual(selected, {
    model: 'claude-opus-5-5',
    effort: 'low',
    assistant_records: 2,
  });
});

test('the rolling Fable alias accepts the pinned hyphenated model ID', () => {
  assert.deepEqual(observedSelection([
    { type: 'assistant', sessionId: SESSION, effort: 'high', message: { model: 'claude-fable-5-1' } },
  ], SESSION, 'fable', 'high'), {
    model: 'claude-fable-5-1',
    effort: 'high',
    assistant_records: 1,
  });
});

test('rolling aliases require a concrete model ID in the session transcript', () => {
  assert.throws(
    () => observedSelection([
      { type: 'assistant', sessionId: SESSION, effort: 'high', message: { model: 'sonnet' } },
    ], SESSION, 'sonnet', 'high'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH',
  );
});

test('model and effort from separate incomplete records cannot be combined', () => {
  assert.throws(
    () => observedSelection([
      { type: 'assistant', sessionId: SESSION, message: { model: 'claude-opus-5-5' } },
      { type: 'assistant', sessionId: SESSION, effort: 'low', message: { role: 'assistant' } },
    ], SESSION, 'claude-opus-5-5', 'low'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISSING',
  );
});

test('does not accept an older Opus ID from an assistant record', () => {
  const records = fixtureRecords();
  records.push({
    type: 'assistant',
    sessionId: SESSION,
    effort: 'low',
    message: { role: 'assistant', model: 'claude-opus-5' },
  });
  assert.throws(
    () => observedSelection(records, SESSION, 'claude-opus-5-5', 'low'),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH',
  );
});

test('native launcher ignores conflicting stdout model and effort and records transcript proof', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-runtime-'));
  const projects = path.join(root, 'claude', 'projects');
  const transcript = writeSession(projects, fixtureRecords());
  const calls = [];
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: path.join(root, 'stream-transcripts'),
      transcriptPollMs: 5,
      uuid: () => SESSION,
      env: {
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_BASE_URL: 'https://provider.invalid',
        OPENAI_API_KEY: 'test-openai-key',
        CODEX_API_KEY: 'test-codex-key',
        GITHUB_TOKEN: 'test-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      },
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        captureConfiguredSessionStart(args, transcript);
        return childFor(stream());
      },
      runtime_version: '2.1.280',
    });
    const result = await launch('run the scoped task', { model: 'claude-opus-5-5', effort: 'low' });
    const args = calls[0].args;
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'claude');
    assert.equal(calls[0].options.cwd, root);
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.equal(args[args.indexOf('--effort') + 1], 'low');
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash,Read,Edit,Write,Glob,Grep');
    assert.equal(args[args.indexOf('--tools') + 1], 'Bash,Read,Edit,Write,Glob,Grep');
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    const evidenceFile = settings.hooks.SessionStart[0].hooks[0].args[2];
    const evidenceGlob = `//${path.dirname(evidenceFile).split(path.sep).filter(Boolean).join('/')}/**`;
    for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      assert.ok(settings.permissions.deny.includes(`${tool}(${evidenceGlob})`));
    }
    assert.deepEqual(settings.sandbox.filesystem.allowWrite[0], root);
    assert.equal(settings.sandbox.filesystem.allowWrite.length, 1);
    assert.ok(settings.sandbox.credentials.envVars.some((item) => item.name === 'GITHUB_TOKEN' && item.mode === 'deny'));
    assert.ok(settings.sandbox.credentials.envVars.some((item) => item.name === 'CLAUDE_CODE_OAUTH_TOKEN' && item.mode === 'deny'));
    assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, path.join(root, 'claude'));
    assert.equal(calls[0].options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, 'test-key');
    assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, 'https://provider.invalid');
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(calls[0].options.env.CODEX_API_KEY, undefined);
    assert.equal(calls[0].options.env.GITHUB_TOKEN, 'test-token');
    assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth-token');
    assert.equal(result.applicationEvidence.applied_model, 'claude-opus-5-5');
    assert.equal(result.applicationEvidence.applied_effort, 'low');
    assert.equal(result.applicationEvidence.observed_model, 'claude-opus-5-5');
    assert.equal(result.applicationEvidence.observed_effort, 'low');
    assert.equal(result.applicationEvidence.process_id, 24038);
    assert.equal(result.applicationEvidence.runtime_version, '2.1.280');
    assert.equal(result.applicationEvidence.stream_evidence.format, 'stream-json');
    assert.ok(!Object.hasOwn(result.applicationEvidence.stream_evidence, 'models'));
    assert.ok(fs.existsSync(result.applicationEvidence.transcript.path));
    assert.equal(result.applicationEvidence.selection_evidence.source, 'claude-session-assistant-transcript');
    assert.equal(result.applicationEvidence.selection_evidence.assistant_records, 2);
    assert.equal(result.applicationEvidence.selection_evidence.transcript.path, `project-a/${SESSION}.jsonl`);
    assert.equal(result.applicationEvidence.selection_evidence.transcript.bytes, fs.statSync(transcript).size);
    assert.match(result.applicationEvidence.selection_evidence.transcript.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.dirname(JSON.parse(args[args.indexOf('--settings') + 1]).hooks.SessionStart[0].hooks[0].args[2])), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waits for a flushed transcript and ignores stdout-only model and effort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-flush-'));
  const projects = path.join(root, 'projects');
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: null,
      sessionTranscriptRoot: projects,
      transcriptTimeoutMs: 1000,
      transcriptPollMs: 5,
      uuid: () => SESSION,
      spawn: (_executable, args) => {
        const anticipated = path.join(projects, 'project-a', `${SESSION}.jsonl`);
        fs.mkdirSync(path.dirname(anticipated), { recursive: true });
        captureConfiguredSessionStart(args, anticipated);
        setTimeout(() => writeSession(projects, fixtureRecords()), 15);
        return childFor(stream());
      },
    });
    const result = await launch('wait for transcript flush', { model: 'claude-opus-5-5', effort: 'low' });
    assert.equal(result.applicationEvidence.selection_evidence.session_id, SESSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing native transcript refuses even when stdout reports model and effort', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-no-transcript-'));
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: null,
      sessionTranscriptRoot: path.join(root, 'projects'),
      transcriptTimeoutMs: 20,
      transcriptPollMs: 5,
      uuid: () => SESSION,
      spawn: () => childFor(stream()),
    });
    await assert.rejects(
      () => launch('missing proof', { model: 'claude-opus-5-5', effort: 'low' }),
      (error) => error.code === 'RUNTIME_EVIDENCE_MISSING',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('contradictory assistant transcript selection refuses a successful process exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-conflict-'));
  const projects = path.join(root, 'projects');
  try {
    writeSession(projects, [
      { type: 'assistant', sessionId: SESSION, effort: 'low', message: { model: 'claude-opus-5-5' } },
      { type: 'assistant', sessionId: SESSION, effort: 'high', message: { model: 'claude-opus-5-5' } },
    ]);
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: null,
      sessionTranscriptRoot: projects,
      transcriptPollMs: 5,
      uuid: () => SESSION,
      spawn: (_executable, args) => {
        captureConfiguredSessionStart(args, path.join(projects, 'project-a', `${SESSION}.jsonl`));
        return childFor(stream());
      },
    });
    await assert.rejects(
      () => launch('contradictory proof', { model: 'claude-opus-5-5', effort: 'low' }),
      (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typed GSD launch applies --agent and proves it in SessionStart and agent-setting records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-gsd-agent-'));
  const projects = path.join(root, 'claude', 'projects');
  const agents = path.join(root, 'claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'gsd-plan-checker.md'), '---\nname: gsd-plan-checker\ndescription: Check phase plans\ntools: Read, Bash, Glob, Grep\ndisallowedTools: Write, Edit\n---\nCheck the plan.\n');
  const transcript = writeSession(projects, typedFixtureRecords('gsd-plan-checker'));
  let capturedArgs;
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: null,
      transcriptPollMs: 5,
      uuid: () => SESSION,
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
      spawn: (_executable, args) => {
        capturedArgs = args;
        captureConfiguredSessionStart(args, transcript, 'gsd-plan-checker');
        return childFor(stream());
      },
    });
    const result = await launch('check the plan', {
      model: 'claude-opus-5-5', effort: 'low', gsd_role: 'gsd-plan-checker',
    });
    assert.equal(capturedArgs[capturedArgs.indexOf('--agent') + 1], 'gsd-plan-checker');
    assert.equal(capturedArgs.includes('--restricted'), true);
    const agent = JSON.parse(capturedArgs[capturedArgs.indexOf('--agents') + 1]);
    assert.deepEqual(agent['gsd-plan-checker'].tools, ['Bash', 'Read', 'Glob', 'Grep']);
    assert.equal(agent['gsd-plan-checker'].prompt, 'Check the plan.\n');
    assert.ok(capturedArgs.includes('--strict-mcp-config'));
    assert.equal(capturedArgs[capturedArgs.indexOf('--tools') + 1], 'Bash,Read,Glob,Grep');
    assert.equal(capturedArgs[capturedArgs.indexOf('--allowedTools') + 1], 'Bash,Read,Glob,Grep');
    assert.deepEqual(result.applicationEvidence.gsd_agent_evidence, {
      schema: 'shipyard.gsd-agent-application.v1',
      runtime: 'claude',
      role: 'gsd-plan-checker',
      session_id: SESSION,
      session_start_agent_type: 'gsd-plan-checker',
      transcript_agent_setting: 'gsd-plan-checker',
      agent_setting_records: 1,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typed GSD launch refuses when the transcript does not name the requested agent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-gsd-agent-mismatch-'));
  const projects = path.join(root, 'claude', 'projects');
  const agents = path.join(root, 'claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'gsd-plan-checker.md'), '---\nname: gsd-plan-checker\ndescription: Check phase plans\ntools: Read, Bash, Glob, Grep\n---\nCheck the plan.\n');
  const transcript = writeSession(projects, typedFixtureRecords('gsd-planner'));
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      transcriptDir: null,
      transcriptPollMs: 5,
      uuid: () => SESSION,
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
      spawn: (_executable, args) => {
        captureConfiguredSessionStart(args, transcript, 'gsd-plan-checker');
        return childFor(stream());
      },
    });
    await assert.rejects(() => launch('check the plan', {
      model: 'claude-opus-5-5', effort: 'low', gsd_role: 'gsd-plan-checker',
    }), (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('typed GSD evidence requires an exact-session agent-setting record', () => {
  const records = typedFixtureRecords('gsd-plan-checker');
  const args = [SESSION, 'claude-opus-5-5', 'low', 'gsd-plan-checker'];
  assert.throws(() => observedSelection(records.filter((record) => record.type !== 'agent-setting'), ...args),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  const foreign = records.map((record) => record.type === 'agent-setting'
    ? { ...record, sessionId: '22222222-2222-4222-8222-222222222222' } : record);
  assert.throws(() => observedSelection(foreign, ...args),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISSING');
  const contradictory = [...records, { type: 'agent-setting', sessionId: SESSION, agentSetting: 'gsd-planner' }];
  assert.throws(() => observedSelection(contradictory, ...args),
    (error) => error.code === 'RUNTIME_EVIDENCE_MISMATCH');
});

test('typed GSD launch refuses a symlinked agent definition before spawning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-gsd-symlink-'));
  const agents = path.join(root, 'claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const source = path.join(root, 'agent.md');
  fs.writeFileSync(source, '---\nname: gsd-plan-checker\ndescription: Check\ntools: Read, Bash, Glob, Grep\n---\nCheck.\n');
  fs.symlinkSync(source, path.join(agents, 'gsd-plan-checker.md'));
  let spawned = false;
  try {
    const launch = createClaudeCliLauncher({
      scope: { ...SCOPE, worktree: root },
      env: { CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
      spawn: () => { spawned = true; throw new Error('unexpected spawn'); },
    });
    await assert.rejects(() => launch('check', {
      model: 'claude-opus-5-5', effort: 'low', gsd_role: 'gsd-plan-checker',
    }), (error) => error.code === 'RUNTIME_CAPABILITY_MISSING');
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probe requires the scoped permission and sandbox CLI surface', () => {
  const calls = [];
  const result = probeClaudeRuntime({
    env: {
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'https://provider.invalid',
      OPENAI_API_KEY: 'test-openai-key',
      CODEX_API_KEY: 'test-codex-key',
    },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (args[0] === '--version') return { status: 0, stdout: '2.1.280\n', stderr: '' };
      if (args[0] === '--help') return {
        status: 0,
        stdout: '--model --effort --output-format stream-json --session-id --permission-mode --permission-prompts --allowedTools --tools --restricted --strict-mcp-config --settings --agent --agents',
        stderr: '',
      };
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.runtime_version, '2.1.280');
  assert.equal(result.auth_method, 'claude.ai');
  assert.equal(result.source, 'capability');
  assert.equal(result.live_execution, 'not_run');
  assert.equal(result.capabilities.assistantTranscriptEvidence, true);
  assert.equal(result.capabilities.sandboxedBash, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.env.ANTHROPIC_API_KEY === 'test-key'
    && call.env.ANTHROPIC_BASE_URL === 'https://provider.invalid'
    && call.env.OPENAI_API_KEY === undefined
    && call.env.CODEX_API_KEY === undefined));
});

test('probe reports unavailable without turning missing runtime into a receipt', () => {
  const result = probeClaudeRuntime({ spawnSync: () => ({ status: 1, stdout: '', stderr: 'not found' }) });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'runtime_missing');
});

test('controller-owned host binds the native assistant transcript evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-claude-host-'));
  const projects = path.join(root, 'projects');
  writeSession(projects, fixtureRecords());
  const ownerCalls = [];
  const controller = {
    assertOwner(runId) { ownerCalls.push(['assert', runId]); },
  };
  try {
    const host = createClaudeRuntimeHost({
      scope: { ...SCOPE, worktree: root },
      probe: probe(),
      controller,
      recorder: { record() {} },
      uuid: () => SESSION,
      spawn: (_executable, args) => {
        captureConfiguredSessionStart(args, path.join(projects, 'project-a', `${SESSION}.jsonl`));
        return childFor(stream());
      },
      transcriptDir: null,
      sessionTranscriptRoot: projects,
      transcriptPollMs: 5,
    });
    const result = await host.agent('scoped prompt', { model: 'claude-opus-5-5', effort: 'low' });
    const evidence = host.applicationEvidence({ result });
    assert.equal(host.scope.run_id, SCOPE.run_id);
    assert.equal(host.scope.ticket, SCOPE.ticket);
    assert.equal(evidence.session_id, SESSION);
    assert.equal(evidence.selection_evidence.transcript.path, `project-a/${SESSION}.jsonl`);
    assert.deepEqual(ownerCalls, [['assert', SCOPE.run_id], ['assert', SCOPE.run_id]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable probe is reported to the controller and refuses launch', () => {
  const unavailable = [];
  assert.throws(
    () => createClaudeRuntimeHost({
      scope: SCOPE,
      probe: { status: 'unavailable', reason: 'runtime_auth_unavailable' },
      controller: { markUnavailable(runId, input) { unavailable.push([runId, input.reason]); } },
      recorder: { record() {} },
    }),
    (error) => error.code === 'RUNTIME_UNAVAILABLE',
  );
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0][0], SCOPE.run_id);
});

done();
