#!/usr/bin/env node
'use strict';

// jira-project.cjs — the WATERMARK for the tracker projection (ADR-008 D1).
//
//   jira-project.cjs read [--json] [--graph <dir>]
//   jira-project.cjs plan [--json] [--graph <dir>]
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
// `plan` (T-29-04) is now here too — the read-only half that computes the work
// from three LOCAL files and emits it. `record` (T-29-05) is not, and nothing in
// this file speaks to a tracker: no socket, no client, no credential. The acting
// half is an agent's, by ADR-008 D4.

const fs = require('fs');
const path = require('path');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
const { TICKET_STATUSES, loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));

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

// ── the planner ─────────────────────────────────────────────────────────────
//
// (ADR-008 D3.) `plan` is a pure function of THREE LOCAL FILES — the journal,
// `tickets.json` and the config — and it is deliberately the largest half of
// this feature, because it is the half a test can prove with no tracker, no
// credential and no stub. Nothing below opens a socket; the negative pin from
// T-29-01 and a token sweep in this script's own test both watch that.

const JOURNAL_NAME = 'delivery-log.jsonl';
const TICKETS_NAME = 'tickets.json';

// The project a graph belongs to: `<project>/.planning/graph` → `<project>`.
// The same walk `lockRootFor` does, and for the same reason — everything read
// here besides the journal lives at the PROJECT root, never at cwd, and the
// documented caller of this verb stands wherever the main loop left it. Reuses
// `lockRootFor` rather than re-declaring an identical body, so the two callers
// cannot drift apart.
const projectRootFor = lockRootFor;

// How much of the journal ONE backward step adds. It is a STEP SIZE and never a
// bound, which is the whole distinction this script draws against
// `stop-gate.cjs`'s `JOURNAL_TAIL_BYTES = 64 * 1024`: that number is a HOOK's
// ~75ms budget, and the scan below keeps stepping until the window covers every
// watermark or holds the whole file. This repository's own journal is already
// 139 KB / 806 events — more than double a 64 KB tail — so a bounded read here
// would silently drop transitions and quietly falsify ADR-008 D6's justification
// ("catch-up is free"). A projection that loses transitions without saying so is
// worse than one that never ran.
const SEEK_STEP_BYTES = 64 * 1024;

// Where the store keeps the unreachable reports T-29-05 writes and this planner
// reads. TOP-LEVEL, beside `tickets`, deliberately: `markProjected` replaces
// `store.tickets[ticket]` wholesale, so a report nested under it would be erased
// by an unrelated advance — and the two facts have different lifetimes anyway.
const UNREACHABLE_KEY = 'unreachable';

/**
 * The `status_change` records in one slab of journal text.
 *
 * `seeked` is stop-gate.cjs's lesson, taken exactly and no further: a read that
 * started mid-file lands mid-line, so the first line is a fragment — and ONLY
 * then. Dropping it unconditionally ate the only event in a short journal, which
 * is every project that has not been running for weeks, and the test caught it.
 * An unparseable line is skipped rather than fatal for the same reason: the tail
 * of a journal being appended to right now is legitimately half-written.
 */
function statusChangesIn(text, seeked) {
  const lines = text.split('\n');
  if (seeked) lines.shift();
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (!e || e.event !== 'status_change' || !e.ticket) continue;
    out.push(e);
  }
  return out;
}

/**
 * The journal's `status_change` stream, read from the OLDEST watermark forward.
 *
 * `watermarks` is `ticket → projected_to | null` over the SUBJECT tickets only.
 * A single subject with no watermark means the whole file: there is no point in
 * the stream we can prove has already been consumed for it.
 *
 * THE ANCHOR IS THE PROJECTED EVENT, NEVER THE WATERMARK'S `ts`. `markProjected`
 * stamps RECORD time, which is an upper bound on the event's time and not the
 * event's time: a sync landing between the plan and the record writes an event
 * older than the record that was never projected, and a scan that stopped at the
 * record's timestamp would leave that event outside the window — unreadable, so
 * `hasProjected` could never rescue it. That is the "loses transitions without
 * saying so" defect one round-trip narrower than the 64 KB tail. So the scan
 * stops on OBJECT IDENTITY instead: it steps backwards until the window holds,
 * for every watermarked subject, a `status_change` whose `to` is that ticket's
 * `projected_to` — and otherwise walks all the way to byte 0.
 */
