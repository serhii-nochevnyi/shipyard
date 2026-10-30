'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { suite, test: runTest, done, assert } = require('./assert-harness.cjs');
let entrySelected = 0, entryVariants = 0;
function test(name, callback) {
  if (/^(?:code review |padded code review )/.test(name)) entrySelected++;
  if (name.startsWith('code review CLI seals one static phase verdict: ')) entryVariants++;
  return runTest(name, callback);
}
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createPlanningWriterLease } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');
const { runBounded } = require('../../plugins/delivery-pipeline/scripts/command-runner.cjs');
const {
  createCodexDeliveryHost,
  createFinalizationRecoveryHost,
  parseResumeArguments,
  parseRepairActionResumeArguments,
  readResumeScope,
  parseCliArguments,
  readRequestFile,
  requestValue,
  completeRepairFeedback,
  shareRepairTransitions,
  repairCoverageTransition,
  recheckHistoricalRepair,
  runCli,
  validateArgs,
  verificationFailureContext,
  verificationFailureReason,
} = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const { createRunScope } = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { SCRATCH_FILES } = require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');
const { codexCapabilities } = require('../smoke/installed-launch/lib.cjs');

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6.1-sol'],
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportedSelections: [
    { model: 'gpt-6.1-sol', effort: 'low' },
    { model: 'gpt-6.1-sol', effort: 'high' },
  ],
};
const finalizerFile = path.join(__dirname, '../../plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs');
const finalizeCommit = require(fs.existsSync(finalizerFile) ? finalizerFile : process.env.SHIPYARD_T38_FINALIZER_FILE).finalizeDeliveryCommit;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scds-'));
const previousEnv = {
  GNUPGHOME: process.env.GNUPGHOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
const disposableGpgHome = path.join(temporary, 'gnupg');
process.env.GNUPGHOME = disposableGpgHome;
process.env.GIT_CONFIG_GLOBAL = path.join(temporary, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
process.on('exit', () => {
  try {
    const stopped = spawnSync('gpgconf', ['--homedir', disposableGpgHome, '--kill', 'gpg-agent'], {
      env: { ...process.env, GNUPGHOME: disposableGpgHome }, stdio: 'ignore', timeout: 5000,
    });
    if (stopped.error || stopped.status !== 0) {
      process.stderr.write('codex-delivery-host tests: disposable GPG agent cleanup failed\n');
      process.exitCode = process.exitCode || 1;
    }
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
  'Delivery Test <delivery@example.test>', 'ed25519', 'sign', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const signer = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];

let graphEnvQueue = Promise.resolve();
function withGraphDirEnv(value, action) {
  const run = graphEnvQueue.then(async () => {
    const previous = process.env.SHIPYARD_GRAPH_DIR;
    if (value === undefined) delete process.env.SHIPYARD_GRAPH_DIR;
    else process.env.SHIPYARD_GRAPH_DIR = value;
    try {
      return await action();
    } finally {
      if (previous === undefined) delete process.env.SHIPYARD_GRAPH_DIR;
      else process.env.SHIPYARD_GRAPH_DIR = previous;
    }
  });
  graphEnvQueue = run.catch(() => {});
  return run;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeShipyardManifest(repo) {
  const dir = path.join(repo, 'plugins', 'delivery-pipeline', '.claude-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'shipyard' }));
}

function fixture(config = {}) {
  const fixtureBase = config.physicalPaths ? fs.realpathSync(temporary) : temporary;
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-delivery-'));
  const root = config.physicalPaths ? fs.realpathSync(createdRoot) : createdRoot;
  const agentDir = fs.mkdtempSync(path.join(fixtureBase, 'agents-'));
  const project = fs.mkdtempSync(path.join(fixtureBase, 'project-'));
  const graphDir = path.join(project, '.planning', 'graph');
  const plan = path.join(project, '.planning', 'PLAN.md');
  const storageRoot = path.join(fixtureBase, 'storage');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'src', 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'base\n');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(plan, '# approved plan\n');
  if (config.target !== true) writeShipyardManifest(root);
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
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({
    'T-38-04': { branch: 'ticket/T-38-04', base: 'main', status: 'pending' },
  }));
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
      context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
        last_agent_message: 'Typed GSD work completed.' });
      return application(selection, context);
    },
  };
  const verification = { commands: [{ id: 'unit', executable: process.execPath, argv: ['-e', 'process.exit(0)'],
    timeoutMs: 5000, maxOutputBytes: 4096 }] };
  return { root, agentDir, project, graphDir, plan, storageRoot, scope, host, calls, file, fileDigest, base, verification };
}

function configureMergedParentBase(f) {
  const parentBranch = 'ticket/T-38-03-merged-parent';
  const graphFile = path.join(f.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  Object.assign(graph.tickets['T-38-04'], {
    pr_base: parentBranch, primary_parent: 'T-38-03', epic: 'main',
  });
  graph.tickets['T-38-03'] = { branch: parentBranch, pr_base: 'main', epic: 'main', files: ['src/owned.txt'] };
  fs.writeFileSync(graphFile, JSON.stringify(graph));
  const boardFile = path.join(f.graphDir, 'delivery-state.json');
  const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  Object.assign(board['T-38-04'], { base: 'main', epic: 'main' });
  board['T-38-03'] = { branch: parentBranch, base: 'main', epic: 'main', status: 'merged', merged_into: 'main' };
  fs.writeFileSync(boardFile, JSON.stringify(board));
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
    ...(context.research_line ? {
      runtime_evidence: { session_id: 'research-fixture-session',
        native_session_evidence: { session_id: 'research-fixture-session' } },
    } : {}),
    ...(context.gsd_role ? { gsd_role: context.gsd_role, gsd_launch_mechanism: 'typed-gsd-callback',
      runtime_evidence: { native_session_evidence: { session_id: 'typed-fixture-session' } } } : {}),
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

test('executor leaves every shared scratch file outside the signed tree', async () => {
  const f = fixture();
  try {
    for (const name of SCRATCH_FILES) fs.writeFileSync(path.join(f.root, name), 'scratch\n');
    const result = await delivery(f).run({ role: 'executor', dispatch_id: 'all-scratch',
      context: { prompt: 'Implement the scoped ticket.' } });
    assert.equal(result.artifact.status, 'committed');
    assert.deepEqual(result.artifact.changed, ['src/owned.txt']);
    assert.equal(git(f.root, 'ls-tree', '--name-only', 'HEAD', ...SCRATCH_FILES), '');
  } finally { clean(f); }
});

test('executor refuses an untracked file outside the shared scratch set', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, '.shipyard-x.js'), 'agent content\n');
    await assert.rejects(delivery(f).run({ role: 'executor', dispatch_id: 'other-untracked',
      context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => error.code === 'WORKTREE_NOT_READY');
  } finally { clean(f); }
});

test('dynamic executor resolves Sol/low through the boundary with worktree write access', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({
      role: 'executor',
      dispatch_id: 'codex-delivery-executor',
      context: { prompt: 'Implement the scoped ticket.' },
    });
    const call = f.calls[0];
    assert.equal(call.method, 'dynamic');
    assert.equal(call.selection.model, 'gpt-6.1-sol');
    assert.equal(call.selection.reasoning_effort, 'low');
    assert.equal(call.context.sandbox_mode, 'workspace-write');
    assert.equal(call.context.run_id, f.scope.run_id);
    assert.equal(call.context.worktreePath, f.scope.worktree);
    assert.match(call.context.prompt, /active coordinator-owned Shipyard delivery loop/);
    assert.match(call.context.prompt, /Do not restart shipyard-route, bootstrap, marketplace installation/);
    assert.match(call.context.prompt, /^Implement the scoped ticket\.\n\nYou are an executor already dispatched/);
    assert.match(call.context.prompt,
      /Leave changes uncommitted\. The trusted host will stage, sign, and verify the commit\.\n\n<TICKET-CONTRACT path="\.planning\/PLAN\.md"/);
    assert.match(call.context.prompt, /# approved plan/);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6.1-sol');
    assert.equal(result.receipt.applied_effort, 'low');
    assert.equal(result.artifact.status, 'committed');
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(result.artifact.signer, signer);
    assert.deepEqual(result.artifact.changed, ['src/owned.txt']);
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(git(f.root, 'show', '-s', '--format=%G?%x00%GF', 'HEAD'), `G\0${signer}`);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
  } finally { clean(f); }
});

test('target-project executor finalizes a conventional, id-free subject from the canonical graph title', async () => {
  const f = fixture({ target: true });
  try {
    await withGraphDirEnv(f.graphDir, async () => {
      let refusal;
      await assert.rejects(() => delivery(f).run({ role: 'executor', dispatch_id: 'codex-target-untitled',
        context: { prompt: 'Implement the scoped ticket.' } }), (error) => { refusal = error; return true; });
      assert.match(refusal.message, /no canonical graph title/);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      const graphFile = path.join(f.graphDir, 'tickets.json');
      const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
      Object.assign(graph.tickets['T-38-04'], { title: 'Retry the flaky upload', type: 'bugfix' });
      fs.writeFileSync(graphFile, JSON.stringify(graph));
      git(f.root, 'checkout', '-q', '--', 'src/owned.txt');
      const result = await delivery(f).run({ role: 'executor', dispatch_id: 'codex-target-titled',
        context: { prompt: 'Implement the scoped ticket.' } });
      assert.equal(result.artifact.status, 'committed');
      assert.equal(git(f.root, 'log', '-1', '--format=%s', 'HEAD'), 'fix: retry the flaky upload');
      assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    });
  } finally { clean(f); }
});

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>/g, (token) => values[token] || token))
    .join('\n') + '\n';
}

test('production runtime host receives the scoped prompt and records native model evidence', async () => {
  const f = fixture();
  const codeHome = path.join(temporary, 'codex-home-' + path.basename(f.root));
  const session = '44444444-4444-4444-8444-444444444444';
  const received = [];
  let capturedArgs;
  const transcript = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
    .split('\n').filter(Boolean).map((line) => {
      const record = JSON.parse(line);
      if (record.type === 'turn_context') Object.assign(record.payload, { model: 'gpt-6.1-sol', effort: 'low' });
      if (record.payload?.type === 'task_complete') record.payload.last_agent_message = 'OK';
      if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
        record.payload.content.forEach(block => { block.text = 'OK'; });
      return JSON.stringify(record);
    }).join('\n') + '\n';
  const output = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session });
  try {
    const result = await createCodexDeliveryHost({
      scope: f.scope,
      graphDir: f.graphDir,
      storageRoot: f.storageRoot,
      finalizeCommit,
      capabilities,
      probe: {
        status: 'available', executable: 'codex', runtime_version: '0.157.1',
        capabilities: { ...capabilities, cliVersion: '0.157.1' },
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
    assert.equal(result.receipt.applied_model, 'gpt-6.1-sol');
    assert.equal(result.receipt.applied_effort, 'low');
    assert.equal(result.receipt.runtime_evidence.native_session_evidence.session_id, session);
    assert.equal(result.artifact.status, 'committed');
    assert.ok(result.receipt.runtime_evidence.transcript.path.startsWith(fs.realpathSync(f.storageRoot)));
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    const filesystemArg = capturedArgs.find((value) => value.startsWith('permissions.shipyard-runtime.filesystem='));
    assert.ok(filesystemArg.includes(JSON.stringify(stateRoot(f)) + '="deny"'));
    const archiveAuthority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
      .archiveAuthorityDirectory(f.root);
    assert.ok(filesystemArg.includes(JSON.stringify(archiveAuthority) + '="deny"'));
    assert(result.receipt.runtime_evidence.sandbox_evidence.protected_paths.includes(archiveAuthority));
  } finally { clean(f); }
});

test('generated static role uses its immutable file and declared read-only sandbox', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Inspect the scoped plan.' } });
    const call = f.calls[0];
    assert.equal(call.method, 'static');
    assert.equal(call.selection.agent_file, f.file);
    assert.equal(call.selection.model, 'gpt-6.1-sol');
    assert.equal(call.selection.reasoning_effort, 'high');
    assert.equal(call.selection.sandbox_mode, 'read-only');
    assert.equal(result.receipt.agent_file_digest, f.fileDigest);
    assert.equal(result.receipt.compliance, 'verified');
  } finally { clean(f); }
});

test('typed GSD delivery goes through the host-owned typed callback', async () => {
  const f = fixture();
  try {
    const actualPhaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    fs.mkdirSync(actualPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(actualPhaseDir, '38-01-PLAN.md'), '# baseline\n');
    fs.mkdirSync(f.storageRoot, { recursive: true });
    const phaseDir = path.join(f.storageRoot, 'phase-alias');
    fs.symlinkSync(actualPhaseDir, phaseDir, 'dir');
    assert.notEqual(path.resolve(phaseDir), fs.realpathSync(phaseDir));
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    const result = await delivery(f, { writerSession }).run({
      role: 'decomposition',
      gsd_role: 'gsd-planner',
      context: { prompt: 'Create the approved phase plan.' },
    });
    assert.equal(f.calls[0].method, 'typed');
    assert.equal(f.calls[0].selection.model, 'gpt-6.1-sol');
    assert.equal(f.calls[0].selection.reasoning_effort, 'high');
    assert.equal(result.receipt.gsd_launch_mechanism, 'typed-gsd-callback');
    assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
    lease.release(handle);
  } finally { clean(f); }
});

for (const [role, gsdRole] of [
  ['research', 'gsd-phase-researcher'],
  ['decomposition', 'gsd-planner'],
  ['decomposition', 'gsd-plan-checker'],
]) {
  test(`typed delivery CLI acquires and releases its own shared writer for ${gsdRole}`, async () => {
    const f = fixture();
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    const writerRoot = path.join(f.storageRoot, 'shared-writer');
    const requestFile = path.join(f.graphDir, `request-${gsdRole}.json`);
    try {
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing plan\n');
      fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Existing context\n');
      if (gsdRole === 'gsd-phase-researcher') {
        fs.writeFileSync(path.join(phaseDir, '38-RESEARCH.md'), '# Existing research\n');
      }
      fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role, gsd_role: gsdRole,
        context: { prompt: 'Complete the typed phase role.' } }));
      const result = await runCli(['--args-file', requestFile], { write() {} }, {
        ...cliOptions(f), testWriterStateRoot: writerRoot,
      });
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.gsd_role, gsdRole);
      assert.equal(f.calls.filter((call) => call.method === 'typed').length, 1);
      assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
      const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
      assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    } finally { clean(f); }
  });
}

for (const mode of ['valid-subset', 'omitted-old-plan', 'extra-edit', 'old-plan-tamper', 'missing-completion']) {
  test(`typed delivery CLI planner completion ${mode}`, async () => {
    const f = fixture();
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    const writerRoot = path.join(f.storageRoot, 'shared-writer');
    const requestFile = path.join(f.graphDir, `planner-${mode}.json`);
    try {
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing first plan\n');
      fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Existing second plan\n');
      fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Existing context\n');
      fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role: 'decomposition',
        gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }));
      f.host.launchTypedGsd = (selection, context) => {
        f.calls.push({ method: 'typed', selection, context });
        fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Edited first plan\n');
        if (mode === 'omitted-old-plan') fs.rmSync(path.join(phaseDir, '38-02-PLAN.md'));
        if (mode === 'extra-edit') fs.writeFileSync(path.join(phaseDir, 'stray.md'), '# Unreported\n');
        if (mode !== 'missing-completion') {
          context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
            last_agent_message: 'Edited the first plan.' });
        }
        if (mode === 'old-plan-tamper') fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Late edit\n');
        return application(selection, context);
      };
      const run = runCli(['--args-file', requestFile], { write() {} }, {
        ...cliOptions(f), testWriterStateRoot: writerRoot,
      });
      if (mode === 'valid-subset') {
        const result = await run;
        assert.equal(result.receipt.compliance, 'verified');
        assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
        assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 1);
      } else {
        const code = mode === 'old-plan-tamper' ? 'FOREIGN_EDIT'
          : mode === 'missing-completion' ? 'WRITER_FENCED' : 'FOREIGN_EDIT';
        await assert.rejects(run, { code });
        assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
      }
      assert.equal(f.calls.filter((call) => call.method === 'typed').length, 1);
      const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
      assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    } finally { clean(f); }
  });
}

for (const ownerName of ['claude-decompose', 'codex-decompose']) {
test(`typed delivery CLI refuses a ${ownerName} shared writer before launch and reacquires after release`, async () => {
  const f = fixture();
  const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
  const writerRoot = path.join(f.storageRoot, 'shared-writer');
  const requestFile = path.join(f.graphDir, 'typed-overlap.json');
  try {
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing plan\n');
    fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }));
    const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
    const first = lease.acquire({ owner: ownerName, base_revision: f.base });
    const original = fs.readFileSync(lease.file, 'utf8');
    await assert.rejects(runCli(['--args-file', requestFile], { write() {} }, {
      ...cliOptions(f), testWriterStateRoot: writerRoot,
    }), { code: 'WRITER_LEASED' });
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(lease.file, 'utf8'), original);
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(first);
    const result = await runCli(['--args-file', requestFile], { write() {} }, {
      ...cliOptions(f), testWriterStateRoot: writerRoot,
    });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
  } finally { clean(f); }
});
}

test('typed GSD delivery refuses a phase symlink escaping the scoped worktree', async () => {
  const f = fixture();
  try {
    const outsidePhaseDir = path.join(f.storageRoot, 'outside-phase');
    fs.mkdirSync(outsidePhaseDir, { recursive: true });
    const phaseDir = path.join(f.root, '.planning', 'phase-link');
    fs.symlinkSync(outsidePhaseDir, phaseDir, 'dir');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a different phase lease before recording', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '39-foreign');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-phase', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a lease keyed to a foreign directory', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-current');
    const foreignDir = path.join(f.root, '.planning', 'phases', '39-foreign');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    fs.mkdirSync(foreignDir, { recursive: true });
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir: foreignDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-lease', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a snapshot from another phase', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-current');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-snapshot', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: { ...lease.snapshotTree(), digests: { 'foreign.md': 'a'.repeat(64) } },
      declaredPaths: [] };
    await assert.rejects(Promise.resolve().then(() => delivery(f, { writerSession }).run({
      role: 'decomposition', gsd_role: 'gsd-planner', context: { prompt: 'Plan.' },
    })), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery rejects request writer authority and a missing host lease', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'decomposition', gsd_role: 'gsd-planner',
      context: { prompt: 'Plan.', preRecordValidation: () => true } }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, 0);
    await assert.rejects(delivery(f).run({ role: 'decomposition', gsd_role: 'gsd-planner',
      context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
  } finally { clean(f); }
});

test('typed GSD delivery checks host lease takeover and foreign edits before recording', async () => {
  for (const mode of ['takeover', 'foreign']) {
    const f = fixture();
    try {
      const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
      fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
      const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
        stateRoot: path.join(f.storageRoot, 'writer') });
      const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
      const writerSession = { lease, handle, base_revision: f.base, phaseDir,
        snapshot: lease.snapshotTree(), declaredPaths: [] };
      f.host.launchTypedGsd = (selection, context) => {
        f.calls.push({ method: 'typed', selection, context });
        context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
          last_agent_message: 'Typed GSD work completed.' });
        if (mode === 'takeover') { lease.release(handle); lease.acquire({ owner: 'new-owner', base_revision: f.base }); }
        else fs.writeFileSync(path.join(phaseDir, 'stray.md'), 'foreign');
        return application(selection, context);
      };
      await assert.rejects(delivery(f, { writerSession }).run({ role: 'decomposition',
        gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }),
      { code: mode === 'takeover' ? 'WRITER_FENCED' : 'FOREIGN_EDIT' });
      assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    } finally { clean(f); }
  }
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

test('typed CLI renews its planning writer lease without changing ownership', async () => {
  const f = fixture();
  const phaseDir = path.join(f.root, '.planning', 'phases', '38-heartbeat');
  const writerRoot = path.join(f.storageRoot, 'heartbeat-' + crypto.randomUUID());
  const file = path.join(f.graphDir, 'request.json');
  let before;
  let after;
  try {
    fs.mkdirSync(phaseDir, { recursive: true });
    const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
    const launch = f.host.launchTypedGsd;
    f.host.launchTypedGsd = async function (selection, context) {
      before = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
      return launch.call(this, selection, context);
    };
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'decomposition', gsd_role: 'gsd-plan-checker',
      context: { prompt: 'Check the fixture plan.' },
    }));
    const result = await runCli(['--args-file', file], { write() {} }, {
      ...cliOptions(f), heartbeatMs: 5, testWriterStateRoot: writerRoot,
    });
    assert.ok(after.heartbeat_at > before.heartbeat_at);
    assert.ok(after.expires_at > before.expires_at);
    assert.equal(after.token, before.token);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.pid, before.pid);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    assert.equal(runStatus(f).state, 'completed');
  } finally { clean(f); }
});

function inflightRows(graphDir) {
  try { return JSON.parse(fs.readFileSync(path.join(graphDir, 'dispatches.json'), 'utf8')).inflight || {}; }
  catch { return {}; }
}

for (const outcome of ['success', 'failure']) {
  test(`CLI holds a pid in-flight record during the run and clears it after ${outcome}`, async () => {
    const f = fixture();
    const file = path.join(f.graphDir, 'request.json');
    let during;
    f.host.launchStatic = async (selection, context) => {
      during = Object.values(inflightRows(f.graphDir));
      if (outcome === 'failure') throw new Error('stubbed runtime launch failed');
      return application(selection, context);
    };
    try {
      fs.writeFileSync(file, JSON.stringify({
        scope: f.scope, role: 'research', context: { prompt: 'Inspect.' },
      }));
      const running = runCli(['--args-file', file], { write() {} }, cliOptions(f));
      if (outcome === 'failure') await assert.rejects(() => running, /stubbed runtime launch failed/);
      else await running;
      assert.equal(during.length, 1);
      assert.equal(during[0].ticket, f.scope.ticket);
      assert.equal(during[0].pid, process.pid);
      assert.equal(during[0].host, 'codex');
      assert.deepEqual(inflightRows(f.graphDir), {});
    } finally { clean(f); }
  });
}

