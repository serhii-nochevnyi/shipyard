'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { runBounded } = require('../../plugins/delivery-pipeline/scripts/command-runner.cjs');
const {
  createCodexDeliveryHost,
  createFinalizationRecoveryHost,
  parseResumeArguments,
  readResumeScope,
  parseCliArguments,
  readRequestFile,
  requestValue,
  runCli,
} = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportedSelections: [
    { model: 'gpt-6-luna', effort: 'max' },
    { model: 'gpt-6-sol', effort: 'high' },
  ],
};
const finalizerFile = path.join(__dirname, '../../plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs');
const finalizeCommit = require(fs.existsSync(finalizerFile) ? finalizerFile : process.env.SHIPYARD_T38_FINALIZER_FILE).finalizeDeliveryCommit;
const temporary = (() => {
  try { return fs.mkdtempSync('/tmp/scds-'); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; return fs.mkdtempSync(path.join(os.tmpdir(), 'scds-')); }
})();
const previousEnv = {
  GNUPGHOME: process.env.GNUPGHOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
process.env.GNUPGHOME = path.join(temporary, 'gnupg');
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
process.on('exit', () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
  'Delivery Test <delivery@example.test>', 'ed25519', 'sign', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const signer = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-delivery-'));
  const agentDir = fs.mkdtempSync(path.join(temporary, 'agents-'));
  const project = fs.mkdtempSync(path.join(temporary, 'project-'));
  const graphDir = path.join(project, '.planning', 'graph');
  const plan = path.join(project, '.planning', 'PLAN.md');
  const storageRoot = path.join(temporary, 'storage');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'src', 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'base\n');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(plan, '# approved plan\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Delivery Test');
  git(root, 'config', 'user.email', 'delivery@example.test');
  git(root, 'config', 'user.signingkey', signer);
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'ticket/T-38-04');
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: {
    'T-38-04': { branch: 'ticket/T-38-04', pr_base: 'main', plan: '.planning/PLAN.md', files: ['src/owned.txt'] },
  } }));
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
    recorder: createDurableRecorder(fs.mkdtempSync(path.join(temporary, 'receipts-'))),
    launch(selection, context) {
      calls.push({ method: 'dynamic', selection, context });
      fs.writeFileSync(path.join(root, 'src', 'owned.txt'), 'changed\n');
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
  const verification = { commands: [{ id: 'unit', executable: process.execPath, argv: ['-e', 'process.exit(0)'],
    timeoutMs: 5000, maxOutputBytes: 4096 }] };
  return { root, agentDir, project, graphDir, plan, storageRoot, scope, host, calls, file, fileDigest, base, verification };
}

function hostRunner(spy = []) {
  return {
    run(spec) {
      spy.push(spec);
      const result = runBounded(spec.executable, spec.argv, { cwd: spec.cwd, timeoutMs: spec.timeoutMs, env: {} });
      const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
      return { id: spec.id, status: result.status, signal: result.signal, error_code: result.timedOut ? null : result.errorCode,
        timed_out: result.timedOut, stdout_sha256: digest(result.stdout), stderr_sha256: digest(result.stderr),
        backend: { kind: 'test-host', path: process.execPath, digest: digest('test') }, profile_sha256: digest('profile') };
    },
  };
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

function delivery(f, overrides = {}) {
  return createCodexDeliveryHost({
    scope: f.scope,
    host: f.host,
    capabilities,
    agentDir: f.agentDir,
    agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
    graphDir: f.graphDir,
    storageRoot: f.storageRoot,
    finalizeCommit,
    verification: f.verification,
    verificationRunner: hostRunner(),
    env: {},
    ...overrides,
  });
}

function clean(f) {
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(f.agentDir, { recursive: true, force: true });
  fs.rmSync(f.project, { recursive: true, force: true });
}

function runStatus(f) {
  const identity = crypto.createHash('sha256')
    .update(`${f.scope.run_id}\0${fs.realpathSync(f.root)}`).digest('hex');
  return createRunController({ storeDir: path.join(f.storageRoot, identity, 'runs') }).status(f.scope.run_id);
}

function cliOptions(f) {
  return {
    storageRoot: f.storageRoot,
    graphDir: f.graphDir,
    finalizeCommit,
    host: { ...f.host, scope: { ...f.host.scope, worktree: fs.realpathSync(f.root) } },
    capabilities,
    agentDir: f.agentDir,
    agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
    verification: f.verification,
    verificationRunner: hostRunner(),
    env: {},
  };
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
    assert.match(call.context.prompt, /^Implement the scoped ticket\.\n\nLeave changes uncommitted/);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6-luna');
    assert.equal(result.receipt.applied_effort, 'max');
    assert.equal(result.artifact.status, 'committed');
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(result.artifact.signer, signer);
    assert.deepEqual(result.artifact.changed, ['src/owned.txt']);
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(git(f.root, 'show', '-s', '--format=%G?%x00%GF', 'HEAD'), `G\0${signer}`);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
  } finally { clean(f); }
});

