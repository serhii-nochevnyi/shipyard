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

function project(front, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ciwait-'));
  const g = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(g, { recursive: true });
  if (front !== null) fs.writeFileSync(path.join(g, 'delivery-front.json'), JSON.stringify(front));
  if (state !== null) fs.writeFileSync(path.join(g, 'delivery-state.json'), JSON.stringify(state));
  return dir;
}

// A stub gh answering exactly the one call ci-wait makes. `rows` is the JSON it
// returns for `pr checks`; `exit` mimics gh's habit of reporting CI state through
// the EXIT CODE (8 = pending) while still printing JSON.
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
  const env = { ...process.env };
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
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS' }]);
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

suite('ci-wait — the wait itself');

test('it returns the moment a PR settles, green', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'SUCCESS' }, { name: 'Lint', state: 'SUCCESS' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a settled PR ends the wait');
  assert.equal(json.waited, true, 'and reports that it waited');
  assert.equal(json.settled, 'T-01-01', 'naming which ticket moved');
  assert.equal(json.pr, 101, 'and its PR');
  assert.deepEqual(json.checks, { total: 2, pending: 0, failing: 0 }, 'with the tally the caller needs');
});

test('RED counts as settled — a waiter must not hold a run hostage to a failure', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'FAILURE' }, { name: 'Lint', state: 'SUCCESS' }]);
  const { code, json } = asJson(null, null, ['--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'the answer exists; whether it is good news is the caller\'s business');
  assert.equal(json.settled, 'T-01-01', 'it settled');
  assert.equal(json.checks.failing, 1, 'and the failure is reported, not hidden');
});

test("gh's non-zero exit on a pending pipeline is DATA, not an error", () => {
  // `gh pr checks` reports CI state through its exit code (8 = pending) while
  // still printing JSON. Treating that as a broken command makes a pending
  // pipeline indistinguishable from a missing gh — state-sync.cjs carries the
  // same note for the same reason.
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'IN_PROGRESS' }], 8);
  const { code, json } = asJson(null, null, ['--timeout', '2', '--interval', '1'], { dir, bin });
  assert.equal(code, 0, 'a timeout is still a legitimate return');
  assert.equal(json.timed_out, true, 'it waited rather than erroring out');
  assert.equal(json.settled, null, 'and nothing settled');
  assert.ok(!/unhandled/.test(JSON.stringify(json)), 'the stub was never asked anything else');
});

test('a timeout returns 0 and tells the caller to re-sync anyway', () => {
  const dir = project(ciOnly(), stateWith());
  const bin = stubGh(dir, [{ name: 'Tests', state: 'PENDING' }]);
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

done();
