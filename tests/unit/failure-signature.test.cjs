'use strict';

// The repair policy used to read an attempt COUNT: "attempt >= 2 -> opus". That
// is "try harder", and the dominant loss in phase 19 was the same wrong
// hypothesis re-tried by three models in sequence (T-19-05: four attempts, three
// escalations, one deterministically failing job). ADR-001 D1 replaces the count
// with a normalized SIGNATURE and reads its HISTORY; D3 adds the case a count can
// never see — the same job failing on an unchanged tree, which is instability,
// not a defect, and must not be charged as an attempt.
//
// Both halves are mechanical or they are nothing, so they are pinned here:
//   * normalization — two logs of one failure differ by timestamps, ANSI codes,
//     durations, line numbers and the absolute prefix of the checkout. If any of
//     those reach the hash, every re-run looks like "progress" and the policy
//     never notices it is repeating itself.
//   * the verdict — six words, one rule order. The ordering IS the design:
//     quarantine beats candidate beats the k-rule, and a red re-run flips a
//     candidate back to deterministic so the loop cannot orbit `flake_candidate`.
//   * where the journal lands — these commands run from ticket WORKTREES, which
//     have no `.planning/` at all. drift-record's repro is the precedent: a
//     record written beside no ticket graph is not misplaced, it is unreadable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'failure-signature.cjs'
);

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });

// A project (has a ticket graph) and a worktree beside it (has none) — the exact
// two cwds this script is called from: the babysit loop stands in the project,
// the fixer that computes a signature stands in the worktree.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-flake-'));
  const project = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  const graph = path.join(project, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(graph, 'tickets.json'),
    JSON.stringify({ tickets: { 'T-20-01': { phase: '20' } } })
  );
  return { project, worktree, graph };
}

const attempt = (sig, head, extra = {}) => ({
  ts: '2026-08-21T10:00:00.000Z',
  event: 'attempt',
  ticket: 'T-20-01',
  pr: 512,
  n: 1,
  role: 'ci-fix',
  model: 'sonnet',
  outcome: 'pushed',
  ...(sig === null ? {} : { signature: sig, head }),
  ...extra,
});

// A green is what ENDS a run of failures. ADR-002 D8 says "a green or a merge"
// and names no event, so the journal shapes that prove one belong to
// failure-signature.cjs itself: an `attempt` that came back green, a `merge`, and
// a `flake` — the record a re-run that PASSED leaves behind — for as long as no
// `flake_lift` withdraws it. Any of them RESETS the distinct window: three
// failures each of which was fixed are not "K distinct signatures with no green
// between them", which is the sentence that file's own header has always claimed
// and the code did not implement.
const greenAttempt = (extra = {}) => ({
  ts: '2026-08-21T10:00:00.000Z',
  event: 'attempt',
  ticket: 'T-20-01',
  pr: 512,
  role: 'ci-fix',
  model: 'sonnet',
  outcome: 'green',
  ...extra,
});

const merged = (extra = {}) => ({
  ts: '2026-08-21T10:00:00.000Z',
  event: 'merge',
  ticket: 'T-20-01',
  pr: 512,
  ...extra,
});

