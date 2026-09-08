'use strict';

// reviewers.cjs is the ONE place the guard, the board and every fixer read the
// review state through, so a wrong answer here is not a wrong answer in one
// place. Three of its answers were wrong, and each cost a different thing:
//
//   * `unresolved` handed gh the literal `{owner}/{repo}` placeholder inside a
//     `--repo` flag. gh expands placeholders in `gh api` paths and NOT in
//     `--repo`, where it is a slug — so the call errored, the review decision
//     came back `null`, and `clean` read `false` over ZERO unresolved threads.
//     Measured on 2026-09-07: `reviewers.cjs unresolved 27` said `clean: false`
//     while the same call with an explicit `--repo` said `clean: true`. A false
//     "review not settled" keeps a green PR out of `merge` forever.
//   * `feedback` reported a bot's comments over the PR's whole life, so a fixer
//     on round 4 read rounds 1–3's already-addressed findings as live work.
//   * `changes_requested` was `some(state === 'CHANGES_REQUESTED')` over EVERY
//     historical review, so a reviewer who later APPROVED still read as
//     blocking. GitHub's own `reviewDecision` reduces to the last state per
//     author; the bot verdicts this script aggregates must be reduced the same
//     way or the two disagree about the same PR.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const REVIEWERS = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'reviewers.cjs'
);
const dirs = [];

const HEAD_AT = '2026-09-07T12:00:00Z';
const BEFORE = '2026-09-07T09:00:00Z';
const AFTER = '2026-09-07T13:00:00Z';
const HEAD_OID = '5555555555555555555555555555555555555555';

// A `gh` that answers exactly the calls reviewers.cjs makes — and that REFUSES a
// `--repo {owner}/{repo}` the way the real one does. Without that refusal the
// placeholder bug is invisible to a test: the stub would happily answer a call
// gh rejects, and the assertion would pass on the broken code.
function stubGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-reviewers-gh-'));
  dirs.push(dir);
  const script = [
    '#!/bin/sh',
    'argv="$*"',
    'if [ -n "${STUB_LOG:-}" ]; then printf \'%s\\n\' "$argv" >> "$STUB_LOG"; fi',
    // gh does not expand {owner}/{repo} in --repo: it wants an OWNER/REPO slug
    // there and errors on anything else. This is the real 2026-09-07 failure.
    'case "$argv" in',
    '  *"--repo {owner}/{repo}"*)',
    '    echo \'gh: expected the "[HOST/]OWNER/REPO" format, got "{owner}/{repo}"\' >&2; exit 1 ;;',
    'esac',
    'case "$argv" in',
    '  "repo view --json owner,name"*) echo \'{"owner":{"login":"acme"},"name":"demo"}\' ;;',
    '  "api graphql"*)',
    '    echo "${STUB_THREADS:-{\\"data\\":{\\"repository\\":{\\"pullRequest\\":{\\"reviewThreads\\":{\\"nodes\\":[],\\"pageInfo\\":{\\"hasNextPage\\":false,\\"endCursor\\":null}}}}}}}" ;;',
    '  "pr view "*)  echo "$STUB_PR_VIEW" ;;',
    '  "api repos/"*"/issues/"*"/comments"*) echo "${STUB_COMMENTS:-[]}" ;;',
    '  "api repos/"*"/pulls/"*"/reviews"*) echo "${STUB_REVIEWS:-[]}" ;;',
    '  "api repos/"*"/commits/"*) echo "${STUB_COMMIT_DATE:-}" ;;',
    '  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return dir;
}

const prView = (over = {}) => JSON.stringify({
  number: 27,
  reviewDecision: null,
  mergeStateStatus: 'CLEAN',
  baseRefName: 'epic/24-x',
  headRefName: 'ticket/T-24-06',
  headRefOid: HEAD_OID,
  commits: [
    { oid: '1111111111111111111111111111111111111111', committedDate: BEFORE },
    { oid: HEAD_OID, committedDate: HEAD_AT },
  ],
  ...over,
});

