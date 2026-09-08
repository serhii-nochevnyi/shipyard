#!/usr/bin/env node
'use strict';

// ci-wait.cjs — the one legitimate way for the conveyor to wait.
//
//   ci-wait.cjs [--graph <dir>] [--timeout <s>] [--interval <s>] [--json]
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The babysit loop is not a loop. It is driven by agent-completion wake-ups: an
// agent finishes, the session is re-invoked, it does a round, it stops. That is
// the right design and it costs nothing while agents work. It has one hole, and
// it is structural: WHEN THE ONLY THING LEFT IS WAITING, NOTHING WILL EVER WAKE
// THE SESSION AGAIN. The front says so honestly — waiting on CI is "not a
// fixpoint, and not a reason to block" — and the stop gate honours it. So the run
// stops, correctly, and never comes back.
//
// Measured on the pdffiller proving ground. The operator asked, in three words,
// for the phase to be merged. A stacked cascade turns that into one CI round PER
// TICKET: the sentinel squashes a child into the epic, GitHub retargets the
// grandchild, the squash has rewritten history so the grandchild goes DIRTY,
// base-merge fixes it, the push re-runs 17 checks. Four tickets, four serialized
// waits. The run survived none of them: it merged one ticket, resolved one
// conflict, stopped to wait — and sat there with the next PR green, conform and
// ready, until a person came back. "Merge everything" needed three wake-ups that
// do not exist in the system.
//
// ── WHY WAITING IN THE FOREGROUND IS CORRECT HERE, AND WAS NOT BEFORE ────────
// This repo removed `gh pr checks --watch` for good reason: a run that blocks on
// one PR's checks stops driving every other ticket, which is the defect front.cjs
// was written to fix. That reasoning is about OPPORTUNITY COST, and it evaporates
// exactly when the board has nothing else to offer. If the front is empty but for
// `waiting.ci`, there is no other work to serialize against — and blocking means
// the TURN NEVER ENDS, so no wake-up is needed at all. The hole closes itself.
//
// The distinction has to be MECHANICAL, or the old defect walks back in the first
// time someone runs this at the wrong moment. Hence: this script REFUSES to wait
// whenever the board holds work THE RUN MAY TAKE, and says what to do instead.
// Under `--json` a refusal is data (`waited: false` + `refusal`), because the
// caller is a loop, not a person.
//
// "May take" is the board's own answer and not this script's guess: `capacity`
// (front.cjs) says how many agents the run is allowed to hold and how many are
// out. When `free` is 0 the actionable items are beyond the cap — there is no
// free wake-up in taking them, because they cannot be taken — so naming them as
// "work to do first" is advice to breach the very gate that computed them, and
// the three mechanisms that read capacity would disagree about one board
// (ADR-006 D1). A cap of 0 is the same fact for a different reason: no policy
// could be read, so nothing may be dispatched at all. The wait mutates nothing,
// and the escalation it may earn is withheld by the config rule below exactly as
// before.
//
// ── WHAT THE FOREGROUND WAIT DOES *NOT* COVER ────────────────────────────────
// "The turn never ends, so nothing has to wake it" is only true WHILE THIS SCRIPT
// IS RUNNING, and that leaves the same rule this repo keeps learning about:
// something has to make the loop call it. Left as prose in deliver.md, that is a
// rule which gets skipped — the exact class of failure the stop gate exists for.
// So the gate now refuses a stop whose board holds nothing but `waiting.ci` and
// names this script. Two mechanisms, one hole.
//
// A stop gate can only refuse once per turn, though, so the pair still has to
// TERMINATE, and it must not do so by leaving a stuck pipeline unattended. That is
// what the wait record below is for: three consecutive timeouts in which one
// ticket's own pipeline did not move (45m at the default window, longer where
// the front's `ci_estimates` size it up) is a pipeline that is not going to
// settle, and the honest end of that is a person, not more patience. So this
// script ESCALATES itself at that point — and because an escalation park drops
// the ticket from the front (`front.cjs` reads `activeParks`), the CI bucket
// empties and the gate goes quiet through the rule it already had. The loop
// terminates structurally rather than by a special case.
//
// It also refuses when tickets are `waiting.dispatched`: an agent completion is a
// wake-up the runtime gives for free and gives sooner. Waiting on CI while an
// agent works would only add latency to a round that was already going to happen.
//
// ── EXITS ────────────────────────────────────────────────────────────────────
//   0  something settled, or the timeout passed — either way, go round again
//   3  refused: the board has work, or there is nothing to wait for
//   2  usage
// Never anything else: a waiter that dies noisily teaches the loop to stop
// calling it, and then the hole is back.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
// The state-moved rule, taken from the store that already owns it. Never
// reimplemented: two stores that expire against the same subject must not come to
// disagree about what "the PR moved" means.
const { fingerprint } = require(path.join(__dirname, 'escalation-record.cjs'));
const { classify, CHECK_FIELDS } = require(path.join(__dirname, 'check-state.cjs'));
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

