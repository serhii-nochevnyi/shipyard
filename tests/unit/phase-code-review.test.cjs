'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phase-review-authority-')));
const homedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = homedir; fs.rmSync(home, { recursive: true, force: true }); });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const { createDispatchBoundary } = require(path.join(scripts, 'dispatch-boundary.cjs'));
const flow = require(path.join(scripts, 'phase-code-review.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const core = require(path.join(scripts, 'code-review-core.cjs'));
const builder = require(path.join(scripts, 'deliver-dispatch.cjs'));
const { fixture: artifactFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
const shapes = [null, 'PRJ-42'];
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const raw = (complete = true, findings = []) => ({ review_completeness: complete ? 'complete' : 'incomplete',
  limitations: complete ? [] : ['unread diff'], unresolved_sources: [], findings, dispositions: [] });
const blocker = { id: 'fix-source', rule: 'source-error', severity: 'BLOCKER', path: 'source.js', line: 1,
  line_text: fs.readFileSync(path.join(__dirname, '../fixtures/code-review/source.js'), 'utf8').split('\n')[0],
  summary: 'Repair the failing source', failure_scenario: 'A caller receives the wrong result.',
  fix_ticket: { title: 'Repair source', scope: 'Correct the cited failure', files: ['source.js'], depends_on: [] } };

function withFlowDependencies(overrides, run) {
  const Module = require('node:module');
  const filename = require.resolve(path.join(scripts, 'phase-code-review.cjs'));
  const originalLoad = Module._load, originalModule = require.cache[filename];
  delete require.cache[filename];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && Object.hasOwn(overrides, request)) return overrides[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return run(require(filename)); }
  finally {
    Module._load = originalLoad;
    delete require.cache[filename];
    if (originalModule) require.cache[filename] = originalModule;
  }
}

function fixture(jira) {
  const f = artifactFixture();
  const branch = jira ? 'feat/PRJ-42-review' : f.branch;
  if (jira) f.git(['branch', '-m', branch]);
  f.graph.epics = { '052': { branch, phaseDir: f.phase, repos: [null], jira } };
  Object.assign(f.graph.tickets['T-52-01'], { epic: branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
  const mode = value => write(path.join(f.root, '.planning/config.json'),
    { git: { base_branch: 'main' }, delivery_pipeline: { code_review: value } });
  mode('hold'); f.writeGraph();
  const live = () => ({ number: 52, state: 'OPEN', headRefName: branch, headRefOid: f.git(['rev-parse', 'HEAD']),
    baseRefName: 'main', baseRefOid: f.base });
  const input = () => ({ phase: 52, phaseDirectory: f.phase, pr: 52, worktree: f.root, graphDir: f.graphDir, live: live() });
  const options = { cwd: f.root, graphDir: f.graphDir, defaultBranch: 'main', getPullRequest: live };
  const args = role => [role, f.phase, '--phase', '52', '--pr', '52'];
  const advance = n => {
    fs.writeFileSync(path.join(f.root, 'round.txt'), String(n));
    f.git(['add', 'round.txt']); f.git(['commit', '--quiet', '-m', 'round ' + n]);
    if (n > 1) {
      const id = 'T-52-0' + n;
      f.graph.tickets[id] = { ...f.graph.tickets['T-52-01'], branch: 'fix/' + id,
        plan: '.planning/phases/' + f.phase + '/52-0' + n + '-PLAN.md' };
      f.state[id] = { status: 'merged', pr: n + 10, head_sha: live().headRefOid, merge_sha: live().headRefOid };
    }
    f.writeGraph();
    return target.phaseBinding({ graph: f.graph, state: f.state, phase: 52, repository: target.repositoryIdentity(f.root),
      branch, pr: 52, head: live().headRefOid, base: f.base });
  };
  return { ...f, inputArtifact: f.input, branch, mode, live, input, options, args, advance };
}

for (const jira of shapes) {
  test('exact graph matching, including unknown and ambiguous heads: ' + jira, () => {
    const f = fixture(jira);
    try {
      const match = (head, graph = f.graph, phase) => flow.matchEpicPullRequest({ graph, state: f.state,
        live: { headRefName: head }, repo: null, phase });
      assert.deepEqual(match(f.branch), { kind: 'epic', phase: 52, phase_dir: f.phase, branch: f.branch });
      assert.equal(match('feat/review-ticket').kind, 'ticket');
      f.state['T-52-01'].pr_branch = 'recorded-ticket';
      assert.equal(match('recorded-ticket').kind, 'ticket');
      for (const head of ['unknown', jira ? 'epic/52-review' : 'feat/PRJ-42-review'])
        assert.equal(match(head).kind, 'unmatched');
      for (const mutate of [
        graph => { graph.epics['53'] = { ...graph.epics['052'] }; },
        graph => { graph.epics['052'].repos = ['other/repo']; },
        graph => { graph.tickets['T-52-01'].epic = 'different'; },
        graph => { delete graph.epics; },
      ]) {
        const graph = structuredClone(f.graph); mutate(graph);
        assert.equal(match(f.branch, graph).kind, 'unmatched');
      }
      assert.equal(match(f.branch, f.graph, 53).kind, 'unmatched');
      assert.equal(flow.matchEpicPullRequest({ graph: null, live: f.live() }).kind, 'unmatched');
    } finally { f.cleanup(); }
  });

  test('default hold gates the CLI and verifier on current graph epic evidence: ' + jira, () => {
    const f = fixture(jira);
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-default-')));
    try {
      f.mode();
      assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.root, '.planning/config.json')))
        .delivery_pipeline, 'code_review'), false);
      const prFile = path.join(temporary, 'pr.json');
      fs.writeFileSync(path.join(temporary, 'gh'),
        '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.REVIEW_PR));\n', { mode: 0o755 });
      const gate = (patch = {}) => {
        write(prFile, { ...f.live(), ...patch });
        return spawnSync(process.execPath, [path.join(scripts, 'phase-code-review.cjs'), 'gate', f.phase,
          '--phase', '52', '--pr', '52', '--worktree', f.root, '--graph', f.graphDir], {
          cwd: temporary, encoding: 'utf8', env: { ...process.env, HOME: home,
            PATH: temporary + path.delimiter + process.env.PATH, REVIEW_PR: prFile } });
      };
      const refused = gate();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /owed.*delivery_pipeline.code_review.*report/);
      const owed = flow.verifyCodeReview(f.input());
      assert.equal(owed.mode, 'hold'); assert.equal(owed.state, 'owed'); assert.equal(owed.ok, false);
      assert.match(owed.reason, /delivery_pipeline.code_review.*report/);
      const binding = f.advance(1);
      artifact.sealJudgment(artifactInput(f, binding, raw()));
      const passed = gate();
      assert.equal(passed.status, 0, passed.stderr);
      assert.equal(flow.verifyCodeReview(f.input()).ok, true);
      const unknown = { ...f.live(), headRefName: jira ? 'epic/52-unmatched' : 'feat/PRJ-42-unmatched' };
      const unmatchedGate = gate(unknown);
      assert.equal(unmatchedGate.status, 1, unmatchedGate.stderr);
      assert.match(unmatchedGate.stderr, /unmatched.*delivery_pipeline.code_review.*report/);
      const unmatched = flow.verifyCodeReview({ ...f.input(), live: unknown });
      assert.notEqual(unmatched, null);
      assert.equal(unmatched.mode, 'hold'); assert.equal(unmatched.state, 'unmatched'); assert.equal(unmatched.ok, false);
      assert.match(unmatched.reason, /delivery_pipeline.code_review.*report/);
      f.advance(2);
      const moved = gate();
      assert.equal(moved.status, 1, moved.stderr);
      assert.match(moved.stderr, /owed.*delivery_pipeline.code_review.*report/);
    } finally { f.cleanup(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });

  test('owed, exact reuse, moved head/base, incomplete retry and named exits: ' + jira, () => {
    const f = fixture(jira);
    try {
      let state = flow.status(f.input());
      assert.equal(state.state, 'owed'); assert.equal(state.round, 1); assert.equal(state.scope, 'full');
      assert.match(flow.evaluateGate(f.input()).message, /build code-review/);
      const binding = f.advance(1);
      artifact.sealJudgment(artifactInput(f, binding, raw()));
      state = flow.status(f.input());
      assert.equal(state.state, 'current'); assert.equal(state.reuse, true);
      assert.equal(flow.evaluateGate(f.input()).ok, true);
      assert.equal(flow.status({ ...f.input(), live: { ...f.live(), baseRefOid: f.live().headRefOid } }).state, 'owed');
      f.advance(2);
      assert.equal(flow.status(f.input()).state, 'owed');
      artifact.sealJudgment(artifactInput(f, currentBinding(f), raw(false), 2, binding.subject.match(/;head=([^;]+)/)[1]));
      state = flow.status(f.input());
      assert.equal(state.state, 'owed'); assert.equal(state.retry, true); assert.equal(state.reuse, false);
      assert.equal(state.review_completeness, 'incomplete');
      assert.match(state.reason, /incomplete/);
      const refusal = flow.evaluateGate(f.input());
      for (const word of ['owed', 'incomplete', 'delivery_pipeline.code_review', 'report', path.join(f.root, '.planning/config.json')])
        assert.ok(refusal.message.includes(word), word);
      assert.throws(() => builder.build(f.args('arch-review'), f.options), /phase code review is owed/);
      for (const mode of ['hold', 'report']) {
        f.mode(mode);
        const unknown = { ...f.input(), live: { ...f.live(), headRefName: 'unknown' } };
        assert.equal(flow.status(unknown).state, 'unmatched'); assert.equal(flow.status(unknown).verdict, null);
        assert.equal(flow.evaluateGate(unknown).ok, mode === 'report');
        assert.equal(flow.verifyCodeReview(unknown).ok, mode === 'report');
        assert.throws(() => flow.status({ ...f.input(), live: { ...f.live(), headRefName: 'feat/review-ticket' } }), /ticket PR/);
      }
      assert.equal(builder.build(f.args('arch-review'), f.options).role, 'arch-review');
    } finally { f.cleanup(); }
  });

  for (const mode of ['hold', 'report']) test('D37 fix tickets change the ticket-set digest between rounds and the cap still holds: ' + jira + ' ' + mode, () => {
    const f = fixture(jira);
    try {
      f.mode(mode);
      const digests = [], heads = [];
      for (let round = 1; round <= 3; round++) {
        const binding = f.advance(round); digests.push(binding.membership);
        const owed = flow.status(f.input());
        assert.equal(owed.state, 'owed'); assert.equal(owed.round, round);
        assert.equal(owed.scope, round === 1 ? 'full' : 'delta'); assert.equal(owed.rounds_used, round - 1);
        artifact.sealJudgment(artifactInput(f, binding, raw(true, [blocker]), round, heads.at(-1) || null));
        heads.push(f.live().headRefOid);
        const current = flow.status(f.input());
        assert.equal(current.state, 'current'); assert.equal(current.repair, round < 3 ? 'tickets' : 'human');
        const refused = flow.evaluateGate(f.input());
        assert.equal(refused.ok, mode === 'report'); assert.match(refused.message, /needs-fix/);
        let diagnostic = '';
        const fixes = flow.fixTickets(f.input(), { stderr: { write: text => { diagnostic += text; } } });
        assert.equal(fixes.length, round < 3 ? 1 : 0);
        if (fixes.length) {
          assert.deepEqual(Object.keys(fixes[0]).sort(), ['depends_on', 'files', 'finding_id', 'scope', 'title']);
          assert.deepEqual(fixes[0].files, ['source.js']);
          if (round === 1 && mode === 'hold') assertFixGraph(fixes[0]);
        } else {
          assert.match(diagnostic, /no longer re-check.*BLOCKERs stay visible.*delivery_pipeline.code_review.*report/);
        }
        const configPath = path.join(f.root, '.planning/config.json');
        const originalConfig = fs.readFileSync(configPath);
        f.mode(mode === 'hold' ? 'report' : 'hold');
        const stale = flow.status(f.input());
        assert.equal(stale.state, round === 3 ? 'limit' : 'owed'); assert.equal(stale.rounds_used, round);
        assert.equal(flow.fixTickets(f.input(), { stderr: { write() {} } }).length, 0);
        fs.writeFileSync(configPath, originalConfig);
        const restored = flow.status(f.input());
        assert.equal(restored.state, 'current'); assert.equal(restored.verdict, current.verdict);
        assert.equal(restored.artifact_ref, current.artifact_ref);
        assert.equal(restored.rounds_used, current.rounds_used);
      }
      digests.push(f.advance(4).membership); assert.equal(new Set(digests).size, 4);
      const status = flow.status(f.input());
      assert.equal(status.state, 'limit'); assert.equal(status.rounds_used, 3); assert.equal(status.round, null);
      const gate = flow.evaluateGate(f.input());
      assert.equal(gate.ok, mode === 'report'); assert.match(gate.message, /three rounds.*delivery_pipeline.code_review.*report/);
      f.mode('hold');
      const held = flow.evaluateGate(f.input());
      assert.equal(held.ok, false);
      assert.throws(() => builder.build(f.args('arch-review'), f.options), error => error.message.includes(held.message));
      f.mode('report'); assert.equal(builder.build(f.args('arch-review'), f.options).role, 'arch-review');
    } finally { f.cleanup(); }
  });

  test('incomplete full review and complete delta never open the gate: ' + jira, () => {
    const f = fixture(jira);
    try {
      const first = f.advance(1), head = f.live().headRefOid;
      artifact.sealJudgment(artifactInput(f, first, raw(false)));
      assert.equal(flow.status(f.input()).retry, true);
      const second = f.advance(2);
      assert.equal(flow.status(f.input()).round, 1);
      artifact.sealJudgment(artifactInput(f, second, raw(true, [blocker]), 2, head));
      const status = flow.status(f.input());
      assert.equal(status.state, 'owed'); assert.equal(status.retry, true); assert.equal(status.rounds_used, 0);
      assert.equal(flow.evaluateGate(f.input()).ok, false);
    } finally { f.cleanup(); }
  });
}

