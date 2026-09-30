'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { needsHuman } = require('../../plugins/delivery-pipeline/scripts/front.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs');
const TICKET = 'T-43-01';
const BRANCH = `ticket/${TICKET}-demo`;
const EPIC = 'epic/43-demo';
const MERGE_SHA = 'a'.repeat(40);
const LEDGER_SCHEMA = 'shipyard.pr-ledger.v1';

function pr(number, state, headRefName = BRANCH, baseRefName = EPIC) {
  return {
    number,
    state,
    isDraft: false,
    headRefName,
    headRefOid: 'b'.repeat(40),
    baseRefName,
    author: { login: 'pr-author' },
    mergedAt: state === 'MERGED' ? '2026-09-01T00:00:00Z' : null,
    createdAt: '2026-09-01T00:00:00Z',
    url: `https://example.test/pull/${number}`,
    title: `${TICKET}: demo`,
    reviewDecision: null,
    body: '',
    mergeStateStatus: 'CLEAN',
    mergeCommit: state === 'MERGED' ? { oid: MERGE_SHA } : null,
  };
}

const GH_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const fixture = JSON.parse(fs.readFileSync(process.env.STATE_SYNC_GH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STATE_SYNC_GH_CALLS, JSON.stringify(args) + '\\n');
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (args[0] === 'pr' && args[1] === 'list') {
  const head = value('--head');
  if (head && Object.prototype.hasOwnProperty.call(fixture.headRaw || {}, head)) emit(fixture.headRaw[head]);
  else if (head) emit((fixture.head || {})[head] || []);
  else if (value('--state') === 'all') emit(fixture.all || []);
  else if (value('--state') === 'open' && (value('--json') || '').includes('reviewDecision')) emit(fixture.review || fixture.open || []);
  else if (value('--state') === 'open' && Object.prototype.hasOwnProperty.call(fixture, 'openRaw')) emit(fixture.openRaw);
  else if (value('--state') === 'open') emit(fixture.open || []);
  else { process.stderr.write('unexpected PR list state\\n'); process.exit(2); }
} else if (args[0] === 'pr' && args[1] === 'view') {
  emit((fixture.view || {})[args[2]] || null);
} else if (args[0] === 'pr' && args[1] === 'checks') {
  emit([]);
} else if (args[0] === 'api') {
  const endpoint = args[1] || '';
  if (endpoint.endsWith('/branches')) emit((fixture.branches || []).join('\\n') + '\\n');
  else if (endpoint.includes('/compare/')) {
    const key = endpoint.split('/compare/')[1];
    emit(String((fixture.comparisons || {})[key] ?? 0) + '\\n');
  } else if (/\\/pulls\\/\\d+\\/reviews$/.test(endpoint)) {
    const number = Number(endpoint.match(/\\/pulls\\/(\\d+)\\/reviews$/)[1]);
    if (Object.prototype.hasOwnProperty.call(fixture.pullReviewsRaw || {}, number)) emit(fixture.pullReviewsRaw[number]);
    else emit((fixture.pullReviews || {})[number] || []);
  } else { process.stderr.write('unexpected api request: ' + endpoint + '\\n'); process.exit(2); }
} else if (args[0] === 'repo' && args[1] === 'view') {
  if ((value('--json') || '').includes('owner,name')) emit({ owner: { login: 'acme' }, name: 'demo' });
  else emit((fixture.defaultBranch || 'main') + '\\n');
} else {
  process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
  process.exit(2);
}
`;

function ticket(overrides = {}) {
  return { phase: '43', branch: BRANCH, title: 'demo', epic: EPIC, depends_on: [], risk: 'low', ...overrides };
}

function priorMergedRow(number = 301, epicState = 'MERGED', epicLanded = true) {
  return {
    branch: BRANCH,
    pr: number,
    recorded_pr: number,
    status: 'merged',
    merged_into: EPIC,
    merge_sha: MERGE_SHA,
    epic_pr: { number: 399, branch: EPIC, state: epicState, base: 'main', landed: epicLanded },
    reapable: true,
    since: '2026-09-01T00:00:00Z',
    url: `https://example.test/pull/${number}`,
  };
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-state-sync-listing-'));
  const graphDir = path.join(root, '.planning', 'graph');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
    git: { base_branch: 'main' },
    delivery_pipeline: { integration_mode: 'epic-stacked', gsd_sync: false, pr_fetch_limit: options.limit || 10 },
    pipeline: options.pipeline || {},
  }));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({
    epics: { '43': { branch: EPIC, base: 'main', repos: [null] } },
    tickets: { [TICKET]: ticket(options.ticket) },
  }));
  if (options.previousState) {
    fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify(options.previousState));
  }
  if (options.ledger) {
    fs.writeFileSync(path.join(graphDir, 'pr-ledger.json'), JSON.stringify({ schema: LEDGER_SCHEMA, entries: {
      [TICKET]: { number: options.ledger, head: BRANCH, repo: null, created_at: '2026-09-01T00:00:00Z' },
    } }));
  }
  const responseFile = path.join(root, 'gh-fixture.json');
  const callsFile = path.join(root, 'gh-calls.jsonl');
  fs.writeFileSync(responseFile, JSON.stringify({
    open: [], all: [], head: {}, view: {}, pullReviews: {}, branches: ['main', EPIC, BRANCH],
    comparisons: { [`main...${EPIC}`]: 0 },
    ...options.responses,
  }));
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  return { root, graphDir, bin, responseFile, callsFile };
}

