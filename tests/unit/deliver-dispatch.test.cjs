'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { mock } = require('node:test');
const testAuthorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-home-')));
const testOriginalHomedir = os.homedir;
os.homedir = () => testAuthorityHome;
const testHomeEnv = Object.fromEntries(['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']
  .map((name) => [name, process.env[name]]));
for (const name of Object.keys(testHomeEnv)) process.env[name] = testAuthorityHome;
process.on('exit', () => {
  os.homedir = testOriginalHomedir;
  for (const [name, value] of Object.entries(testHomeEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(testAuthorityHome, { recursive: true, force: true });
});

const targetBin = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-gh-'));
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
const targetOldPath = process.env.PATH;
process.env.PATH = targetBin + path.delimiter + targetOldPath;
process.on('exit', () => { process.env.PATH = targetOldPath; fs.rmSync(targetBin, {recursive:true,force:true}); });
const { suite, test, done, assert } = require('./assert-harness.cjs');

const codexSessionEnv = Object.fromEntries(['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_CODE_ENTRYPOINT', 'SHIPYARD_RUNTIME', 'GSD_RUNTIME', 'SHIPYARD_GRAPH_DIR']
  .map((name) => [name, process.env[name]]));
for (const name of Object.keys(codexSessionEnv)) delete process.env[name];
process.on('exit', () => {
  for (const [name, value] of Object.entries(codexSessionEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const deliverDispatch = require('../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
const claudeHost = require('../../plugins/delivery-pipeline/scripts/claude-delivery-host.cjs');
const claudeInvestigationHost = require('../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');
const { validateRequest } = claudeHost;
const claudeDecomposeHost = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');
const codexPlanningContextHost = require('../../plugins/delivery-pipeline/scripts/codex-planning-context-host.cjs');
const codexDeliveryHost = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const { validateArgs } = codexDeliveryHost;
const { parseRequest, REQUEST_SCHEMA: ROLE_REQUEST_SCHEMA } = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
const { validateContextPacket } = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const modelPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const prHygiene = require('../../plugins/delivery-pipeline/scripts/pr-hygiene.cjs');

suite('deliver-dispatch — front-to-dispatch entry point');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Deliver Dispatch Test');
  git(dir, 'config', 'user.email', 'deliver-dispatch@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const PLAN_TEXT = [
  '---',
  'phase: 1',
  'plan: 1',
  'title: "Demo ticket"',
  'type: implementation',
  '---',
  '',
  '## Context (Reads)',
  '',
  '- `src/helper.js`',
  '',
  '## Acceptance criteria',
  '',
  '- it works',
  '',
  '## Verification commands',
  '',
  '- `node -e "1"`',
  '',
].join('\n');

function ticketRow(overrides = {}) {
  return {
    branch: 'ticket/T-01-01-demo',
    plan: '.planning/phases/01-demo/01-01-PLAN.md',
    type: 'implementation',
    phase: 1,
    risk: 'low',
    human_checkpoint: false,
    critical: false,
    files: ['src/thing.js'],
    pr_base: 'main',
    repo: null,
    ...overrides,
  };
}

function writeShipyardManifest(root) {
  writeJson(path.join(root, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'), { name: 'shipyard' });
}

function shipyardFixture(id = 'T-01-01', prefix = 'shipyard-deliver-dispatch-sy-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initRepo(root);
  writeShipyardManifest(root);
  writeJson(path.join(root, '.planning', 'graph', 'tickets.json'), { tickets: { [id]: ticketRow() } });
  writeJson(path.join(root, '.planning', 'graph', 'delivery-state.json'), { [id]: { ready: true } });
  fs.mkdirSync(path.join(root, '.planning', 'phases', '01-demo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'phases', '01-demo', '01-01-PLAN.md'), PLAN_TEXT);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'thing.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = 2;\n');
  commitAll(root, 'demo: seed shipyard fixture');
  return { root, id, graphDir: path.join(root, '.planning', 'graph') };
}

function builderFixture(id = 'T-11-11') {
  const fixture = shipyardFixture(id);
  git(fixture.root, 'checkout', '-q', '-b', ticketRow().branch);
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), {
    [id]: { ready: true, status: 'pr-open', pr: 501, branch: ticketRow().branch, base: 'main' },
  });
  return fixture;
}

function planningBuilderFixture(invId = 'INV-43-15', prefix) {
  const fixture = shipyardFixture('T-43-15', prefix);
  const invPath = path.join(fixture.root, '.planning', 'investigations', invId);
  fs.mkdirSync(path.join(invPath, 'research'), { recursive: true });
  fs.mkdirSync(path.join(fixture.root, '.planning', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(invPath, 'PROBLEM.md'), '---\nadr: .planning/architecture/ADR-TEST.md\n---\n\n# Problem\n');
  fs.writeFileSync(path.join(invPath, 'RESEARCH-CONTRACT.md'), '# Research contract\n');
  fs.writeFileSync(path.join(invPath, 'DECISIONS.md'), '# Decisions\n');
  fs.writeFileSync(path.join(fixture.root, '.planning', 'architecture', 'ADR-TEST.md'), '# Planning ADR\n');
  fs.writeFileSync(path.join(fixture.root, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
  fs.writeFileSync(path.join(fixture.root, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  writeJson(path.join(fixture.graphDir, 'tickets.json'), {
    tickets: { 'T-43-15': ticketRow({ phase: 43 }) },
  });
  return { ...fixture, invId, invPath };
}

function targetProjectFixture(id = 'T-02-02') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-tp-'));
  initRepo(projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'thing.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(projectRoot, '.planning', 'phases', '02-demo'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.planning', 'phases', '02-demo', '02-02-PLAN.md'), PLAN_TEXT);
  commitAll(projectRoot, 'demo: seed target project (no .planning tracked)');
  writeJson(path.join(projectRoot, '.planning', 'graph', 'tickets.json'), {
    tickets: { [id]: ticketRow({ branch: 'feat/demo-ticket', plan: '.planning/phases/02-demo/02-02-PLAN.md' }) },
  });
  writeJson(path.join(projectRoot, '.planning', 'graph', 'delivery-state.json'), { [id]: { ready: true } });

  const ticketWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-tp-wt-'));
  initRepo(ticketWorktree);
  fs.writeFileSync(path.join(ticketWorktree, 'README.md'), '# ticket worktree\n');
  commitAll(ticketWorktree, 'demo: seed cross-repo ticket worktree');
  git(ticketWorktree, 'checkout', '-q', '-b', 'feat/demo-ticket');

  return { projectRoot, ticketWorktree, id, graphDir: path.join(projectRoot, '.planning', 'graph') };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

const sharedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
process.on('exit', () => fs.rmSync(sharedStateDir, { recursive: true, force: true }));

test('Pitfall 1: ticket type never enters signals, and the row shape is accepted by the real resolver', () => {
  const row = ticketRow({ type: 'implementation' });
  const signals = deliverDispatch.buildSignals(row);
  assert.equal(Object.prototype.hasOwnProperty.call(signals, 'type'), false);
  assert.deepEqual(signals, { risk: 'low' });
  assert.deepEqual(modelPolicy.normalizeSignals(signals), { risk: 'low' });
});

test('build emits an arch-review request accepted by the Claude role host', async () => {
  const fixture = builderFixture();
  try {
    let output = '';
    const code = await deliverDispatch.main([
      'build', 'arch-review', fixture.id, '--runtime', 'claude', '--pr', '501',
    ], { write(value) { output += value; } }, { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.equal(code, 0);
    const request = JSON.parse(output);
    const accepted = parseRequest(request);
    assert.equal(request.schema, ROLE_REQUEST_SCHEMA);
    assert.equal(accepted.role, 'arch-review');
    assert.equal(accepted.ticket, fixture.id);
    assert.equal(accepted.pr, 501);
    assert.equal(accepted.worktree, fs.realpathSync(fixture.root));
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'type'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'model'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.signals || {}, 'effort'), false);
  } finally {
    cleanup(fixture.root);
  }
});

test('research and decomposition builders round-trip through both runtimes’ real validators', () => {
  const fixture = planningBuilderFixture();
  const graphFile = path.join(fixture.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  graph.unrelated_large_metadata = 'bounded packet fixture '.repeat(4000);
  writeJson(graphFile, graph);
  const basePaths = ['PROBLEM.md', 'RESEARCH-CONTRACT.md', 'DECISIONS.md']
    .map((name) => fs.realpathSync(path.join(fixture.invPath, name)));
  basePaths.push(fs.realpathSync(path.join(fixture.graphDir, 'tickets.json')));
  const sourceRef = (file) => ({
    path: file,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const sourceRefs = basePaths.map(sourceRef);
  const decompositionRefs = [
    ...sourceRefs,
    sourceRef(fs.realpathSync(path.join(fixture.root, '.planning', 'architecture', 'ADR-TEST.md'))),
    sourceRef(fs.realpathSync(path.join(fixture.root, '.planning', 'REQUIREMENTS.md'))),
    sourceRef(fs.realpathSync(path.join(fixture.root, '.planning', 'ROADMAP.md'))),
  ];
  try {
    for (const [role, argv] of [
      ['research', ['research', fixture.invId]],
      ['decomposition', ['decomposition', fixture.invId, '--phase', '44']],
    ]) {
      for (const runtime of ['claude', 'codex']) {
        const request = deliverDispatch.build([...argv, '--runtime', runtime], {
          cwd: fixture.root,
          graphDir: fixture.graphDir,
        });
        let accepted;
        if (role === 'research' && runtime === 'claude') {
          accepted = validateRequest('investigation-research', request);
          assert.equal(accepted.workflow, 'investigation-research');
          assert.equal(request.scope.ticket, fixture.invId);
          assert.equal(request.scope.phase, 43);
          assert.deepEqual(request.args.lines.map((line) => line.id), ['system-state', 'alternatives', 'constraints', 'risks']);
          assert.equal(request.args.sourceRefs.length, 4);
          assert.deepEqual(request.args.sourceRefs, sourceRefs);
          assert.equal(request.args.contextPacketRequired, true);
          for (const line of request.args.lines) {
            assert.equal(Object.hasOwn(line, 'model'), false);
            assert.equal(Object.hasOwn(line, 'effort'), false);
            assert.equal(line.contextPacket.backlog.empty, true);
            assert.deepEqual(line.contextPacket.backlog.selected_ids, []);
            assert.ok(line.contextPacket.accounting.estimated_tokens <= line.contextPacket.accounting.soft_ceiling);
            assert.ok(line.contextPacket.optional_refs.some((ref) =>
              ref.path === '.planning/graph/tickets.json' && ref.content_omitted));
            validateContextPacket(line.contextPacket, {
              role: 'research', subject: `${fixture.invId}:${line.id}`,
              root: fixture.root, sourceRevision: git(fixture.root, 'rev-parse', 'HEAD'),
              policyHash: modelPolicy.POLICY_HASH,
            });
          }
          const cliArgs = claudeInvestigationHost.resolveResearchSelections(request.args, fixture.root);
          assert.equal(cliArgs.lines.length, 4);
          assert.ok(cliArgs.lines.every((line) => typeof line.model === 'string' && typeof line.effort === 'string'));
        } else if (role === 'decomposition' && runtime === 'claude') {
          accepted = claudeDecomposeHost.canonicalRequest(request);
          assert.equal(accepted.role, 'gsd-planner');
          assert.equal(accepted.phase, 44);
          assert.equal(accepted.worktree, fs.realpathSync(fixture.root));
          for (const source of decompositionRefs) {
            assert.ok(request.prompt.includes(source.path));
            assert.ok(request.prompt.includes(source.sha256));
          }
        } else if (role === 'research') {
          const { scope: _scope, ...launch } = request;
          accepted = codexDeliveryHost.validateArgs(launch);
          assert.equal(accepted.request.role, 'research');
          assert.deepEqual(request.context.investigation.lines.map((line) => line.id),
            ['system-state', 'alternatives', 'constraints', 'risks']);
          assert.equal(request.context.contextPacketRequired, true);
          validateContextPacket(request.context.contextPacket, {
            role: 'research', subject: fixture.invId, root: fixture.root,
            sourceRevision: git(fixture.root, 'rev-parse', 'HEAD'), policyHash: modelPolicy.POLICY_HASH,
          });
          fs.appendFileSync(path.join(fixture.invPath, 'PROBLEM.md'), 'Changed after build.\n');
          assert.throws(() => validateContextPacket(request.context.contextPacket), /changed after packet construction/);
          fs.writeFileSync(path.join(fixture.invPath, 'PROBLEM.md'), '---\nadr: .planning/architecture/ADR-TEST.md\n---\n\n# Problem\n');
        } else {
          const { scope: _scope, ...launch } = request;
          accepted = codexPlanningContextHost.requestValue(launch, { worktreePath: fixture.root });
          assert.equal(accepted.gsd_role, 'gsd-planner');
          assert.equal(accepted.contextPacketRequired, true);
          assert.equal(accepted.sourceRevision, git(fixture.root, 'rev-parse', 'HEAD'));
          assert.ok(accepted.contextPacket.required_refs.some((ref) => ref.path === '.planning/architecture/ADR-TEST.md'));
          assert.equal(accepted.contextPacket.backlog.empty, true);
          assert.ok(accepted.contextPacket.accounting.estimated_tokens <= accepted.contextPacket.accounting.soft_ceiling);
          assert.ok(accepted.contextPacket.optional_refs.some((ref) =>
            ref.path === '.planning/graph/tickets.json' && ref.content_omitted));
          validateContextPacket(accepted.contextPacket, {
            role: 'decomposition', subject: accepted.subject, root: fixture.root,
            sourceRevision: accepted.sourceRevision, policyHash: modelPolicy.POLICY_HASH,
          });
          fs.appendFileSync(path.join(fixture.root, '.planning', 'architecture', 'ADR-TEST.md'), 'Changed after build.\n');
          assert.throws(() => codexPlanningContextHost.requestValue(launch, { worktreePath: fixture.root }),
            /changed after packet construction/);
          fs.writeFileSync(path.join(fixture.root, '.planning', 'architecture', 'ADR-TEST.md'), '# Planning ADR\n');
          for (const source of decompositionRefs) {
            assert.ok(request.prompt.includes(source.path));
            assert.ok(request.prompt.includes(source.sha256));
          }
        }
        assert.ok(accepted);
        if (role === 'research' && runtime === 'codex') {
          assert.equal(Object.hasOwn(request, 'model'), false);
          assert.equal(Object.hasOwn(request, 'effort'), false);
        }
      }
    }
  } finally {
    cleanup(fixture.root);
  }
});

// @contract: planning builders work with no graph; a graph that is named or exists but is wrong still refuses.
function graphlessFixture(invId = 'INV-001-first') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-graphless-')));
  initRepo(root);
  fs.writeFileSync(path.join(root, 'README.md'), '# Target project\n');
  commitAll(root, 'initial');
  const invPath = path.join(root, '.planning', 'investigations', invId);
  fs.mkdirSync(path.join(invPath, 'research'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(invPath, 'PROBLEM.md'), '---\nadr: .planning/architecture/ADR-TEST.md\n---\n\n# Problem\n');
  fs.writeFileSync(path.join(invPath, 'RESEARCH-CONTRACT.md'), '# Research contract\n');
  fs.writeFileSync(path.join(invPath, 'DECISIONS.md'), '# Decisions\n');
  fs.writeFileSync(path.join(root, '.planning', 'architecture', 'ADR-TEST.md'), '# Planning ADR\n');
  return { root, invId, invPath };
}

// @contract: graph resolution reads process.cwd() as well as the cwd option, so these tests chdir to match the CLI.
function withoutGraphEnv(run) {
  const saved = process.env.SHIPYARD_GRAPH_DIR;
  const originalCwd = process.cwd();
  delete process.env.SHIPYARD_GRAPH_DIR;
  process.chdir(os.tmpdir());
  try { return run(); } finally {
    process.chdir(originalCwd);
    if (saved !== undefined) process.env.SHIPYARD_GRAPH_DIR = saved;
  }
}

test('research and decomposition build with no graph and pass both runtimes’ real validators', () => withoutGraphEnv(() => {
  const fixture = graphlessFixture();
  try {
    process.chdir(fixture.root);
    assert.equal(fs.existsSync(path.join(fixture.root, '.planning', 'graph')), false);
    const revision = git(fixture.root, 'rev-parse', 'HEAD');
    for (const runtime of ['claude', 'codex']) {
      const research = deliverDispatch.build(['research', fixture.invId, '--runtime', runtime], { cwd: fixture.root });
      const refPaths = runtime === 'claude'
        ? research.args.sourceRefs.map((ref) => ref.path)
        : research.context.contextPacket.required_refs.concat(research.context.contextPacket.optional_refs)
          .map((ref) => ref.path);
      assert.ok(refPaths.every((file) => !file.endsWith('tickets.json')), `${runtime} research must not name a graph`);
      assert.equal(research.scope.phase, 1);
      assert.equal(research.scope.worktree, fixture.root);
      if (runtime === 'claude') {
        assert.equal(validateRequest('investigation-research', research).workflow, 'investigation-research');
        assert.equal(research.args.sourceRefs.length, 3);
        for (const line of research.args.lines) {
          validateContextPacket(line.contextPacket, {
            role: 'research', subject: `${fixture.invId}:${line.id}`, root: fixture.root,
            sourceRevision: revision, policyHash: modelPolicy.POLICY_HASH,
          });
        }
      } else {
        const { scope: _scope, ...launch } = research;
        assert.equal(codexDeliveryHost.validateArgs(launch).request.role, 'research');
        validateContextPacket(research.context.contextPacket, {
          role: 'research', subject: fixture.invId, root: fixture.root,
          sourceRevision: revision, policyHash: modelPolicy.POLICY_HASH,
        });
      }

      const decomposition = deliverDispatch.build(['decomposition', fixture.invId, '--phase', '1', '--runtime', runtime],
        { cwd: fixture.root });
      assert.equal(JSON.stringify(decomposition).includes('tickets.json'), false);
      if (runtime === 'claude') {
        assert.equal(claudeDecomposeHost.canonicalRequest(decomposition).phase, 1);
        assert.ok(decomposition.prompt.includes('.planning/architecture/ADR-TEST.md'));
      } else {
        const { scope: _scope, ...launch } = decomposition;
        const accepted = codexPlanningContextHost.requestValue(launch, { worktreePath: fixture.root });
        assert.ok(accepted.contextPacket.required_refs.some((ref) => ref.path === '.planning/architecture/ADR-TEST.md'));
      }
    }
    const phased = deliverDispatch.build(['research', fixture.invId, '--runtime', 'claude', '--phase', '3'], { cwd: fixture.root });
    assert.equal(phased.scope.phase, 3);
    assert.equal(fs.existsSync(path.join(fixture.root, '.planning', 'graph')), false);
  } finally {
    cleanup(fixture.root);
  }
}));

test('graph-less planning build resolves the owning repository from a linked worktree', () => withoutGraphEnv(() => {
  const fixture = graphlessFixture('INV-002-linked');
  const linked = path.join(os.tmpdir(), `deliver-graphless-linked-${process.pid}`);
  try {
    git(fixture.root, 'worktree', 'add', '-q', '--detach', linked);
    process.chdir(linked);
    const request = deliverDispatch.build(['research', fixture.invId, '--runtime', 'claude'], { cwd: linked });
    assert.equal(request.scope.worktree, fixture.root);
    assert.equal(request.scope.phase, 1);
  } finally {
    cleanup(linked, fixture.root);
  }
}));

test('graph-less fallback does not relax a graph that was named or that exists but is wrong', () => withoutGraphEnv(() => {
  const fixture = graphlessFixture('INV-003-strict');
  try {
    process.chdir(fixture.root);
    const missing = path.join(fixture.root, 'elsewhere', 'graph');
    assert.throws(() => deliverDispatch.build(['research', fixture.invId], { cwd: fixture.root, graphDir: missing }),
      (error) => error.code === 'BUILD_REFUSED' && /canonical ticket graph is unavailable/.test(error.message));
    process.env.SHIPYARD_GRAPH_DIR = missing;
    try {
      assert.throws(() => deliverDispatch.build(['research', fixture.invId], { cwd: fixture.root }),
        (error) => error.code === 'BUILD_REFUSED' && /canonical ticket graph is unavailable/.test(error.message));
    } finally { delete process.env.SHIPYARD_GRAPH_DIR; }
    const graphDir = path.join(fixture.root, '.planning', 'graph');
    writeJson(path.join(graphDir, 'tickets.json'), { tickets: {} });
    commitAll(fixture.root, 'graph');
    assert.throws(() => deliverDispatch.build(['research', fixture.invId, '--runtime', 'claude'], { cwd: fixture.root }),
      (error) => error.code === 'BUILD_REFUSED' && /no positive phase/.test(error.message));
  } finally {
    cleanup(fixture.root);
  }
}));

test('the decomposition builder carries the ADR path to both runtimes and refuses an investigation with no linked ADR', () => {
  const fixture = planningBuilderFixture('INV-43-17');
  try {
    for (const runtime of ['claude', 'codex']) {
      const request = deliverDispatch.build(['decomposition', fixture.invId, '--phase', '44', '--runtime', runtime],
        { cwd: fixture.root, graphDir: fixture.graphDir });
      assert.equal(request.adr, '.planning/architecture/ADR-TEST.md', runtime);
    }
    fs.writeFileSync(path.join(fixture.invPath, 'PROBLEM.md'), '# Problem\n');
    assert.throws(() => deliverDispatch.build(['decomposition', fixture.invId, '--phase', '44', '--runtime', 'claude'],
      { cwd: fixture.root, graphDir: fixture.graphDir }),
    (error) => error.code === 'BUILD_REFUSED' && /link its accepted ADR/.test(error.message));
  } finally {
    cleanup(fixture.root);
  }
});

test('planning builders preserve context with distinct fresh run ids and missing PROBLEM.md exits 2', () => {
  const fixture = planningBuilderFixture('INV-43-16');
  const args = ['research', fixture.invId, '--runtime', 'codex'];
  try {
    const first = deliverDispatch.build(args, { cwd: fixture.root, graphDir: fixture.graphDir });
    const second = deliverDispatch.build(args, { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.notEqual(second.scope.run_id, first.scope.run_id);
    assert.match(first.scope.run_id, /^deliver-build-research-[a-f0-9-]{36}$/);
    assert.deepEqual({ ...second, scope: { ...second.scope, run_id: first.scope.run_id } }, first);
    const claudeFirst = deliverDispatch.build(['research', fixture.invId, '--runtime', 'claude'],
      { cwd: fixture.root, graphDir: fixture.graphDir });
    const claudeSecond = deliverDispatch.build(['research', fixture.invId, '--runtime', 'claude'],
      { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.notEqual(claudeSecond.scope.run_id, claudeFirst.scope.run_id);
    fs.rmSync(path.join(fixture.invPath, 'PROBLEM.md'));
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'),
      'build', ...args,
    ], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...process.env, SHIPYARD_GRAPH_DIR: fixture.graphDir },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PROBLEM\.md/);
    const invalid = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'),
      'build', 'research', 'not-an-investigation',
    ], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...process.env, SHIPYARD_GRAPH_DIR: fixture.graphDir },
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /not-an-investigation/);
  } finally {
    cleanup(fixture.root);
  }
});

test('Codex arch-review builder delegates context and signals to its trusted host', () => {
  const fixture = builderFixture('T-12-12');
  try {
    const shape = validateArgs({ role: 'arch-review', signals: {}, context: {} });
    assert.equal(shape.request.role, 'arch-review');
    assert.equal(shape.request.context.prompt, undefined);
    const request = deliverDispatch.build(['arch-review', fixture.id, '--runtime', 'codex', '--pr', '501'], {
      cwd: fixture.root, graphDir: fixture.graphDir,
    });
    assert.equal(request.role, 'arch-review');
    assert.equal(request.scope.ticket, fixture.id);
    assert.equal(request.graph_dir, fs.realpathSync(fixture.graphDir));
    assert.deepEqual(request.context, {});
    assert.deepEqual(request.signals, {});
    const relativeGraph = deliverDispatch.build(['arch-review', fixture.id, '--runtime', 'codex',
      '--pr', '501', '--graph', '.planning/graph'], { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.equal(relativeGraph.graph_dir, fs.realpathSync(fixture.graphDir));
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs'), 'build', 'arch-review', fixture.id,
      '--runtime', 'codex', '--pr', '501', '--graph', fixture.graphDir], {
      cwd: fixture.root, encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: fixture.graphDir },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).scope.ticket, fixture.id);
    assert.throws(() => deliverDispatch.build(['arch-review', fixture.id, '--runtime', 'codex', '--pr', '502'], {
      cwd: fixture.root, graphDir: fixture.graphDir,
    }), /PR differs/);
  } finally {
    cleanup(fixture.root);
  }
});

test('fix builders refuse shape-only hosts after checking evidence paths and digests', () => {
  const fixture = builderFixture('T-13-13');
  const failureFile = path.join(fixture.root, 'failure.log');
  const reviewFile = path.join(fixture.root, 'review.md');
  fs.writeFileSync(failureFile, 'failing test output\n');
  fs.writeFileSync(reviewFile, 'review thread evidence\n');
  try {
    for (const runtime of ['claude', 'codex']) {
      for (const [role, flag, evidence, hostName] of [
        ['ci-fix', '--failure-file', failureFile, 'failure evidence'],
        ['review-fix', '--review-file', reviewFile, 'review evidence'],
      ]) {
        if (runtime === 'codex') {
          const shape = validateArgs({ role, signals: {}, context: { evidence_path: evidence,
            evidence_sha256: crypto.createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') } });
          assert.equal(shape.request.role, role);
        }
        if (runtime === 'codex' && role === 'review-fix') {
          const built = deliverDispatch.build([role, fixture.id, '--runtime', runtime, '--pr', '501', flag, evidence], {
            cwd: fixture.root, graphDir: fixture.graphDir,
          });
          assert.equal(built.role, 'review-fix');
          assert.equal(built.context.prompt, undefined);
          assert.equal(built.context.evidence_sha256, crypto.createHash('sha256').update(fs.readFileSync(evidence)).digest('hex'));
          continue;
        }
        assert.throws(
          () => deliverDispatch.build([role, fixture.id, '--runtime', runtime, '--pr', '501', flag, evidence], {
            cwd: fixture.root, graphDir: fixture.graphDir,
          }),
          (error) => error.exitCode === 2 && new RegExp(`${runtime} ${role} host contract missing`).test(error.message)
            && new RegExp(hostName).test(error.message),
        );
      }
    }
  } finally {
    cleanup(fixture.root);
  }
});

test('build exits 2 and names --failure-file when CI evidence is missing', () => {
  const fixture = builderFixture('T-14-14');
  try {
    const script = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/deliver-dispatch.cjs');
    const options = {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...process.env, SHIPYARD_GRAPH_DIR: fixture.graphDir },
    };
    const absentFlag = spawnSync(process.execPath, [script, 'build', 'ci-fix', fixture.id,
      '--runtime', 'claude', '--pr', '501'], options);
    const missingFile = spawnSync(process.execPath, [script, 'build', 'ci-fix', fixture.id,
      '--runtime', 'claude', '--pr', '501', '--failure-file', 'missing.log'], options);
    assert.equal(absentFlag.status, 2);
    assert.match(absentFlag.stderr, /--failure-file/);
    assert.equal(missingFile.status, 2);
    assert.match(missingFile.stderr, /--failure-file file is unavailable/);
  } finally {
    cleanup(fixture.root);
  }
});

test('Pitfall 2: planPath satisfies the canonical-plan formula regardless of process.cwd()', async () => {
  const fixture = shipyardFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    const expectedPlanPath = path.resolve(fs.realpathSync(fixture.graphDir), '..', '..', ticketRow().plan);
    assert.equal(captured.args.tickets[0].planPath, expectedPlanPath);
    assert.notEqual(path.resolve(fs.realpathSync(fixture.graphDir), '..', '..'), process.cwd());
  } finally {
    cleanup(fixture.root);
  }
});

test('D-43: a Shipyard-shaped fixture resolves the worktree graph and plan exactly as today', async () => {
  const fixture = shipyardFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.args.tickets[0].branch, ticketRow().branch);
    assert.equal(captured.args.tickets[0].worktreePath, fs.realpathSync(fixture.root));
    assert.equal(Object.prototype.hasOwnProperty.call(captured.args, 'prBodyGuide'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(captured.args, 'deliveryRulesHint'), false);
    const valid = validateRequest('executors', captured);
    assert.equal(valid.hostScope.ticket, fixture.id);
    const packet = captured.args.tickets[0].contextPacket;
    const validated = validateContextPacket(packet, {
      root: fs.realpathSync(fixture.root), role: 'executor', subject: fixture.id, policyHash: modelPolicy.POLICY_HASH,
    });
    assert.ok(validated.required_refs.some((ref) => ref.path === '.planning/phases/01-demo/01-01-PLAN.md'));
    assert.ok(validated.required_refs.some((ref) => ref.path === 'src/helper.js'));
  } finally {
    cleanup(fixture.root);
  }
});

test('an explicit canonical project graph overrides stale ticket-branch state', async () => {
  const fixture = shipyardFixture();
  const linked = path.join(fixture.root, '..', `${path.basename(fixture.root)}-ticket`);
  try {
    git(fixture.root, 'branch', ticketRow().branch);
    git(fixture.root, 'worktree', 'add', '-q', linked, ticketRow().branch);
    writeJson(path.join(linked, '.planning', 'graph', 'delivery-state.json'), {
      [fixture.id]: { ready: false },
    });
    commitAll(linked, 'ticket: retain an older board');
    let captured;
    await deliverDispatch.launch([
      '--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', fixture.graphDir,
    ], {
      cwd: linked,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        captured = JSON.parse(fs.readFileSync(spawnArgs[spawnArgs.indexOf('--request-file') + 1], 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.args.tickets[0].worktreePath, fs.realpathSync(linked));
    assert.equal(captured.args.tickets[0].planPath,
      path.join(fs.realpathSync(fixture.root), ticketRow().plan));
  } finally {
    try { git(fixture.root, 'worktree', 'remove', '--force', linked); } catch {}
    cleanup(fixture.root, linked);
  }
});

test('D-43: a target-project fixture resolves the project graph, and its packet has no .planning ref', async () => {
  const fixture = targetProjectFixture();
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', fixture.graphDir], {
      cwd: fixture.ticketWorktree,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        captured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    const entry = captured.args.tickets[0];
    const expectedSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(fixture.projectRoot, '.planning', 'phases', '02-demo', '02-02-PLAN.md'))).digest('hex');
    assert.equal(entry.planSha256, expectedSha256);
    assert.equal(entry.planPath, path.resolve(fs.realpathSync(fixture.projectRoot), '.planning', 'phases', '02-demo', '02-02-PLAN.md'));
    const packet = entry.contextPacket;
    assert.equal(packet.required_refs.length, 0);
    assert.equal(packet.role_context.planSha256, expectedSha256);
    const validated = validateContextPacket(packet, {
      root: fs.realpathSync(fixture.ticketWorktree), role: 'executor', subject: fixture.id, policyHash: modelPolicy.POLICY_HASH,
    });
    assert.equal(validated.required_refs.some((ref) => ref.path.includes('.planning')), false);
    assert.equal(captured.args.prBodyGuide, prHygiene.NEUTRAL_PR_BODY_GUIDE);
    assert.equal(captured.args.deliveryRulesHint, prHygiene.NEUTRAL_DELIVERY_RULES_HINT);
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree);
  }
});

test('D-43: a --graph-dir copy inside a linked worktree refuses GRAPH_NOT_CANONICAL', async () => {
  const fixture = targetProjectFixture('T-03-03');
  const linked = path.join(fixture.projectRoot, '..', `${path.basename(fixture.projectRoot)}-linked`);
  try {
    git(fixture.projectRoot, 'branch', 'linked-branch');
    git(fixture.projectRoot, 'worktree', 'add', '-q', linked, 'linked-branch');
    const copyDir = path.join(linked, '.planning', 'graph');
    writeJson(path.join(copyDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', copyDir], {
        cwd: linked,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'GRAPH_NOT_CANONICAL',
    );
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree, linked);
  }
});

test('a --graph-dir naming nothing refuses GRAPH_UNRESOLVED', async () => {
  const fixture = targetProjectFixture('T-04-04');
  const emptyGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-empty-'));
  try {
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor', '--graph-dir', emptyGraphDir], {
        cwd: fixture.ticketWorktree,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'GRAPH_UNRESOLVED',
    );
  } finally {
    cleanup(fixture.projectRoot, fixture.ticketWorktree, emptyGraphDir);
  }
});

test('a non-actionable ticket refuses', async () => {
  const fixture = shipyardFixture('T-05-05');
  writeJson(path.join(fixture.graphDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), { [fixture.id]: { ready: false } });
  try {
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'], {
        cwd: fixture.root,
        stateDir: sharedStateDir,
      }),
      (error) => error.code === 'NOT_ACTIONABLE',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('a Codex request passes the real validateArgs', async () => {
  const fixture = shipyardFixture('T-06-06');
  try {
    let captured;
    await deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const argsFile = spawnArgs[spawnArgs.indexOf('--args-file') + 1];
        captured = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(captured.scope.ticket, fixture.id);
    assert.equal(captured.scope.worktree, fs.realpathSync(fixture.root));
    const { resolution } = validateArgs({ role: captured.role, signals: captured.signals, context: captured.context });
    assert.equal(resolution.role, 'executor');
  } finally {
    cleanup(fixture.root);
  }
});

test('the detached child pid is the host process; status/wait report exit and record a dispatch wake', async () => {
  const fixture = shipyardFixture('T-07-07');
  const stub = path.join(fixture.root, 'stub-host.cjs');
  fs.writeFileSync(stub, "process.stdout.write(JSON.stringify({pid: process.pid}) + '\\n');\n");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
  try {
    const launched = await deliverDispatch.launch(
      ['--runtime', 'claude', '--ticket', fixture.id, '--role', 'executor'],
      { cwd: fixture.root, stateDir, claudeHostScript: stub },
    );
    const waited = await deliverDispatch.waitOnce(launched.dispatch_id, { stateDir, intervalMs: 20, timeoutMs: 5000 });
    assert.equal(waited.status, 'exited-ok');
    assert.equal(typeof waited.result.pid, 'number');
    assert.notEqual(waited.result.pid, process.pid);
    const status = deliverDispatch.statusOnce(launched.dispatch_id, { stateDir });
    assert.equal(status.status, 'exited-ok');
    const events = fs.readFileSync(path.join(fixture.graphDir, 'runs', 'wake-events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.kind === 'dispatch' && event.run_id === launched.dispatch_id));
  } finally {
    cleanup(fixture.root, stateDir);
  }
});

test('blocking observations are measured once across repeat waits and lost recovery adds no poll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-wait-measurement-'));
  const stateDir = path.join(root, 'dispatch');
  const graphDir = path.join(root, 'graph');
  const id = 'original-wait';
  const directory = path.join(stateDir, id);
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, 'record.json'), { dispatch_id: id, pid: 999999,
    role: 'gsd-planner', runtime: 'codex', ticket: 'T-47-02', graph_dir: graphDir,
    started_at: '2026-10-06T00:00:00.000Z', result: path.join(directory, 'result.jsonl') });
  writeJson(path.join(directory, 'args.json'), { scope: { run_id: 'original-run', worktree: root } });
  const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');
  try {
    let genericTick = 0;
    await deliverDispatch.waitOnce(id, { stateDir, pidLive: () => true,
      timeoutMs: 20, intervalMs: 10, clock: () => genericTick,
      sleep: async (ms) => { genericTick += ms; } });
    assert.equal(overhead.readStream(graphDir).rows.length, 0,
      'generic wait must not mutate a live contained planner worktree');
    for (let attempt = 0; attempt < 2; attempt++) {
      let tick = 0;
      const result = await deliverDispatch.waitOnce(id, { stateDir,
        waitScope: { run_id: 'original-run', worktree: root }, pidLive: () => true,
        timeoutMs: 20, intervalMs: 10, clock: () => tick,
        sleep: async (ms) => { tick += ms; } });
      assert.equal(result.status, 'running');
      assert.equal(result.exit_code, 3);
    }
    const rows = overhead.readStream(graphDir).rows;
    assert.equal(rows.length, 2, 'same original observations are deduplicated in storage');
    assert.ok(rows.every((row) => row.actor === 'parent' && row.run_id === 'original-run'
      && row.dispatch_id === id && row.counts.polls === 1 && row.counts.model_turns === null));
    const lost = await deliverDispatch.waitOnce('lost-original', { stateDir });
    assert.equal(lost.status, 'lost');
    assert.equal(lost.exit_code, 2);
    const failed = await deliverDispatch.waitOnce(id, { stateDir, pidLive: () => false, recordWakeEvent() {} });
    assert.equal(failed.status, 'exited-failed');
    assert.equal(overhead.readStream(graphDir).rows.length, 2);
  } finally { cleanup(root); }
});

test('an unknown dispatch id reports lost', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-deliver-dispatch-state-'));
  try {
    const status = deliverDispatch.statusOnce('dd-does-not-exist', { stateDir });
    assert.equal(status.status, 'lost');
  } finally {
    cleanup(stateDir);
  }
});

test('pr-sentinel runs the round preflight first, and a stubbed refusal propagates before any spawn', async () => {
  const fixture = shipyardFixture('T-08-08');
  writeJson(path.join(fixture.graphDir, 'tickets.json'), { tickets: { [fixture.id]: ticketRow() } });
  writeJson(path.join(fixture.graphDir, 'delivery-state.json'), {
    [fixture.id]: { status: 'pr-open', pr: 501, pr_base: 'main', checks: { failing: 1, pending: 0 } },
  });
  try {
    let spawnCalled = false;
    await assert.rejects(
      () => deliverDispatch.launch(['--runtime', 'claude', '--ticket', fixture.id, '--role', 'pr-sentinel'], {
        cwd: fixture.root,
        stateDir: sharedStateDir,
        preflightRound() { throw new Error('stubbed preflight refusal'); },
        spawn() { spawnCalled = true; return { pid: 1, unref() {}, on() {} }; },
      }),
      /stubbed preflight refusal/,
    );
    assert.equal(spawnCalled, false);
  } finally {
    cleanup(fixture.root);
  }
});

test('a target-project fixture gets NEUTRAL guides; a fixture with a committed shipyard manifest gets neither', async () => {
  const target = targetProjectFixture('T-09-09');
  const shipyard = shipyardFixture('T-10-10');
  try {
    let targetCaptured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', target.id, '--role', 'executor', '--graph-dir', target.graphDir], {
      cwd: target.ticketWorktree,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        targetCaptured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(targetCaptured.args.prBodyGuide, prHygiene.NEUTRAL_PR_BODY_GUIDE);
    assert.equal(targetCaptured.args.deliveryRulesHint, prHygiene.NEUTRAL_DELIVERY_RULES_HINT);
    validateRequest('executors', targetCaptured);

    let shipyardCaptured;
    await deliverDispatch.launch(['--runtime', 'claude', '--ticket', shipyard.id, '--role', 'executor'], {
      cwd: shipyard.root,
      stateDir: sharedStateDir,
      spawn(command, spawnArgs) {
        const requestFile = spawnArgs[spawnArgs.indexOf('--request-file') + 1];
        shipyardCaptured = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
        return { pid: 999999, unref() {}, on() {} };
      },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(shipyardCaptured.args, 'prBodyGuide'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(shipyardCaptured.args, 'deliveryRulesHint'), false);
    validateRequest('executors', shipyardCaptured);
  } finally {
    cleanup(target.projectRoot, target.ticketWorktree, shipyard.root);
  }
});

function brokenBundle(runtimeRoot) {
  const bundle = path.join(runtimeRoot, 'shipyard');
  fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), '{}');
  return path.join(bundle, 'scripts');
}

function noSpawn() {
  return () => { throw new Error('spawn must not be called'); };
}

function dispatchDirs(stateDir) {
  try { return fs.readdirSync(stateDir).filter((name) => name.startsWith('dd-')); } catch { return []; }
}

test('launch isolates os.homedir from the real authority namespace', () => {
  assert.equal(os.homedir(), testAuthorityHome);
});

test('launch refuses a broken installed bundle before creating a dispatch directory or spawning', async () => {
  const fixture = shipyardFixture('T-50-61');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-refuse-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-bundle-'));
  const stderr = [];
  try {
    await assert.rejects(deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root, stateDir, hostScriptDir: brokenBundle(runtimeRoot), spawn: noSpawn(),
      preflightStderr: { write(text) { stderr.push(text); } },
    }), (error) => error.code === 'PREFLIGHT_REFUSED');
    assert.match(stderr.join(''), /hint\[BUNDLE_MANIFEST_INVALID\]/);
    assert.deepEqual(dispatchDirs(stateDir), []);
  } finally {
    cleanup(fixture.root, stateDir, runtimeRoot);
  }
});

test('launch hands the spawned host the launchEnvironment output with the preserved variables', async () => {
  const fixture = shipyardFixture('T-50-62');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-env-'));
  try {
    let seen;
    await deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root, stateDir, env: { SHIPYARD_TEST_PRESERVED: 'kept' },
      spawn(_command, _args, spawnOptions) { seen = spawnOptions.env; return { pid: 999999, unref() {}, on() {} }; },
    });
    assert.equal(seen.SHIPYARD_TEST_PRESERVED, 'kept');
    assert.equal(seen.SHIPYARD_GRAPH_DIR, fs.realpathSync(fixture.graphDir));
    assert.equal(seen.HOME, process.env.HOME);
  } finally {
    cleanup(fixture.root, stateDir);
  }
});

const authorityLstatSync = fs.lstatSync;
let unreadableAuthorityRun;
test('an unreadable authority namespace does not stop a healthy launch but other findings still refuse', () => {
  unreadableAuthorityRun = (async () => {
    const fixture = shipyardFixture('T-50-63');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-eperm-'));
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-bundle-'));
    const original = fs.lstatSync;
    const injected = mock.method(fs, 'lstatSync', function (target, ...rest) {
      if (String(target).includes('role-artifact-authority')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return original.call(this, target, ...rest);
    });
    const stderr = [];
    const sink = { write(text) { stderr.push(text); } };
    try {
      let spawned = 0;
      await deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
        cwd: fixture.root, stateDir, preflightStderr: sink,
        spawn() { spawned += 1; return { pid: 999999, unref() {}, on() {} }; },
      });
      assert.equal(spawned, 1);
      assert.equal(/hint\[/.test(stderr.join('')), false);
      const before = dispatchDirs(stateDir).length;
      await assert.rejects(deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
        cwd: fixture.root, stateDir, hostScriptDir: brokenBundle(runtimeRoot), spawn: noSpawn(), preflightStderr: sink,
      }), (error) => error.code === 'PREFLIGHT_REFUSED');
      assert.equal(dispatchDirs(stateDir).length, before);
    } finally {
      injected.mock.restore();
      cleanup(fixture.root, stateDir, runtimeRoot);
    }
  })();
  return unreadableAuthorityRun;
});

test('a refused launch names the runtime delivery host in its remedy, never deliver-dispatch', async () => {
  const fixture = shipyardFixture('T-50-64');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-host-name-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-host-bundle-'));
  const stderr = [];
  try {
    await assert.rejects(deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root, stateDir, hostScriptDir: brokenBundle(runtimeRoot), spawn: noSpawn(),
      preflightStderr: { write(text) { stderr.push(text); } },
    }), (error) => error.code === 'PREFLIGHT_REFUSED');
    const text = stderr.join('');
    assert.match(text, /codex-delivery-host\.cjs --preflight/);
    assert.equal(text.includes('deliver-dispatch.cjs'), false);
  } finally {
    cleanup(fixture.root, stateDir, runtimeRoot);
  }
});

