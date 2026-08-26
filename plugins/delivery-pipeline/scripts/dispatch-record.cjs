#!/usr/bin/env node
'use strict';

// dispatch-record.cjs — the durable home for "this ticket is with an agent right
// now".
//
//   dispatch-record.cjs mark  <ticket> <role> [--graph <dir>]
//   dispatch-record.cjs clear <ticket>        [--graph <dir>]
//   dispatch-record.cjs list  [--json]        [--graph <dir>]
//
// Why this exists. The front's vocabulary had no state for DISPATCHED AND
// RUNNING, so a ticket handed to an agent was indistinguishable from one nobody
// had touched: nothing is pushed yet, so state-sync — which reads GitHub — still
// classifies it `execute`, and the stop gate then refuses a turn over work that
// is already in flight. Measured five times in one session (3, 5, 6, 4 and 5
// items), across BOTH owners, every one verified in flight before it was
// reported.
//
// It is wrong by construction rather than by accident: deliver.md tells the run
// to post the guard and NOT wait for it, so `fix`/`finalize`/`merge` are
// dispatched BY DESIGN. A run that follows the documented protocol therefore
// mis-reports the guard's buckets on every healthy round. The evidence of a
// dispatch lived only in the orchestrator's session, which is exactly the kind of
// fact this conveyor has repeatedly learned not to keep there (`--parked` →
// escalation-record, the drift verdict → drift.json).
//
// EXPIRY IS THE WHOLE DESIGN, and it has TWO independent triggers because either
// alone leaves a hole. A record that never lifted would hide a ticket the next
// run must pick up — trading a spurious block for a SILENT STALL, which is the
// worse of the two outcomes and the one this store must never produce:
//
//   1. THE STATE MOVED. The dispatch is a claim about the ticket as it stood when
//      the work was handed over; the moment its delivery state moves (a branch
//      appears, a PR opens, checks change, it comes out of draft) the dispatch
//      has done its job and the board owns the ticket again. Bound to
//      escalation-record's own `fingerprint` — REQUIRED, never reimplemented, so
//      two stores that expire against the same subject cannot come to disagree
//      about what "the PR moved" means.
//   2. A TTL, so a killed session cannot park a ticket forever. See below.
//
// Neither needs a second command to remember, which is the property that makes
// this safe to write from a loop that may not survive to clean up after itself.

const fs = require('fs');
const path = require('path');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
// The state-moved rule, taken from the store that already owns it.
const { fingerprint } = require(path.join(__dirname, 'escalation-record.cjs'));
// One role vocabulary for the whole conveyor: the same names `pipeline-config.cjs
// model <role>` resolves a model for. A dispatch filed under a name the ladder
// does not know is a record whose owner nobody can identify.
const { ROLES } = require(path.join(__dirname, 'pipeline-config.cjs'));

// HOW LONG A DISPATCH MAY STAY SILENT — the backstop, not the main rule. It only
// has to cover the longest stretch of REAL work that legitimately moves no
// delivery state at all, because anything that moves state expires by trigger 1
// long before this.
//
// Measured from this repo's own delivery journal rather than rounded to a
// comfortable number. The longest observed dispatch→publish stretch is one
// executor wave: phase 21 wave 1 opened its PRs at 13:52 and wave 2 (dispatched
// off that board) opened at 14:29 — 37 minutes with nothing pushed in between.
// Phase 20 gives 29 minutes for the same span, phase 22 gives 14. The longest
// PR LIFETIME in the same journal is 135 minutes (T-21-02), but every minute of
// that moves checks, drafts or review decisions, so trigger 1 has already fired.
// 90 minutes is ~2.4x the worst silent stretch on record — enough that a slow
// wave is never dropped mid-flight, short enough that a session killed at
// midnight is not still hiding its tickets at 02:00.
const TTL_RAW = Number(process.env.SHIPYARD_DISPATCH_TTL_MS || 90 * 60 * 1000);
// Garbage in the env var must not disable the backstop: NaN poisons every
// comparison into "never expired", which is precisely the silent stall.
const DISPATCH_TTL_MS = Number.isFinite(TTL_RAW) && TTL_RAW > 0 ? TTL_RAW : 90 * 60 * 1000;