function run(f, args = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_|GH_|GITHUB_)/.test(key)
        || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  env.HOME = path.join(f.root, 'home');
  env.PATH = f.bin + path.delimiter + env.PATH;
  env.STATE_SYNC_GH_FIXTURE = f.responseFile;
  env.STATE_SYNC_GH_CALLS = f.callsFile;
  fs.mkdirSync(env.HOME, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: f.root, env, encoding: 'utf8', timeout: 20000,
  });
}

function calls(f) {
  if (!fs.existsSync(f.callsFile)) return [];
  return fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function state(f) {
  return JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json'), 'utf8'));
}

function metadata(f) {
  return JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state-meta.json'), 'utf8'));
}

function isTicketLookup(args) {
  const headIndex = args.indexOf('--head');
  return args[0] === 'pr' && ((args[1] === 'view' && args[2] !== '399')
    || (args[1] === 'list' && headIndex !== -1 && args[headIndex + 1] === BRANCH));
}

suite('state-sync — open PR listing and immutable landed-ticket cache');

test('skips per-ticket GitHub lookups for a ledgered merge into a landed epic', () => {
  const previous = priorMergedRow(301);
  const f = fixture({
    ledger: 301,
    previousState: { [TICKET]: previous },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(f).filter(isTicketLookup).length, 0);
  assert.match(result.stdout, /listed_open=0.*looked_up=0.*skipped_landed=1/);
  assert.deepEqual(state(f)[TICKET], previous);
});

test('revalidates and records a prior landed PR after a plan rename changes its canonical branch', () => {
  const renamedBranch = 'ticket/T-43-01-renamed-plan-title';
  const previous = priorMergedRow(301);
  const merged = { ...pr(301, 'MERGED', BRANCH, EPIC), mergeCommit: { oid: MERGE_SHA } };
  const f = fixture({
    ticket: { branch: renamedBranch },
    previousState: { [TICKET]: previous },
    responses: { view: { 301: merged } },
  });

  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '301'));
  assert.equal(state(f)[TICKET].status, 'merged');
  assert.equal(state(f)[TICKET].branch, renamedBranch);
  assert.equal(state(f)[TICKET].pr_branch, BRANCH);
  assert.equal(state(f)[TICKET].recorded_pr, 301);
  assert.equal(state(f)[TICKET].merge_sha, MERGE_SHA);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'pr-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.entries[TICKET], {
    number: 301, head: BRANCH, repo: null, created_at: ledger.entries[TICKET].created_at,
  });

  fs.writeFileSync(f.callsFile, '');
  const repeated = run(f);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '301'), false);
  assert.match(repeated.stdout, /skipped_landed=1/);
});