test('decomposition build carries repositoryIdentity for a path with a space and an origin remote', () => {
  const fixture = planningBuilderFixture('INV-50-20', 'shipyard deliver dispatch id-');
  try {
    git(fixture.root, 'remote', 'add', 'origin', 'https://github.com/Example/Repo.git');
    const identity = fs.realpathSync(path.join(fixture.root, '.git'));
    const request = deliverDispatch.build(['decomposition', fixture.invId, '--phase', '44', '--runtime', 'codex'],
      { cwd: fixture.root, graphDir: fixture.graphDir });
    assert.equal(request.scope.repository, identity);
    assert.ok(request.subject.endsWith(`;repository=${identity}`));
    assert.equal(request.scope.ticket, request.subject);
    assert.equal(request.subject.includes('example/repo'), false);
  } finally {
    cleanup(fixture.root);
  }
});

test('preflight reads the launch graph directory project, not the worktree project', async () => {
  const fixture = shipyardFixture('T-50-64');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-dispatch-graph-'));
  try {
    let graphSeen;
    await deliverDispatch.launch(['--runtime', 'codex', '--ticket', fixture.id, '--role', 'executor'], {
      cwd: fixture.root, stateDir,
      spawn(_command, _args, spawnOptions) { graphSeen = spawnOptions.env.SHIPYARD_GRAPH_DIR; return { pid: 999999, unref() {}, on() {} }; },
    });
    assert.equal(graphSeen, fs.realpathSync(fixture.graphDir));
  } finally {
    cleanup(fixture.root, stateDir);
  }
});