function currentBinding(f) {
  return target.phaseBinding({ graph: f.graph, state: f.state, phase: 52, repository: target.repositoryIdentity(f.root),
    branch: f.branch, pr: 52, head: f.live().headRefOid, base: f.base });
}
function artifactInput(f, binding, result, round = 1, priorHead = null) {
  return retainPlanningInput(f, f.inputArtifact(binding, round, priorHead, result));
}

function assertFixGraph(fix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-plan-')));
  try {
    execFileSync('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'source.js'), 'source');
    const directory = path.join(root, '.planning/phases/52-review'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '52-01-PLAN.md'), ['---', 'phase: 52', 'plan: 1',
      'title: ' + JSON.stringify(fix.title), 'type: implementation', 'wave: 1', 'depends_on: []',
      'requirements: [REQ-211]', 'files_modified: ' + JSON.stringify(fix.files),
      'delivery:', '  ticket: T-52-01', '  risk: low', '---', '', '## Scope', fix.scope, ''].join('\n'));
    const validated = spawnSync(process.execPath, [path.join(scripts, 'validate-graph.cjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.planning/graph/tickets.json'))).tickets['T-52-01'].files, fix.files);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const jira of shapes) test('every mode consumer follows the project graph across checkouts: ' + jira, () => {
  const f = fixture(jira);
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-checkouts-')));
  try {
    f.mode('report');
    f.git(['add', '.planning/config.json', '.planning/graph']); f.git(['commit', '--quiet', '-m', 'tracked worktree config']);
    const head = f.git(['rev-parse', 'HEAD']);
    f.git(['switch', '--quiet', 'main']);
    const linked = path.join(parent, 'linked');
    f.git(['worktree', 'add', '--quiet', linked, f.branch]);
    const unrelated = path.join(parent, 'unrelated');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', f.root, unrelated]);
    execFileSync('git', ['-C', unrelated, 'checkout', '--quiet', f.branch]);
    fs.rmSync(path.join(unrelated, '.planning'), { recursive: true, force: true });
    fs.mkdirSync(f.graphDir, { recursive: true }); f.writeGraph();
    const live = { ...f.live(), headRefOid: head };
    for (const mode of ['hold', 'report']) {
      f.mode(mode);
      write(path.join(linked, '.planning/config.json'), { git: { base_branch: 'main' },
        delivery_pipeline: { code_review: mode === 'hold' ? 'report' : 'hold' } });
      for (const worktree of [linked, unrelated]) {
        const input = { ...f.input(), worktree, live };
        const options = { ...f.options, cwd: worktree, getPullRequest: () => live };
        const resolved = flow.resolveCodeReviewMode({ graphDir: f.graphDir, worktree });
        assert.equal(resolved.mode, mode); assert.equal(resolved.project_root, f.root);
        assert.equal(resolved.config_path, path.join(f.root, '.planning/config.json'));
        assert.equal(flow.status(input).mode, mode);
        const gate = flow.evaluateGate(input);
        assert.equal(gate.ok, mode === 'report');
        assert.equal(flow.verifyCodeReview(input).ok, mode === 'report');
        if (mode === 'hold') assert.throws(() => builder.build(f.args('arch-review'), options),
          error => error.message.includes(resolved.config_path));
        else assert.equal(builder.build(f.args('arch-review'), options).role, 'arch-review');
      }
    }
    const probe = path.join(parent, 'resolve.cjs');
    fs.writeFileSync(probe, `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(scripts, 'phase-code-review.cjs'))}).resolveCodeReviewMode({worktree:process.argv[2]})));`);
    const env = { ...process.env }; delete env.SHIPYARD_GRAPH_DIR;
    const resolved = spawnSync(process.execPath, [probe, linked], { cwd: parent, env, encoding: 'utf8' });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).graph_dir, f.graphDir);
    const missing = spawnSync(process.execPath, [probe, parent], { cwd: parent, env, encoding: 'utf8' });
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), { mode: 'hold', project_root: null,
      graph_dir: null, config_path: null, source: 'default' });
  } finally { f.cleanup(); fs.rmSync(parent, { recursive: true, force: true }); }
});