test('an old ledger branch does not authorize a skip after the canonical branch changes', () => {
  const renamedBranch = 'ticket/T-43-01-renamed-plan-title';
  const merged = { ...pr(301, 'MERGED', BRANCH, EPIC), mergeCommit: { oid: MERGE_SHA } };
  const f = fixture({
    ticket: { branch: renamedBranch },
    ledger: 301,
    previousState: { [TICKET]: priorMergedRow(301) },
    responses: { view: { 301: merged } },
  });

  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '301'));
  assert.equal(state(f)[TICKET].status, 'merged');
  assert.equal(state(f)[TICKET].branch, renamedBranch);
  assert.equal(state(f)[TICKET].pr_branch, BRANCH);
});

test('an open ticket-ID follow-up prevents reuse of its previous landed PR', () => {
  const renamedBranch = 'ticket/T-43-01-renamed-plan-title';
  const previous = priorMergedRow(301);
  const unrelatedFollowUp = { ...pr(307, 'OPEN', 'ticket/T-43-01-follow-up'), title: 'unrelated rewrite' };
  const f = fixture({
    ticket: { branch: renamedBranch, title: 'new delivery goal' },
    previousState: { [TICKET]: previous },
    ledger: 301,
    responses: { open: [unrelatedFollowUp], review: [unrelatedFollowUp], view: { 301: pr(301, 'MERGED') } },
  });

  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state(f)[TICKET].status, 'pending');
  assert.equal(state(f)[TICKET].pr, null);
  assert.equal(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '301'), false);
});

test('a new remote branch prevents the previous landed PR from erasing fresh work', () => {
  const renamedBranch = 'ticket/T-43-01-renamed-plan-title';
  const f = fixture({
    ticket: { branch: renamedBranch },
    ledger: 301,
    previousState: { [TICKET]: priorMergedRow(301) },
    responses: {
      view: { 301: { ...pr(301, 'MERGED'), mergeCommit: { oid: MERGE_SHA } } },
      branches: ['main', EPIC, BRANCH, renamedBranch],
    },
  });

  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state(f)[TICKET].status, 'branched');
  assert.equal(state(f)[TICKET].branch, renamedBranch);
  assert.equal(state(f)[TICKET].pr, null);
});

test('finds an open ticket PR in the one bounded open listing', () => {
  const open = pr(302, 'OPEN');
  const f = fixture({ responses: { open: [open], review: [open] } });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const primaryOpenListings = calls(f).filter((args) => args[0] === 'pr' && args[1] === 'list'
    && args.includes('--state') && args[args.indexOf('--state') + 1] === 'open'
    && !(args[args.indexOf('--json') + 1] || '').includes('reviewDecision'));
  assert.equal(primaryOpenListings.length, 1);
  assert.equal(state(f)[TICKET].pr, 302);
  assert.equal(state(f)[TICKET].status, 'pr-open');
  assert.match(result.stdout, /listed_open=1/);
  assert.equal(calls(f).filter(isTicketLookup).length, 0);
});

test('state-sync publishes current human approval evidence for review checkpoints', () => {
  const approved = { ...pr(330, 'OPEN'), reviewDecision: 'APPROVED' };
  const reviewRows = [
    { user: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: 'old-head', submitted_at: '2026-09-01T00:00:00Z' },
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: approved.headRefOid, submitted_at: '2026-09-02T00:00:00Z' },
  ];
  const f = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    pipeline: { reviewer_bots: { 'acme/demo': ['review-helper*'] } },
    responses: { open: [approved], review: [approved], pullReviews: { 330: reviewRows } },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const row = state(f)[TICKET];
  assert.deepEqual(row.author, { login: 'pr-author' });
  assert.deepEqual(row.reviewer_bots, ['review-helper*']);
  assert.deepEqual(row.approved_reviews, [{
    author: 'alice', state: 'APPROVED', commit_id: approved.headRefOid,
    submitted_at: '2026-09-02T00:00:00Z', user: { login: 'alice', type: 'User' },
  }]);
  assert.equal(row.review_fresh, true);
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), row), false,
    'the front consumes the same observed fields rather than synthetic test-only values');
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), {
    ...row,
    approved_reviews: [{
      state: 'APPROVED', commit_id: approved.headRefOid,
      user: { login: 'review-helper[bot]', type: 'User' },
    }],
  }), true, 'the state-sync bot configuration prevents a machine reviewer from clearing the gate');
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), {
    ...row,
    approved_reviews: [{
      state: 'APPROVED', commit_id: approved.headRefOid,
      user: { login: 'pr-author', type: 'User' },
    }],
  }), true, 'the PR author cannot clear their own checkpoint');
  const projected = metadata(f).observation_projection.tickets[TICKET];
  assert.deepEqual(projected.author, row.author);
  assert.deepEqual(projected.reviewer_bots, row.reviewer_bots);
  assert.equal(projected.review_fresh, true);
  assert.deepEqual(projected.approved_reviews, row.approved_reviews);
  assert.equal(calls(f).filter((args) => args[0] === 'api' && /\/pulls\/330\/reviews$/.test(args[1])).length, 1,
    'one review-history read supplies every front field');
});

