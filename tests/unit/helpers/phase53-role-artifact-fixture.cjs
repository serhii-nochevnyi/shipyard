'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

function createRoleArtifactFixture(context) {
  const { require, module, unitDir: __dirname, scriptsDir, assert, lifecycle } = context;
  if (![path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts'),
    path.resolve(__dirname, '../../plugins/shipyard/host/plugins/delivery-pipeline/scripts')].includes(scriptsDir))
    throw new Error('role fixture script root differs from its explicit unit root');
  const { testAuthorityArgs, targetBin } = lifecycle;
  const codexJudgmentFixtures = require('./helpers/codex-arch-review-fixtures.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');

const {
  CLAUDE_MODEL_ALIASES,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

const {
  createDispatchBoundary,
  createDurableRecorder,
} = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');

const {
  registerClaudeWorkflowHost,
} = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');

const {
  NEUTRAL_PR_BODY_GUIDE,
} = require('../../plugins/delivery-pipeline/scripts/pr-hygiene.cjs');

const ROLE_ARTIFACT = path.join(scriptsDir, 'role-artifact.cjs');

const roleArtifact = require(ROLE_ARTIFACT);

const CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.sonnet],
  supportedEfforts: ['medium'],
  observedModel: true,
  observedEffort: true,
});

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

const SHIPYARD_MANIFEST_RELATIVE = 'plugins/delivery-pipeline/.claude-plugin/plugin.json';

function writeShipyardManifest(root) {
  const file = path.join(root, ...SHIPYARD_MANIFEST_RELATIVE.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: 'shipyard' }));
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-role-artifact-'));
  const receipts = path.join(root, 'receipts');
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'role-artifact@example.test']);
  git(root, ['config', 'user.name', 'Role Artifact Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  const baseFiles = ['tracked.txt'];
  if (options.exempt !== false) {
    writeShipyardManifest(root);
    baseFiles.push(SHIPYARD_MANIFEST_RELATIVE);
  }
  git(root, ['add', ...baseFiles]);
  git(root, ['commit', '--quiet', '-m', 'fixture base']);

  const ticket = options.ticket || 'T-33-artifact';
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  if (options.uncommittedManifest) writeShipyardManifest(root);
  const recorder = createDurableRecorder(receipts);
  const evidence = new WeakMap();
  let agentResult;
  const host = registerClaudeWorkflowHost({
    agent: async (_prompt, launchOptions) => {
      fs.writeFileSync(
        path.join(root, '.shipyard-pr-body.md'),
        options.prBody === undefined ? `Ticket: ${ticket}\n\nProblem\n\nScope\n` : options.prBody,
      );
      fs.writeFileSync(path.join(root, '.shipyard-evidence.md'), 'node tests/unit/role-artifact.test.cjs\n\ncomplete evidence\n');
      fs.writeFileSync(path.join(root, 'implemented.txt'), 'implemented\n');
      git(root, ['add', 'implemented.txt']);
      git(root, ['commit', '--quiet', '-m', `feat(${ticket}): fixture implementation`]);
      agentResult = {
        id: ticket,
        status: options.status || 'committed',
        summary: options.summary || 'executor completed',
        actionable_delta: options.actionableDelta,
        blocking_count: options.blockingCount === undefined ? 0 : options.blockingCount,
        ...(options.forgedReceipt ? { receipt: { dispatch_id: 'agent-forged' } } : {}),
      };
      evidence.set(agentResult, transcriptEvidence({
        launch_id: `role-artifact-${ticket}`,
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      }));
      return agentResult;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: CAPABILITIES,
    recorder,
    applicationEvidence: ({ result }) => evidence.get(result),
  });
  const args = {
    tickets: [{
      id: ticket,
      title: 'artifact fixture',
      planPath: path.join(root, 'PLAN.md'),
      branch: `ticket/${ticket}`,
      worktreePath: root,
      prBase: 'main',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    }],
  };
  return {
    root,
    receipts,
    ticket,
    recorder,
    host,
    args,
    get agentResult() { return agentResult; },
  };
}

async function runFixture(options = {}) {
  const value = fixture(options);
  try {
    const result = await value.host.run('executors', { args: value.args });
    return { ...value, result };
  } catch (error) {
    error.fixture = value;
    throw error;
  }
}

function clean(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

function judgmentReceipt(resolution) {
  const launchId = `judgment-launch-${resolution.dispatch_id}`;
  return {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    launch_id: launchId,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.model,
    applied_effort: resolution.effort,
    observed_model: resolution.model,
    observed_effort: resolution.effort,
    policy_hash: resolution.policy_hash,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: launchId,
    },
  };
}

function judgmentFixture(ticket = 'T-43-05-role-artifact-judgment') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-role-artifact-judgment-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'role-artifact-judgment@example.test']);
  git(root, ['config', 'user.name', 'Role Artifact Judgment Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment base']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'main'])]);
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  fs.writeFileSync(path.join(root, 'change.txt'), 'change\n');
  git(root, ['add', 'change.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment change']);

  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const boundary = createDispatchBoundary({
    adapters: { claude: { launch: judgmentReceipt } },
    recorder,
  });
  const dispatch = boundary.dispatch(
    { runtime: 'claude', role: 'arch-review', signals: {} },
    { ticket },
  );
  return { root, ticket, recorder, dispatch };
}

