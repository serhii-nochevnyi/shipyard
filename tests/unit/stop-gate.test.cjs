'use strict';

// The stop gate is the only shipyard component whose failure mode is BOTH ways
// round, so both directions are tested here:
//
//   too permissive → the defect it exists for (a run ends with the front full,
//     which deliver.md forbids in prose and could not enforce);
//   too aggressive → a session that cannot be ended, in a project that never
//     asked for a conveyor, or over work nobody intends to take.
//
// The second is the worse of the two — a guard that traps you gets uninstalled,
// after which it enforces nothing at all. Hence five separate escape hatches,
// one test each.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'stop-gate.cjs'
);

const fresh = () => new Date().toISOString();
const agesAgo = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

// A front with two live items — the shape that MUST be refused.
const live = (over = {}) => ({
  generated_at: fresh(),
  actionable_count: 2,
  left_behind_count: 0,
  actionable: { execute: ['T-01-03'], fix: ['T-01-02'], publish: [], finalize: [], merge: [] },
  ...over,
});

// project(front) — a scratch cwd; front === null means "no conveyor here".
function project(front) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stopgate-'));
  if (front !== null) {
    fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'graph', 'delivery-front.json'),
      typeof front === 'string' ? front : JSON.stringify(front)
    );
  }
  return dir;
}

// run(front, payload) → the parsed hook verdict, or null when it stayed silent.
function run(front, payload = {}, env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd: project(front), input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

suite('stop-gate — refuses the stop while the front has live work');

test('a non-empty fresh front blocks the stop', () => {
  const v = run(live());
  assert.equal(v.decision, 'block', 'a live front must block');
  assert.ok(/2 item\(s\) are actionable/.test(v.reason), 'the reason names the count');
});

test('the reason names the actual tickets, not just a number', () => {
  const { reason } = run(live());
  assert.ok(reason.includes('T-01-03'), 'names the executable ticket');
  assert.ok(reason.includes('T-01-02'), 'names the fixable ticket');
  assert.ok(reason.includes('execute:') && reason.includes('fix:'), 'names the buckets');
});

test('the reason points at the loop-back, not just "you have work"', () => {
  // A refusal that does not say what to do next reads as an obstacle and gets
  // worked around — the run summarises anyway, one message later.
  const { reason } = run(live());
  assert.ok(/state-sync/.test(reason), 'names the resync step');
  assert.ok(/fixpoint: YES/.test(reason), 'names the only legitimate stop');
  assert.ok(/drift-record\.cjs mark/.test(reason), 'names the way OUT for work not to be taken');
});

suite('stop-gate — the escape hatches');

test('stop_hook_active is honoured, so a refusal cannot become a loop', () => {
  assert.equal(run(live(), { stop_hook_active: true }), null,
    'a second stop must pass — the run has already been told once');
});

test('a project with no delivery front is not a conveyor project', () => {
  assert.equal(run(null), null, 'the gate is global; it must be silent everywhere else');
});

test('a front older than the resync ceiling never traps a session', () => {
  // The original rule — and still the right one for the case it was written for:
  // a board from a run that ENDED. `agesAgo()` is six hours, past RESYNC_MS.
  assert.equal(run(live({ generated_at: agesAgo() })), null,
    'a front from a run that ended hours ago describes nothing current');
  // ...and both windows are tunable, so a project with a slower round can widen them.
  assert.equal(
    run(live({ generated_at: new Date(Date.now() - 90 * 1000).toISOString() }),
        {}, { SHIPYARD_STOP_GATE_FRESH_MS: '60000', SHIPYARD_STOP_GATE_RESYNC_MS: '60000' }),
    null, 'SHIPYARD_STOP_GATE_RESYNC_MS moves the ceiling');
});

test('SHIPYARD_STOP_GATE=off silences the hook in one word', () => {
  // An operator who wants the gate quiet should say so, rather than discovering
  // that shrinking a freshness window happens to have that effect.
  assert.equal(run(live(), {}, { SHIPYARD_STOP_GATE: 'off' }), null,
    'the off switch is unconditional');
});

test('a front of only left-behind work is a decision, not motion', () => {
  // front.cjs already says so in its own fixpoint text. Blocking here would
  // demand the run take tickets whose phase has shipped without them.
  assert.equal(run(live({ actionable_count: 2, left_behind_count: 2 })), null,
    'all-left-behind must pass');
  assert.equal(run(live({ actionable_count: 2, left_behind_count: 1 })).decision, 'block',
    'but ONE live item among them still blocks');
});

test('waiting on CI is not a reason to block', () => {
  // The conveyor is explicitly allowed to wait; front.cjs keeps ci out of
  // actionable_count, so an empty count is the whole test.
  assert.equal(run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0,
    actionable: {}, waiting: { ci: ['T-01-01'], merge_human: ['T-01-04'] },
  }), null, 'nothing actionable → the run may stop and wait');
});

