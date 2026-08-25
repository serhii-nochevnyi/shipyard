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

const seed = (graph, events) =>
  fs.writeFileSync(
    path.join(graph, 'delivery-log.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );

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
  assert.ok(/^[0-9a-f]{16}$/.test(got.signature), 'still a usable signature');
});

test('an empty log is not an error either', () => {
  const got = compute('');
  assert.equal(got.error_class, 'unknown');
  assert.ok(/^[0-9a-f]{16}$/.test(got.signature));
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
  assert.equal(verdict(project, ['--signature', 'bbbb', '--head', 'h1']).verdict, 'progress',
    'another signature on the same ticket is not quarantined');
});

test('`lift` ends the quarantine', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  run(['rerun', 'T-20-01', '--signature', 'aaaa', '--head', 'h1', '--outcome', 'green'], { cwd: project, encoding: 'utf8' });
  const l = run(['lift', 'T-20-01', '--signature', 'aaaa'], { cwd: project, encoding: 'utf8' });
  assert.equal(l.status, 0, `lift must succeed (${l.stderr})`);
  assert.equal(verdict(project, ['--signature', 'aaaa', '--head', 'h2']).verdict, 'repeat',
    'the signature is deterministic again, not quarantined');
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
  assert.deepEqual(Object.keys(got).sort(), ['distinct', 'head', 'k', 'seen', 'signature', 'verdict']);
  assert.equal(got.signature, 'aaaa');
  assert.equal(got.head, 'h4');
  assert.equal(got.seen, 2, 'seen = how many prior attempts carried THIS signature');
  assert.equal(got.distinct, 2);
});

test('the bare form prints the verdict word alone', () => {
  const { project, graph } = scratch();
  seed(graph, [attempt('aaaa', 'h1')]);
  const r = run(['verdict', 'T-20-01', '--signature', 'aaaa', '--head', 'h2'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'repeat');
});

test('the enum is exactly the six pinned words', () => {
  // T-20-02 and T-20-06 switch on these literals; a seventh word, or a synonym,
  // is a silent no-op in the policy that reads them.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = /const VERDICTS = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'the enum is declared once, as VERDICTS');
  const words = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(words, ['first', 'progress', 'repeat', 'flake_candidate', 'flake', 'plan_defect']);
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
  // (Spawned through bash rather than from an async test body: this harness's
  // `test()` is synchronous and `done()` exits the process, so an awaited body
  // would be marked green before its assertions ever ran.)
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