function archReviewResult(value, extra = {}) {
  const head = git(value.root, ['rev-parse', 'HEAD']);
  const mergeBase = git(value.root, ['merge-base', 'main', 'HEAD']);
  const baseTree = git(value.root, ['rev-parse', `${mergeBase}^{tree}`]);
  return {
    id: value.ticket,
    pr: 404,
    verdict: 'violation',
    head,
    base_tree: baseTree,
    blocking_count: 1,
    summary: 'architecture review summary',
    findings: [],
    ...extra,
  };
}

function sealArchReview(value, result) {
  const evidencePath = path.join(value.root, '.shipyard-arch-review-evidence.md');
  fs.writeFileSync(evidencePath, 'complete architecture review evidence\n');
  return roleArtifact.seal({
    worktreePath: value.root,
    base: 'main',
    role: 'arch-review',
    ticket: value.ticket,
    pr: 404,
    recorder: value.recorder,
    dispatchId: value.dispatch.receipt.dispatch_id,
    result,
    evidencePath,
    ...(value.ticketSet ? { ticketSet: value.ticketSet } : {}),
  });
}



function phaseScopeFixture({ second = false, empty = false, repo = null, mixed = false } = {}) {
  const value = judgmentFixture('T-47-01');
  value.originalReceiptStore = path.join(value.root, 'receipts');
  value.root = fs.realpathSync(value.root);
  const rows = [];
  const retain = item => {
    sealArchReview(item, archReviewResult(item, { verdict: 'conform', blocking_count: 0 }));
    rows.push({ worktree: fs.realpathSync(item.root), ticket: item.ticket,
      dispatch_id: item.dispatch.receipt.dispatch_id, receipt: item.dispatch.receipt,
      receipt_store: item.originalReceiptStore || path.join(item.root, 'receipts'), pins: roleArtifact.authenticatedArchivePins(item.root) });
  };
  if (!empty) retain(value);
  if (second) {
    value.second = value.root + '-second';
    git(value.root, ['worktree', 'add', '--detach', value.second, 'HEAD']);
    const recorder = createDurableRecorder(path.join(value.second, 'receipts'));
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder });
    const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: 'T-47-02' });
    retain({ root: value.second, ticket: 'T-47-02', recorder, dispatch });
  }
  const graphDir = path.join(value.root, '.planning/graph');
  fs.mkdirSync(graphDir, { recursive: true });
  const tickets = Object.fromEntries((second ? ['T-47-01', 'T-47-02'] : ['T-47-01']).map(id => [id,
    { phase: '47', repo, epic: 'epic/47-scope', plan: '.planning/phases/47-scope/' + id + '-PLAN.md' }]));
  if (mixed) tickets.foreign = {...tickets['T-47-01'],repo:repo === null ? 'acme/foreign' : null,epic:'epic/foreign',plan:'.planning/phases/47-foreign/foreign-PLAN.md'};
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), '{}');
  git(value.root, ['switch', '-c', 'epic/47-scope']);
  git(value.root, ['add', '.planning']); git(value.root, ['commit', '-m', 'fixture: current phase graph']);
  const binding = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({
    graph: { tickets }, state: {}, phase: 47, repo,
    repository: git(value.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    branch: 'epic/47-scope', pr: 404, head: git(value.root, ['rev-parse', 'HEAD']), base: git(value.root, ['rev-parse', 'main']) });
  const inventoryPath = path.join(value.root, 'retained-inventory.json');
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows }), { mode: 0o600 });
  const input = { worktreePath: value.root, graphDir, binding, inventoryPath,
    expectedInventoryDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') };
  const roster = roleArtifact.registerPhaseArchiveRoster(input);
  return { ...value, input, rows, roster,
    select: extra => roleArtifact.selectPhaseArchives(value.root, binding, { graphDir, ...extra }) };
}