const comment = (login, at, body) => ({
  user: { login }, created_at: at, html_url: `https://example/c/${at}`, body,
});
const review = (login, state, at) => ({
  user: { login }, state, submitted_at: at, html_url: `https://example/r/${at}`, body: '',
});

function logFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shipyard-reviewers-log-${tag}-`));
  dirs.push(dir);
  return path.join(dir, 'argv.log');
}
const callsIn = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

function run(args, env = {}) {
  const dir = stubGh();
  const r = spawnSync(process.execPath, [REVIEWERS, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      STUB_PR_VIEW: prView(),
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const json = (r) => {
  try { return JSON.parse(r.stdout); } catch (e) {
    throw new Error(`not JSON (${e.message}); stdout=${r.stdout.slice(0, 400)} stderr=${r.stderr.slice(0, 400)}`);
  }
};

suite('reviewers unresolved — a repo nobody named is not the literal placeholder');

test('with no --repo, gh is never handed {owner}/{repo}, and zero threads read as clean', () => {
  const log = logFile('placeholder');
  const r = run(['unresolved', '27'], { STUB_LOG: log });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = json(r);
  assert.strictEqual(out.unresolved_count, 0);
  // The whole harm in one assertion: a green PR with no threads read as unsettled.
  assert.strictEqual(out.clean, true, `clean must be true at zero threads: ${JSON.stringify(out)}`);
  const bad = callsIn(log).filter((c) => /--repo \{owner\}\/\{repo\}/.test(c));
  assert.deepStrictEqual(bad, [], `gh does not expand placeholders in --repo: ${bad.join(' | ')}`);
});

test('an explicit --repo is still pinned onto every call that takes one', () => {
  const log = logFile('explicit');
  const out = json(run(['unresolved', '27', '--repo', 'acme/other'], { STUB_LOG: log }));
  assert.strictEqual(out.clean, true);
  const view = callsIn(log).find((c) => c.startsWith('pr view '));
  assert.ok(view && /--repo acme\/other/.test(view), `${view}`);
});

test('the guard reads the merge state off the same call, so it costs no extra query', () => {
  // `duty` has to know whether the base moved under the branch, and the review
  // decision is already fetched with one `gh pr view`. Adding the field there is
  // free; a second call per PR per round is not (state-sync's wall time is the
  // conveyor's tick rate).
  const log = logFile('mergestate');
  const out = json(run(['unresolved', '27'], { STUB_PR_VIEW: prView({ mergeStateStatus: 'BEHIND' }), STUB_LOG: log }));
  assert.strictEqual(out.merge_state, 'BEHIND');
  assert.strictEqual(out.base, 'epic/24-x');
  assert.strictEqual(out.head, 'ticket/T-24-06');
  assert.strictEqual(callsIn(log).filter((c) => c.startsWith('pr view ')).length, 1,
    'one PR view, not two');
});

test('a decision gh could not answer stays unknown, and unknown is not clean', () => {
  const out = json(run(['unresolved', '27'], { STUB_PR_VIEW: 'not json at all' }));
  assert.strictEqual(out.review_decision, null);
  assert.strictEqual(out.clean, false, 'unknown must never read as a clean bill of health');
});

suite('reviewers feedback — the review state SINCE the last push');

const twoRounds = {
  STUB_COMMENTS: JSON.stringify([
    comment('coderabbitai[bot]', BEFORE, 'round 1: rename this'),
    comment('coderabbitai[bot]', AFTER, 'round 4: this null check is unreachable'),
  ]),
};

test('a bot comment older than the head commit is not live feedback', () => {
  const out = json(run(['feedback', '27'], twoRounds));
  assert.strictEqual(out.since_head, new Date(HEAD_AT).toISOString(), JSON.stringify(out.since_head));
  assert.deepStrictEqual(out.bot_comments.map((c) => c.created_at), [AFTER],
    `only the comment filed after the head commit is live: ${JSON.stringify(out.bot_comments)}`);
  assert.strictEqual(out.bot_comment_count, 1);
  // Dropping evidence silently is its own defect: say how much was left out.
  assert.strictEqual(out.bot_comments_before_head, 1);
});

test('--no-since-head restores the whole history for a human who asks for it', () => {
  const out = json(run(['feedback', '27', '--no-since-head'], twoRounds));
  assert.deepStrictEqual(out.bot_comments.map((c) => c.created_at), [BEFORE, AFTER]);
  assert.strictEqual(out.since_head, null, 'and says the filter was not applied');
});

test('when the head date cannot be read, nothing is hidden', () => {
  // Fail OPEN here, deliberately: the cost of showing an addressed comment is a
  // wasted paragraph, the cost of hiding a live one is an unaddressed finding.
  const out = json(run(['feedback', '27'], { ...twoRounds, STUB_PR_VIEW: 'not json at all' }));
  assert.strictEqual(out.since_head, null);
  assert.deepStrictEqual(out.bot_comments.map((c) => c.created_at), [BEFORE, AFTER]);
});

suite('reviewers — a verdict is the reviewer\'s LAST word, not their first');

const verdicts = (rows) => ({ STUB_REVIEWS: JSON.stringify(rows) });

test('CHANGES_REQUESTED that the same bot later APPROVED is not blocking', () => {
  const out = json(run(['feedback', '27'], verdicts([
    review('coderabbitai[bot]', 'CHANGES_REQUESTED', BEFORE),
    review('coderabbitai[bot]', 'APPROVED', AFTER),
  ])));
  assert.strictEqual(out.changes_requested, false, JSON.stringify(out.current_reviews));
  assert.deepStrictEqual(out.current_reviews.map((v) => [v.author, v.state]), [['coderabbitai[bot]', 'APPROVED']]);
  // The raw history is still reported — the reduction is a verdict, not a purge.
  assert.strictEqual(out.reviews.length, 2);
});

test('a later COMMENTED review does not lift a CHANGES_REQUESTED', () => {
  // GitHub's own rule: only a newer APPROVED or DISMISSED supersedes it. A
  // reduction that took the plain last row would call this PR settled.
  const out = json(run(['feedback', '27'], verdicts([
    review('coderabbitai[bot]', 'CHANGES_REQUESTED', BEFORE),
    review('coderabbitai[bot]', 'COMMENTED', AFTER),
  ])));
  assert.strictEqual(out.changes_requested, true, JSON.stringify(out.current_reviews));
});

test('one reviewer approving does not speak for another still requesting changes', () => {
  const out = json(run(['feedback', '27'], verdicts([
    review('coderabbitai[bot]', 'APPROVED', AFTER),
    review('copilot-pull-request-reviewer[bot]', 'CHANGES_REQUESTED', BEFORE),
  ])));
  assert.strictEqual(out.changes_requested, true);
});

test('status prints the raw history AND the reduced verdicts, so the difference is visible', () => {
  const rows = [
    review('coderabbitai[bot]', 'CHANGES_REQUESTED', BEFORE),
    review('coderabbitai[bot]', 'APPROVED', AFTER),
  ];
  const out = json(run(['status', '27', '--json'], verdicts(rows)));
  assert.deepStrictEqual(out.reviews_raw.map((v) => v.state), ['CHANGES_REQUESTED', 'APPROVED']);
  assert.deepStrictEqual(out.current_reviews.map((v) => v.state), ['APPROVED']);
  assert.strictEqual(out.changes_requested, false);
  const lines = run(['status', '27'], verdicts(rows)).stdout;
  assert.ok(/CHANGES_REQUESTED/.test(lines), lines);
  assert.ok(/APPROVED/.test(lines), lines);
});

for (const d of dirs) {
  try { execFileSync('rm', ['-rf', d]); } catch { /* best effort */ }
}

done();