for (const jira of shapes) test('the mode property has one reader and unknown PRs read no sealed verdict: ' + jira, () => {
  for (const name of ['deliver-dispatch.cjs', 'gate-trailer.cjs'])
    assert.doesNotMatch(fs.readFileSync(path.join(scripts, name), 'utf8'), /(?:config|cfg)\.code_review|\[['"]code_review['"]\]/);
  const source = fs.readFileSync(path.join(scripts, 'phase-code-review.cjs'), 'utf8');
  const before = source.indexOf('function resolveCodeReviewMode('), after = source.indexOf('\nfunction git(');
  const outside = source.slice(0, before) + source.slice(after);
  assert.doesNotMatch(outside, /(?:config|DEFAULTS)\.code_review/);
  const f = fixture(jira);
  const originalLoad = require('node:module')._load;
  const originalModule = require.cache[require.resolve(path.join(scripts, 'phase-code-review.cjs'))];
  try {
    assert.equal(Object.isFrozen(artifact), true);
    let reads = 0;
    const unread = () => { reads++; assert.fail('unmatched must not read seals'); };
    withFlowDependencies({ './role-artifact.cjs': { ...artifact,
      currentCodeReviewVerdict: unread, priorCodeReviewVerdicts: unread } }, isolated => {
      for (const mode of ['hold', 'report']) {
        f.mode(mode);
        const input = { ...f.input(), live: { ...f.live(), headRefName: 'unmatched' } };
        assert.equal(isolated.status(input).state, 'unmatched');
        assert.equal(isolated.evaluateGate(input).ok, mode === 'report');
        assert.equal(isolated.verifyCodeReview(input).state, 'unmatched');
        assert.equal(isolated.verifyCodeReview({ ...input, live: { ...input.live, baseRefName: 'ticket-base' } }), null);
        assert.equal(isolated.verifyCodeReview({ ...input, live: { ...input.live, headRefName: 'feat/review-ticket' } }), null);
      }
      assert.throws(() => isolated.status(f.input()), /unmatched must not read seals/);
      assert.equal(reads, 1, 'the scoped fixture intercepts a real matched verdict lookup');
    });
    assert.equal(require('node:module')._load, originalLoad);
    assert.equal(require.cache[require.resolve(path.join(scripts, 'phase-code-review.cjs'))], originalModule);
    assert.equal(Object.isFrozen(artifact), true);
    assert.equal(flow.status(f.input()).state, 'owed');
  } finally { f.cleanup(); }
});

for (const jira of shapes) test('CLI status, gate, repair and usage exits are stable: ' + jira, () => {
  const f = fixture(jira);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-cli-')));
  try {
    const prFile = path.join(temporary, 'pr.json');
    const gh = path.join(temporary, 'gh');
    fs.writeFileSync(gh, '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.REVIEW_PR));\n', { mode: 0o755 });
    const run = (verb, patch = {}, extra = []) => {
      write(prFile, { ...f.live(), ...patch });
      return spawnSync(process.execPath, [path.join(scripts, 'phase-code-review.cjs'), verb, f.phase,
        '--phase', '52', '--pr', '52', '--worktree', f.root, '--graph', f.graphDir, ...extra], {
        cwd: temporary, encoding: 'utf8', env: { ...process.env, HOME: home,
          PATH: temporary + path.delimiter + process.env.PATH, REVIEW_PR: prFile } });
    };
    for (const mode of ['hold', 'report']) {
      f.mode(mode);
      const status = run('status');
      assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'owed');
      const gate = run('gate');
      assert.equal(gate.status, mode === 'hold' ? 1 : 0, gate.stderr);
      assert.equal(gate.stderr.trim().split('\n').length, 1);
      assert.match(gate.stderr, mode === 'hold' ? /build code-review.*delivery_pipeline.code_review.*report/ : /nothing is held/);
      const unknown = run('status', { headRefName: 'unknown' });
      assert.equal(unknown.status, 0, unknown.stderr); assert.equal(JSON.parse(unknown.stdout).state, 'unmatched');
      const unknownGate = run('gate', { headRefName: 'unknown' });
      assert.equal(unknownGate.status, mode === 'hold' ? 1 : 0, unknownGate.stderr);
      assert.match(unknownGate.stderr, /unmatched/);
      const fixes = run('fix-tickets'); assert.equal(fixes.status, 0, fixes.stderr); assert.deepEqual(JSON.parse(fixes.stdout), []);
      assert.equal(run('status', { headRefName: 'feat/review-ticket' }).status, 1);
    }
    assert.equal(run('status', {}, ['--unknown', 'value']).status, 2);
    assert.equal(run('status', { headRefOid: 'a'.repeat(40) }).status, 1);
    assert.equal(run('status', { baseRefName: 'ticket-base' }).status, 1);
    const usage = spawnSync(process.execPath, [path.join(scripts, 'phase-code-review.cjs'), 'gate', f.phase], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally { f.cleanup(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

for (const jira of shapes) test('D37 a complete delta pass opens the hold and unrelated heads spend no rounds: ' + jira, () => {
  const f = fixture(jira);
  try {
    const first = f.advance(1), head = f.live().headRefOid;
    artifact.sealJudgment(artifactInput(f, first, raw()));
    artifact.sealJudgment(artifactInput(f, f.advance(2), raw(), 2, head));
    assert.equal(flow.status(f.input()).state, 'current');
    assert.equal(flow.evaluateGate(f.input()).ok, true);
    assert.deepEqual(flow.fixTickets(f.input()), []);
    f.git(['reset', '--hard', f.base]);
    f.advance(3);
    const next = flow.status(f.input());
    assert.equal(next.rounds_used, 0); assert.equal(next.round, 1); assert.equal(next.scope, 'full');
    assert.equal(flow.evaluateGate(f.input()).ok, false);
  } finally { f.cleanup(); }
});

for (const jira of shapes) test('D37 fatal ancestry preserves refusal across an authenticated three-round lineage: ' + jira, () => {
  const f = fixture(jira);
  try {
    let priorHead = null;
    for (let round = 1; round <= 3; round++) {
      artifact.sealJudgment(artifactInput(f, f.advance(round), raw(), round, priorHead));
      priorHead = f.live().headRefOid;
    }
    f.advance(4);
    assert.equal(flow.status(f.input()).state, 'limit');
    assert.equal(flow.status(f.input()).rounds_used, 3);
    const failures = [
      Object.assign(new Error('fatal: failed to read commit object'), { status: 128, signal: null }),
      Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT', status: null }),
      Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }),
      Object.assign(new Error('git terminated'), { status: 1, signal: 'SIGTERM' }),
      Object.assign(new Error('spawnSync git ENOBUFS'), { status: 1, code: 'ENOBUFS' }),
      Object.assign(new Error('git was killed'), { status: 1, killed: true }),
    ];
    for (const failure of failures) {
      let probes = 0;
      withFlowDependencies({ 'node:child_process': { ...require('node:child_process'),
        execFileSync(file, args, options) {
          if (file === 'git' && args[2] === 'merge-base' && args[3] === '--is-ancestor') {
            probes++; throw failure;
          }
          return execFileSync(file, args, options);
        } } }, isolated => {
        for (const mode of ['hold', 'report']) {
          f.mode(mode);
          for (const run of [
            () => isolated.status(f.input()),
            () => isolated.evaluateGate(f.input()),
            () => isolated.fixTickets(f.input()),
            () => isolated.verifyCodeReview(f.input()),
            () => builder.build(f.args('arch-review'), f.options),
          ]) assert.throws(run, error => error === failure, failure.message);
        }
      });
      assert.equal(probes, 10, 'each consumer must refuse at the failed ancestry probe');
      assert.equal(flow.status(f.input()).rounds_used, 3, 'fatal probes must not alter authenticated history');
    }
    let negativeProbes = 0;
    withFlowDependencies({ 'node:child_process': { ...require('node:child_process'),
      execFileSync(file, args, options) {
        if (file === 'git' && args[2] === 'merge-base' && args[3] === '--is-ancestor') {
          negativeProbes++;
          throw Object.assign(new Error('not an ancestor'), { status: 1, signal: null });
        }
        return execFileSync(file, args, options);
      } } }, isolated => {
      const next = isolated.status(f.input());
      assert.equal(next.state, 'owed'); assert.equal(next.rounds_used, 0);
      assert.equal(next.round, 1); assert.equal(next.scope, 'full');
    });
    assert(negativeProbes > 0, 'genuine exit 1 is a negative ancestry result');
    assert.equal(flow.status(f.input()).state, 'limit');
  } finally { f.cleanup(); }
});


for (const [selected, foreign, separate] of [
  [null, 'acme/app', false], ['acme/app', null, false], ['acme/other', 'acme/app', false],
  [null, 'acme/app', true], ['acme/app', null, true],
]) {
  test(`canonical ticket repository scope: ${selected} / ${foreign}, separate=${separate}`, () => {
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-repo-scope-')));
    const coordinator = path.join(temporary, 'coordinator'), app = path.join(temporary, 'app');
    const git = (root, args) => execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const init = root => {
      fs.mkdirSync(root);
      git(root, ['init', '--quiet', '--initial-branch=main']);
      git(root, ['config', 'user.name', 'Scope Fixture']);
      git(root, ['config', 'user.email', 'scope@example.invalid']);
      git(root, ['config', 'commit.gpgsign', 'false']);
    };
    try {
      init(coordinator);
      if (separate) init(app);
      const phase = path.join(coordinator, '.planning/phases/52-scope');
      fs.mkdirSync(phase, { recursive: true });
      for (const [n, repo] of [[1, selected], [2, foreign]]) {
        const file = n === 1 ? 'local.js' : 'foreign.js';
        fs.writeFileSync(path.join(coordinator, file), 'module.exports = true;\n');
        fs.writeFileSync(path.join(phase, `52-0${n}-PLAN.md`), [
          '---', 'phase: 52', `plan: ${n}`, `title: ${n === 1 ? 'Local work' : 'Foreign work'}`,
          'type: execute', 'wave: 1', 'depends_on: []', `files_modified: [${file}]`,
          'requirements: [REQ-214]', 'delivery:', `  ticket: T-52-0${n}`, '  risk: low',
          '  human_checkpoint: false', ...(repo ? [`  repo: ${repo}`] : []),
          '---', 'Keep contracts.', '',
        ].join('\n'));
      }
      const configPath = path.join(coordinator, '.planning/config.json');
      const config = { git: { base_branch: 'main' }, delivery_pipeline: {
        code_review: 'hold', ...(separate ? { repos: { 'acme/app': app } } : {}),
      } };
      write(configPath, config);
      const valid = spawnSync(process.execPath, [path.join(scripts, 'validate-graph.cjs')],
        { cwd: coordinator, encoding: 'utf8' });
      assert.equal(valid.status, 0, valid.stderr + valid.stdout);
      assert.match(valid.stdout, /validate-graph: OK.*2 ticket\(s\)/);
      const graphDir = path.join(coordinator, '.planning/graph');
      const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
      assert.equal(graph.tickets['T-52-01'].repo, selected);
      assert.equal(graph.tickets['T-52-02'].repo, foreign);
      assert.equal(new Set(Object.values(graph.tickets).map(row => row.branch)).size, 2);
      const state = { tickets: {
        'T-52-01': { repo: foreign, pr_branch: 'feat/local-recorded' },
        'T-52-02': { repo: selected, pr_branch: 'feat/foreign-recorded' },
      } };
      write(path.join(graphDir, 'delivery-state.json'), state);
      git(coordinator, ['add', '.']);
      git(coordinator, ['commit', '--quiet', '-m', 'canonical planning']);
      if (separate) {
        fs.writeFileSync(path.join(app, 'foreign.js'), 'module.exports = true;\n');
        git(app, ['add', '.']); git(app, ['commit', '--quiet', '-m', 'application base']);
        assert.notEqual(target.repositoryIdentity(coordinator), target.repositoryIdentity(app));
        assert.equal(fs.existsSync(path.join(app, '.planning')), false);
      }
      const root = separate && selected ? app : coordinator;
      const association = require(path.join(scripts, 'context-packet.cjs')).resolvePlanningReference({
        worktree: root, graphDir, repo: selected,
      });
      assert.equal(association.root, coordinator);
      assert.equal(association.repository, target.repositoryIdentity(root));
      const base = git(root, ['rev-parse', 'HEAD']);
      git(root, ['update-ref', 'refs/remotes/origin/main', base]);
      git(root, ['switch', '--quiet', '-c', graph.tickets['T-52-02'].branch]);
      git(root, ['commit', '--quiet', '--allow-empty', '-m', 'integration PR']);
      const live = { number: 52, state: 'OPEN', headRefName: graph.tickets['T-52-02'].branch,
        headRefOid: git(root, ['rev-parse', 'HEAD']), baseRefName: 'main', baseRefOid: base };
      const bin = path.join(temporary, 'bin'), response = path.join(temporary, 'response.json');
      const requests = path.join(temporary, 'requests.jsonl');
      fs.mkdirSync(bin);
      const prArgs = ['pr', 'view', '52', ...(selected ? ['--repo', selected] : []), '--json',
        'number,state,headRefName,headRefOid,baseRefName,baseRefOid'];
      const repoArgs = ['repo', 'view', ...(selected ? [selected] : []), '--json',
        'defaultBranchRef', '--jq', '.defaultBranchRef.name'];
      fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\n' +
        `const fs = require('node:fs'), assert = require('node:assert/strict');
const args = process.argv.slice(2), pr = ${JSON.stringify(prArgs)}, repo = ${JSON.stringify(repoArgs)};
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(pr)) process.stdout.write(fs.readFileSync(${JSON.stringify(response)}));
else { assert.deepEqual(args, repo); process.stdout.write('main\\n'); }
`, { mode: 0o755 });
      const check = (head, kind, mode) => {
        config.delivery_pipeline.code_review = mode; write(configPath, config);
        const current = { ...live, headRefName: head };
        assert.equal(flow.matchEpicPullRequest({ graph, state, live: current, repo: selected }).kind, kind);
        const result = flow.verifyCodeReview({ worktree: root, graphDir, repo: selected, live: current },
          { defaultBranch: 'main' });
        if (kind === 'ticket') assert.equal(result, null);
        else {
          assert.notEqual(result, null);
          assert.equal(result.state, kind === 'epic' ? 'owed' : 'unmatched');
          assert.equal(result.mode, mode); assert.equal(result.ok, mode === 'report');
        }
        write(response, current); fs.writeFileSync(requests, '');
        const cli = spawnSync(process.execPath, [path.join(scripts, 'gate-trailer.cjs'), 'verify', '52',
          '--graph', graphDir, '--worktree', root, ...(selected ? ['--repo', selected] : [])], {
          cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home,
            PATH: bin + path.delimiter + process.env.PATH },
        });
        assert.equal(cli.status, 1, cli.stderr + cli.stdout);
        const body = JSON.parse(cli.stdout);
        assert.equal(body.required, true); assert.equal(body.ready, false); assert.equal(body.verdict, null);
        if (kind === 'ticket') assert.equal(body.code_review, null);
        else {
          assert.notEqual(body.code_review, null);
          assert.equal(body.code_review.state, kind === 'epic' ? 'owed' : 'unmatched');
          assert.equal(body.code_review.mode, mode); assert.equal(body.code_review.ok, mode === 'report');
        }
        const calls = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(prArgs)));
        if (selected) assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(repoArgs)));
        for (const args of calls) assert.ok([prArgs, repoArgs].some(expected =>
          JSON.stringify(args) === JSON.stringify(expected)));
      };
      for (const mode of ['hold', 'report']) {
        check(graph.tickets['T-52-02'].branch, 'unmatched', mode);
        check(state.tickets['T-52-02'].pr_branch, 'unmatched', mode);
        check(graph.tickets['T-52-01'].branch, 'ticket', mode);
        check(state.tickets['T-52-01'].pr_branch, 'ticket', mode);
      }
      state.tickets['T-52-02'].pr_branch = graph.epics['52'].branch;
      write(path.join(graphDir, 'delivery-state.json'), state);
      check(graph.epics['52'].branch, 'epic', 'hold');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}

function retainPlanningInput(f, input, planningRoot = f.root, repo = null) {
  return require('../fixtures/code-review/artifact-fixture.cjs').retainPlanningInput(f, input, planningRoot, repo);
}

for (const mode of ['hold', 'report']) test('D35 completed normalization controls public current status and hold: ' + mode, () => {
  const f = fixture(null);
  try {
    f.mode(mode);
    const binding = f.advance(1);
    const input = artifactInput(f, binding, raw(true, [{ ...blocker, fix_ticket: undefined }]));
    const sealed = artifact.sealJudgment(input);
    assert.equal(input.result.demoted_for_evidence, 1); assert.equal(input.result.verdict, 'pass');
    assert.equal(flow.status(f.input()).state, 'current'); assert.equal(flow.status(f.input()).reuse, true);
    assert.equal(flow.verifyCodeReview(f.input()).ok, true);
    assert.equal(flow.evaluateGate(f.input()).ok, true);
    const receipt = f.recorder.getVerifiedRecord(input.dispatchId).receipt;
    const original = fs.readFileSync(receipt.selection_evidence.transcript.path);
    fs.writeFileSync(receipt.selection_evidence.transcript.path, original.subarray(0, original.length - 1));
    assert.equal(artifact.currentCodeReviewVerdict({ worktreePath: f.root, pr: 52, head: f.live().headRefOid,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir }), null);
    const owed = flow.status(f.input());
    assert.equal(owed.state, 'owed'); assert.equal(owed.reuse, false); assert.equal(owed.rounds_used, 1);
    assert.equal(flow.verifyCodeReview(f.input()).ok, mode === 'report');
    assert.equal(flow.evaluateGate(f.input()).ok, mode === 'report');
    assert.throws(() => artifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest }), /authenticated complete current material coverage/);
    fs.writeFileSync(receipt.selection_evidence.transcript.path, original);
    assert.equal(flow.status(f.input()).state, 'current'); assert.equal(flow.verifyCodeReview(f.input()).ok, true);
  } finally { f.cleanup(); }
});

test('D35 cold public CLI refuses changed native evidence and accepts restored original bytes', () => {
  const f = fixture(null), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd35-gate-')));
  try {
    const input = artifactInput(f, f.advance(1), raw()); artifact.sealJudgment(input);
    fs.writeFileSync(path.join(directory, 'gh'), '#!/usr/bin/env node\nprocess.stdout.write(process.env.D35_PR);\n', { mode: 0o755 });
    const gate = () => spawnSync(process.execPath, [path.join(scripts, 'phase-code-review.cjs'), 'gate', f.phase,
      '--phase', '52', '--pr', '52', '--worktree', f.root, '--graph', f.graphDir], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, HOME: home,
        PATH: directory + path.delimiter + process.env.PATH, D35_PR: JSON.stringify(f.live()) } });
    const passed = gate(); assert.equal(passed.status, 0, passed.stderr);
    const pin = f.recorder.getVerifiedRecord(input.dispatchId).receipt.transcript;
    const bytes = fs.readFileSync(pin.path); fs.writeFileSync(pin.path, 'Foreign native stream\n');
    const refused = gate(); assert.equal(refused.status, 1, refused.stderr); assert.match(refused.stderr, /owed/);
    fs.writeFileSync(pin.path, bytes);
    const restored = gate(); assert.equal(restored.status, 0, restored.stderr);
  } finally { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
});