test('unreadable approval history leaves a review checkpoint waiting for a person', () => {
  const approved = { ...pr(331, 'OPEN'), reviewDecision: 'APPROVED' };
  const f = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    responses: { open: [approved], review: [approved], pullReviewsRaw: { 331: 'not-json' } },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const row = state(f)[TICKET];
  assert.equal(row.review_fresh, false);
  assert.deepEqual(row.approved_reviews, []);
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), row), true);
});

test('an explicit empty bot list still recognizes built-ins and a current human', () => {
  const approved = { ...pr(335, 'OPEN'), reviewDecision: 'APPROVED' };
  const reviewRows = [
    { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED',
      commit_id: 'old-head', submitted_at: '2026-09-01T00:00:00Z' },
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED',
      commit_id: approved.headRefOid, submitted_at: '2026-09-02T00:00:00Z' },
  ];
  const f = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    pipeline: { reviewer_bots: { 'acme/demo': [] } },
    responses: { open: [approved], review: [approved], pullReviews: { 335: reviewRows } },
  });
  assert.equal(run(f).status, 0);
  const row = state(f)[TICKET];
  assert.deepEqual(row.reviewer_bots, []);
  assert.equal(row.review_fresh, true);
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), row), false);
});

test('stale built-in bot alone cannot use unreadable branch rules as a waiver', () => {
  const approved = { ...pr(336, 'OPEN'), reviewDecision: 'APPROVED' };
  const f = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    responses: { open: [approved], review: [approved], pullReviews: { 336: [
      { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED',
        commit_id: 'old-head', submitted_at: '2026-09-01T00:00:00Z' },
    ] } },
  });
  assert.equal(run(f).status, 0);
  const row = state(f)[TICKET];
  assert.equal(row.review_fresh, false);
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), row), true);
  assert.ok(calls(f).some((args) => args[0] === 'api'
    && args[1].startsWith('repos/acme/demo/rules/branches/')));
});

test('a stale human verdict keeps the board aligned with the live guard', () => {
  const approved = { ...pr(334, 'OPEN'), reviewDecision: 'APPROVED' };
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'old-head', submitted_at: '2026-09-01T00:00:00Z' },
    { user: { login: 'bob', type: 'User' }, state: 'APPROVED', commit_id: approved.headRefOid, submitted_at: '2026-09-02T00:00:00Z' },
  ];
  const f = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    responses: { open: [approved], review: [approved], pullReviews: { 334: reviews } },
  });
  assert.equal(run(f).status, 0);
  const row = state(f)[TICKET];
  assert.equal(row.review_fresh, false);
  assert.equal(row.approved_reviews.some((review) => review.user.login === 'bob' && review.commit_id === approved.headRefOid), true);
  assert.equal(needsHuman(ticket({ human_checkpoint: true, checkpoint: 'review' }), row), true,
    'a current approval does not bypass the stale human verdict that blocks the sentinel');
});

