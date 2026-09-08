'use strict';

// ci-wait.cjs is the one legitimate way for the conveyor to wait, and its value
// is entirely in WHEN IT REFUSES. `gh pr checks --watch` was removed from this
// repo because a run blocking on one PR stops driving every other ticket — the
// defect front.cjs exists to fix. That reasoning is about opportunity cost, and
// it evaporates only when the board has nothing else to offer.
//
// So the tests are mostly refusals: every one of them is the old defect trying to
// come back. The settle path is tested against a stub `gh`, because this is about
// our parsing and our verdicts, not about GitHub.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'ci-wait.cjs'
);

const EMPTY_ACTIONABLE = { execute: [], publish: [], fix: [], finalize: [], merge: [] };

// A board whose ONLY content is CI — the shape that legitimately waits.
const ciOnly = (over = {}) => ({
  generated_at: new Date().toISOString(),
  actionable_count: 0, left_behind_count: 0, actionable: { ...EMPTY_ACTIONABLE },
  waiting: { ci: ['T-01-01'], dispatched: [], merge_human: [], human: [] },
  fixpoint: false,
  ...over,
});

const stateWith = (over = {}) => ({
  'T-01-01': { pr: 101, repo: 'acme/widgets', status: 'pr-open' },
  ...over,
});

// A board whose only content is a child HELD BEHIND A MOVING PARENT. The child's
// own checks are green; the pipeline it is actually waiting for is the parent's,
// and the board says which parent that is (`parent_of`, written by front.cjs).
const heldOnly = (over = {}) => ciOnly({
  waiting: { ci: [], dispatched: [], parent: ['T-01-02'], merge_human: [], human: [] },
  parent_of: { 'T-01-02': 'T-01-01' },
  ...over,
});
const heldState = (over = {}) => stateWith({
  'T-01-02': { pr: 102, repo: 'acme/widgets', status: 'pr-open' },
  ...over,
});

// `configRaw` writes .planning/config.json byte for byte — the only way to build
// an UNPARSEABLE one. Absent by default, which is the case every other test in
// this file means: nobody has configured the project, so the defaults apply.
function project(front, state, configRaw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ciwait-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  if (configRaw !== undefined) fs.writeFileSync(path.join(dir, '.planning', 'config.json'), configRaw);
  if (front !== null) fs.writeFileSync(path.join(g, 'delivery-front.json'), JSON.stringify(front));
  if (state !== null) fs.writeFileSync(path.join(g, 'delivery-state.json'), JSON.stringify(state));
  // escalation-record refuses to write beside a graph with no tickets.json — the
  // guard that stops a record being filed where nobody would read it.
  fs.writeFileSync(path.join(g, 'tickets.json'), JSON.stringify({ tickets: { 'T-01-01': {} } }));
  return dir;
}

const waits = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'graph', 'ci-waits.json'), 'utf8')); }
  catch { return null; }
};
const escalations = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'graph', 'escalations.json'), 'utf8')); }
  catch { return null; }
};

// A stub gh answering exactly the one call ci-wait makes. `rows` is the JSON it
// returns for `pr checks`; `exit` mimics gh's habit of reporting CI state through
// the EXIT CODE (8 = pending) while still printing JSON.
//
// Every row carries gh's own `bucket` next to its `state`, because that is what
// gh returns and what check-state.cjs reads. A row WITHOUT one is PENDING by the
// fail-closed rule, so a bucket-less fixture would sit in the wait forever — which
// is the point of the two cases at the end of this suite.
function stubGh(dir, rows, exit = 0) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    'case "$1 $2" in\n' +
    `  "pr checks") cat <<'J'\n${JSON.stringify(rows)}\nJ\n    exit ${exit} ;;\n` +
    '  *) echo "stub gh: unhandled: $*" >&2; exit 1 ;;\n' +
    'esac\n', { mode: 0o755 });
  return bin;
}

// run(front, state, args, {bin}) → {code, out}
function run(front, state, args = [], opts = {}) {
  const dir = opts.dir || project(front, state);
  const env = { ...process.env, ...(opts.env || {}) };
  if (opts.bin) env.PATH = `${opts.bin}:${env.PATH}`;
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), dir };
}

const asJson = (front, state, args = [], opts = {}) => {
  const r = run(front, state, ['--json', ...args], opts);
  return { code: r.code, json: JSON.parse(r.out), dir: r.dir };
};

suite('ci-wait — it refuses whenever waiting is not the run\'s next move');