const d37Fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
const d37Modes = [{ runtime: 'claude', transport: 'inline' }, { runtime: 'codex', transport: 'inline' }];
const d37Prior = f => artifact.priorCodeReviewVerdicts({ worktreePath: f.root, graphDir: f.graphDir,
  repository: target.repositoryIdentity(f.root), phaseDir: f.phase });
function d37Input(f, binding, mode, original = raw(), round = 1, priorHead = null, priorFindings = [], extra = {}) {
  const input = f.inputArtifact(binding, round, priorHead, priorFindings.length ? raw() : original);
  d37Fixtures.setOriginalReview(input, original, priorFindings);
  return d37Fixtures.retainPlanningInput(f, input, f.root, null, { ...mode, ...extra });
}

for (const mode of d37Modes) test('D37 frozen original survives real membership, twin carry and three-round cap: ' + JSON.stringify(mode), () => {
  const f = fixture(null);
  try {
    const source = name => fs.readFileSync(path.join(__dirname, '../fixtures/code-review', name), 'utf8');
    fs.writeFileSync(path.join(f.root, 'source.js'), source('twins.js')); f.git(['add', 'source.js']);
    let previous = null, originalTarget;
    const membership = [];
    for (const round of [1, 2, 3]) {
      if (round === 2) {
        fs.writeFileSync(path.join(f.root, 'source.js'), source('twins-added.js')); f.git(['add', 'source.js']);
      }
      const binding = f.advance(round); membership.push(binding.membership);
      const history = d37Prior(f);
      assert.equal(history.length, round - 1);
      assert.ok(history.every(entry => entry.answer_authenticated && entry.coverage_range));
      const owed = flow.status(f.input());
      assert.equal(owed.scope, round === 1 ? 'full' : 'delta'); assert.equal(owed.round, round);
      const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
      let priorFindings = [];
      const original = raw(true, round === 1 ? [2, 4, 6].map((line, index) => ({ ...blocker,
        id: 'twin-' + index, line, line_text: 'return null;' })) : []);
      if (round > 1) {
        const deltaDiff = f.git(['diff', '--unified=50', previous, 'HEAD']);
        const carried = core.carryPriorFindings({ priorFindings: history.at(-1), deltaDiff, readSource });
        const text = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
          path: 'source.js', line_text: 'return null;', occurrence: 2,
          reason: 'The middle caller handles absence', recorded_by: 'operator' }] });
        write(path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json'), JSON.parse(text));
        const disagreements = core.parseDisagreements(text, { priorFindings: carried });
        priorFindings = core.carryPriorFindings({ priorFindings: history.at(-1), deltaDiff, disagreements, readSource });
        original.dispositions = priorFindings.filter(finding => !finding.disagreement).map(finding => ({
          ref: finding.ref, disposition: 'unresolved', justification: 'Other callers still fail' }));
      }
      const input = d37Input(f, binding, mode, original, round, previous, priorFindings);
      const sealed = artifact.sealJudgment(input);
      const validated = artifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref,
        artifactDigest: sealed.artifact_digest });
      assert.equal(validated.manifest.repository_identity, target.repositoryIdentity(f.root));
      assert.equal(validated.manifest.worktree_realpath, f.root);
      const current = f.lookup();
      assert.equal(current.artifact_digest, sealed.artifact_digest);
      assert.equal(current.blocking_count, round === 1 ? 3 : 2);
      if (round === 1) originalTarget = input.result.findings.find(finding => finding.line === 4).identity;
      else {
        const suppressed = current.findings.filter(finding => finding.suppressed);
        assert.equal(suppressed.length, 1); assert.equal(suppressed[0].line, 5);
        assert.equal(suppressed[0].occurrence, 3); assert.equal(suppressed[0].disagreement_identity, originalTarget);
        assert.equal(current.disagreement_suppressed, 1);
      }
      assert.equal(flow.evaluateGate(f.input()).ok, false);
      assert.throws(() => artifact.sealJudgment({ ...input, dispatchId: 'foreign-dispatch' }));
      previous = input.result.head;
    }
    assert.equal(new Set(membership).size, 3);
    const history = d37Prior(f);
    assert.ok(history.every(entry => entry.answer_authenticated && entry.coverage_range));
    assert.equal(core.lineageComplete({ verdict: history.at(-1), priorVerdicts: history }), true);
    f.advance(4);
    assert.equal(flow.status(f.input()).state, 'limit'); assert.equal(flow.status(f.input()).rounds_used, 3);
    assert.equal(flow.fixTickets(f.input(), { stderr: { write() {} } }).length, 0);
    f.mode('report'); assert.equal(flow.evaluateGate(f.input()).ok, true);
    assert.ok(d37Prior(f).every(entry => entry.answer_authenticated && entry.coverage_range));
  } finally { f.cleanup(); }
});