test('ordinary tickets and unapproved review checkpoints do not query review history', () => {
  const ordinaryApproved = { ...pr(332, 'OPEN'), reviewDecision: 'APPROVED' };
  const normal = fixture({ responses: { open: [ordinaryApproved], review: [ordinaryApproved] } });
  assert.equal(run(normal).status, 0);
  assert.equal(calls(normal).filter((args) => args[0] === 'api' && /\/pulls\/\d+\/reviews$/.test(args[1])).length, 0);

  const waiting = { ...pr(333, 'OPEN'), reviewDecision: 'CHANGES_REQUESTED' };
  const checkpoint = fixture({
    ticket: { human_checkpoint: true, checkpoint: 'review' },
    responses: { open: [waiting], review: [waiting] },
  });
  assert.equal(run(checkpoint).status, 0);
  assert.equal(calls(checkpoint).filter((args) => args[0] === 'api' && /\/pulls\/\d+\/reviews$/.test(args[1])).length, 0);
});

test('looks up a closed-unmerged PR by its ledger number', () => {
  const closed = pr(303, 'CLOSED');
  const f = fixture({ ledger: 303, responses: { view: { 303: closed } } });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '303'));
  assert.equal(state(f)[TICKET].pr, 303);
  assert.equal(state(f)[TICKET].status, 'branched');
  assert.equal(state(f)[TICKET].merge_sha, undefined);
  assert.match(result.stdout, /looked_up=1/);
});

test('falls back to the ticket branch when its ledger PR number is missing', () => {
  const branchPr = pr(309, 'CLOSED');
  const f = fixture({
    ledger: 308,
    responses: { head: { [BRANCH]: [branchPr] } },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '308'));
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'list' && args.includes('--head')
    && args[args.indexOf('--head') + 1] === BRANCH));
  assert.equal(state(f)[TICKET].pr, 309);
  assert.equal(state(f)[TICKET].status, 'branched');
  assert.match(result.stdout, /looked_up=2/);
});

test('--full re-derives a previously landed ticket from the all-state listing', () => {
  const closed = pr(304, 'CLOSED');
  const f = fixture({
    ledger: 304,
    previousState: { [TICKET]: priorMergedRow(304) },
    responses: { all: [closed] },
  });
  const result = run(f, ['--full']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'list'
    && args.includes('--state') && args[args.indexOf('--state') + 1] === 'all'
    && !args.includes('--head')));
  assert.equal(calls(f).filter(isTicketLookup).length, 0);
  assert.equal(state(f)[TICKET].status, 'branched');
  assert.match(result.stdout, /skipped_landed=0/);
});

test('--full records the merge proof that a later normal sync can reuse', () => {
  const f = fixture({
    ledger: 308,
    responses: { all: [pr(308, 'MERGED'), pr(399, 'MERGED', EPIC, 'main')] },
  });
  const full = run(f, ['--full']);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(state(f)[TICKET].merge_sha, MERGE_SHA);
  assert.deepEqual(state(f)[TICKET].epic_pr, {
    number: 399, branch: EPIC, state: 'MERGED', base: 'main', landed: true,
  });

  fs.writeFileSync(f.callsFile, '');
  const normal = run(f);
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(calls(f).filter(isTicketLookup).length, 0);
  assert.match(normal.stdout, /looked_up=0.*skipped_landed=1/);
});

test('--full refreshes an omitted epic PR from its branch listing instead of historical merge proof', () => {
  const mergedTicketPr = pr(305, 'MERGED');
  const currentEpicPr = pr(400, 'OPEN', EPIC, 'main');
  const f = fixture({
    ledger: 305,
    previousState: { [TICKET]: priorMergedRow(305) },
    responses: {
      all: [mergedTicketPr],
      head: { [EPIC]: [currentEpicPr] },
      comparisons: { [`main...${EPIC}`]: 1 },
    },
  });

  const result = run(f, ['--full']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'list' && args.includes('--head')
    && args[args.indexOf('--head') + 1] === EPIC));
  assert.deepEqual(state(f)[TICKET].epic_pr, {
    number: 400, branch: EPIC, state: 'OPEN', base: 'main', landed: false,
  });
});