test('validateArgs accepts the canonical request and surfaces unknown keys and UNSUPPORTED_SIGNAL unchanged', () => {
  const valid = validateArgs({ role: 'executor', context: { prompt: 'Run.' } });
  assert.equal(valid.request.role, 'executor');
  assert.ok(valid.resolution.model);
  assert.throws(() => validateArgs({ role: 'executor', model: 'gpt-6-luna' }),
    (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateArgs({ role: 'research', signals: { type: 'implementation' } }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL');
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

test('executor and recovery use the live board base after the recorded primary parent is merged', async () => {
  const f = fixture();
  try {
    configureMergedParentBase(f);
    assert.equal(spawnSync('git', ['-C', f.root, 'show-ref', '--verify', '--hash',
      'refs/heads/ticket/T-38-03-merged-parent'], { encoding: 'utf8' }).status !== 0, true);
    const error = await failedFinalization(f);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8')).payload;
    assert.equal(candidate.base_ref, 'main');
    assert.equal(candidate.expected_base, f.base);
    const result = await recovery(f).resumeFinalization(error.candidate_id, liveScope(f));
    assert.equal(result.status, 'committed');
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
  } finally { clean(f); }
});

test('executor refuses a changed live base that is not justified by a merged parent', async () => {
  const f = fixture();
  try {
    configureMergedParentBase(f);
    const boardFile = path.join(f.graphDir, 'delivery-state.json');
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    board['T-38-03'].status = 'pr-open';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    await assert.rejects(() => delivery(f).run({ role: 'executor', dispatch_id: 'unproved-live-base',
      context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => error.code === 'BASE_MISMATCH' && /neither its open primary parent nor its merged destination/.test(error.message));
    assert.equal(f.calls.length, 0, 'the executor must not launch on an unproved base');
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

test('Codex host verification refuses an admitted failure without finalizing', async () => {
  const f = fixture();
  let finalized = 0;
  try {
    approvedPlan(f, ['node check.cjs']);
    const result = await delivery(f, { verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() { return { status: 3, stdout: '', stderr: 'failed', backend: { kind: 'host' } }; } },
      finalizeCommit() { finalized++; },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } });
    assert.equal(result.status, 'verification_failed');
    assert.deepEqual(result.command, ['node', 'check.cjs']);
    assert.match(result.evidence_digest, /^[0-9a-f]{64}$/);
    assert.equal(result.retryable, true);
    assert.deepEqual(result.receipt, f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id).receipt);
    assert.equal(finalized, 0);
  } finally { clean(f); }
});

test('Codex host verification passes sealed evidence digest to trusted finalizer', async () => {
  const f = fixture();
  let digest;
  try {
    approvedPlan(f, ['node check.cjs']);
    await assert.rejects(() => delivery(f, { verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() { return { status: 0, stdout: '', stderr: '', backend: { kind: 'host' } }; } },
      finalizeCommit(input) { digest = input.verificationEvidenceDigest;
        throw new Error('stop after evidence'); },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } }), /stop after evidence/);
    assert.match(digest, /^[0-9a-f]{64}$/);
  } finally { clean(f); }
});

test('Codex retries one failed plan command with sealed diagnostics and binds the passing digest', async () => {
  const f = fixture();
  const controllerOwner = 'verification-retry-owner';
  const controller = createRunController({ storeDir: path.join(f.storageRoot, 'retry-controller'), ownerId: controllerOwner });
  controller.begin(createRunScope({
    run_id: f.scope.run_id, repository_id: 'shipyard/test', phase: f.scope.phase,
    ticket: f.scope.ticket, worktree: f.root, runtime: 'codex', provider: 'openai',
    owner_id: controllerOwner,
    dispatch: { dispatch_id: 'verification-retry-initial', role: 'executor', model: 'gpt-6.1-sol', effort: 'low' },
  }));
  let checks = 0;
  try {
    approvedPlan(f, ['node check.cjs']);
    const launch = f.host.launch.bind(f.host);
    f.host.launch = (selection, context) => ({ ...launch(selection, context), launch_id: `codex-delivery-${f.calls.length}` });
    const result = await delivery(f, {
      controller,
      verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() {
        checks++;
        return { status: checks === 1 ? 7 : 0, stdout: '', stderr: checks === 1 ? 'failed' : '', backend: { kind: 'host' } };
      } },
    }).run({ role: 'executor', dispatch_id: 'verification-retry-initial', context: { prompt: 'Implement.' } });
    assert.equal(result.artifact.status, 'committed');
    assert.equal(checks, 2);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.match(call.context.prompt, /Do not run or retry the host-assigned commands in the sandbox/);
      assert.deepEqual(call.context.verification_assignment.commands[0].argv, ['node', 'check.cjs']);
      assert.equal(call.context.verification_assignment.commands[0].profile, 'host');
      assert.equal(call.context.verification_assignment.expected_head, f.base);
    }
    assert.deepEqual(f.calls[1].context.verification_assignment, f.calls[0].context.verification_assignment);
    assert.match(f.calls[1].context.prompt, /<HOST-VERIFICATION-FAILURE>/);
    assert.match(f.calls[1].context.prompt, /"attempt":1/);
    assert.equal(controller.status(f.scope.run_id).retry.attempts, 1);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, result.artifact.candidate_id), 'utf8')).payload;
    assert.match(candidate.verification.allow_list_sha256, /^[0-9a-f]{64}$/);
    assert.match(git(f.root, 'show', '-s', '--format=%B', 'HEAD'),
      new RegExp(`Shipyard-Verification-Evidence: ${candidate.verification.evidence_digest}`));
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
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification-allow-list'] },
      { verificationAllowList: [] });
    const records = path.join(stateRoot(f), 'verification');
    const pinned = JSON.parse(fs.readFileSync(candidatePath(f, id), 'utf8')).payload.verification.records[0];
    const recordFile = path.join(records, pinned.record_sha256 + '.json');
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
      files_modified: candidate.files_modified, expectedTree: candidate.scoped_tree,
      verificationEvidenceDigest: candidate.verification.evidence_digest });
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
    const recoveryScope = liveScope(f);
    fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
    const candidateBytes = fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8');
    const output = [];
    const result = await runCli(['--resume-finalization', error.candidate_id, '--scope-file', scopeFile],
      { write: (chunk) => output.push(chunk) }, {
        storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, verification: f.verification,
        recorder: f.host.recorder,
      });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(output.join('')).artifact.candidate_id, error.candidate_id);
    assertRecoveryPolicy(f, error.candidate_id, recoveryScope);
    assert.equal(fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8'), candidateBytes);
    assert.equal(f.calls.length, launchesBefore);
  } finally { clean(f); }
});

function assertRecoveryPolicy(f, id, scope) {
  const file = candidatePath(f, id);
  const candidate = JSON.parse(fs.readFileSync(file, 'utf8')).payload;
  const original = f.host.recorder.getVerifiedRecord(candidate.dispatch_id);
  assert.equal(candidate.policy_version, original.policy_version);
  assert.equal(candidate.policy_hash, original.receipt.policy_hash);
  const identity = crypto.createHash('sha256').update(`${scope.run_id}\0${fs.realpathSync(f.root)}`).digest('hex');
  const stored = createRunController({ storeDir: path.join(f.storageRoot, identity, 'runs') }).status(scope.run_id);
  assert.equal(stored.scope.dispatch.policy_version, original.policy_version);
  assert.equal(stored.scope.dispatch.policy_hash, original.receipt.policy_hash);
}

function resealCandidate(f, id, mutate) {
  const payload = JSON.parse(fs.readFileSync(candidatePath(f, id), 'utf8')).payload;
  delete payload.candidate_id;
  mutate(payload);
  const sorted = (value) => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const canonical = (value) => JSON.stringify(sorted(value));
  const nextId = crypto.createHash('sha256').update(canonical(payload)).digest('hex');
  payload.candidate_id = nextId;
  const key = fs.readFileSync(path.join(stateRoot(f), 'finalization-authority', 'hmac.key'));
  const envelope = { format: 'shipyard.host-authenticated.v1', payload,
    integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', key).update(canonical(payload)).digest('hex') } };
  fs.writeFileSync(candidatePath(f, nextId), JSON.stringify(envelope) + '\n', { mode: 0o600 });
  return nextId;
}

test('recovery CLI derives a legacy candidate version only from bound authenticated authority and refuses conflicts', async () => {
  for (const variant of ['legacy', 'conflict', 'null', 'missing-authority', 'historical']) {
    const f = fixture();
    try {
      const error = await failedFinalization(f);
      const id = resealCandidate(f, error.candidate_id, (candidate) => {
        if (variant === 'legacy') delete candidate.policy_version;
        if (variant === 'conflict') candidate.policy_version = 'adr-014.v6';
        if (variant === 'null') candidate.policy_version = null;
      });
      const scope = liveScope(f);
      const file = path.join(f.graphDir, 'recovery-scope.json');
      fs.writeFileSync(file, JSON.stringify(scope));
      const before = fs.readFileSync(candidatePath(f, id), 'utf8');
      let recorder = f.host.recorder;
      if (variant === 'missing-authority') recorder = { getVerifiedRecord(dispatchId) {
        const record = structuredClone(f.host.recorder.getVerifiedRecord(dispatchId));
        delete record.policy_version;
        delete record.resolution.policy_version;
        delete record.receipt.policy_version;
        return record;
      } };
      const action = () => runCli(['--resume-finalization', id, '--scope-file', file], { write() {} },
        { storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, verification: f.verification, recorder });
      if (variant === 'historical') {
        const candidate = JSON.parse(before).payload;
        const record = structuredClone(f.host.recorder.getVerifiedRecord(candidate.dispatch_id));
        const hash = '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968';
        record.policy_version = record.resolution.policy_version = 'adr-014.v6';
        record.policy_hash = record.resolution.policy_hash = record.receipt.policy_hash = hash;
        record.receipt.compliance_proof.policy_hash = hash;
        if (Object.hasOwn(record.receipt, 'policy_version')) record.receipt.policy_version = 'adr-014.v6';
        const sorted = (value) => Array.isArray(value) ? value.map(sorted)
          : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
        const historicalId = resealCandidate(f, id, (value) => {
          value.policy_version = 'adr-014.v6';
          value.policy_hash = hash;
          value.receipt_sha256 = crypto.createHash('sha256').update(JSON.stringify(sorted(record.receipt))).digest('hex');
        });
        await assert.rejects(() => recovery(f, { recorder: { getVerifiedRecord() { return record; } } })
          .resumeFinalization(historicalId, scope), (error) => error.code === 'MISSING_RECEIPT');
      } else if (variant === 'legacy') {
        await action();
        assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
      } else {
        await assert.rejects(action, (error) => error.code === (variant === 'missing-authority' ? 'MISSING_RECEIPT' : 'IDENTITY_CHANGED'));
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      }
      assert.equal(fs.readFileSync(candidatePath(f, id), 'utf8'), before);
      assert.equal(f.calls.length, 1);
    } finally { clean(f); }
  }
});

function approvedPlan(f, commands) {
  fs.writeFileSync(f.plan, '# approved plan\n\n## Verification commands\n\n'
    + commands.map((command) => '- `' + command + '`\n').join('') + '\n## Next\n\n- `node --bogus`\n');
  fs.writeFileSync(path.join(f.project, '.planning', 'config.json'), JSON.stringify({
    delivery_pipeline: { verification_commands: { default: commands
      .filter((command) => /^(node|bash|make)\s/.test(command))
      .map((command) => ({ argv: command.split(' '), profile: 'sandbox' })) } },
  }));
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

test('CLI holds an unmatched PLAN command before executor launch and does not retry it', async () => {
  const f = fixture();
  const requestFile = path.join(f.graphDir, 'request-empty-allow-list.json');
  const output = [];
  try {
    approvedPlan(f, ['node check.cjs']);
    fs.writeFileSync(requestFile, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    await assert.rejects(() => runCli(['--args-file', requestFile], { write(chunk) { output.push(chunk); } }, {
      ...cliOptions(f), verification: undefined, verificationAllowList: [],
      hostVerificationRunner: { run() { assert.fail('an empty allow-list must not launch a command'); } },
    }), (error) => error.code === 'VERIFICATION_FAILED' && error.status === 'hold'
      && error.command.join(' ') === 'node check.cjs' && error.retryable === false);
    assert.equal(runStatus(f).state, 'failed');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(output, [], 'a pre-dispatch HOLD must not fabricate executor or assertion evidence');
  } finally { clean(f); }
});

test('verification failure reason safely handles an absent command', () => {
  assert.match(verificationFailureReason({ command: null, summary: 'no command matched' }),
    /no allow-listed verification command matched/);
});

test('Codex retry diagnostic remains within its byte limit for oversized Unicode evidence', () => {
  const diagnostic = verificationFailureContext({
    command: Array(64).fill('💥'.repeat(256)), evidence_digest: 'a'.repeat(64), summary: '⚠'.repeat(500),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') <= 2048);
  assert.equal(diagnostic.attempt, 1);
  assert.equal(Object.isFrozen(diagnostic.command), true);
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
    const recoveryScope = liveScope(f);
    fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
    const result = await runCli(['--resume-finalization', captured.candidate_id, '--scope-file', scopeFile], { write() {} },
      { storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, recorder: f.host.recorder });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assertRecoveryPolicy(f, captured.candidate_id, recoveryScope);
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('PLAN verification with shell syntax or a non-allowlisted bare program refuses before launch', async () => {
  for (const command of ['node a.cjs && rm -rf x', 'sh test.sh', 'npm test', 'bash -c "true"']) {
    const f = fixture();
    try {
      approvedPlan(f, [command]);
      await assert.rejects(() => delivery(f, { verification: undefined }).run({
        role: 'executor', context: { prompt: 'Implement.' } }),
      (error) => /^(sh|npm)\s/.test(command)
        ? error.code === 'VERIFICATION_FAILED' && error.status === 'hold'
        : error.code === 'VERIFICATION_SPEC_UNSUPPORTED');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  }
});

test('PLAN verification resolves bash and make bullets to fixed absolute executables with unchanged argv', async () => {
  const f = fixture();
  const spy = [];
  try {
    approvedPlan(f, ['bash tests/smoke/x.sh', 'bash -n x.sh', 'make test-docs']);
    await assert.rejects(() => delivery(f, { verification: undefined,
      verificationRunner: { run(spec) { spy.push(spec); return { status: 0 }; } },
      finalizeCommit() { throw new Error('stop after pinned executable verification'); },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } }), /stop after pinned executable verification/);
    const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) => fs.existsSync(candidate));
    const make = ['/usr/bin/make', '/bin/make'].find((candidate) => fs.existsSync(candidate));
    assert.deepEqual(spy.map((spec) => [spec.executable, spec.argv]), [
      [bash, ['tests/smoke/x.sh']],
      [bash, ['-n', 'x.sh']],
      [make, ['test-docs']],
    ]);
  } finally { clean(f); }
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

suite('codex-delivery-host — T-40-12 investigation research consumer');

function baseInvestigation(f, overrides = {}) {
  return {
    invId: 'INV-100',
    sourceRevision: f.base,
    repository: 'acme/shipyard',
    policyHash: policy.resolveDispatch({ runtime: 'codex', role: 'research' }).policy_hash,
    lines: ['system-state', 'alternatives', 'constraints', 'risks'].map((id) => ({ id, signals: {} })),
    ...overrides,
  };
}

function researchLaunchStub(f, { skip = new Set(), rogueWrite } = {}) {
  return (selection, context) => {
    f.calls.push({ method: 'static', selection, context });
    if (rogueWrite && context.research_line === rogueWrite.line) {
      fs.writeFileSync(rogueWrite.path, rogueWrite.content || 'rogue write\n');
    } else if (!skip.has(context.research_line)) {
      fs.writeFileSync(context.artifactPath, `# ${context.research_line}\n\nfinding for ${context.research_line}\n`);
    }
    const bytes = Buffer.from(`# ${context.research_line}\n\nfinding for ${context.research_line}\n`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'research-fixture-session',
      last_agent_message: JSON.stringify({ id: context.research_line, status: 'completed',
        summary: 'Research line completed.', artifact: { path: context.artifactPath,
          bytes: bytes.length, content_bytes: bytes.length, sha256: digest, digest } }) });
    return application(selection, context);
  };
}

test('a clean four-line investigation run seals every line through the shared sealer', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({
      role: 'research', context: { prompt: 'Investigate the scoped topic.', investigation },
    });
    assert.deepEqual(result.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
    for (const entry of result) {
      assert.equal(entry.schema, 'shipyard.role-artifact.v1');
      assert.equal(entry.envelope.schema, 'shipyard.research-result.v1');
      assert.equal(entry.envelope.subject, `INV-100:${entry.id}`);
      assert.equal(entry.envelope.status, 'completed');
      assert.equal(entry.envelope.source_revision, f.base);
      assert.equal(entry.envelope.repository, 'acme/shipyard');
      assert.equal(entry.envelope.policy_hash, investigation.policyHash);
      assert.match(entry.artifact_digest, /^[a-f0-9]{64}$/);
      assert.ok(fs.existsSync(entry.artifact_index.path));
    }
    assert.equal(f.calls.length, 4);
  } finally { clean(f); }
});

test('a line writing outside its artifact refuses CONTAINMENT_VIOLATION naming the line', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f, {
      rogueWrite: { line: 'alternatives', path: path.join(f.root, 'outside.txt') },
    });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'alternatives');
    assert.equal(result.code, 'CONTAINMENT_VIOLATION');
    assert.deepEqual(result.sealed_lines.map((entry) => entry.id).sort(), ['constraints', 'risks', 'system-state']);
  } finally { clean(f); }
});

test('a missing artifact names the line and RESEARCH_LINE_MISSING', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f, { skip: new Set(['risks']) });
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'risks');
    assert.equal(result.code, 'RESEARCH_LINE_MISSING');
    assert.equal(result.sealed_lines.length, 3);
  } finally { clean(f); }
});

test('a request with a ticket type value in signals is still refused by the boundary (Pitfall 1 guard)', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f, {
      lines: [
        { id: 'system-state', signals: { type: 'implementation' } },
        { id: 'alternatives', signals: {} },
        { id: 'constraints', signals: {} },
        { id: 'risks', signals: {} },
      ],
    });
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'system-state');
    assert.equal(result.code, 'UNSUPPORTED_SIGNAL');
    assert.equal(result.sealed_lines.length, 0);
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a single-line re-dispatch launches only the failed line and leaves its sealed siblings unchanged', async () => {
  const f = fixture();
  try {
    const skip = new Set(['alternatives']);
    f.host.launchStatic = researchLaunchStub(f, { skip });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const failure = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(failure.status, 'blocked');
    assert.equal(failure.failed_line, 'alternatives');
    assert.equal(failure.code, 'RESEARCH_LINE_MISSING');
    assert.equal(failure.sealed_lines.length, 3);
    const digestsBefore = Object.fromEntries(failure.sealed_lines.map((entry) => [entry.id, entry.artifact_digest]));

    skip.delete('alternatives');
    const callsBefore = f.calls.length;
    const redispatch = await delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: investigation.repository, policyHash: investigation.policyHash,
          lines: [{ id: 'alternatives', signals: {} }],
          sealedLines: failure.sealed_lines,
        },
      },
    });
    assert.equal(f.calls.length, callsBefore + 1);
    assert.deepEqual(redispatch.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
    for (const id of ['system-state', 'constraints', 'risks']) {
      assert.equal(redispatch.find((entry) => entry.id === id).artifact_digest, digestsBefore[id]);
    }
    assert.equal(redispatch.find((entry) => entry.id === 'alternatives').envelope.status, 'completed');
  } finally { clean(f); }
});

test('a re-dispatch verifies siblings sealed under the older owner/repo form with the physical repository identity', async () => {
  const f = fixture();
  try {
    git(f.root, 'remote', 'add', 'origin', 'https://github.com/Acme/Shipyard.git');
    f.host.launchStatic = researchLaunchStub(f, { skip: new Set(['alternatives']) });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const failure = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(failure.sealed_lines.length, 3);
    f.host.launchStatic = researchLaunchStub(f);
    const redispatch = await delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: fs.realpathSync(path.join(f.root, '.git')), policyHash: investigation.policyHash,
          lines: [{ id: 'alternatives', signals: {} }],
          sealedLines: failure.sealed_lines,
        },
      },
    });
    assert.deepEqual(redispatch.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
  } finally { clean(f); }
});

test('a single-line request whose sibling artifact is missing refuses naming the sibling', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    const broken = result.find((entry) => entry.id === 'alternatives');
    fs.rmSync(broken.artifact_ref);
    const siblings = result.filter((entry) => entry.id !== 'system-state');

    await assert.rejects(() => delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: investigation.repository, policyHash: investigation.policyHash,
          lines: [{ id: 'system-state', signals: {} }],
          sealedLines: siblings,
        },
      },
    }), (error) => error.code === 'RESEARCH_VERIFY_MANIFEST_MISSING' && error.message.includes('alternatives'));
  } finally { clean(f); }
});

suite('codex-delivery-host — T-40-28 plan delivery (D-43)');

function agentManifestFor(agentDir, role) {
  const resolution = policy.resolveDispatch({ runtime: 'codex', role });
  const file = resolution.agent_file;
  const content = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + resolution.policy_version + '"',
    '# shipyard-policy-hash = "' + resolution.policy_hash + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "' + role + '"',
    '# shipyard-policy-rung = "' + resolution.rung + '"',
    'name = "' + file.replace(/\.toml$/, '') + '"',
    'model = "' + resolution.model + '"',
    'model_reasoning_effort = "' + resolution.effort + '"',
    'sandbox_mode = "' + (role === 'review-fix' ? 'workspace-write' : 'read-only') + '"',
    "developer_instructions = '''",
    'Follow the scoped role.',
    "'''",
    '',
  ].join('\n');
  const fileDigest = crypto.createHash('sha256').update(content).digest('hex');
  fs.writeFileSync(path.join(agentDir, file), content);
  fs.writeFileSync(path.join(agentDir, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id, policy_version: resolution.policy_version, policy_hash: resolution.policy_hash,
    agent_files: [file], agent_digests: { [file]: fileDigest },
  }));
  return path.join(agentDir, '.shipyard-manifest.json');
}