suite('stop-gate — degrades quietly');

test('an unreadable front does not trap the session', () => {
  assert.equal(run('{not json'), null, 'a corrupt front is a bug elsewhere, not a trap here');
  // JSON.parse("null") succeeds — reading .generated_at off it would throw, and
  // an uncaught throw breaks "it always exits 0".
  assert.equal(run('null'), null, 'a null front is as unreadable as a corrupt one');
});

test('garbage in SHIPYARD_STOP_GATE_FRESH_MS does not disable the staleness hatch', () => {
  // Number('an hour') is NaN, and `age > NaN` is false — so a garbage value used
  // to make EVERY front read as fresh, quietly re-arming the trap the window
  // exists to prevent. It must fall back to the default instead.
  assert.equal(
    run(live({ generated_at: agesAgo() }), {}, { SHIPYARD_STOP_GATE_FRESH_MS: 'an hour' }),
    null, 'a six-hour-old front stays stale under a garbage env var');
});

test('no stdin payload at all is survivable', () => {
  const r = spawnSync('node', [SCRIPT], { cwd: project(live()), input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, 'must not crash without a payload');
  assert.equal(JSON.parse(r.stdout).decision, 'block', 'and still enforces');
});

suite('stop-gate — it reads the board the conveyor is driving');

// Measured on 2026-08-30: the hook's cwd is the SESSION's cwd, and the main loop
// `cd`s into a phase worktree inside every Bash call, so the session never leaves
// the checkout it was opened in. In the proving ground that checkout was a
// different branch carrying its own tracked `.planning/graph/` from a phase that
// had already shipped — `fixpoint: true, actionable_count: 0`. The gate ran on
// twelve stops that day and blocked none, reading an affirmative all-clear off
// the wrong board while the live front two directories away said `finalize: 4`.
// One of those stops cost 5h46m of silence.

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

// A repo whose MAIN checkout carries a shipped board, plus a linked worktree
// carrying the live one — the exact shape of the failure.
function repoWithPhaseWorktree(mainFront, phaseFront) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stopgate-repo-'));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(main, 'README'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  const writeFront = (dir, front) => {
    fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-front.json'),
      JSON.stringify(front));
  };
  writeFront(main, mainFront);
  const phase = path.join(root, 'phase');
  git(main, 'worktree', 'add', '-q', '-b', 'phase/1', phase);
  writeFront(phase, phaseFront);
  return { main, phase };
}