function flag(name, dflt) {
  const at = argv.indexOf(name);
  if (at === -1) return dflt;
  const v = Number(argv[at + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    process.stderr.write(`ci-wait: ${name} needs a positive number of seconds\n`);
    process.exit(2);
  }
  return v;
}

// Long enough to cover a real CI run on this repo's own scale (17 checks, ~8-12
// minutes observed), short enough that one call is a bounded commitment the
// caller can decide to repeat. The loop re-syncs and re-decides between calls,
// so a stuck pipeline costs one window, not a night.
//
// This is the FLOOR/DEFAULT only. Once the watch list is known, an explicit
// `--timeout` (tracked here as TIMEOUT_S_EXPLICIT) or `SHIPYARD_CI_WAIT_TIMEOUT_S`
// still wins outright; short of that, the window is resized from the front's
// own `ci_estimates` — see the "WINDOW SIZING" block below.
const TIMEOUT_S_EXPLICIT = argv.includes('--timeout');
let TIMEOUT_S = flag('--timeout', 15 * 60);
const WINDOW_FLOOR_S = 15 * 60;
const WINDOW_CEIL_S = 60 * 60;
// Same "positive number or ignore it" rule as SHIPYARD_CI_WAIT_MAX_EMPTY below —
// a garbage env value must fall back, not disable the sizing it was meant to tune.
const ENV_TIMEOUT_S = (() => {
  const v = Number(process.env.SHIPYARD_CI_WAIT_TIMEOUT_S);
  return Number.isFinite(v) && v > 0 ? v : null;
})();
const INTERVAL_S = flag('--interval', 30);

// Same resolution and the same flag spelling as log-event.cjs / drift-record.cjs
// — one convention for "which graph is this", and a flag-shaped token is not a
// directory.
function resolveGraphDir() {
  const at = argv.indexOf('--graph');
  if (at !== -1) {
    const v = argv[at + 1];
    if (v === undefined || v.startsWith('--')) {
      process.stderr.write(`ci-wait: --graph needs a directory value (got ${v === undefined ? 'nothing' : `the flag "${v}"`})\n`);
      process.exit(2);
    }
    return path.resolve(v);
  }
  if (process.env.SHIPYARD_GRAPH_DIR) return path.resolve(process.env.SHIPYARD_GRAPH_DIR);
  return path.join(process.cwd(), '.planning', 'graph');
}

const GRAPH = resolveGraphDir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function refuse(reason, hint) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ waited: false, refusal: reason, hint }, null, 2) + '\n');
  } else {
    process.stdout.write(`ci-wait: refusing to wait — ${reason}\n  ${hint}\n`);
  }
  process.exit(3);
}

function finish(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ waited: true, ...payload }, null, 2) + '\n');
  else process.stdout.write(human + '\n');
  process.exit(0);
}

