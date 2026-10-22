'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-authority-')));
const homedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = homedir; fs.rmSync(home, { recursive: true, force: true }); });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const { createDispatchBoundary } = require(path.join(scripts, 'dispatch-boundary.cjs'));
const flow = require(path.join(scripts, 'phase-code-review.cjs'));
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const core = require(path.join(scripts, 'code-review-core.cjs'));
const hygiene = require(path.join(scripts, 'pr-hygiene.cjs'));
const { fixture: artifactFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
const sourceLine = fs.readFileSync(path.join(__dirname, '../fixtures/code-review/source.js'), 'utf8').split('\n')[0];
const blocker = { id: 'repair-source', rule: 'source-error', severity: 'BLOCKER', path: 'source.js', line: 1,
  line_text: sourceLine, summary: 'Repair the failing source', failure_scenario: 'A caller receives the wrong result.',
  fix_ticket: { title: 'Repair source', scope: 'Correct the cited failure', files: ['source.js'], depends_on: [] } };
const raw = (complete = true, findings = []) => ({ review_completeness: complete ? 'complete' : 'incomplete',
  limitations: complete ? [] : ['unread partition'], unresolved_sources: [], findings, dispositions: [],
  coverage: complete ? [] : [{ status: 'not-reviewed' }] });

function fixture(jira = null, mode = 'report', pr = 52) {
  const f = artifactFixture('publish');
  let planningRoot = f.root;
  const branch = jira ? 'feat/PRJ-42-review' : f.branch;
  if (jira) f.git(['branch', '-m', branch]);
  f.graph.epics = { '052': { branch, phaseDir: f.phase, repos: [null], jira } };
  Object.assign(f.graph.tickets['T-52-01'], { epic: branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
  fs.writeFileSync(path.join(f.root, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' },
    delivery_pipeline: { code_review: mode } }));
  f.writeGraph();
  const live = () => ({ number: pr, state: 'OPEN', headRefName: branch, headRefOid: f.git(['rev-parse', 'HEAD']),
    baseRefName: 'main', baseRefOid: f.base });
  const writes = [], comments = [], hooks = {};
  let nextCommentId = 77;
  let ticketHead = f.base, failStatus = false, failComment = false, failLookup = false;
  const getPullRequest = ({ pr: requested }) => {
    const result = requested === pr ? live() : { number: requested, headRefOid: ticketHead };
    hooks.readPR?.(requested);
    return result;
  };
  const options = { defaultBranch: 'main', getPullRequest, gh(args) {
    const endpoint = args[1], method = args[args.indexOf('--method') + 1];
    const fields = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-f').map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
    if (args.includes('--method') || args.includes('-f')) {
      writes.push({ endpoint, method, fields });
      if (endpoint.includes('/statuses/')) {
        hooks.status?.();
        if (failStatus) throw new Error('status unavailable');
        return {};
      }
      if (failComment) throw new Error('comment unavailable');
      if (method === 'PATCH') {
        const comment = comments.find(comment => endpoint.endsWith('/' + comment.id));
        comment.body = fields.body; hooks.comment?.(); return { ...comment };
      }
      nextCommentId = Math.max(nextCommentId, ...comments.map(comment => comment.id + 1));
      const comment = { id: nextCommentId++, body: fields.body };
      comments.push(comment); hooks.comment?.(); return { ...comment };
    }
    if (failLookup) throw new Error('comment lookup unavailable');
    hooks.lookup?.();
    return [comments];
  } };
  const input = () => ({ phase: 52, phaseDirectory: f.phase, pr, worktree: f.root, graphDir: f.graphDir });
  const seal = (result = raw(), round = 1, priorHead = null, priorFindings = []) => {
    fs.writeFileSync(path.join(f.root, 'round.txt'), String(round));
    f.git(['add', 'round.txt']); f.git(['commit', '--quiet', '-m', 'round ' + round]);
    if (round > 1) {
      const ticket = 'T-52-0' + round;
      f.graph.tickets[ticket] = { ...f.graph.tickets['T-52-01'], branch: 'fix/' + ticket,
        plan: '.planning/phases/' + f.phase + '/52-0' + round + '-PLAN.md' };
      f.state[ticket] = { status: 'merged', pr: 10 + round,
        head_sha: live().headRefOid, merge_sha: live().headRefOid };
    }
    f.writeGraph();
    const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52,
      repository: target.repositoryIdentity(f.root), branch, pr, head: live().headRefOid, base: f.base });
    const request = f.input(binding, round, priorHead, raw());
    Object.assign(request.result, core.normalizeResult(result, { round, scope: round === 1 ? 'full' : 'delta',
      priorFindings, readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') }));
    return artifact.sealJudgment(retainPlanningInput(f, request, planningRoot));
  };
  return { ...f, branch, live, input, options, seal, writes, comments, hooks,
    sealLinked: linked => {
      const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52,
        repository: target.repositoryIdentity(linked), branch, pr, head: live().headRefOid, base: f.base });
      const request = f.input(binding, 1, null, raw());
      request.worktreePath = linked;
      fs.copyFileSync(path.join(f.root, '.shipyard-code-review-evidence.md'),
        path.join(linked, '.shipyard-code-review-evidence.md'));
      return artifact.sealJudgment(retainPlanningInput({ ...f, root: linked }, request, planningRoot));
    },
    sealPr: number => {
      const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52,
        repository: target.repositoryIdentity(f.root), branch, pr: number, head: live().headRefOid, base: f.base });
      const request = f.input(binding, 1, null, raw());
      request.pr = number; request.result.pr = number;
      Object.assign(request.result, core.normalizeResult(raw(), { round: 1, scope: 'full',
        priorFindings: [], readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') }));
      return artifact.sealJudgment(retainPlanningInput(f, request, planningRoot));
    },
    setPlanningRoot: value => { planningRoot = value; },
    lookup: () => artifact.currentCodeReviewVerdict({ worktreePath: f.root, pr, head: live().headRefOid,
      baseName: 'main', baseCommit: f.base, graphDir: path.join(planningRoot, '.planning/graph'), headBranch: branch }),
    setTicketHead: value => { ticketHead = value; }, failStatus: () => { failStatus = true; },
    failComment: () => { failComment = true; }, failLookup: () => { failLookup = true; } };
}

for (const jira of [null, 'PRJ-42']) {
  test('publish pass to the graph epic and edit the marked comment in place: ' + jira, () => {
    const f = fixture(jira);
    try {
      f.seal();
      for (let i = 0; i < 2; i++) {
        const result = flow.publish(f.input(), f.options);
        assert.equal(result.schema, 'shipyard.phase-code-review-publish.v1');
        assert.equal(result.status.ok, true); assert.equal(result.comment.ok, true);
        assert.equal(result.comment.action, i ? 'edited' : 'created');
      }
      assert.equal(f.comments.length, 1);
      assert.match(f.comments[0].body, /<!-- code-review -->/);
      const statuses = f.writes.filter(write => write.endpoint.includes('/statuses/'));
      assert.equal(statuses.length, 2);
      for (const posted of statuses) {
        assert(posted.endpoint.endsWith('/' + f.live().headRefOid));
        assert.deepEqual(posted.fields, { state: 'success', context: 'code-review', description: 'code review: no blocking issues, 0 notes' });
      }
    } finally { f.cleanup(); }
  });

  test('unmatched, other naming shape and ticket branches refuse before any write: ' + jira, () => {
    const f = fixture(jira);
    try {
      f.seal();
      for (const head of [jira ? 'epic/52-review' : 'feat/PRJ-42-review', 'unlisted', 'feat/review-ticket']) {
        const options = { ...f.options, getPullRequest: ({ pr }) => pr === 52 ? { ...f.live(), headRefName: head }
          : f.options.getPullRequest({ pr }) };
        assert.throws(() => flow.publish(f.input(), options), head === 'feat/review-ticket' ? /ticket PR/ : /unmatched/);
        assert.equal(f.writes.length, 0);
      }
    } finally { f.cleanup(); }
  });

  test('a graph ticket PR head, wrong base and moved live head refuse before writes: ' + jira, () => {
    const f = fixture(jira);
    try {
      f.seal(); f.setTicketHead(f.live().headRefOid);
      assert.throws(() => flow.publish(f.input(), f.options), /ticket PR/);
      assert.equal(f.writes.length, 0); f.setTicketHead(f.base);
      for (const changed of [{ baseRefName: 'other' }, { headRefOid: f.base }]) {
        assert.throws(() => flow.publish(f.input(), { ...f.options,
          getPullRequest: ({ pr }) => pr === 52 ? { ...f.live(), ...changed } : f.options.getPullRequest({ pr }) }));
        assert.equal(f.writes.length, 0);
      }
      assert.throws(() => flow.publish({ ...f.input(), live: { ...f.live(), headRefOid: f.base } }, f.options));
    } finally { f.cleanup(); }
  });

  for (const [name, result, description] of [
    ['needs-fix', raw(true, [blocker]), 'code review: 1 blocking issues, 0 notes'],
    ['incomplete', raw(false), 'code review incomplete: 1 partitions not reviewed'],
  ]) test('publish ' + name + ' as pending: ' + jira, () => {
    const f = fixture(jira, 'hold');
    try {
      f.seal(result);
      const published = flow.publish(f.input(), f.options);
      assert.equal(published.status.state, 'pending'); assert.equal(published.status.description, description);
      assert.equal(hygiene.applies({ root: f.root }), true);
      assert.equal(published.comment.ok, true);
      assert.deepEqual(published.rules, []);
      if (name === 'needs-fix') assert.match(f.comments[0].body, /Proposed fix-ticket title: Repair source/);
      assert.match(f.comments[0].body, /delivery_pipeline.code_review.*report/);
      assert(!f.writes.some(write => ['failure', 'error'].includes(write.fields.state)));
    } finally { f.cleanup(); }
  });

  test('limit posts pending status only; unreviewed owed head cannot publish: ' + jira, () => {
    const f = fixture(jira);
    try {
      assert.throws(() => flow.publish(f.input(), f.options), /sealed|owed/);
      assert.equal(f.writes.length, 0);
      let prior = null;
      for (let round = 1; round <= 3; round++) {
        f.seal(raw(), round, prior); prior = f.live().headRefOid;
      }
      fs.writeFileSync(path.join(f.root, 'after.txt'), 'new head');
      f.git(['add', 'after.txt']); f.git(['commit', '--quiet', '-m', 'after cap']);
      const capped = flow.status(f.input(), f.options);
      assert.equal(capped.state, 'limit'); assert.equal(capped.rounds_used, 3);
      const config = path.join(f.root, '.planning/config.json');
      const originalConfig = fs.readFileSync(config);
      const before = publicationSnapshot(f);
      fs.writeFileSync(config, '[]');
      const mode = flow.resolveCodeReviewMode(f.input());
      assert.equal(mode.valid, false); assert.equal(mode.error.file, config);
      assertConfigRefusal(() => flow.publish(f.input(), f.options), config);
      assert.equal(f.writes.length, 0); assert.deepEqual(publicationSnapshot(f), before);
      assert.equal(fs.existsSync(publicationState(f).directory), false);
      fs.writeFileSync(config, originalConfig);
      const published = flow.publish(f.input(), f.options);
      assert.equal(published.status.state, 'pending');
      assert.equal(published.status.description, 'code review limit reached: no further review will run for this head');
      assert.equal(published.comment.action, 'skipped'); assert.equal(f.comments.length, 0); assert.equal(f.writes.length, 1);
      fs.unlinkSync(config);
      const absent = flow.resolveCodeReviewMode(f.input());
      assert.equal(absent.valid, true); assert.equal(absent.error, null); assert.equal(absent.source, 'default');
      const defaults = flow.publish(f.input(), f.options);
      assert.equal(defaults.status.ok, true); assert.equal(defaults.status.state, 'pending');
      assert.equal(defaults.comment.action, 'skipped'); assert.equal(f.writes.length, 2);
      assert.deepEqual(publicationSnapshot(f), before);
    } finally { f.cleanup(); }
  });
}

for (const leak of ['T-12-03', 'ADR-032', '.planning/private', 'shipyard', 'gsd', 'conveyor', 'Phase 2']) {
  for (const exempt of [false, true]) test('hygiene isolates the comment from the status: ' + leak + ', exempt=' + exempt, () => {
    const f = fixture();
    try {
      if (exempt) {
        const manifest = path.join(f.root, 'plugins/delivery-pipeline/.claude-plugin');
        fs.mkdirSync(manifest, { recursive: true });
        fs.writeFileSync(path.join(manifest, 'plugin.json'), JSON.stringify({ name: 'shipyard' }));
        f.git(['add', 'plugins/delivery-pipeline/.claude-plugin/plugin.json']);
      }
      f.seal(raw(true, [{ ...blocker, summary: leak }]));
      const result = flow.publish(f.input(), f.options);
      assert.equal(result.status.ok, true); assert.equal(result.status.state, 'pending');
      assert.equal(result.status.description, 'code review: 1 blocking issues, 0 notes');
      assert.equal(result.comment.ok, exempt);
      assert.equal(f.comments.length, exempt ? 1 : 0);
      assert.deepEqual(result.rules, exempt ? [] : hygiene.internalLeakViolations('comment', leak).map(item => item.rule));
      assert.equal(f.writes[0].fields.context, 'code-review');
      if (!exempt) assert.equal(f.writes.length, 1);
    } finally { f.cleanup(); }
  });
}

for (const leak of [false, true]) test('publish CLI reports independent results and exit code, leak=' + leak, () => {
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-cli-'));
  try {
    f.seal(leak ? raw(true, [{ ...blocker, summary: 'Phase 2' }]) : raw());
    const preload = path.join(directory, 'preload.cjs');
    fs.writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(home)};\n`);
    const data = path.join(directory, 'data.json'), log = path.join(directory, 'writes.jsonl');
    fs.writeFileSync(data, JSON.stringify({ epic: f.live(), ticket: { number: 1, headRefOid: f.base }, log }));
    installPublicationGh(directory);
    const argv = ['--require', preload, path.join(scripts, 'phase-code-review.cjs'),
      'publish', f.phase, '--phase', '52', '--pr', '52', '--graph', f.graphDir, '--worktree', f.root];
    const options = { encoding: 'utf8', env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH,
      PUBLISH_TEST_DATA: data } };
    const run = spawnSync(process.execPath, argv, options);
    assert.equal(run.status, leak ? 1 : 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status.action, 'posted'); assert.equal(result.status.ok, true);
    assert.equal(result.comment.ok, !leak);
    if (leak) { assert.equal(result.comment.action, 'refused'); assert.deepEqual(result.rules, ['phase-number']); }
    const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(writes.length, leak ? 1 : 2);
    assert(writes[0][1].endsWith('/statuses/' + f.live().headRefOid));
    if (!leak) {
      const again = spawnSync(process.execPath, argv, options);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      const second = JSON.parse(again.stdout);
      assert.equal(second.comment.action, 'edited'); assert.equal(second.comment.id, result.comment.id);
      const saved = JSON.parse(fs.readFileSync(data + '.comments', 'utf8'));
      assert.equal(saved.length, 1); assert.equal(saved[0].id, result.comment.id);
    }
  } finally { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('comment refusal never edits an existing comment', () => {
  const f = fixture();
  try {
    f.seal(raw(true, [{ ...blocker, summary: 'Phase 2' }]));
    f.comments.push({ id: 77, body: '<!-- code-review -->\nprevious' });
    const result = flow.publish(f.input(), f.options);
    assert.equal(result.comment.ok, false); assert.equal(result.status.ok, true);
    assert.equal(f.comments[0].body, '<!-- code-review -->\nprevious'); assert.equal(f.writes.length, 1);
  } finally { f.cleanup(); }
});

for (const failure of ['failStatus', 'failComment', 'failLookup']) test('publication failures are independent: ' + failure, () => {
  const f = fixture();
  try {
    f.seal(); f[failure](); const result = flow.publish(f.input(), f.options);
    assert.equal(result.status.ok, failure !== 'failStatus');
    assert.equal(result.comment.ok, failure === 'failStatus');
  } finally { f.cleanup(); }
});

test('BLOCKER comment exposes the full host citation and reproducible disagreement identity', () => {
  const f = fixture();
  try {
    f.seal(raw(true, [blocker, { ...blocker, id: 'note', severity: 'WARNING', summary: 'Optional note' }]));
    const published = flow.publish(f.input(), f.options);
    assert.equal(published.status.description, 'code review: 1 blocking issues, 1 notes');
    const body = f.comments[0].body;
    const identity = JSON.parse(body.split('\n').find(line => line.startsWith('    {')).trim());
    assert.deepEqual(identity, { path: blocker.path, line_text: sourceLine, occurrence: 1 });
    assert.match(body, /source-error.*source.js:1/); assert.match(body, /Optional note/);
    assert.match(body, /Proposed fix-ticket title: Repair source/); assert.match(body, /A caller receives the wrong result/);
    assert.match(body, /citations_unresolved: 0/); assert.match(body, /0 findings not raised again/);
    const current = f.lookup();
    const entries = core.parseDisagreements(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
      entries: [{ ...identity, reason: 'Accepted behavior', recorded_by: 'operator' }] }), { priorFindings: core.carryPriorFindings({ priorFindings: current.findings, deltaDiff: '',
      readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') }) });
    assert.equal(Object.keys(entries)[0], current.findings[0].identity);
  } finally { f.cleanup(); }
});


test('unresolved citations are counted and never given invented source identities', () => {
  const f = fixture();
  try {
    f.seal(raw(true, [{ ...blocker, line: 9999, line_text: 'unavailable' }]));
    const result = flow.publish(f.input(), f.options);
    assert.equal(result.status.ok, true); assert.equal(result.comment.ok, true);
    const body = f.comments[0].body;
    assert.match(body, /citations_unresolved: 1/);
    assert.match(body, /No reusable original locator is available/);
    assert(!body.split('\n').some(value => value.startsWith('    {')));
  } finally { f.cleanup(); }
});

test('the host citation is printed in full at the 1024-byte line bound', () => {
  const f = fixture();
  try {
    const line = 'x'.repeat(1024);
    fs.writeFileSync(path.join(f.root, 'source.js'), line + '\n');
    f.git(['add', 'source.js']); f.git(['commit', '--quiet', '-m', 'long source line']);
    f.seal(raw(true, [{ ...blocker, line_text: line }]));
    flow.publish(f.input(), f.options);
    const identity = JSON.parse(f.comments[0].body.split('\n').find(value => value.startsWith('    {')).trim());
    assert.equal(identity.line_text, line); assert.equal(identity.line_text.length, 1024);
  } finally { f.cleanup(); }
});

test('third-round needs-fix publishes pending with the operator exit', () => {
  const f = fixture(null, 'hold');
  try {
    let prior = null;
    for (let round = 1; round <= 3; round++) {
      f.seal(round === 3 ? raw(true, [blocker]) : raw(), round, prior);
      prior = f.live().headRefOid;
    }
    const result = flow.publish(f.input(), f.options);
    assert.equal(result.status.state, 'pending');
    assert.equal(result.comment.ok, true); assert.match(f.comments[0].body, /round 3/);
    assert.match(f.comments[0].body, /delivery_pipeline.code_review.*report/);
  } finally { f.cleanup(); }
});

test('injected gh runner covers every read as well as writes and refuses a head race', () => {
  const f = fixture();
  try {
    f.seal();
    const gh = args => args[0] === 'pr' ? f.options.getPullRequest({ pr: Number(args[2]) }) : f.options.gh(args);
    assert.equal(flow.publish(f.input(), { defaultBranch: 'main', gh }).status.ok, true);
    f.writes.length = 0;
    let reads = 0;
    assert.throws(() => flow.publish(f.input(), { defaultBranch: 'main', gh: args => {
      if (args[0] !== 'pr') return f.options.gh(args);
      const pr = Number(args[2]);
      if (pr === 52 && ++reads === 2) return { ...f.live(), headRefOid: f.base };
      return f.options.getPullRequest({ pr });
    } }), /changed before publication/);
    assert.equal(f.writes.length, 0);
  } finally { f.cleanup(); }
});

test('every status grammar uses safe integer counts and passes hygiene at the maximum', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const value of [
    { state: 'current', verdict: 'pass', review_completeness: 'complete', warning_count: maximum, blocking_count: 0 },
    { state: 'current', verdict: 'needs-fix', warning_count: maximum, blocking_count: maximum },
    { state: 'owed', retry: true, partitions_not_reviewed: maximum },
    { state: 'limit' },
  ]) {
    const result = flow.statusDescription(value);
    assert.equal(result.description.length <= 140, true);
    assert.deepEqual(hygiene.internalLeakViolations('status', result.description), []);
    assert.equal(result.state, value.verdict === 'pass' ? 'success' : 'pending');
  }
  assert.throws(() => flow.statusDescription({ state: 'current', verdict: 'needs-fix', blocking_count: 'model text', warning_count: 0 }));
});

test('comment stays within 60000 characters and names omitted findings', () => {
  const f = fixture();
  try {
    f.seal(raw(true, Array.from({ length: 128 }, (_, i) => ({ ...blocker, id: 'finding-' + i,
      summary: 's'.repeat(1024), failure_scenario: 'f'.repeat(1024) }))));
    const result = flow.publish(f.input(), f.options);
    assert.equal(result.comment.ok, true); assert(f.comments[0].body.length <= 60000);
    assert.match(f.comments[0].body, /and \d+ more/); assert.match(f.comments[0].body, /citations_unresolved: 0/);
  } finally { f.cleanup(); }
});

const importsCheckState = source => /(?:require\s*\(\s*|from\s*|import\s*(?:\(\s*)?)(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?['"][^'"]*check-state\.cjs['"]/.test(source);

test('the reader registry recognizes direct imports and path-built requires', () => {
  for (const source of [
    "require('./check-state.cjs')",
    "require(path.join(__dirname, 'check-state.cjs'))",
    "require(path.resolve(__dirname, 'check-state.cjs'))",
    "import { classify } from './check-state.cjs'",
    "import('./check-state.cjs')",
  ]) assert.equal(importsCheckState(source), true, source);
  assert.equal(importsCheckState("require(path.join(__dirname, 'other.cjs'))"), false);
});

const readerSources = () => fs.readdirSync(scripts, { recursive: true }).filter(file => /\.[cm]?js$/.test(file))
  .map(file => [file, fs.readFileSync(path.join(scripts, file), 'utf8')]);
function assertReaderRegistry(sources) {
  const message = 're-audit the check-rollup readers (plan 52-11)';
  assert.deepEqual(sources.filter(([, source]) => importsCheckState(source))
    .map(([file]) => file).sort(), ['ci-wait.cjs', 'front.cjs', 'sentinel.cjs', 'state-sync.cjs'], message);
  assert.deepEqual(sources.filter(([, source]) => /['"]pr['"]\s*,\s*['"]checks['"]\s*,\s*String\(/.test(source))
    .map(([file]) => file).sort(), ['ci-wait.cjs', 'sentinel.cjs', 'state-sync.cjs'], message);
}

test('check rollup reader registry requires a new audit for any added reader', () => {
  assertReaderRegistry(readerSources());
});

test('reader registry rejects an added importer or direct checks caller', () => {
  const sources = readerSources();
  assertReaderRegistry(sources);
  for (const source of [
    "require('./check-state.cjs')",
    "require(path.join(__dirname, 'check-state.cjs'))",
    "require(path.resolve(__dirname, 'check-state.cjs'))",
    "import { classify } from './check-state.cjs'",
    "import('./check-state.cjs')",
    "gh(['pr', 'checks', String(pr)])",
  ]) assert.throws(() => assertReaderRegistry([...sources, ['new-reader.cjs', source]]),
    /re-audit the check-rollup readers \(plan 52-11\)/, source);
});

test('readGate ignores a newer pending code-review status beside merge-gate success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-gate-'));
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(root, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' \'[{"context":"code-review","state":"pending"},{"context":"merge-gate","state":"success","description":"arch-review=conform"}]\'\n', { mode: 0o700 });
    process.env.PATH = root + path.delimiter + previousPath;
    const gate = require(path.join(scripts, 'gate-trailer.cjs')).readGate({ repo: 'owner/repo', sha: 'a'.repeat(40) });
    assert.equal(gate['arch-review'], 'conform'); assert.equal(gate.head, 'a'.repeat(40));
  } finally { process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); }
});


test('published retained locator reloads the original target and leaves a later twin blocking', () => {
  const f = fixture();
  try {
    const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
    const writeSource = text => {
      fs.writeFileSync(path.join(f.root, 'source.js'), text);
      f.git(['add', 'source.js']); f.git(['commit', '--quiet', '-m', 'update source']);
    };
    const carrier = path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json');
    const writeCarrier = entry => {
      fs.mkdirSync(path.dirname(carrier), { recursive: true });
      fs.writeFileSync(carrier, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
        entries: [{ ...entry, reason: 'Caller handles absence', recorded_by: 'operator' }] }));
    };
    const load = priorFindings => core.loadDisagreements({ projectRoot: f.root, phaseDirName: f.phase,
      priorFindings, readFile: file => ({ text: fs.readFileSync(file), stat: fs.lstatSync(file) }) }).entries;
    writeSource('function a() {\nreturn null;\n}\nreturn null;\n');
    f.seal(raw(true, [{ ...blocker, line: 4, line_text: 'return null;' }]));
    const first = f.lookup(), firstHead = f.live().headRefOid;
    const original = { path: 'source.js', line_text: 'return null;', occurrence: 2 };
    writeCarrier(original);
    const entries = load(core.carryPriorFindings({ priorFindings: first, deltaDiff: '', readSource }));
    writeSource('return null;\nfunction a() {\nreturn null;\n}\nreturn null;\n');
    const prior = core.carryPriorFindings({ priorFindings: first,
      deltaDiff: f.git(['diff', '--unified=3', firstHead, 'HEAD', '--', 'source.js']), disagreements: entries, readSource });
    f.seal(raw(), 2, firstHead, prior);
    const second = f.lookup(), secondHead = f.live().headRefOid;
    assert.equal(second.findings[0].line, 5);
    assert.equal(second.findings[0].occurrence, 3);
    assert.equal(second.findings[0].disagreement_identity, first.findings[0].identity);
    const before = JSON.stringify(second);
    const originalArtifact = fs.readFileSync(second.artifact_ref);
    const originalCarrier = fs.readFileSync(carrier);
    fs.unlinkSync(carrier);
    assert.equal(f.lookup(), null);
    assert.deepEqual(fs.readFileSync(second.artifact_ref), originalArtifact);
    assert.equal(second.round, 2);
    assert.throws(() => flow.publish(f.input(), f.options));
    assert.equal(f.writes.length, 0);
    fs.writeFileSync(carrier, originalCarrier);
    assert.equal(flow.publish(f.input(), f.options).comment.ok, true);
    assert.equal(JSON.stringify(f.lookup()), before);
    const body = f.comments[0].body;
    assert.match(body, /source.js:5/);
    assert.match(body, /Source line \(full text\), occurrence 3/);
    const tuple = JSON.parse(body.split('\n').find(line => line.startsWith('    {')).trim());
    assert.deepEqual(tuple, original);
    const latest = core.carryPriorFindings({ priorFindings: second, deltaDiff: '', readSource });
    writeCarrier(tuple);
    const reloaded = load(latest);
    assert.deepEqual(Object.keys(reloaded), [first.findings[0].identity]);
    for (const patch of [{ occurrence: 3 }, { path: 'other.js' }, { line_text: 'return true;' }]) {
      writeCarrier({ ...tuple, ...patch });
      assert.throws(() => load(latest), { code: 'DISPOSITION_TARGET_UNKNOWN' });
    }
    writeCarrier(tuple);
    const thirdPrior = core.carryPriorFindings({ priorFindings: second, deltaDiff: '', disagreements: load(latest), readSource });
    f.seal(raw(true, [{ ...blocker, id: 'later-twin', line: 3, line_text: 'return null;' }]), 3, secondHead, thirdPrior);
    const third = f.lookup();
    assert.equal(third.blocking_count, 1);
    assert.equal(third.disagreement_suppressed, 1);
    assert.equal(third.findings.find(finding => finding.id === 'later-twin').blocking, true);
    assert.equal(flow.publish(f.input(), f.options).comment.ok, true);
    const thirdLatest = core.carryPriorFindings({ priorFindings: third, deltaDiff: '', readSource });
    const blocks = f.comments[0].body.split(/(?=BLOCKER \[)/).slice(1);
    assert.equal(blocks.length, 2);
    for (const block of blocks) {
      const targetIndex = third.findings.findIndex(finding => block.startsWith(`BLOCKER [${finding.rule}] ${finding.path}:${finding.line}`));
      const tupleLine = block.split('\n').find(line => line.startsWith('    {'));
      if (third.findings[targetIndex].id === 'later-twin') {
        assert.equal(tupleLine, undefined);
        assert.match(block, /No reusable original locator is available/);
      } else {
        writeCarrier(JSON.parse(tupleLine.trim()));
        const carried = core.carryPriorFindings({ priorFindings: third, deltaDiff: '', readSource,
          disagreements: load(thirdLatest) });
        assert.deepEqual(carried.map((finding, index) => finding.disagreement ? index : null).filter(index => index !== null),
          [targetIndex]);
      }
    }
    assert.deepEqual(Object.keys(load(thirdLatest)), [first.findings[0].identity]);
  } finally { f.cleanup(); }
});


for (const linked of [false, true]) test('retained locators require authenticated history or a validated original carrier: linked=' + linked, () => {
  const f = fixture();
  let coordinatorDirectory;
  try {
    if (linked) coordinatorDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-coordinator-')));
    const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
    fs.writeFileSync(path.join(f.root, 'source.js'), 'function a() {\nreturn null;\n}\nreturn null;\n');
    f.git(['add', 'source.js']); f.git(['commit', '--quiet', '-m', 'original twins']);
    const originalHead = f.live().headRefOid;
    const first = core.normalizeResult(raw(true, [{ ...blocker, line: 4, line_text: 'return null;' }]),
      { round: 1, scope: 'full', readSource });
    const original = { path: 'source.js', line_text: 'return null;', occurrence: 2,
      reason: 'Caller handles absence', recorded_by: 'operator' };
    const entries = core.parseDisagreements(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
      entries: [original] }), { priorFindings: core.carryPriorFindings({ priorFindings: first, deltaDiff: '', readSource }) });
    fs.writeFileSync(path.join(f.root, 'source.js'), 'return null;\nfunction a() {\nreturn null;\n}\nreturn null;\n');
    f.git(['add', 'source.js']); f.git(['commit', '--quiet', '-m', 'source twins']);
    const prior = core.carryPriorFindings({ priorFindings: first,
      deltaDiff: f.git(['diff', '--unified=3', originalHead, 'HEAD', '--', 'source.js']), disagreements: entries, readSource });
    assert.equal(prior[0].occurrence, 3);
    const coordinator = linked ? path.join(coordinatorDirectory, 'checkout') : f.root;
    if (linked) {
      f.git(['worktree', 'add', '--detach', coordinator, 'HEAD']);
      fs.cpSync(path.join(f.root, '.planning'), path.join(coordinator, '.planning'), { recursive: true });
    }
    f.setPlanningRoot(coordinator);
    const carrier = path.join(coordinator, '.planning/phases', f.phase, 'code-review-disagreements.json');
    fs.mkdirSync(path.dirname(carrier), { recursive: true });
    fs.writeFileSync(carrier, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [original] }));
    const originalCarrier = fs.readFileSync(carrier);
    f.seal(raw(), 1, null, prior);
    const before = JSON.stringify(f.lookup());
    const originalArtifact = fs.readFileSync(JSON.parse(before).artifact_ref);
    const publicationInput = () => linked ? { ...f.input(), graphDir: path.join(coordinator, path.relative(f.root, f.graphDir)) } : f.input();
    if (linked) {
      const stale = path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json');
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [original] }));
    }
    fs.mkdirSync(path.dirname(carrier), { recursive: true });
    for (const patch of [null, { occurrence: 3 }, { path: 'other.js' }, { line_text: 'return true;' },
      { occurrence: 0 }, 'invalid', 'symlink', {}]) {
      fs.rmSync(carrier, { force: true });
      if (patch === 'invalid') fs.writeFileSync(carrier, '{');
      else if (patch === 'symlink') fs.symlinkSync(path.join(coordinator, '.planning/config.json'), carrier);
      else if (patch) fs.writeFileSync(carrier, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
        entries: [{ ...original, ...patch }] }));
      if (patch && typeof patch === 'object' && Object.keys(patch).length === 0) {
        assert.deepEqual(fs.readFileSync(carrier), originalCarrier);
      } else {
        assert.equal(f.lookup(), null);
        assert.throws(() => flow.publish(publicationInput(), f.options));
        const history = artifact.priorCodeReviewVerdicts({ worktreePath: f.root,
          graphDir: path.join(coordinator, '.planning/graph'), repository: target.repositoryIdentity(f.root), phaseDir: f.phase });
        assert.equal(history.length, 1);
        assert.equal(history[0].review_round, 1);
        assert.deepEqual(fs.readFileSync(history[0].artifact_ref), originalArtifact);
        assert.equal(history[0].artifact_digest, JSON.parse(before).artifact_digest);
        assert.deepEqual(history[0].findings, JSON.parse(before).findings);
      }
      fs.rmSync(carrier, { force: true });
      fs.writeFileSync(carrier, originalCarrier);
      assert.equal(flow.publish(publicationInput(), f.options).comment.ok, true);
      const body = f.comments[0].body;
      assert.match(body, /Source line \(full text\), occurrence 3/);
      const tuple = JSON.parse(body.split('\n').find(line => line.startsWith('    {')).trim());
      assert.deepEqual(tuple, { path: original.path, line_text: original.line_text, occurrence: 2 });
      const sealed = f.lookup();
      const latest = core.carryPriorFindings({ priorFindings: sealed, deltaDiff: '', readSource });
      const loaded = core.loadDisagreements({ projectRoot: coordinator, phaseDirName: f.phase,
        priorFindings: latest, readFile: file => ({ text: fs.readFileSync(file), stat: fs.lstatSync(file) }) });
      assert.deepEqual(Object.keys(loaded.entries), [sealed.findings[0].disagreement_identity]);
      assert.equal(JSON.stringify(f.lookup()), before);
    }
  } finally {
    try { f.cleanup(); }
    finally { if (coordinatorDirectory) fs.rmSync(coordinatorDirectory, { recursive: true, force: true }); }
  }
});

function retainPlanningInput(f, input, planningRoot = f.root, repo = null) {
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const crypto = require('node:crypto');
  const refs = input.result.ticket_set.map(item => item.row.plan);
  for (const plan of refs) {
    const absolute = path.join(planningRoot, plan);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, '# Original complete acceptance\n');
  }
  const graphDir = path.join(planningRoot, '.planning/graph');
  const carrier = path.join(planningRoot, '.planning/phases', f.phase, 'code-review-disagreements.json');
  let dispositionsDigest = null;
  try { dispositionsDigest = crypto.createHash('sha256').update(fs.readFileSync(carrier)).digest('hex'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  input.result.dispositions_digest = dispositionsDigest;
  const packet = packets.buildContextPacket({ root: planningRoot, role: 'code-review', subject: input.ticket,
    sourceRevision: input.result.head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: ['source.js'] }, requiredRefs: refs, roleContext: {
      planning_reference: packets.resolvePlanningReference({ worktree: f.root, graphDir, repo }),
      ticket_set: input.result.ticket_set, prior_findings: [], plan_acceptance: [],
      exact_diff: { content: f.git([
        'diff', '--no-ext-diff', '--no-textconv', '--unified=50',
        input.result.review_scope === 'delta' ? input.result.prior_head : f.base,
        'HEAD', ...require('../../plugins/delivery-pipeline/scripts/development-artifacts.cjs').productPathspec()
      ]) },
      dispositions_digest: dispositionsDigest, integration_base: { commit: f.base } } });
  input.result.host_context = { planning_reference: packet.role_context.planning_reference,
    selected_refs: packet.required_refs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) };
  const boundary = createDispatchBoundary({ recorder: f.recorder, adapters: { claude: { launch(r) {
    const session = 'original-' + r.dispatch_id;
    const transcript = path.join(planningRoot, '.planning', session + '.jsonl');
    const content = JSON.stringify({ type: 'user', sessionId: session, message: {
      content: '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet))
        + '\n</AUTHENTICATED_CONTEXT_PACKET>' } }) + '\n';
    fs.writeFileSync(transcript, content);
    return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
      launch_id: session, session_id: session, requested_model: r.requested_model, requested_effort: r.requested_effort,
      applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
      policy_hash: r.policy_hash, selection_evidence: { source: 'claude-session-assistant-transcript',
        session_id: session, assistant_records: 1, model: r.model, effort: r.effort,
        transcript: { path: transcript, bytes: Buffer.byteLength(content),
          sha256: crypto.createHash('sha256').update(content).digest('hex') } } };
  } } } });
  const dispatch = boundary.dispatch({ runtime: 'claude', role: 'code-review', signals: {} },
    { ticket: input.ticket, subject_kind: 'phase' });
  return { ...input, dispatchId: dispatch.dispatch_id };
}

function publicationState(f, pr = 52) {
  const crypto = require('node:crypto');
  const namespace = crypto.createHash('sha256').update(JSON.stringify([target.repositoryIdentity(f.root), null])).digest('hex');
  const directory = path.join(home, '.local/state/shipyard/code-review-publications', namespace);
  return { directory, file: path.join(directory, `${pr}.json`) };
}

function publicationSnapshot(f) {
  const { directory } = publicationState(f);
  if (!fs.existsSync(directory)) return null;
  const snapshot = [];
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    snapshot.push({ path: relative, mode: stat.mode & 0o777, uid: stat.uid,
      bytes: stat.isFile() ? fs.readFileSync(file, 'hex') : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
  };
  walk(directory, '.');
  return snapshot;
}

function assertConfigRefusal(action, file) {
  assert.throws(action, error => {
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.equal(error.file, file);
    assert(error.message.includes(file), error.message);
    return true;
  });
}

test('existing malformed, array, scalar, null and unreadable configs refuse', () => {
  const f = fixture();
  const originalRead = fs.readFileSync;
  try {
    f.seal();
    const file = path.join(f.root, '.planning/config.json');
    const before = publicationSnapshot(f);
    let reads = 0;
    f.hooks.readPR = () => { reads++; };
    for (const bytes of ['{', '[]', '"report"', '42', 'true', 'null']) {
      fs.writeFileSync(file, bytes);
      assertConfigRefusal(() => flow.publish(f.input(), f.options), file);
      assert.equal(reads, 0);
      assert.equal(f.writes.length, 0); assert.deepEqual(publicationSnapshot(f), before);
    }
    fs.writeFileSync(file, '{}');
    fs.readFileSync = function (name, ...args) {
      if (name === file) throw Object.assign(new Error('config unreadable'), { code: 'EACCES' });
      return originalRead.call(this, name, ...args);
    };
    assertConfigRefusal(() => flow.publish(f.input(), f.options), file);
    assert.equal(reads, 0);
    assert.equal(f.writes.length, 0); assert.deepEqual(publicationSnapshot(f), before);
  } finally { fs.readFileSync = originalRead; f.cleanup(); }
});

test('absent config preserves defaults with a verdict sealed under those defaults', () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.root, '.planning/config.json'));
    f.seal();
    const published = flow.publish(f.input(), f.options);
    assert.equal(published.status.ok, true); assert.equal(published.comment.action, 'created');
  } finally { f.cleanup(); }
});

test('config invalidation during the final live-head read refuses the status POST', () => {
  const f = fixture();
  try {
    f.seal();
    const file = path.join(f.root, '.planning/config.json'), before = publicationSnapshot(f);
    let reads = 0;
    f.hooks.readPR = pr => { if (pr === 52 && ++reads === 2) fs.writeFileSync(file, '[]'); };
    assertConfigRefusal(() => flow.publish(f.input(), f.options), file);
    assert.equal(reads, 2); assert.equal(f.writes.length, 0);
    assert.deepEqual(publicationSnapshot(f), before);
  } finally { f.cleanup(); }
});

for (const statusFails of [false, true]) test('invalidation after status stops namespace initialization: statusFails=' + statusFails, () => {
  const f = fixture();
  try {
    f.seal();
    const file = path.join(f.root, '.planning/config.json'), before = publicationSnapshot(f);
    f.hooks.status = () => fs.writeFileSync(file, 'null');
    if (statusFails) f.failStatus();
    assertConfigRefusal(() => flow.publish(f.input(), f.options), file);
    assert.equal(f.writes.length, 1); assert(f.writes[0].endpoint.includes('/statuses/'));
    assert.equal(f.comments.length, 0); assert.deepEqual(publicationSnapshot(f), before);
  } finally { f.cleanup(); }
});

test('invalidation after namespace validation prevents lock initialization', () => {
  const f = fixture();
  const originalLstat = fs.lstatSync, originalMkdir = fs.mkdirSync;
  try {
    f.seal();
    const file = path.join(f.root, '.planning/config.json'), { directory } = publicationState(f);
    let invalidated = false, laterMkdirs = 0, before;
    fs.lstatSync = function (name, ...args) {
      const stat = originalLstat.call(this, name, ...args);
      if (name === directory && !invalidated) {
        invalidated = true;
        before = publicationSnapshot(f);
        fs.writeFileSync(file, '[]');
      }
      return stat;
    };
    fs.mkdirSync = function (name, ...args) {
      if (invalidated && (name === directory || String(name).startsWith(directory + path.sep))) laterMkdirs++;
      return originalMkdir.call(this, name, ...args);
    };
    assertConfigRefusal(() => flow.publish(f.input(), f.options), file);
    assert.equal(invalidated, true); assert.equal(laterMkdirs, 0);
    assert.equal(f.writes.length, 1); assert.equal(f.comments.length, 0);
    assert.deepEqual(publicationSnapshot(f), before);
  } finally { fs.lstatSync = originalLstat; fs.mkdirSync = originalMkdir; f.cleanup(); }
});

for (const bound of [false, true]) {
  for (const boundary of ['lookup', 'live-head', 'comment-write', 'comment', 'temporary-file', 'atomic-write']) {
    test('invalidation before ' + boundary + ' stops later mutations: bound=' + bound, () => {
      const f = fixture();
      const originalOpen = fs.openSync, originalClose = fs.closeSync, originalLstat = fs.lstatSync;
      try {
        f.seal();
        const state = publicationState(f), config = path.join(f.root, '.planning/config.json');
        if (bound) {
          assert.equal(flow.publish(f.input(), f.options).comment.action, 'created');
          const head = f.live().headRefOid;
          f.seal(raw(), 2, head);
        } else fs.mkdirSync(state.directory, { recursive: true, mode: 0o700 });
        const human = { id: 91, body: '<!-- code-review --> Human discussion.\r\n' };
        f.comments.push(human);
        const before = publicationSnapshot(f), comments = structuredClone(f.comments);
        f.writes.length = 0;
        let invalidated = false, temporaryFd, temporaryOpens = 0;
        const invalidate = () => { invalidated = true; fs.writeFileSync(config, '{'); };
        fs.openSync = function (name, ...args) {
          const fd = originalOpen.call(this, name, ...args);
          if (name === path.join(state.directory, `.52.json.tmp-${process.pid}`) && args[0] === 'wx') {
            temporaryOpens++;
            if (boundary === 'atomic-write') temporaryFd = fd;
          }
          return fd;
        };
        if (boundary === 'lookup') f.hooks.lookup = invalidate;
        else if (boundary === 'live-head') {
          let reads = 0;
          f.hooks.readPR = pr => { if (pr === 52 && ++reads === 3) invalidate(); };
        } else if (boundary === 'comment') f.hooks.comment = invalidate;
        else if (boundary === 'comment-write' || boundary === 'temporary-file') {
          let reads = 0;
          const watched = boundary === 'comment-write' ? state.directory : state.file;
          const finalRead = boundary === 'comment-write' ? 3 : bound ? 4 : 2;
          fs.lstatSync = function (name, ...args) {
            try { return originalLstat.call(this, name, ...args); }
            finally { if (name === watched && ++reads === finalRead) invalidate(); }
          };
        } else {
          fs.closeSync = function (fd) {
            const result = originalClose.call(this, fd);
            if (fd === temporaryFd) { temporaryFd = undefined; invalidate(); }
            return result;
          };
        }
        assertConfigRefusal(() => flow.publish(f.input(), f.options), config);
        assert.equal(invalidated, true);
        const commentCompleted = ['comment', 'temporary-file', 'atomic-write'].includes(boundary);
        assert.equal(f.writes.length, commentCompleted ? 2 : 1);
        assert(f.writes[0].endpoint.includes('/statuses/'));
        if (commentCompleted) {
          assert.equal(f.writes[1].method, bound ? 'PATCH' : 'POST');
          assert.match(f.comments.find(comment => comment.id !== 91).body, /Code review/);
          if (bound) assert.notEqual(f.comments[0].body, comments[0].body);
        } else assert.deepEqual(f.comments, comments);
        assert.equal(temporaryOpens, boundary === 'atomic-write' ? 1 : 0);
        assert.equal(human.body, '<!-- code-review --> Human discussion.\r\n');
        assert.deepEqual(publicationSnapshot(f), before);
      } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; fs.lstatSync = originalLstat; f.cleanup(); }
    });
  }
}

function coldPublisher() {
  const file = path.join(scripts, 'phase-code-review.cjs');
  delete require.cache[require.resolve(file)];
  return require(file);
}

test('unbound human marker quotations, legacy summaries and copied genuine reports remain byte exact', () => {
  const f = fixture(), donor = fixture();
  try {
    donor.seal(); assert.equal(flow.publish(donor.input(), donor.options).comment.ok, true);
    const bodies = ['Human quotes <!-- code-review --> inline.\nDo not edit.\r\n',
      '<!-- code-review -->\nCode review — round 1, scope full\nHuman discussion.',
      '<!-- code-review -->\nprevious host summary without a binding', donor.comments[0].body];
    f.comments.push(...bodies.map((body, index) => ({ id: 91 + index, body })));
    f.seal();
    const first = flow.publish(f.input(), f.options);
    assert.equal(first.status.ok, true); assert.equal(first.comment.action, 'created');
    assert(first.comment.id > 94);
    const second = coldPublisher().publish(f.input(), f.options);
    assert.equal(second.comment.action, 'edited'); assert.equal(second.comment.id, first.comment.id);
    assert.deepEqual(f.comments.slice(0, 4).map(comment => comment.body), bodies);
    assert.deepEqual(f.writes.filter(write => write.method === 'PATCH').map(write => write.endpoint),
      [`repos/{owner}/{repo}/issues/comments/${first.comment.id}`]);
  } finally { f.cleanup(); donor.cleanup(); }
});

test('manual edits and deletion replace the binding; later sealed heads reuse the eligible ID', () => {
  const f = fixture();
  try {
    f.seal(); const head = f.live().headRefOid;
    const first = flow.publish(f.input(), f.options);
    f.comments[0].body += '\nHuman clarification.\r\n'; const edited = f.comments[0].body;
    const replacement = flow.publish(f.input(), f.options);
    assert.equal(replacement.comment.action, 'created'); assert.notEqual(replacement.comment.id, first.comment.id);
    assert.equal(f.comments[0].body, edited);
    f.seal(raw(), 2, head);
    const next = coldPublisher().publish(f.input(), f.options);
    assert.equal(next.comment.action, 'edited'); assert.equal(next.comment.id, replacement.comment.id);
    assert.match(f.comments[1].body, /round 2/); assert.equal(f.comments[0].body, edited);
    f.comments.splice(1, 1);
    const deleted = flow.publish(f.input(), f.options);
    assert.equal(deleted.comment.action, 'created'); assert.equal(f.comments[0].body, edited);
    assert(!f.writes.some(write => write.method === 'PATCH' && write.endpoint.endsWith('/' + first.comment.id)));
  } finally { f.cleanup(); }
});

for (const mutation of ['json', 'oversize', 'directory', 'symlink', 'mode', 'namespace-mode', 'ancestor-symlink',
  'schema', 'repository', 'selector', 'pr', 'comment_id', 'body_hash', 'unreadable', 'wrong-owner']) {
  test('unsafe existing private publication state refuses independently: ' + mutation, () => {
    const f = fixture(); let restore = () => {};
    try {
      f.seal(); assert.equal(flow.publish(f.input(), f.options).comment.ok, true);
      const { file, directory } = publicationState(f);
      const original = f.comments[0].body;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (mutation === 'json') fs.writeFileSync(file, '{');
      else if (mutation === 'oversize') fs.writeFileSync(file, ' '.repeat(8193));
      else if (mutation === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
      else if (mutation === 'symlink') { fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file); }
      else if (mutation === 'ancestor-symlink') {
        fs.renameSync(directory, directory + '.saved'); fs.symlinkSync(directory + '.saved', directory);
      } else if (mutation === 'mode') fs.chmodSync(file, 0o644);
      else if (mutation === 'namespace-mode') fs.chmodSync(directory, 0o755);
      else if (mutation === 'unreadable' || mutation === 'wrong-owner') {
        const originalOpen = fs.openSync, originalLstat = fs.lstatSync;
        fs.openSync = function (name, ...args) {
          if (name === file && mutation === 'unreadable') throw Object.assign(new Error('unreadable state'), { code: 'EACCES' });
          return originalOpen.call(this, name, ...args);
        };
        fs.lstatSync = function (name, ...args) {
          const stat = originalLstat.call(this, name, ...args);
          if (name === file && mutation === 'wrong-owner') stat.uid += 1;
          return stat;
        };
        restore = () => { fs.openSync = originalOpen; fs.lstatSync = originalLstat; };
      } else {
        record[mutation] = ({ schema: 'unknown', repository: '/wrong/repository', selector: 'other/repo',
          pr: 53, comment_id: '77', body_hash: 'bad' })[mutation];
        fs.writeFileSync(file, JSON.stringify(record));
      }
      const before = f.writes.length;
      const result = flow.publish(f.input(), f.options);
      assert.equal(result.status.ok, true); assert.equal(result.comment.ok, false);
      assert.equal(f.writes.length, before + 1); assert.equal(f.comments[0].body, original);
    } finally { restore(); f.cleanup(); }
  });
}

for (const invalid of [null, {}, { id: '77' }, { id: 0 }, { id: -1 }, { id: 1.5 },
  { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 77, body: 'different bytes' }]) {
  test('invalid POST response never binds copied public text: ' + JSON.stringify(invalid), () => {
    const f = fixture();
    try {
      f.seal();
      const options = { ...f.options, gh(args) {
        const response = f.options.gh(args);
        return args.includes('--method') ? invalid : response;
      } };
      const failed = flow.publish(f.input(), options);
      assert.equal(failed.comment.ok, false); assert.equal(failed.status.ok, true);
      assert.equal(fs.existsSync(publicationState(f).file), false);
      const old = f.comments[0].body;
      const retry = coldPublisher().publish(f.input(), f.options);
      assert.equal(retry.comment.action, 'created'); assert.equal(f.comments[0].body, old);
      assert(!f.writes.some(write => write.method === 'PATCH'));
    } finally { f.cleanup(); }
  });
}

for (const failure of ['wrong-id', 'body', 'lookup', 'write', 'temporary-symlink', 'head-race']) {
  test('bound publication fails closed after ' + failure, () => {
    const f = fixture(); let restore = () => {};
    try {
      f.seal(); const first = flow.publish(f.input(), f.options);
      const state = publicationState(f), bytes = fs.readFileSync(state.file, 'utf8');
      const human = { id: 91, body: '<!-- code-review --> human bytes\r\n' }; f.comments.push(human);
      if (failure === 'write') {
        const original = fs.renameSync;
        fs.renameSync = function (from, to) { if (to === state.file) throw new Error('state write failed'); return original.call(this, from, to); };
        restore = () => { fs.renameSync = original; };
      }
      if (failure === 'temporary-symlink') fs.symlinkSync(state.file,
        path.join(state.directory, `.52.json.tmp-${process.pid}`));
      let reads = 0;
      const options = { ...f.options,
        getPullRequest(args) {
          const live = f.options.getPullRequest(args);
          if (args.pr === 52 && ++reads === 3 && failure === 'head-race') return { ...live, headRefOid: f.base };
          return live;
        },
        gh(args) {
          if (failure === 'lookup' && args.includes('--slurp')) return [{}];
          const response = f.options.gh(args);
          if (args.includes('PATCH') && failure === 'wrong-id') return { ...response, id: 91 };
          if (args.includes('PATCH') && failure === 'body') return { ...response, body: response.body + 'changed' };
          return response;
        } };
      const result = flow.publish(f.input(), options);
      assert.equal(result.status.ok, true); assert.equal(result.comment.ok, false);
      assert.equal(fs.readFileSync(state.file, 'utf8'), bytes);
      assert.equal(human.body, '<!-- code-review --> human bytes\r\n');
      assert(!f.writes.some(write => write.method === 'PATCH' && write.endpoint.endsWith('/91')));
      assert.equal(first.comment.ok, true);
    } finally { restore(); f.cleanup(); }
  });
}

test('canonical repositories and PRs cannot borrow a valid binding', () => {
  const f = fixture(), other = fixture();
  try {
    f.seal(); other.seal(); const first = flow.publish(f.input(), f.options);
    other.comments.push({ ...f.comments[0] });
    const second = flow.publish(other.input(), other.options);
    assert.equal(second.comment.action, 'created'); assert.notEqual(second.comment.id, first.comment.id);
    const origin = publicationState(f), destination = publicationState(other);
    fs.copyFileSync(origin.file, destination.file);
    const failed = flow.publish(other.input(), other.options);
    assert.equal(failed.comment.ok, false); assert.equal(failed.status.ok, true);
    const record = JSON.parse(fs.readFileSync(origin.file, 'utf8'));
    record.pr = 53; fs.writeFileSync(origin.file, JSON.stringify(record));
    const wrongPr = flow.publish(f.input(), f.options);
    assert.equal(wrongPr.comment.ok, false); assert.equal(wrongPr.status.ok, true);
  } finally { f.cleanup(); other.cleanup(); }
});

function installPublicationGh(directory) {
  fs.writeFileSync(path.join(directory, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.PUBLISH_TEST_DATA;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'pr') {
  console.log(JSON.stringify(Number(args[2]) === 52 ? data.epic : data.ticket));
} else if (!args.includes('-f')) {
  const comments = fs.existsSync(file + '.comments') ? JSON.parse(fs.readFileSync(file + '.comments', 'utf8')) : [];
  console.log(JSON.stringify([comments]));
} else {
  fs.appendFileSync(data.log, JSON.stringify(args) + '\\n');
  if (args[1].includes('/statuses/')) console.log('{}');
  else {
    const comments = fs.existsSync(file + '.comments') ? JSON.parse(fs.readFileSync(file + '.comments', 'utf8')) : [];
    const body = args.find((v, i) => args[i - 1] === '-f' && v.startsWith('body=')).slice(5);
    let comment;
    if (args.includes('PATCH')) comment = comments.find(c => args[1].endsWith('/' + c.id));
    else { comment = { id: Math.max(76, ...comments.map(c => c.id)) + 1 }; comments.push(comment); }
    comment.body = body;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    fs.writeFileSync(file + '.comments', JSON.stringify(comments));
    console.log(JSON.stringify(comment));
  }
}
`, { mode: 0o700 });
}

function childPublication(argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 0, stdout + stderr); resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
  });
}

