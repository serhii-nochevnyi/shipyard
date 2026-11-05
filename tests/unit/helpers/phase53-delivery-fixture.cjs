'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodeOs = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');
const { createRequire } = require('node:module');
const UNIT = path.resolve(__dirname, '..');
const unitRequire = createRequire(path.join(UNIT, 'codex-delivery-host.test.cjs'));

function createDeliveryFixture(options = {}) {
  const __dirname = UNIT;
  const os = options.tmpdir ? { ...nodeOs, tmpdir: () => options.tmpdir } : nodeOs;
  const temporary = options.temporary, signer = options.signer;
  const require = options.scripts ? Object.assign(request =>
    request.startsWith('../../plugins/delivery-pipeline/scripts/')
      ? unitRequire(path.join(options.scripts, path.basename(request))) : unitRequire(request),
    { resolve: request => request.startsWith('../../plugins/delivery-pipeline/scripts/')
      ? unitRequire.resolve(path.join(options.scripts, path.basename(request))) : unitRequire.resolve(request) }) : unitRequire;
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
const finalizerFile = options.scripts ? path.join(options.scripts, 'delivery-commit-finalizer.cjs')
  : path.join(__dirname, '../../plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs');
const finalizeCommit = options.finalizeCommit || require(fs.existsSync(finalizerFile)
  ? finalizerFile : process.env.SHIPYARD_T38_FINALIZER_FILE).finalizeDeliveryCommit;

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
        last_agent_message: JSON.stringify({ schema: 'shipyard.codex-decompose-output.v1', artifact_paths: [] }) });
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

function approvedPlan(f, commands) {
  fs.writeFileSync(f.plan, '# approved plan\n\n## Verification commands\n\n'
    + commands.map((command) => '- `' + command + '`\n').join('') + '\n## Next\n\n- `node --bogus`\n');
  fs.writeFileSync(path.join(f.project, '.planning', 'config.json'), JSON.stringify({
    delivery_pipeline: { verification_commands: { default: commands
      .filter((command) => /^(node|bash|make)\s/.test(command))
      .map((command) => ({ argv: command.split(' '), profile: 'sandbox' })) } },
  }));
}

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

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>/g, (token) => values[token] || token))
    .join('\n') + '\n';
}

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
  if (config.partitioned) helper.write(f.root, 'src/reviewed.txt', ('large line ' + 'x'.repeat(240) + '\n').repeat(5000));
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
  let launchMutationApplied = false;
  const native = require('../fixtures/phase53/code-review-native-driver.cjs').semanticNativeDriver({
    runtime: 'codex', worktree: f.root, storageRoot: storage, agentDir, agentManifest,
    controls: {
      result(result) {
        if (config.incomplete) {
          result.completeness = 'incomplete'; result.outcome = 'human-review-required';
          result.limitations = ['unresolved source'];
        }
      },
      afterNative(launch) {
        if (!launchMutationApplied) {
          launchMutationApplied = true;
          config.afterLaunch?.({ f, launch, agentDir, recorder });
        }
      },
    },
  });
  const calls = native.launches;
  const host = { scope, capabilities: { supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high', 'xhigh'] }, recorder,
    launch() { assert.fail('code review must use authenticated semantic child hosts'); } };
  let recorderReads = 0;
  Object.defineProperty(host, 'recorder', { enumerable: true, get() {
    if (++recorderReads === 2) config.beforeLaunch?.({ f, agentDir, manifest, agentManifest });
    return recorder;
  } });
  const file = path.join(storage, 'request.json');
  const request = { scope, graph_dir: graphDir, role: 'code-review', signals: {}, context: { repo: null } };
  const options = { host, capabilities: host.capabilities, agentDir, agentManifest, storageRoot: storage,
    graphDir, refreshGit: false, getPullRequest: () => f.pr, env: {}, spawn: native.spawn,
    probe: { status: 'available', executable: 'codex-fixture', runtime_version: native.runtimeVersion, capabilities: host.capabilities } };
  async function run(patch = {}, extra = {}) {
    fs.writeFileSync(file, JSON.stringify({ ...request, ...patch }));
    let output = '';
    const result = await runCli(['--args-file', file], { write(chunk) { output += chunk; } }, { ...options, ...extra });
    return { result, output };
  }
  const originalHome = os.homedir;
  const originalReadFile = fs.readFileSync;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = storage;
  os.homedir = () => storage;
  try { return await action({ f, run, request, options, calls, codeContext, storage }); }
  finally {
    os.homedir = originalHome;
    fs.readFileSync = originalReadFile;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true });
  }
}