// A park is the one outcome the caller must not miss, so it is said in both forms.
function parkLines(parked) {
  return parked.map((p) => {
    if (p.ok) {
      return `  ESCALATED ${p.id} (PR #${p.pr}) after ${p.empty_windows} empty windows — a person now owns it,`
        + ' and the park lifts by itself once the PR moves.';
    }
    if (!p.id) return `  WARNING: ${p.error} — the empty-window count did not advance, so no park will be earned.`;
    // A DELIBERATE refusal is not a failed write, and the two must not read the
    // same: "record it by hand" is the opposite of the rule when the reason the
    // park was withheld is that nothing may be mutated at all.
    if (p.refused) {
      return `  NOT ESCALATED ${p.id} (PR #${p.pr}) after ${p.empty_windows} empty windows — ${p.error}`;
    }
    return `  WARNING: could not escalate ${p.id} (${p.error}) — record it by hand, or the front keeps offering`
      + ' a wait that has already failed its window budget.';
  }).join('\n');
}

const front = readJson(path.join(GRAPH, 'delivery-front.json'));
const state = readJson(path.join(GRAPH, 'delivery-state.json'));
if (!front || !state) {
  refuse(`no board at ${GRAPH}`,
    'Run state-sync.cjs from the project (or pass --graph <project>/.planning/graph).');
}

// THE GUARD. Anything actionable and left-behind-adjusted means the run owes work
// now, and waiting instead is the serialization defect this script exists not to
// reintroduce — UNLESS the cap says none of it may be dispatched this round.
const actionableCount = Number(front.actionable_count || 0);
const leftBehind = Number(front.left_behind_count || 0);
// The board's capacity, read defensively: a `delivery-front.json` written before
// capacity existed outlives an upgrade, and an absent field must read as "no cap
// is in force" (refuse as before), never as a full board.
const capacity = (front.capacity && typeof front.capacity === 'object') ? front.capacity : null;
// `front.cjs` only ever emits non-negative counts (`Math.max(0, …)` for `free`,
// a length or a collapsed sum for `max`/`in_flight`), so a negative value here
// is not a smaller cap — it is a corrupted or hand-edited front, and must read
// as unreadable exactly like `null`/a string/an object would.
const capNum = (k) => (capacity !== null && typeof capacity[k] === 'number'
  && Number.isFinite(capacity[k]) && capacity[k] >= 0 ? capacity[k] : null);
const capFree = capNum('free');
// `max`/`in_flight` are read the same defensive way for the human message below —
// they gate nothing here, but an old or partially-written front must not print
// `undefined`/garbled numbers into an operator-facing line.
const capMax = capNum('max');
const capInFlight = capNum('in_flight');
// Both fields must be readable, matching stop-gate.cjs's `capacityFull`: a
// `free` of 0 or less means nothing while `max` is unreadable, because a
// partially-written front (`free: 0`, `max` missing or garbled) is not
// evidence the cap is spent — it is evidence the front cannot be trusted, and
// the two readers must agree about which case that is. An unreadable `max`
// falls back to the pre-cap refusal (no cap in force), exactly like an absent
// `capacity` object does above.
const capBinds = capMax !== null && capFree !== null && capFree <= 0;
if (actionableCount > 0 && leftBehind < actionableCount && !capBinds) {
  const named = ['execute', 'publish', 'fix', 'finalize', 'merge']
    .filter((k) => (front.actionable?.[k] || []).length)
    .map((k) => `${k}: ${front.actionable[k].join(', ')}`)
    .join(' | ');
  refuse(`the board has ${actionableCount} actionable item(s) (${named})`,
    'Take that work first. Waiting while the board has moves is what front.cjs was written to stop.');
}

const dispatched = (front.waiting && front.waiting.dispatched) || [];
if (dispatched.length) {
  refuse(`${dispatched.length} ticket(s) are with an agent (${dispatched.join(', ')})`,
    'An agent completion wakes the run for free and sooner; this would only add latency.');
}

