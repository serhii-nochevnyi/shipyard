#!/usr/bin/env node
'use strict';

// jira-project.cjs — the WATERMARK for the tracker projection (ADR-008 D1).
//
//   jira-project.cjs read [--json] [--graph <dir>]
//
// The fifth durable store. `jira-projection.json` records, per ticket, the last
// `status_change` that was actually projected onto the tracker, so a re-run, a
// re-synced board or a replayed journal cannot transition the same issue twice
// or walk it backwards.
//
// WHY A WATERMARK AND NOT LIVE STATE. State is a snapshot: it says what a ticket
// IS, never what has already been told to the tracker. The conveyor's own
// journal is an owned, append-only, timestamped transition stream
// (`status_change`, written by state-sync alone), so the only thing the
// projection needs in order to be exactly-once is a mark saying how far it has
// already consumed. That mark is this file.
//
// FORWARD-ONLY IS THE OTHER HALF, and it is measured in OUR order
// (`pending` < `branched` < `pr-open` < `merged`), not the tracker's. A PR that
// is reopened after merge produces a genuine `merged` → `pr-open` change, and a
// projection that honoured it would drag someone's board backwards on a fact the
// conveyor does not even treat as a regression. So a `to` no later than what was
// already projected is SKIPPED — an ordinary outcome, never an error.
//
// The order lives in exactly one place: `TICKET_STATUSES` in pipeline-config.cjs
// (the same list `jira_transitions` validates its left-hand sides against), and
// exactly one comparator over it is exported from here. The planner (T-29-04) and
// every later reader take that comparator rather than spelling the order again —
// two copies of an order are free to disagree, and the disagreement would show up
// as a board that moves backwards on some runtimes and not others.
//
// STORE DISCIPLINE, copied verbatim from the four stores that came before
// (drift-record, escalation-record, dispatch-record, ci-wait's window store):
// `withLock` + `writeAtomic` around the WHOLE read-modify-write, the lock beside
// the STORE rather than at cwd, `--graph <dir>` accepted in ANY position, and a
// refusal when the resolved graph dir holds no `tickets.json`. Every one of those
// is a defect this repo has already paid for: a verdict written into a worktree
// where nothing reads it, and six concurrent marks producing five records.
//
// This ticket ships the STORE half only. `plan` (T-29-04) and `record`
// (T-29-05) — the verbs an agent calls — are not here, and nothing in this file
// speaks to a tracker.

const fs = require('fs');
const path = require('path');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
const { TICKET_STATUSES } = require(path.join(__dirname, 'pipeline-config.cjs'));

