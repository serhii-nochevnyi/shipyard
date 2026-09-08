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
// The gate reads `left_behind_count` off the board and acts on it; the board is
// front.cjs's. Most tests here hand-write a front, which is right for testing the
// gate's own arithmetic and wrong for the one question below — whether the hatch
// opens over a phase that is merely NUMBERED lower than one that landed. That
// answer is a collaboration, so the fixture is the real computed front.
const { computeFront, epicKey } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));
const epicOf = (phase, over = {}) => ({
  phase: String(phase), repo: null, branch: `epic/${phase}-x`, base: 'main',
  exists: true, ahead: 0, pr: null, landed: true, landed_reason: 'whole diff is in', ...over,
});
const epics = (...records) => Object.fromEntries(records.map((r) => [epicKey(r.phase, r.repo), r]));
const boardOf = (tickets, state, epicRecords) => ({
  generated_at: fresh(),
  ...computeFront(tickets, state, { epics: epics(...epicRecords) }),
});

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

// project(front, journal) — a scratch cwd; front === null means "no conveyor
// here". `journal` is an array of events written to delivery-log.jsonl beside it.
function project(front, journal = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stopgate-'));
  if (front !== null) {
    fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'graph', 'delivery-front.json'),
      typeof front === 'string' ? front : JSON.stringify(front)
    );
  }
  if (journal) {
    fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-log.jsonl'),
      journal.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}

// run(front, payload) → the parsed hook verdict, or null when it stayed silent.
function run(front, payload = {}, env = {}, journal = null) {
  const r = spawnSync('node', [SCRIPT], {
    cwd: project(front, journal), input: JSON.stringify(payload), encoding: 'utf8',
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

test('waiting on CI is a reason to WAIT, and that is not the same as stopping', () => {
  // This assertion is the inverse of the one it replaces, and the reversal was
  // measured rather than reasoned. "Nothing actionable → the run may stop and
  // wait" folded two states into one: a finished run, and a run with PRs in CI.
  // The second is where the conveyor bled — the babysit loop wakes on agents
  // finishing, so with no agent out and only CI pending nothing ever wakes the
  // session. 5h46m once, 11h43m the next night, the second time with the next PR
  // green, conform and ready to land.
  const v = run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0,
    actionable: {}, waiting: { ci: ['T-01-01'], dispatched: [], merge_human: ['T-01-04'] },
  });
  assert.ok(v && v.decision === 'block', 'a wait the run cannot return from is not a fixpoint');
  assert.ok(/ci-wait\.cjs/.test(v.reason), 'and the refusal names the script that waits');
  assert.ok(/T-01-01/.test(v.reason), 'and which PR it is waiting on');
});

test('a ticket with an agent silences the CI branch — that wake-up is free', () => {
  assert.equal(run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {},
    waiting: { ci: ['T-01-01'], dispatched: ['T-01-02'], merge_human: [], human: [] },
  }), null, 'an agent completion comes sooner and costs nothing');
});

test('a genuine fixpoint is still a fixpoint', () => {
  // The whole branch must not cost the one thing the gate has to get right:
  // letting a finished run finish.
  assert.equal(run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {},
    waiting: { ci: [], dispatched: [], merge_human: [], human: [] }, fixpoint: true,
  }), null, 'nothing actionable and nothing waiting → stop');
});

test('all-left-behind work with a PR in CI still blocks on the wait', () => {
  // Left-behind work is "a decision, not motion", so it does not make the board
  // actionable — but a PR genuinely in CI is still a wait nobody will return from.
  const v = run({
    generated_at: fresh(), actionable_count: 2, left_behind_count: 2,
    actionable: { execute: ['T-00-01', 'T-00-02'] },
    waiting: { ci: ['T-01-01'], dispatched: [], merge_human: [], human: [] },
  });
  assert.ok(v && v.decision === 'block', 'the wait outlives the left-behind decision');
  assert.ok(/ci-wait\.cjs/.test(v.reason), 'and it is the wait being named, not the left-behind work');
});