// WHAT COUNTS AS A WAIT ON A PIPELINE — two buckets, not one:
//
//   waiting.ci     — the ticket's own checks are still running;
//   waiting.parent — the ticket is stacked on a parent whose PR is still open, so
//                    the pipeline it is actually waiting for is the PARENT's.
//
// Reading only the first is what let a board full of held children report
// "nothing is waiting on CI": this script refused, the stop gate's CI-only branch
// saw the same empty bucket and allowed the stop, and the one thing that would
// ever have released those children was a pipeline nobody was watching.
const ciTickets = (front.waiting && front.waiting.ci) || [];
const heldTickets = (front.waiting && front.waiting.parent) || [];
// WHO the parent is comes from the BOARD (`front.cjs` writes `parent_of`), never
// from tickets.json: re-deriving the graph here is exactly the duplication that
// let the guard and the board disagree about this bucket in the first place.
const parentOf = (front.parent_of && typeof front.parent_of === 'object') ? front.parent_of : {};
if (!ciTickets.length && !heldTickets.length) {
  refuse('nothing is waiting on CI',
    front.fixpoint === true
      ? 'The board reports a fixpoint — this run is done.'
      : 'Re-read the front: whatever is left is not a wait this script can shorten.');
}

// One watch target per ticket, scoped to the ticket's OWN repo — the same rule
// state-sync obeys, and for the same reason: watching the wrong repository
// reports a foreign PR as pending forever.
//
// DEDUPLICATED BY PR, because the usual shape has a parent in `waiting.ci` AND a
// child held behind it: two entries would poll the same PR twice a round and
// count the same empty window twice against the same budget. The entry keeps the
// PARENT's ticket id — the record and any escalation belong to the ticket whose
// pipeline is stuck, and parking it is what lifts the hold on its children
// (`parentIsMoving` reads its caller's parked set) — with `via` naming who else
// is waiting on it.
//
// A parent that is already GREEN settles on the first poll and this returns at
// once. That is the normal return path and is deliberately not filtered: a check
// that finished between the sync and the wait looks identical from here. It can
// only happen when the parent is neither actionable (the board would have been
// refused above) nor in `waiting.ci`, i.e. its merge is a human's — and today the
// stop gate's CI-only branch reads `waiting.ci` alone, so such a board ends the
// run rather than spinning on it. T-24-09 owns the gate's half.
// A held child with NO entry in `parent_of` is a stale or partial front, not a
// ticket with nothing to watch: `front.cjs` writes `parent_of` for every id it
// puts in `waiting.parent`, so a miss here means the two disagree about the
// SAME board. That must refuse even when some other ticket gives this script a
// watch target — otherwise the missing mapping is silently dropped the moment
// anything else is waiting on CI, which is exactly the shape that hid a stale
// front the longest: everything else on the board looked fine.
const orphanHeld = heldTickets.filter((id) => !parentOf[id]);
if (orphanHeld.length) {
  refuse(`held behind a parent the board names no parent_of for (${orphanHeld.join(', ')})`,
    'That is a board bug, not a wait: re-run state-sync.cjs.');
}

const watch = [];
const byPr = new Map();
const wanted = [
  ...ciTickets.map((id) => ({ ticket: id, via: null })),
  ...heldTickets.map((id) => ({ ticket: parentOf[id], via: id })),
];
for (const w of wanted) {
  const s = state[w.ticket];
  if (!s || !s.pr) continue;
  const key = `${s.repo || ''}#${s.pr}`;
  const seen = byPr.get(key);
  if (seen) {
    if (w.via && !seen.via.includes(w.via)) seen.via.push(w.via);
    continue;
  }
  const entry = { id: w.ticket, pr: s.pr, repo: s.repo || null, via: w.via ? [w.via] : [] };
  byPr.set(key, entry);
  watch.push(entry);
}
if (!watch.length) {
  const named = [
    ...(ciTickets.length ? [`waiting on CI: ${ciTickets.join(', ')}`] : []),
    ...(heldTickets.length ? [`held behind a parent: ${heldTickets.join(', ')}`] : []),
  ].join(' | ');
  refuse(`no PR to watch for any ticket the board says is waiting (${named})`,
    'That is a board bug, not a wait: re-run state-sync.cjs.');
}