function ticketWorktreeFixture(role) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-inworktree-'));
  const agentDir = fs.mkdtempSync(path.join(temporary, 'agents-'));
  const planRel = '.planning/phases/x/X-PLAN.md';
  fs.mkdirSync(path.join(root, '.planning', 'phases', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, planRel), '# plan\n\n## Context (Reads)\n\n- nothing planning-shaped here.\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'owned.txt'), 'base\n');
  fs.mkdirSync(path.join(root, '.planning', 'graph'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Delivery Test');
  git(root, 'config', 'user.email', 'delivery@example.test');
  fs.writeFileSync(path.join(root, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {
    'T-38-04': { branch: 'main', pr_base: 'main', plan: planRel, files: ['src/owned.txt'] },
  } }));
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const agentManifest = agentManifestFor(agentDir, role);
  const scope = {
    run_id: 'run-codex-inworktree', ticket: 'T-38-04', phase: 38,
    worktree: root, runtime: 'codex', provider: 'openai',
  };
  const calls = [];
  const host = {
    scope,
    capabilities,
    recorder: createDurableRecorder(fs.mkdtempSync(path.join(temporary, 'receipts-'))),
    launchStatic(selection, context) { calls.push({ method: 'static', selection, context }); return application(selection, context); },
  };
  return { root, agentDir, agentManifest, scope, host, calls, planRel };
}

function withoutShipyardGraphDirEnv(action) {
  return withGraphDirEnv(undefined, action);
}

test('requestValue accepts context.plan_sha256 and rejects every other plan* context field', () => {
  requestValue({ role: 'drift-check', context: { prompt: 'hi', plan_sha256: '0'.repeat(64) } });
  for (const bad of [{ plan_path: '/x' }, { plan: 'x' }, { plan_content: 'x' }]) {
    assert.throws(() => requestValue({ role: 'drift-check', context: { prompt: 'hi', ...bad } }),
      (error) => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => requestValue({ role: 'drift-check', context: { prompt: 'hi', plan_sha256: 'not-hex' } }),
    (error) => error.code === 'INVALID_INPUT');
});

test('a Shipyard-shaped worktree (graph tracked at HEAD, no flag or env) leaves the drift-check prompt unchanged', () =>
  withoutShipyardGraphDirEnv(async () => {
    const f = ticketWorktreeFixture('drift-check');
    try {
      await createCodexDeliveryHost({
        scope: f.scope, host: f.host, capabilities, agentDir: f.agentDir, agentManifest: f.agentManifest,
        storageRoot: fs.mkdtempSync(path.join(temporary, 'storage-')), env: {},
      }).run({ role: 'drift-check', context: { prompt: 'Judge this ticket.' } });
      assert.equal(f.calls[0].context.prompt, 'Judge this ticket.');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }));

test('review-fix caller prompts cannot acquire canonical host repair authority', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'review-fix', context: { prompt: 'Fix the review.' } }),
      error => error.code === 'REPAIR_SUBJECT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a wrong context.plan_sha256 refuses PLAN_DIGEST_MISMATCH for a ticket-delivery role', async () => {
  const f = fixture();
  const agentDir = fs.mkdtempSync(path.join(temporary, 'agents-'));
  const agentManifest = agentManifestFor(agentDir, 'ci-fix');
  try {
    await assert.rejects(() => delivery(f, { agentDir, agentManifest }).run({
      role: 'ci-fix', context: { prompt: 'Fix CI.', plan_sha256: '0'.repeat(64) },
    }), (error) => error.code === 'PLAN_DIGEST_MISMATCH');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a wrong context.plan_sha256 refuses PLAN_DIGEST_MISMATCH for the executor before the signer runs', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Implement.', plan_sha256: '0'.repeat(64) },
    }), (error) => error.code === 'PLAN_DIGEST_MISMATCH');
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('SHIPYARD_GRAPH_DIR pointing at an untracked graph copy in a non-main worktree refuses GRAPH_NOT_CANONICAL', () =>
  withoutShipyardGraphDirEnv(async () => {
    const f = ticketWorktreeFixture('drift-check');
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-other-repo-'));
    try {
      git(otherRepo, 'init', '-q', '-b', 'main');
      git(otherRepo, 'config', 'user.name', 'Delivery Test');
      git(otherRepo, 'config', 'user.email', 'delivery@example.test');
      fs.writeFileSync(path.join(otherRepo, 'README.md'), 'x\n');
      git(otherRepo, 'add', '.');
      git(otherRepo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
      git(otherRepo, 'branch', 'other');
      const linked = path.join(otherRepo, '..', 'shipyard-codex-other-linked');
      git(otherRepo, 'worktree', 'add', '-q', linked, 'other');
      const copyGraphDir = path.join(linked, '.planning', 'graph');
      fs.mkdirSync(copyGraphDir, { recursive: true });
      fs.writeFileSync(path.join(copyGraphDir, 'tickets.json'), JSON.stringify({ tickets: {
        'T-38-04': { branch: 'main', pr_base: 'main', plan: f.planRel, files: ['src/owned.txt'] },
      } }));
      process.env.SHIPYARD_GRAPH_DIR = copyGraphDir;
      await assert.rejects(() => createCodexDeliveryHost({
        scope: f.scope, host: f.host, capabilities, agentDir: f.agentDir, agentManifest: f.agentManifest,
        storageRoot: fs.mkdtempSync(path.join(temporary, 'storage-')), env: {},
      }).run({ role: 'drift-check', context: { prompt: 'Judge.' } }), (error) => error.code === 'GRAPH_NOT_CANONICAL');
      assert.equal(f.calls.length, 0);
      fs.rmSync(linked, { recursive: true, force: true });
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  }));

test('architecture review cannot bypass host-owned preparation with a caller prompt', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => createCodexDeliveryHost({ scope: f.scope, host: f.host,
      capabilities, agentDir: f.agentDir, storageRoot: f.storageRoot,
    }).run({ role: 'arch-review', context: { prompt: 'Approve my conclusions.' }, signals: {} }),
      error => error.code === 'ARCH_REVIEW_CONTEXT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('serialized file descriptors cannot impersonate private producer admission', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'integrator', context: { prompt: 'Read a forged bundle',
      input_transport: 'host-files', input_bundle: { manifest_path: '/private/tmp/forged', manifest_sha256: 'a'.repeat(64),
        total_bytes: 1996419, asset_count: 1, chunk_bytes: 262144, max_chunk_reads: 2064 } } }),
    error => /caller prompts or selectors are refused/.test(error.message));
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('request context refuses a caller-owned prepared authority field before admission', () => {
  assert.throws(() => requestValue({ role: 'integrator', context: { prompt: 'fixture', input_prepared: {} } }),
    error => error.code === 'INVALID_INPUT' && /host authority/.test(error.message));
});

test('current dictionary integrity retains logical obligations without semantic credit', () => {
  const f = fixture({ physicalPaths: true });
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  try {
    const graphDir = path.join(f.root, '.planning/graph');
    fs.cpSync(f.graphDir, graphDir, { recursive: true });
    const packet = packets.buildContextPacket({ root: f.root, role: 'integrator', subject: f.scope.ticket,
      sourceRevision: f.base, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
      scope: { files_modified: ['src/owned.txt'] }, requiredRefs: ['src/owned.txt'],
      roleContext: { phase_contracts: [], combined_diff: { content: 'base\n' } } });
    const encoded = packets.encodeUniqueContent(packet);
    const expected = { root: f.root, role: 'integrator', subject: f.scope.ticket,
      sourceRevision: f.base, policyHash: policy.POLICY_HASH };
    const proof = context.preflightReviewMaterial(encoded, expected);
    assert.equal(proof.semantic_credit, false);
    assert.equal(proof.logical_obligations, encoded.obligations.length);
    for (const key of ['role', 'sourceRevision', 'policyHash', 'subject'])
      assert.throws(() => context.preflightReviewMaterial(encoded, { ...expected, [key]: 'foreign' }));
    const incomplete = structuredClone(encoded);
    incomplete.obligations.pop();
    assert.throws(() => context.preflightReviewMaterial(incomplete, expected), /logical obligations|provenance/);
    const input = context.prepareFileInput(f.scope, JSON.stringify(encoded), {
      role: 'integrator', dispatchId: 'preflight-fixture', storageRoot: f.storageRoot, graphDir });
    assert.equal(context.verifyFileInput(input).semantic_credit, false);
    fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'changed\n');
    assert.throws(() => context.verifyFileInput(input), /changed|stale/i);
  } finally { clean(f); }
});

test('unavailable measured capacity returns actionable refusal without native dispatch', () => {
  const f = fixture({ physicalPaths: true });
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  try {
    assert.throws(() => context.prepareFileInput(f.scope, 'complete input', {
      role: 'integrator', dispatchId: 'capacity-fixture', storageRoot: f.storageRoot,
      readerCapacity: { contract: { schema: 'shipyard.native-reader-transport.v2' } },
    }), error => error.code === 'READER_CAPACITY_UNSUPPORTED'
      && error.refusal.limiting_field === 'original_matching_capacity_authority'
      && error.refusal.observed === 'unavailable' && /legacy/.test(error.refusal.supported_next_action));
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('encoded schedule admission counts complete manifest, envelopes and launch instructions', () => {
  const { preflightReaderSchedule } = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const manifest = { chunk_bytes: 128 * 1024, assets: [{ ordinal: 0, bytes: 256 * 1024 }],
    accounting: { relay_bytes: 1200, generated_instruction_bytes: 2400 },
    transport: { schema: 'shipyard.native-reader-transport.v2', chunk_bytes: 128 * 1024,
      encoding: 'base64', output_tokens: 10000, range_schedule: 'manifest-first/ordinal-offset/v1',
      nested_envelope: 'exec-command.v1', outer_envelope: 'functions-exec.v1', output_budget_bytes: 252 * 1024 } };
  const result = preflightReaderSchedule(manifest, 1024);
  assert.equal(result.range_count, 3);
  assert.equal(result.launch_input_bytes, 3600);
  assert.ok(result.encoded_schedule_bytes > 4 * Math.ceil((256 * 1024 + 1024) / 3));
  assert.equal(result.semantic_credit, false);
  for (const transport of [{ ...manifest.transport, schema: 'shipyard.native-reader-transport.v99' },
    { ...manifest.transport, output_budget_bytes: 128 * 1024 }])
    assert.throws(() => preflightReaderSchedule({ ...manifest, transport }, 1024), error =>
      error.code === 'READER_CAPACITY_UNSUPPORTED' && Boolean(error.refusal.supported_next_action));
});

for (const mutation of [null, 'dirty-source', 'dirty-intake', 'new-output', 'sibling-output']) {
  test('authenticated native research seals with dirty operator inputs: ' + (mutation || 'unchanged'), async () => {
    const f = fixture();
    const home = fs.mkdtempSync(path.join(temporary, 'research-native-'));
    let launches = 0;
    const source = path.join(f.root, 'src', 'owned.txt');
    const intake = path.join(f.root, '.planning', 'intake.md');
    try {
      fs.writeFileSync(source, 'operator source\n');
      fs.writeFileSync(intake, 'operator intake\n');
      const result = await createCodexDeliveryHost({ scope: f.scope, graphDir: f.graphDir,
        storageRoot: f.storageRoot, capabilities, agentDir: f.agentDir,
        agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
        env: { CODEX_HOME: home },
        probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
        spawn: (_executable, args) => {
          const ids = ['system-state', 'alternatives', 'constraints', 'risks'];
          const id = ids[launches++];
          const session = '88888888-8888-4888-8888-' + String(launches).padStart(12, '0');
          const artifactPath = path.join(fs.realpathSync(f.root), '.planning', 'investigations', 'INV-100', 'research', id + '.md');
          const bytes = Buffer.from('# ' + id + '\nNative finding.\n');
          fs.writeFileSync(artifactPath, bytes);
          if (mutation && launches === 2) {
            const target = mutation === 'dirty-source' ? source : mutation === 'dirty-intake' ? intake : mutation === 'new-output'
              ? path.join(f.root, 'rogue.txt') : path.join(path.dirname(artifactPath), 'system-state.md');
            fs.writeFileSync(target, 'unauthorized mutation\n');
          }
          const digest = crypto.createHash('sha256').update(bytes).digest('hex');
          const final = JSON.stringify({ id, status: 'completed', summary: 'Native research completed.',
            artifact: { path: artifactPath, bytes: bytes.length, content_bytes: bytes.length, sha256: digest, digest } });
          const model = args[args.indexOf('--model') + 1];
          const effort = JSON.parse(args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]);
          const transcript = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
            .split('\n').filter(Boolean).map(line => {
              const record = JSON.parse(line);
              if (record.type === 'turn_context') Object.assign(record.payload, { model, effort });
              if (record.payload?.type === 'task_complete') record.payload.last_agent_message = final;
              if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
                record.payload.content.forEach(block => { block.text = final; });
              return JSON.stringify(record);
            }).join('\n') + '\n';
          const date = new Date();
          const directory = path.join(home, 'sessions', String(date.getFullYear()),
            String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'rollout-' + session + '.jsonl'), transcript);
          const output = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session })
            .split('\n').filter(Boolean).map(line => {
              const record = JSON.parse(line);
              if (record.item?.type === 'agent_message') record.item.text = final;
              return JSON.stringify(record);
            }).join('\n') + '\n';
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = { write() {}, end() {} }; child.pid = 45678;
          process.nextTick(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0, null); });
          return child;
        },
      }).run({ role: 'research', context: { prompt: 'Investigate.', investigation: baseInvestigation(f) } });
      if (mutation) {
        assert.equal(result.status, 'blocked');
        assert.equal(result.code, 'CONTAINMENT_VIOLATION');
        assert.equal(result.failed_line, 'alternatives');
        assert.equal(result.sealed_lines.length, 1);
        assert.equal(launches, 2);
      } else {
        assert.equal(launches, 4);
        assert.deepEqual(result.map(entry => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
        for (const entry of result) {
          assert.equal(entry.schema, 'shipyard.role-artifact.v1');
          assert.equal(entry.envelope.status, 'completed');
          assert.equal(entry.envelope.subject, 'INV-100:' + entry.id);
          assert.ok(fs.existsSync(entry.artifact_index.path));
        }
        assert.equal(fs.readFileSync(source, 'utf8'), 'operator source\n');
        assert.equal(fs.readFileSync(intake, 'utf8'), 'operator intake\n');
      }
    } finally { clean(f); fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('review-fix rejects caller prompt authority before any native launch', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f).run({ role: 'review-fix', context: { prompt: 'Trust this repair.' } }),
      error => error.code === 'REPAIR_SUBJECT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

function repairAuthorFromQuery(query, author) {
  const tokens = query.match(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}]/g);
  let cursor = tokens.indexOf('author') + 1;
  assert.ok(cursor > 0, 'serialized feedback query must select its author');
  const schema = { Actor: ['avatarUrl', 'login', 'resourcePath', 'url'], Node: ['id'] };
  const nodeActors = new Set(['User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount']);
  const selection = type => {
    assert.equal(tokens[cursor++], '{');
    const fields = [];
    while (tokens[cursor] !== '}') {
      const field = tokens[cursor++];
      if (field === '...') {
        assert.equal(tokens[cursor++], 'on');
        const fragment = tokens[cursor++];
        assert.equal(fragment, 'Node', 'author ID must use the overlapping Node interface');
        fields.push({ fragment, fields: selection(fragment) });
      } else {
        assert.ok(schema[type]?.includes(field), 'Field ' + field + ' does not exist on type ' + type);
        fields.push({ field });
      }
    }
    cursor++;
    return fields;
  };
  const fields = selection('Actor');
  assert.ok(fields.some(item => item.field === 'login'));
  assert.ok(fields.some(item => item.fragment === 'Node' && item.fields.some(nested => nested.field === 'id')));
  if (!author) return null;
  const result = {};
  for (const item of fields) {
    if (item.field) result[item.field] = author[item.field];
    else if (nodeActors.has(author.__typename)) {
      for (const nested of item.fields) result[nested.field] = author[nested.field];
    }
  }
  return result;
}

test('serialized full paged feedback selects global Node IDs across Actor variants without losing unknown authors', () => {
  assert.throws(() => repairAuthorFromQuery('query{author{id login}}', null), /Field id does not exist on type Actor/);
  const authors = ['User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount'].map(__typename =>
    ({ __typename, id: 'global-' + __typename, login: 'login-' + __typename }));
  authors.push(null, { __typename: 'UnknownActor', login: 'delivery-host' });
  const requests = [];
  const prepared = { repo: 'fixture/repository', commit: { worktree: '/unused-read-only-fixture' } };
  const result = completeRepairFeedback({ execFileSync(program, args) {
    assert.equal(program, 'gh');
    const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
    const query = value('query');
    requests.push({ query, cursor: value('cursor') });
    if (query.includes('{id body title}')) return JSON.stringify({ data: { repository: { pullRequest:
      { id: 'pr-501', title: 'Complete title', body: 'Complete PR body' } } } });
    const connection = (nodes, more = false) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } });
    if (query.includes('reviewThreads(')) return JSON.stringify({ data: { repository: { pullRequest:
      { reviewThreads: connection([{ id: 'thread-1', isResolved: false }]) } } } });
    const field = query.includes('node(id:') ? 'thread-comments' : query.includes('reviews(') ? 'reviews' : 'comments';
    const offset = value('cursor') ? 3 : 0;
    const nodes = authors.slice(offset, offset ? undefined : 3).map((author, index) => ({
      id: field + '-' + (offset + index), body: 'Complete original body ' + field + '-' + (offset + index),
      author: repairAuthorFromQuery(query, author), ...(field === 'reviews' ? { state: 'COMMENTED' } : {}),
    }));
    const page = connection(nodes, offset === 0);
    return JSON.stringify({ data: field === 'thread-comments' ? { node: { comments: page } }
      : { repository: { pullRequest: { [field]: page } } } });
  } }, prepared, 501);
  assert.equal(result.inventory.length, 23);
  assert.equal(result.pages.length, 7);
  assert.equal(requests.filter(request => request.cursor === 'next').length, 3);
  for (const field of ['thread-comments', 'comments', 'reviews']) {
    authors.forEach((author, index) => {
      const entry = result.inventory.find(item => item.id === field + '-' + index);
      assert.equal(entry.body, 'Complete original body ' + field + '-' + index);
      assert.equal(entry.body_sha256, crypto.createHash('sha256').update(entry.body).digest('hex'));
      assert.equal(entry.author, author?.login || null);
      assert.equal(entry.author_id, index < 5 ? author.id : null);
    });
  }
  const canonicalInventory = JSON.stringify(result.inventory.map(entry =>
    Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))));
  assert.equal(result.digest, crypto.createHash('sha256').update(canonicalInventory).digest('hex'));
});