for (const jira of [null, 'PRJ-42']) test(`phase code-review builders use graph epic identity (${jira})`, () => {
  const f = shipyardFixture();
  try {
    const branch = jira ? 'feat/PRJ-42-demo' : 'epic/01-demo';
    git(f.root, 'checkout', '-q', '-b', branch);
    const graph = { epics: { 1: { branch, phaseDir: '01-demo', repos: [null], jira } },
      tickets: { [f.id]: { ...ticketRow(), epic: branch, phaseDir: '01-demo', repo: null } } };
    writeJson(path.join(f.graphDir, 'tickets.json'), graph);
    writeJson(path.join(f.root, '.planning/config.json'), { git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'hold' } });
    const live = { number: 801, state: 'OPEN', headRefName: branch, headRefOid: git(f.root, 'rev-parse', 'HEAD'),
      baseRefName: 'main', baseRefOid: git(f.root, 'rev-parse', 'HEAD') };
    const options = { cwd: f.root, graphDir: f.graphDir, getPullRequest: () => live };
    const args = ['code-review', '01-demo', '--phase', '1', '--pr', '801'];
    for (const runtime of ['claude', 'codex']) {
      const request = deliverDispatch.build([...args, '--runtime', runtime], options);
      assert.strictEqual(request.role, 'code-review');
      if (runtime === 'claude') assert.strictEqual(parseRequest(request).role, 'code-review');
      else {
        const { scope, graph_dir, ...launch } = request;
        assert.strictEqual(validateArgs(launch).request.role, 'code-review');
        assert.strictEqual(require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs')
          .parseSubject('architecture-review', scope.ticket).repository,
        require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.root));
      }
    }
    for (const argv of [args.slice(0, 2), args.slice(0, 4), [args[0], args[1], '--pr', '801'],
      [...args, '--unknown', 'x'], [args[0], args[1], '--repo', 'owner/repo']])
      assert.throws(() => deliverDispatch.build(argv, options), /requires|unsupported/);
    for (const patch of [{ baseRefName: 'other' }, { headRefOid: 'a'.repeat(40) }]) {
      assert.throws(() => deliverDispatch.build(args, { ...options, getPullRequest: () => ({ ...live, ...patch }) }));
    }
    for (const unknown of ['unknown', jira ? 'epic/01-demo' : 'feat/PRJ-42-demo', graph.tickets[f.id].branch]) {
      graph.epics[1].branch = unknown;
      writeJson(path.join(f.graphDir, 'tickets.json'), graph);
      assert.throws(() => deliverDispatch.build(args, options), /unmatched|ticket PR/);
    }
    graph.epics[1].branch = branch;
    writeJson(path.join(f.graphDir, 'tickets.json'), graph);
    const arch = ['arch-review', ...args.slice(1)];
    assert.throws(() => deliverDispatch.build(arch, options), /phase code review is owed.*delivery_pipeline.code_review.*report/);
    writeJson(path.join(f.root, '.planning/config.json'), { git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'report' } });
    assert.strictEqual(deliverDispatch.build(arch, options).role, 'arch-review');
    graph.tickets[f.id].branch = branch; delete graph.epics[1];
    writeJson(path.join(f.graphDir, 'tickets.json'), graph);
    assert.throws(() => deliverDispatch.build(args, options), /ticket PR/);
    assert.throws(() => deliverDispatch.build(arch, options), /ticket PR/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('overlapping authority callbacks wait for the unreadable probe to restore lstatSync', async () => {
  assert.notStrictEqual(fs.lstatSync, authorityLstatSync);
  await unreadableAuthorityRun;
  assert.strictEqual(fs.lstatSync, authorityLstatSync);
});

for (const jira of [null, 'PRJ-42']) test(`default hold guards phase architecture builders (${jira})`, async () => {
  await unreadableAuthorityRun;
  assert.strictEqual(fs.lstatSync, authorityLstatSync);
  const f = require('../fixtures/code-review/artifact-fixture.cjs').fixture();
  const artifact = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  try {
    const branch = jira ? 'feat/PRJ-42-review' : f.branch;
    if (jira) f.git(['branch', '-m', branch]);
    f.graph.epics = { 52: { branch, phaseDir: f.phase, repos: [null], jira } };
    Object.assign(f.graph.tickets['T-52-01'], { epic: branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
    const config = { git: { base_branch: 'main' } };
    writeJson(path.join(f.root, '.planning/config.json'), config);
    assert.strictEqual(Object.hasOwn(config.delivery_pipeline || {}, 'code_review'), false);
    f.writeGraph();
    const live = () => ({ number: 52, state: 'OPEN', headRefName: branch, headRefOid: f.git(['rev-parse', 'HEAD']),
      baseRefName: 'main', baseRefOid: f.base });
    const options = { cwd: f.root, graphDir: f.graphDir, getPullRequest: live };
    const args = ['arch-review', f.phase, '--phase', '52', '--pr', '52'];
    for (const runtime of ['claude', 'codex']) {
      assert.throws(() => deliverDispatch.build([...args, '--runtime', runtime], options),
        /phase code review is owed.*delivery_pipeline.code_review.*report/);
    }
    const advance = round => {
      fs.writeFileSync(path.join(f.root, 'round.txt'), String(round));
      f.git(['add', 'round.txt']); f.git(['commit', '--quiet', '-m', 'round ' + round]);
    };
    advance(1);
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52,
      repository: target.repositoryIdentity(f.root), branch, pr: 52, head: live().headRefOid, base: f.base });
    artifact.sealJudgment(f.input(binding, 1, null,
      { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [] }));
    for (const runtime of ['claude', 'codex']) {
      assert.strictEqual(deliverDispatch.build([...args, '--runtime', runtime], options).role, 'arch-review');
    }
    const unknownBranch = jira ? 'epic/52-unmatched' : 'feat/PRJ-42-unmatched';
    f.git(['branch', '-m', unknownBranch]);
    const unknown = { ...options, getPullRequest: () => ({ ...live(), headRefName: unknownBranch }) };
    for (const runtime of ['claude', 'codex']) {
      assert.throws(() => deliverDispatch.build([...args, '--runtime', runtime], unknown),
        /phase code review is unmatched.*delivery_pipeline.code_review.*report/);
    }
    f.git(['branch', '-m', branch]);
    advance(2);
    for (const runtime of ['claude', 'codex']) {
      assert.throws(() => deliverDispatch.build([...args, '--runtime', runtime], options),
        /phase code review is owed.*delivery_pipeline.code_review.*report/);
    }
  } finally { f.cleanup(); }
});

done();