test('production runtime host receives the scoped prompt and records native model evidence', async () => {
  const f = fixture();
  const codeHome = path.join(temporary, 'codex-home-' + path.basename(f.root));
  const session = '44444444-4444-4444-8444-444444444444';
  const received = [];
  let capturedArgs;
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
      graphDir: f.graphDir,
      storageRoot: f.storageRoot,
      finalizeCommit,
      capabilities,
      probe: {
        status: 'available', executable: 'codex', runtime_version: '0.155.1',
        capabilities: { ...capabilities, cliVersion: '0.155.1' },
      },
      env: { CODEX_HOME: codeHome, GNUPGHOME: process.env.GNUPGHOME, SSH_AUTH_SOCK: '/tmp/ssh.sock' },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      verification: f.verification,
      verificationRunner: hostRunner(),
      spawn: (_executable, args, options) => {
        capturedArgs = args;
        assert.equal(options.env.GNUPGHOME, undefined);
        assert.equal(options.env.SSH_AUTH_SOCK, undefined);
        fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'changed\n');
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
    assert.equal(result.artifact.status, 'committed');
    assert.ok(result.receipt.runtime_evidence.transcript.path.startsWith(fs.realpathSync(f.storageRoot)));
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    const filesystemArg = capturedArgs.find((value) => value.startsWith('permissions.shipyard-runtime.filesystem='));
    assert.ok(filesystemArg.includes(JSON.stringify(stateRoot(f)) + '="deny"'));
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

test('executor without a worktree delta fails closed before calling the signer', async () => {
  const f = fixture();
  let signerCalls = 0;
  f.host.launch = (selection, context) => application(selection, context);
  try {
    await assert.rejects(() => createCodexDeliveryHost({
      ...cliOptions(f), scope: { ...f.scope, worktree: fs.realpathSync(f.root) },
      finalizeCommit() { signerCalls++; throw new Error('should not sign'); },
    }).run({ role: 'executor', context: { prompt: 'Inspect only.' } }),
    (error) => error.code === 'NO_PUBLISHABLE_DELTA');
    assert.equal(signerCalls, 0);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('host finalizer refuses an out-of-scope delta without moving HEAD', async () => {
  const f = fixture();
  f.host.launch = (selection, context) => {
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'out of scope\n');
    return application(selection, context);
  };
  try {
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Make the change.' },
    }), /out-of-scope paths/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('missing host signer refuses before launching the child', async () => {
  const f = fixture();
  try {
    git(f.root, 'config', '--unset', 'user.signingkey');
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Make the change.' },
    }), (error) => error.code === 'COMMIT_PREFLIGHT_FAILED' || error.code === 'SIGNER_UNAVAILABLE');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('CLI owns a durable run through signed artifact completion', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  const output = [];
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    const result = await runCli(['--args-file', file], { write: (chunk) => output.push(chunk) }, cliOptions(f));
    assert.equal(result.artifact.status, 'committed');
    assert.equal(JSON.parse(output.join('')).artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    const status = runStatus(f);
    assert.equal(status.state, 'completed');
    assert.equal(status.owner.status, 'completed');
    assert.equal(status.scope.repository.repository_id,
      'git-common:' + crypto.createHash('sha256').update(fs.realpathSync(path.join(f.root, '.git'))).digest('hex'));
    assert.ok(!status.scope.worktree.path.startsWith(f.storageRoot));
  } finally { clean(f); }
});

test('CLI heartbeats its out-of-worktree lease while a launch remains active', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  let during;
  f.host.launchStatic = async (selection, context) => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    during = runStatus(f);
    return application(selection, context);
  };
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'research', context: { prompt: 'Inspect.' },
    }));
    await runCli(['--args-file', file], { write() {} }, { ...cliOptions(f), heartbeatMs: 5 });
    assert.ok(during.owner.heartbeat_at > during.owner.acquired_at);
    assert.equal(runStatus(f).state, 'completed');
  } finally { clean(f); }
});