// Same resolution and the same flag spelling as drift-record.cjs/log-event.cjs —
// one convention for "which graph does this belong to", stripped from ANY
// position, because a flag only tolerated at the end is a trap for the caller who
// puts it first.
const ARGV_ALL = process.argv.slice(2);
const GRAPH_FLAG_AT = ARGV_ALL.indexOf('--graph');
// A flag-shaped token is not a directory. Guarded for the CLI only: front.cjs
// `require`s this file for activeDispatches/dispatchWhy, and an exit at require
// time would kill THAT script under this one's name.
if (require.main === module && GRAPH_FLAG_AT !== -1) {
  const val = ARGV_ALL[GRAPH_FLAG_AT + 1];
  if (val === undefined || val.startsWith('--')) {
    fail(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
  }
}
const GRAPH_EXPLICIT = GRAPH_FLAG_AT !== -1 || !!process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_DIR = GRAPH_FLAG_AT !== -1
  ? path.resolve(ARGV_ALL[GRAPH_FLAG_AT + 1] || '')
  : (process.env.SHIPYARD_GRAPH_DIR
    ? path.resolve(process.env.SHIPYARD_GRAPH_DIR)
    : path.join(process.cwd(), '.planning', 'graph'));
// Guarded on the -1 case: `i !== GRAPH_FLAG_AT + 1` with no flag present reads as
// `i !== 0` and eats the SUBCOMMAND.
const ARGV = GRAPH_FLAG_AT === -1
  ? ARGV_ALL
  : ARGV_ALL.filter((_, i) => i !== GRAPH_FLAG_AT && i !== GRAPH_FLAG_AT + 1);
const STORE_NAME = 'dispatches.json';

function fail(msg) {
  process.stderr.write(`dispatch-record: ${msg}\n`);
  process.exit(1);
}

function graphDir(cwd = process.cwd()) {
  return path.join(cwd, '.planning', 'graph');
}

function readState(cwd) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), 'delivery-state.json'), 'utf8'));
    return raw && raw.tickets ? raw.tickets : raw || {};
  } catch {
    return {};
  }
}

function load(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), STORE_NAME), 'utf8'));
    return raw && typeof raw === 'object' && raw.tickets ? raw : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
}

// Read-modify-write plus the journal line, under ONE lock and written atomically —
// drift-record's rule for the same reason: the main loop dispatches a whole wave
// at once, and an unsynchronized load→save loses records (six concurrent marks
// reliably produced five). The lock sits beside the STORE, never at cwd: a mark
// run from a ticket worktree would otherwise take a lock nobody else contends
// for and serialize nothing.
function mutate(cwd, fn) {
  fs.mkdirSync(graphDir(cwd), { recursive: true });
  return withLock(lockDirFor(cwd), 'dispatch-record', () => {
    const store = load(cwd);
    const extra = fn(store);
    writeAtomic(path.join(graphDir(cwd), STORE_NAME), JSON.stringify(store, null, 2) + '\n');
    if (extra) fs.appendFileSync(path.join(graphDir(cwd), 'delivery-log.jsonl'), JSON.stringify(extra) + '\n');
  }, { label: 'dispatch-record' });
}

const roleOf = (rec) => (typeof rec === 'string' ? rec : ((rec && rec.role) || 'an agent'));

function ageMinutes(rec) {
  const at = Date.parse((rec && rec.at) || '');
  return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 60000)) : null;
}

/**
 * The board's sentence for a live dispatch, and it lives HERE — beside the branch
 * in `activeDispatches` that decides when the record actually lifts. That is
 * escalation-record's rule applied to a second store: a lifting rule composed at
 * the render site is how a board came to promise one thing while the file that
 * decides promised another.
 *
 * It names both expiry triggers, because a reader who does not know the record
 * lifts by itself will reach for `clear` — and a `clear` that becomes routine is
 * how a store starts being cleared before the work returns.
 */
function dispatchWhy(id, rec) {
  const mins = ageMinutes(rec);
  const age = mins === null ? '' : ` ${mins}m ago`;
  return `dispatched to ${roleOf(rec)}${age} — an agent holds it, so it is nobody else's to start. ` +
    'It returns to the board by itself when the ticket\'s delivery state moves (a branch, a PR, a check, an undraft) ' +
    `or after ${Math.round(DISPATCH_TTL_MS / 60000)}m; \`dispatch-record.cjs clear ${id}\` returns it now.`;
}