test('actionable work on the board is refused, and the work is named', () => {
  const { code, json } = asJson(ciOnly({
    actionable_count: 2, actionable: { ...EMPTY_ACTIONABLE, merge: ['T-01-02'], finalize: ['T-01-03'] },
  }), stateWith());
  assert.equal(code, 3, 'a board with moves must not be waited on');
  assert.equal(json.waited, false, 'and it says so as data, because the caller is a loop');
  assert.ok(/merge: T-01-02/.test(json.refusal) && /finalize: T-01-03/.test(json.refusal),
    'the refusal names the buckets, so the caller knows what to do instead');
  assert.ok(/front\.cjs/.test(json.hint), 'and names the rule it is protecting');
});

test('a board of only LEFT-BEHIND work is not a reason to refuse', () => {
  // front.cjs calls that "a decision, not motion" — demanding it be taken is how
  // a guard starts lying, and the stop gate already honours the same rule.
  const dir = project(ciOnly({ actionable_count: 2, left_behind_count: 2,
    actionable: { ...EMPTY_ACTIONABLE, execute: ['T-00-01', 'T-00-02'] } }), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'left-behind work must not block a legitimate wait');
  assert.equal(json.settled, 'T-01-01', 'the wait proceeded and returned normally');
});

test('a dispatched agent is refused: that wake-up is free and sooner', () => {
  const { code, json } = asJson(
    ciOnly({ waiting: { ci: ['T-01-01'], dispatched: ['T-01-04'], merge_human: [], human: [] } }),
    stateWith());
  assert.equal(code, 3, 'never add latency to a round that was already going to happen');
  assert.ok(/T-01-04/.test(json.refusal), 'the refusal names who is working');
});

test('nothing waiting on CI is refused, and a fixpoint is said out loud', () => {
  const { code, json } = asJson(
    ciOnly({ waiting: { ci: [], dispatched: [], merge_human: [], human: [] }, fixpoint: true }),
    stateWith());
  assert.equal(code, 3, 'there is nothing to shorten');
  assert.ok(/fixpoint/.test(json.hint), 'and the honest reason is that the run is done');
});

test('a CI ticket with no PR is a board bug, not a wait', () => {
  const { code, json } = asJson(ciOnly(), {});
  assert.equal(code, 3, 'waiting on a PR that is not recorded would wait forever');
  assert.ok(/state-sync/.test(json.hint), 'and the remedy is a re-sync, not patience');
});

test('no board at all is refused with the directory it looked in', () => {
  const { code, json } = asJson(null, null);
  assert.equal(code, 3, 'no board, no wait');
  assert.ok(/\.planning\/graph/.test(json.refusal), 'and it names where it looked');
});

suite('ci-wait — a wait on the parent is a wait, and the parent is what it watches');

// D4. `waiting.parent` is a child whose base is about to move: the only thing that
// will ever release it is the PARENT's pipeline. A waiter that reads `waiting.ci`
// alone called that board "nothing is waiting on CI" and refused — while the stop
// gate's CI-only branch, reading the same empty bucket, allowed the stop. Between
// the two, the one thing that would have moved the board was a pipeline nobody
// watched.

test('a held child is a legitimate wait, and it watches the PARENT\'s PR', () => {
  const dir = project(heldOnly(), heldState());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], 8);
  const { code, json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'this is a wait, not a refusal');
  assert.equal(json.waited, true);
  assert.deepEqual(json.watched.map((w) => w.pr), [101], 'the PARENT\'s PR, not the child\'s');
  assert.equal(json.watched[0].id, 'T-01-01', 'and the record belongs to the ticket whose pipeline it is');
  assert.deepEqual(json.watched[0].via, ['T-01-02'], 'naming who is held behind it');
});

test('a parent already in waiting.ci is watched ONCE', () => {
  // The common shape: the parent's checks are running, so the parent is in
  // `waiting.ci` and is also what its child waits for. Two entries would poll the
  // same PR twice per round and record the same empty window twice.
  const dir = project(
    heldOnly({ waiting: { ci: ['T-01-01'], dispatched: [], parent: ['T-01-02'], merge_human: [], human: [] } }),
    heldState());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], 8);
  const { json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.deepEqual(json.watched.map((w) => w.pr), [101]);
  assert.deepEqual(json.watched[0].via, ['T-01-02'], 'and it still says who else is waiting on it');
  assert.equal(waits(dir).tickets['T-01-01'].empty_windows, 1, 'one window, not two');
});

test('a held child whose board names no parent is a board bug, not a wait', () => {
  // An older front on disk carries `waiting.parent` with no `parent_of`. Guessing
  // the parent here would mean re-deriving graph semantics in the waiter — the
  // duplication this ticket exists to remove. Say so and name the re-sync.
  const { code, json } = asJson(heldOnly({ parent_of: {} }), heldState());
  assert.equal(code, 3);
  assert.ok(/T-01-02/.test(json.refusal), 'the refusal names the held ticket');
  assert.ok(/state-sync/.test(json.hint), 'and the remedy is a re-sync, not patience');
});

