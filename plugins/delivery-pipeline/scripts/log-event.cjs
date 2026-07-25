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
//
// status_change events are appended by state-sync.cjs automatically — do not
// log them by hand. The journal is append-only; pipeline-stats.cjs reads it.

const fs = require('fs');
const path = require('path');

const GRAPH_DIR = path.join(process.cwd(), '.planning', 'graph');
const LOG = path.join(GRAPH_DIR, 'delivery-log.jsonl');

const [, , event, ...pairs] = process.argv;
if (!event || !/^[a-z][a-z0-9_-]*$/.test(event)) {
  console.error('usage: log-event.cjs <event> [key=value ...]   (event: lowercase slug)');
  process.exit(2);
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

fs.mkdirSync(GRAPH_DIR, { recursive: true });
fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
console.log(`logged ${event} → ${path.relative(process.cwd(), LOG)}`);
