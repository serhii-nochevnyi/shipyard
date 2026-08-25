#!/usr/bin/env node
'use strict';

// Append one conveyor telemetry event to .planning/graph/delivery-log.jsonl.
//
//   log-event.cjs <event> [key=value ...]
//
// Examples (what /shipyard:deliver logs — session-only facts GitHub can't
// reconstruct later):
//   log-event.cjs attempt ticket=T-02-03 pr=445 n=2 role=ci-fix model=opus signature=9f2a outcome=pushed
//   log-event.cjs fix_round ticket=T-02-05 pr=447 outcome=no-op pushed=false
//   log-event.cjs reuse_scan ticket=T-02-03 hits=2 verdict=fresh
//
// Some events belong to a script and are refused here — see OWNED_BY_SCRIPTS
// below, which says for each one what writing it by hand would break. The journal
// is append-only; pipeline-stats.cjs reads it.

const fs = require('fs');
const path = require('path');

// The journal belongs NEXT TO THE GRAPH, and only there. This used to be
// `process.cwd()/.planning/graph` with an unconditional mkdir, which is wrong
// wherever the conveyor actually runs its agents: a ci-fix working inside a
// cross-repo checkout logged one `attempt` into that borrowed repository,
// creating an untracked `.planning/` in someone else's tree and orphaning the
// event — `pipeline-stats` requires `tickets.json` beside the journal, so an
// event filed anywhere else is not merely misplaced, it is unreadable. Resolve
// explicitly, and refuse rather than invent a second journal.
//   1. SHIPYARD_GRAPH_DIR / --graph <dir>  — the caller knows the project root
//   2. <cwd>/.planning/graph               — only when the graph is really there
//   3. fail, saying where the event was about to go and why nobody would read it
function resolveGraphDir(argv) {
  const flagAt = argv.indexOf('--graph');
  // One spelling has to mean one PARSER — the same guard, in the same words, as
  // drift-record.cjs and escalation-record.cjs. A flag-shaped token is not a
  // directory: `--graph --json` used to resolve a directory literally called
  // "--json" AND count as explicit, so the refusal below was skipped and the
  // event was filed where pipeline-stats never looks, under `logged attempt`.
  // A trailing `--graph` was worse than useless: it fell back to the cwd, i.e.
  // the caller who passed the flag got the very default it was passed to
  // override. Exit 1, with the refusal below rather than the exit-2 usage
  // errors: this is "refusing to write where nobody will read", not a mistyped
  // key=value pair.
  if (flagAt !== -1) {
    const val = argv[flagAt + 1];
    if (val === undefined || val.startsWith('--')) {
      console.error(`log-event: --graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
      process.exit(1);
    }
  }
  const explicit = flagAt !== -1 ? argv[flagAt + 1] : process.env.SHIPYARD_GRAPH_DIR;
  if (explicit) return { dir: path.resolve(explicit), explicit: true };
  return { dir: path.join(process.cwd(), '.planning', 'graph'), explicit: false };
}

const argvAll = process.argv.slice(2);
const { dir: GRAPH_DIR, explicit: GRAPH_EXPLICIT } = resolveGraphDir(argvAll);
const LOG = path.join(GRAPH_DIR, 'delivery-log.jsonl');

// Strip `--graph <dir>` wherever it sits, so it is neither mistaken for the
// event name nor recorded as telemetry. Positional parsing that only tolerates
// a flag at the end is a trap for the caller who puts it first.
const ARGS = (() => {
  const out = [];
  for (let i = 0; i < argvAll.length; i++) {
    if (argvAll[i] === '--graph') { i++; continue; }
    out.push(argvAll[i]);
  }
  return out;
})();

const [event, ...pairs] = ARGS;
if (!event || !/^[a-z][a-z0-9_-]*$/.test(event)) {
  console.error('usage: log-event.cjs <event> [key=value ...] [--graph <dir>]   (event: lowercase slug)');
  process.exit(2);
}

// Events the deterministic layer writes for itself. `sentinel.cjs merge` and
// `state-sync.cjs` append these directly — neither goes through this CLI — so a
// hand-written one is always a DUPLICATE, never a rescue. deliver.md has said
// "do NOT log them by hand" since they existed and it happened anyway: two
// merges were double-logged in one morning, which inflated "sentinel landed N"
// and put an empty base in the summary, because the hand-written copy carries no
// `by` and no `base`. Refusing costs nothing — the real record is already there.
// `escalation` joined them for a different reason: journalling it by hand records
// the fact WITHOUT parking the ticket, so the next session inherits a metric and
// no verdict — which is how a ticket ended up parked with no journal entry and
// six journalled escalations ended up with no durable park. `plan_defect` is that
// same half-act one verdict over, and the flake trio is a third case again: those
// events ARE the quarantine — failure-signature.cjs keeps no store beside the
// journal — so a hand-written one duplicates nothing, it invents state the loop
// then reads back as a verdict.
//
// Three harms, three messages: the wording is what sends the reader to the right
// place, and "duplicate" pointed at a second record that, for two of these, was
// never written.
const duplicate = (e) =>
  'refusing to add a duplicate.\n' +
  '  The genuine record carries fields a hand-written one cannot (by, base), and counting both\n' +
  '  overstates what the guard actually did. If the real event is missing, that is a bug in\n' +
  `  ${e.by}, not something to paper over here.`;

// Not a duplicate: an incomplete act. The journal line is half of a park, and the
// half that leaves no verdict behind.
const halfAct = (e) =>
  `refusing a half-recorded ${e.kind}.\n` +
  '  Writing it here would record the fact without PARKING the ticket, so the next session\n' +
  '  inherits a metric and no verdict — and the front hands the ticket straight back.\n' +
  `  \`${e.fix}\` does both in one act.`;

// Not a duplicate and not half an act: the quarantine has NO store beside the
// journal, so these lines are the state itself. A hand-written one is a verdict
// invented outside the lock and outside the (ticket, signature, head) bookkeeping
// the rules match on — and the loop would read it back and believe it.
const forgedState = (e) =>
  'refusing to invent quarantine state.\n' +
  '  There is no second store: these events ARE what `failure-signature.cjs verdict` reads\n' +
  '  back, so a hand-written line is a verdict — written outside the lock and without the\n' +
  '  (ticket, signature, head) bookkeeping the rules match on. The loop would believe it.\n' +
  `  \`${e.fix}\` records it properly.`;

const OWNED_BY_SCRIPTS = {
  merge: { by: 'sentinel.cjs merge', why: duplicate },
  status_change: { by: 'state-sync.cjs', why: duplicate },
  escalation: {
    by: 'escalation-record.cjs mark', kind: 'escalation', why: halfAct,
    fix: 'escalation-record.cjs mark <ticket> <reason...>',
  },
  plan_defect: {
    by: 'escalation-record.cjs mark-plan-defect', kind: 'plan defect', why: halfAct,
    fix: 'escalation-record.cjs mark-plan-defect <ticket> <plan-path> <reason...>',
  },
  flake: {
    by: 'failure-signature.cjs rerun', why: forgedState,
    fix: 'failure-signature.cjs rerun <ticket> --signature <sig> --head <sha> --outcome green',
  },
  flake_rerun: {
    by: 'failure-signature.cjs rerun', why: forgedState,
    fix: 'failure-signature.cjs rerun <ticket> --signature <sig> --head <sha> --outcome red',
  },
  flake_lift: {
    by: 'failure-signature.cjs lift', why: forgedState,
    fix: 'failure-signature.cjs lift <ticket> --signature <sig>',
  },
};
if (OWNED_BY_SCRIPTS[event]) {
  const owner = OWNED_BY_SCRIPTS[event];
  console.error(`log-event: "${event}" events are written by ${owner.by} itself — ` + owner.why(owner));
  process.exit(1);
}

if (!GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) {
  console.error(
    `log-event: no ticket graph at ${GRAPH_DIR} — refusing to start a second journal there.\n` +
    `  An event filed away from the graph is unreadable, not merely misplaced: pipeline-stats\n` +
    `  requires tickets.json beside the journal, so it would never be counted.\n` +
    `  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n` +
    `  (or set SHIPYARD_GRAPH_DIR) — which is what a cross-repo or worktree agent must do.`
  );
  process.exit(1);
}

// Only plain decimal integers/floats become numbers. `Number()` also accepts
// "0x10", "1e5", "Infinity" and " 5 ", which would rewrite a ticket-ish value
// into something the stats reader cannot match back (and Infinity JSON-encodes
// as null, losing the field outright).
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

const rec = { ts: new Date().toISOString(), event };
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    console.error(`log-event: malformed pair "${pair}" (expected key=value)`);
    process.exit(2);
  }
  const key = pair.slice(0, eq);
  if (!/^[A-Za-z][\w-]*$/.test(key) || key === 'ts' || key === 'event') {
    console.error(`log-event: bad key "${key}"`);
    process.exit(2);
  }
  rec[key] = coerce(pair.slice(eq + 1));
}

// An invented role is not a labelling nit: `pipeline-config.cjs model <role>`
// rejects anything outside the set, so a dispatch logged under one resolved no
// model from role × risk × attempt — a human picked it by hand and the ladder
// never applied. The journal still takes the event (telemetry must not lose a
// real attempt over its label), but it stops being silent about it.
if (rec.role) {
  try {
    const { ROLES } = require(path.join(__dirname, 'pipeline-config.cjs'));
    if (!ROLES.includes(rec.role)) {
      console.error(
        `log-event: WARNING role "${rec.role}" is not a pipeline role, so the model ladder did not resolve this ` +
        `dispatch. Known roles: ${ROLES.join(', ')}. Logging it anyway; pipeline-stats will report it.`
      );
    }
  } catch { /* resolver unavailable — never block telemetry on it */ }
}

fs.mkdirSync(GRAPH_DIR, { recursive: true });
fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
// Relative only while it stays inside cwd; a `--graph` elsewhere otherwise
// prints a ladder of `../..` that tells the operator nothing about where the
// event actually went.
const shown = path.relative(process.cwd(), LOG);
console.log(`logged ${event} → ${shown.startsWith('..') ? LOG : shown}`);