test('the CI refusal names the cascade cost and its own termination', () => {
  // Two things the run gets wrong without being told: that one merge ends a
  // stack, and that an unattended wait could spin forever. It cannot — three
  // empty windows and ci-wait.cjs escalates, which parks the ticket and empties
  // this bucket through the rule the gate already had.
  const { reason } = run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {},
    waiting: { ci: ['T-01-01'], dispatched: [], merge_human: [], human: [] },
  });
  assert.ok(/PER TICKET/.test(reason), 'a cascade costs one round per ticket');
  assert.ok(/escalates by\n *itself/.test(reason) || /escalates by/.test(reason),
    'and the refusal says how it ends, so it does not read as a trap');
});

test('the CI refusal is capped at one per turn', () => {
  assert.equal(run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {},
    waiting: { ci: ['T-01-01'], dispatched: [], merge_human: [], human: [] },
  }, { stop_hook_active: true }), null, 'the anti-loop hatch covers this branch too');
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

suite('stop-gate — the journal is the evidence, the clock is only a guess');

// Measured 2026-08-31, the morning after the fix above shipped. The session
// resumed from an 11h43m silence, merged a PR, resolved the cascade conflict it
// created, pushed — and never synced. The board was then 13 hours old: PAST the
// resync ceiling, so the gate went silent on all three of that morning's stops
// while the phase sat 1/4 merged with one PR ready and nobody driving it.
//
// A board's age is a fact about the last SYNC and says nothing about whether the
// RUN is over. `delivery-log.jsonl` answers the actual question, and `merge` /
// `status_change` are owned by sentinel.cjs / state-sync.cjs alone.

const ev = (over) => ({ ts: new Date().toISOString(), ...over });
const ancient = () => ({ generated_at: agesAgo(), actionable_count: 0, left_behind_count: 0,
  actionable: {}, fixpoint: true });