function cleanPhaseScope(value) {
  if (value.second) fs.rmSync(value.second, { recursive: true, force: true });
  clean(value);
}

function retainPlanningInput(f, input, planningRoot = f.root, repo = null) {
  return require('../fixtures/code-review/artifact-fixture.cjs').retainPlanningInput(f, input, planningRoot, repo);
}

function foreignCodeReviewArchive() {
  const { fixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = fixture();
  const coordinator = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-review-coordinator-')));
  const git = args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'Review Test']); git(['config', 'user.email', 'review@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  f.advance(1);
  f.graph.tickets['T-52-01'].repo = 'acme/app';
  f.graph.epics = { '52': { branch: f.branch, phaseDir: f.phase, repos: ['acme/app'] } };
  f.writeGraph();
  fs.renameSync(path.join(f.root, '.planning'), path.join(coordinator, '.planning'));
  fs.writeFileSync(path.join(coordinator, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' },
    delivery_pipeline: { code_review: 'hold', repos: { 'acme/app': f.root } } }));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'canonical foreign selection']);
  const graphDir = path.join(coordinator, '.planning/graph');
  const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52, repo: 'acme/app',
    repository: target.repositoryIdentity(f.root), pr: 52, head: f.git(['rev-parse', 'HEAD']), base: f.base, branch: f.branch });
  const input = f.input(binding, 1, null, { review_completeness: 'complete', limitations: [], unresolved_sources: [],
    summary: 'Complete foreign review', findings: [], dispositions: [] });
  const live = { number: 52, state: 'OPEN', isDraft: false, headRefName: f.branch,
    headRefOid: input.result.head, baseRefName: 'main', baseRefOid: f.base };
  return { ...f, coordinator, graphDir, binding, input, live,
    lookup: (extra = {}) => roleArtifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir, repo: 'acme/app',
      pr: 52, head: live.headRefOid, headBranch: f.branch, baseName: 'main', baseCommit: f.base, ...extra }),
    cleanup() { f.cleanup(); fs.rmSync(coordinator, { recursive: true, force: true }); } };
}

function roleArtifactInternals(names) {
  const Module = require('node:module');
  const isolated = new Module(ROLE_ARTIFACT, module);
  isolated.filename = ROLE_ARTIFACT;
  isolated.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
  isolated._compile(fs.readFileSync(ROLE_ARTIFACT, 'utf8') + `\nmodule.exports = { ${names.join(', ')} };`, ROLE_ARTIFACT);
  return isolated.exports;
}

  return {
    ...context, fs, path, os, execFileSync, spawnSync, testAuthorityArgs, targetBin, codexJudgmentFixtures,
    testTranscriptEvidence, CLAUDE_MODEL_ALIASES, createDispatchBoundary, createDurableRecorder,
    registerClaudeWorkflowHost, NEUTRAL_PR_BODY_GUIDE, ROLE_ARTIFACT, roleArtifact, CAPABILITIES,
    transcriptEvidence, git, SHIPYARD_MANIFEST_RELATIVE, writeShipyardManifest, fixture, runFixture, clean,
    judgmentReceipt, judgmentFixture, archReviewResult, sealArchReview, phaseScopeFixture, cleanPhaseScope,
    retainPlanningInput, roleArtifactInternals,
    foreignCodeReviewArchive,
  };
}