function runIn(cwd, payload = {}, env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

// The shipped board the session's own checkout was carrying, verbatim in shape.
const shipped = {
  generated_at: agesAgo(), actionable_count: 0, left_behind_count: 0,
  actionable: { execute: [], publish: [], fix: [], finalize: [], merge: [] },
  fixpoint: true,
};

test('a stale all-clear in the session cwd does not answer for a live sibling worktree', () => {
  const { main } = repoWithPhaseWorktree(shipped, live({
    actionable_count: 4, left_behind_count: 0,
    actionable: { execute: [], publish: [], fix: [], finalize: ['T-21-01', 'T-21-02', 'T-21-03', 'T-21-04'], merge: [] },
  }));
  const v = runIn(main);
  assert.ok(v && v.decision === 'block', 'the newest board decides, not the nearest one');
  assert.ok(v.reason.includes('T-21-01'), 'and the refusal names what that board actually holds');
  // Told only to "run state-sync", a session parked in the wrong checkout runs it
  // THERE — regenerating that branch's shipped board as `fixpoint: true` with a
  // brand-new timestamp, which then wins selection and silences the gate. Advice
  // that reconstructs the defect is worse than none.
  assert.ok(v.reason.includes(path.join('phase', '.planning', 'graph')),
    'the refusal names the directory the deciding board lives in');
  assert.ok(v.reason.includes('NOT your cwd'), 'and says plainly that the cwd is not it');
});

test('a verdict off the cwd\'s own board does not send anyone elsewhere', () => {
  // The pointer is only meaningful when the board came from somewhere else;
  // repeating the cwd back at a run standing in it is noise.
  const { reason } = run(live());
  assert.ok(!/NOT your cwd/.test(reason), 'no redirection when there is nowhere to redirect to');
});

test('the newest board wins even when the nearest one is the live-looking fake', () => {
  // Reversed: the session cwd holds a FRESH but empty board and the worktree an
  // old busy one. Freshness must decide, or the fix trades one wrong board for
  // another.
  const { main } = repoWithPhaseWorktree(
    { generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {}, fixpoint: true },
    live({ generated_at: agesAgo() }));
  assert.equal(runIn(main), null, 'the freshest sync is the one describing now');
});

test('selection ignores dispatch marks, which touch the file without resyncing', () => {
  // `dispatch-record.cjs` rewrites delivery-front.json on every mark and stamps
  // `dispatches_applied_at`. Counting that as freshness would let a loop that
  // dispatches busily but never re-derives look permanently current — which is
  // precisely the stale-board case this hook now has to catch.
  const { main } = repoWithPhaseWorktree(
    { ...shipped, generated_at: fresh() },
    live({ generated_at: agesAgo(), dispatches_applied_at: fresh() }));
  assert.equal(runIn(main), null, 'a dispatch mark is not a sync');
});

test('a cwd outside any git repo still reads its own front', () => {
  // `git worktree list` fails there, and the pre-existing behaviour must survive.
  assert.equal(run(live()).decision, 'block', 'the cwd candidate always counts');
});

suite('stop-gate — a board the loop forgot to resync');

// The 12:30 stop. The loop had dispatched four executors off the 11:33 board and
// never re-derived it; by 12:30 all four PRs were open but the front still said
// `execute: 4`. Under one rule for all staleness the gate went silent at the exact
// moment its answer mattered, and the run ended. 5h46m, broken by the operator.
const stale = (mins, over = {}) => live({
  generated_at: new Date(Date.now() - mins * 60 * 1000).toISOString(), ...over,
});

test('a board stale with live work blocks and asks for the resync', () => {
  const v = run(stale(57));
  assert.ok(v && v.decision === 'block', '57 minutes past a sync is not a reason to go quiet');
  assert.ok(/57 minutes old/.test(v.reason), 'the refusal states the age, so the remedy is obvious');
  assert.ok(/state-sync/.test(v.reason), 'and names the one command that settles it');
});

test('the stale refusal does not assert the old board as fact', () => {
  // The 11:33 board said `execute: T-21-01..04` for four tickets whose PRs were
  // already open. Repeating that list would hand the run four wrong instructions
  // in the name of correcting it.
  const { reason } = run(stale(57));
  assert.ok(!reason.includes('T-01-03'), 'a stale board names no tickets');
  assert.ok(/4 actionable|2 actionable|actionable,/.test(reason), 'only the shape, as a count');
});

test('a stale board with nothing live stays silent', () => {
  // Waiting on CI, everything merged, a phase that shipped — all reach `stop and
  // wait` legitimately, and none of them is improved by a resync demand.
  assert.equal(run(stale(57, { actionable_count: 0, left_behind_count: 0, actionable: {} })), null,
    'nothing to take → nothing to say');
  assert.equal(run(stale(57, { actionable_count: 2, left_behind_count: 2 })), null,
    'all-left-behind is a decision at any age');
});

test('a dispatch outliving its run is live work on a stale board', () => {
  // dispatch-record.cjs expires a mark when the ticket's state moves or after its
  // TTL — but only when something recomputes the front. On a board this old
  // nothing has, so a `dispatched` entry is evidence the loop left mid-flight:
  // the silent-stall shape that store exists to prevent.
  const v = run(stale(57, {
    actionable_count: 0, left_behind_count: 0, actionable: {},
    waiting: { ci: [], dispatched: ['T-21-03'], merge_human: [], human: [] },
  }));
  assert.ok(v && v.decision === 'block', 'a dispatch nobody cleared is not a fixpoint');
  assert.ok(/1 dispatched/.test(v.reason), 'and the refusal says so');
});

test('the stale refusal is capped at one per turn like every other block', () => {
  assert.equal(run(stale(57), { stop_hook_active: true }), null,
    'the anti-loop hatch covers this band too');
});

done();