/**
 * The dispatches still in force: {ticket: {role, at}} — the shape `computeFront`
 * takes as `opts.dispatched`. Callers get both expiry triggers for free.
 *
 * `state` may be passed in by a caller that already has it, otherwise it is read
 * from disk.
 *
 * Every branch here fails TOWARDS offering the work. A record that cannot be
 * read, cannot be dated, or was written against a ticket the state no longer
 * describes is treated as spent, because the failure this store must never
 * produce is a ticket hidden from the run that owns it.
 */
function activeDispatches(cwd = process.cwd(), state = null) {
  const live = state || readState(cwd);
  const now = Date.now();
  const out = {};
  for (const [id, rec] of Object.entries(load(cwd).tickets || {})) {
    if (!rec) continue;
    const s = live[id] || {};
    // A merged ticket is never suppressed, whoever was working on it: it landed.
    if (s.status === 'merged') continue;
    const at = Date.parse(rec.at || '');
    // An undateable record has an unknown age, and an unknown age is expired.
    if (!Number.isFinite(at) || now - at >= DISPATCH_TTL_MS) continue;
    // Trigger 1 — the state moved, so the dispatch did its job.
    if (rec.fingerprint && fingerprint(s) !== rec.fingerprint) continue;
    out[id] = { role: roleOf(rec), at: rec.at };
  }
  return out;
}