test('an orphan held child is refused even when another ticket gives the script a watch target', () => {
  // The dangerous shape: T-01-01 is legitimately in `waiting.ci`, so `watch` is
  // non-empty on its own — the old code let that mask a SEPARATE held ticket with
  // no `parent_of` entry, silently dropping it instead of surfacing the stale
  // front. Everything else on the board looking fine is exactly what must not
  // hide this.
  const { code, json } = asJson(heldOnly({
    waiting: { ci: ['T-01-01'], dispatched: [], parent: ['T-01-02'], merge_human: [], human: [] },
    parent_of: {},
  }), heldState());
  assert.equal(code, 3, 'one orphan held ticket refuses the whole wait, not just its own entry');
  assert.ok(/T-01-02/.test(json.refusal), 'the refusal names the orphan ticket');
  assert.ok(/state-sync/.test(json.hint), 'and the remedy is a re-sync, not patience');
});

suite('ci-wait — the wait itself');

test('it returns the moment a PR settles, green', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }, { name: 'Lint', state: 'SUCCESS', bucket: 'pass' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a settled PR ends the wait');
  assert.equal(json.waited, true, 'and reports that it waited');
  assert.equal(json.settled, 'T-01-01', 'naming which ticket moved');
  assert.equal(json.pr, 101, 'and its PR');
  assert.deepEqual(json.checks, { total: 2, pending: 0, failing: 0 }, 'with the tally the caller needs');
});

test('RED counts as settled — a waiter must not hold a run hostage to a failure', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'FAILURE', bucket: 'fail' }, { name: 'Lint', state: 'SUCCESS', bucket: 'pass' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'the answer exists; whether it is good news is the caller\'s business');
  assert.equal(json.settled, 'T-01-01', 'it settled');
  assert.equal(json.checks.failing, 1, 'and the failure is reported, not hidden');
});

test('a state no local list ever named is failing when gh says bucket fail', () => {
  // ci-wait's own list had FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED and
  // nothing else, so STARTUP_FAILURE fell through both filters and this settle
  // reported `failing: 0` — a green answer on a pipeline that never started. gh
  // buckets it `fail`, and now so does the waiter.
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'STARTUP_FAILURE', bucket: 'fail' }], 1);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'the answer exists, so the wait is over');
  assert.equal(json.settled, 'T-01-01');
  assert.equal(json.checks.failing, 1, 'and it is reported as the failure it is');
});

test('a row with no bucket keeps waiting — it must never be counted as settled', () => {
  // Fail closed, on the waiter's side: an unreadable check cannot be green, and
  // `total > 0 && pending === 0` is what ends the wait. An older gh with no
  // `bucket` field used to end it AND hand the loop a green tally.
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS' }]);
  const { code, json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a timeout is still a legitimate return');
  assert.equal(json.settled, null, 'nothing settled: the row could not be read');
  assert.equal(json.timed_out, true);
});

test("gh's non-zero exit on a pending pipeline is DATA, not an error", () => {
  // `gh pr checks` reports CI state through its exit code (8 = pending) while
  // still printing JSON. Treating that as a broken command makes a pending
  // pipeline indistinguishable from a missing gh — state-sync.cjs carries the
  // same note for the same reason.
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], 8);
  const { code, json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a timeout is still a legitimate return');
  assert.equal(json.timed_out, true, 'it waited rather than erroring out');
  assert.equal(json.settled, null, 'and nothing settled');
  assert.ok(!/unhandled/.test(JSON.stringify(json)), 'the stub was never asked anything else');
});

test('a timeout returns 0 and tells the caller to re-sync anyway', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'PENDING', bucket: 'pending' }]);
  const r = run(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(r.code, 0, 'a waiter that dies noisily teaches the loop to stop calling it');
  assert.ok(/nothing settled/.test(r.out), 'the human form says what happened');
  assert.ok(/Re-sync anyway/.test(r.out), 'and what to do about it');
});

test('an unreachable gh is survived, not fatal', () => {
  // A foreign repo the token cannot see is a parked ticket, never an aborted
  // run — the same rule state-sync obeys.
  const dir = project(ciOnly(), stateWith());
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh: not found" >&2\nexit 127\n', { mode: 0o755 });
  const { code, json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'the wait times out instead of crashing');
  assert.equal(json.timed_out, true, 'and says so');
});

suite('ci-wait — usage');

test('--graph followed by another flag is a usage error, not a silent cwd fallback', () => {
  // One spelling has to mean one PARSER: log-event.cjs, drift-record.cjs and
  // escalation-record.cjs all carry this guard, because `--graph --json` once
  // resolved a directory literally called "--json" AND counted as explicit.
  const r = run(ciOnly(), stateWith(), ['--graph', '--json']);
  assert.equal(r.code, 2, 'a flag-shaped token is not a directory');
  assert.ok(/--graph needs a directory value/.test(r.out), 'and the message says which');
});