test('CLI records failed ownership when executor makes no publishable delta', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  f.host.launch = (selection, context) => application(selection, context);
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Inspect only.' },
    }));
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, cliOptions(f)),
      (error) => error.code === 'NO_PUBLISHABLE_DELTA');
    assert.equal(runStatus(f).state, 'failed');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('CLI rejects contradictory caller repository identity before starting a run', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: { ...f.scope, repository: 'caller-controlled-repository' },
      role: 'research', context: { prompt: 'Inspect.' },
    }));
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, cliOptions(f)),
      (error) => error.code === 'SCOPE_MISMATCH');
    assert.equal(f.calls.length, 0);
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
    assert.deepEqual(parsed.launch, { role: 'executor', signals: {}, context: { prompt: 'Run.' } });
    assert.throws(() => requestValue({ role: 'executor', model: 'gpt-6-luna' }),
      (error) => error.code === 'INVALID_INPUT');
  } finally { clean(f); }
});

test('spawning with bad argv exits 1, keeps the first stderr line, and appends a hint line', () => {
  const scriptPath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n');
  assert.equal(lines[0], 'codex-delivery-host: codex-delivery-host: usage: codex-delivery-host.cjs --args-file <json>');
  assert.match(lines[1], /^hint\[INVALID_INPUT\]: /);
});

suite('codex-delivery-host — REQ-158 trusted finalization recovery');

function stateRoot(f) {
  return path.join(fs.realpathSync(f.storageRoot), 'finalization',
    crypto.createHash('sha256').update(fs.realpathSync(f.root)).digest('hex'));
}

function candidatePath(f, id) {
  return path.join(stateRoot(f), 'candidates', id + '.json');
}

function recovery(f, overrides = {}) {
  return createFinalizationRecoveryHost({
    graphDir: f.graphDir, storageRoot: f.storageRoot, finalizeCommit, verification: f.verification,
    recorder: f.host.recorder, ...overrides,
  });
}

function liveScope(f) {
  return { run_id: 'recovery-' + crypto.randomBytes(4).toString('hex'), ticket: f.scope.ticket, phase: f.scope.phase,
    worktree: fs.realpathSync(f.root) };
}

async function failedFinalization(f) {
  let captured;
  await assert.rejects(() => delivery(f, {
    finalizeCommit() { throw Object.assign(new Error('gpg: signing failed: No pinentry'), { code: 'SIGNING_FAILED' }); },
  }).run({ role: 'executor', dispatch_id: 'req158-' + crypto.randomBytes(4).toString('hex'),
    context: { prompt: 'Implement the scoped ticket.' } }), (error) => { captured = error; return true; });
  return captured;
}