async function originalFixerFixture(outcome, mutation, evolution = null, historicalRecovery = null) {
  const f = fixture({ physicalPaths: true });
  if (['pending', 'action'].includes(historicalRecovery)) fs.writeFileSync(path.join(f.graphDir, 'delivery-log.jsonl'),
    JSON.stringify({ ts: '2026-10-19T07:31:21.739Z', event: 'status_change', ticket: 'T-999-98',
      from: null, to: 'pending', pr: null }) + '\n');
  const defaultAgents = mutation?.startsWith('normalized-default-') || mutation?.startsWith('normalized-cli-default-');
  const defaultOsHome = mutation?.endsWith('-os-home');
  const home = defaultOsHome ? path.join(fs.realpathSync(temporary), '.codex')
    : path.join(fs.realpathSync(temporary), 'repair-native-' + path.basename(f.root));
  if (defaultAgents) {
    const originalDir = f.agentDir;
    f.agentDir = path.join(home, 'agents');
    fs.mkdirSync(f.agentDir, { recursive: true });
    fs.cpSync(originalDir, f.agentDir, { recursive: true });
    fs.rmSync(originalDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(f.root, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('src/owned.txt','utf8'), 'fixed by static native review-fix\\n');\n");
  git(f.root, 'add', 'check.cjs'); git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture: actual candidate verification');
  f.base = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'update-ref', 'refs/heads/main', f.base);
  approvedPlan(f, ['node check.cjs']);
  const verificationAllowList = [{ argv: ['node', 'check.cjs'], profile: 'host', timeout_s: 600 }];
  const agentManifest = agentManifestFor(f.agentDir, 'review-fix');
  const evidenceFile = path.join(f.root, '.shipyard-evidence.md');
  fs.writeFileSync(evidenceFile, 'Complete original review evidence.');
  const boardFile = path.join(f.graphDir, 'delivery-state.json');
  const board = JSON.parse(fs.readFileSync(boardFile)); board['T-38-04'].pr = 501;
  fs.writeFileSync(boardFile, JSON.stringify(board));
  const graphFile = path.join(f.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphFile)); graph.tickets[f.scope.ticket].phase = '38';
  fs.writeFileSync(graphFile, JSON.stringify(graph));
  const built = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(['review-fix', f.scope.ticket,
    '--runtime', 'codex', '--pr', '501', '--review-file', evidenceFile, '--graph', f.graphDir], { cwd: f.root });
  f.scope = { ...f.scope, ...built.scope };
  const { scope: _scope, graph_dir: _graph, ...nativeRequest } = built;
  const legacyActions = mutation?.startsWith('companion-cli-legacy-');
  const threadId = legacyActions ? 'PRRT_kwDOTmU9jc6rQN4b' : 'thread-1';
  const commentId = legacyActions ? 'PRRC_kwDOTmU9jc784inG' : 'comment-1';
  const locationMutation = mutation?.includes('-location-');
  const feedback = [{ id: threadId, isResolved: false,
    ...((locationMutation || mutation?.startsWith('issue-')) ? { path: 'src/owned.txt', originalLine: 1616, line: 1653 } : {}) }];
  const originalThreadComment = { id: commentId, body: mutation?.startsWith('issue-') ? '[rule-a] Full original thread comment' : 'Full original thread comment' };
  const output = { schema: 'shipyard.repair-result.v1', id: f.scope.ticket, pr: 501,
    status: outcome === 'source' ? 'fixed' : outcome, pushed: false, notes: 'Complete repair reasoning.',
    hypothesis: 'The source condition explains the original finding.', review_dispositions: [
      { id: threadId, action: outcome === 'no-op' ? 'reply-and-resolve' : 'escalate', reply: 'Retain pending current review.', evidence: { command: 'inspect', result: 'complete source reviewed' } },
      { id: commentId, action: outcome === 'no-op' ? 'reply' : 'escalate', reply: 'Retain this obligation.', evidence: { command: 'inspect', result: 'complete comment reviewed' } },
      { id: 'pr-body-501', action: outcome === 'no-op' ? 'reply' : 'escalate', reply: 'Complete PR body reasoning.', evidence: { command: 'inspect PR', result: 'complete original body evaluated' } },
    ] };
  if (outcome === 'escalate') output.review_dispositions[1].action = 'reply';
  if (mutation?.startsWith('issue-')) for (const item of output.review_dispositions) item.action = 'escalate';
  if (['normalized-source-repeat', 'normalized-cli-source-repeat'].includes(mutation)) {
    for (const disposition of output.review_dispositions) disposition.action = disposition.id === threadId ? 'reply-and-resolve' : 'reply';
  }
  const replies = [], prReplies = [], external = [], reviews = [];
  const actor = legacyActions ? { __typename: 'User', id: 'U_kgDOBacXqA', login: 'serhii-nochevnyi' }
    : { __typename: 'User', id: 'authenticated-host-user', login: 'delivery-host' };
  const originalComments = legacyActions ? Array.from({ length: 3 }, (_, index) =>
    ({ id: 'original-pr-comment-' + index, body: 'Complete original external feedback ' + index })) : [];
  if (legacyActions) {
    output.review_dispositions = [output.review_dispositions[2], ...originalComments.map(comment => ({
      ...structuredClone(output.review_dispositions[2]), id: comment.id })),
    { ...output.review_dispositions[0], action: 'escalate' }, { ...output.review_dispositions[1], action: 'reply',
      reply: 'Launch setup exceptions are covered by the outer failure-retention handler.' }];
  }
  let swapReplyTarget = false, mutateRelation = false;
  let launches = 0, publishedHead = f.base, pushes = 0;
  let relationReads = 0;
  const readOnlyResponses = new Map();
  const live = () => ({ number: mutation === 'foreign-pr' ? 502 : 501, state: mutation === 'closed-pr' ? 'CLOSED' : 'OPEN',
    headRefName: 'ticket/T-38-04', headRefOid: mutation === 'stale-head' ? '1'.repeat(40) : publishedHead,
    baseRefName: 'main', baseRefOid: mutation === 'stale-base' ? '2'.repeat(40) : f.base });
  const gh = (_program, args) => {
    if (_program === 'git' && args[0] === 'push') {
      pushes++; publishedHead = git(f.root, 'rev-parse', 'HEAD');
      if (mutation === 'publication-response-loss' || (historicalRecovery === 'pending' && launches > 1)) throw new Error('Original push response was lost after remote confirmation');
      return 'confirmed host push';
    }
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'fixture/repository' });
    const query = args.find(arg => arg.startsWith('query='));
    if (args[0] === 'pr') return JSON.stringify({ id: 'pr-body-501' });
    const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
    const project = comment => ({ ...comment, author: repairAuthorFromQuery(query, comment.author) });
    if (query.includes('viewer{id login}')) return JSON.stringify({ data: { viewer: actor } });
    if (query.includes('addPullRequestReviewThreadReply')) {
      const forgedAuthor = {
        'reply-author-foreign': { ...actor, id: 'foreign-global-user' },
        'reply-author-login': { ...actor, login: 'foreign-login' },
        'reply-author-bot': { ...actor, __typename: 'Bot', id: 'foreign-global-bot' },
        'reply-author-mannequin': { ...actor, __typename: 'Mannequin', id: 'foreign-global-mannequin' },
        'reply-author-organization': { ...actor, __typename: 'Organization', id: 'foreign-global-organization' },
        'reply-author-enterprise': { ...actor, __typename: 'EnterpriseUserAccount', id: 'foreign-global-enterprise' },
        'reply-author-unknown': { ...actor, __typename: 'UnknownActor' },
        'reply-author-null': null,
        'reply-author-missing-id': { __typename: 'User', login: actor.login },
        'reply-author-api-id': { ...actor, id: 12345 },
      };
      const comment = { id: legacyActions && !replies.length ? 'PRRC_kwDOTmU9jc7865lw' : 'reply-' + (replies.length + 1), body: value('body'),
        author: replies.length === 0 && Object.hasOwn(forgedAuthor, mutation) ? forgedAuthor[mutation] : actor }; replies.push(comment);
      if (!reviews.length) reviews.push({ id: legacyActions ? 'PRR_kwDOTmU9jc8AAAABRu8U6g' : 'companion-review-1',
        body: '', state: 'COMMENTED', author: actor });
      if ((mutation === 'thread-response-loss' || mutation === 'companion-cli-response-loss' || mutation === 'companion-cli-legacy-absent'
          || mutation?.startsWith('pending-')) && replies.length === 1) throw new Error('Original accepted thread reply response lost');
      if ((mutation === 'companion-cli-reuse-response-loss' && replies.length === 2)
          || (historicalRecovery === 'action' && launches > 1 && replies.length === 3))
        throw new Error('Original accepted later thread reply response lost');
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment } } });
    }
    if (query.includes('addComment(input:')) {
      const comment = { id: 'pr-reply-' + (prReplies.length + 1), body: value('body'), author: actor }; prReplies.push(comment);
      if (mutation === 'comment-response-loss' && prReplies.length === 1) throw new Error('Original accepted PR reply response lost');
      return JSON.stringify({ data: { addComment: { commentEdge: { node: comment } } } });
    }
    if (query.includes('resolveReviewThread(input:')) { feedback[0].isResolved = true;
      if (mutation === 'resolve-response-loss') throw new Error('Original accepted resolve response lost');
      return JSON.stringify({ data: { resolveReviewThread: { thread: feedback[0] } } }); }
    if (query.includes('{id body title}')) return JSON.stringify({ data: { repository: { pullRequest: { id: 'pr-body-501', body: 'Original complete PR body', title: 'Original PR title' } } } });
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (query.includes('... on PullRequestReviewComment{')) {
      relationReads++;
      if ((['companion-cli-pending-id', 'companion-cli-legacy-id'].includes(mutation)
          || mutation?.startsWith('companion-cli-refuse-')) && relationReads === 1)
        throw new Error('Original relation query unavailable');
      const reply = replies.find(item => item.id === value('id'));
      const pr = { id: 'pr-body-501', number: 501, repository: { nameWithOwner: 'fixture/repository' } };
      const node = reply && { ...project(reply), replyTo: { id: commentId }, pullRequest: pr,
        pullRequestReview: reviews[0] ? { ...project(reviews[0]), pullRequest: pr } : null };
      const targetComment = [originalThreadComment, ...external, ...replies]
        .find(item => item.id === value('target'));
      const target = targetComment ? { ...project(targetComment), pullRequest: pr,
        replyTo: targetComment.id === commentId ? null : { id: commentId } } : {};
      if (mutation === 'companion-wrong-link') node.pullRequestReview.id = 'foreign-review';
      if (mutation === 'companion-wrong-pr') node.pullRequest.number = 502;
      if (mutation === 'companion-wrong-review-pr') node.pullRequestReview.pullRequest = { ...pr, id: 'foreign-pr' };
      if (mutation === 'companion-wrong-repo') node.pullRequest.repository.nameWithOwner = 'foreign/repository';
      if (mutation === 'companion-wrong-target') node.replyTo.id = 'foreign-comment';
      if (mutation === 'companion-truncated') node.pullRequestReview.body_truncated = true;
      if (['normalized-companion-link', 'normalized-covered-source-companion-link'].includes(mutation) && mutateRelation)
        node.pullRequestReview.id = 'foreign-review';
      return JSON.stringify({ data: { node, target } });
    }
    if (query.includes('node(id:')) {
      if (mutation === 'failed-page') throw new Error('original page unavailable');
      if (mutation === 'disposition-budget') {
        const offset = Number(value('cursor') || 0);
        return JSON.stringify({ data: { node: { comments: {
          nodes: Array.from({ length: 100 }, (_, index) => ({ id: 'bounded-obligation-' + (offset + index), body: 'x' })),
          pageInfo: { hasNextPage: offset + 100 < 2000, endCursor: String(offset + 100) } } } } });
      }
      const comments = [{ ...originalThreadComment, body: mutation === 'overflow' ? 'x'.repeat(600000) : originalThreadComment.body }, ...external, ...(swapReplyTarget ? [] : replies)].map(project);
      if (mutation === 'duplicate-feedback') comments.push(comments[0]);
      if (mutation === 'feedback-movement' && launches) comments.push({ id: 'new-obligation', body: 'New feedback after preparation.' });
      const page = connection(comments);
      if (mutation === 'stalled-pagination') page.pageInfo = { hasNextPage: true, endCursor: 'unchanged-cursor' };
      return JSON.stringify({ data: { node: { comments: page } } });
    }
    const field = query.includes('reviewThreads(') ? 'reviewThreads' : query.includes('reviews(') ? 'reviews' : 'comments';
    if (field === 'reviews' && reviews.length) {
      if (mutation === 'companion-review-body') reviews[0].body = 'New external review finding';
      if (mutation === 'companion-review-state') reviews[0].state = 'CHANGES_REQUESTED';
      if (mutation === 'companion-review-author') reviews[0].author = { ...actor, id: 'foreign-user' };
      if (mutation === 'companion-extra-review' && reviews.length === 1) reviews.push({ ...reviews[0], id: 'unknown-review' });
      if (mutation === 'companion-reuse-extra-review' && replies.length === 2 && reviews.length === 1)
        reviews.push({ ...reviews[0], id: 'unknown-later-review' });
      if (mutation === 'companion-reuse-review-body' && replies.length === 2) reviews[0].body = 'New external finding';
    }
    return JSON.stringify({ data: { repository: { pullRequest: { [field]: connection(field === 'reviewThreads' ? feedback : field === 'comments' ? [...originalComments, ...prReplies, ...(swapReplyTarget ? replies : [])].map(project) : reviews.map(project)) } } } });
  };
  const transport = (program, args, ...rest) => {
    const response = gh(program, args, ...rest);
    if (program === 'gh' && !args.some(arg => arg.startsWith('query=mutation')))
      readOnlyResponses.set(JSON.stringify(args), response);
    return response;
  };
  const originalHome = os.homedir; os.homedir = () => fs.realpathSync(temporary);
  const originalCodexHome = process.env.CODEX_HOME;
  if (defaultOsHome) delete process.env.CODEX_HOME;
  try {
    if (mutation === 'missing-disposition') output.review_dispositions.pop();
    if (mutation === 'missing-schema') delete output.schema;
    if (mutation === 'foreign-schema') output.schema = 'shipyard.repair-result.v2';
    if (mutation === 'extra-result-field') output.accepted = true;
    if (mutation === 'extra-disposition-field') output.review_dispositions[0].resolved = true;
    if (mutation === 'escalate-resolve') output.review_dispositions[0].action = 'reply-and-resolve';
    if (mutation === 'foreign-result') output.id = 'T-38-99';
    if (mutation === 'producer-push') output.pushed = true;
    if (mutation === 'evidence-symlink') { fs.unlinkSync(evidenceFile); fs.symlinkSync(f.plan, evidenceFile); }
    if (mutation === 'evidence-bytes') fs.appendFileSync(evidenceFile, 'changed');
    if (mutation === 'unknown-selector') nativeRequest.context.attempt = 99;
    if (mutation === 'caller-rung') nativeRequest.signals = { signatureState: 'repeat_exhausted' };
    if (mutation === 'caller-first') nativeRequest.signals = { signatureState: 'first' };
    if (mutation === 'caller-new') nativeRequest.signals = { signatureState: 'new' };
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'review-fix' });
    const run = (request = nativeRequest) => {
      const executing = request.role === 'executor';
      const launchRole = executing ? policy.resolveDispatch({ runtime: 'codex', role: 'executor' }) : selected;
      const hostOptions = { ...cliOptions(f), host: undefined, scope: f.scope,
      agentManifest, getPullRequest: live, execFileSync: transport, verification: undefined,
      verificationAllowList, hostVerificationRunner: hostRunner(),
      probe: { status: 'available', executable: 'codex', runtime_version: 'fixture',
        capabilities: { supportedModels: [selected.model], supportedEfforts: ['low', 'high', 'xhigh'] } },
      env: { CODEX_HOME: home },
      spawn(_executable, _args, options) {
        launches++;
        if (defaultOsHome) assert.equal(options.env.CODEX_HOME, undefined);
        const session = crypto.randomUUID();
        const effort = JSON.parse(_args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]);
        const applied = { model: _args[_args.indexOf('--model') + 1], effort,
          agent_file: !launchRole.agent_file || effort === 'low' ? launchRole.agent_file
            : launchRole.agent_file.replace('.toml', effort === 'high' ? '-repeat.toml' : '-deep.toml') };
        if (executing) assert.equal(applied.agent_file, null, 'executor uses the original dynamic native launch');
        const final = JSON.stringify(output);
        if (historicalRecovery && !executing && launches > 1) fs.writeFileSync(path.join(f.root, 'outside.txt'), 'Subsequent native source correction.\n');
        if (outcome === 'source' || executing || (historicalRecovery && launches > 1)) fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'fixed by static native review-fix\n');
        if (mutation === 'foreign-dirty') fs.writeFileSync(path.join(f.root, 'outside.txt'), 'foreign mutation');
        if (mutation === 'self-commit') { git(f.root, 'add', 'src/owned.txt'); git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unauthorized producer commit'); }
        if (mutation === 'plan-movement') fs.appendFileSync(f.plan, '\nChanged approved PLAN.');
        if (mutation === 'evidence-completion') fs.appendFileSync(evidenceFile, '\nChanged during native turn.');
        fs.writeFileSync(path.join(f.root, '.shipyard-repair-evidence.md'), 'Complete original producer evidence and dispositions.');
        const capturedRows = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
          .trim().split('\n').map(JSON.parse);
        const started = capturedRows.find(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
        const turnId = crypto.randomUUID();
        Object.assign(started.payload, { turn_id: turnId, root_turn_id: turnId });
        const nativeMessage = (role, text, phase) => {
          const row = structuredClone(capturedRows.find(row => row.type === 'response_item'
            && row.payload?.type === 'message' && row.payload.role === role));
          assert.ok(row, 'registered native message template is required');
          row.payload.content = [{ ...row.payload.content[0], text }];
          row.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
          if (phase) row.payload.phase = phase;
          return row;
        };
        const user = nativeMessage('user', '');
        const instructions = applied.agent_file
          ? require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').generatedInstructions(
            fs.readFileSync(path.join(f.agentDir, applied.agent_file), 'utf8')) : null;
        const rows = [capturedRows.find(row => row.type === 'session_meta'), capturedRows.find(row => row.type === 'turn_context'),
          started, ...(instructions === null ? [] : [nativeMessage('developer', instructions)]), user,
          capturedRows.find(row => row.type === 'response_item' && row.payload?.phase === 'final_answer'),
          capturedRows.find(row => row.type === 'event_msg' && row.payload?.type === 'task_complete')];
        if (mutation === 'native-delegation') {
          const call = structuredClone(capturedRows.find(row => row.type === 'response_item' && row.payload?.type === 'function_call'));
          Object.assign(call.payload, { name: 'spawn_agent', call_id: 'unauthorized-fixer-child', arguments: JSON.stringify({ agent_type: 'executor' }) });
          call.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
          rows.splice(rows.length - 2, 0, call);
        }
        for (const row of rows) {
          if (row.type === 'session_meta') Object.assign(row.payload, { id: session, session_id: session, cwd: f.root, runtime_workspace_roots: [f.root] });
          if (row.type === 'turn_context') {
            Object.assign(row.payload, { model: applied.model, effort: applied.effort, cwd: f.root, turn_id: turnId });
            row.payload.sandbox_policy = { type: 'workspace-write' };
            if (row.payload.collaboration_mode?.settings) Object.assign(row.payload.collaboration_mode.settings, { model: applied.model, reasoning_effort: applied.effort });
          }
          if (row.payload?.type === 'task_complete') Object.assign(row.payload, { last_agent_message: final, turn_id: turnId });
          if (row.payload?.phase === 'final_answer') {
            row.payload.internal_chat_message_metadata_passthrough.turn_id = turnId;
            row.payload.content.forEach(block => { block.text = final; });
          }
        }
        if (mutation === 'missing-native-completion') rows.pop();
        if (mutation === 'duplicate-native-final') rows.splice(rows.length - 1, 0, structuredClone(rows.at(-2)));
        if (mutation === 'foreign-native-final') rows.at(-2).payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign-turn';
        if (mutation === 'mismatched-native-final') rows.at(-2).payload.content[0].text = 'foreign final JSON';
        const date = new Date();
        const nativeHome = options.env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        const directory = path.join(nativeHome, 'sessions', String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        fs.mkdirSync(directory, { recursive: true });
        const cli = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session })
          .trim().split('\n').map(JSON.parse);
        for (const row of cli) if (row.item?.type === 'agent_message') row.item.text = final;
        const finalItem = cli.find(row => row.item?.type === 'agent_message');
        const progress = Array.from({ length: 4 }, (_, index) => {
          const row = structuredClone(finalItem);
          Object.assign(row.item, { id: 'progress-' + index, text: 'Original progress ' + index });
          return row;
        });
        cli.splice(cli.findIndex(row => row.item?.type === 'agent_message'), 0, ...progress);
        rows.splice(rows.length - 2, 0, ...progress.map(row => nativeMessage('assistant', row.item.text, 'commentary')));
        if (mutation === 'duplicate-cli-final') {
          const duplicate = structuredClone(finalItem); duplicate.item.id = 'duplicate-final';
          cli.splice(cli.length - 1, 0, duplicate);
        }
        if (mutation === 'foreign-cli-session') {
          const foreign = structuredClone(cli.find(row => row.type === 'thread.started'));
          foreign.thread_id = crypto.randomUUID(); cli.unshift(foreign);
        }
        if (mutation === 'mismatched-cli-final') cli.findLast(row => row.item?.type === 'agent_message').item.text = 'Foreign final';
        if (mutation === 'duplicate-completion') cli.push(structuredClone(cli.find(row => row.type === 'turn.completed')));
        if (mutation === 'missing-completion') cli.splice(cli.findIndex(row => row.type === 'turn.completed'), 1);
        const child = new EventEmitter(); child.pid = 45678;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { write(prompt) {
          if (executing) assert.ok(String(prompt).includes('executor already dispatched'));
          else {
          assert.ok(String(prompt).includes('full feedback') || String(prompt).includes('complete feedback'));
          const required = String(prompt).split('exactly these required fields: ')[1]?.split('. ')[0];
          assert.ok(required, 'the actual generated native prompt must enumerate the complete producer schema');
          for (const field of ['schema', 'id', 'pr', 'status', 'pushed', 'notes', 'hypothesis', 'review_dispositions'])
            assert.match(required, new RegExp('\\b' + field + '\\b'));
          assert.ok(required.includes('schema="shipyard.repair-result.v1"'));
          assert.ok(String(prompt).includes('If status="escalate", every disposition must use reply or escalate'));
          assert.ok(String(prompt).includes('reply-and-resolve is forbidden for ALL findings in that result'));
          }
          user.payload.content = [{ type: 'input_text', text: mutation === 'native-context' ? 'Repair a foreign subject.' : String(prompt).trim() }];
        }, end() {
          process.nextTick(() => {
            fs.writeFileSync(path.join(directory, session + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
            child.stdout.emit('data', Buffer.from(cli.map(JSON.stringify).join('\n') + '\n')); child.emit('close', 0, null);
          });
        } };
        return child;
      },
      };
      if (historicalRecovery === 'admitted' && launches > 0 && !executing) {
        hostOptions.finalizeCommit = () => { throw Object.assign(new Error('Fixture finalizer interruption'), { code: 'SIGNING_FAILED' }); };
      }
      if (defaultAgents) {
        delete hostOptions.agentDir;
        delete hostOptions.agentManifest;
        if (defaultOsHome) hostOptions.env = {};
      }
      if (mutation?.endsWith('-callback')) {
        const storage = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'));
        const actualRuntime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs').createCodexRuntimeHost({
          ...hostOptions, recorderDir: path.join(storage, 'receipts'), transcriptDir: path.join(storage, 'transcripts'),
          additionalProtectedPaths: [stateRoot(f), require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').archiveAuthorityDirectory(f.root)],
        });
        hostOptions.host = { ...actualRuntime, launchStatic(selection, context) {
          return actualRuntime.launchStatic(selection, { ...context, onCompleted(completed) {
            if (mutation === 'missing-callback') return;
            if (mutation === 'foreign-callback') context.onCompleted({ ...completed, session_id: crypto.randomUUID() });
            else if (mutation === 'mismatched-callback') context.onCompleted({ ...completed, last_agent_message: 'foreign result' });
            else { context.onCompleted(completed); context.onCompleted(completed); }
          } });
        } };
      }
      if (mutation?.startsWith('normalized-cli-') && launches) {
        const requestFile = path.join(home, 'original-repeat-request.json');
        fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, ...nativeRequest }));
        const written = [];
        return runCli(['--args-file', requestFile], { write(chunk) { written.push(chunk); } }, hostOptions)
          .then(result => { assert.equal(JSON.parse(written.join('')).receipt.dispatch_id, result.receipt.dispatch_id); return result; });
      }
      return createCodexDeliveryHost(hostOptions).run(request);
    };
    if (['thread-response-loss', 'comment-response-loss', 'resolve-response-loss', 'companion-cli-response-loss',
      'companion-cli-pending-id', 'companion-cli-reuse-response-loss', 'companion-cli-legacy-id', 'companion-cli-legacy-absent'].includes(mutation)
        || mutation?.startsWith('pending-') || mutation?.startsWith('companion-cli-refuse-')) {
      await assert.rejects(run, { code: 'REPAIR_FEEDBACK_UNAVAILABLE' });
      const records = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'));
      assert.equal(records.length, 1);
      const dispatchId = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', records[0]))).payload.dispatch_id;
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList });
      if (mutation?.startsWith('companion-cli-refuse-')) {
        const file = path.join(stateRoot(f), 'repair-actions', records[0]);
        if (mutation === 'companion-cli-refuse-head') publishedHead = '3'.repeat(40);
        if (mutation === 'companion-cli-refuse-graph') fs.appendFileSync(graphFile, '\n');
        if (mutation === 'companion-cli-refuse-plan') fs.appendFileSync(f.plan, '\n');
        if (mutation === 'companion-cli-refuse-ledger') {
          const envelope = JSON.parse(fs.readFileSync(file)); envelope.payload.pending.reply_id = 'foreign-reply';
          fs.writeFileSync(file, JSON.stringify(envelope));
        }
        const bytes = fs.readFileSync(file), scopeFile = path.join(home, 'refused-action-scope.json');
        const { runtime: _runtime, provider: _provider, ...scope } = f.scope;
        fs.writeFileSync(scopeFile, JSON.stringify(scope));
        await assert.rejects(() => runCli(['--resume-repair-actions', dispatchId, '--scope-file', scopeFile],
          { write() { throw new Error('refusal cannot produce a success result'); } },
          { ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList }),
        { code: mutation === 'companion-cli-refuse-ledger' ? 'STATE_RECORD_INVALID' : 'REPAIR_SUBJECT_CHANGED' });
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.equal(launches, 1); assert.equal(replies.length, 1); assert.equal(prReplies.length, 0);
        assert.equal(feedback[0].isResolved, false);
        return;
      }
      if (mutation?.startsWith('pending-')) {
        if (mutation === 'pending-duplicate') replies.push({ ...replies[0], id: 'ambiguous-reply' });
        if (mutation === 'pending-author') replies[0].author = { ...actor, id: 'foreign-user' };
        if (mutation === 'pending-body') replies[0].body += ' changed';
        if (mutation === 'pending-target') swapReplyTarget = true;
        if (mutation === 'pending-external') external.push({ id: 'unexpected-external', body: 'complete unknown feedback' });
        if (mutation === 'pending-missing') replies.length = 0;
        const before = replies.length + prReplies.length;
        assert.throws(() => recoveryHost.resumeRepairActions(dispatchId, f.scope), { code: 'REPAIR_ACTION_PENDING' });
        assert.equal(replies.length + prReplies.length, before);
        assert.equal(launches, 1); assert.equal(feedback[0].isResolved, false);
        return;
      }
      let recovered;
      if (mutation?.startsWith('companion-cli-')) {
        const scopeFile = path.join(home, 'original-action-recovery-scope.json');
        const { runtime: _runtime, provider: _provider, ...recoveryScope } = f.scope;
        fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
        const writes = [], options = { ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList,
          spawn() { throw new Error('action recovery cannot start another native model'); } };
        const actionFile = path.join(stateRoot(f), 'repair-actions', records[0]);
        const before = JSON.parse(fs.readFileSync(actionFile)).payload;
        assert.equal(before.pending.reply_id !== undefined, ['companion-cli-pending-id', 'companion-cli-legacy-id'].includes(mutation));
        assert.ok(!Object.hasOwn(before.pending, 'reply_review'));
        if (legacyActions) {
          assert.equal(before.confirmed.length, 4);
          assert.ok(before.confirmed.every(action => !Object.hasOwn(action, 'reply_review')));
          assert.equal(before.pending.feedback_id, commentId);
          assert.equal(replies[0].id, 'PRRC_kwDOTmU9jc7865lw');
          assert.equal(reviews[0].id, 'PRR_kwDOTmU9jc8AAAABRu8U6g');
          assert.equal(before.pending.body_sha256, '96715a709acea7e1cd45596690a04924b36a42ea1c6e440f09686ef7461e3dc0');
        }
        const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
        const snapshots = fs.readdirSync(receiptDir).filter(file => fs.statSync(path.join(receiptDir, file)).isFile())
          .map(file => [file, fs.readFileSync(path.join(receiptDir, file))]);
        const argv = ['--resume-repair-actions', dispatchId, '--scope-file', scopeFile];
        if (legacyActions) {
          completeRepairFeedback({ execFileSync: transport }, { repo: 'fixture/repository', commit: { worktree: f.root } }, 501);
          const query = 'query($id:ID!,$target:ID!){node(id:$id){... on PullRequestReviewComment{id body author{login ... on Node{id}} '
            + 'replyTo{id} pullRequest{id number repository{nameWithOwner}} '
            + 'pullRequestReview{id body state author{login ... on Node{id}} pullRequest{id number repository{nameWithOwner}}}}} '
            + 'target:node(id:$target){... on PullRequestReviewComment{id body author{login ... on Node{id}} '
            + 'replyTo{id} pullRequest{id number repository{nameWithOwner}}}}}';
          const args = ['api', 'graphql', '-f', 'query=' + query, '-f', 'id=' + replies[0].id, '-f', 'target=' + commentId];
          try { transport('gh', args); } catch { transport('gh', args); }
          const registryFile = path.join(home, 'complete-current-gh-responses.json');
          fs.writeFileSync(registryFile, JSON.stringify({ options: { storageRoot: f.storageRoot, graphDir: f.graphDir,
            verificationAllowList }, live: live(), responses: [...readOnlyResponses], argv, home: fs.realpathSync(temporary) }));
          const script = `const fs = require('node:fs'), os = require('node:os');
            const registry = JSON.parse(fs.readFileSync(process.argv[1])); os.homedir = () => registry.home;
            const host = require(process.argv[2]); const responses = new Map(registry.responses);
            host.runCli(registry.argv, process.stdout, { ...registry.options, getPullRequest: () => registry.live,
              spawn() { throw new Error('cold recovery must not launch'); }, execFileSync(program, args) {
                if (program !== 'gh' || args.some(arg => arg.startsWith('query=mutation')))
                  throw new Error('cold recovery must not replay an action');
                const raw = responses.get(JSON.stringify(args)); if (!raw) throw new Error('uncaptured original read');
                return raw;
              } }).catch(error => { process.stderr.write(error.code + ': ' + error.message); process.exitCode = 1; });`;
          const cold = spawnSync(process.execPath, ['-e', script, registryFile,
            path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs')],
          { encoding: 'utf8', env: process.env, timeout: 30000 });
          assert.equal(cold.status, 0, cold.stderr);
          recovered = JSON.parse(cold.stdout);
        } else {
          recovered = await runCli(argv, { write(chunk) { writes.push(chunk); } }, options);
          assert.deepEqual(JSON.parse(writes.join('')), recovered);
        }
        const confirmed = JSON.parse(fs.readFileSync(actionFile)).payload;
        assert.equal(confirmed.schema, before.schema);
        assert.deepEqual(confirmed.subject, before.subject);
        assert.deepEqual(confirmed.actor, before.actor);
        const threadActions = confirmed.confirmed.filter(action => action.reply_review);
        assert.equal(threadActions[0].reply_review.created, true);
        if (!legacyActions) assert.equal(threadActions[1].reply_review.created, false);
        else assert.deepEqual(confirmed.confirmed.slice(0, 4), before.confirmed);
        assert.equal(confirmed.feedback.inventory.filter(item => item.kind === 'review').length, 1);
        assert.ok(confirmed.feedback.pages.every(page => Number.isInteger(page.count)));
        assert.deepEqual(threadActions[0].reply_review.review, confirmed.feedback.inventory.find(item => item.kind === 'review'));
        const relation = threadActions[0].reply_review;
        assert.equal(relation.sha256, crypto.createHash('sha256').update(relation.response).digest('hex'));
        assert.equal(JSON.parse(relation.response).data.node.pullRequestReview.id, relation.review.id);
        const repeated = await runCli(argv, { write() {} }, options);
        assert.deepEqual(repeated, recovered);
        for (const [file, bytes] of snapshots) assert.deepEqual(fs.readFileSync(path.join(receiptDir, file)), bytes);
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      } else recovered = recoveryHost.resumeRepairActions(dispatchId, f.scope);
      assert.equal(recovered.actions.confirmed.length, legacyActions ? 5 : 3);
      assert.equal(replies.length + prReplies.length, legacyActions ? 5 : 3, 'accepted replies with lost responses are not replayed');
      assert.equal(feedback[0].isResolved, !legacyActions);
      return;
    }
    if (mutation?.startsWith('companion-')) {
      await assert.rejects(run, { code: 'REPAIR_ACTION_PENDING' });
      const laterReply = mutation.startsWith('companion-reuse-');
      assert.equal(launches, 1); assert.equal(replies.length, laterReply ? 2 : 1); assert.equal(prReplies.length, 0);
      assert.equal(feedback[0].isResolved, laterReply);
      const file = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'))[0];
      const pending = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file))).payload;
      assert.equal(pending.pending.reply_id, replies.at(-1).id);
      const bytes = fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file));
      assert.throws(() => createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verificationAllowList }).resumeRepairActions(pending.dispatch_id, f.scope), { code: 'REPAIR_ACTION_PENDING' });
      assert.deepEqual(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file)), bytes);
      assert.equal(replies.length, laterReply ? 2 : 1); assert.equal(launches, 1);
      return;
    }
    if (mutation?.startsWith('reply-author-')) {
      await assert.rejects(run, { code: 'REPAIR_ACTION_PENDING' });
      assert.equal(launches, 1); assert.equal(replies.length, 1); assert.equal(prReplies.length, 0);
      assert.equal(feedback[0].isResolved, false);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      const records = fs.readdirSync(path.join(stateRoot(f), 'repair-actions'));
      assert.equal(records.length, 1);
      const dispatchId = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-actions', records[0]))).payload.dispatch_id;
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList });
      assert.throws(() => recoveryHost.resumeRepairActions(dispatchId, f.scope), { code: 'REPAIR_ACTION_PENDING' });
      assert.equal(replies.length, 1); assert.equal(feedback[0].isResolved, false);
      replies[0].author = { ...actor };
      const recovered = recoveryHost.resumeRepairActions(dispatchId, f.scope);
      assert.equal(recovered.actions.confirmed.length, 3);
      assert.equal(replies.length + prReplies.length, 3, 'authenticated recovery confirms the original reply without replay');
      assert.equal(feedback[0].isResolved, true); assert.equal(launches, 1);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      return;
    }
    if (mutation === 'publication-response-loss') {
      await assert.rejects(run, { code: 'REPAIR_PUBLICATION_PENDING' });
      const candidates = fs.readdirSync(path.join(stateRoot(f), 'candidates'));
      assert.equal(candidates.length, 1);
      const recovered = await createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() })
        .resumeFinalization(candidates[0].replace(/\.json$/, ''), f.scope);
      assert.equal(recovered.idempotent, true);
      assert.equal(recovered.publication.status, 'confirmed');
      assert.equal(recovered.artifact.commit, publishedHead);
      assert.equal(recovered.actions.status, 'confirmed');
      assert.equal(pushes, 1, 'an independently confirmed signed push is never replayed');
      assert.equal(launches, 1);
      return;
    }
    if (mutation?.startsWith('issue-')) {
      if (mutation === 'issue-unknown') feedback[0].line = feedback[0].originalLine = null;
      if (mutation === 'issue-ambiguous') originalThreadComment.body = '[rule-a] rule:other class:conflicting';
      const first = await run();
      assert.equal(first.receipt.applied_effort, 'low');
      const installRung = (suffix, rung, effort) => {
        const file = selected.agent_file.replace('.toml', suffix + '.toml');
        const original = fs.readFileSync(path.join(f.agentDir, selected.agent_file), 'utf8');
        const agent = original.replace('shipyard-policy-rung = "base"', 'shipyard-policy-rung = "' + rung + '"')
          .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "' + effort + '"')
          .replace('name = "' + selected.agent_file.replace('.toml', '') + '"', 'name = "' + file.replace('.toml', '') + '"');
        fs.writeFileSync(path.join(f.agentDir, file), agent);
        const manifest = JSON.parse(fs.readFileSync(agentManifest));
        manifest.agent_files.push(file); manifest.agent_digests[file] = crypto.createHash('sha256').update(agent).digest('hex');
        fs.writeFileSync(agentManifest, JSON.stringify(manifest));
      };
      installRung('-repeat', 'repeat', 'high'); installRung('-deep', 'repeat_exhausted', 'xhigh');
      const repost = (id, rule) => {
        originalThreadComment.id = id;
        originalThreadComment.body = '[' + rule + '] Reposted current finding';
        output.review_dispositions[1].id = id;
      };
      if (mutation === 'issue-shift') feedback[0].line++;
      repost('comment-b', ['issue-repost', 'issue-shift'].includes(mutation) ? 'rule-a' : 'rule-b');
      const second = await run();
      assert.equal(second.receipt.applied_effort, mutation === 'issue-repost' ? 'high' : 'low');
      assert.equal(second.resolution.signals.signatureState, mutation === 'issue-repost' ? 'repeat' : 'first');
      if (['issue-unknown', 'issue-ambiguous', 'issue-shift'].includes(mutation)) {
        assert.equal(second.resolution.signals.signatureState, 'first');
        assert.equal(second.receipt.applied_effort, 'low');
        return;
      }
      if (mutation !== 'issue-repost') {
        repost('comment-a-again', 'rule-a');
        const third = await run();
        assert.equal(third.resolution.signals.signatureState, 'repeat');
        assert.equal(third.receipt.applied_effort, 'high');
        assert.equal(third.resolution.signals.priorApplied.dispatch_id, first.dispatch_id);
        const attempts = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).map(file =>
          JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload);
        const originalThird = attempts.find(item => item.dispatch_id === third.dispatch_id);
        const originalSecond = attempts.find(item => item.dispatch_id === second.dispatch_id);
        const secondFile = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).find(file =>
          JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload.dispatch_id === second.dispatch_id);
        assert.equal(originalThird.predecessor, secondFile.replace(/\.json$/, ''));
        assert.equal(originalSecond.dispatch_id, second.dispatch_id);
        repost('comment-b-again', 'rule-b');
        assert.equal((await run()).receipt.applied_effort, 'high');
        repost('comment-a-deep', 'rule-a');
        const fifth = await run();
        assert.equal(fifth.resolution.signals.signatureState, 'repeat_exhausted');
        assert.equal(fifth.receipt.applied_effort, 'xhigh');
        assert.equal(fifth.resolution.signals.priorApplied.dispatch_id, third.dispatch_id);
        repost('comment-a-exhausted', 'rule-a');
        await assert.rejects(run, { code: 'REPAIR_POLICY_EXHAUSTED' });
      }
      return;
    }
    if (mutation?.startsWith('normalized-')) {
      const first = await run();
      assert.equal(first.actions.confirmed.length, 3);
      assert.equal(first.resolution.signals.signatureState, 'first');
      const firstReceipt = first.receipt;
      const firstHead = git(f.root, 'rev-parse', 'HEAD');
      const coveredSource = mutation.startsWith('normalized-covered-source');
      let sourceResult;
      let currentHead = firstHead;
      const retainedFiles = fs.readdirSync(path.join(stateRoot(f), 'repair-actions')).map(file => ({
        file: path.join(stateRoot(f), 'repair-actions', file), bytes: fs.readFileSync(path.join(stateRoot(f), 'repair-actions', file)) }));
      if ((coveredSource && locationMutation) || evolution) {
        const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
        const dispatchDigest = crypto.createHash('sha256').update(first.dispatch_id).digest('hex');
        for (const file of ['record-' + dispatchDigest + '.json', 'reservation-' + dispatchDigest + '.json']) {
          const original = path.join(receiptDir, file);
          assert.ok(fs.statSync(original).isFile());
          retainedFiles.push({ file: original, bytes: fs.readFileSync(original) });
        }
        const transcript = firstReceipt.runtime_evidence.transcript.path;
        retainedFiles.push({ file: transcript, bytes: fs.readFileSync(transcript) });
        const nativeFiles = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs')
          .nativeSessionCandidates(path.join(home, 'sessions'), firstReceipt.runtime_evidence.session_id);
        assert.equal(nativeFiles.length, 1);
        retainedFiles.push({ file: nativeFiles[0], bytes: fs.readFileSync(nativeFiles[0]) });
      }
      if (coveredSource) {
        sourceResult = await run({ role: 'executor', context: { prompt: 'Implement the current covered source correction.' } });
        currentHead = git(f.root, 'rev-parse', 'HEAD'); publishedHead = currentHead;
        assert.equal(sourceResult.receipt.role, 'executor'); assert.equal(sourceResult.receipt.compliance, 'verified');
        assert.equal(sourceResult.receipt.agent_file, undefined);
        assert.equal(sourceResult.receipt.agent_file_digest, undefined);
        assert.ok(sourceResult.receipt.runtime_evidence.native_session_evidence);
        const sealedDirectory = name => path.join(stateRoot(f), name);
        const finalized = fs.readdirSync(sealedDirectory('finalized')).map(name =>
          JSON.parse(fs.readFileSync(path.join(sealedDirectory('finalized'), name))).payload).find(item => item.commit === currentHead);
        assert.ok(finalized); assert.equal(finalized.parent, firstHead);
        const candidateRecord = path.join(sealedDirectory('candidates'), finalized.candidate_id + '.json');
        const sealedCandidate = JSON.parse(fs.readFileSync(candidateRecord));
        assert.equal(sealedCandidate.payload.expected_role, 'executor');
        assert.equal(sealedCandidate.payload.dispatch_id, sourceResult.dispatch_id);
        graph.synchronized_head = currentHead; fs.writeFileSync(graphFile, JSON.stringify(graph));
        if (mutation.endsWith('-forged')) {
          sealedCandidate.payload.ticket = 'T-38-99';
          fs.writeFileSync(candidateRecord, JSON.stringify(sealedCandidate));
        }
        if (mutation.endsWith('-plan')) fs.appendFileSync(f.plan, '\nChanged approved PLAN.');
        if (mutation.endsWith('-owners')) { graph.tickets[f.scope.ticket].files.push('outside.txt'); fs.writeFileSync(graphFile, JSON.stringify(graph)); }
      }
      if (evolution) {
        if (['owners', 'all'].includes(evolution)) {
          graph.tickets[f.scope.ticket].files.push('outside.txt');
          fs.writeFileSync(graphFile, JSON.stringify(graph));
        }
        if (['allowlist', 'all'].includes(evolution)) {
          verificationAllowList.push({ argv: ['node', '--version'], profile: 'host', timeout_s: 600 });
          approvedPlan(f, ['node check.cjs', 'node --version']);
        }
        fs.appendFileSync(f.plan, '\nCurrent approved scope: ' + JSON.stringify(graph.tickets[f.scope.ticket].files) + '\n');
        if (['base', 'all'].includes(evolution)) {
          f.base = currentHead;
          git(f.root, 'update-ref', 'refs/heads/main', currentHead);
        }
        if (['base-merge', 'base-merge-extra'].includes(evolution)) {
          git(f.root, 'checkout', '-q', 'main');
          fs.writeFileSync(path.join(f.root, 'base-only.txt'), 'Current approved base material.\n');
          git(f.root, 'add', 'base-only.txt'); git(f.root, 'commit', '-q', '-S', '-m', 'Current signed base evolution');
          f.base = git(f.root, 'rev-parse', 'HEAD');
          git(f.root, 'checkout', '-q', graph.tickets[f.scope.ticket].branch);
          git(f.root, 'merge', '--no-ff', '-S', '-m', 'Import current signed base', 'main');
          if (evolution === 'base-merge-extra') {
            fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'Unverified merge edit.\n');
            git(f.root, 'add', 'src/owned.txt'); git(f.root, 'commit', '--amend', '-q', '-S', '--no-edit');
          }
          currentHead = git(f.root, 'rev-parse', 'HEAD'); publishedHead = currentHead;
          graph.synchronized_head = currentHead; fs.writeFileSync(graphFile, JSON.stringify(graph));
        }
        if (evolution === 'unsigned-base') {
          f.base = git(f.root, '-c', 'commit.gpgsign=false', 'commit-tree', git(f.root, 'rev-parse', 'HEAD^{tree}'),
            '-p', f.base, '-m', 'Unsigned base evolution');
          git(f.root, 'update-ref', 'refs/heads/main', f.base);
        }
        const fresh = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs').build(['review-fix', f.scope.ticket,
          '--runtime', 'codex', '--pr', '501', '--review-file', evidenceFile, '--graph', f.graphDir], { cwd: f.root });
        if (evolution !== 'stale-plan') nativeRequest.context = fresh.context;
      }
      if (mutation?.startsWith('normalized-uncovered-source')) {
        fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'uncovered external source\n');
        git(f.root, 'add', 'src/owned.txt');
        git(f.root, ...(mutation.endsWith('-signed') ? ['commit', '-qS'] : ['-c', 'commit.gpgsign=false', 'commit', '-q']), '-m', 'uncovered external source');
        publishedHead = git(f.root, 'rev-parse', 'HEAD');
      }
      if (['normalized-source-repeat', 'normalized-cli-source-repeat'].includes(mutation)) assert.equal(firstHead, first.artifact.commit);
      const actionFile = path.join(stateRoot(f), 'repair-actions', crypto.createHash('sha256').update(first.dispatch_id).digest('hex') + '.json');
      if (mutation === 'normalized-forged-actions') {
        const state = JSON.parse(fs.readFileSync(actionFile)); state.payload.confirmed[0].reply_id = 'forged';
        fs.writeFileSync(actionFile, JSON.stringify(state));
      }
      if (mutation === 'normalized-companion-forged') {
        const state = JSON.parse(fs.readFileSync(actionFile)); state.payload.confirmed[0].reply_review.response += ' ';
        fs.writeFileSync(actionFile, JSON.stringify(state));
      }
      if (['normalized-reply-body', 'normalized-covered-source-reply-body'].includes(mutation)) replies[0].body += ' mutated';
      if (['normalized-reply-author', 'normalized-covered-source-reply-author'].includes(mutation)) replies[0].author = { ...actor, id: 'foreign-user' };
      if (['normalized-reply-id', 'normalized-covered-source-reply-id'].includes(mutation)) replies[0].id = 'foreign-reply';
      if (['normalized-reply-target', 'normalized-covered-source-reply-target'].includes(mutation)) swapReplyTarget = true;
      if (mutation === 'normalized-missing-actions') fs.unlinkSync(actionFile);
      if (mutation === 'normalized-reopened') feedback[0].isResolved = false;
      if (mutation === 'normalized-source') publishedHead = '3'.repeat(40);
      if (['normalized-companion-link', 'normalized-covered-source-companion-link'].includes(mutation)) mutateRelation = true;
      if (mutation === 'normalized-companion-body') reviews[0].body = 'New finding on the retained companion review';
      if (mutation === 'normalized-companion-author') reviews[0].author = { ...actor, id: 'foreign-user' };
      if (mutation === 'normalized-companion-missing') reviews.length = 0;
      if (locationMutation) {
        feedback[0].line = mutation.endsWith('-null') ? null : 1686;
        if (mutation.endsWith('-path')) feedback[0].path = 'outside.txt';
        if (mutation.endsWith('-original-line')) feedback[0].originalLine++;
        if (mutation.endsWith('-thread-id')) feedback[0].id = 'foreign-thread';
        if (mutation.endsWith('-reopened')) feedback[0].isResolved = false;
        if (mutation.endsWith('-negative')) feedback[0].line = -1;
        if (mutation.endsWith('-string')) feedback[0].line = '1686';
        if (mutation.endsWith('-zero')) feedback[0].line = 0;
        if (mutation.endsWith('-false')) feedback[0].line = false;
        if (mutation.endsWith('-empty')) feedback[0].line = '';
        if (mutation.endsWith('-body')) originalThreadComment.body += ' changed original feedback';
        if (mutation.endsWith('-author')) originalThreadComment.author = { ...actor, id: 'foreign-user' };
      }
      const refusal = {
        'normalized-location-shift': 'REPAIR_PREDECESSOR_INVALID', 'normalized-location-null': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-uncovered-source-location-shift': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-location-forged': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-location-path': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-original-line': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-thread-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-reopened': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-negative': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-string': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-zero': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-false': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-empty': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-location-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-forged': 'REPAIR_SUBJECT_CHANGED', 'normalized-uncovered-source': 'REPAIR_SUBJECT_CHANGED',
        'normalized-uncovered-source-signed': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-plan': 'PLAN_DIGEST_MISMATCH', 'normalized-covered-source-owners': 'REPAIR_SUBJECT_CHANGED',
        'normalized-covered-source-reply-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-reply-target': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-covered-source-companion-link': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-forged-actions': 'STATE_RECORD_INVALID', 'normalized-reply-body': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-reply-author': 'REPAIR_PREDECESSOR_INVALID', 'normalized-reply-id': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-reply-target': 'REPAIR_PREDECESSOR_INVALID', 'normalized-reopened': 'REPAIR_PREDECESSOR_INVALID', 'normalized-source': 'REPAIR_SUBJECT_CHANGED',
        'normalized-companion-body': 'REPAIR_PREDECESSOR_INVALID', 'normalized-companion-author': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-companion-missing': 'REPAIR_PREDECESSOR_INVALID', 'normalized-companion-link': 'REPAIR_PREDECESSOR_INVALID',
        'normalized-companion-forged': 'STATE_RECORD_INVALID',
      }[mutation];
      if (refusal || ['stale-plan', 'unsigned-base', 'base-merge-extra'].includes(evolution)) {
        await assert.rejects(run, { code: evolution === 'stale-plan' ? 'PLAN_DIGEST_MISMATCH'
          : ['unsigned-base', 'base-merge-extra'].includes(evolution) ? 'REPAIR_SUBJECT_CHANGED' : refusal });
        assert.equal(launches, coveredSource ? 2 : 1); assert.equal(replies.length + prReplies.length, 3);
        if (locationMutation) {
          for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
        }
        return;
      }
      if (mutation === 'normalized-missing-actions') {
        for (const reply of [...replies, ...prReplies, ...reviews]) output.review_dispositions.push({
          ...structuredClone(output.review_dispositions[1]), id: reply.id });
      }
      if (mutation === 'normalized-external') {
        external.push({ id: 'external-identical-body', body: replies[0].body, author: actor });
        output.review_dispositions.push({ ...structuredClone(output.review_dispositions[1]), id: external[0].id });
      }
      for (const disposition of output.review_dispositions) disposition.action = 'reply';
      const repeatFile = selected.agent_file.replace('.toml', '-repeat.toml');
      const originalAgent = fs.readFileSync(path.join(f.agentDir, selected.agent_file), 'utf8');
      const repeatAgent = originalAgent.replace('shipyard-policy-rung = "base"', 'shipyard-policy-rung = "repeat"')
        .replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"')
        .replace('name = "' + selected.agent_file.replace('.toml', '') + '"', 'name = "' + repeatFile.replace('.toml', '') + '"');
      fs.writeFileSync(path.join(f.agentDir, repeatFile), repeatAgent);
      const manifest = JSON.parse(fs.readFileSync(agentManifest));
      manifest.agent_files.push(repeatFile); manifest.agent_digests[repeatFile] = crypto.createHash('sha256').update(repeatAgent).digest('hex');
      fs.writeFileSync(agentManifest, JSON.stringify(manifest));
      if (['normalized-default-missing-manifest', 'normalized-default-stale-manifest'].includes(mutation)) {
        if (mutation.endsWith('-missing-manifest')) fs.unlinkSync(agentManifest);
        else fs.appendFileSync(path.join(f.agentDir, repeatFile), '\nchanged installed repeat instructions\n');
        await assert.rejects(run, { code: 'STALE_GENERATED_AGENT' });
        assert.equal(launches, 1, 'invalid installed defaults refuse before the repeated native launch');
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), firstHead);
        assert.equal(replies.length + prReplies.length, 3);
        return;
      }
      let second;
      if (historicalRecovery) {
        output.status = 'fixed';
        if (historicalRecovery === 'direct') {
          second = await run();
          const counters = [launches, pushes, replies.length, prReplies.length];
          const recovery = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
            verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() });
          for (let retry = 0; retry < 2; retry++) {
            const resumed = await recovery.resumeFinalization(second.artifact.candidate_id, f.scope);
            assert.equal(resumed.artifact.commit, second.artifact.commit);
            assert.equal(resumed.actions.status, 'confirmed');
            assert.deepEqual([launches, pushes, replies.length, prReplies.length], counters);
          }
        } else {
          await assert.rejects(run);
          const candidates = fs.readdirSync(path.join(stateRoot(f), 'candidates')).map(file =>
            JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'candidates', file))).payload);
          const candidate = candidates.find(item => item.expected_head === currentHead && item.expected_role === 'review-fix');
          assert.ok(candidate);
          const historical = candidate.repair_subject.actionable_feedback.coverage.map(item =>
            repairCoverageTransition(item, candidate.repair_subject.actionable_feedback));
          assert.equal(historical.length, 3);
          assert.ok(historical.every(item => item.historical && item.semantic_credit === false
            && (item.source_transition ? item.source_transition.to === currentHead : firstHead === currentHead)));
          assert.deepEqual(candidate.files_modified, graph.tickets[f.scope.ticket].files);
          const counters = [launches, pushes, replies.length, prReplies.length];
          const originals = [...retainedFiles];
          for (const directory of ['candidates', 'finalized']) {
            const root = path.join(stateRoot(f), directory);
            if (fs.existsSync(root)) for (const file of fs.readdirSync(root)) originals.push({
              file: path.join(root, file), bytes: fs.readFileSync(path.join(root, file)) });
          }
          const recoveryOptions = { ...cliOptions(f), getPullRequest: live, execFileSync: transport,
            verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() };
          const recovery = createFinalizationRecoveryHost(recoveryOptions);
          const resume = () => recovery.resumeFinalization(candidate.candidate_id, f.scope);
          const unchangedCounters = () => assert.deepEqual([launches, pushes, replies.length, prReplies.length], counters);
          const rejectFileChange = async (file, mutate) => {
            const bytes = fs.readFileSync(file);
            const mode = fs.statSync(file).mode & 0o777;
            try { mutate(file, bytes); await assert.rejects(resume); unchangedCounters(); }
            finally { fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); }
          };
          await rejectFileChange(f.plan, file => fs.appendFileSync(file, '\nChanged current PLAN'));
          await rejectFileChange(graphFile, file => {
            const changed = JSON.parse(fs.readFileSync(file)); changed.tickets[f.scope.ticket].files.push('foreign-owner.txt');
            fs.writeFileSync(file, JSON.stringify(changed));
          });
          await rejectFileChange(evidenceFile, file => fs.appendFileSync(file, '\nReplaced evidence'));
          for (const directory of ['candidates', 'finalized', 'repair-publications', 'repair-actions', 'repair-attempts']) {
            const root = path.join(stateRoot(f), directory);
            if (!fs.existsSync(root)) continue;
            for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json')
                && (!['candidates', 'finalized', 'repair-publications'].includes(directory) || name === candidate.candidate_id + '.json'))) {
              const file = path.join(root, name);
              await rejectFileChange(file, (target, bytes) => {
                const envelope = JSON.parse(bytes); envelope.payload.ticket = 'T-38-99';
                fs.writeFileSync(target, JSON.stringify(envelope));
              });
              await rejectFileChange(file, target => fs.unlinkSync(target));
            }
          }
          for (const original of retainedFiles.filter(item => !item.file.includes('repair-actions') && !path.basename(item.file).startsWith('reservation-'))) {
            await rejectFileChange(original.file, file => fs.appendFileSync(file, '\nTampered original native custody'));
          }
          await assert.rejects(() => recovery.resumeFinalization(candidate.candidate_id, { ...f.scope, repository: 'foreign-repository' }));
          unchangedCounters();
          verificationAllowList.push({ argv: ['node', '--invalid-recovery-policy'], profile: 'host', timeout_s: 600 });
          try { await assert.rejects(resume); unchangedCounters(); } finally { verificationAllowList.pop(); }
          const baseBefore = git(f.root, 'rev-parse', 'main');
          try {
            git(f.root, 'update-ref', 'refs/heads/main', candidate.expected_head === baseBefore ? 'HEAD' : candidate.expected_head);
            if (git(f.root, 'rev-parse', 'main') !== baseBefore) { await assert.rejects(resume); unchangedCounters(); }
          } finally { git(f.root, 'update-ref', 'refs/heads/main', baseBefore); }
          const branchBefore = git(f.root, 'symbolic-ref', 'HEAD');
          try {
            git(f.root, 'update-ref', 'refs/heads/foreign-recovery', 'HEAD');
            git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/foreign-recovery');
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'symbolic-ref', 'HEAD', branchBefore); }
          const originalSigner = git(f.root, 'config', 'user.signingkey');
          try {
            git(f.root, 'config', 'user.signingkey', 'F'.repeat(40));
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'config', 'user.signingkey', originalSigner); }
          const originalPublished = publishedHead;
          try { publishedHead = '1'.repeat(40); await assert.rejects(resume); unchangedCounters(); }
          finally { publishedHead = originalPublished; }
          const sourceHead = git(f.root, 'rev-parse', 'HEAD');
          const unrelated = git(f.root, 'commit-tree', '-S', git(f.root, 'rev-parse', 'HEAD^{tree}'),
            '-p', sourceHead, '-m', 'Unrelated authentic equal-tree signed commit');
          try {
            git(f.root, 'update-ref', 'HEAD', unrelated); publishedHead = unrelated;
            await assert.rejects(resume); unchangedCounters();
          } finally { git(f.root, 'update-ref', 'HEAD', sourceHead); publishedHead = originalPublished; }
          if (['pending', 'action'].includes(historicalRecovery)) {
            const originalGraph = fs.readFileSync(graphFile);
            const snapshot = path.join(f.root, '.git', 'original-recovery-graph.json');
            fs.writeFileSync(snapshot, originalGraph);
            recoveryOptions.recoveryGraphSnapshot = snapshot;
            const journal = candidate.repair_subject.journal;
            assert.ok(journal);
            const journalBytes = fs.readFileSync(journal.path);
            const row = { ts: '2026-10-20T07:31:21.739Z', event: 'status_change', ticket: 'T-999-99',
              from: null, to: 'pending', pr: null };
            const append = value => fs.writeFileSync(journal.path, Buffer.concat([journalBytes, Buffer.from(value)]));
            for (const invalid of [JSON.stringify(row), 'false\n', '{bad}\n',
              JSON.stringify({ ...row, ticket: f.scope.ticket }) + '\n',
              JSON.stringify({ ...row, pr: candidate.repair_subject.pr }) + '\n',
              JSON.stringify({ ...row, event: 'repair_attempt' }) + '\n',
              JSON.stringify({ ...row, to: false }) + '\n', Buffer.from([0xff, 10])]) {
              append(invalid);
              await assert.rejects(resume); unchangedCounters();
            }
            append(JSON.stringify(row) + '\n');
            const evolved = JSON.parse(originalGraph);
            evolved.tickets['T-999-99'] = { ...evolved.tickets[f.scope.ticket], depends_on: [f.scope.ticket] };
            fs.writeFileSync(graphFile, JSON.stringify(evolved));
            await rejectFileChange(snapshot, file => fs.appendFileSync(file, ' '));
            await rejectFileChange(graphFile, file => {
              const changed = JSON.parse(fs.readFileSync(file)); changed.tickets[f.scope.ticket].risk = 'changed';
              fs.writeFileSync(file, JSON.stringify(changed));
            });
            await rejectFileChange(journal.path, (file, bytes) => {
              const changed = Buffer.from(bytes); changed[0] ^= 1; fs.writeFileSync(file, changed);
            });
            await rejectFileChange(journal.path, file => fs.writeFileSync(file, journalBytes.subarray(0, -1)));
            await rejectFileChange(graphFile, file => {
              const changed = JSON.parse(fs.readFileSync(file)); changed.epics = { forged: true };
              fs.writeFileSync(file, JSON.stringify(changed));
            });
            delete recoveryOptions.recoveryGraphSnapshot;
            await assert.rejects(resume); unchangedCounters();
            recoveryOptions.recoveryGraphSnapshot = snapshot;
          }
          const resumed = await resume();
          assert.equal(resumed.publication.status, 'confirmed');
          assert.equal(resumed.actions.status, 'confirmed');
          assert.notEqual(resumed.artifact.commit, currentHead);
          const accepted = [launches, pushes, replies.length, prReplies.length];
          assert.equal(accepted[0], counters[0]);
          if (historicalRecovery !== 'admitted') assert.equal(accepted[1], counters[1]);
          const again = await recovery.resumeFinalization(candidate.candidate_id, f.scope);
          assert.deepEqual(again.artifact, resumed.artifact);
          assert.deepEqual([launches, pushes, replies.length, prReplies.length], accepted);
          if (candidate.repair_subject.journal) {
            const pin = candidate.repair_subject.journal;
            assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pin.path).subarray(0, pin.bytes)).digest('hex'), pin.sha256);
          }
          for (const original of originals) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
          for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
          return;
        }
      } else second = await run();
      const unknown = !!evolution || coveredSource || ['normalized-external', 'normalized-missing-actions'].includes(mutation);
      assert.equal(second.resolution.signals.signatureState, unknown ? 'first' : 'repeat');
      assert.equal(second.receipt.applied_effort, unknown ? 'low' : 'high');
      assert.equal(second.receipt.agent_file_digest, crypto.createHash('sha256').update(unknown ? originalAgent : repeatAgent).digest('hex'));
      assert.notEqual(second.dispatch_id, first.dispatch_id);
      assert.notEqual(second.receipt.runtime_evidence.session_id, firstReceipt.runtime_evidence.session_id);
      assert.notEqual(second.receipt.launch_id, firstReceipt.launch_id);
      assert.notEqual(second.receipt.runtime_evidence.transcript.sha256, firstReceipt.runtime_evidence.transcript.sha256);
      assert.notEqual(second.receipt.runtime_evidence.native_session_evidence.sha256, firstReceipt.runtime_evidence.native_session_evidence.sha256);
      assert.equal(second.repair_result.review_dispositions.length, mutation === 'normalized-missing-actions' ? 7 : mutation === 'normalized-external' ? 4 : 3);
      if (mutation !== 'normalized-missing-actions') assert.ok(second.repair_result.review_dispositions.every(item => !/^reply-|^pr-reply-/.test(item.id)));
      const attempts = fs.readdirSync(path.join(stateRoot(f), 'repair-attempts')).map(file =>
        JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'repair-attempts', file))).payload).filter(item => item.dispatch_id);
      const originalSecond = attempts.find(item => item.dispatch_id === second.dispatch_id);
      assert.equal(originalSecond.subject.feedback.inventory.length, mutation === 'normalized-external' ? 8 : 7);
      assert.equal(originalSecond.subject.actionable_feedback.coverage.length, mutation === 'normalized-missing-actions' ? 0 : 3);
      if (coveredSource || evolution) {
        const historicalCoverage = originalSecond.subject.actionable_feedback.coverage.map(item =>
          repairCoverageTransition(item, originalSecond.subject.actionable_feedback));
        assert.deepEqual(originalSecond.subject.actionable_feedback.historical_dispatch_ids, [first.dispatch_id]);
        assert.ok(historicalCoverage.every(item => item.historical && item.semantic_credit === false
          && (!coveredSource || (item.source_transition.from === firstHead && item.source_transition.to === currentHead))));
        assert.equal(originalSecond.subject.actionable_feedback.inventory.find(item => item.id === threadId).resolved, true);
        if (evolution) {
          assert.ok(historicalCoverage.every(item => item.scope_transition
            && item.scope_transition.from.plan.sha256 !== item.scope_transition.to.plan.sha256));
          assert.equal(originalSecond.preparation.plan.sha256, nativeRequest.context.plan_sha256);
          assert.deepEqual(originalSecond.preparation.commit.files_modified, graph.tickets[f.scope.ticket].files);
          assert.deepEqual(originalSecond.preparation.verificationAllowList, verificationAllowList);
          assert.equal(originalSecond.preparation.commit.expectedBase, f.base);
          if (!coveredSource) assert.ok(historicalCoverage.every(item =>
            !Object.hasOwn(item, 'source_transition')), 'PLAN-only provenance must not invent a source transition');
          if (evolution === 'base-merge') {
            for (const item of historicalCoverage) {
              const records = item.source_transition.records;
              assert.equal(records.filter(pin => pin.candidate_id).length, 1);
              assert.equal(records.filter(pin => pin.base_import && pin.semantic_credit === false).length, 1);
              const merge = records.find(pin => pin.base_merge);
              assert.equal(merge.commit, currentHead); assert.equal(merge.semantic_credit, false);
              assert.deepEqual(merge.base_merge.parents, [sourceResult.artifact.commit, f.base]);
              assert.equal(merge.base_merge.tree, git(f.root, 'rev-parse', currentHead + '^{tree}'));
            }
          }
        }
        if (locationMutation) {
          const originalThread = JSON.parse(retainedFiles[0].bytes).payload.feedback.inventory.find(item => item.id === threadId);
          const currentThread = originalSecond.subject.actionable_feedback.inventory.find(item => item.id === threadId);
          assert.equal(originalThread.line, 1653);
          assert.deepEqual(currentThread, { ...originalThread, line: feedback[0].line });
          const receiptDir = path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts');
          assert.equal(createDurableRecorder(receiptDir).getLatestReceipt('codex', 'review-fix').dispatch_id, second.dispatch_id);
        }
        for (const original of retainedFiles) assert.deepEqual(fs.readFileSync(original.file), original.bytes);
        assert.equal(first.receipt.dispatch_id, firstReceipt.dispatch_id);
      }
      assert.equal(originalSecond.subject.actionable_feedback.digest === attempts.find(item => item.dispatch_id === first.dispatch_id).normalized_feedback_digest,
        !unknown);
      assert.equal(replies.length + prReplies.length, mutation === 'normalized-missing-actions' ? 10 : mutation === 'normalized-external' ? 7 : 6);
      if (mutation === 'normalized-repeat' && !evolution) {
        const deepFile = selected.agent_file.replace('.toml', '-deep.toml');
        const deepAgent = repeatAgent.replace('shipyard-policy-rung = "repeat"', 'shipyard-policy-rung = "repeat_exhausted"')
          .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"')
          .replace('name = "' + repeatFile.replace('.toml', '') + '"', 'name = "' + deepFile.replace('.toml', '') + '"');
        fs.writeFileSync(path.join(f.agentDir, deepFile), deepAgent);
        manifest.agent_files.push(deepFile); manifest.agent_digests[deepFile] = crypto.createHash('sha256').update(deepAgent).digest('hex');
        fs.writeFileSync(agentManifest, JSON.stringify(manifest));
        const third = await run();
        assert.equal(third.resolution.signals.signatureState, 'repeat_exhausted');
        assert.equal(third.receipt.applied_effort, 'xhigh');
        assert.notEqual(third.dispatch_id, first.dispatch_id); assert.notEqual(third.dispatch_id, second.dispatch_id);
        assert.equal(third.repair_result.review_dispositions.length, 3);
        assert.equal(replies.length + prReplies.length, 9);
        await assert.rejects(run, { code: 'REPAIR_POLICY_EXHAUSTED' });
        assert.equal(launches, 3);
      }
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), historicalRecovery === 'direct' ? second.artifact.commit : currentHead);
      return;
    }
    if (mutation) {
      const expectedCode = {
        'foreign-pr': 'REPAIR_SUBJECT_CHANGED', 'closed-pr': 'REPAIR_SUBJECT_CHANGED',
        'stale-head': 'REPAIR_SUBJECT_CHANGED', 'stale-base': 'REPAIR_SUBJECT_CHANGED',
        'failed-page': 'REPAIR_FEEDBACK_UNAVAILABLE', 'overflow': 'REPAIR_FEEDBACK_OVERFLOW',
        'disposition-budget': 'REPAIR_FEEDBACK_OVERFLOW', 'duplicate-feedback': 'REPAIR_FEEDBACK_INVALID',
        'stalled-pagination': 'REPAIR_FEEDBACK_INVALID', 'feedback-movement': 'REPAIR_SUBJECT_CHANGED',
        'missing-disposition': 'REPAIR_COMPLETION_INVALID', 'missing-schema': 'REPAIR_COMPLETION_INVALID',
        'foreign-schema': 'REPAIR_COMPLETION_INVALID', 'extra-result-field': 'REPAIR_COMPLETION_INVALID',
        'extra-disposition-field': 'REPAIR_COMPLETION_INVALID',
        'escalate-resolve': 'REPAIR_COMPLETION_INVALID', 'foreign-result': 'REPAIR_COMPLETION_INVALID',
        'producer-push': 'REPAIR_COMPLETION_INVALID', 'evidence-symlink': 'REPAIR_EVIDENCE_CHANGED',
        'evidence-bytes': 'REPAIR_EVIDENCE_CHANGED', 'unknown-selector': 'INVALID_INPUT', 'caller-rung': 'INVALID_INPUT',
        'caller-first': 'INVALID_INPUT', 'caller-new': 'INVALID_INPUT',
        'foreign-dirty': 'SCOPED_TREE_UNAVAILABLE', 'self-commit': 'REPAIR_SUBJECT_CHANGED',
        'plan-movement': 'REPAIR_SUBJECT_CHANGED', 'evidence-completion': 'REPAIR_EVIDENCE_CHANGED',
        'missing-completion': 'RUNTIME_EVIDENCE_MISSING', 'duplicate-completion': 'RUNTIME_EVIDENCE_MISMATCH',
        'missing-callback': 'REPAIR_COMPLETION_INVALID', 'foreign-callback': 'REPAIR_COMPLETION_INVALID',
        'mismatched-callback': 'REPAIR_COMPLETION_INVALID', 'duplicate-callback': 'RUNTIME_EVIDENCE_INVALID',
        'duplicate-cli-final': 'REPAIR_COMPLETION_INVALID', 'foreign-cli-session': 'RUNTIME_EVIDENCE_INVALID',
        'mismatched-cli-final': 'RUNTIME_EVIDENCE_MISMATCH', 'duplicate-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'missing-native-completion': 'RUNTIME_EVIDENCE_MISMATCH', 'foreign-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'mismatched-native-final': 'RUNTIME_EVIDENCE_MISMATCH',
        'native-context': 'REPAIR_COMPLETION_INVALID', 'native-delegation': 'REPAIR_COMPLETION_INVALID',
      }[mutation];
      assert.ok(expectedCode, 'every mutation must name its intended refusal');
      await assert.rejects(run, { code: expectedCode });
      const prelaunch = ['foreign-pr', 'closed-pr', 'stale-head', 'stale-base', 'failed-page', 'overflow',
        'disposition-budget', 'duplicate-feedback', 'stalled-pagination', 'evidence-symlink', 'evidence-bytes',
        'unknown-selector', 'caller-rung', 'caller-first', 'caller-new'];
      assert.equal(launches, prelaunch.includes(mutation) ? 0 : 1);
      if (mutation !== 'self-commit') assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      assert.equal(replies.length + prReplies.length, 0);
      return;
    }
    const result = await run();
    assert.equal(launches, 1);
    assert.equal(result.receipt.role, 'review-fix');
    assert.equal(result.receipt.compliance, 'verified');
    const originalStream = fs.readFileSync(result.receipt.runtime_evidence.transcript.path, 'utf8');
    assert.equal(crypto.createHash('sha256').update(originalStream).digest('hex'), result.receipt.runtime_evidence.transcript.sha256);
    const streamRows = originalStream.trim().split('\n').map(JSON.parse);
    assert.equal(streamRows.filter(row => row.type === 'turn.completed').length, 1);
    assert.equal(streamRows.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message').length, 5);
    assert.equal(streamRows.findLast(row => row.item?.type === 'agent_message').item.text, JSON.stringify(output));
    // @contract: Selection signals retain the original boundary resolution identity.
    assert.equal(result.resolution.dispatch_id, result.receipt.dispatch_id);
    assert.equal(result.resolution.role, 'review-fix');
    assert.equal(result.resolution.model, selected.model);
    assert.equal(result.resolution.effort, selected.effort);
    assert.deepEqual(result.resolution.signals, result.signals);
    assert.equal(result.resolution.signals.signatureState, 'first');
    assert.equal(Object.hasOwn(result.resolution.signals, 'priorApplied'), false);
    assert.equal(result.receipt.applied_effort, selected.effort);
    assert.equal(result.repair.role, 'review-fix');
    assert.equal(result.repair.envelope.pushed, false);
    // @contract: Artifact base identity uses the canonical graph/PR literal, including for equivalent Git aliases.
    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const repairRead = { role: 'review-fix', ticket: f.scope.ticket, pr: 501,
      worktreePath: f.root, base: graph.tickets[f.scope.ticket].pr_base,
      branch: graph.tickets[f.scope.ticket].branch, planPath: graph.tickets[f.scope.ticket].plan,
      boundaryStore: result.receipt_store || path.join(f.storageRoot, crypto.createHash('sha256').update(f.scope.run_id + '\0' + f.root).digest('hex'), 'receipts'),
      dispatchId: result.receipt.dispatch_id, artifactPath: result.repair.artifact_ref, artifactDigest: result.repair.artifact_digest, historical: true };
    assert.equal(repairRead.base, live().baseRefName);
    assert.throws(() => roleArtifacts.read({ ...repairRead, base: 'refs/heads/main' }), { code: 'STALE_ARTIFACT' });
    // @contract: PLAN identity retains the graph literal; filesystem aliases and foreign paths refuse.
    assert.equal(path.resolve(f.graphDir, '..', '..', repairRead.planPath), f.plan);
    for (const planPath of [f.plan, './' + repairRead.planPath, '.planning/phases/38-requests/38-99-PLAN.md']) {
      assert.throws(() => roleArtifacts.read({ ...repairRead, planPath }),
        error => error.code === 'ARTIFACT_IDENTITY_MISMATCH' && error.message.includes('plan_path'));
    }
    const protectedRepair = roleArtifacts.read(repairRead);
    assert.equal(protectedRepair.base, repairRead.base);
    assert.equal(protectedRepair.manifest.branch, repairRead.branch);
    assert.equal(protectedRepair.manifest.plan_path, repairRead.planPath);
    assert.equal(protectedRepair.manifest.producer_dispatch, result.receipt.dispatch_id);
    assert.equal(protectedRepair.manifest.producer_launch, result.receipt.launch_id);
    assert.equal(protectedRepair.pr, output.pr);
    assert.equal(protectedRepair.ticket, output.id);
    assert.equal(protectedRepair.integration_base.commit, f.base);
    assert.equal(protectedRepair.producer_head, f.base);
    assert.equal(protectedRepair.evidence, 'Complete original producer evidence and dispositions.');
    assert.equal(protectedRepair.findings.hypothesis, output.hypothesis);
    assert.deepEqual(result.repair_result.review_dispositions, output.review_dispositions);
    if (outcome === 'source') {
      assert.equal(result.artifact.status, 'committed');
      assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
      assert.equal(result.actions.status, 'confirmed');
      assert.equal(publishedHead, result.artifact.commit);
      assert.ok(git(f.root, 'show', '-s', '--format=%B', 'HEAD').includes('Shipyard-Verification-Evidence:'));
      const signedCandidate = JSON.parse(fs.readFileSync(path.join(stateRoot(f), 'candidates', result.artifact.candidate_id + '.json'))).payload;
      assert.equal(signedCandidate.expected_role, 'review-fix');
      const recoveryHost = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport,
        verification: undefined, verificationAllowList, hostVerificationRunner: hostRunner() });
      await assert.rejects(() => recoveryHost.resumeFinalization(result.artifact.candidate_id, { ...f.scope, role: 'executor' }),
        error => error.code === 'IDENTITY_CHANGED' && error.invalidated.includes('role'));
      const resumed = await recoveryHost.resumeFinalization(result.artifact.candidate_id, f.scope);
      assert.equal(resumed.idempotent, true); assert.equal(resumed.artifact.commit, result.artifact.commit);
      assert.equal(resumed.publication.status, 'confirmed'); assert.equal(launches, 1);
    } else {
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      assert.equal(result.artifact, undefined);
      if (outcome === 'no-op') {
        assert.equal(result.actions.confirmed.length, 3);
        assert.equal(result.actions.confirmed.filter(action => action.resolved).length, 1);
        assert.equal(feedback[0].isResolved, true);
        assert.equal(replies.length + prReplies.length, 3);
        const recovered = createFinalizationRecoveryHost({ ...cliOptions(f), getPullRequest: live, execFileSync: transport, verificationAllowList })
          .resumeRepairActions(result.receipt.dispatch_id, f.scope);
        assert.equal(recovered.resumed, true); assert.equal(recovered.actions.confirmed.length, 3);
        assert.equal(replies.length + prReplies.length, 3, 'confirmed actions are independently checked without replay');
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      } else { assert.equal(feedback[0].isResolved, false); assert.equal(result.actions.confirmed.length, 0); }
    }
  } finally {
    os.homedir = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    clean(f); fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const outcome of ['source', 'no-op', 'escalate']) test('canonical builder through original static fixer seals ' + outcome + ' with host custody with four original native progress messages',
  () => withGraphDirEnv(undefined, () => originalFixerFixture(outcome)));