function readTransitions(dir, watermarks) {
  const file = path.join(dir, JOURNAL_NAME);
  let size;
  try { size = fs.statSync(file).size; } catch {
    // No journal is no work, never an error: a project that has not synced yet
    // has nothing to project.
    return { events: [], seeked: false, start: 0, size: 0 };
  }

  const readFrom = (start) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, size - start));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  };

  const need = new Map();
  let anchored = watermarks.size > 0;
  for (const [ticket, projectedTo] of watermarks) {
    if (!projectedTo) { anchored = false; break; }
    need.set(ticket, projectedTo);
  }
  if (!anchored) {
    return { events: statusChangesIn(readFrom(0), false), seeked: false, start: 0, size };
  }

  let start = Math.max(0, size - SEEK_STEP_BYTES);
  for (;;) {
    const seeked = start > 0;
    const events = statusChangesIn(readFrom(start), seeked);
    // Byte 0 is the end of the walk whatever the window holds: a watermark whose
    // event is not in the journal at all (a hand-seeded store, a rotated file)
    // must degrade to reading everything, not spin.
    if (!seeked) return { events, seeked, start, size };
    let covered = 0;
    const seen = new Set();
    for (const e of events) {
      if (seen.has(e.ticket)) continue;
      if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }
    }
    if (covered === need.size) return { events, seeked, start, size };
    start = Math.max(0, start - SEEK_STEP_BYTES);
  }
}

/**
 * The unreachable report recorded for one ticket, or null. Written by
 * `jira-project.cjs record --unreachable` (T-29-05) as
 * `{to, ts, key, offered}`, where `ts` is THE ITEM'S EVENT TIMESTAMP copied
 * straight out of this planner's output — not the time the report was filed.
 * Same argument as the seek anchor above: a filing time is an upper bound on the
 * event it is about, so a sync landing in between would produce genuinely new
 * information that a filing-time comparison suppresses.
 */
function unreachableFor(ticket, store) {
  const u = (store && store[UNREACHABLE_KEY]) || {};
  return Object.prototype.hasOwnProperty.call(u, ticket) ? u[ticket] : null;
}

/**
 * The record T-29-05 writes, built HERE so the reader and the writer cannot
 * disagree about a field name. `ts` must be the plan item's `ts`.
 */
function unreachableRecord({ to, ts, key = null, offered = null }) {
  return { to, ts: ts || null, key, offered };
}

/**
 * Is this pending item suppressed by an unreachable report?
 *
 * The pair `plan` + `record --unreachable` is a RETRY LOOP WEARING A REPORT'S
 * HAT unless something stops it: the item is re-emitted every round, the agent
 * asks the tracker for transitions again, records unreachable again, forever —
 * one tracker call per stuck ticket per round, which is exactly the "never retry
 * hard" ADR-008 D4 forbids. So the item is withheld until the WORLD MOVES, which
 * is `escalation-record.cjs`'s fingerprint-expiry shape over a different
 * subject: the block lifts by itself, and nobody has to remember to clear it.
 *
 * "The world moved" is a different `to`, or the same `to` reached by a strictly
 * newer `status_change`. An unusable `ts` on the record falls back to the `to`
 * test alone — a report we cannot date must still lift when the board moves on,
 * because a suppression that never lifts is worse than one round of noise.
 */
function unreachableSuppressed(item, store) {
  const rec = unreachableFor(item.ticket, store);
  if (!rec || !rec.to) return false;
  if (rec.to !== item.to) return false;
  const at = Date.parse(rec.ts);
  const now = Date.parse(item.ts);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return true;
  return !(now > at);
}

/**
 * The work list: what should be transitioned on the tracker, and nothing else.
 *
 * Returns `{graph, enabled, reason, items, warnings}`. `items` carry
 * `{ticket, key, from, to, target_status, ts}` — `ts` is the driving event's,
 * and it is in the item because T-29-05's unreachable report is anchored on it.
 *
 * Every off-switch answers with an EMPTY LIST and exit 0, never a warning OF
 * ITS OWN: this runs once per round, the common case is zero work, and a
 * mechanism that complains on every round of every unconfigured project
 * teaches its reader to skip the output. `loadConfig`'s own diagnostics
 * (unknown keys, a malformed entry it skipped) are a different fact — a real
 * misconfiguration, not the quiet common case — and are carried through
 * regardless of whether the projection ends up on or off.
 */