// Recompute `delivery-front.json` from the stores as they now stand.
//
// This is not decoration: the file the stop gate reads is written by state-sync,
// and the dispatch happens BETWEEN two syncs — deliver.md runs state-sync once,
// after the whole publish phase, so at the moment a wave is handed to agents the
// board on disk still lists every one of them as actionable. A record nothing
// re-derives from would be a fact with no reader at exactly the moment it is
// true.
//
// Deliberately narrow:
//   * it REFRESHES an existing front and never creates one. The stop gate is
//     installed globally, and a front conjured in a directory that has none would
//     arm it where nothing asked for it;
//   * it inherits `parked_by_run`, `auto_merge` and `generated_at` from the file
//     it is updating. Those are the SYNC's facts — session parks and how fresh
//     the GitHub read is — and re-stamping `generated_at` would make a stale
//     board read as current, which is the staleness hatch this whole gate relies
//     on;
//   * it is BEST EFFORT. The record is the durable fact; the front is derived.
//     A concurrent state-sync holding the lock is a reason to say so and move on,
//     never a reason to fail the mark.
// The READ, the COMPUTE and the WRITE all sit inside the `state` lock — the same
// one state-sync writes its trio under. Reading first and locking only the write
// is the lost-update this repo has already paid for twice: the guard runs
// state-sync at the top of every round, and one landing between our read and our
// write would see its newer board replaced by one computed from older inputs.
function refreshFront(cwd) {
  const dir = graphDir(cwd);
  const frontFile = path.join(dir, 'delivery-front.json');
  // Required lazily and ON PURPOSE: front.cjs requires THIS file at load time for
  // `dispatchWhy`, so a top-level require here would hand it a half-built module.
  // By the time this function runs, both are fully loaded.
  const { computeFront, ciEstimates } = require(path.join(__dirname, 'front.cjs'));
  const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
  const { activeParks } = require(path.join(__dirname, 'escalation-record.cjs'));
  try {
    return withLock(lockDirFor(cwd), 'state', () => {
      let previous;
      let tickets;
      let state;
      try {
        previous = JSON.parse(fs.readFileSync(frontFile, 'utf8'));
        tickets = (JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8')) || {}).tickets || {};
        state = JSON.parse(fs.readFileSync(path.join(dir, 'delivery-state.json'), 'utf8'));
      } catch {
        return null; // no board here yet — state-sync writes the first one
      }
      if (!previous || typeof previous !== 'object' || !state || typeof state !== 'object') return null;
      const front = computeFront(tickets, state, {
        parked: previous.parked_by_run || [],
        autoMerge: previous.auto_merge === 'epic',
        drifted: activeDrift(cwd),
        escalated: activeParks(cwd, state),
        dispatched: activeDispatches(cwd, state),
        ci_estimates: ciEstimates(dir, tickets),
      });
      writeAtomic(frontFile, JSON.stringify({
        generated_at: previous.generated_at,
        parked_by_run: previous.parked_by_run || [],
        auto_merge: previous.auto_merge || 'off',
        dispatches_applied_at: new Date().toISOString(),
        ...front,
      }, null, 2) + '\n');
      return front;
    }, { label: 'dispatch-record', waitMs: 20_000 });
  } catch (e) {
    process.stderr.write(
      `dispatch-record: the record is stored, but delivery-front.json could not be refreshed (${e.message}).\n` +
      '  The next state-sync rewrites it anyway; re-run this command if the board still offers the ticket.\n'
    );
    return null;
  }
}

module.exports = { activeDispatches, dispatchWhy, DISPATCH_TTL_MS };

if (require.main === module) {
  const [cmd, ...rest] = ARGV;
  const cwd = path.resolve(GRAPH_DIR, '..', '..');

  // Fail-closed, exactly as drift-record and escalation-record do: this command
  // is documented to run from ticket worktrees, which have no `.planning/` of
  // their own, and a store written beside no ticket graph is unreadable rather
  // than merely misplaced — the front reads the PROJECT's. `list`/`clear` stay
  // permissive: they read or they remove, they never hide a ticket nowhere.
  if (cmd === 'mark' && !GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) {
    fail(
      `no ticket graph at ${GRAPH_DIR} — refusing to record a dispatch nothing will read.\n` +
      '  The front reads the PROJECT\'s graph; one written in a worktree is invisible to it,\n' +
      '  so the ticket keeps being offered as work an agent already holds.\n' +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }

  if (cmd === 'mark') {
    const [ticket, role] = rest;
    if (!ticket || !role) fail(`usage: dispatch-record.cjs mark <ticket> <role> [--graph <dir>]   (roles: ${ROLES.join(', ')})`);
    // The role is what tells the morning reader WHO holds the ticket, and it is
    // the ladder's own vocabulary so that the name on the board is the name the
    // model resolver answers to.
    if (!ROLES.includes(role)) {
      fail(`"${role}" is not a pipeline role — the board would name a holder nothing can identify.\n  roles: ${ROLES.join(', ')}`);
    }
    const s = readState(cwd)[ticket];
    if (!s) fail(`no ${ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);
    const at = new Date().toISOString();
    mutate(cwd, (store) => {
      // A re-dispatch restarts the clock: the previous agent is not the one
      // holding it now.
      store.tickets[ticket] = { role, at, fingerprint: fingerprint(s), pr: s.pr || null };
      // Journalled because nothing else records WHEN work was handed over. The
      // TTL above had to be inferred from PR timestamps for want of this line;
      // the next one can be measured. The ticket's next `status_change` closes
      // the interval, so a `clear` needs no event of its own.
      return { ts: at, event: 'dispatch', ticket, role, pr: s.pr || null, by: 'dispatch-record' };
    });
    // The record is durable the instant `mutate` above returns — that alone is
    // what `activeDispatches` reads. `refreshFront` only decides whether the
    // ON-DISK board reflects it RIGHT NOW or on the next sync; its return value
    // says which, so the message does not claim a refresh that did not happen
    // (no board yet, or a state-sync held the lock).
    const refreshed = refreshFront(cwd) !== null;
    console.log(
      `dispatch recorded for ${ticket} (${role}) — ` +
      (refreshed
        ? 'the front reports it as waiting, not as work to start. '
        : 'no board was refreshed just now (none exists yet, or a sync holds the lock); the record is durable and the next state-sync or refresh will apply it. ') +
      `It lifts when the ticket's state moves or after ${Math.round(DISPATCH_TTL_MS / 60000)}m.`
    );
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: dispatch-record.cjs clear <ticket> [--graph <dir>]');
    const had = !!load(cwd).tickets[ticket];
    if (had) {
      mutate(cwd, (store) => { delete store.tickets[ticket]; });
      refreshFront(cwd);
    }
    console.log(had ? `dispatch cleared for ${ticket} — it is the board's again` : `no dispatch recorded for ${ticket}`);
  } else if (cmd === 'list') {
    const active = activeDispatches(cwd);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(active, null, 2));
    } else if (!Object.keys(active).length) {
      console.log('no dispatches in force');
    } else {
      for (const [id, rec] of Object.entries(active)) {
        const mins = ageMinutes(rec);
        console.log(`${id}: ${rec.role}${mins === null ? '' : `, ${mins}m ago`}`);
      }
    }
  } else {
    fail('usage: dispatch-record.cjs <mark|clear|list> …');
  }
}