for (const mutation of ['missing-schema', 'foreign-schema', 'extra-result-field', 'extra-disposition-field', 'escalate-resolve'])
  test('complete multi-message escalated native fixer refuses ' + mutation + ' before any host action',
    () => withGraphDirEnv(undefined, () => originalFixerFixture('escalate', mutation)));
test('signed fixer publication recovers a lost response without replaying its confirmed push',
  () => withGraphDirEnv(undefined, () => originalFixerFixture('source', 'publication-response-loss')));
for (const mutation of ['foreign-pr', 'closed-pr', 'stale-head', 'stale-base', 'failed-page', 'overflow', 'disposition-budget', 'duplicate-feedback',
  'stalled-pagination', 'feedback-movement', 'missing-disposition', 'foreign-result', 'producer-push', 'evidence-symlink', 'evidence-bytes',
  'unknown-selector', 'caller-rung', 'caller-first', 'caller-new', 'foreign-dirty', 'self-commit', 'plan-movement', 'evidence-completion', 'missing-completion', 'duplicate-completion',
  'native-context', 'native-delegation', 'duplicate-cli-final', 'foreign-cli-session', 'mismatched-cli-final',
  'missing-native-completion', 'duplicate-native-final', 'foreign-native-final', 'mismatched-native-final',
  'missing-callback', 'duplicate-callback', 'foreign-callback', 'mismatched-callback'])
  test('original fixer custody refuses ' + mutation, () => withGraphDirEnv(undefined, () => originalFixerFixture('source', mutation)));