test('a non-positive timeout or interval is a usage error', () => {
  assert.equal(run(ciOnly(), stateWith(), ['--timeout', '0']).code, 2, 'zero is not a window');
  assert.equal(run(ciOnly(), stateWith(), ['--interval', 'soon']).code, 2, 'nor is a word');
});

suite('ci-wait — it terminates, and a stuck pipeline ends with a person');

// A stop gate can refuse only once per turn, so the gate/waiter pair has to reach
// an end on its own — and it must not do so by leaving a stuck pipeline
// unattended. Three empty windows against escalation-record's fingerprint is ~45m
// of nothing moving; that ends with a park, and a park drops the ticket from the
// front, which makes the gate's CI branch stop firing through the rule it already
// had. No second special case anywhere.

const pending = (dir) => stubGh(dir, [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], 8);
const shortWait = ['--timeout', '1', '--interval', '1'];

// A `gh` that never answers at all — no valid JSON, ever. Distinct from `pending`
// (which DOES answer, just with a pending check): this is what a rate limit, an
// outage, or an expired token looks like from here.
function stubGhDown(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "gh: rate limited" >&2\nexit 1\n', { mode: 0o755 });
  return bin;
}

// A stub that answers differently PER PR NUMBER (the third positional arg to
// `gh pr checks <pr> --json ...`), so two watched tickets on two different PRs
// can be driven independently in the same round.
function stubGhByPr(dir, map) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cases = Object.entries(map)
    .map(([pr, { rows, exit }]) => `  ${pr}) cat <<'J'\n${JSON.stringify(rows)}\nJ\n     exit ${exit || 0} ;;\n`)
    .join('');
  fs.writeFileSync(path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    'if [ "$1 $2" = "pr checks" ]; then\n' +
    '  case "$3" in\n' +
    cases +
    '  *) echo "stub gh: unhandled pr $3" >&2; exit 1 ;;\n' +
    '  esac\n' +
    'else\n' +
    '  echo "stub gh: unhandled: $*" >&2; exit 1\n' +
    'fi\n', { mode: 0o755 });
  return bin;
}

test('an empty window is counted, bound to the delivery-state fingerprint', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = pending(dir);
  const { code, json } = asJson(null, null, shortWait, { dir, bin });
  assert.equal(code, 0, 'a timeout is a legitimate return');
  assert.equal(json.timed_out, true, 'nothing settled');
  const w = waits(dir);
  assert.equal(w.tickets['T-01-01'].empty_windows, 1, 'the window is on record');
  assert.ok(w.tickets['T-01-01'].fingerprint, 'bound to a fingerprint, so any real change resets it');
  assert.equal(escalations(dir), null, 'and one window earns nobody a park');
});

test('three empty windows escalate, and the reason says how to lift it', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = pending(dir);
  let json;
  for (let i = 0; i < 3; i += 1) ({ json } = asJson(null, null, shortWait, { dir, bin }));
  assert.equal(waits(dir).tickets['T-01-01'].empty_windows, 3, 'the count reached the budget');
  assert.equal(json.escalated.length, 1, 'and the park was filed in the same act');
  assert.equal(json.escalated[0].ok, true, 'successfully');
  const e = escalations(dir).tickets['T-01-01'];
  assert.ok(/not going to settle/.test(e.reason), 'the reason names the judgement');
  assert.ok(/escalation-record\.cjs clear/.test(e.reason), 'and how a person lifts it by hand');
  assert.ok(e.fingerprint, 'and it expires by itself once the PR moves');
});

test('a settle forgets the whole run of empty windows', () => {
  // Progress means nothing here is stuck, so carrying the count forward would
  // march a healthy-but-slow pipeline toward a park it never earned.
  const dir = project(ciOnly(), stateWith());
  asJson(null, null, shortWait, { dir, bin: pending(dir) });
  assert.equal(waits(dir).tickets['T-01-01'].empty_windows, 1, 'one window recorded');
  const green = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { json } = asJson(null, null, ['--interval', '1'], { dir, bin: green });
  assert.equal(json.settled, 'T-01-01', 'it settled');
  assert.equal(waits(dir).tickets['T-01-01'], undefined, 'and the record is gone');
});

test('the budget is tunable, and garbage in the env var does not disable it', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = pending(dir);
  const { json } = asJson(null, null, shortWait, { dir, bin, env: { SHIPYARD_CI_WAIT_MAX_EMPTY: '1' } });
  assert.equal(json.escalated.length, 1, 'one window is enough when the budget says so');

  const d2 = project(ciOnly(), stateWith());
  const b2 = pending(d2);
  const { json: j2 } = asJson(null, null, shortWait, { dir: d2, bin: b2, env: { SHIPYARD_CI_WAIT_MAX_EMPTY: 'three' } });
  assert.equal(j2.escalated.length, 0, 'a garbage value falls back to the default, it does not park at once');
});

