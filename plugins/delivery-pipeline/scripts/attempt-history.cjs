#!/usr/bin/env node
'use strict';

// Render what has already been tried on ONE ticket, as data for the next fixer.
//
//   attempt-history.cjs <ticket> [--json] [--limit <n>] [--graph <dir>]
//
// Why this exists (ADR-001 D5): a fresh subagent per attempt is the right call
// for context hygiene, and it is precisely why attempt 3 can re-propose the fix
// attempt 1 already tried and lost. The remedy is not a longer-lived repair
// agent — it is prior attempts handed over as INPUT. The journal already holds
// them, so this is a reader, not a new store: filter
// `.planning/graph/delivery-log.jsonl` to one ticket's repair events and render
// them compactly enough to paste into the next fixer's prompt.
//
//   attempt n=2 role=ci-fix model=opus signature=ab12cd34 outcome=pushed \
//     hypothesis="off-by-one in the pagination cursor"
//
// Fields are rendered ONLY when the event carries them. Events written before
// `signature`/`hypothesis` existed render without them, and a ticket nobody has
// attempted yet prints one line and exits 0 — an empty or partial history is
// the normal state of young work, not a failure to report.
//
// The orchestrator produces this string and passes it into the fix round
// (`prs[].attemptHistory`); the Workflow path builds prompts deterministically
// and must not shell out for itself.

const fs = require('fs');
const path = require('path');

const argvAll = process.argv.slice(2);

const USAGE = 'usage: attempt-history.cjs <ticket> [--json] [--limit <n>] [--graph <dir>]';

function usage(msg) {
  console.error(`attempt-history: ${msg}\n${USAGE}`);
  process.exit(2);
}

// The journal is only meaningful BESIDE its graph, so resolve where to read it
// exactly as log-event.cjs resolves where to write it — one convention for
// "which graph does this belong to", so a caller who learns it once is right
// everywhere:
//   1. --graph <dir> / SHIPYARD_GRAPH_DIR — the caller knows the project root
//   2. <cwd>/.planning/graph              — only when the graph is really there
//   3. refuse, rather than report an empty history that is merely a wrong turn
// A fixer reads this from a ticket WORKTREE, which has no .planning/ of its own
// when the project keeps it untracked; silently answering "no prior attempts"
// there would be the exact defect this record exists to prevent, dressed as a
// clean slate.
const graphFlagAt = argvAll.indexOf('--graph');
// `--graph` immediately followed by another flag (e.g. `--graph --json`) must
// not be read as an explicit value: the flag-stripping loop below skips
// exactly one token after `--graph` unconditionally, so `--json` would be
// silently consumed as the "directory", disabling JSON mode AND resolving
// GRAPH_DIR to a nonexistent path outside cwd/.planning — which reads back as
// an empty history from nowhere rather than the refusal it should be. Found
// by Copilot's review of this PR.
if (graphFlagAt !== -1) {
  const val = argvAll[graphFlagAt + 1];
  if (val === undefined || val.startsWith('--')) {
    usage(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
  }
}
const explicitGraph = graphFlagAt !== -1 ? argvAll[graphFlagAt + 1] : process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_EXPLICIT = !!explicitGraph;
const GRAPH_DIR = GRAPH_EXPLICIT
  ? path.resolve(explicitGraph)
  : path.join(process.cwd(), '.planning', 'graph');

// Both value-taking flags are stripped wherever they sit: a flag only tolerated
// at the end is a trap for the caller who puts it first, and here it would be
// read as the ticket id.
let asJson = false;
let limitRaw = null;
const positional = [];
for (let i = 0; i < argvAll.length; i++) {
  const a = argvAll[i];
  if (a === '--graph') { i++; continue; }
  if (a === '--limit') { limitRaw = argvAll[++i]; continue; }
  if (a === '--json') { asJson = true; continue; }
  positional.push(a);
}

const ticket = positional[0];
if (!ticket) usage('a ticket id is required');
if (positional.length > 1) usage(`unexpected argument "${positional[1]}"`);

let limit = null;
if (limitRaw !== null) {
  if (!/^\d+$/.test(String(limitRaw)) || Number(limitRaw) === 0) {
    usage(`--limit takes a positive integer, got "${limitRaw === undefined ? '' : limitRaw}"`);
  }
  limit = Number(limitRaw);
}

if (!GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) {
  console.error(
    `attempt-history: no ticket graph at ${GRAPH_DIR} — refusing to report an empty history from here.\n` +
    `  "No prior attempts" read out of the wrong directory is indistinguishable from a fresh ticket,\n` +
    `  which is how a fixer ends up re-proposing a fix that already failed.\n` +
    `  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n` +
    `  (or set SHIPYARD_GRAPH_DIR) — which is what a cross-repo or worktree agent must do.`
  );
  process.exit(1);
}

// The repair record: what was tried, how it went, and why it stopped. Anything
// else in the journal (reuse_scan, status_change, merge) describes the ticket's
// PROGRESS, not an attempt at a fix, and rendering it here would read as one.
const REPAIR_EVENTS = new Set([
  'attempt', 'fix_round', 'escalation', 'plan_defect', 'flake', 'flake_rerun', 'flake_lift',
]);

const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
const raw = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n') : [];

// A truncated line from a killed writer loses one event, never the record.
const events = [];
for (const line of raw) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  if (!rec || typeof rec !== 'object') continue;
  if (rec.ticket !== ticket || !REPAIR_EVENTS.has(rec.event)) continue;
  events.push(rec);
}