function planItems(dir = GRAPH_DIR) {
  const out = { graph: dir, enabled: true, reason: null, items: [], warnings: [] };
  const root = projectRootFor(dir);
  const { config, valid, error, warnings: configWarnings } = loadConfig(root);

  // ADR-004 D2: a corrupt configuration permits no mutation, and transitioning
  // somebody's board is a mutation. One line, because this one IS worth saying —
  // it is not the quiet common case, it is a broken file.
  if (!valid) {
    out.enabled = false;
    out.reason = `${error && error.relative} is invalid (${error && error.message}) — no policy is in effect, so nothing is projected`;
    out.warnings.push(out.reason);
    return out;
  }
  // The config parsed: carry loadConfig's own warnings (unknown keys, a
  // non-alias tier, …) through rather than discarding them — a misconfiguration
  // that isn't fatal must not look like a silent off-switch with no diagnostic
  // context.
  out.warnings.push(...(configWarnings || []));
  if (config.jira.enabled === false) {
    out.enabled = false;
    out.reason = 'pipeline.jira.enabled is false';
    return out;
  }
  const map = config.jira_transitions || {};
  if (!Object.keys(map).length) {
    out.enabled = false;
    out.reason = 'pipeline.jira_transitions is empty, which is the projection switched off (the default)';
    return out;
  }

  // The subjects: tickets carrying a `delivery.jira` key. A ticket without one
  // is NOT a subject and NOT a warning — ADR-008 D1 says so in as many words.
  let tickets = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, TICKETS_NAME), 'utf8'));
    tickets = (raw && raw.tickets) || {};
  } catch {
    out.reason = `no ${TICKETS_NAME} at ${dir} — nothing is a subject`;
    return out;
  }
  const keyOf = new Map();
  for (const [id, t] of Object.entries(tickets)) {
    if (t && t.jira) keyOf.set(id, String(t.jira));
  }
  if (!keyOf.size) {
    out.reason = 'no ticket carries a jira key';
    return out;
  }

  const store = load(dir);
  const watermarks = new Map();
  for (const id of keyOf.keys()) {
    const rec = projectionOf(id, store);
    watermarks.set(id, (rec && rec.projected_to) || null);
  }

  const { events, seeked, start, size } = readTransitions(dir, watermarks);
  out.journal = { bytes_read: size - start, size, seeked };

  // COLLAPSE, in append order. Several `status_change`s for one ticket since the
  // watermark produce ONE item at the LATEST status: a board that moved
  // `pending` → `branched` → `pr-open` between two runs must not walk the issue
  // through three transitions. Append order is the truth here rather than the
  // timestamp — the journal is append-only and state-sync writes a whole round's
  // transitions with one `nowIso`, so several events legitimately share a `ts`.
  const latest = new Map();
  const earliest = new Map();
  for (const e of events) {
    if (!keyOf.has(e.ticket)) continue;
    if (!earliest.has(e.ticket)) earliest.set(e.ticket, e);
    latest.set(e.ticket, e);
  }

  for (const [ticket, e] of latest) {
    // An unmapped `to` is skipped SILENTLY: an operator who mapped only `merged`
    // asked for only `merged`.
    const target = Object.prototype.hasOwnProperty.call(map, e.to) ? map[e.to] : null;
    if (!target) continue;
    // Exactly-once and forward-only, in OUR order — T-29-03's single comparator.
    if (hasProjected(ticket, e.to, store)) continue;
    const wm = projectionOf(ticket, store);
    const item = {
      ticket,
      key: keyOf.get(ticket),
      // What the tracker was last TOLD, when we know it; otherwise where the
      // collapsed run started. Informational either way — the transition is
      // chosen by `to`, never by `from`.
      from: (wm && wm.projected_to) || (earliest.get(ticket) || {}).from || null,
      to: e.to,
      target_status: target,
      ts: e.ts || null,
    };
    if (unreachableSuppressed(item, store)) continue;
    out.items.push(item);
  }
  out.items.sort((a, b) => (a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0));
  return out;
}

module.exports = {
  compareStatus, statusRank, hasProjected, markProjected, projectionOf, load,
  planItems, readTransitions, statusChangesIn,
  unreachableFor, unreachableRecord, unreachableSuppressed,
  TICKET_STATUSES, STORE_NAME, UNREACHABLE_KEY, GRAPH_DIR, ARGV,
  SEEK_STEP_BYTES, JOURNAL_NAME, TICKETS_NAME,
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
  } else if (cmd === 'plan') {
    const out = planItems();
    if (rest.includes('--json')) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const w of out.warnings) process.stderr.write(`jira-project: ${w}\n`);
      if (!out.items.length) {
        // A report, never a warning: zero work is the common case, once a round.
        console.log(`nothing to project${out.reason ? ` — ${out.reason}` : ''}`);
      } else {
        console.log(`${out.items.length} pending projection${out.items.length === 1 ? '' : 's'}:`);
        for (const it of out.items) {
          console.log(`  ${it.ticket} ${it.key}: ${it.from || '(nothing)'} -> ${it.to}` +
            `  =>  target status ${JSON.stringify(it.target_status)}`);
        }
      }
    }
  } else {
    fail('usage: jira-project.cjs read|plan [--json] [--graph <dir>]\n' +
      '  `record` is not in this build.');
  }
}