function codexPartitionHelpers() {
  const Module = require('node:module'), file = require.resolve('./phase49-incremental-integration.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'node:test' ? { test() {} } : original.call(this, name, ...args); };
  try {
    loaded._compile(fs.readFileSync(file, 'utf8')
      + '\nmodule.exports = { fixture, projectOptions, agent, commit, write, successfulReview, template, parent, cli, serialize, currentPartitionConsumer, publicIntegrationFixture, publicPartitionFixture };\n', file);
  } finally { Module._load = original; }
  return loaded.exports;
}

function codexPartitionFixture(f, helper, controls = {}) {
  const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const native = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const complete = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
    .prepareNativeIntegratorContext(helper.projectOptions(f), { worktree: f.worktree, phase: '49',
      review_contract: roleArtifacts.INTEGRATION_REVIEW_V3 });
  const a = helper.agent(f, 'integrator', complete.signals);
  const frameRows = () => {
    const meta = helper.template(helper.parent, row => row.type === 'session_meta');
    const context = helper.template(helper.parent, row => row.type === 'turn_context');
    Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort, cwd: f.worktree, workspace_roots: [f.worktree] });
    context.payload.sandbox_policy.type = 'read-only';
    Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
    const developer = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.role === 'developer');
    developer.payload.content = [{ type: 'input_text', text: native.generatedInstructions(a.text) }];
    return { meta, context, developer };
  };
  const directory = path.join(f.root, 'codex-behavior-only-capacity'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retain = proof => {
    const raw = stable({ ...proof, behavior_only: true }), file = path.join(directory, digest(raw) + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, raw, { mode: 0o600 });
    return { path: file, bytes: Buffer.byteLength(raw), sha256: digest(raw) };
  };
  const capacity = { max_input_bytes: 8 * 1024 * 1024, unit_input_bytes: 256 * 1024, segment_bytes: 16 * 1024,
    output_reserve_tokens: 32000, tool_reserve_tokens: 10000,
    output_limits: { conclusions: 1024, findings: 2048, limitations: 1024, required_context: 1024, seams: 16384 },
    recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'native-exact' } };
  const resources = { capacity, counterSource: 'codex-behavior-only-counter', windowSource: 'codex-behavior-only-window',
    renderLaunch(launch) {
      controls.render?.(launch);
      const { meta, context, developer } = frameRows(), { turn_id, ...framing } = context.payload;
      const frame = { developers: [{ role: developer.payload.role, content: developer.payload.content }], other_users: [],
        base_instructions: meta.payload.base_instructions || null, contexts: [framing] };
      const request = { schema: 'shipyard.integration-native-request.v1', runtime: 'codex', model: launch.model,
        effort: launch.effort, input: launch.input, instruction_sha256: launch.instruction_sha256,
        recipe_sha256: digest(stable(capacity.recipe)), frame, tools: [],
        native_payload: stable({ frame, tools: [], input: launch.input, model: launch.model, effort: launch.effort }) };
      controls.mutate?.(request, 'request', launch);
      return request;
    },
    readWindow(identity) {
      if (controls.noWindow) throw new Error('fixture window unavailable');
      const proof = { schema: 'shipyard.integration-runtime-window.v1', ...identity,
        source: 'codex-behavior-only-window', evidence_id: 'codex-behavior-only-window', window_tokens: 100000000 };
      controls.mutate?.(proof, 'window');
      return retain(proof);
    },
    measureInput(request, identity) {
      const payload = JSON.parse(request.input.match(/<AUTHENTICATED_INTEGRATION_PARTITION>\s*([\s\S]*?)\s*<\/AUTHENTICATED_INTEGRATION_PARTITION>/)[1]);
      (controls.measured ||= []).push(payload);
      const proof = { schema: 'shipyard.integration-input-measurement.v1', ...identity, runtime: 'codex', model: request.model,
        source: 'codex-behavior-only-counter', evidence_id: 'codex-behavior-only-count-' + identity.launch_sha256,
        input_tokens_upper_bound: 1000 };
      controls.mutate?.(proof, 'measurement', payload);
      return retain(proof);
    } };
  const options = { ...helper.projectOptions(f), scope: { worktree: f.worktree, phase: 49,
    repository: complete.canonical.commonPath, ticket: complete.ticket, run_id: 'public-codex-v3-' + ++f.count },
    storageRoot: path.join(f.root, 'public-codex-v3-' + f.count), agentDir: a.dir, agentManifest: a.manifest,
    capabilities: a.capabilities, env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
    probe: { status: 'available', executable: 'codex-fixture', runtime_version: 'fixture', capabilities: a.capabilities },
    integrationCapacity: resources,
    spawn(_file, _args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
      let input = '';
      child.stdin = { write(raw) { input += raw; }, end() { process.nextTick(() => {
        try {
          input = input.replace(/\n$/, '');
          const wire = input, readRows = [];
          assert.ok(wire.length <= 1048576, 'actual native CLI physical character ceiling');
          if (/^INPUT_MANIFEST=/m.test(wire)) {
            const manifestPath = /^INPUT_MANIFEST=(.+)$/m.exec(wire)[1];
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const bundle = { manifest_path: manifestPath, chunk_bytes: manifest.chunk_bytes };
            const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
            const material = manifest.assets.map(asset => fs.readFileSync(asset.path));
            const reads = collector.integrationTextReads(bundle, { manifest, manifest_bytes: fs.readFileSync(manifestPath), material });
            assert.equal(/^MANIFEST_READ=(.+)$/m.exec(wire)?.[1], reads[0].command,
              'actual relay and native verifier prescribe the same first manifest command');
            for (const read of reads) {
              const call = 'integration-read-' + readRows.length;
              const output = require('node:child_process').execSync(read.command, { maxBuffer: 252 * 1024 });
              assert.deepEqual(output, read.bytes);
              const invocation = helper.template(helper.parent, row => row.payload?.type === 'function_call');
              Object.assign(invocation.payload, { name: 'exec_command', call_id: call,
                arguments: JSON.stringify({ cmd: read.command, max_output_tokens: 10000 }) });
              delete invocation.payload.namespace;
              const response = helper.template(helper.parent, row => row.payload?.type === 'function_call_output');
              Object.assign(response.payload, { call_id: call,
                output: JSON.stringify({ exit_code: 0, output: output.toString('utf8') }) });
              readRows.push(invocation, response);
            }
            input = Buffer.concat(material).toString('utf8');
          }
          const payload = JSON.parse(input.match(/<AUTHENTICATED_INTEGRATION_PARTITION>\s*([\s\S]*?)\s*<\/AUTHENTICATED_INTEGRATION_PARTITION>/)[1]);
          (controls.launches ||= []).push({ input, payload, wire, readRows });
          controls.onLaunch?.(input, payload, wire, readRows);
          const identity = payload.reviewed_identity, assignment = payload.assignment;
          const result = { review_contract: roleArtifacts.INTEGRATION_REVIEW_V3, kind: payload.kind, runtime: 'codex',
            subject: payload.subject, plan_sha256: payload.plan_sha256, input_sha256: digest(input), reviewed_identity: identity,
            completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], evidence_markdown: 'Original Codex fixture evidence; behavior only.' };
          if (payload.kind === 'unit') Object.assign(result, { schema: 'shipyard.integration-unit-result.v1', unit_id: assignment.unit_id,
            coverage: { primary_segments: assignment.primary_segments, primary_obligation_ids: assignment.primary_obligation_ids,
              support_segments: assignment.support_segments, support_obligation_ids: assignment.support_obligation_ids },
            conclusions: ['All exact primary fixture bytes and obligations evaluated.'], limitations: [], required_context: [],
            seams: assignment.seam_ids.map(id => ({ id, disposition: 'unresolved', rationale: 'Final must independently judge the interaction.' })) });
          else Object.assign(result, { phase: identity.phase, head: identity.head, head_tree: identity.head_tree,
            base: identity.base_ref.replace(new RegExp('^refs/remotes/'), ''), base_tree: identity.base_tree,
            ticket_set: identity.ticket_set, ticket_set_digest: identity.ticket_set_digest, summary: 'Separate Codex fixture final.',
            coverage: { ...payload.coverage, limitations: [], seam_dispositions: payload.seams.map(seam => ({
              id: seam.id, disposition: 'resolved', rationale: 'Independent fixture final judged complete acceptance and this seam.' })) } });
          controls.result?.(result, payload);
          const session = crypto.randomUUID(), text = JSON.stringify(result), { meta, context, developer } = frameRows();
          Object.assign(meta.payload, { id: session, session_id: session, cwd: f.worktree, runtime_workspace_roots: [f.worktree] });
          const start = helper.template(helper.parent, row => row.payload?.type === 'task_started'), turn = start.payload.turn_id;
          context.payload.turn_id = turn;
          const user = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.role === 'user');
          user.payload.content = [{ type: 'input_text', text: wire }];
          const final = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.phase === 'final_answer');
          final.payload.content.forEach(block => { block.text = text; }); final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
          const completion = helper.template(helper.parent, row => row.payload?.type === 'task_complete');
          Object.assign(completion.payload, { turn_id: turn, last_agent_message: text });
          for (const row of readRows) row.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
          const rows = [meta, context, start, developer, user, ...readRows,
            helper.template(helper.parent, row => row.payload?.type === 'token_count'), final, completion];
          controls.native?.(rows);
          const now = new Date(), root = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
          fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, session + '.jsonl'), helper.serialize(rows));
          const cli = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
            .map(type => helper.template(helper.cli, row => row.type === type));
          cli[0].thread_id = session; cli[2].item.text = text;
          child.stdout.emit('data', Buffer.from(helper.serialize(cli))); child.emit('close', 0);
        } catch (error) { child.emit('error', error); }
      }); } };
      return child;
    } };
  return { options, resources, controls };
}

return { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, scriptsRoot: options.scripts || path.resolve(UNIT, '../../plugins/delivery-pipeline/scripts'), git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname };
}

function createDeliveryLifecycle(options = {}) {
  let temporary, previousEnv, disposableGpgHome, context, closed = false;
  function cleanup() {
    if (!temporary || closed) return;
    closed = true;
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
      process.removeListener('exit', cleanup);
    }
  }
  function start() {
    if (context || closed || temporary) throw new Error('delivery fixture lifecycle already started');
    previousEnv = Object.fromEntries(['HOME', 'CODEX_HOME', 'GNUPGHOME', 'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM', 'SHIPYARD_COVERAGE_ROOT'].map(key => [key, process.env[key]]));
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scds-')));
    disposableGpgHome = path.join(temporary, 'gnupg');
    process.env.HOME = path.join(temporary, 'home');
    process.env.CODEX_HOME = path.join(process.env.HOME, '.codex');
    process.env.GNUPGHOME = disposableGpgHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(temporary, 'empty-gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.SHIPYARD_COVERAGE_ROOT = path.join(temporary, 'coverage');
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.mkdirSync(disposableGpgHome, { mode: 0o700 });
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    process.on('exit', cleanup);
    try {
      execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
        'Delivery Test <delivery@example.test>', 'ed25519', 'sign', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const signer = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
      context = createDeliveryFixture({ ...options, temporary, signer });
      return context;
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  return { start, cleanup };
}

module.exports = { createDeliveryFixture, createDeliveryLifecycle };