// Chronological, with file order as the tiebreak. The journal is append-only,
// but two processes write it (the main loop and the guard, from different
// worktrees), so a late-arriving line is possible; an event with no usable `ts`
// keeps the position it was appended at rather than floating to an end.
let carried = 0;
const ordered = events
  .map((e, i) => {
    const t = Date.parse(e.ts || '');
    if (!Number.isNaN(t)) carried = t;
    return { e, i, t: Number.isNaN(t) ? carried : t };
  })
  .sort((a, b) => (a.t - b.t) || (a.i - b.i))
  .map((d) => d.e);

// The most RECENT n — trimming the head, and still reading oldest-first: the
// order is what shows a fixer that a hypothesis was tried and did not hold.
const shown = limit === null ? ordered : ordered.slice(-limit);

if (asJson) {
  // Raw means raw, and an empty set is `[]`. A JSON consumer must never be
  // handed the prose line below.
  console.log(JSON.stringify(shown, null, 2));
  process.exit(0);
}

if (!shown.length) {
  console.log(`no prior attempts recorded for ${ticket}`);
  process.exit(0);
}

// Read order for a human and for a fixer alike: what round, who ran it, what it
// believed, how it ended. Unknown keys still render (T-20-01/T-20-06 add to the
// attempt event, and a field this reader has not heard of is still evidence);
// `ts`, `event` and `ticket` are the line itself or its subject, and `by` is
// provenance the fixer cannot act on.
const HIDDEN = new Set(['ts', 'event', 'ticket', 'by']);
const ORDER = ['n', 'role', 'model', 'pr', 'signature', 'head', 'outcome', 'pushed', 'verdict', 'reason', 'hypothesis'];

// A hypothesis is a sentence. Quoted, it stays ONE field instead of shredding
// the line it lives on into unreadable fragments.
const value = (v) => {
  const s = String(v);
  return s === '' || /[\s"]/.test(s) ? JSON.stringify(s) : s;
};

for (const e of shown) {
  const keys = [
    ...ORDER.filter((k) => Object.prototype.hasOwnProperty.call(e, k)),
    ...Object.keys(e).filter((k) => !HIDDEN.has(k) && !ORDER.includes(k)),
  ];
  const parts = [];
  for (const k of keys) {
    const v = e[k];
    if (v === null || v === undefined) continue; // e.g. an escalation with no PR yet
    parts.push(`${k}=${value(v)}`);
  }
  console.log([e.event, ...parts].join(' '));
}