suite('ci-wait — a corrupt configuration permits no park (ADR-004 D2)');

// The park is a MUTATION: it hands the ticket to a person and drops it off the
// front. An unparseable config means the project's policy is unknown, and an
// unknown policy authorizes nothing — so the wait still happens (waiting mutates
// nothing) and the escalation is withheld, with the reason, until the file parses.
const TRUNCATED = '{"pipeline": {"auto_merge": "off"';

test('three empty windows on an invalid config file earn NO escalation', () => {
  const dir = project(ciOnly(), stateWith(), TRUNCATED);
  const bin = pending(dir);
  let json;
  for (let i = 0; i < 3; i += 1) ({ json } = asJson(null, null, shortWait, { dir, bin }));
  assert.equal(waits(dir).tickets['T-01-01'].empty_windows, 3,
    'the empty window is a FACT and is still counted');
  assert.equal(escalations(dir), null, 'but nothing was parked');
  assert.equal(json.escalated.length, 1, 'the withheld park is still reported to the caller');
  assert.equal(json.escalated[0].ok, false);
  assert.equal(json.escalated[0].refused, true, 'a deliberate refusal, not a failed write');
  assert.ok(/does not parse/.test(json.escalated[0].error), json.escalated[0].error);
});

test('and it says so on window ONE, not only when the park came due', () => {
  // The caller is a loop; learning on window 3 that the termination path is
  // withheld is learning 45 minutes late.
  const dir = project(ciOnly(), stateWith(), TRUNCATED);
  const { code, json } = asJson(null, null, shortWait, { dir, bin: pending(dir) });
  assert.equal(code, 0, 'a waiter never dies noisily — least of all over a config file');
  assert.equal(json.config_valid, false);
  assert.ok(/config\.json/.test(json.config_error.relative), JSON.stringify(json.config_error));
  assert.ok(/no escalation is filed/.test(json.config_note), json.config_note);
  assert.equal(json.escalated.length, 0, 'no park was due yet, and none was invented');
});

test('a VALID config parks exactly as before — the control', () => {
  const dir = project(ciOnly(), stateWith(), '{"pipeline":{"auto_merge":"off"}}');
  const bin = pending(dir);
  let json;
  for (let i = 0; i < 3; i += 1) ({ json } = asJson(null, null, shortWait, { dir, bin }));
  assert.equal(json.escalated[0].ok, true, 'a readable config authorizes the park');
  assert.ok(escalations(dir).tickets['T-01-01'], 'and the record is on disk');
  assert.equal(json.config_valid, undefined, 'and nothing is said about a file that is fine');
});

suite('ci-wait — an outage is not a stall');

// A9 defect 1. When `gh` cannot be reached at all, every poll returns the same
// "nothing readable" — not the same fact as a pipeline that genuinely has not
// moved. Counting it as an empty window escalates every watched ticket after
// one bad window each, and each park then needs a human to lift for no reason
// but a rate limit.

test('gh failing for the whole window is an outage, not a stall — nothing is recorded', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGhDown(dir);
  const { code, json } = asJson(null, null, shortWait, { dir, bin });
  assert.equal(code, 0, 'an outage still returns a code the loop can read');
  assert.equal(json.outage, true, 'and says plainly that it is an outage, not a stall');
  assert.equal(json.escalated.length, 0, 'nothing was parked from an outage');
  assert.equal(waits(dir), null, 'ci-waits.json is untouched — no empty window was counted');
});

test("a settle on one ticket must not wipe another ticket's own window count", () => {
  // A9 defect 2. `delete store.tickets[w.id]` used to run for EVERY watched
  // ticket on any settle — a neighbour finishing wiped a ticket that had been
  // stuck for two windows already.
  const dir = project(
    ciOnly({ waiting: { ci: ['T-01-01', 'T-01-05'], dispatched: [], merge_human: [], human: [] } }),
    stateWith({ 'T-01-05': { pr: 105, repo: 'acme/widgets', status: 'pr-open' } }));
  const bothPending = stubGhByPr(dir, {
    101: { rows: [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], exit: 8 },
    105: { rows: [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], exit: 8 },
  });
  // Two full windows where neither settles: B's count reaches 2.
  asJson(null, null, shortWait, { dir, bin: bothPending });
  asJson(null, null, shortWait, { dir, bin: bothPending });
  assert.equal(waits(dir).tickets['T-01-05'].empty_windows, 2, 'B accumulated two empty windows');

  // Third window: A settles at once; B is still pending.
  const aSettles = stubGhByPr(dir, {
    101: { rows: [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }], exit: 0 },
    105: { rows: [{ name: 'Tests', state: 'IN_PROGRESS', bucket: 'pending' }], exit: 8 },
  });
  const { json } = asJson(null, null, shortWait, { dir, bin: aSettles });
  assert.equal(json.settled, 'T-01-01', 'A settled');
  assert.equal(waits(dir).tickets['T-01-01'], undefined, "A's own record is cleared");
  assert.equal(waits(dir).tickets['T-01-05'].empty_windows, 2,
    "B's record survives A's settle — today it is deleted along with it");
});