for (const mode of d37Modes) for (const carrier of ['stream', 'semantic']) for (const change of ['missing', 'changed'])
test('D37 original custody refuses and exact restoration authenticates: ' + JSON.stringify({ ...mode, carrier, change }), () => {
  const f = fixture(null);
  try {
    const input = d37Input(f, f.advance(1), mode);
    artifact.sealJudgment(input);
    const receipt = f.recorder.getVerifiedRecord(input.dispatchId).receipt;
    let file = receipt.transcript?.path || receipt.runtime_evidence.transcript.path;
    if (carrier === 'semantic' && mode.runtime === 'claude') file = receipt.selection_evidence.transcript.path;
    if (carrier === 'semantic' && mode.runtime === 'codex') {
      const files = fs.readdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
      file = path.join(process.env.CODEX_HOME, 'sessions', files.find(name => name.endsWith('.jsonl')));
    }
    const bytes = fs.readFileSync(file);
    assert.equal(d37Prior(f)[0].answer_authenticated, true);
    if (change === 'missing') fs.rmSync(file); else fs.appendFileSync(file, 'changed');
    const refused = d37Prior(f)[0];
    assert.equal(refused.answer_authenticated, false); assert.equal(refused.coverage_range, null);
    assert.equal(f.lookup(), null); assert.equal(flow.status(f.input()).state, 'owed');
    assert.equal(flow.evaluateGate(f.input()).ok, false);
    fs.writeFileSync(file, bytes);
    assert.equal(d37Prior(f)[0].answer_authenticated, true); assert.equal(f.lookup().verdict, 'pass');
  } finally { f.cleanup(); }
});