// `gh pr checks` reports CI state through its EXIT CODE (8 = pending, 1 =
// failing/no checks) while still printing JSON — so a non-zero exit here is
// DATA, not an error. state-sync.cjs carries the same note; getting it wrong
// makes a pending pipeline look like a broken command.
function checksOf({ pr, repo }) {
  const args = ['pr', 'checks', String(pr), '--json', CHECK_FIELDS];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60000 });
  const stdout = (r.stdout || '').trim();
  let rows;
  if (stdout) {
    try { rows = JSON.parse(stdout); } catch { rows = null; }
  } else if (r.status === 0) {
    rows = []; // gh succeeded and printed nothing — genuinely no checks
  } else {
    // Empty stdout AND a non-zero exit: gh did not answer at all. A rate limit,
    // an outage or an expired token prints to STDERR and leaves stdout blank,
    // and a failed spawn hands back `null`. `JSON.parse(r.stdout || '[]')` used
    // to read every one of those as `[]` — the SAME shape as a real "no checks
    // configured" answer, which is exactly the null-vs-empty collapse the
    // comment below warns against and the distinction the outage handling in
    // the round loop depends on (an unreachable gh must never be counted as an
    // empty window). Fixed by not reaching that fallback at all.
    rows = null;
  }
  // `null` is UNREACHABLE THIS ROUND and is not the same fact as an empty list —
  // check-state.cjs would happily count `[]` as "no checks reported", so the
  // guard stays here, ahead of it.
  if (!Array.isArray(rows)) return null; // unreachable this round; try the next
  // The vocabulary lives in check-state.cjs. This function used to carry its own
  // list, and it was the only one of three that called ACTION_REQUIRED failing —
  // three copies, three answers. The SHAPE stays {total, pending, failing}: it is
  // what `--json` reports and what the settle test below reads.
  const c = classify(rows);
  return { total: c.total, pending: c.pending, failing: c.failing };
}

// HOW MANY EMPTY WINDOWS BEFORE A PERSON IS ASKED. Three at the default 15m is
// 45 minutes in which that ticket's OWN pipeline did not move — not a slow
// pipeline, a stuck one. Bound to escalation-record's own fingerprint, so ANY
// real change (a check finishing, a push, a draft lifting, a review landing)
// resets the count rather than accumulating toward a park nobody has earned.
const MAX_EMPTY_RAW = Number(process.env.SHIPYARD_CI_WAIT_MAX_EMPTY || 3);
const MAX_EMPTY = Number.isFinite(MAX_EMPTY_RAW) && MAX_EMPTY_RAW > 0 ? Math.floor(MAX_EMPTY_RAW) : 3;

const WAITS = path.join(GRAPH, 'ci-waits.json');
// The lock lives beside the store, exactly as drift-record.cjs derives it: a lock
// taken at some other cwd serializes nothing, which is how six concurrent marks
// once produced five records.
const LOCK_ROOT = path.resolve(GRAPH, '..', '..');

// A CORRUPT CONFIGURATION PERMITS NO MUTATION (ADR-004 D2), and the park this
// script files is one: it hands a ticket to a person and drops it off the front.
// So the wait itself still happens — waiting mutates nothing — and the ESCALATION
// is withheld while the file does not parse. Read from the project the graph
// belongs to, not from the cwd: this script is called from worktrees.
//
// Wrapped, and treated as invalid on a throw, because of this script's own
// invariant: a waiter must never die noisily. A config read that took the wait
// down with a stack trace would teach the loop to stop calling it, and then the
// hole this whole script exists to close is back.
const CONFIG = (() => {
  try {
    const { valid, error } = loadConfig(LOCK_ROOT);
    return { valid, error };
  } catch (e) {
    return { valid: false, error: { file: path.join(LOCK_ROOT, '.planning', 'config.json'), relative: '.planning/config.json', message: `could not be read (${e.message})` } };
  }
})();
const CONFIG_REASON = CONFIG.valid ? null
  : `the configuration does not parse (${CONFIG.error.relative} — ${CONFIG.error.message}), and an `
    + 'unparseable config permits no mutation — no escalation is filed until the file parses. '
    + 'The empty-window count keeps running, so the park is earned the moment it does.';