test('completed executor work persists a private authenticated candidate before signed finalization', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    assert.equal(error.code, 'SIGNING_FAILED');
    assert.match(error.candidate_id, /^[0-9a-f]{64}$/);
    assert.deepEqual(error.gates.downstream, { ci: 'pending', review: 'pending' });
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    const file = candidatePath(f, error.candidate_id);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    const candidate = JSON.parse(raw).payload;
    assert.equal(candidate.ticket, 'T-38-04');
    assert.equal(candidate.expected_head, f.base);
    assert.equal(candidate.signer, signer);
    assert.equal(candidate.plan_path, '.planning/PLAN.md');
    assert.match(candidate.receipt_sha256, /^[0-9a-f]{64}$/);
    assert.match(candidate.scoped_tree, /^[0-9a-f]{40}$/);
    assert.equal(candidate.gates.pre_commit, 'passed');
    assert.deepEqual(candidate.gates.downstream, { ci: 'pending', review: 'pending' });
    assert.equal(candidate.verification.records[0].outcome, 'passed');
    const key = fs.readFileSync(path.join(stateRoot(f), 'finalization-authority', 'hmac.key'));
    assert.ok(!raw.includes(key.toString('hex')));
    assert.ok(!fs.realpathSync(file).startsWith(fs.realpathSync(f.root)));
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('recovery resumes the unchanged candidate without an executor launch and repeats idempotently', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const scope = liveScope(f);
    const first = await recovery(f).resumeFinalization(error.candidate_id, scope);
    assert.equal(first.status, 'committed');
    assert.equal(first.idempotent, false);
    assert.equal(first.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(git(f.root, 'rev-parse', 'HEAD^{tree}'), first.artifact.tree);
    assert.deepEqual(first.artifact.gates.downstream, { ci: 'pending', review: 'pending' });
    const second = await recovery(f).resumeFinalization(error.candidate_id, scope);
    assert.equal(second.idempotent, true);
    assert.equal(second.artifact.commit, first.artifact.commit);
    assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('verification failures, missing specs and tree-changing checks refuse before any candidate', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f, { verification: undefined }).run({
      role: 'executor', context: { prompt: 'Implement.' } }), (error) => error.code === 'VERIFICATION_SPEC_MISSING');
    assert.equal(f.calls.length, 0);
    let signed = 0;
    const failing = { commands: [{ ...f.verification.commands[0], argv: ['-e', 'process.exit(4)'] }] };
    await assert.rejects(() => delivery(f, { verification: failing, finalizeCommit() { signed++; } }).run({
      role: 'executor', context: { prompt: 'Implement.' } }),
    (error) => error.code === 'VERIFICATION_FAILED' && /failed unit/.test(error.message)
      && error.gates.downstream.ci === 'pending');
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'base\n');
    const mutating = { commands: [{ ...f.verification.commands[0], argv: ['-e',
      "require('fs').writeFileSync('src/owned.txt', 'verification rewrote it\\n')"] }] };
    await assert.rejects(() => delivery(f, { verification: mutating, finalizeCommit() { signed++; } }).run({
      role: 'executor', context: { prompt: 'Implement.' } }),
    (error) => error.code === 'VERIFICATION_FAILED' && /changed scoped tree/.test(error.message));
    assert.equal(signed, 0);
    assert.equal(fs.existsSync(path.join(stateRoot(f), 'candidates'))
      ? fs.readdirSync(path.join(stateRoot(f), 'candidates')).length : 0, 0);
  } finally { clean(f); }
});