for (const mode of d37Modes) for (const change of ['graph', 'config', 'plan', 'dispositions', 'head', 'base'])
test('D37 historical authenticity grants no changed current authority: ' + JSON.stringify({ ...mode, change }), () => {
  const f = fixture(null);
  try {
    const binding = f.advance(1), input = d37Input(f, binding, mode);
    artifact.sealJudgment(input); assert.equal(f.lookup().verdict, 'pass');
    let file, bytes;
    if (change === 'graph') file = path.join(f.graphDir, 'tickets.json');
    if (change === 'config') file = path.join(f.root, '.planning/config.json');
    if (change === 'plan') file = path.join(f.root, binding.ticketSet[0].row.plan);
    if (file) { bytes = fs.readFileSync(file); fs.appendFileSync(file, '\n'); }
    if (change === 'dispositions') {
      file = path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json');
      write(file, { schema: 'shipyard.code-review-disagreements.v1', entries: [] });
    }
    if (change === 'head') f.git(['commit', '--allow-empty', '--quiet', '-m', 'new current head']);
    if (change === 'base') f.git(['update-ref', 'refs/remotes/origin/main', input.result.head]);
    const historical = d37Prior(f)[0];
    assert.equal(historical.answer_authenticated, true); assert.ok(historical.coverage_range);
    assert.equal(f.lookup(), null); assert.equal(flow.evaluateGate(f.input()).ok, false);
    if (file) { if (bytes) fs.writeFileSync(file, bytes); else fs.rmSync(file); }
    if (change === 'base') f.git(['update-ref', 'refs/remotes/origin/main', f.base]);
    if (change !== 'head') assert.equal(f.lookup().verdict, 'pass');
    if (['graph', 'config'].includes(change)) {
      fs.appendFileSync(file, '\n');
      assert.throws(() => artifact.sealJudgment(input));
      fs.writeFileSync(file, bytes);
    }
  } finally { f.cleanup(); }
});