suite('ci-wait — the window is sized from the observed CI, not a flat 15 minutes');

// A9 defect 3. `TIMEOUT_S` default (15m) × `MAX_EMPTY` (3) is 45 minutes to
// escalation regardless of the repo. `front.ci_estimates[ticket]` carries a
// per-repo median PR lifetime; when it is present the window should default to
// a fraction of it rather than the flat constant.

test('the window is sized from ci_estimates when the front carries one, floored at 15m', () => {
  const dir = project(ciOnly({ ci_estimates: { 'T-01-01': 2400 } }), stateWith()); // 40m estimate
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  // No --timeout: it settles on the first poll regardless of window size, so the
  // derived window is never actually waited out — only the reported value is
  // checked.
  const { json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(json.settled, 'T-01-01');
  assert.equal(json.window_s, 900, '2400/3=800s is below the 15-minute floor, so it clamps to 900');
  assert.ok(/ci_estimates/.test(json.window_source || ''), 'and says where the window came from');
});

test('the derived window is clamped to an hour for a very slow repo', () => {
  const dir = project(ciOnly({ ci_estimates: { 'T-01-01': 999999 } }), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(json.window_s, 3600, 'clamped to the one-hour ceiling');
});

test('an explicit --timeout overrides the estimate-derived window', () => {
  const dir = project(ciOnly({ ci_estimates: { 'T-01-01': 2400 } }), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { json } = asJson(null, null, ['--timeout', '600', '--interval', '1'], { dir, bin });
  assert.equal(json.window_s, 600, 'an explicit --timeout always wins over an estimate');
});

test('SHIPYARD_CI_WAIT_TIMEOUT_S overrides the estimate, but not an explicit --timeout', () => {
  const dir = project(ciOnly({ ci_estimates: { 'T-01-01': 2400 } }), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { json: j1 } = asJson(null, null, ['--interval', '1'],
    { dir, bin, env: { SHIPYARD_CI_WAIT_TIMEOUT_S: '300' } });
  assert.equal(j1.window_s, 300, 'the env override wins over the derived estimate');
  const { json: j2 } = asJson(null, null, ['--timeout', '120', '--interval', '1'],
    { dir, bin, env: { SHIPYARD_CI_WAIT_TIMEOUT_S: '300' } });
  assert.equal(j2.window_s, 120, 'an explicit --timeout still wins over the env override');
});

test('with no ci_estimates entry, the window stays the flat default', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(json.window_s, 15 * 60, 'no estimate for this ticket — the original 15-minute default holds');
});

test('a broken wait record never takes the wait down with it', () => {
  // Measured while writing this file: an accident left `ci-waits.json` as a
  // DIRECTORY, and writeAtomic's EISDIR killed the whole script — no exit code
  // the loop could read, which teaches the loop to stop calling it and puts the
  // hole straight back. The bookkeeping is not worth that.
  const dir = project(ciOnly(), stateWith());
  const bin = pending(dir);
  fs.mkdirSync(path.join(dir, '.planning', 'graph', 'ci-waits.json'), { recursive: true });
  const { code, json } = asJson(null, null, shortWait, { dir, bin });
  assert.equal(code, 0, 'the wait still returns a code the loop can read');
  assert.equal(json.timed_out, true, 'and its own result stands');
  assert.equal(json.escalated[0].ok, false, 'while saying the bookkeeping failed');
  assert.ok(/wait record not updated/.test(json.escalated[0].error), 'and naming what broke');
});

suite('ci-wait — the left-behind adjustment reads a front built from evidence');

// The guard subtracts `left_behind_count` from the actionable count, and that is
// the right arithmetic over the wrong input for as long as the count is derived
// from phase NUMBERS. Measured on 2026-09-07: three phase-26 tickets merged into
// their epic, so phase 24's live, high-risk, pre-authorized head counted as
// left behind — a board with one real move would then have waited on somebody
// else's CI instead of taking it. So this fixture is the real computed front.

test('a lower-numbered phase still in flight is a move, and the wait is refused', () => {
  const { computeFront, epicKey } = require(path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
  ));
  const epic = (phase, over) => ({
    phase: String(phase), repo: null, branch: `epic/${phase}-x`, base: 'main',
    exists: true, ahead: 0, pr: null, landed: true, landed_reason: 'whole diff is in', ...over,
  });
  const tickets = { 'T-24-05': { phase: '24' }, 'T-26-01': { phase: '26' }, 'T-26-02': { phase: '26' } };
  const state = {
    'T-24-05': { status: 'pending', ready: true },
    'T-26-01': { status: 'merged' },
    'T-26-02': { status: 'pr-open', pr: 102, repo: 'acme/widgets', checks: { total: 3, failing: 0, pending: 3, none_reported: false } },
  };
  const records = [
    epic(24, { ahead: 7, landed: false, pr: { number: 824, state: 'OPEN' } }),
    epic(26, { pr: { number: 926, state: 'MERGED' } }),
  ];
  const front = {
    generated_at: new Date().toISOString(),
    ...computeFront(tickets, state, { epics: Object.fromEntries(records.map((r) => [epicKey(r.phase, r.repo), r])) }),
  };
  assert.equal(front.left_behind_count, 0, 'the fixture must be the defect, not a hand-written count');
  assert.deepEqual(front.waiting.ci, ['T-26-02'], 'and there is a genuine wait to be tempted by');

  const { code, json } = asJson(front, state);
  assert.equal(code, 3, 'a board with a move must not be waited on');
  assert.ok(/T-24-05/.test(json.refusal), 'and the refusal names the work that was nearly skipped');
});

// ── the last sleep of a wait, and why this is arithmetic and not a run ───────
//
// `sleep(s)` is called once per round with the time LEFT until the deadline, so
// `s` is fractional whenever the remainder is smaller than `--interval`. Both
// numbers handed to `spawnSync` must be integers: `timeout` is rejected with
// ERR_OUT_OF_RANGE otherwise. It used to be `(s + 5) * 1000`, and in IEEE754
// that is not always an integer — **12.1% of whole-millisecond remainders
// between 1s and 30s produce one that is not** (3495 of 29000; e.g. s = 1.001
// gives 6000.999999999999). So the throw landed on roughly one final sleep in
// eight, immediately BEFORE the deadline branch — which means the empty-window
// counting and the three-strikes escalation this script exists to reach never
// ran on those invocations, and the waiter died noisily: the exact thing its own
// header calls the reason a loop stops calling it.
//
// Two reasons this is tested as a rule rather than by running the script.
// First, every other timeout test here passes `--interval 1`, so `Math.min(1, …)`
// always picked the integer and the defect was invisible to all of them — and
// widening the interval only makes the FINAL sleep fractional, which is a race
// against how long a stubbed poll takes. Probed at `--timeout 3/5/8`: no crash,
// because those remainders happened to land on the 88% that are integral. A test
// that reproduces one run in eight is a flake, not a guard.
// Second, `ci-wait.cjs` runs its CLI at require time, so the helper cannot be
// imported and asserted directly.
// So: pin the RULE over the range that broke, and pin that the code uses it.
test('the sleep timeout is an integer for every remainder, not 88% of them', () => {
  const msFor = (s) => Math.round(s * 1000) + 5000;   // the shipped derivation
  const old = (s) => (s + 5) * 1000;                  // what it replaced
  let brokeBefore = 0;
  for (let ms = 1000; ms < 30000; ms += 1) {
    const s = ms / 1000;
    assert.ok(Number.isInteger(msFor(s)), `a remainder of ${s}s must yield an integer timeout`);
    if (!Number.isInteger(old(s))) brokeBefore += 1;
  }
  assert.ok(brokeBefore > 3000,
    'and the old derivation really did break on thousands of them — if this drops, ' +
    'the arithmetic being guarded has changed and the guard needs rereading');
});

test('the script derives both sleep numbers from ONE rounding', () => {
  // The regression was two separate derivations from the same fractional input:
  // the `-e` body rounded, the `timeout` did not. Pin the shape, because the
  // rule above cannot see which expression the file actually passes.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/const ms = Math\.round\(s \* 1000\)/.test(src), 'the milliseconds are rounded once');
  assert.ok(/timeout: ms \+ 5000/.test(src), 'and the timeout is derived from that same integer');
  assert.ok(!/timeout: \(s \+ 5\) \* 1000/.test(src), 'never again from the fractional seconds');
});

// ── THE CAP AND THE WAIT AGREE ABOUT ONE BOARD (T-27-01, ADR-006 D1) ─────────
//
// This script's refusal is about OPPORTUNITY COST: waiting while the board has
// moves stops the run driving every other ticket. A move that CANNOT BE TAKEN
// costs nothing to leave, so on a board the cap has spent (`capacity.free === 0`)
// the actionable items are not "work to take first" — naming them as such told
// the run to breach the gate that computed them, while `front.cjs` said
// `fixpoint: NO — capacity` and `stop-gate.cjs` blocked the stop. Three
// mechanisms, one board, three answers.
suite('ci-wait — a board the cap has spent is not work to take first');

// THE SHARED FULL-BOARD FIXTURE — four executors out under a cap of four, two
// more tickets ready. Computed through the real front.cjs, and restated in
// tests/unit/front.test.cjs and tests/unit/stop-gate.test.cjs: the point of the
// ticket is that all three readers agree about ONE board, which three hand-built
// fronts could not show. Change it here and change it there.
const { computeFront } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));
const FULL_OUT = ['T-27-91', 'T-27-92', 'T-27-93', 'T-27-94'];
const FULL_READY = ['T-27-95', 'T-27-96'];
const fullBoard = () => {
  const ids = [...FULL_OUT, ...FULL_READY];
  return {
    generated_at: new Date().toISOString(),
    ...computeFront(
      Object.fromEntries(ids.map((id) => [id, {}])),
      Object.fromEntries(ids.map((id) => [id, { status: 'pending', ready: true }])),
      { maxConcurrentAgents: 4, dispatched: Object.fromEntries(FULL_OUT.map((id) => [id, 'executor'])) }
    ),
  };
};
const fullBoardState = () => Object.fromEntries(
  [...FULL_OUT, ...FULL_READY].map((id) => [id, { status: 'pending', ready: true }])
);