test('changed tree, graph, base, plan, verification or receipt refuses and keeps the candidate visible', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const id = error.candidate_id;
    const refused = async (expected, overrides = {}) => {
      await assert.rejects(() => recovery(f, overrides).resumeFinalization(id, liveScope(f)),
        (refusal) => refusal.code === expected.code && expected.names.every((name) => refusal.invalidated.includes(name))
          && refusal.gates.downstream.review === 'pending');
    };
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'edited after verification\n');
    await refused({ code: 'IDENTITY_CHANGED', names: ['tree'] });
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'changed\n');
    const graphFile = path.join(f.graphDir, 'tickets.json');
    const graph = fs.readFileSync(graphFile, 'utf8');
    fs.writeFileSync(graphFile, graph.replace('"pr_base"', '"note":"x","pr_base"'));
    await refused({ code: 'IDENTITY_CHANGED', names: ['graph'] });
    fs.writeFileSync(graphFile, graph);
    const plan = fs.readFileSync(f.plan);
    fs.appendFileSync(f.plan, 'amended\n');
    await refused({ code: 'IDENTITY_CHANGED', names: ['plan'] });
    fs.writeFileSync(f.plan, plan);
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification-spec'],
    }, { verification: { commands: [{ ...f.verification.commands[0], argv: ['-e', '1'] }] } });
    const records = path.join(stateRoot(f), 'verification');
    const recordFile = path.join(records, fs.readdirSync(records)[0]);
    const original = fs.readFileSync(recordFile, 'utf8');
    fs.writeFileSync(recordFile, original.replace('"outcome":"passed"', '"outcome":"failed"'));
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification:unit'] });
    fs.writeFileSync(recordFile, original);
    await refused({ code: 'MISSING_RECEIPT', names: ['receipt'] },
      { recorder: createDurableRecorder(fs.mkdtempSync(path.join(temporary, 'empty-receipts-'))) });
    git(f.root, 'stash', 'push', '-q', '-m', 'req158-base-move');
    git(f.root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'moved base\n');
    git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'move base');
    git(f.root, 'checkout', '-q', 'ticket/T-38-04');
    git(f.root, 'stash', 'pop', '-q');
    await refused({ code: 'IDENTITY_CHANGED', names: ['base'] });
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    assert.ok(fs.existsSync(candidatePath(f, id)));
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('tampered candidate and wrong scope refuse; commit without a finalization record needs reconciliation', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const id = error.candidate_id;
    await assert.rejects(() => recovery(f).resumeFinalization(id, { ...liveScope(f), ticket: 'T-38-05' }),
      (refusal) => refusal.code === 'IDENTITY_CHANGED' && refusal.invalidated.includes('ticket'));
    const file = candidatePath(f, id);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace(f.base, '0'.repeat(40)));
    await assert.rejects(() => recovery(f).resumeFinalization(id, liveScope(f)),
      (refusal) => refusal.code === 'STATE_RECORD_INVALID');
    fs.writeFileSync(file, original);
    await assert.rejects(() => recovery(f).resumeFinalization('f'.repeat(64), liveScope(f)),
      (refusal) => refusal.code === 'CANDIDATE_MISSING');
    const candidate = JSON.parse(original).payload;
    finalizeCommit({ ticket: candidate.ticket, worktree: candidate.worktree, expectedBranch: candidate.branch,
      expectedBase: candidate.expected_base, expectedHead: candidate.expected_head, expectedSigner: signer,
      files_modified: candidate.files_modified, expectedTree: candidate.scoped_tree });
    const head = git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(() => recovery(f).resumeFinalization(id, liveScope(f)),
      (refusal) => refusal.code === 'RECONCILIATION_REQUIRED');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  } finally { clean(f); }
});