for (const mode of d37Modes) for (const change of ['session', 'selection', 'association', 'repository', 'packet', 'answer', 'evidence'])
test('D37 inconsistent originals cannot be sealed and leave no history: ' + JSON.stringify({ ...mode, change }), () => {
  const f = fixture(null);
  try {
    const input = d37Input(f, f.advance(1), mode, raw(), 1, null, [], {
      mutateNative(rows, _stream, { packet }) {
        if (change === 'session') {
          if (mode.runtime === 'claude') rows[0].sessionId = 'foreign-session';
          else rows[0].payload.id = 'foreign-session';
        }
        if (change === 'selection') {
          if (mode.runtime === 'claude') rows[1].message.model = 'foreign-model';
          else rows[1].payload.model = 'foreign-model';
        }
        if (['packet', 'association', 'repository'].includes(change)) {
          const packets = require(path.join(scripts, 'context-packet.cjs'));
          const altered = structuredClone(packet);
          if (change === 'packet') altered.role_context.dispositions_digest = '0'.repeat(64);
          if (change === 'association') altered.canonical_root = path.join(f.root, '.planning');
          if (change === 'repository') altered.role_context.focused.repository = f.root + '-foreign';
          const extra = '<AUTHENTICATED_CONTEXT_PACKET>\n'
            + JSON.stringify(packets.encodeUniqueContent(altered)) + '\n</AUTHENTICATED_CONTEXT_PACKET>';
          if (mode.runtime === 'claude') rows[0].message.content += extra;
          else rows[3].payload.content[0].text += extra;
        }
      },
    });
    if (change === 'answer') input.result.limitations = ['Not in original answer'];
    if (change === 'answer') {
      input.result.review_completeness = 'incomplete'; input.result.verdict = 'incomplete';
    }
    if (change === 'evidence') fs.writeFileSync(path.join(f.root, '.shipyard-code-review-evidence.md'), 'Substituted evidence\n');
    assert.throws(() => artifact.sealJudgment(input));
    assert.deepEqual(d37Prior(f), []);
    assert.equal(f.lookup(), null); assert.equal(flow.evaluateGate(f.input()).ok, false);
    assert.equal(flow.status(f.input()).rounds_used, 0);
  } finally { f.cleanup(); }
});

