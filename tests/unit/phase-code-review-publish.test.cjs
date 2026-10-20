'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-authority-')));
const homedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = homedir; fs.rmSync(home, { recursive: true, force: true }); });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
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

function fixture(jira = null, mode = 'report') {
  const f = artifactFixture('publish');
  const branch = jira ? 'feat/PRJ-42-review' : f.branch;
  if (jira) f.git(['branch', '-m', branch]);
  f.graph.epics = { '052': { branch, phaseDir: f.phase, repos: [null], jira } };
  Object.assign(f.graph.tickets['T-52-01'], { epic: branch, branch: 'feat/review-ticket', repo: null, phaseDir: f.phase });
  fs.writeFileSync(path.join(f.root, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' },
    delivery_pipeline: { code_review: mode } }));
  f.writeGraph();
  const live = () => ({ number: 52, state: 'OPEN', headRefName: branch, headRefOid: f.git(['rev-parse', 'HEAD']),
    baseRefName: 'main', baseRefOid: f.base });
  const writes = [], comments = [];
  let ticketHead = f.base, failStatus = false, failComment = false, failLookup = false;
  const getPullRequest = ({ pr }) => pr === 52 ? live() : { number: pr, headRefOid: ticketHead };
  const options = { defaultBranch: 'main', getPullRequest, gh(args) {
    const endpoint = args[1], method = args[args.indexOf('--method') + 1];
    const fields = Object.fromEntries(args.filter((_, i) => args[i - 1] === '-f').map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    }));
    if (args.includes('--method') || args.includes('-f')) {
      writes.push({ endpoint, method, fields });
      if (endpoint.includes('/statuses/')) {
        if (failStatus) throw new Error('status unavailable');
        return {};
      }
      if (failComment) throw new Error('comment unavailable');
      if (method === 'PATCH') { comments.find(comment => endpoint.endsWith('/' + comment.id)).body = fields.body; return {}; }
      const comment = { id: 77, body: fields.body }; comments.push(comment); return comment;
    }
    if (failLookup) throw new Error('comment lookup unavailable');
    return [comments];
  } };
  const input = () => ({ phase: 52, phaseDirectory: f.phase, pr: 52, worktree: f.root, graphDir: f.graphDir });
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
      repository: target.repositoryIdentity(f.root), branch, pr: 52, head: live().headRefOid, base: f.base });
    const request = f.input(binding, round, priorHead, raw());
    Object.assign(request.result, core.normalizeResult(result, { round, scope: round === 1 ? 'full' : 'delta',
      priorFindings, readSource: file => fs.readFileSync(path.join(f.root, file), 'utf8') }));
    return artifact.sealJudgment(request);
  };
  return { ...f, branch, live, input, options, seal, writes, comments,
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
      const published = flow.publish(f.input(), f.options);
      assert.equal(published.status.state, 'pending');
      assert.equal(published.status.description, 'code review limit reached: no further review will run for this head');
      assert.equal(published.comment.action, 'skipped'); assert.equal(f.comments.length, 0); assert.equal(f.writes.length, 1);
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
    fs.writeFileSync(path.join(directory, 'gh'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const data = JSON.parse(fs.readFileSync(process.env.PUBLISH_TEST_DATA, 'utf8'));",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'pr') console.log(JSON.stringify(Number(args[2]) === 52 ? data.epic : data.ticket));",
      "else if (!args.includes('-f')) console.log('[[]]');",
      'else {',
      "  fs.appendFileSync(data.log, JSON.stringify(args) + '\\n');",
      "  console.log('{\"id\":77}');",
      '}',
    ].join('\n') + '\n', { mode: 0o700 });
    const run = spawnSync(process.execPath, ['--require', preload, path.join(scripts, 'phase-code-review.cjs'),
      'publish', f.phase, '--phase', '52', '--pr', '52', '--graph', f.graphDir, '--worktree', f.root],
    { encoding: 'utf8', env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, PUBLISH_TEST_DATA: data } });
    assert.equal(run.status, leak ? 1 : 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status.action, 'posted'); assert.equal(result.status.ok, true);
    assert.equal(result.comment.ok, !leak);
    if (leak) { assert.equal(result.comment.action, 'refused'); assert.deepEqual(result.rules, ['phase-number']); }
    const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(writes.length, leak ? 1 : 2);
    assert(writes[0][1].endsWith('/statuses/' + f.live().headRefOid));
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
    fs.unlinkSync(carrier);
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
    assert.deepEqual(Object.keys(load(core.carryPriorFindings({ priorFindings: third, deltaDiff: '', readSource }))),
      [first.findings[0].identity]);
  } finally { f.cleanup(); }
});


test('retained locators require authenticated history or a validated original carrier', () => {
  const f = fixture();
  try {
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
    f.seal(raw(), 1, null, prior);
    const before = JSON.stringify(f.lookup());
    const carrier = path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json');
    fs.mkdirSync(path.dirname(carrier), { recursive: true });
    for (const patch of [null, { occurrence: 3 }, { path: 'other.js' }, { line_text: 'return true;' },
      { occurrence: 0 }, {}]) {
      if (patch) fs.writeFileSync(carrier, JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1',
        entries: [{ ...original, ...patch }] }));
      assert.equal(flow.publish(f.input(), f.options).comment.ok, true);
      const body = f.comments[0].body;
      assert.match(body, /Source line \(full text\), occurrence 3/);
      if (patch && Object.keys(patch).length === 0) {
        const tuple = JSON.parse(body.split('\n').find(line => line.startsWith('    {')).trim());
        assert.deepEqual(tuple, { path: original.path, line_text: original.line_text, occurrence: 2 });
      } else {
        assert.match(body, /No reusable original locator is available/);
        assert(!body.split('\n').some(line => line.startsWith('    {')));
      }
      assert.equal(JSON.stringify(f.lookup()), before);
    }
  } finally { f.cleanup(); }
});