function createRoleArtifactLifecycle() {
  const Module = require('node:module');
  const events = require('node:events');
  let pendingCase = Promise.resolve();
  let resources = null;
  const testAuthorityArgs = [];
  function snapshot() {
    return { homedir: os.homedir, load: Module._load, emit: events.EventEmitter.prototype.emit,
      fs: Object.entries(fs).filter(([key, value]) => typeof value === 'function'
        && Object.getOwnPropertyDescriptor(fs, key).writable), env: { ...process.env } };
  }
  function restore(owned) {
    os.homedir = owned.homedir;
    Module._load = owned.load;
    events.EventEmitter.prototype.emit = owned.emit;
    for (const [key, value] of owned.fs) fs[key] = value;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(owned.env, key)) delete process.env[key];
    for (const [key, value] of Object.entries(owned.env)) process.env[key] = value;
  }
  function cleanup() {
    if (!resources) return;
    const owned = resources;
    resources = null;
    process.removeListener('exit', cleanup);
    restore(owned);
    for (const directory of owned.directories) fs.rmSync(directory, { recursive: true, force: true });
    testAuthorityArgs.length = 0;
  }
  function start() {
    if (resources) throw new Error('role runner already started');
    resources = { ...snapshot(), directories: [] };
    process.on('exit', cleanup);
    try {
      const testAuthorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-authority-')));
      resources.directories.push(testAuthorityHome);
      const testAuthorityModule = path.join(testAuthorityHome, 'fixture.cjs');
      fs.writeFileSync(testAuthorityModule, "require('node:os').homedir = () => " + JSON.stringify(testAuthorityHome) + ";\n");
      testAuthorityArgs.push('--require', testAuthorityModule);
      os.homedir = () => testAuthorityHome;
      const targetBin = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-gh-'));
      resources.directories.push(targetBin);
      resources.targetBin = targetBin;
      fs.writeFileSync(path.join(targetBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const git = args => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write('main');
else if (args[0] === 'pr' && args[1] === 'view') {
  let base = 'main';
  try { base = JSON.parse(fs.readFileSync('.planning/config.json')).git?.base_branch || base; } catch {}
  let oid; try { oid = git(['rev-parse','refs/remotes/origin/' + base]); } catch { oid = git(['rev-parse','HEAD']); }
  process.stdout.write(JSON.stringify({number:Number(args[2]),state:'OPEN',headRefName:git(['branch','--show-current']),
    headRefOid:git(['rev-parse','HEAD']),baseRefName:base,baseRefOid:oid}));
} else process.exit(2);
`, {mode:0o755});

      process.env.PATH = targetBin + path.delimiter + process.env.PATH;
      if (!process.env.GIT_CONFIG_GLOBAL) {
        const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shy-git-'));
        resources.directories.push(gitHome);
        const configFile = path.join(gitHome, 'gitconfig');
        fs.writeFileSync(configFile, '');
        for (const [key, value] of [
          ['user.name', 'Shipyard Unit Tests'],
          ['user.email', 'unit-tests@shipyard.invalid'],
          ['commit.gpgsign', 'false'],
          ['tag.gpgsign', 'false'],
          ['init.defaultBranch', 'main'],
        ]) execFileSync('git', ['config', '--file', configFile, key, value]);
        process.env.GIT_CONFIG_GLOBAL = configFile;
        process.env.GIT_CONFIG_NOSYSTEM = '1';
      }
    } catch (error) { cleanup(); throw error; }
  }
  function run(callback) {
    const current = pendingCase.then(async () => {
      const before = snapshot();
      try { return await callback(); }
      finally { restore(before); }
    });
    pendingCase = current.catch(() => {});
    return current;
  }
  return { start, run, cleanup, settle: () => pendingCase, testAuthorityArgs,
    get targetBin() { return resources?.targetBin; } };
}

module.exports = { createRoleArtifactFixture, createRoleArtifactLifecycle };