// Carried on EVERY result, not only on the window where a park came due: the
// caller is a loop, and it should learn on window 1 that the termination path is
// withheld rather than discover it on window 3.
const CONFIG_FIELDS = CONFIG.valid ? {}
  : { config_valid: false, config_error: CONFIG.error, config_note: CONFIG_REASON };

// One locked read-modify-write, with the lock BESIDE THE STORE — a lock taken at
// some other cwd serializes nothing, which is how six concurrent marks once
// produced five records.
//
// `goodEver` is the set of watched ticket ids that got at least one READABLE gh
// answer during this window (see the round loop below). A ticket absent from it
// never taught us anything this window — not settled, not moved, not unchanged
// — so its record must be left exactly as it was: not incremented (an outage
// must never read as a stall) and not reset either (that would hide a real
// unchanged run once gh comes back).
function recordOutcome(settledId, watched, goodEver) {
  try {
    return recordOutcomeInner(settledId, watched, goodEver);
  } catch (e) {
    // A WAITER MUST NEVER DIE NOISILY — that is this script's own stated
    // invariant, and the bookkeeping is not worth breaking it for. A held lock,
    // a read-only graph, a `ci-waits.json` that some accident left as a
    // DIRECTORY (measured, while writing the test for this): every one of those
    // took the whole wait down and returned no exit code the loop could read,
    // which teaches the loop to stop calling this and puts the hole straight
    // back. Say what broke and let the wait's own result stand.
    return [{ id: null, pr: null, empty_windows: null, ok: false,
      error: `wait record not updated (${e.message})` }];
  }
}

function recordOutcomeInner(settledId, watched, goodEver) {
  const escalations = [];
  withLock(lockDirFor(LOCK_ROOT), 'ci-wait', () => {
    let store = { tickets: {} };
    try { store = JSON.parse(fs.readFileSync(WAITS, 'utf8')) || { tickets: {} }; } catch { /* first wait */ }
    if (!store.tickets || typeof store.tickets !== 'object') store.tickets = {};
    const now = new Date().toISOString();

    for (const w of watched) {
      if (settledId) {
        // Progress on ONE ticket says nothing about any OTHER watched ticket.
        // Clear only the record of the ticket that actually settled — this used
        // to run for every watched ticket, which wiped a neighbour's multi-
        // window count the moment anything settled.
        if (w.id === settledId) delete store.tickets[w.id];
        continue;
      }
      // Never got a readable answer this window (gh unreachable throughout) —
      // see the doc comment on `recordOutcome` above. Leave it untouched.
      if (goodEver && !goodEver.has(w.id)) continue;
      const fp = fingerprint(state[w.id] || {});
      const prev = store.tickets[w.id];
      const empties = prev && prev.fingerprint === fp ? Number(prev.empty_windows || 0) + 1 : 1;
      store.tickets[w.id] = {
        fingerprint: fp,
        empty_windows: empties,
        first_at: (prev && prev.fingerprint === fp && prev.first_at) || now,
        last_at: now,
        pr: w.pr,
      };
      if (empties >= MAX_EMPTY) escalations.push({ id: w.id, pr: w.pr, empties });
    }
    writeAtomic(WAITS, JSON.stringify(store, null, 2) + '\n');
  });

  // Park OUTSIDE the lock: escalation-record takes its own, beside its own store.
  const parked = [];
  for (const e of escalations) {
    // Counting an empty window is recording a FACT and is always safe; filing the
    // park is a mutation, and an unparseable config authorizes none.
    if (!CONFIG.valid) {
      parked.push({ id: e.id, pr: e.pr, empty_windows: e.empties, ok: false, refused: true,
        error: CONFIG_REASON });
      continue;
    }
    const reason =
      `CI has not moved for ${e.empties} consecutive ci-wait windows (~${Math.round(e.empties * TIMEOUT_S / 60)}m) ` +
      `on PR #${e.pr}, with no change to any delivery-state fact a check would touch. ` +
      'That is a pipeline that is not going to settle on its own, so waiting longer buys nothing. ' +
      'UNBLOCK: look at the run itself (a queued-forever job, a required check that never reports, a ' +
      'self-hosted runner that is down are the usual three), then `escalation-record.cjs clear ' +
      `${e.id}` + '` — or simply answer the PR, since this park lifts by itself once the delivery ' +
      'facts change.';
    const r = spawnSync(process.execPath,
      [path.join(__dirname, 'escalation-record.cjs'), 'mark', e.id, reason, '--graph', GRAPH],
      { encoding: 'utf8', timeout: 30000 });
    parked.push({ id: e.id, pr: e.pr, empty_windows: e.empties, ok: r.status === 0,
      error: r.status === 0 ? null : ((r.stderr || '').trim() || `exit ${r.status}`) });
  }
  return parked;
}