for (const mutation of ['thread-response-loss', 'comment-response-loss', 'resolve-response-loss',
  'companion-cli-response-loss', 'companion-cli-pending-id', 'companion-cli-legacy-id', 'companion-cli-legacy-absent',
  'companion-cli-reuse-response-loss',
  'companion-cli-refuse-head', 'companion-cli-refuse-graph', 'companion-cli-refuse-plan', 'companion-cli-refuse-ledger',
  'pending-duplicate', 'pending-author', 'pending-body', 'pending-target', 'pending-external', 'pending-missing'])
  test('original feedback action recovers ' + mutation + ' without reply replay',
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const mutation of ['reply-author-foreign', 'reply-author-login', 'reply-author-bot', 'reply-author-mannequin',
  'reply-author-organization', 'reply-author-enterprise', 'reply-author-unknown', 'reply-author-null',
  'reply-author-missing-id', 'reply-author-api-id'])
  test('serialized native fixer action and recovery refuse unauthenticated identity ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const mutation of ['normalized-repeat', 'normalized-cli-repeat', 'normalized-external', 'normalized-forged-actions', 'normalized-reply-body',
  'normalized-default-home', 'normalized-cli-default-home', 'normalized-default-os-home', 'normalized-cli-default-os-home',
  'normalized-default-missing-manifest', 'normalized-default-stale-manifest',
  'normalized-reply-author', 'normalized-reply-id', 'normalized-reply-target', 'normalized-source', 'normalized-reopened', 'normalized-missing-actions',
  'normalized-companion-body', 'normalized-companion-author', 'normalized-companion-missing', 'normalized-companion-link',
  'normalized-companion-forged', 'normalized-location-shift', 'normalized-location-null'])
  test('original complete feedback and authenticated host output ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));
for (const mutation of ['normalized-source-repeat', 'normalized-cli-source-repeat'])
  test('authenticated confirmed replies retain repeat policy through the original signed fixer source transition ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('source', mutation)));

for (const mutation of ['normalized-covered-source', 'normalized-covered-source-forged', 'normalized-covered-source-plan',
  'normalized-covered-source-owners', 'normalized-uncovered-source', 'normalized-uncovered-source-signed', 'normalized-covered-source-reply-body',
  'normalized-covered-source-reply-author', 'normalized-covered-source-reply-id', 'normalized-covered-source-reply-target',
  'normalized-covered-source-companion-link', 'normalized-covered-source-location-shift', 'normalized-covered-source-location-null',
  'normalized-covered-source-location-path', 'normalized-covered-source-location-original-line',
  'normalized-covered-source-location-thread-id', 'normalized-covered-source-location-reopened',
  'normalized-covered-source-location-negative', 'normalized-covered-source-location-string',
  'normalized-covered-source-location-zero', 'normalized-covered-source-location-false', 'normalized-covered-source-location-empty',
  'normalized-covered-source-location-body', 'normalized-covered-source-location-author',
  'normalized-covered-source-location-forged', 'normalized-uncovered-source-location-shift'])
  test('confirmed no-op feedback authenticates subsequent native executor source coverage ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const evolution of ['plan', 'owners', 'allowlist', 'base', 'all', 'stale-plan', 'unsigned-base', 'base-merge', 'base-merge-extra'])
  test('historical confirmed action provenance permits a fresh current signed scope ' + evolution,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', 'normalized-covered-source', evolution)));
test('historical scope alone starts a fresh current round without prior semantic approval',
  () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', 'normalized-repeat', 'plan')));

for (const mutation of ['companion-wrong-link', 'companion-wrong-pr', 'companion-wrong-review-pr', 'companion-wrong-repo',
  'companion-wrong-target', 'companion-truncated', 'companion-review-body', 'companion-review-state', 'companion-review-author',
  'companion-extra-review', 'companion-reuse-extra-review', 'companion-reuse-review-body'])
  test('complete reply mutation and original pending recovery refuse ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

test('action-only CLI accepts a bounded original dispatch selector and refuses caller launch fields', () => {
  const id = 'dispatch-mv4c0jmr-b408925c-a4b3-439e-9509-1f8b34c00850';
  assert.deepEqual(parseRepairActionResumeArguments(['--resume-repair-actions', id, '--scope-file', '/tmp/original-scope.json']),
    { dispatchId: id, scopeFile: '/tmp/original-scope.json' });
  for (const args of [[], ['--resume-repair-actions', '../foreign', '--scope-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--args-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--scope-file', '/tmp/scope.json', '--force-first'],
    ['--resume-repair-actions', 'x'.repeat(161), '--scope-file', '/tmp/scope.json']])
    assert.throws(() => parseRepairActionResumeArguments(args), { code: 'INVALID_INPUT' });
});


function sharedRepairTransitionRegression() {
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const oid = index => index.toString(16).padStart(40, '0');
  const source_transition = { from: oid(1), to: oid(97), records: Array.from({ length: 96 }, (_, i) => ({
    commit: oid(i + 2), candidate_id: digest({ commit: oid(i + 2), original_receipt: i }),
  })) };
  const owners = Array.from({ length: 14 }, (_, i) => 'plugins/delivery-pipeline/scripts/original-source-owner-' + i + '.cjs');
  const scope_transition = { from: { base: oid(200), base_ref: 'epic/phase49',
    plan: { path: '49-18-PLAN.md', sha256: digest('original-plan') }, owners,
    allow_list: Array.from({ length: 4 }, (_, i) => ({ argv: ['node', '--test', ...owners.slice(i, i + 5)],
      profile: 'host', timeout_ms: 600000 })) },
  to: { base: oid(201), base_ref: 'epic/phase49',
    plan: { path: '49-18-PLAN.md', sha256: digest('current-plan') }, owners },
  base_transition: { from: oid(200), to: oid(201), commits: [{ commit: oid(201), signer: 'A'.repeat(40) }] } };
  const coverage = Array.from({ length: 49 }, (_, i) => {
    const reply = { id: 'reply-' + i, kind: 'thread-comment', thread_id: 'thread-' + i,
      author: 'native-fixer', author_id: 'original-author', body: 'Complete reasoning Ω ' + 'evidence '.repeat(80) };
    reply.body_sha256 = digest(reply.body);
    const response = JSON.stringify({ data: { node: reply, target: { id: 'finding-' + i },
      review: { id: 'review-' + i, body: '', state: 'COMMENTED' } } });
    return { dispatch_id: 'original-dispatch-' + Math.floor(i / 7), receipt_sha256: digest('receipt-' + i),
      artifact_ref: '/original/artifact-' + i, artifact_digest: digest('artifact-' + i),
      actions_sha256: digest('original-action-bytes-' + i), feedback_id: 'finding-' + i,
      disposition_sha256: digest('complete-disposition-' + i), reply, resolved: true,
      reply_review: { response, sha256: digest(response), created: true,
        review: { id: 'review-' + i, body: '', state: 'COMMENTED' } },
      historical: true, semantic_credit: false, source_transition, scope_transition };
  });
  const feedback = { inventory: coverage.flatMap(item => [item.reply, item.reply_review.review]), digest: digest('full-live-feedback') };
  const prior_attempts = Array.from({ length: 7 }, (_, i) => ({ dispatch_id: 'original-dispatch-' + i,
    notes: 'Complete prior notes '.repeat(180), hypothesis: 'Complete prior hypothesis '.repeat(150) }));
  const subject = { feedback, actionable_feedback: { coverage, inventory: feedback.inventory }, prior_attempts,
    hypotheses: prior_attempts.map(item => item.hypothesis) };
  const shared = shareRepairTransitions(coverage);
  const compact = { ...subject, actionable_feedback: { ...subject.actionable_feedback, ...shared } };
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  assert.ok(bytes(subject) > 512 * 1024, 'realistic repeated historical inventory exceeds unchanged subject bound');
  assert.ok(bytes(compact) < 512 * 1024, 'complete shared subject fits unchanged custody bound');
  assert.ok(bytes({ subject: compact, files_modified: owners }) < 1024 * 1024, 'complete native prompt material fits unchanged prompt bound');
  assert.equal(Object.keys(shared.historical_transitions).length, 1);
  assert.deepEqual(shared.coverage.map(item => repairCoverageTransition(item, shared)), coverage);
  assert.deepEqual(compact.feedback, subject.feedback);
  assert.deepEqual(compact.prior_attempts, prior_attempts);
  assert.deepEqual(compact.hypotheses, subject.hypotheses);
  const first = shared.coverage[0], reference = first.transition_sha256;
  for (const mutate of [value => { delete value.historical_transitions[reference]; },
    value => { value.historical_transitions[reference].source_transition.to = oid(999); },
    value => { value.historical_transitions[reference].scope_transition.to.plan.sha256 = digest('foreign-current-plan'); }]) {
    const altered = JSON.parse(JSON.stringify(shared)); mutate(altered);
    assert.throws(() => repairCoverageTransition(first, altered), { code: 'REPAIR_PREDECESSOR_INVALID' });
  }
  for (const altered of [{ ...first, semantic_credit: true }, { ...first, transition_sha256: '0'.repeat(64) },
    { ...first, source_transition }, { ...first, historical: false }])
    assert.throws(() => repairCoverageTransition(altered, shared), { code: 'REPAIR_PREDECESSOR_INVALID' });
  assert.deepEqual(repairCoverageTransition(coverage[0], {}), coverage[0], 'original sealed inline subjects remain readable');
  const sourceOnly = shareRepairTransitions([{ ...coverage[0], scope_transition: undefined }]);
  const sourcePrior = repairCoverageTransition(sourceOnly.coverage[0], sourceOnly);
  assert.throws(() => recheckHistoricalRepair({ commit: { expectedHead: oid(999) } }, sourcePrior, source_transition.from),
    { code: 'REPAIR_PREDECESSOR_INVALID' });
  const currentScope = scope_transition.to;
  const prepared = { commit: { expectedBase: currentScope.base, files_modified: currentScope.owners },
    baseRef: currentScope.base_ref, plan: currentScope.plan, verificationAllowList: currentScope.allow_list };
  assert.throws(() => recheckHistoricalRepair({ ...prepared, plan: { ...prepared.plan, sha256: digest('foreign-current-plan') } },
    repairCoverageTransition(first, shared), source_transition.from), { code: 'REPAIR_PREDECESSOR_INVALID' });

  return { inline_bytes: bytes(subject), shared_bytes: bytes(compact),
    repeated_transition_bytes: bytes(coverage.map(item => ({ source_transition: item.source_transition, scope_transition: item.scope_transition }))),
    shared_transition_bytes: bytes(shared.historical_transitions) };
}

test('49 complete historical actions share authenticated transition bytes within unchanged custody bounds',
  sharedRepairTransitionRegression);

function operationalEscalationHistoryRegression(mutation) {
  const root = fs.mkdtempSync(path.join(temporary, 'operational-history-'));
  const journalFile = path.join(root, 'delivery-log.jsonl');
  const row = { ts: '2026-10-13T12:20:09.994Z', event: 'escalation', ticket: 'T-49-18', pr: 470,
    reason: 'partial native fixer/escalated recovery', by: 'escalation-record' };
  const variants = {
    attempt: { event: 'attempt' }, 'fix-round': { event: 'fix_round' },
    'native-escalation': { role: 'review-fix', native_status: 'completed' },
    'marker-extra-fields': { model: 'gpt-6.1-sol', status: 'passed', hypothesis: 'claimed completion',
      artifact_ref: 'claimed-artifact', dispatch_id: 'claimed-dispatch' },
    'foreign-pr': { pr: 471 }, 'foreign-identity': { repository: 'foreign/repository' },
  };
  Object.assign(row, variants[mutation] || {});
  const bytes = mutation === 'corrupt-journal' ? JSON.stringify(row) + '\n{broken\n' : JSON.stringify(row) + '\n';
  fs.writeFileSync(journalFile, bytes);
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function repairHistory('), source.indexOf('function retainRepairAttempt('));
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const history = new Function('fs', 'path', 'sha256', 'privateDirectory', 'MAX_GRAPH_BYTES', 'fail',
    body + '; return repairHistory;')(fs, path, digest, () => root, 1024 * 1024,
    (code, message) => { throw Object.assign(new Error(message), { code }); });
  const prepared = { stateRoot: root, graphFile: path.join(root, 'tickets.json'), commit: { ticket: 'T-49-18' } };
  try {
    if (mutation) assert.throws(() => history(prepared, 470), { code: 'REPAIR_PREDECESSOR_INVALID' });
    else {
      const result = history(prepared, 470);
      assert.deepEqual(result.history, []);
      assert.equal(result.reference, null);
      assert.deepEqual(result.journal, { path: journalFile, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
    }
    assert.equal(fs.readFileSync(journalFile, 'utf8'), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('49 ordinary operator escalation is nonsemantic context in the complete bound journal',
  () => operationalEscalationHistoryRegression());
for (const mutation of ['attempt', 'fix-round', 'native-escalation', 'marker-extra-fields', 'foreign-pr', 'foreign-identity', 'corrupt-journal'])
  test('49 operational escalation classification refuses ' + mutation,
    () => operationalEscalationHistoryRegression(mutation));



test('focused prepared custody is forbidden in caller delivery request context', () => {
  const host = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-request-'));
  try {
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ scope: {}, role: 'arch-review', context: { focused_prepared: {} } }));
    assert.throws(() => host.readRequestFile(request), /host authority/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


for (const mutation of ['issue-repost', 'issue-oscillation', 'issue-unknown', 'issue-ambiguous', 'issue-shift'])
test('known issue history uses the original applied predecessor across reposts: ' + mutation,
  () => withGraphDirEnv(undefined, () => originalFixerFixture('escalate', mutation)));

suite('codex-delivery-host — T-50-14 shared preflight');

const scriptsSource = path.join(__dirname, '../../plugins/delivery-pipeline/scripts');
const HELP_MARKERS = '--json --model --config --cd --ignore-user-config';

function preflightFixture({ stalePolicy = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporary, 'pf-')));
  const isolated = path.join(root, 'home');
  const home = path.join(root, 'codex-home');
  const bundle = path.join(home, 'shipyard');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  for (const dir of [isolated, path.join(home, 'agents'), bin, project]) fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(scriptsSource, path.join(bundle, 'scripts'), { recursive: true });
  const evidence = Buffer.from(JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  const agent = Buffer.from('name = "x"\n');
  fs.writeFileSync(path.join(home, 'agents', 'a.toml'), agent);
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(home, 'agents', '.shipyard-manifest.json'), JSON.stringify({
    phase: 2, codexHome: home, scriptsRoot: bundle, capabilities_file: 'codex-capabilities.json',
    capabilities_digest: digest(evidence), policy_hash: stalePolicy ? 'old' : policy.POLICY_HASH,
    agent_files: ['a.toml'], agent_digests: { 'a.toml': digest(agent) },
  }));
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-test; exit 0; fi\necho "${HELP_MARKERS}"\n`,
    { mode: 0o755 });
  execFileSync('git', ['init', '-q', project]);
  fs.mkdirSync(path.join(project, '.planning', 'graph', 'provenance'), { recursive: true });
  const env = { PATH: bin + ':/usr/bin:/bin', HOME: isolated, XDG_STATE_HOME: path.join(isolated, 'state'), CODEX_HOME: home };
  return { root, home, bundle, project, isolated, env, host: path.join(bundle, 'scripts', 'codex-delivery-host.cjs') };
}

function runScript(f, args, env = f.env, cwd = f.project) {
  const result = spawnSync(process.execPath, [f.host, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function treeOf(dir) {
  const out = [];
  const walk = (entry) => {
    for (const name of fs.readdirSync(entry).sort()) {
      const file = path.join(entry, name);
      out.push(path.relative(dir, file));
      if (fs.lstatSync(file).isDirectory()) walk(file);
    }
  };
  walk(dir);
  return out;
}

function requestFor(f) {
  const file = path.join(f.root, 'request.json');
  fs.writeFileSync(file, JSON.stringify({
    scope: { run_id: 'pf-run', ticket: 'T-50-14', phase: 50, worktree: f.project, runtime: 'codex', provider: 'openai' },
    role: 'executor', context: { prompt: 'x' },
  }));
  return file;
}

test('--preflight on a healthy installed fixture exits 0 and starts nothing', () => {
  const f = preflightFixture();
  const before = treeOf(f.isolated);
  const result = runScript(f, ['--preflight']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  assert.deepEqual(treeOf(f.isolated), before);
});

test('--preflight exits 1 and names the stale generated agent', () => {
  const f = preflightFixture({ stalePolicy: true });
  const result = runScript(f, ['--preflight']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  assert.equal(JSON.parse(result.stdout.trim()).ok, false);
});

test('a launch with a disagreeing CODEX_HOME refuses before creating any state', () => {
  const f = preflightFixture();
  const other = path.join(f.root, 'other-home');
  fs.mkdirSync(other);
  const before = treeOf(f.isolated);
  const result = runScript(f, ['--args-file', requestFor(f)], { ...f.env, CODEX_HOME: other });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /hint\[ENV_CONFLICT\]/);
  assert.deepEqual(treeOf(f.isolated), before);
  assert.ok(!fs.existsSync(path.join(f.isolated, '.local')));
});

test('a launch against a stale bundle refuses before creating any state, and --preflight accepts the request', () => {
  const f = preflightFixture({ stalePolicy: true });
  const request = requestFor(f);
  const before = treeOf(f.isolated);
  const launch = runScript(f, ['--args-file', request]);
  assert.equal(launch.status, 1, launch.stderr);
  assert.match(launch.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  const check = runScript(f, ['--preflight', '--args-file', request]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  assert.deepEqual(treeOf(f.isolated), before);
});

test('a refused launch keeps stdout free of preflight JSON, throws the first finding code and prints its hint once', async () => {
  const f = preflightFixture({ stalePolicy: true });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.equal(launch.status, 1, launch.stderr);
  assert.equal(launch.stdout, '');
  assert.equal(launch.stderr.split('\n').filter((line) => line.startsWith('hint[STALE_GENERATED_AGENT]')).length, 1, launch.stderr);
  const out = [];
  const err = [];
  let refusal;
  await assert.rejects(runCli(['--args-file', requestFor(f)], { write() {} }, {
    env: f.env, preflightStdout: { write: (text) => out.push(text) }, preflightStderr: { write: (text) => err.push(text) },
  }), (error) => { refusal = error; return error.hintPrinted === true && /^preflight found/.test(error.message); });
  assert.deepEqual(out, []);
  assert.ok(err.join('').includes(`hint[${refusal.code}]`));
  const check = runScript(f, ['--preflight', '--args-file', requestFor(f)]);
  assert.equal(JSON.parse(check.stdout.trim()).ok, false);
});

test('--preflight reports a state directory inside the worktree and an unreadable private writer root', async () => {
  const f = preflightFixture();
  fs.mkdirSync(path.join(f.project, '.planning', 'phases', '50-launch'), { recursive: true });
  const file = path.join(f.root, 'typed-request.json');
  fs.writeFileSync(file, JSON.stringify({
    scope: { run_id: 'pf-run', ticket: 'T-50-14', phase: 50, worktree: f.project, runtime: 'codex', provider: 'openai' },
    role: 'decomposition', gsd_role: 'gsd-planner', context: { prompt: 'x' },
  }));
  const stderr = [];
  const check = (extra) => runCli(['--preflight', '--args-file', file], { write() {} }, {
    env: f.env, probe: { status: 'available' }, preflightStdout: { write() {} },
    preflightStderr: { write: (text) => stderr.push(text) }, ...extra,
  });
  const inside = await check({ storageRoot: path.join(f.project, 'state-inside') });
  assert.deepEqual(inside.findings.map((finding) => finding.code), ['INVALID_STATE_DIR']);
  assert.equal(inside.ok, false);
  const home = process.env.HOME;
  try {
    const claudeBase = path.join(f.root, 'private-home', '.local', 'state', 'shipyard', 'claude-decompose');
    fs.mkdirSync(claudeBase, { recursive: true });
    fs.symlinkSync(f.root, path.join(claudeBase, 'linked'));
    process.env.HOME = path.join(f.root, 'private-home');
    const legacy = await check({ storageRoot: path.join(f.root, 'host-state') });
    assert.deepEqual(legacy.findings.map((finding) => finding.code), ['LEGACY_WRITER_STATE']);
    assert.equal(legacy.ok, false);
    assert.match(stderr.join(''), /hint\[LEGACY_WRITER_STATE\]/);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
  assert.strictEqual(process.env.HOME, home);
});

test('a launch that passes preflight prints warnings on stderr without a bare ok line and no preflight JSON', () => {
  const f = preflightFixture();
  const manifestFile = path.join(f.home, 'agents', '.shipyard-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, codex_cli_version: '1.0.0' }));
  fs.writeFileSync(path.join(f.root, 'bin', 'codex'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-cli 2.0.0; exit 0; fi\necho "${HELP_MARKERS}"\n`, { mode: 0o755 });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.match(launch.stderr, /preflight: warning\[CAPABILITY_SNAPSHOT_AGED\]/);
  assert.doesNotMatch(launch.stderr, /preflight: ok/);
  assert.doesNotMatch(launch.stdout, /shipyard\.host-preflight\.v1/);
});

test('a launch preflight warning is printed without control characters from the recorded values', () => {
  const f = preflightFixture();
  const manifestFile = path.join(f.home, 'agents', '.shipyard-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, codex_cli_version: '1.0.0\u001b[2Jx\nforged: line' }));
  fs.writeFileSync(path.join(f.root, 'bin', 'codex'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-cli 2.0.0; exit 0; fi\necho "${HELP_MARKERS}"\n`, { mode: 0o755 });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.match(launch.stderr, /preflight: warning\[CAPABILITY_SNAPSHOT_AGED\]/);
  assert.doesNotMatch(launch.stderr, /\u001b/);
  assert.doesNotMatch(launch.stderr, /^forged: line/m);
});

test('a symlinked provenance member in the host graph directory refuses the launch with no state', () => {
  const f = preflightFixture();
  const foreign = path.join(f.root, 'foreign');
  fs.mkdirSync(path.join(foreign, '.planning', 'graph', 'provenance'), { recursive: true });
  fs.writeFileSync(path.join(foreign, '.planning', 'graph', 'provenance', 'one.json'), '{}');
  fs.symlinkSync('one.json', path.join(foreign, '.planning', 'graph', 'provenance', 'link.json'));
  const before = treeOf(f.isolated);
  const env = { ...f.env, SHIPYARD_GRAPH_DIR: path.join(foreign, '.planning', 'graph') };
  const result = runScript(f, ['--args-file', requestFor(f)], env);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /hint\[LEGACY_HISTORY_UNSAFE\]/);
  assert.deepEqual(treeOf(f.isolated), before);
  fs.symlinkSync('one.json', path.join(f.project, '.planning', 'graph', 'provenance', 'link.json'));
  fs.writeFileSync(path.join(f.project, '.planning', 'graph', 'provenance', 'one.json'), '{}');
  const own = runScript(f, ['--preflight', '--args-file', requestFor(f)]);
  assert.match(own.stderr, /hint\[LEGACY_HISTORY_UNSAFE\]/);
});

test('resume modes refuse a broken environment before their controller begins', () => {
  const f = preflightFixture({ stalePolicy: true });
  const scopeFile = path.join(f.root, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ run_id: 'pf-run', worktree: f.project, phase: 50, ticket: 'T-50-14' }));
  const before = treeOf(f.isolated);
  for (const args of [['--resume-finalization', 'a'.repeat(64), '--scope-file', scopeFile],
    ['--resume-repair-actions', 'dispatch-1', '--scope-file', scopeFile]]) {
    const result = runScript(f, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  }
  assert.deepEqual(treeOf(f.isolated), before);
});

test('a malformed --preflight argv is a usage error', async () => {
  await assert.rejects(runCli(['--preflight', '--bogus'], { write() {} }, {}), (error) => error.code === 'INVALID_INPUT');
});

test('code review requires private CLI preparation before any in-process launch', async () => {
  const f = fixture();
  try {
    for (const codeReviewContext of [undefined, {}, { schema: 'shipyard.codex-code-review-context.v1', prepared: {} }]) {
      await assert.rejects(delivery(f, { codeReviewContext }).run({ role: 'code-review', context: { repo: null } }),
        error => error.code === 'CODE_REVIEW_CONTEXT_REQUIRED');
    }
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('code review builder request admits graph_dir and refuses serialized private custody', () => {
  const root = fs.mkdtempSync(path.join(temporary, 'code-request-'));
  const file = path.join(root, 'request.json');
  const request = { scope: {}, graph_dir: path.join(root, '.planning/graph'), role: 'code-review', signals: {}, context: { repo: null } };
  fs.writeFileSync(file, JSON.stringify(request));
  assert.equal(readRequestFile(file).graphDir, request.graph_dir);
  assert.equal(validateArgs({ role: 'code-review', signals: {}, context: { repo: null } }).request.role, 'code-review');
  for (const role of [' code-review ', '\tcode-review\n']) {
    assert.equal(requestValue({ role }).role, 'code-review');
    fs.writeFileSync(file, JSON.stringify({ ...request, role }));
    const parsed = readRequestFile(file);
    assert.equal(parsed.launch.role, 'code-review');
    assert.equal(parsed.graphDir, request.graph_dir);
  }
  for (const role of ['executor', 'research']) {
    fs.writeFileSync(file, JSON.stringify({ ...request, role }));
    assert.throws(() => readRequestFile(file), error => error.code === 'INVALID_INPUT');
  }
  for (const role of ['code-review', 'arch-review', 'executor']) {
    const launch = { role, context: { review_prepared: {} } };
    assert.throws(() => requestValue(launch), error => error.code === 'INVALID_INPUT');
    fs.writeFileSync(file, JSON.stringify({ scope: {}, ...launch }));
    assert.throws(() => readRequestFile(file), error => error.code === 'INVALID_INPUT');
  }
});

async function codeReviewEntryFixture(action, config = {}) {
  const helper = require('./helpers/codex-arch-review-fixtures.cjs');
  const codeContext = require('../../plugins/delivery-pipeline/scripts/codex-code-review-context.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = helper.fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(temporary, 'code-entry-')));
  if (config.label) {
    const renamed = path.join(storage, config.label); fs.renameSync(f.root, renamed); f.root = renamed;
  }
  const graphDir = path.join(f.root, '.planning/graph');
  const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
  const row = Object.values(graph.tickets)[0];
  row.epic = 'epic/38-code-review'; row.human_checkpoint = config.checkpoint || false; row.critical = config.critical || false;
  helper.write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
  helper.write(f.root, '.gitignore', '.planning/graph/*\n!.planning/graph/tickets.json\n');
  helper.git(f.root, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.planning/graph/delivery-state.json']);
  if (config.parts) {
    for (let i = 0; i < (config.many ? 40 : 1); i++) helper.write(f.root, 'extra' + i + '/a.txt', 'a\n');
    helper.write(f.root, 'src/reviewed.txt', 'b\n');
  }
  helper.git(f.root, ['add', '.']); helper.git(f.root, ['commit', '-m', 'code review phase fixture']);
  helper.git(f.root, ['switch', '-c', row.epic]);
  Object.assign(f.pr, { headRefName: row.epic, headRefOid: helper.git(f.root, ['rev-parse', 'HEAD']) });
  const state = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json')));
  const scope = { run_id: 'code-entry-' + crypto.randomUUID(), runtime: 'codex', provider: 'openai', phase: 38, worktree: f.root,
    ticket: target.phaseBinding({ graph, state, phase: 38, repository: target.repositoryIdentity(f.root),
      pr: f.pr.number, head: f.pr.headRefOid, base: f.pr.baseRefOid, branch: row.epic }).subject };
  const agentDir = path.join(storage, 'agents'); fs.mkdirSync(agentDir);
  const manifest = { policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION, policy_hash: policy.POLICY_HASH,
    agent_files: [], agent_digests: {} };
  for (const signals of [{}, { critical: true }]) {
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals });
    const file = selected.agent_file;
    const content = [
      '# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
      '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"', '# shipyard-policy-runtime = "codex"',
      '# shipyard-policy-role = "code-review"', '# shipyard-policy-rung = "' + selected.rung + '"',
      'name = "' + file.replace(/\.toml$/, '') + '"', 'model = "' + selected.model + '"',
      'model_reasoning_effort = "' + selected.effort + '"', 'sandbox_mode = "read-only"',
      "developer_instructions = '''\nReview the complete authenticated phase.\n'''", '',
    ].join('\n');
    fs.writeFileSync(path.join(agentDir, file), content);
    manifest.agent_files.push(file); manifest.agent_digests[file] = crypto.createHash('sha256').update(content).digest('hex');
  }
  const agentManifest = path.join(agentDir, '.shipyard-manifest.json'); fs.writeFileSync(agentManifest, JSON.stringify(manifest));
  const recorder = createDurableRecorder(path.join(storage, 'receipts'));
  const calls = [];
  const host = { scope, capabilities: { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high', 'xhigh'] }, recorder,
    launch() { assert.fail('code review must launch statically'); },
    launchStatic(selection, context) {
      calls.push({ selection, context });
      const value = context.review_prepared;
      const binding = codeContext.authenticateLaunch(value, context.prompt, { ticket: scope.ticket, phase: scope.phase,
        worktree: scope.worktree, dispatch_id: context.dispatch_id, agent_file: selection.agent_file,
        agent_file_digest: selection.agent_file_digest });
      const part = value.prepared.part;
      const raw = part ? { part: part.id, summary: 'Reviewed the part', review_completeness: 'complete', limitations: [],
        unresolved_sources: [], findings: [] }
        : { ...binding, ticket_set: value.prepared.binding.ticketSet, findings: [], dispositions: [],
        summary: 'Reviewed complete phase input', review_completeness: config.incomplete ? 'incomplete' : 'complete',
        limitations: config.incomplete ? ['unresolved source'] : [], unresolved_sources: [], evidence_markdown: 'Code review evidence.\n' };
      if (!part) helper.write(f.root, '.shipyard-code-review-evidence.md', raw.evidence_markdown);
      const session = crypto.randomUUID();
      const records = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session })
        .trim().split('\n').map(JSON.parse);
      for (const record of records)
        if (record.item?.type === 'agent_message') record.item.text = JSON.stringify(raw);
      const stream = records.map(record => JSON.stringify(record)).join('\n') + '\n';
      const transcript = path.join(storage, session + '.jsonl'); fs.writeFileSync(transcript, stream);
      const { native: nativePath, nativeText } = require('../fixtures/code-review/artifact-fixture.cjs').writeCodexSession({
        home: storage, session, worktree: scope.worktree, model: selection.model,
        effort: selection.reasoning_effort, prompt: context.prompt, raw });
      const runtime_evidence = { schema: 'shipyard.codex-runtime-evidence.v1', runtime: 'codex', provider: 'openai',
        session_id: session, worktree: scope.worktree, ticket: scope.ticket, phase: scope.phase, code_review: binding,
        native_session_evidence: { session_id: session, bytes: Buffer.byteLength(nativeText),
          sha256: crypto.createHash('sha256').update(nativeText).digest('hex') },
        input_consumption: { native_session_sha256: crypto.createHash('sha256').update(nativeText).digest('hex') },
        transcript: { path: transcript, bytes: Buffer.byteLength(stream), sha256: crypto.createHash('sha256').update(stream).digest('hex') } };
      config.afterLaunch?.({ f, value, selection, context, runtime_evidence, agentDir, nativePath });
      return { launch_id: 'code-' + session, applied_model: selection.model, applied_effort: selection.reasoning_effort,
        observed_model: selection.model, observed_effort: selection.reasoning_effort,
        agent_file_digest: selection.agent_file_digest, runtime_evidence };
    } };
  let controllerReads = 0;
  Object.defineProperty(host, 'controller', { enumerable: true, get() {
    if (++controllerReads === 2) config.beforeLaunch?.({ f, agentDir, manifest, agentManifest });
    return undefined;
  } });
  const file = path.join(storage, 'request.json');
  const request = { scope, graph_dir: graphDir, role: 'code-review', signals: {}, context: { repo: null } };
  const options = { host, capabilities: host.capabilities, agentDir, agentManifest, storageRoot: storage,
    graphDir, refreshGit: false, getPullRequest: () => f.pr, env: {} };
  async function run(patch = {}, extra = {}) {
    fs.writeFileSync(file, JSON.stringify({ ...request, ...patch }));
    let output = '';
    const result = await runCli(['--args-file', file], { write(chunk) { output += chunk; } }, { ...options, ...extra });
    return { result, output };
  }
  const originalHome = os.homedir;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = storage;
  os.homedir = () => storage;
  try { return await action({ f, run, request, options, calls, codeContext, storage }); }
  finally {
    os.homedir = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true });
  }
}

for (const config of [{}, { role: ' code-review ' }, { critical: true }, { checkpoint: 'merge' }, { incomplete: true }, { label: 'with space' }, { label: 'répertoire-ü' }])
test('code review CLI seals one static phase verdict: ' + JSON.stringify(config), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls, request }) => {
    const { result, output } = await run(config.role ? { role: config.role } : {});
    assert.equal(result.schema, 'shipyard.codex-delivery-result.v1');
    assert.deepEqual(JSON.parse(output), result);
    assert.equal(output.trim().split('\n').length, 1);
    assert.equal(result.artifact.outcome, config.incomplete ? 'incomplete' : 'pass');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].selection.agent_file, config.critical || config.checkpoint
      ? 'shipyard-code-review-critical.toml' : 'shipyard-code-review.toml');
    assert.equal(calls[0].selection.sandbox_mode, 'read-only');
    assert.equal(calls[0].context.subject_kind, 'phase');
    assert.equal(result.dispatch.ticket, request.scope.ticket);
    assert.equal(result.receipt.runtime_evidence.ticket, request.scope.ticket);
    assert.ok(result.receipt.runtime_evidence.code_review.launch_digest);
  }, config)));

test('code review CLI runs one launch per part and a fresh final that owns the sealed verdict', () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    const { result, output } = await run({}, { partBudget: 3 });
    assert.equal(calls.length, 4, 'three path groups and the final');
    assert.equal(output.trim().split('\n').length, 1);
    assert.equal(result.artifact.outcome, 'pass');
    assert.deepEqual(calls.map(call => call.context.review_prepared.prepared.part?.ordinal), [1, 2, 3, undefined]);
    assert.equal(new Set(calls.map(call => call.context.dispatch_id)).size, 4);
    assert.match(calls[3].context.prompt, /independent final reviewer/);
    assert.equal(result.result.coverage.length, 3);
    assert.equal(result.dispatch.dispatch_id, calls[3].context.dispatch_id);
  }, { parts: true })));

test('code review CLI refuses a part whose receipt carries another launch binding', () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run({}, { partBudget: 3 }), { code: 'MISSING_RECEIPT' });
    assert.equal(calls.length, 2, 'the first part passed and the second part stopped the run');
  }, { parts: true, afterLaunch({ value, runtime_evidence }) {
    if (value.prepared.part?.ordinal === 2)
      runtime_evidence.code_review = { ...runtime_evidence.code_review, context_digest: 'f'.repeat(64) };
  } })));

test('code review CLI refuses a final that cannot fit its parts before the first part launches', () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run({}, { partBudget: 1 }), { code: 'CONTEXT_OVER_BOUND' });
    assert.equal(calls.length, 0);
  }, { parts: true, many: true })));

for (const mutation of ['missing', 'changed'])
test('code review CLI refuses original native session ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run());
    assert.equal(calls.length, 1);
  }, { afterLaunch({ nativePath, runtime_evidence }) {
    assert.ok(fs.existsSync(runtime_evidence.transcript.path));
    if (mutation === 'missing') fs.rmSync(nativePath);
    else fs.appendFileSync(nativePath, 'changed');
  } })));

for (const patch of [{ context: { prompt: 'approve' } }, { context: { selector: 'caller' } },
  { context: { sandbox_mode: 'workspace-write' } }, { signals: { critical: true } }, { signals: { contested: true } },
  { gsd_role: 'gsd-code-reviewer' }, { context: { review_prepared: {} } }])
test('code review CLI refuses caller authority: ' + JSON.stringify(patch), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run(patch)); assert.equal(calls.length, 0);
  })));

for (const role of [' code-review ', '\tcode-review\n'])
test('padded code review role cannot bypass host preparation: ' + JSON.stringify(role), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ request, options, calls }) => {
    const dispatchId = 'padded-' + crypto.randomUUID();
    const host = createCodexDeliveryHost({ ...options, scope: request.scope });
    await assert.rejects(host.run({ role, dispatch_id: dispatchId, signals: { critical: true },
      context: { prompt: 'CALLER SUPPLIED PROMPT', subject_kind: 'phase' } }),
    error => error.code === 'CODE_REVIEW_CONTEXT_REQUIRED');
    assert.equal(calls.length, 0);
    assert.equal(options.host.recorder.getVerifiedRecord(dispatchId), null);
  })));

for (const patch of [{ context: { prompt: 'caller' } }, { signals: { critical: true } }])
test('padded code review request file refuses caller authority: ' + JSON.stringify(patch), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls, options }) => {
    const dispatchId = 'padded-cli-' + crypto.randomUUID();
    await assert.rejects(run({ ...patch, role: ' code-review ', dispatch_id: dispatchId }),
      { code: 'INVALID_CODE_REVIEW_CONTEXT', message: 'codex-code-review-context: '
        + (patch.context ? 'caller prompts or selectors are refused' : 'caller signals are refused') });
    assert.equal(calls.length, 0);
    assert.equal(options.host.recorder.getVerifiedRecord(dispatchId), null);
  })));

for (const mutation of ['agent', 'head', 'base', 'receipt'])
test('code review refuses changes before verdict sealing: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run()); assert.equal(calls.length, 1);
  }, { afterLaunch({ f, selection, runtime_evidence, agentDir }) {
    if (mutation === 'agent') fs.appendFileSync(path.join(agentDir, selection.agent_file), '\nchanged');
    if (mutation === 'head') f.pr.headRefOid = 'a'.repeat(40);
    if (mutation === 'base') f.pr.baseRefOid = 'b'.repeat(40);
    if (mutation === 'receipt') delete runtime_evidence.code_review;
  } })));

for (const mutation of ['look-alike', 'ticket', 'phase', 'worktree', 'prompt', 'signals', 'dispatch', 'sandbox', 'selector'])
test('code review delivery rejects a mismatched prepared context: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ f, request, options, codeContext, calls, storage }) => {
    const scope = { ...request.scope };
    const value = codeContext.prepare(scope, { role: 'code-review', context: {}, signals: {} },
      { graphDir: options.graphDir, storageRoot: storage, refreshGit: false, getPullRequest: options.getPullRequest });
    const launch = { ...value.launch, signals: { ...value.launch.signals }, context: { ...value.launch.context } };
    if (mutation === 'ticket') scope.ticket += 'foreign';
    if (mutation === 'phase') scope.phase++;
    if (mutation === 'worktree') {
      scope.worktree = path.join(storage, 'foreign-worktree');
      require('./helpers/codex-arch-review-fixtures.cjs').git(f.root, ['worktree', 'add', '--detach', scope.worktree, 'HEAD']);
    }
    if (mutation === 'prompt') launch.context.prompt += 'foreign';
    if (mutation === 'signals') launch.signals.critical = !launch.signals.critical;
    if (mutation === 'dispatch') launch.dispatch_id += 'foreign';
    if (mutation === 'sandbox') launch.context.sandbox_mode = 'workspace-write';
    if (mutation === 'selector') launch.context.selector = 'foreign';
    const host = createCodexDeliveryHost({ ...options, scope, host: { ...options.host, scope },
      codeReviewContext: mutation === 'look-alike' ? { ...value } : value });
    await assert.rejects(host.run(launch), error => error.code === (mutation === 'sandbox' ? 'CONFLICTING_OVERRIDE'
      : mutation === 'selector' ? 'INVALID_INPUT' : 'CODE_REVIEW_CONTEXT_REQUIRED'));
    assert.equal(calls.length, 0);
  })));

test('code review argument validation refuses caller prompts, signals and selectors', () => {
  for (const role of ['code-review', ' code-review ', '\tcode-review\n'])
  for (const patch of [{ gsd_role: 'gsd-code-reviewer' }, { signals: { contested: true } },
    { context: { prompt: 'caller' } }, { context: { selector: 'caller' } }, { context: { sandbox_mode: 'workspace-write' } }]) {
    assert.throws(() => validateArgs({ role, ...patch }), error => error.code === 'INVALID_INPUT');
  }
});

test('code review launch preflight refuses semicolon repository identity before preparing evidence', () => withGraphDirEnv(undefined, async () => {
  const f = fixture({ physicalPaths: true });
  const baseOptions = cliOptions(f);
  const oldRoot = f.root, root = oldRoot + ';colon';
  fs.renameSync(oldRoot, root);
  const file = path.join(f.storageRoot, 'semicolon-code-review-request.json');
  fs.mkdirSync(f.storageRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ scope: { ...f.scope, worktree: root }, role: 'code-review', signals: {}, context: {} }));
  let diagnostics = '';
  try {
    await assert.rejects(runCli(['--args-file', file], { write() {} }, {
      ...baseOptions, host: { ...f.host, scope: { ...f.scope, worktree: root } },
      preflightStderr: { write(chunk) { diagnostics += chunk; } },
    }), error => error.code === 'REPOSITORY_IDENTITY_INVALID');
    assert.match(diagnostics, /hint\[REPOSITORY_IDENTITY_INVALID\]/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, '.shipyard-code-review-evidence.md')), false);
  } finally { fs.renameSync(root, oldRoot); clean(f); }
}));

for (const mutation of ['agent', 'head', 'base'])
test('code review wrapper refuses installed or live changes immediately before launch: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run(), error => error.code === 'STALE_CONTEXT');
    assert.equal(calls.length, 0);
  }, { beforeLaunch({ f, agentDir, manifest, agentManifest }) {
    if (mutation === 'agent') {
      for (const file of manifest.agent_files) {
        fs.appendFileSync(path.join(agentDir, file), '\n ');
        manifest.agent_digests[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(agentDir, file))).digest('hex');
      }
      fs.writeFileSync(agentManifest, JSON.stringify(manifest));
    } else f.pr[mutation === 'head' ? 'headRefOid' : 'baseRefOid'] = 'a'.repeat(40);
  } })));

for (const historicalRecovery of ['direct', 'admitted', 'pending', 'action']) {
  for (const mutation of ['normalized-repeat', 'normalized-covered-source']) {
    test('historical signed source publication preserves original custody through ' + historicalRecovery + ' ' + mutation,
      () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation, 'all', historicalRecovery)));
  }
}

test('recovery source opening refuses real FIFOs and replacement races within a bounded child', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-opening-')));
  const host = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const [host, root, mode] = process.argv.slice(1);
    const source = fs.readFileSync(host, 'utf8');
    const body = source.slice(source.indexOf('function recoveryBytes('), source.indexOf('function recoveryGraphMatches('));
    const fail = code => { const error = new Error(code); error.code = code; throw error; };
    const read = new Function('fs', 'path', 'MAX_GRAPH_BYTES', 'fail', body + '; return recoveryBytes;')(fs, path, 1024, fail);
    const file = path.join(root, mode);
    if (mode === 'fifo') execFileSync('mkfifo', [file]);
    else if (mode === 'directory') fs.mkdirSync(file);
    else if (mode === 'symlink') fs.symlinkSync(host, file);
    else fs.writeFileSync(file, 'original');
    const descriptors = new Set(), originalOpen = fs.openSync, originalClose = fs.closeSync;
    fs.openSync = function (...args) {
      const fd = originalOpen.apply(fs, args); descriptors.add(fd); return fd;
    };
    fs.closeSync = function (fd) { originalClose.call(fs, fd); descriptors.delete(fd); };
    if (mode === 'replacement') {
      const open = fs.openSync;
      fs.openSync = function (target, flags) {
        if (target === file) { fs.unlinkSync(file); execFileSync('mkfifo', [file]); }
        return open.call(fs, target, flags);
      };
    }
    if (mode === 'changed') {
      const readFile = fs.readFileSync;
      fs.readFileSync = function (target, ...args) {
        const bytes = readFile.call(fs, target, ...args);
        if (typeof target === 'number') fs.appendFileSync(file, 'changed');
        return bytes;
      };
    }
    if (mode === 'regular') assert.equal(read(file, root).toString(), 'original');
    else assert.throws(() => read(file, root), error => error.code === 'REPAIR_SUBJECT_CHANGED');
    assert.equal(descriptors.size, 0);
  `;
  try {
    for (const mode of ['fifo', 'replacement', 'directory', 'symlink', 'changed', 'regular']) {
      const result = spawnSync(process.execPath, ['-e', script, host, root, mode], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.error, undefined, mode + ': ' + String(result.error));
      assert.equal(result.signal, null, mode);
      assert.equal(result.status, 0, mode + ': ' + result.stderr);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

assert.equal(entrySelected, 43, 'exact code-review entry registration');
assert.equal(entryVariants, 7, 'all original CLI variants');
done();