test('re-derives a ticket while its epic PR is still open', () => {
  const epicPr = pr(399, 'OPEN', EPIC, 'main');
  const mergedTicketPr = pr(305, 'MERGED');
  const f = fixture({
    ledger: 305,
    previousState: { [TICKET]: priorMergedRow(305, 'OPEN', false) },
    responses: {
      open: [epicPr],
      review: [epicPr],
      view: { 305: mergedTicketPr },
      comparisons: { [`main...${EPIC}`]: 1 },
    },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '305'));
  assert.match(result.stdout, /looked_up=1.*skipped_landed=0/);
  assert.equal(state(f)[TICKET].status, 'merged');
  assert.equal(state(f)[TICKET].merge_sha, MERGE_SHA);
});

test('an open follow-up PR takes precedence over an older landed ticket row', () => {
  const followUp = pr(307, 'OPEN');
  const f = fixture({
    ledger: 306,
    previousState: { [TICKET]: priorMergedRow(306) },
    responses: { open: [followUp], review: [followUp] },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state(f)[TICKET].pr, 307);
  assert.equal(state(f)[TICKET].status, 'pr-open');
  assert.match(result.stdout, /looked_up=0.*skipped_landed=0/);
});

test('malformed successful open-list JSON cannot authorize a landed skip', () => {
  const previous = priorMergedRow(301);
  const followUp = pr(310, 'OPEN');
  const f = fixture({
    ledger: 301,
    previousState: { [TICKET]: previous },
    responses: {
      openRaw: '{not-json',
      view: { 301: pr(301, 'MERGED') },
      head: { [BRANCH]: [followUp] },
    },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '301'));
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'list' && args.includes('--head')
    && args[args.indexOf('--head') + 1] === BRANCH));
  assert.equal(state(f)[TICKET].pr, 310);
  assert.equal(state(f)[TICKET].status, 'pr-open');
  assert.match(result.stdout, /looked_up=2.*skipped_landed=0/);

  const unreadableHead = fixture({
    ledger: 301,
    previousState: { [TICKET]: previous },
    responses: {
      openRaw: '{not-json',
      view: { 301: pr(301, 'MERGED') },
      headRaw: { [BRANCH]: '{not-json' },
    },
  });
  const unknown = run(unreadableHead);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(state(unreadableHead)[TICKET].status, 'branched');
  assert.equal(state(unreadableHead)[TICKET].pr, null);
  assert.equal(state(unreadableHead)[TICKET].merge_sha, undefined);
  assert.equal(state(unreadableHead)[TICKET].reapable, false);
  assert.match(unknown.stdout, /skipped_landed=0/);
});

test('a truncated open listing resolves the ticket head before skipping a landed row', () => {
  const crowdedListing = Array.from({ length: 10 }, (_, index) => ({
    ...pr(500 + index, 'OPEN', `feature/other-${index}`, 'main'),
    title: `unrelated change ${index}`,
  }));
  const followUp = pr(311, 'OPEN');
  const f = fixture({
    limit: 10,
    ledger: 301,
    previousState: { [TICKET]: priorMergedRow(301) },
    responses: {
      open: crowdedListing,
      review: crowdedListing,
      head: { [BRANCH]: [followUp] },
      view: { 301: pr(301, 'MERGED') },
    },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(f).some((args) => args[0] === 'pr' && args[1] === 'list' && args.includes('--head')
    && args[args.indexOf('--head') + 1] === BRANCH));
  assert.equal(state(f)[TICKET].pr, 311);
  assert.equal(state(f)[TICKET].status, 'pr-open');
  assert.match(result.stdout, /skipped_landed=0/);
});

test('refreshes reap safety on a skipped landed ticket when an open PR targets its branch', () => {
  const dependent = { ...pr(312, 'OPEN', 'ticket/T-43-02-child', BRANCH), title: 'child change' };
  const f = fixture({
    ledger: 301,
    previousState: { [TICKET]: priorMergedRow(301) },
    responses: { open: [dependent], review: [dependent] },
  });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(f).filter(isTicketLookup).length, 0);
  assert.equal(state(f)[TICKET].reapable, false);
  assert.deepEqual(state(f)[TICKET].reap_blocked_by, { open_from_branch: [], open_onto_branch: [312] });
  assert.match(result.stdout, /skipped_landed=1/);
});

done();