test('a merge after the board was computed blocks, however old the board is', () => {
  // The exact shape of the 2026-08-31 stops: an ancient board that says
  // `fixpoint: true`, and a merge the board has never heard of.
  const v = run(ancient(), {}, {}, [ev({ event: 'merge', ticket: 'T-21-01', pr: 645 })]);
  assert.ok(v && v.decision === 'block', 'age must not be able to silence proof');
  assert.ok(/T-21-01 was MERGED \(PR #645\)/.test(v.reason), 'the refusal names the event');
  assert.ok(/provably behind reality/.test(v.reason), 'and says why it is not a judgement call');
  assert.ok(/one round per ticket/.test(v.reason),
    'and names the cascade, which is why one merge is not the end');
});

test('a push after the board was computed blocks too', () => {
  const v = run(ancient(), {}, {},
    [ev({ event: 'attempt', ticket: 'T-21-03', pr: 647, outcome: 'pushed' })]);
  assert.ok(v && v.decision === 'block', 'a push re-runs checks the board still reports');
  assert.ok(/a push on T-21-03/.test(v.reason), 'the refusal names it');
});

test('a status_change is not evidence — state-sync writes it', () => {
  // log-event.cjs refuses `status_change` by hand precisely because state-sync
  // owns it, so it is contemporaneous with the front by construction. Counting
  // it would make EVERY board look behind itself the instant it was computed.
  assert.equal(run(ancient(), {}, {}, [ev({ event: 'status_change', ticket: 'T-21-01', to: 'pr-open' })]),
    null, 'the sync\'s own bookkeeping is not a reason to re-sync');
});

test('a dispatch is not evidence — dispatch-record already overlays it', () => {
  // This is the false block that fired five times across phases 20 and 22, on 3,
  // 5, 6, 4 and 5 items, every one verified in flight. A gate that reproduces it
  // gets uninstalled, after which it enforces nothing.
  assert.equal(run(ancient(), {}, {}, [ev({ event: 'dispatch', ticket: 'T-21-01', role: 'executor' })]),
    null, 'dispatching is not a state the board is missing');
});

test('an event OLDER than the board is not evidence', () => {
  const old = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  assert.equal(run(ancient(), {}, {}, [{ ts: old, event: 'merge', ticket: 'T-20-01', pr: 600 }]),
    null, 'the board already knows about it — that is what generated_at means');
});

test('no journal, or an unreadable one, is no evidence rather than a block', () => {
  assert.equal(run(ancient()), null, 'a project with no journal is unchanged');
  assert.equal(run(ancient(), {}, {}, ['{not json']), null, 'a corrupt line is skipped, not fatal');
});

test('the evidence branch is capped at one block per turn', () => {
  assert.equal(run(ancient(), { stop_hook_active: true }, {},
    [ev({ event: 'merge', ticket: 'T-21-01', pr: 645 })]),
    null, 'the anti-loop hatch covers this branch too');
});

test('SHIPYARD_STOP_GATE=off silences the evidence branch as well', () => {
  assert.equal(run(ancient(), {}, { SHIPYARD_STOP_GATE: 'off' },
    [ev({ event: 'merge', ticket: 'T-21-01', pr: 645 })]),
    null, 'the off switch stays unconditional');
});

test('only the journal TAIL is read, so a long-lived project stays fast', () => {
  // 584 status_changes in the proving ground already, and a hook has ~75ms. The
  // newest events are at the end, which is the only end that matters — but a
  // seek into the middle of a file lands mid-line, and that fragment must not be
  // parsed as an event.
  const filler = Array.from({ length: 4000 }, (_, i) => ({
    ts: new Date(Date.now() - (5000 - i) * 1000).toISOString(),
    event: 'status_change', ticket: `T-99-${i}`, to: 'merged', pad: 'x'.repeat(80),
  }));
  const v = run(ancient(), {}, {}, [...filler, ev({ event: 'merge', ticket: 'T-21-04', pr: 648 })]);
  assert.ok(v && v.decision === 'block', 'the newest event is found past a large journal');
  assert.ok(/T-21-04 was MERGED/.test(v.reason), 'and it is the right one');
});

suite('stop-gate — one block per ROUND, not one per turn');

// `stop_hook_active` caps the gate at one block per TURN. A stacked cascade needs
// one round per TICKET — merge, the next child goes BEHIND, base-merge, push, CI,
// merge — and the loop legitimately tries to end the turn after each dispatch. So
// the gate blocked once, the loop resumed, dispatched, tried to stop again, and
// that stop went through with three tickets still to land. The hatch was written
// to bound the cost of a FALSE block; it must not also bound the number of TRUE
// ones. A per-session ledger beside the front makes the distinction mechanical:
// re-block when the BOARD ADVANCED since the last block, under a hard cap.

const graphOf = (dir) => path.join(dir, '.planning', 'graph');
const ledgerFile = (dir) => path.join(graphOf(dir), 'stop-gate-ledger.json');
const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

function putFront(dir, front) {
  fs.mkdirSync(graphOf(dir), { recursive: true });
  fs.writeFileSync(path.join(graphOf(dir), 'delivery-front.json'), JSON.stringify(front));
}

function putJournal(dir, events) {
  fs.mkdirSync(graphOf(dir), { recursive: true });
  fs.writeFileSync(path.join(graphOf(dir), 'delivery-log.jsonl'),
    events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
}

function putDispatches(dir, tickets) {
  fs.mkdirSync(graphOf(dir), { recursive: true });
  fs.writeFileSync(path.join(graphOf(dir), 'dispatches.json'),
    JSON.stringify({ tickets }, null, 2) + '\n');
}

function ledgerOf(dir) {
  try { return JSON.parse(fs.readFileSync(ledgerFile(dir), 'utf8')); } catch { return null; }
}

// Like runIn, but the whole result — the ledger's failure line and the cap notice
// go to STDERR, because a non-JSON line on stdout is not a hook verdict.
function runFull(cwd, payload = {}, env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return { verdict: out ? JSON.parse(out) : null, stderr: r.stderr || '' };
}

test('a board that ADVANCED re-blocks inside the same turn', () => {
  // The measured sequence, and the whole point of the ledger: the second stop is
  // the same board (allow, unchanged), the third is a board that MOVED — a merge
  // landed and a resync ran — and today that one goes through.
  const dir = project(live({ generated_at: minsAgo(2) }));
  const S = { session_id: 'sess-round' };

  const first = runIn(dir, S);
  assert.ok(first && first.decision === 'block', 'the first stop blocks as it always did');
  assert.equal(ledgerOf(dir).blocks, 1, 'and the block is recorded against the session');

  assert.equal(runIn(dir, { ...S, stop_hook_active: true }), null,
    'the same board twice is a loop, and the anti-loop rule still holds');

  putFront(dir, live({
    generated_at: fresh(), actionable_count: 1, left_behind_count: 0,
    actionable: { execute: [], publish: [], fix: [], finalize: ['T-01-09'], merge: [] },
  }));
  const third = runIn(dir, { ...S, stop_hook_active: true });
  assert.ok(third && third.decision === 'block',
    'a board that advanced is a new round, and the cascade needs one block per round');
  assert.ok(/T-01-09/.test(third.reason), 'and the refusal names what the NEW board holds');
  assert.equal(ledgerOf(dir).blocks, 2, 'the ledger counts rounds, not turns');
});

test('a journal event newer than the last block is advancement too', () => {
  // The board need not be resynced for the world to move: a merge lands, the
  // journal records it, and the next stop is a new round even against the same
  // `generated_at`.
  const dir = project(live({ generated_at: minsAgo(5) }));
  const S = { session_id: 'sess-journal' };
  assert.ok(runIn(dir, S).decision === 'block', 'the first stop blocks');
  assert.equal(runIn(dir, { ...S, stop_hook_active: true }), null, 'nothing moved yet');

  putJournal(dir, [ev({ event: 'merge', ticket: 'T-01-02', pr: 7 })]);
  const after = runIn(dir, { ...S, stop_hook_active: true });
  assert.ok(after && after.decision === 'block', 'a merge the board has not seen is a new round');
  assert.ok(/was MERGED/.test(after.reason), 'and the evidence branch is the one that says so');

  assert.equal(runIn(dir, { ...S, stop_hook_active: true }), null,
    'the SAME event is not a second round — advancement is measured, not re-counted');
});

test('twelve advancing rounds block; the thirteenth allows and says why', () => {
  // A cascade deeper than this is a phase nobody should be running in one turn,
  // and a gate with no ceiling at all is a gate that can trap a session.
  const dir = project(live());
  const S = { session_id: 'sess-cap' };
  for (let i = 0; i < 12; i++) {
    putFront(dir, live({ generated_at: new Date(Date.now() - (13 - i) * 1000).toISOString() }));
    const v = runIn(dir, { ...S, stop_hook_active: i > 0 });
    assert.ok(v && v.decision === 'block', `round ${i + 1} of a live cascade must still block`);
  }
  assert.equal(ledgerOf(dir).blocks, 12, 'twelve rounds, twelve blocks');

  putFront(dir, live({ generated_at: fresh() }));
  const past = runFull(dir, { ...S, stop_hook_active: true });
  assert.equal(past.verdict, null, 'past the cap the gate gets out of the way');
  assert.ok(/SHIPYARD_STOP_GATE_MAX_BLOCKS/.test(past.stderr),
    'and says which knob decided, so the operator is not guessing');
  assert.equal(ledgerOf(dir).blocks, 12, 'the cap does not keep counting');
});

test('the cap is tunable, and garbage in it falls back to the default', () => {
  const dir = project(live({ generated_at: minsAgo(3) }));
  const S = { session_id: 'sess-cap-2' };
  assert.ok(runIn(dir, S, { SHIPYARD_STOP_GATE_MAX_BLOCKS: '1' }).decision === 'block',
    'the first block is under any cap of 1 or more');
  putFront(dir, live({ generated_at: fresh() }));
  assert.equal(runIn(dir, { ...S, stop_hook_active: true }, { SHIPYARD_STOP_GATE_MAX_BLOCKS: '1' }), null,
    'a cap of one means one');
  // Garbage must not disable the ROUNDS, which is the direction that ends runs.
  assert.ok(runIn(dir, { ...S, stop_hook_active: true }, { SHIPYARD_STOP_GATE_MAX_BLOCKS: 'lots' })
    .decision === 'block', 'a garbage cap falls back to 12, not to zero');
});

test('a payload with no session_id keeps the old one-block rule', () => {
  // The ledger is keyed by the session the hook was called for. Without one
  // there is nothing to count rounds against, and inventing a key would make
  // every stop in the repository look like the same run.
  const dir = project(live({ generated_at: minsAgo(2) }));
  assert.ok(runIn(dir, {}).decision === 'block', 'a first stop still blocks');
  assert.equal(ledgerOf(dir), null, 'and no ledger is written for a payload that cannot own one');
  putFront(dir, live({ generated_at: fresh() }));
  assert.equal(runIn(dir, { stop_hook_active: true }), null,
    'so the anti-loop hatch stays exactly as permissive as it was');
});

test('a ledger this session does not own neither silences nor traps it', () => {
  const dir = project(live());
  fs.writeFileSync(ledgerFile(dir), JSON.stringify({
    session_id: 'someone-else', blocks: 99, last_generated_at: fresh(), last_moved_at: null,
  }));
  const v = runIn(dir, { session_id: 'mine' });
  assert.ok(v && v.decision === 'block', 'another run\'s cap is not this run\'s');
  const led = ledgerOf(dir);
  assert.equal(led.session_id, 'mine', 'the ledger belongs to the session that is stopping');
  assert.equal(led.blocks, 1, 'counting starts from this session\'s first block');
});

test('an unwritable ledger changes nothing but a line on stderr', () => {
  // ci-wait.cjs's rule for the same class of bookkeeping: a store left as a
  // DIRECTORY by some accident (measured) must not take the decision down with
  // it. The gate always exits 0 and the verdict stands.
  const dir = project(live());
  fs.mkdirSync(ledgerFile(dir), { recursive: true });
  const r = runFull(dir, { session_id: 'sess-ro' });
  assert.ok(r.verdict && r.verdict.decision === 'block', 'the refusal is unaffected');
  assert.ok(/ledger/.test(r.stderr), 'and one line says the bookkeeping did not happen');
});

test('a read-only graph directory is survivable', () => {
  const dir = project(live());
  fs.chmodSync(graphOf(dir), 0o555);
  try {
    const r = runFull(dir, { session_id: 'sess-ro-2' });
    assert.ok(r.verdict && r.verdict.decision === 'block', 'the decision never depends on the write');
  } finally { fs.chmodSync(graphOf(dir), 0o755); }
});

test('a corrupt ledger is a ledger this session does not own', () => {
  const dir = project(live());
  fs.writeFileSync(ledgerFile(dir), '{not json');
  assert.equal(runIn(dir, { session_id: 'sess-corrupt', stop_hook_active: true }), null,
    'with no provable advancement, a stop already blocked once goes through');
  assert.ok(runIn(dir, { session_id: 'sess-corrupt' }).decision === 'block', 'and a first stop blocks');
  assert.equal(ledgerOf(dir).blocks, 1, 'the corrupt file is replaced by a real record');
});

suite('stop-gate — a journal event from a run that ENDED is not evidence');

// `movedSince` counted an event of ANY age. A run that ended on a sentinel merge
// leaves such an event in the journal forever, and this hook is GLOBAL — so the
// first stop of every later session in that repository was blocked with "the
// board is behind reality" over a merge from days ago. Bound the event by the
// same ceiling the stale-board rule uses: older than that is a run that ended.

test('a five-hour-old merge against a six-hour-old board is a run that ended', () => {
  const fiveHours = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  assert.equal(
    run(ancient(), {}, {}, [{ ts: fiveHours, event: 'merge', ticket: 'T-21-01', pr: 645 }]),
    null, 'an event past the resync ceiling describes a run that is over');
  // The same event, minutes old, is the case the evidence branch was written for.
  const v = run(ancient(), {}, {}, [ev({ event: 'merge', ticket: 'T-21-01', pr: 645 })]);
  assert.ok(v && v.decision === 'block', 'a fresh merge on an ancient board still blocks');
});

test('the event bound follows SHIPYARD_STOP_GATE_RESYNC_MS, not a second number', () => {
  // One ceiling, one knob: a project with a slower cadence widens both at once.
  const fiveHours = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const v = run(ancient(), {}, { SHIPYARD_STOP_GATE_RESYNC_MS: String(8 * 60 * 60 * 1000) },
    [{ ts: fiveHours, event: 'merge', ticket: 'T-21-01', pr: 645 }]);
  assert.ok(v && v.decision === 'block', 'inside a widened ceiling the same event is evidence again');
});

suite('stop-gate — a dispatch that outlived its launch is not an agent at work');

// The CI-only branch is opened by ANY `waiting.dispatched` entry, on the sound
// reasoning that an agent completion is a free wake-up. A mark written BEFORE a
// launch that never happened is not that: it is 90 minutes of silence with
// nothing coming. So the hatch now asks `dispatches.json` how old the mark is.

const ciOnly = (dispatched = []) => ({
  generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {},
  waiting: { ci: ['T-01-01'], dispatched, merge_human: [], human: [] },
});

test('a ten-minute-old dispatch still opens the CI hatch', () => {
  const dir = project(ciOnly(['T-01-02']));
  putDispatches(dir, { 'T-01-02': { role: 'executor', at: minsAgo(10) } });
  assert.equal(runIn(dir, { session_id: 'sess-disp' }), null,
    'an agent ten minutes into a fix round is exactly the free wake-up this hatch is for');
});

test('an hour-old dispatch does not, and the refusal names it', () => {
  const dir = project(ciOnly(['T-01-02']));
  putDispatches(dir, { 'T-01-02': { role: 'executor', at: minsAgo(60) } });
  const v = runIn(dir, { session_id: 'sess-disp' });
  assert.ok(v && v.decision === 'block', 'a mark this old is not evidence anyone is working');
  assert.ok(/T-01-02/.test(v.reason), 'the refusal names the ticket');
  assert.ok(/dispatch-record\.cjs clear/.test(v.reason), 'and how to return it to the board');
  assert.ok(/ci-wait\.cjs/.test(v.reason), 'while still naming the wait, which is the actual next move');
});

test('a dispatched ticket with no record keeps the hatch open', () => {
  // Unknown age is not proof the agent is gone, and the direction that traps a
  // session is the one this hook must never take. Positive evidence only.
  const dir = project(ciOnly(['T-01-02']));
  assert.equal(runIn(dir, { session_id: 'sess-disp-2' }), null, 'no store, no suspicion');
  putDispatches(dir, { 'T-01-02': { role: 'executor', at: 'not a date' } });
  assert.equal(runIn(dir, { session_id: 'sess-disp-3' }), null, 'an undateable mark is not an old one');
});

test('one live dispatch beside a suspect one still opens the hatch', () => {
  const dir = project(ciOnly(['T-01-02', 'T-01-03']));
  putDispatches(dir, {
    'T-01-02': { role: 'executor', at: minsAgo(60) },
    'T-01-03': { role: 'ci-fix', at: minsAgo(5) },
  });
  assert.equal(runIn(dir, { session_id: 'sess-disp-4' }), null,
    'one agent still out is one wake-up still coming');
});

test('the suspect window is tunable', () => {
  const dir = project(ciOnly(['T-01-02']));
  putDispatches(dir, { 'T-01-02': { role: 'executor', at: minsAgo(10) } });
  assert.ok(runIn(dir, { session_id: 'sess-disp-5' },
    { SHIPYARD_STOP_GATE_DISPATCH_SUSPECT_MS: '60000' }).decision === 'block',
    'a project with faster rounds can say so');
  assert.equal(runIn(dir, { session_id: 'sess-disp-6' },
    { SHIPYARD_STOP_GATE_DISPATCH_SUSPECT_MS: 'soon' }), null,
    'and garbage falls back to the default rather than suspecting everything');
});

test('the two new reads stay inside the hook budget', () => {
  // A hook has ~75ms. There was no timing assertion in this file before — the
  // journal-tail test measures the READ, not the clock — so this measures the
  // DELTA between a bare board and one with everything the gate now reads
  // beside it (a 4000-line journal, a ledger, a dispatch store). Node's own
  // startup dominates both and cancels out; min-of-3, because the minimum is
  // the stable statistic on a machine doing other things. It is a tripwire for
  // an O(size) regression, not a microbenchmark.
  const filler = Array.from({ length: 4000 }, (_, i) => ({
    ts: new Date(Date.now() - (5000 - i) * 1000).toISOString(),
    event: 'status_change', ticket: `T-99-${i}`, to: 'merged', pad: 'x'.repeat(80),
  }));
  const bare = project(live());
  const loaded = project(live({
    actionable_count: 2, left_behind_count: 0,
    waiting: { ci: [], dispatched: ['T-01-02'], merge_human: [], human: [] },
  }));
  putJournal(loaded, filler);
  putDispatches(loaded, { 'T-01-02': { role: 'executor', at: minsAgo(5) } });
  fs.writeFileSync(ledgerFile(loaded), JSON.stringify({
    session_id: 'sess-budget', blocks: 1, last_generated_at: minsAgo(30), last_moved_at: null,
  }));

  const timed = (dir) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const v = runIn(dir, { session_id: 'sess-budget' });
      best = Math.min(best, Date.now() - t);
      assert.ok(v && v.decision === 'block', 'both sides must take the same branch');
    }
    return best;
  };
  const a = timed(bare);
  const b = timed(loaded);
  console.log(`      bare ${a}ms, with journal+ledger+dispatches ${b}ms`);
  assert.ok(b - a < 400, `the extra reads cost ${b - a}ms, which is not "one small JSON read"`);
});

suite('stop-gate — the all-left-behind hatch, over a board built from evidence');

// The hatch is the gate's most dangerous exit: it exits 0 on a front that HAS
// actionable work. Measured on 2026-09-07 — three phase-26 tickets merged into
// their epic, and the board then called phase 24's live, high-risk,
// pre-authorized head "a phase already moved past" purely because 26 > 24. The
// gate's own arithmetic was right; what it read was wrong. So these two run the
// real front rather than a hand-written count.

test('a lower-numbered phase still in flight is live work, and the stop is refused', () => {
  const tickets = { 'T-24-05': { phase: '24' }, 'T-26-01': { phase: '26' } };
  const state = {
    'T-24-05': { status: 'pending', ready: true },
    'T-26-01': { status: 'merged' },
  };
  const board = boardOf(tickets, state, [
    epicOf(24, { ahead: 7, landed: false, pr: { number: 824, state: 'OPEN' } }),
    epicOf(26, { pr: { number: 926, state: 'MERGED' } }),
  ]);
  assert.strictEqual(board.left_behind_count, 0, 'the fixture must be the defect, not a hand-written count');
  const v = run(board);
  assert.ok(v && v.decision === 'block', 'phase 24 is the live work — this stop cost 5h46m once');
  assert.ok(/T-24-05/.test(v.reason), 'and the refusal names the ticket that was skipped');
});

test('a phase that really did land without a ticket still opens the hatch', () => {
  // The other direction, and the reason the hatch exists: work its own phase
  // shipped without is a decision, not motion, and demanding it is how a gate
  // starts lying.
  const tickets = { 'T-20-01': { phase: '20' }, 'T-20-02': { phase: '20' } };
  const state = {
    'T-20-01': { status: 'merged' },
    'T-20-02': { status: 'pending', ready: true },
  };
  const board = boardOf(tickets, state, [epicOf(20, { pr: { number: 920, state: 'MERGED' } })]);
  assert.strictEqual(board.left_behind_count, board.actionable_count, 'all of it is left behind');
  assert.equal(run(board), null, 'a board of only left-behind work must not trap the session');
});

// ── A FULL BOARD IS A BOARD WITH AN AGENT OUT (T-27-01, ADR-006 D1) ──────────
//
// The gate did not read `capacity` at all, and its with-an-agent hatch sat behind
// `count <= 0`. So on the ordinary full board — every agent the cap allows is
// out, more tickets ready — it blocked the stop and ordered the run to "take the
// actionable items RIGHT NOW", which is the one thing the cap exists to prevent.
// `front.cjs` was meanwhile reporting `fixpoint: NO` for a reason that names
// capacity, and `ci-wait.cjs` was refusing to wait. One board, three answers.
suite('stop-gate — the cap is read, and a spent cap is not live work');

// THE SHARED FULL-BOARD FIXTURE — four executors out under a cap of four, two
// more tickets ready. Computed through the real front.cjs, and restated in
// tests/unit/front.test.cjs and tests/unit/ci-wait.test.cjs: the point of the
// ticket is that all three readers agree about ONE board, which three hand-built
// fronts could not show. Change it here and change it there.
const FULL_OUT = ['T-27-91', 'T-27-92', 'T-27-93', 'T-27-94'];
const FULL_READY = ['T-27-95', 'T-27-96'];
const fullBoard = () => {
  const ids = [...FULL_OUT, ...FULL_READY];
  return {
    generated_at: fresh(),
    ...computeFront(
      Object.fromEntries(ids.map((id) => [id, {}])),
      Object.fromEntries(ids.map((id) => [id, { status: 'pending', ready: true }])),
      { maxConcurrentAgents: 4, dispatched: Object.fromEntries(FULL_OUT.map((id) => [id, 'executor'])) }
    ),
  };
};

test('the shared full board does not block: the agents out are the wake-up', () => {
  const board = fullBoard();
  assert.deepEqual(board.capacity, { max: 4, in_flight: 4, free: 0 }, 'the fixture really is full');
  assert.equal(board.actionable_count, 2, 'and it really does have work on it');
  assert.equal(run(board, { session_id: 'sess-cap-full' }), null,
    'four agents are out; ordering a fifth is the thing the cap exists to prevent');
});

test('a guard holding four PRs is ONE agent, so a board of five ready tickets still blocks', () => {
  // The other side of the same counting fix, end to end: with the collapse the
  // board reports `free: 3`, so this work CAN be taken and walking away from it
  // is the defect this hook exists for. Before the collapse the same board read
  // as full and the gate would now stay silent on it.
  const ids = ['T-27-81', 'T-27-82', 'T-27-83', 'T-27-84', 'T-27-85'];
  const front = {
    generated_at: fresh(),
    ...computeFront(
      Object.fromEntries(ids.map((id) => [id, {}])),
      Object.fromEntries(ids.map((id) => [id, { status: 'pending', ready: true }])),
      { maxConcurrentAgents: 4, dispatched: Object.fromEntries(ids.slice(0, 4).map((id) => [id, 'pr-sentinel'])) }
    ),
  };
  assert.deepEqual(front.capacity, { max: 4, in_flight: 1, free: 3 });
  const v = run(front, { session_id: 'sess-cap-guard' });
  assert.ok(v && v.decision === 'block', 'one guard is one agent, so there is room and there is work');
  assert.ok(/T-27-85/.test(v.reason), 'and the refusal names the ticket that can be taken');
});

test('a capacity-full board whose marks are all suspect still blocks, and says the cap is a phantom', () => {
  // The direction that must NOT get more permissive. `in_flight` comes from
  // dispatch marks, and a mark can be written before a launch that never
  // happened: a board that looks full with nobody behind it is 90 minutes of
  // silence with nothing coming, which is exactly what the suspect rule exists
  // for. Same plausibility test as the CI hatch, so the two cannot diverge.
  const dir = project(fullBoard());
  putDispatches(dir, Object.fromEntries(FULL_OUT.map((id) => [id, { role: 'executor', at: minsAgo(60) }])));
  const v = runIn(dir, { session_id: 'sess-cap-phantom' });
  assert.ok(v && v.decision === 'block', 'a full board with no agent behind it is a stall, not a wait');
  assert.ok(/FULL/.test(v.reason), `the refusal explains the cap it is blocking past: ${v.reason}`);
  assert.ok(/dispatch-record\.cjs clear/.test(v.reason), 'and how to return the phantom tickets to the board');
});

test('one live mark beside three suspect ones keeps the board quiet', () => {
  const dir = project(fullBoard());
  putDispatches(dir, {
    [FULL_OUT[0]]: { role: 'executor', at: minsAgo(60) },
    [FULL_OUT[1]]: { role: 'executor', at: minsAgo(60) },
    [FULL_OUT[2]]: { role: 'executor', at: minsAgo(60) },
    [FULL_OUT[3]]: { role: 'executor', at: minsAgo(5) },
  });
  assert.equal(runIn(dir, { session_id: 'sess-cap-mixed' }), null,
    'one agent still out is one wake-up still coming');
});

test('capacity.max === 0 exits 0 and stays silent', () => {
  // front.cjs can only express 0 one way: the project config does not parse, so
  // NO policy is in effect and nothing may be dispatched. A board that correctly
  // cannot dispatch anything is not a defect to block on — no refusal of a stop
  // can edit a file, and front.cjs's own line already says what to do.
  assert.equal(run(live({ capacity: { max: 0, in_flight: 0, free: 0 } }), { session_id: 'sess-cap-zero' }),
    null, 'a cap of 0 is a person\'s job, not a trap for the session');
});

test('a board written before capacity existed blocks exactly as it did', () => {
  // `delivery-front.json` outlives an upgrade, and `live()` carries no capacity
  // at all: an absent field must read as "no cap is in force", never as a full
  // board — the second would silence the gate on every old board in existence.
  const v = run(live(), { session_id: 'sess-cap-absent' });
  assert.ok(v && v.decision === 'block', 'no capacity field is not a spent cap');
  assert.ok(/2 item\(s\) are actionable/.test(v.reason), v.reason);
});

test('room in the cap blocks with the ordinary reason — no capacity noise', () => {
  const v = run(live({ capacity: { max: 4, in_flight: 1, free: 3 } }), { session_id: 'sess-cap-room' });
  assert.ok(v && v.decision === 'block');
  assert.ok(!/FULL/.test(v.reason), `nothing is full, so nothing should say so: ${v.reason}`);
});

done();