// Same resolution and the same flag spelling as drift-record.cjs /
// escalation-record.cjs / log-event.cjs — one convention for "which graph does
// this belong to", so a caller who learns it once is right everywhere. Stripped
// from ANY position: a flag only tolerated at the end is a trap for the caller
// who puts it first.
const ARGV_ALL = process.argv.slice(2);
const GRAPH_FLAG_AT = ARGV_ALL.indexOf('--graph');
// One spelling has to mean one PARSER. A flag-shaped token is not a directory:
// `--graph --json` would otherwise resolve a directory literally called
// "--json", and a trailing `--graph` would fall through the `|| ''` below to the
// cwd — both then reading as EXPLICIT, which is exactly what skips the
// no-ticket-graph refusal. The wording is escalation-record.cjs's, verbatim,
// because a caller who learns one spelling must not meet a second phrasing here.
//
// CLI only, deliberately: T-29-04's planner `require`s this file for the
// comparator and the watermark, and an exit at require time would kill THAT
// script under this one's name.
if (require.main === module && GRAPH_FLAG_AT !== -1) {
  const val = ARGV_ALL[GRAPH_FLAG_AT + 1];
  if (val === undefined || val.startsWith('--')) {
    fail(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
  }
}
const GRAPH_EXPLICIT = GRAPH_FLAG_AT !== -1 || !!process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_DIR = GRAPH_FLAG_AT !== -1
  // The `|| ''` is not dead code behind that guard: it covers the library
  // `require`, where a trailing `--graph` in someone else's argv would make
  // path.resolve(undefined) throw at require time instead of reaching that
  // caller's own message.
  ? path.resolve(ARGV_ALL[GRAPH_FLAG_AT + 1] || '')
  : (process.env.SHIPYARD_GRAPH_DIR
    ? path.resolve(process.env.SHIPYARD_GRAPH_DIR)
    : path.join(process.cwd(), '.planning', 'graph'));
// Guarded on the -1 case deliberately: `i !== GRAPH_FLAG_AT + 1` with no flag
// present reads as `i !== 0` and eats the SUBCOMMAND. That bug is recorded in
// CLAUDE.md and has been made twice.
const ARGV = GRAPH_FLAG_AT === -1
  ? ARGV_ALL
  : ARGV_ALL.filter((_, i) => i !== GRAPH_FLAG_AT && i !== GRAPH_FLAG_AT + 1);

const STORE_NAME = 'jira-projection.json';

function fail(msg) {
  process.stderr.write(`jira-project: ${msg}\n`);
  process.exit(1);
}

const storeFile = (dir) => path.join(dir, STORE_NAME);
// The lock belongs beside the STORE, never at cwd: a caller running in a ticket
// worktree would otherwise take a lock nobody else contends for and serialize
// nothing.
const lockRootFor = (dir) => path.resolve(dir, '..', '..');

// ── the order, and the ONE comparator over it ───────────────────────────────

// Where a status sits in OUR order, or -1 when the value is not one of the four
// state-sync ever writes. -1 is "unknown", never "before everything": every
// caller checks for it before comparing, because arithmetic on an unknown would
// quietly answer a question nobody can actually answer.
function statusRank(status) {
  return TICKET_STATUSES.indexOf(status);
}

/**
 * The projection's order, as one exported comparator: negative when `a` is
 * earlier than `b`, zero when they are the same status, positive when `a` is
 * later. Defined ONLY over `TICKET_STATUSES` — hand it an unknown value and the
 * result is meaningless, which is why `hasProjected` screens both sides through
 * `statusRank` first rather than trusting the subtraction.
 *
 * Exported and used by everything that needs the order (the planner, T-29-04,
 * and any later reader): one definition, so a change to the order is a change in
 * one place.
 */
function compareStatus(a, b) {
  return statusRank(a) - statusRank(b);
}

// ── the store ───────────────────────────────────────────────────────────────

/**
 * The watermark store, `{ tickets: { "T-29-01": { projected_to, ts, key,
 * status, transition_id } } }`. A missing or unreadable file is an EMPTY store,
 * not an error: nothing has been projected yet is the normal first state, and a
 * torn read cannot happen (every write goes through `writeAtomic`).
 */
function load(dir = GRAPH_DIR) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    return raw && typeof raw === 'object' && raw.tickets ? raw : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
}

/** The watermark recorded for one ticket, or null. */
function projectionOf(ticket, store = load()) {
  const t = (store && store.tickets) || {};
  return Object.prototype.hasOwnProperty.call(t, ticket) ? t[ticket] : null;
}

/**
 * Has `ticket` already been projected AT OR PAST `to`?
 *
 * True means SKIP: either this exact change is already on the tracker, or the
 * board is further along than the change being replayed. Both are the same
 * ordinary outcome — the projection is exactly-once and forward-only, and this
 * is the single test that makes it both.
 *
 * An unrecognised status on EITHER side answers true, i.e. skip. That is the
 * safe direction and it is deliberate: a value outside `TICKET_STATUSES` can
 * only arrive from a hand-edited store or a caller that invented a status, and
 * in neither case is there evidence that the move is forwards. This store's job
 * is to refuse an unproven write into somebody's tracker, not to guess.
 */
function hasProjected(ticket, to, store = load()) {
  const rec = projectionOf(ticket, store);
  if (!rec || !rec.projected_to) return false;   // nothing projected yet
  if (statusRank(rec.projected_to) === -1 || statusRank(to) === -1) return true;
  return compareStatus(rec.projected_to, to) >= 0;
}