const seed = (graph, events) =>
  fs.writeFileSync(
    path.join(graph, 'delivery-log.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );

// The sequence tests below are driven ROW BY ROW rather than from a hand-written
// store, because the defect ADR-007 D2 names is a SEQUENCE property: `A → B → A`
// read `progress` while every single-row fixture of it looked correct. Appending
// one round at a time is also the real order of operations — sign the failure,
// ask for the verdict, dispatch, push, and only THEN journal the round — so a
// test that seeds the row it is asking about is asking a question the conveyor
// never asks.
const appendEvent = (graph, e) =>
  fs.appendFileSync(path.join(graph, 'delivery-log.jsonl'), JSON.stringify(e) + '\n');

// Forty-character heads, as ADR-007 D2's own reproduction used. `verdict` does
// not validate the length, but "the tree moved" is only meaningful between shas
// of the shape the journal actually carries.
const HEAD = (n) => String(n).repeat(40).slice(0, 40);

// One round of the loop: ask for the verdict BEFORE the round it is about exists
// in the journal (deliver.md a2 runs before step d), then record the round that
// verdict caused. `extra` is what THAT round's own row carries — `effort_applied`
// above all, which is the difference between a rethink that was dispatched at the
// deeper effort and one that only ever got as far as being decided on.
const round = (project, graph, sig, head, extra = {}) => {
  const got = verdict(project, ['--signature', sig, '--head', head, '--k', '3']);
  appendEvent(graph, attempt(sig, head, extra));
  return got;
};

const journalLines = (graph) => {
  const p = path.join(graph, 'delivery-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const verdict = (cwd, args) => {
  const r = run(['verdict', 'T-20-01', ...args, '--json'], { cwd });
  assert.equal(r.status, 0, `verdict must succeed (${r.stderr})`);
  return JSON.parse(r.stdout);
};

// One failure, as CI prints it: ANSI colour, an ISO timestamp, a duration, an
// absolute checkout prefix and a line:column suffix. The escape is built rather
// than typed so the fixture survives every editor and diff viewer between here
// and the runner.
const ESC = String.fromCharCode(27);
const c = (code, s) => `${ESC}[${code}m${s}${ESC}[39m`;
const JEST_NOISY = [
  `${ESC}[2m2026-08-15T03:12:44.019Z${ESC}[22m ${c(31, 'FAIL')} src/api/user.test.ts (12.34 s)`,
  `  ${c(31, '●')} UserService › rejects an expired token`,
  '',
  `    ${c(31, 'TypeError')}: Cannot read properties of undefined (reading 'exp')`,
  '',
  '      at Object.<anonymous> (/home/runner/work/app/app/src/api/user.test.ts:42:17)',
  '      at processTicksAndRejections (node:internal/process/task_queues:95:5)',
].join('\n');

// The same failure, the next night: no colour, a different day, a faster run, a
// developer's checkout instead of the runner's, and the file has grown 15 lines.
const JEST_CLEAN = [
  '2026-08-16T11:02:03.771Z FAIL src/api/user.test.ts (0.42 s)',
  '  ● UserService › rejects an expired token',
  '',
  "    TypeError: Cannot read properties of undefined (reading 'exp')",
  '',
  '      at Object.<anonymous> (/Users/dev/app/src/api/user.test.ts:57:9)',
  '      at processTicksAndRejections (node:internal/process/task_queues:95:5)',
].join('\n');

const compute = (log, args = [], opts = {}) => {
  const r = run(['compute', '--json', ...args], { input: log, encoding: 'utf8', ...opts });
  assert.equal(r.status, 0, `compute must never exit non-zero (${r.stderr})`);
  return JSON.parse(r.stdout);
};

suite('failure signature — normalization: one failure hashes to one signature');

test('ANSI codes, timestamps, durations, line numbers and the checkout prefix do not reach the hash', () => {
  const a = compute(JEST_NOISY);
  const b = compute(JEST_CLEAN);
  assert.equal(a.signature, b.signature,
    `the same failure must hash the same: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert.equal(a.error_class, 'TypeError', 'the named class wins over the FAIL marker');
  assert.equal(a.test_id, 'UserService › rejects an expired token');
  assert.equal(a.file, 'src/api/user.test.ts', 'the absolute prefix is normalized away');
  assert.ok(/^[0-9a-f]{16}$/.test(a.signature), 'the signature is 16 hex chars');
});

test('a different failing test in the same file is a DIFFERENT signature', () => {
  // If it were not, "progress" and "repetition" would be indistinguishable and
  // the whole policy reads noise.
  const other = JEST_CLEAN.replace('rejects an expired token', 'accepts a fresh token');
  assert.notEqual(compute(JEST_CLEAN).signature, compute(other).signature);
});

test('a different error class in the same test is a different signature', () => {
  const other = JEST_CLEAN.replace('TypeError', 'RangeError');
  assert.notEqual(compute(JEST_CLEAN).signature, compute(other).signature);
});

test('the bare form prints the signature and nothing else', () => {
  const r = run(['compute'], { input: JEST_CLEAN, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), compute(JEST_CLEAN).signature);
});

test('a go test failure yields its own class, test and file', () => {
  const log = [
    '=== RUN   TestUserExpiry',
    '--- FAIL: TestUserExpiry (0.00s)',
    '    user_test.go:42: expected 401, got 500',
    'FAIL\texample.com/app/internal/user\t0.014s',
  ].join('\n');
  const got = compute(log);
  assert.equal(got.error_class, 'go-test-fail');
  assert.equal(got.test_id, 'TestUserExpiry');
  assert.equal(got.file, 'user_test.go');
});

test('a TAP failure yields the not-ok class and the test name', () => {
  const got = compute('ok 1 - parses\nnot ok 2 - refuses a stale base\n  ---\n  file: tests/unit/x.test.cjs');
  assert.equal(got.error_class, 'tap-not-ok');
  assert.equal(got.test_id, 'refuses a stale base');
});

test('a bare node assertion falls back to the job name for the test id', () => {
  const log = [
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
    '    at Object.<anonymous> (/build/ws/tests/unit/front.test.cjs:12:3)',
  ].join('\n');
  const got = compute(log, ['--job', 'unit (ubuntu-latest)']);
  assert.equal(got.error_class, 'AssertionError');
  assert.equal(got.test_id, 'unit (ubuntu-latest)', 'the job is the identifier when the log has none');
  assert.equal(got.file, 'tests/unit/front.test.cjs');
});

test('an exit-code line is a class when nothing better is present', () => {
  const got = compute('Running build...\nProcess completed with exit code 2.', ['--job', 'build']);
  assert.equal(got.error_class, 'exit-2');
  assert.equal(got.test_id, 'build');
});

test('garbage input degrades to `unknown` and still exits 0', () => {
  // A degraded signature is better than an aborted babysit round — the same
  // ethos as state-sync treating `gh pr checks` exit codes as data.
  const got = compute('  nothing useful here, just prose', ['--job', 'ci']);
  assert.equal(got.error_class, 'unknown');
  assert.equal(got.test_id, 'ci');
  assert.ok(/^unknown-[0-9a-f]{16}$/.test(got.signature), 'still a usable signature');
});

test('a degraded signature SAYS it is degraded, and stays job-specific', () => {
  // The k-rule has to exclude these, and it reads nothing but the signature
  // string out of the journal — no error_class is recorded there. So the shape
  // carries the fact. The hash stays, because "unknown in the unit job" and
  // "unknown in the build job" are still two different things to re-run.
  const readable = compute(JEST_CLEAN);
  assert.ok(/^[0-9a-f]{16}$/.test(readable.signature),
    'a readable failure is unchanged — every signature already in a journal still matches');
  const a = compute('just prose', ['--job', 'unit']);
  const b = compute('just prose', ['--job', 'build']);
  assert.ok(a.signature.startsWith('unknown-') && b.signature.startsWith('unknown-'));
  assert.notEqual(a.signature, b.signature);
});

test('an empty log is not an error either', () => {
  const got = compute('');
  assert.equal(got.error_class, 'unknown');
  assert.ok(/^unknown-[0-9a-f]{16}$/.test(got.signature));
});

test('an unreadable --log file is degraded data, never a stopped round', () => {
  const r = run(['compute', '--log', '/no/such/failure.log', '--job', 'ci', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'exit 0 — a missing temp file at 3am must not stop the loop');
  assert.equal(JSON.parse(r.stdout).error_class, 'unknown');
  assert.ok(/failure\.log/.test(r.stderr), 'but it says so on stderr');
});

test('--log and stdin agree', () => {
  const { worktree } = scratch();
  const f = path.join(worktree, 'fail.log');
  fs.writeFileSync(f, JEST_NOISY);
  assert.equal(compute('', ['--log', f]).signature, compute(JEST_CLEAN).signature);
});

test('compute needs no ticket graph — it is called from a worktree', () => {
  // compute touches no journal, so the refusal that protects the record must not
  // reach it: the fixer computing a signature stands in a checkout with no
  // .planning/ at all.
  const { worktree } = scratch();
  const r = run(['compute'], { cwd: worktree, input: JEST_CLEAN, encoding: 'utf8' });
  assert.equal(r.status, 0, `compute must work anywhere (${r.stderr})`);
  assert.ok(/^[0-9a-f]{16}$/.test(r.stdout.trim()));
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'and writes nothing');
});

suite('failure signature — the verdict enum, in rule order');

test('a fresh ticket is `first`, with no journal at all', () => {
  const { project } = scratch();
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'first');
});

test('a new signature after a push is `progress`', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'bbbb', '--head', 'h2']).verdict, 'progress');
});

test('the same signature after a push is `repeat`', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'repeat');
});

test('the same signature a THIRD time is `repeat_exhausted` — the second is still `repeat`', () => {
  // The rung ADR-005 D4 R2 rests on. `seen` counts PRIOR attempts and the verdict
  // is computed before the round it is about is journalled, so the third
  // occurrence of one signature arrives with seen = 2:
  //   1st → first (fix) · 2nd → repeat (rethink, at `max`) · 3rd → the deepest
  //   thinking has already failed on this exact failure, so the next rung is the
  //   ceiling MODEL and after that a human — never a third model at one depth.
  // Every head differs on purpose: the same signature at the SAME head is the
  // flake rule, which outranks this one (asserted below).
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'repeat',
    'the second occurrence is a rethink, not an exhaustion');
  // ADR-007 D2: the third occurrence exhausts only with PROOF that the deeper
  // effort was actually spent, not merely decided. The `h2` round is the one the
  // `repeat` verdict above dispatched, so it is the row that records the depth it
  // carried — the assertion below without it is the very next test.
  seed(graph, [attempt('aaaa', 'h1'), attempt('aaaa', 'h2', { effort_applied: 'max' })]);
  const third = verdict(project, ['--signature', 'aaaa', '--head', 'h3']);
  assert.equal(third.verdict, 'repeat_exhausted');
  assert.equal(third.seen, 2, 'two priors + the failure in hand = the same failure a third time');
  assert.equal(third.depth_spent, true, 'and the record says the rethink was applied');
});

test('a green resets it: the count is the WINDOW, not the whole journal', () => {
  // Same rule as the k-distinct window, over a different subject. A failure that
  // was fixed, went green, and came back twice is on its second occurrence, not
  // its fourth — otherwise the ceiling route fires on a healthy ticket.
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), attempt('aaaa', 'h2'), greenAttempt(), attempt('aaaa', 'h3')]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h4']).verdict, 'repeat');
});

test('the flake rules still outrank it — an unchanged tree is not an exhausted repair', () => {
  const { project, graph } = scratch();
  // Same signature three times, and the last one at the head being asked about:
  // the tree did not move, so this is the candidate rule's business.
  seed(graph, [attempt('aaaa', 'h1'), attempt('aaaa', 'h2')]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'flake_candidate');
});

test('k distinct signatures with no progress is `plan_defect`', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), attempt('bbbb', 'h2')]);
  const got = verdict(project, ['--signature', 'cccc', '--head', 'h3']);
  assert.equal(got.verdict, 'plan_defect');
  assert.equal(got.distinct, 3, 'the current signature counts toward k');
  assert.equal(got.k, 3, 'k defaults to 3 — the same default as pipeline.plan_defect_signatures');
});

test('--k moves the threshold', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'bbbb', '--head', 'h2', '--k', '2']).verdict, 'plan_defect');
  assert.equal(verdict(project, ['--signature', 'bbbb', '--head', 'h2', '--k', '4']).verdict, 'progress');
});

test('a green between the failures RESETS the distinct window', () => {
  // The defect this closes: three sequential failures, each of them FIXED and
  // each followed by a green, parked a healthy ticket as a plan defect on the
  // third. `priorSignatures` was every signature the ticket had ever journalled,
  // so "K distinct" counted work that had already succeeded.
  const { project, graph } = scratch();
  seed(graph, [
    attempt('aaaa', 'h1'), greenAttempt(),
    attempt('bbbb', 'h2'), greenAttempt(),
  ]);
  const got = verdict(project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']);
  assert.notEqual(got.verdict, 'plan_defect',
    'two fixed failures are not evidence that the plan is wrong');
  assert.equal(got.verdict, 'first', 'the window since the last green is empty');
  assert.equal(got.distinct, 1, 'only the current failure is in the window');
});

test('a `merge` resets it too, and so does a green re-run', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), merged(), attempt('bbbb', 'h2')]);
  assert.equal(verdict(project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']).distinct, 2,
    'the window starts after the merge: bbbb + cccc');

  // Seeded through the WRITER, not by hand: "the re-run passed" lands on disk as
  // a `flake` event, and the first cut of this test asserted the reset against a
  // synthetic `{event: 'flake_rerun', outcome: 'green'}` — a record no permitted
  // path produces, so it proved a reader branch nothing could ever reach.
  const other = scratch();
  seed(other.graph, [attempt('aaaa', 'h1')]);
  const r = run(
    ['rerun', 'T-20-01', '--signature', 'zzzz', '--head', 'h1', '--outcome', 'green', '--job', 'unit'],
    { cwd: other.project }
  );
  assert.equal(r.status, 0, `rerun must succeed (${r.stderr})`);
  assert.equal(journalLines(other.graph)[1].event, 'flake',
    'the shape under test is the one the writer appends');
  fs.appendFileSync(
    path.join(other.graph, 'delivery-log.jsonl'), JSON.stringify(attempt('bbbb', 'h2')) + '\n'
  );
  assert.equal(verdict(other.project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']).distinct, 2,
    'a re-run that passed is a green as much as a merge is');
});

test('a green BEFORE the run of failures does not excuse them', () => {
  // The window is "since the last green", not "the whole journal minus greens":
  // three distinct failures after one still park the ticket.
  const { project, graph } = scratch();
  seed(graph, [greenAttempt(), attempt('aaaa', 'h1'), attempt('bbbb', 'h2')]);
  const got = verdict(project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']);
  assert.equal(got.verdict, 'plan_defect');
  assert.equal(got.distinct, 3);
});

test('another ticket\'s green does not reset THIS ticket\'s window', () => {
  const { project, graph } = scratch();
  seed(graph, [
    attempt('aaaa', 'h1'),
    { ...merged(), ticket: 'T-20-02' },
    attempt('bbbb', 'h2'),
  ]);
  assert.equal(verdict(project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']).verdict, 'plan_defect');
});

test('`unknown` never counts towards K — two unreadable logs are not two failures', () => {
  // A degraded signature says "nobody could read this log", not "a second,
  // different failure". Counted as distinct it spent a ticket's plan-defect
  // budget on the CI's own illegibility.
  const { project, graph } = scratch();
  seed(graph, [attempt('unknown', 'h1'), attempt('unknown', 'h2')]);
  const got = verdict(project, ['--signature', 'aaaa', '--head', 'h3', '--k', '3']);
  assert.equal(got.distinct, 1, 'only the one readable failure is distinct');
  assert.notEqual(got.verdict, 'plan_defect');
});

test('the real degraded form — `unknown-<hash>` — is excluded the same way', () => {
  // compute() keeps the job discrimination inside an unknown signature, so the
  // exclusion has to match the shape it actually emits, not just the bare word.
  const { project, graph } = scratch();
  const u1 = compute('nothing useful here at all', ['--job', 'unit']).signature;
  const u2 = compute('nothing useful here at all', ['--job', 'build']).signature;
  assert.notEqual(u1, u2, 'two unreadable logs from different checks stay distinguishable');
  seed(graph, [attempt(u1, 'h1'), attempt(u2, 'h2')]);
  const got = verdict(project, ['--signature', 'aaaa', '--head', 'h3', '--k', '3']);
  assert.equal(got.distinct, 1);
  assert.notEqual(got.verdict, 'plan_defect');
});

test('an unreadable failure still walks the repeat ladder when it keeps happening', () => {
  // Excluded from the k-rule, NOT from the rest: the current signature still
  // participates in first/repeat/repeat_exhausted/flake_candidate, or an
  // illegible log would be invisible to the strategy switch as well.
  const { project, graph } = scratch();
  seed(graph, [attempt('unknown', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'unknown', '--head', 'h2', '--k', '3']).verdict, 'repeat');
  seed(graph, [attempt('unknown', 'h1'), attempt('unknown', 'h2', { effort_applied: 'max' })]);
  const got = verdict(project, ['--signature', 'unknown', '--head', 'h3', '--k', '3']);
  assert.equal(got.verdict, 'repeat_exhausted', 'the third one is exhausted, illegible or not');
  assert.equal(got.seen, 2, 'seen still counts THIS signature');
  assert.equal(got.distinct, 0, 'and nothing readable is on the board');
});

test('the same signature at the same HEAD across a green is still `flake_candidate`', () => {
  // Deliberate asymmetry, and it is the whole point of the candidate rule: the
  // tree did not move and CI went green in between, so this failure is
  // instability by definition. The green resets the k-rule's window; it must not
  // blind the head comparison, or a flake gets a fixer dispatched at it.
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), greenAttempt()]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'flake_candidate');
});

test('the same signature at the SAME head is `flake_candidate`', () => {
  // The tree did not change between the two failures, so the loop must re-run the
  // job once before dispatching a fixer at it.
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'flake_candidate');
});

test('rule order: a quarantine beats the candidate rule', () => {
  const { project, graph } = scratch();
  seed(graph, [
    attempt('aaaa', 'h1'),
    { ts: '2026-08-21T10:05:00.000Z', event: 'flake', ticket: 'T-20-01', signature: 'aaaa', head: 'h1', job: 'unit' },
  ]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'flake');
});

test('rule order: the candidate rule beats the k rule', () => {
  // Three distinct signatures are on the board, but the tree has not moved since
  // the last failure — re-run before concluding the plan is wrong.
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), attempt('bbbb', 'h2'), attempt('cccc', 'h3')]);
  assert.equal(verdict(project, ['--signature', 'cccc', '--head', 'h3']).verdict, 'flake_candidate');
});

test('a red re-run flips the candidate to `repeat` — no orbit on flake_candidate', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  const r = run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'red'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, `rerun must succeed (${r.stderr})`);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'repeat');
});

test('a green re-run quarantines the signature: the verdict is `flake`', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green', '--job', 'unit'], { cwd: project, encoding: 'utf8' });
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h1']).verdict, 'flake');
});

test('the quarantine survives a head change — a flaky test is flaky across pushes', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green'], { cwd: project, encoding: 'utf8' });
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h9']).verdict, 'flake');
});

test('the quarantine is scoped to (ticket, signature)', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green'], { cwd: project, encoding: 'utf8' });
  const got = verdict(project, ['--signature', 'bbbb', '--head', 'h1']);
  assert.notEqual(got.verdict, 'flake',
    'another signature on the same ticket is not quarantined');
  // And the re-run that passed is a green, so it emptied the window behind it:
  // `first`, not `progress`, is what "nothing on record since the green" reads as.
  assert.equal(got.verdict, 'first');
});

test('`lift` ends the quarantine', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green'], { cwd: project, encoding: 'utf8' });
  const l = run(['lift', 'T-20-01', '--signature', 'aaaa'], { cwd: project, encoding: 'utf8' });
  assert.equal(l.status, 0, `lift must succeed (${l.stderr})`);
  const got = verdict(project, ['--signature', 'aaaa', '--head', 'h2']);
  assert.equal(got.verdict, 'repeat',
    'the signature is deterministic again, not quarantined');
  assert.equal(got.seen, 1,
    'the lift withdrew the green as well, so the failure it excused is back in the window');
});

test('a quarantine recorded AFTER a lift holds again', () => {
  // The pair is read in journal order, so the last word wins — otherwise a single
  // lift would immunize a signature forever.
  const { project, graph } = scratch();
  seed(graph, [
    attempt('aaaa', 'h1'),
    { ts: '2026-08-21T10:05:00.000Z', event: 'flake_lift', ticket: 'T-20-01', signature: 'aaaa' },
    { ts: '2026-08-21T10:06:00.000Z', event: 'flake', ticket: 'T-20-01', signature: 'aaaa', head: 'h1' },
  ]);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'flake');
});

test('a lifted `flake` stops being a green — the window it emptied comes back', () => {
  // The green a `flake` records IS the re-run passing; `flake_lift` says the
  // signature counts as a real failure again, which withdraws the excuse and with
  // it the green. Ticket-wide, not just for the lifted signature: an unretracted
  // lift would leave the window empty for every other failure too, and three real
  // ones would read as `progress` while the board says the plan is wrong.
  const events = [
    attempt('aaaa', 'h1'),
    { ts: '2026-08-21T10:05:00.000Z', event: 'flake', ticket: 'T-20-01', signature: 'aaaa', head: 'h1', job: 'unit', by: 'failure-signature' },
    attempt('bbbb', 'h2'),
  ];

  const standing = scratch();
  seed(standing.graph, events);
  assert.equal(verdict(standing.project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']).distinct, 2,
    'while the quarantine stands the flake is a green: bbbb + cccc');

  const lifted = scratch();
  seed(lifted.graph, [
    ...events,
    { ts: '2026-08-21T10:07:00.000Z', event: 'flake_lift', ticket: 'T-20-01', signature: 'aaaa' },
  ]);
  const got = verdict(lifted.project, ['--signature', 'cccc', '--head', 'h3', '--k', '3']);
  assert.equal(got.distinct, 3, 'the lift put aaaa back on the board: aaaa + bbbb + cccc');
  assert.equal(got.verdict, 'plan_defect');
});

test('pre-phase attempt events with no signature are ignored, not fatal', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt(null), attempt(null), { event: 'fix_round', ticket: 'T-20-01', outcome: 'no-op' }]);
  const got = verdict(project, ['--signature', 'aaaa', '--head', 'h1']);
  assert.equal(got.verdict, 'first', 'no signature recorded reads as "first", never as an error');
  assert.equal(got.distinct, 1);
});

test("another ticket's history is not this ticket's", () => {
  const { project, graph } = scratch();
  seed(graph, [{ ...attempt('aaaa', 'h1'), ticket: 'T-20-02' }]);
  assert.equal(verdict(project, ['--signature', 'bbbb', '--head', 'h1']).verdict, 'first');
});

test('an unparseable journal line is skipped, not fatal', () => {
  const { project, graph } = scratch();
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'),
    'not json at all\n' + JSON.stringify(attempt('aaaa', 'h1')) + '\n');
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'repeat');
});

test('--json carries the numbers the policy reads', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1'), attempt('aaaa', 'h2'), attempt('bbbb', 'h3')]);
  const got = verdict(project, ['--signature', 'aaaa', '--head', 'h4']);
  assert.deepEqual(Object.keys(got).sort(),
    ['depth_spent', 'distinct', 'head', 'k', 'seen', 'signature', 'verdict']);
  assert.equal(got.signature, 'aaaa');
  assert.equal(got.head, 'h4');
  assert.equal(got.seen, 2, 'seen = how many prior attempts carried THIS signature');
  assert.equal(got.distinct, 2);
  assert.equal(got.depth_spent, false,
    'depth_spent = whether a rethink round on THIS signature recorded the depth it applied');
  assert.equal(got.verdict, 'repeat', 'two priors, and nothing on record spent the deeper effort');
});

test('the bare form prints the verdict word alone', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  const r = run(['verdict', 'T-20-01', '--signature', 'aaaa', '--head', 'h2'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'repeat');
});

test('the enum is exactly the seven pinned words', () => {
  // T-20-02 and T-20-06 switch on these literals; an eighth word, or a synonym,
  // is a silent no-op in the policy that reads them. `repeat_exhausted` sits
  // beside `repeat` because pipeline-config.cjs's STRATEGIES keys must be this
  // list VERBATIM, order included (its own test asserts the two are identical).
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = /const VERDICTS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'the enum is declared once, as VERDICTS');
  const words = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(words,
    ['first', 'progress', 'repeat', 'repeat_exhausted', 'flake_candidate', 'flake', 'plan_defect']);
});

suite('failure signature — a history is a SET with adjacency, not a count (ADR-007 D2)');

test('`A → B → A` at a moved head is `repeat` — whatever appeared between', () => {
  // ADR-007 D2's reproduction, driven the way the loop drives it. `seen` was
  // already a count of the signature's occurrences in the window; the test that
  // chose the verdict read only the LAST pair, so one intervening failure made a
  // signature the ticket had already attempted read as novel. `repeat` is the
  // only verdict whose strategy is `rethink` — the one step that means "a
  // different hypothesis at the same tier" — so skipping it means the ladder
  // never re-thinks at all: `progress` straight to the state that opens the
  // ceiling model and then hands the ticket to a person.
  const { project, graph } = scratch();
  assert.equal(round(project, graph, 'aaaa', HEAD(1)).verdict, 'first');
  assert.equal(round(project, graph, 'bbbb', HEAD(2)).verdict, 'progress');
  const third = round(project, graph, 'aaaa', HEAD(3));
  assert.equal(third.verdict, 'repeat',
    'the question the verdict answers is "has this exact failure already been attempted"');
  assert.equal(third.seen, 1, 'one prior attempt carried this signature');
  assert.equal(third.distinct, 2, 'and the k-rule still sees two distinct failures');
});

test('the k-rule still outranks recurrence — three distinct failures are a plan defect', () => {
  // Rule ORDER is the design, and recurrence must not pre-empt it: `plan_defect`
  // is decided before the repeat rungs, so a ticket whose third distinct failure
  // happens to be one it has seen before is still a plan defect and still goes to
  // a person in the morning rather than to another fixer now.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1));
  round(project, graph, 'bbbb', HEAD(2));
  round(project, graph, 'cccc', HEAD(3));
  const got = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
  assert.equal(got.verdict, 'plan_defect');
  assert.equal(got.seen, 1, 'it HAS recurred — the k-rule simply answers first');
});

test('`A → B → A → A` does not exhaust while no round records the depth it applied', () => {
  // `repeat_exhausted` claims the deeper effort has ALREADY been spent on this
  // exact failure, and it is the rung that opens the ceiling model and then hands
  // the ticket over. On the Agent path a spawn carries no effort at all, so that
  // claim is unprovable there — and absent proof reads as NOT-YET-SPENT, which
  // keeps the failure direction on "rethink once more" rather than "escalate
  // early". The count is not the evidence; the record is.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1));
  round(project, graph, 'bbbb', HEAD(2));
  assert.equal(round(project, graph, 'aaaa', HEAD(3)).verdict, 'repeat');
  const fourth = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
  assert.equal(fourth.verdict, 'repeat', 'two priors, and nothing says the rethink was ever applied');
  assert.equal(fourth.seen, 2, 'the count is unchanged — it is the EVIDENCE that is missing');
  assert.equal(fourth.depth_spent, false);
});

test('… and does exhaust once the rethink round records what it applied', () => {
  // The other half of the same rule: with the depth on record the claim is true,
  // so the rung is returned. `agent()` takes an effort, which is why the Workflow
  // path can say this and the Agent tool cannot.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1));
  round(project, graph, 'bbbb', HEAD(2));
  assert.equal(round(project, graph, 'aaaa', HEAD(3), { effort_applied: 'max' }).verdict, 'repeat');
  const fourth = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
  assert.equal(fourth.verdict, 'repeat_exhausted');
  assert.equal(fourth.depth_spent, true);
});

test('unmeasured effort states are not evidence of a spent rethink', () => {
  for (const state of ['unknown', 'unsupported']) {
    // The honest value for a spawn that could not carry or expose an effort. It
    // must read as absence and not as a depth, or the one field built to admit
    // "unmeasured" becomes the proof the escalation rests on.
    const { project, graph } = scratch();
    round(project, graph, 'aaaa', HEAD(1));
    round(project, graph, 'bbbb', HEAD(2));
    round(project, graph, 'aaaa', HEAD(3), { effort_applied: state });
    const got = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
    assert.equal(got.verdict, 'repeat', state);
    assert.equal(got.depth_spent, false, state);
  }
});

test("the FIRST round's own effort is not evidence of a rethink", () => {
  // The first occurrence of a signature is dispatched under `first`/`progress`,
  // whose strategy is `fix`. Its recorded depth proves that a round ran, never
  // that the deeper rung was spent — and reading it as evidence would exhaust a
  // signature the conveyor had thought about exactly once.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1), { effort_applied: 'high' });
  round(project, graph, 'bbbb', HEAD(2));
  round(project, graph, 'aaaa', HEAD(3));
  const got = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
  assert.equal(got.verdict, 'repeat');
  assert.equal(got.depth_spent, false);
});

test('a green resets the evidence along with the window', () => {
  // `depth_spent` is measured over the WINDOW, exactly like `seen` and
  // `distinct`: a rethink spent on a failure that was then FIXED says nothing
  // about the failure that came back after the green.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1));
  round(project, graph, 'aaaa', HEAD(2), { effort_applied: 'max' });
  appendEvent(graph, greenAttempt());
  round(project, graph, 'aaaa', HEAD(3));
  const got = verdict(project, ['--signature', 'aaaa', '--head', HEAD(4), '--k', '3']);
  assert.equal(got.seen, 1, 'one occurrence since the green');
  assert.equal(got.verdict, 'repeat');
  assert.equal(got.depth_spent, false,
    'the depth spent before the green was spent on a failure that got fixed');
});

test('the oscillation still dodges every rule but the attempt backstop', () => {
  // deliver.md's attempt backstop exists for `A → B → A → B → …`, and the reason
  // stated there has two halves. This change closes ONE of them: an oscillating
  // signature now does read `repeat`, because it genuinely has been attempted
  // before. The half that stops the sequence still holds — it never reaches K
  // distinct, so `plan_defect` never fires; nothing on record claims the deeper
  // effort was spent, so `repeat_exhausted` never fires either; and `repeat`
  // DISPATCHES a round, it does not end anything. So no verdict in this sequence
  // ever stops the loop and the attempt counter is still the only thing that
  // does. This is not dead code and this ticket does not replace it.
  const { project, graph } = scratch();
  const rounds = [];
  for (let i = 1; i <= 8; i++) {
    rounds.push(round(project, graph, i % 2 ? 'aaaa' : 'bbbb', HEAD(i)));
  }
  const words = rounds.map((r) => r.verdict);
  assert.deepEqual(words,
    ['first', 'progress', 'repeat', 'repeat', 'repeat', 'repeat', 'repeat', 'repeat'],
    words.join(','));
  assert.ok(rounds.every((r) => r.distinct <= 2), 'two signatures never reach K=3');
  assert.ok(rounds.every((r) => r.verdict !== 'plan_defect'), words.join(','));
  assert.ok(rounds.every((r) => r.verdict !== 'repeat_exhausted'), words.join(','));
});

test('an oscillation whose rethinks ARE recorded does exhaust — the rule, not an accident', () => {
  // Pinned as a DECISION. The acceptance criterion says the oscillation "still
  // reaches no repeat_exhausted"; the gating clause beside it says
  // `repeat_exhausted` means the depth was applied. Those agree only while
  // nothing records a depth, and the wording is resolved in favour of the gate:
  // when the record shows a rethink dispatched at the deeper effort on THIS
  // signature, the claim `repeat_exhausted` makes is simply true. Nothing about
  // the backstop changes in kind — `repeat_exhausted` is still a dispatch, one
  // more round with the model raised, and what ends the loop is still the attempt
  // counter or a person.
  const { project, graph } = scratch();
  round(project, graph, 'aaaa', HEAD(1));
  round(project, graph, 'bbbb', HEAD(2));
  round(project, graph, 'aaaa', HEAD(3), { effort_applied: 'max' });
  round(project, graph, 'bbbb', HEAD(4), { effort_applied: 'max' });
  assert.equal(
    verdict(project, ['--signature', 'aaaa', '--head', HEAD(5), '--k', '3']).verdict,
    'repeat_exhausted'
  );
});

test('it says WHY it read `repeat` with the count already at the threshold', () => {
  // Without this line the ceiling silently never opens and an operator cannot
  // tell an unspent depth from a broken ladder — which is how a guard that reports
  // nothing teaches its reader to stop looking.
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', HEAD(1)), attempt('aaaa', HEAD(2))]);
  const r = run(
    ['verdict', 'T-20-01', '--signature', 'aaaa', '--head', HEAD(3), '--json'],
    { cwd: project, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'repeat');
  assert.ok(/effort_applied/.test(r.stderr), `the reason must name the missing field: ${r.stderr}`);
  assert.ok(/repeat_exhausted/.test(r.stderr), r.stderr);
});

test('and stays quiet when the depth IS on record', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', HEAD(1)), attempt('aaaa', HEAD(2), { effort_applied: 'max' })]);
  const r = run(
    ['verdict', 'T-20-01', '--signature', 'aaaa', '--head', HEAD(3), '--json'],
    { cwd: project, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'repeat_exhausted');
  assert.equal(r.stderr.trim(), '', `nothing to report: ${r.stderr}`);
});

suite('failure signature — the journal is the record, and it lands in the project');

test('a green re-run journals exactly one `flake` event, carrying the job', () => {
  const { project, graph } = scratch();
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green', '--job', 'unit'], { cwd: project, encoding: 'utf8' });
  const lines = journalLines(graph);
  assert.equal(lines.length, 1, 'one act, one line');
  assert.deepEqual(
    { event: lines[0].event, ticket: lines[0].ticket, signature: lines[0].signature, head: lines[0].head, job: lines[0].job, by: lines[0].by },
    { event: 'flake', ticket: 'T-20-01', signature: 'aaaa', head: 'h1', job: 'unit', by: 'failure-signature' }
  );
  assert.ok(lines[0].ts, 'and a timestamp');
});

test('a red re-run journals a `flake_rerun`, never a quarantine', () => {
  const { project, graph } = scratch();
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'red'], { cwd: project, encoding: 'utf8' });
  const lines = journalLines(graph);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'flake_rerun');
  assert.equal(lines[0].outcome, 'red');
  assert.equal(lines[0].by, 'failure-signature');
});

test('`lift` journals a flake_lift and nothing else', () => {
  const { project, graph } = scratch();
  run(['lift', 'T-20-01', '--signature', 'aaaa'], { cwd: project, encoding: 'utf8' });
  const lines = journalLines(graph);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'flake_lift');
  assert.equal(lines[0].signature, 'aaaa');
  assert.ok(!fs.existsSync(path.join(graph, 'flakes.json')), 'the journal IS the record — no new store');
});

test('an unknown --outcome is refused', () => {
  const { project } = scratch();
  const r = run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'yellow'], { cwd: project, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'green|red, or nothing');
  assert.equal(journalLines(path.join(project, '.planning', 'graph')).length, 0);
});

test('verdict and rerun require the signature and the head', () => {
  const { project } = scratch();
  assert.notEqual(run(['verdict', 'T-20-01', '--head', 'h1'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.notEqual(run(['verdict', 'T-20-01', '--signature', 'aaaa'], { cwd: project, encoding: 'utf8' }).status, 0);
  assert.notEqual(run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1'], { cwd: project, encoding: 'utf8' }).status, 0);
});

test('a value-taking flag followed by another flag reports THAT flag as missing a value', () => {
  // `--signature --head h1` used to consume "--head" as the signature, then
  // fail later on a missing --head with a confusing, unrelated error. Found
  // by Copilot's review of this PR.
  const { project } = scratch();
  const r = run(['verdict', 'T-20-01', '--signature', '--head', 'h1'], { cwd: project, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.ok(/--signature needs a value/.test(r.stderr), r.stderr);
});

for (const [what, args] of [
  ['verdict', ['verdict', 'T-20-01', '--signature', 'aaaa', '--head', 'h1']],
  ['rerun', ['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green']],
  ['lift', ['lift', 'T-20-01', '--signature', 'aaaa']],
]) {
  test(`${what} refuses a cwd with no ticket graph, and names --graph`, () => {
    // The flag fixes the instruction; the refusal fixes the class. A verdict read
    // from — or a quarantine written into — a worktree is invisible to the loop.
    const { worktree } = scratch();
    const r = run(args, { cwd: worktree, encoding: 'utf8' });
    assert.equal(r.status, 1, 'must refuse');
    assert.ok(/--graph/.test(r.stderr), 'and name the flag that fixes it');
    assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'nothing is written');
  });

  test(`${what} accepts --graph BEFORE the subcommand`, () => {
    // A flag only tolerated at the end is a trap for the caller who puts it first,
    // and the -1 guard is what keeps the flagless call from eating its subcommand.
    const { worktree, graph } = scratch();
    const r = run(['--graph', graph, ...args], { cwd: worktree, encoding: 'utf8' });
    assert.equal(r.status, 0, `must succeed (${r.stderr})`);
    assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'and nothing lands in the worktree');
  });
}

for (const [what, args] of [
  ['verdict', ['verdict', 'T-20-01', '--signature', 'aaaa', '--head', 'h1']],
  ['rerun', ['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green']],
  ['lift', ['lift', 'T-20-01', '--signature', 'aaaa']],
]) {
  // Copilot's finding on this PR: `--graph` with no value read as "explicit"
  // regardless, because the old check only tested flag PRESENCE. That resolved
  // GRAPH_DIR to `path.resolve('')` (the cwd) and skipped the refusal below —
  // a fixer's worktree cwd would silently become the graph dir.
  test(`${what}: a --graph at the end with no value is a usage error, not a silent cwd fallback`, () => {
    const { worktree } = scratch();
    const r = run([...args, '--graph'], { cwd: worktree, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'a missing value must not be treated as an explicit graph');
    assert.ok(/--graph/.test(r.stderr), 'and the message names the flag');
    assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'nothing is written to the wrong place');
  });

  test(`${what}: a --graph immediately followed by another flag is a usage error`, () => {
    const { worktree } = scratch();
    const r = run(['--graph', '--json', ...args], { cwd: worktree, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'the next flag is not a directory value');
    assert.ok(/--graph/.test(r.stderr));
    assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'nothing is written to the wrong place');
  });
}

test('SHIPYARD_GRAPH_DIR resolves it too', () => {
  const { worktree, graph } = scratch();
  const r = run(['lift', 'T-20-01', '--signature', 'aaaa'],
    { cwd: worktree, encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: graph } });
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(journalLines(graph).length, 1, 'the event lands in the project journal');
});

test('a --graph written from a worktree lands in the PROJECT journal', () => {
  const { worktree, graph } = scratch();
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green', '--graph', graph],
    { cwd: worktree, encoding: 'utf8' });
  assert.equal(journalLines(graph).length, 1);
  assert.equal(verdict(worktree, ['--signature', 'aaaa', '--head', 'h1', '--graph', graph]).verdict, 'flake');
});

test('six concurrent re-run marks all reach the journal', () => {
  // The loop and the sentinel run at once, so two processes can record a re-run
  // in the same instant. An append that escaped the lock shows up here as a short
  // or interleaved log — the same repro that found drift-record's lost updates.
  // (Spawned through bash rather than from an async test body: `bash -c '... & wait'`
  // is the plainest way to get six writers into flight AT ONCE, which is the
  // contention under test — `spawnSync` in a loop would serialize it away before
  // the lock is ever asked anything. It was first written this way for a different
  // reason: the harness could not await an async body at all, and that defect was
  // routed around here rather than recorded, which is how two vacuous tests kept
  // reporting safety for a month. T-22-05 repaired the harness — an async body is
  // awaited now and can fail — so only the first reason still holds.)
  const { project, graph } = scratch();
  const cmd = [1, 2, 3, 4, 5, 6].map((i) =>
    `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} rerun T-20-01 ` +
    `--signature sig${i} --head h1 --outcome red --graph ${JSON.stringify(graph)} &`
  ).join('\n') + '\nwait\n';
  const r = spawnSync('bash', ['-c', cmd], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, `all six must succeed (${r.stderr})`);
  const lines = journalLines(graph);
  assert.equal(lines.length, 6, `one line per re-run, got ${lines.length}`);
  assert.equal(new Set(lines.map((l) => l.signature)).size, 6, 'and none overwrote another');
});

done();