test('the shared full board is never refused with the capped items as the reason', () => {
  const board = fullBoard();
  assert.deepEqual(board.capacity, { max: 4, in_flight: 4, free: 0 }, 'the fixture really is full');
  const { code, json } = asJson(board, fullBoardState());
  // It still refuses — four agents are out, and an agent completion is a wake-up
  // the runtime gives for free and sooner — but on THAT ground, which is the one
  // the board supports. What must never come back is "take that work first".
  assert.equal(code, 3);
  assert.ok(/with an agent/.test(json.refusal), `the refusal names the agents: ${json.refusal}`);
  assert.ok(!/actionable item/.test(json.refusal),
    `a capped board must not be named as work to take first: ${json.refusal}`);
  for (const id of FULL_READY) {
    assert.ok(!json.refusal.includes(id), `${id} cannot be taken this round: ${json.refusal}`);
  }
});

test('a capped board with nobody out WAITS — the guard is skipped, not merely reordered', () => {
  // Reachable and not contrived: `in_flight` counts live dispatch records, and a
  // record for a ticket that has since merged or been parked leaves the bucket
  // while still spending its agent until it expires. The cap says nothing may be
  // dispatched, nothing is with an agent, and a pipeline is running — so the only
  // move in the system is the wait, and this script is the one that can take it.
  const dir = project(ciOnly({
    actionable_count: 2,
    actionable: { ...EMPTY_ACTIONABLE, execute: ['T-01-05', 'T-01-06'] },
    capacity: { max: 4, in_flight: 4, free: 0 },
  }), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a capped board must not be refused as work to take first');
  assert.equal(json.settled, 'T-01-01', 'the wait proceeded and returned normally');
});

test('a cap of 0 waits too — no policy is in effect, so no dispatch is possible', () => {
  // front.cjs can only express `max: 0` one way: the project config does not
  // parse, so nothing may be dispatched at all. Waiting mutates nothing; the
  // escalation a wait may earn is withheld by the config rule this file already
  // tests, and that split is exactly ci-wait's own template.
  const dir = project(ciOnly({
    actionable_count: 1,
    actionable: { ...EMPTY_ACTIONABLE, execute: ['T-01-05'] },
    capacity: { max: 0, in_flight: 0, free: 0 },
  }), stateWith(), '{ "pipeline": ');
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS', bucket: 'pass' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0);
  assert.equal(json.settled, 'T-01-01');
});

test('room in the cap still refuses — the guard is not gone', () => {
  // The control, and the direction that matters: this script's whole value is
  // WHEN IT REFUSES, so the capacity read must narrow that refusal by exactly
  // one case and not switch it off.
  const { code, json } = asJson(ciOnly({
    actionable_count: 2,
    actionable: { ...EMPTY_ACTIONABLE, execute: ['T-01-05'], merge: ['T-01-06'] },
    capacity: { max: 4, in_flight: 2, free: 2 },
  }), stateWith());
  assert.equal(code, 3, 'two agents may still be dispatched, so the run owes work');
  assert.ok(/execute: T-01-05/.test(json.refusal) && /merge: T-01-06/.test(json.refusal), json.refusal);
});

test('a board written before capacity existed refuses exactly as it did', () => {
  // `delivery-front.json` outlives an upgrade. An absent field must read as "no
  // cap is in force", never as a full board — the second would turn every old
  // board into a legitimate wait.
  const { code, json } = asJson(ciOnly({
    actionable_count: 1, actionable: { ...EMPTY_ACTIONABLE, execute: ['T-01-05'] },
  }), stateWith());
  assert.equal(code, 3);
  assert.ok(/execute: T-01-05/.test(json.refusal), json.refusal);
});

done();