// The whole read-modify-write, under ONE lock and replaced by rename(2).
// Unsynchronized load→save loses updates — six concurrent marks reliably
// produced five records for drift-record, and a lost watermark is a ticket
// transitioned twice on somebody's board. writeAtomic on top, because a reader
// that opens this file mid-write must see the old snapshot rather than half of
// the new one; a torn read parses as an empty store, which reads as "nothing has
// been projected" and re-projects everything.
function mutate(fn, dir = GRAPH_DIR) {
  // The guard that makes a missing `--graph` LOUD. Same shape as the siblings',
  // including the `GRAPH_EXPLICIT` exemption: an explicit answer always wins,
  // because a cross-repo caller legitimately names a graph dir this process
  // cannot otherwise reach. Unlike them it lives on the WRITE path rather than
  // in the CLI dispatch, since every writer here is a library call — the verbs
  // that write (T-29-04/05) are not in this ticket, and a guard behind
  // `require.main` would therefore never fire.
  if (!GRAPH_EXPLICIT && dir === GRAPH_DIR && !fs.existsSync(path.join(dir, 'tickets.json'))) {
    throw new Error(
      `no ticket graph at ${dir} — refusing to record a projection nothing will read.\n` +
      '  The watermark belongs to the PROJECT\'s graph; one written in a worktree is invisible,\n' +
      '  so the next round re-projects the same change and the tracker is transitioned twice.\n' +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n' +
      '  (or set SHIPYARD_GRAPH_DIR).'
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  return withLock(lockDirFor(lockRootFor(dir)), 'jira-project', () => {
    const store = load(dir);
    const result = fn(store);
    writeAtomic(storeFile(dir), JSON.stringify(store, null, 2) + '\n');
    return result;
  }, { label: 'jira-project' });
}

/**
 * Advance the watermark for one ticket to `to`, recording WHAT was performed
 * (`key`, `status`, `transition_id`) alongside it.
 *
 * Returns `{written, reason, record}`. A backwards or already-projected move is
 * `written: false` and NOT an error — it is the whole point of the store, and
 * the caller's honest report is "nothing to do", not a failure.
 *
 * The forward-only test runs INSIDE the lock, against the store this call is
 * about to write. Reading it outside would be the same lost-update race the lock
 * exists for: two concurrent projections of the same ticket would both see "not
 * projected yet" and both perform.
 */
function markProjected(ticket, to, fields = {}, dir = GRAPH_DIR) {
  if (!ticket || !to) throw new Error('markProjected needs a ticket and a status');
  // A status the comparator cannot order must never ENTER the store. Refusing it
  // on read alone is not enough and the asymmetry bites: an unrecorded ticket
  // has nothing to compare against, so `hasProjected` answers false and the
  // unorderable value would be written — after which every real status for that
  // ticket reads as "already projected" and is skipped forever. A poisoned
  // record that never lifts is strictly worse than the refusal here.
  if (statusRank(to) === -1) {
    throw new Error(
      `"${to}" is not a ticket status (statuses: ${TICKET_STATUSES.join(', ')}) — `
      + 'refusing to record a watermark nothing can order. '
      + 'The front\'s bucket names (fix, finalize, merge, ci) are not statuses.'
    );
  }
  return mutate((store) => {
    if (hasProjected(ticket, to, store)) {
      const at = (projectionOf(ticket, store) || {}).projected_to;
      return {
        written: false,
        reason: `${ticket} is already projected to "${at}", which is at or past "${to}" — skipped`,
        record: projectionOf(ticket, store),
      };
    }
    const rec = {
      projected_to: to,
      ts: new Date().toISOString(),
      key: fields.key || null,
      status: fields.status || null,
      transition_id: fields.transition_id || null,
    };
    store.tickets[ticket] = rec;
    return { written: true, reason: null, record: rec };
  }, dir);
}

module.exports = {
  compareStatus, statusRank, hasProjected, markProjected, projectionOf, load,
  TICKET_STATUSES, STORE_NAME, GRAPH_DIR, ARGV,
};

if (require.main === module) {
  const [cmd, ...rest] = ARGV;

  // `read` is deliberately permissive about a missing ticket graph: it reads and
  // it never writes, so it can only report an empty store — there is no record to
  // strand anywhere. The refusal lives on the write path, where the damage is.
  if (cmd === 'read' || cmd === 'list') {
    const store = load();
    const tickets = store.tickets || {};
    if (rest.includes('--json')) {
      console.log(JSON.stringify(store, null, 2));
    } else if (!Object.keys(tickets).length) {
      console.log(`no projections recorded in ${storeFile(GRAPH_DIR)}`);
    } else {
      for (const [id, rec] of Object.entries(tickets)) {
        console.log(`${id}: ${rec.projected_to}${rec.key ? ` (${rec.key}` +
          `${rec.status ? ` → ${rec.status}` : ''}${rec.transition_id ? `, transition ${rec.transition_id}` : ''})` : ''}` +
          `${rec.ts ? ` at ${rec.ts}` : ''}`);
      }
    }
  } else {
    fail('usage: jira-project.cjs read [--json] [--graph <dir>]\n' +
      '  `plan` and `record` are not in this build.');
  }
}