// WINDOW SIZING. Precedence: an explicit --timeout always wins (the caller said
// so on purpose); short of that, SHIPYARD_CI_WAIT_TIMEOUT_S; short of that, the
// front's own `ci_estimates` (keyed by TICKET id — front.cjs already resolves
// each ticket to its own repo's median, so there is no repo lookup to redo
// here). A flat 15m/45m budget escalates a 40-minute-CI repo before its own
// pipeline could ever settle; deriving from the observed median and clamping it
// to [15m, 1h] keeps the SAME termination shape (three empty windows still ends
// in a park) while sizing each window to the repo it is actually watching.
let windowSource = 'default (no ci_estimates for the watched ticket(s))';
if (TIMEOUT_S_EXPLICIT) {
  windowSource = '--timeout (explicit)';
} else if (ENV_TIMEOUT_S !== null) {
  TIMEOUT_S = ENV_TIMEOUT_S;
  windowSource = 'SHIPYARD_CI_WAIT_TIMEOUT_S';
} else {
  const estimates = watch
    .map((w) => Number((front.ci_estimates || {})[w.id] || 0))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (estimates.length) {
    // The MAX across watched tickets, not one arbitrarily picked: the window is
    // shared by the whole round, so it must not undersize the slowest pipeline
    // it is also watching.
    const maxEst = Math.max(...estimates);
    const derived = maxEst / 3;
    TIMEOUT_S = Math.min(WINDOW_CEIL_S, Math.max(WINDOW_FLOOR_S, derived));
    windowSource = `ci_estimates (max=${Math.round(maxEst)}s / 3 = ${Math.round(derived)}s, clamped to `
      + `[${WINDOW_FLOOR_S}, ${WINDOW_CEIL_S}])`;
  }
}

const startedAt = Date.now();
const deadline = startedAt + TIMEOUT_S * 1000;
const label = watch.map((w) => `${w.id}#${w.pr}${w.via.length ? ` (holding ${w.via.join(', ')})` : ''}`).join(', ');
// WHY waiting is the move, in the board's own terms. "Nothing but pipelines" is
// false on a capacity-bound board — there IS other work, and the cap is what
// makes waiting correct anyway — and a line that misdescribes the board it just
// read is how a reader learns to stop reading it.
const offer = capBinds && actionableCount > 0
  ? `every move on the board is beyond capacity (${capMax ?? '?'} agent(s) allowed, `
    + `${capInFlight ?? '?'} in flight)`
  : 'the board offers nothing but pipelines';
if (!JSON_OUT) {
  process.stdout.write(
    `ci-wait: ${offer} — waiting on ${label}\n` +
    `  up to ${Math.round(TIMEOUT_S / 60)}m, polling every ${INTERVAL_S}s; returns the moment one settles\n` +
    `  window: ${Math.round(TIMEOUT_S)}s — ${windowSource}\n`
    + (CONFIG_REASON ? `  ⚠ ${CONFIG_REASON}\n` : ''));
}