test('concurrent cold processes and both runtimes reuse one canonical repository binding', async () => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-producers-'));
  try {
    f.seal();
    const preload = path.join(directory, 'preload.cjs');
    fs.writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(home)};\n`);
    const data = path.join(directory, 'data.json');
    fs.writeFileSync(data, JSON.stringify({ epic: f.live(), ticket: { number: 1, headRefOid: f.base },
      log: path.join(directory, 'writes.jsonl') }));
    installPublicationGh(directory);
    const argv = owner => ['--require', preload, owner, 'publish', f.phase, '--phase', '52', '--pr', '52',
      '--graph', f.graphDir, '--worktree', f.root];
    const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH, PUBLISH_TEST_DATA: data };
    const results = await Promise.all([
      childPublication(argv(path.join(scripts, 'phase-code-review.cjs')), env),
      childPublication(argv(path.resolve(__dirname,
        '../../plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs')), env),
    ]);
    assert.deepEqual(results.map(result => result.comment.action).sort(), ['created', 'edited']);
    assert.equal(results[0].comment.id, results[1].comment.id);
    const comments = JSON.parse(fs.readFileSync(data + '.comments', 'utf8'));
    assert.equal(comments.length, 1);
    const record = JSON.parse(fs.readFileSync(publicationState(f).file, 'utf8'));
    assert.equal(record.comment_id, comments[0].id);
  } finally { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
});


test('a linked source worktree shares the canonical binding and authenticated review', () => {
  const f = fixture(), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-linked-')));
  try {
    f.seal();
    const first = flow.publish(f.input(), f.options);
    assert.equal(first.comment.ok, true);
    const linked = path.join(directory, 'checkout');
    f.git(['worktree', 'add', '--detach', linked, 'HEAD']);
    assert.equal(target.repositoryIdentity(linked), target.repositoryIdentity(f.root));
    f.sealLinked(linked);
    const next = coldPublisher().publish({ ...f.input(), worktree: linked }, f.options);
    assert.equal(next.comment.ok, true, next.comment.reason);
    assert.equal(next.comment.action, 'edited'); assert.equal(next.comment.id, first.comment.id);
    assert.equal(f.comments.length, 1);
  } finally { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('linked publication checks the graph project config rather than a worktree config', () => {
  const f = fixture(), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-config-linked-')));
  try {
    f.seal();
    const linked = path.join(directory, 'checkout');
    f.git(['worktree', 'add', '--detach', linked, 'HEAD']);
    f.sealLinked(linked);
    fs.mkdirSync(path.join(linked, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(linked, '.planning/config.json'), '{}');
    const config = path.join(f.root, '.planning/config.json'), original = fs.readFileSync(config);
    const before = publicationSnapshot(f), input = { ...f.input(), worktree: linked };
    fs.writeFileSync(config, '[]');
    assertConfigRefusal(() => flow.publish(input, f.options), config);
    assert.equal(f.writes.length, 0); assert.deepEqual(publicationSnapshot(f), before);
    fs.writeFileSync(config, original);
    fs.writeFileSync(path.join(linked, '.planning/config.json'), '[]');
    assert.equal(flow.publish(input, f.options).comment.action, 'created');
  } finally { f.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('distinct admitted PRs in the same real repository never share a binding', () => {
  const f = fixture();
  try {
    f.seal(); const first = flow.publish(f.input(), f.options);
    const request = f.input;
    const other = f.sealPr(53);
    assert(other);
    const input = { ...request(), pr: 53 };
    const options = { ...f.options, getPullRequest: ({ pr }) => pr === 53
      ? { ...f.live(), number: 53 } : f.options.getPullRequest({ pr }) };
    const second = flow.publish(input, options);
    assert.equal(second.comment.ok, true, second.comment.reason);
    assert.equal(second.comment.action, 'created'); assert.notEqual(second.comment.id, first.comment.id);
    assert.equal(JSON.parse(fs.readFileSync(publicationState(f, 52).file, 'utf8')).pr, 52);
    assert.equal(JSON.parse(fs.readFileSync(publicationState(f, 53).file, 'utf8')).pr, 53);
    fs.copyFileSync(publicationState(f, 52).file, publicationState(f, 53).file);
    assert.equal(flow.publish(input, options).comment.ok, false);
  } finally { f.cleanup(); }
});

test('a contended publication lock fails the comment independently without a write', () => {
  const f = fixture(); let handle;
  try {
    f.seal(); assert.equal(flow.publish(f.input(), f.options).comment.ok, true);
    handle = require(path.join(scripts, 'lock.cjs')).acquire(publicationState(f).directory, 'pr-52');
    assert(handle);
    const count = f.writes.length, before = f.comments[0].body;
    const result = flow.publish(f.input(), f.options);
    assert.equal(result.status.ok, true); assert.equal(result.comment.ok, false);
    assert.match(result.comment.reason, /lock/);
    assert.equal(f.writes.length, count + 1); assert.equal(f.comments[0].body, before);
  } finally { if (handle) handle.release(); f.cleanup(); }
});