test('recovery-only CLI returns the signed artifact with zero executor launches and a bounded scope file', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const launchesBefore = f.calls.length;
    const scopeFile = path.join(f.graphDir, 'recovery-scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify({ ...liveScope(f), role: 'executor' }));
    assert.throws(() => readResumeScope(scopeFile), (refusal) => refusal.code === 'INVALID_INPUT');
    for (const field of ['prompt', 'dispatch_id', 'verification', 'candidate_path', 'gates']) {
      fs.writeFileSync(scopeFile, JSON.stringify({ ...liveScope(f), [field]: 'x' }));
      assert.throws(() => readResumeScope(scopeFile), (refusal) => refusal.code === 'INVALID_INPUT');
    }
    assert.throws(() => parseResumeArguments(['--resume-finalization', error.candidate_id, '--scope-file', scopeFile, '--role', 'executor']),
      (refusal) => refusal.code === 'INVALID_INPUT');
    assert.throws(() => parseResumeArguments(['--resume-finalization', 'not-an-id', '--scope-file', scopeFile]),
      (refusal) => refusal.code === 'INVALID_INPUT');
    fs.writeFileSync(scopeFile, JSON.stringify(liveScope(f)));
    const output = [];
    const result = await runCli(['--resume-finalization', error.candidate_id, '--scope-file', scopeFile],
      { write: (chunk) => output.push(chunk) }, {
        storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, verification: f.verification,
        recorder: f.host.recorder,
      });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(output.join('')).artifact.candidate_id, error.candidate_id);
    assert.equal(f.calls.length, launchesBefore);
  } finally { clean(f); }
});

function approvedPlan(f, commands) {
  fs.writeFileSync(f.plan, '# approved plan\n\n## Verification commands\n\n'
    + commands.map((command) => '- `' + command + '`\n').join('') + '\n## Next\n\n- `node --bogus`\n');
}

test('CLI pins verification from the approved PLAN when no spec is injected', async () => {
  const f = fixture();
  const spy = [];
  const file = path.join(f.graphDir, 'request.json');
  try {
    approvedPlan(f, ['node --version']);
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    const { verification: _unused, ...options } = cliOptions(f);
    const result = await runCli(['--args-file', file], { write() {} }, { ...options, verificationRunner: hostRunner(spy) });
    assert.equal(result.artifact.status, 'committed');
    assert.deepEqual(spy.map((spec) => [spec.id, spec.executable, spec.argv]), [['plan-1', process.execPath, ['--version']]]);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, result.artifact.candidate_id), 'utf8')).payload;
    assert.deepEqual(candidate.verification.required, ['plan-1']);
  } finally { clean(f); }
});

test('recovery-only CLI reuses the PLAN-pinned verification spec without an injected spec', async () => {
  const f = fixture();
  try {
    approvedPlan(f, ['node --version']);
    let captured;
    await assert.rejects(() => delivery(f, { verification: undefined,
      finalizeCommit() { throw Object.assign(new Error('gpg: signing failed'), { code: 'SIGNING_FAILED' }); },
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => { captured = error; return error.code === 'SIGNING_FAILED'; });
    const scopeFile = path.join(f.graphDir, 'recovery-scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify(liveScope(f)));
    const result = await runCli(['--resume-finalization', captured.candidate_id, '--scope-file', scopeFile], { write() {} },
      { storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, recorder: f.host.recorder });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('PLAN verification with shell syntax or a bare program refuses before launch', async () => {
  for (const command of ['node a.cjs && rm -rf x', 'make test']) {
    const f = fixture();
    try {
      approvedPlan(f, [command]);
      await assert.rejects(() => delivery(f, { verification: undefined }).run({
        role: 'executor', context: { prompt: 'Implement.' } }), (error) => error.code === 'VERIFICATION_SPEC_UNSUPPORTED');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  }
});

test('recovery takes over a stale fence left by a dead holder and refuses a live one', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const lockPath = path.join(stateRoot(f), 'recovery', error.candidate_id + '.lock');
    const hold = (at) => {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, label: 'crashed', at, token: 'dead' }));
    };
    hold(new Date().toISOString());
    await assert.rejects(() => recovery(f).resumeFinalization(error.candidate_id, liveScope(f)),
      (refusal) => refusal.code === 'RECOVERY_IN_PROGRESS' && refusal.gates.downstream.ci === 'pending');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    hold(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const result = await recovery(f).resumeFinalization(error.candidate_id, liveScope(f));
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

done();
