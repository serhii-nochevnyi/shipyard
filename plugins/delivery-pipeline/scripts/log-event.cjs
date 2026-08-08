#!/usr/bin/env node
'use strict';

// Append one conveyor telemetry event to .planning/graph/delivery-log.jsonl.
//
//   log-event.cjs <event> [key=value ...]
//
// Examples (what /shipyard:deliver logs — session-only facts GitHub can't
// reconstruct later):
//   log-event.cjs attempt ticket=T-02-03 pr=445 n=2 role=ci-fix model=opus outcome=pushed
//   log-event.cjs fix_round ticket=T-02-05 pr=447 outcome=no-op pushed=false
//   log-event.cjs escalation ticket=T-01-04 pr=441 reason="out-of-scope fix needed"
//   log-event.cjs reuse_scan ticket=T-02-03 hits=2 verdict=fresh
//
// status_change events are appended by state-sync.cjs automatically — do not
// log them by hand. The journal is append-only; pipeline-stats.cjs reads it.

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