for (const mode of d37Modes) test('D37 foreign mapping and selected references refuse current reuse independently: ' + JSON.stringify(mode), () => {
  const f = fixture(null);
  const coordinator = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd37-coordinator-')));
  try {
    const git = args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.name', 'Code Review Test']); git(['config', 'user.email', 'review@example.test']);
    git(['config', 'commit.gpgsign', 'false']);
    f.advance(1);
    f.graph.tickets['T-52-01'].repo = 'acme/app';
    f.graph.epics['052'].repos = ['acme/app']; f.writeGraph();
    fs.renameSync(path.join(f.root, '.planning'), path.join(coordinator, '.planning'));
    const config = path.join(coordinator, '.planning/config.json');
    write(config, { git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'hold', repos: { 'acme/app': f.root } } });
    git(['add', '.']); git(['commit', '--quiet', '-m', 'canonical planning mapping']);
    const graphDir = path.join(coordinator, '.planning/graph');
    const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52, repo: 'acme/app',
      repository: target.repositoryIdentity(f.root), branch: f.branch, pr: 52,
      head: f.live().headRefOid, base: f.base });
    const input = f.inputArtifact(binding, 1, null, raw());
    d37Fixtures.retainPlanningInput(f, input, coordinator, 'acme/app', mode);
    const sealed = artifact.sealJudgment(input);
    const prior = () => artifact.priorCodeReviewVerdicts({ worktreePath: f.root, graphDir,
      repository: target.repositoryIdentity(f.root), phaseDir: f.phase });
    const lookup = () => artifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir, repo: 'acme/app',
      pr: 52, head: f.live().headRefOid, headBranch: f.branch, baseName: 'main', baseCommit: f.base });
    assert.equal(lookup().artifact_digest, sealed.artifact_digest);
    const savedConfig = fs.readFileSync(config), graph = path.join(graphDir, 'tickets.json'), savedGraph = fs.readFileSync(graph);
    for (const change of ['mapping', 'selected-plan', 'membership']) {
      if (change === 'mapping') write(config, { git: { base_branch: 'main' },
        delivery_pipeline: { code_review: 'hold', repos: { 'acme/app': coordinator } } });
      else {
        const altered = JSON.parse(savedGraph);
        if (change === 'selected-plan') altered.tickets['T-52-01'].plan = '.planning/phases/' + f.phase + '/52-99-PLAN.md';
        else altered.tickets['T-52-02'] = { ...altered.tickets['T-52-01'] };
        write(graph, altered);
      }
      let current; try { current = lookup(); } catch { current = null; }
      assert.equal(current, null);
      assert.equal(prior()[0].answer_authenticated, true); assert.ok(prior()[0].coverage_range);
      fs.writeFileSync(config, savedConfig); fs.writeFileSync(graph, savedGraph);
      assert.equal(lookup().artifact_digest, sealed.artifact_digest);
    }
  } finally { f.cleanup(); fs.rmSync(coordinator, { recursive: true, force: true }); }
});