// Node has no synchronous sleep, and a busy loop would burn a core for fifteen
// minutes. Sleeping in a child process is the portable version.
//
// `s` arrives FRACTIONAL — the caller passes the time left until the deadline in
// seconds, and `--interval` takes any positive number — so both numbers handed
// to `spawnSync` are derived from ONE rounding rather than rounded separately.
// `timeout` must be an unsigned integer or Node throws `ERR_OUT_OF_RANGE`, and
// it used to be `(s + 5) * 1000`: at s = 1.376 that is 6375.999999999999 and the
// call threw. It threw on the LAST sleep of a wait, because `Math.min(INTERVAL_S,
// …)` only picks the fractional value inside the final interval — so the throw
// landed immediately before the deadline branch, and the empty-window counting
// and three-strikes escalation this script exists to reach never ran. A waiter
// that dies noisily teaches the loop to stop calling it, which is the hole in the
// first place (see the header). Found by phase 26's integrator, 2026-09-08.
const sleep = (s) => {
  const ms = Math.round(s * 1000);
  return spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], { timeout: ms + 5000 });
};

let rounds = 0;
// A ticket earns an entry here the first time `checksOf` returns a READABLE
// answer this window (settled, moved or unchanged — anything but `null`). A
// ticket that never appears here taught this window nothing: `gh` was
// unreachable for it on every poll, and that is an outage, not a stall (A9
// defect 1). Checked at the deadline, not per-poll, because a ticket that
// answers on round 2 after failing round 1 is not an outage at all.
const goodEver = new Set();
for (;;) {
  rounds += 1;
  const seen = [];
  for (const w of watch) {
    const c = checksOf(w);
    if (c) goodEver.add(w.id);
    seen.push({ ...w, checks: c });
    // Settled means the answer exists: green or red, both change the board and
    // both are the caller's business, not this script's. A waiter that only
    // returned on GREEN would hold a run hostage to a red pipeline.
    if (c && c.total > 0 && c.pending === 0) {
      // A settle clears THAT ticket's own record — its whole accumulated run of
      // empty windows at once, not one decrement off it. Every OTHER watched
      // ticket keeps its count: one pipeline finishing is no evidence about any
      // other, and wiping the board here is the defect this call was fixed for.
      const parked = recordOutcome(w.id, watch, goodEver);
      finish(
        { settled: w.id, pr: w.pr, checks: c, rounds, waited_s: Math.round((Date.now() - startedAt) / 1000),
          watched: seen, escalated: parked, window_s: Math.round(TIMEOUT_S), window_source: windowSource,
          ...CONFIG_FIELDS },
        `ci-wait: ${w.id} (PR #${w.pr}) settled after ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
        `${c.total - c.failing}/${c.total} green${c.failing ? `, ${c.failing} failing` : ''}. ` +
        'Re-sync and take the round.');
    }
  }
  if (Date.now() >= deadline) {
    // gh answered NOBODY, not even once, for the whole window: every ticket's
    // "unchanged" would really be "unknown". Counting that would escalate the
    // entire watch list after one bad window each — an outage read as every
    // pipeline stalling at once. Skip the store entirely: nothing was learned,
    // so nothing is recorded.
    const outage = watch.length > 0 && goodEver.size === 0;
    const parked = outage ? [] : recordOutcome(null, watch, goodEver);
    const lines = parkLines(parked);
    finish(
      { settled: null, timed_out: true, rounds, waited_s: Math.round((Date.now() - startedAt) / 1000),
        watched: seen, escalated: parked, window_s: Math.round(TIMEOUT_S), window_source: windowSource,
        outage, ...CONFIG_FIELDS },
      (outage
        ? `ci-wait: gh was unreachable for the whole ${Math.round(TIMEOUT_S / 60)}m window (${label}) — ` +
          'that is an outage, not a stall; nothing was recorded. Re-sync and try again once gh answers.'
        : `ci-wait: ${Math.round(TIMEOUT_S / 60)}m passed and nothing settled (${label}). ` +
          'Re-sync anyway — the board may have moved for other reasons — then decide whether to wait again.')
      + (lines ? `\n${lines}` : ''));
  }
  sleep(Math.min(INTERVAL_S, Math.max(1, (deadline - Date.now()) / 1000)));
}
