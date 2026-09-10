#!/usr/bin/env node
'use strict';

// Append one conveyor telemetry event to .planning/graph/delivery-log.jsonl.
//
//   log-event.cjs <event> [key=value ...]
//
// Examples (what /shipyard:deliver logs — session-only facts GitHub can't
// reconstruct later):
//   log-event.cjs attempt ticket=T-02-03 pr=445 n=2 role=ci-fix model=opus signature=9f2a outcome=pushed effort_applied=max
//   log-event.cjs fix_round ticket=T-02-05 pr=447 outcome=no-op pushed=false
//   log-event.cjs reuse_scan ticket=T-02-03 hits=2 verdict=fresh
//   log-event.cjs base_merge ticket=T-02-03 pr=445 base=epic/02-x head=$(git rev-parse HEAD)
//
// `base_merge` is the guard's `base-merge` duty recording itself: a moved base
// merged into a ticket branch. It went out under an ad-hoc slug for a while
// because the alternative was logging it as an `attempt` — which would charge a
// mechanical merge to the ticket's REPAIR record, spending an attempt from the
// budget on work no hypothesis was ever wrong about (`attempt-history.cjs`
// deliberately does not count it). Declared here so the name is one every reader
// already knows, and so the four fields that make it readable are named
// somewhere other than a prompt.
//
// Some events belong to a script and are refused here — see OWNED_BY_SCRIPTS
// below, which says for each one what writing it by hand would break. The journal
// is append-only; pipeline-stats.cjs reads it.
//
// Every sha it records is the FULL FORTY characters, on write — see SHA_FIELDS.

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
//
// Two clauses are per-event and both DEFAULT to the park's wording, so the
// escalation and plan-defect messages are byte-identical to what they have always
// been: `otherHalf` names the half a hand-written line skips, and `lost` names
// what the next session is then missing. `dispatch` is the third member and skips
// a different half — the durable record the front reads — for the same reason and
// with the same consequence in the last clause: the ticket is handed straight
// back.
const halfAct = (e) =>
  `refusing a half-recorded ${e.kind}.\n` +
  `  Writing it here would record the fact without ${e.otherHalf || 'PARKING the ticket'}, so the next session\n` +
  `  inherits a metric and no ${e.lost || 'verdict'} — and the front hands the ticket straight back.\n` +
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
  // `dispatch` is a half-act one store over, and it is the entry this repository
  // asserted was already here: T-25-05's own plan said `log-event.cjs` refuses it
  // ("it refuses the events other scripts own"), a reviewer ran the command, and
  // the line landed in the journal. What a hand-written one costs is everything
  // `dispatch-record.cjs mark` does BESIDE the journal line — the durable record
  // `activeDispatches` reads, the front refresh that moves the ticket out of
  // `execute`, and the validation of the role, the tier, the effort pair and the
  // agent file. So the metric says an agent holds the ticket while the board
  // offers it as work to start, which is the exact defect that store was built for.
  dispatch: {
    by: 'dispatch-record.cjs mark', kind: 'dispatch', why: halfAct,
    otherHalf: 'MARKING the ticket as held',
    lost: 'record',
    fix: 'dispatch-record.cjs mark <ticket> <role> --model <alias> --effort <level>',
  },
  // `jira_transition` is the same half-act, one store further out, and the half
  // it skips is the one that makes the projection exactly-once. A hand-written
  // line records that somebody's issue was moved and leaves `jira-projection.json`
  // untouched — so the planner offers the identical item on the next round and the
  // agent transitions the issue a second time, on somebody else's board. It is
  // also the line that would carry no `transition_id` anybody checked: the whole
  // point of the verb is that an agent which cannot name the id it used has not
  // produced evidence (ADR-008 D5).
  jira_transition: {
    by: 'jira-project.cjs record', kind: 'tracker projection', why: halfAct,
    otherHalf: 'ADVANCING the watermark',
    lost: 'record',
    fix: 'jira-project.cjs record <ticket> <key> --to <status> --transition-id <id> --status <name>',
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

// ── ONE SHA FORMAT: the full forty characters ────────────────────────────────
//
// Measured in this project's own journal before the rule existed: `head` appeared
// at 40, 7 AND 6 characters, across `attempt`, `base_merge` and `arch_review`.
// The direction of the loss is what settles the format — `gate_status` records the
// full forty (gate-trailer.cjs's `normSha`), and its own comment says a reader
// cannot lengthen an abbreviation, so a journal holding both formats cannot be
// compared against a trailer or a `headRefOid` at all. ADR-002 D5 binds an
// architecture verdict to the head it judged, so the first reader to make that
// comparison gets a FALSE MISMATCH — a verdict that looks stale when it is not,
// which is the failure that gate exists to prevent. Refused rather than padded,
// because padding is the lengthening that is impossible.
//
// The set is keyed EXPLICITLY, never guessed from the key name or the value:
// `signature` is failure-signature.cjs's four hex characters and appears on
// nineteen journal lines, and a rule that matched hex-looking values would refuse
// every one of them. Add a key here when a writer starts recording a second sha.
const SHA_FIELDS = new Set(['head', 'head_sha']);
const FULL_SHA = /^[0-9a-fA-F]{40}$/;

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
  const raw = pair.slice(eq + 1);
  if (SHA_FIELDS.has(key) && raw !== '') {
    // An EMPTY value is absence, not a bad sha — `DECLARED_FIELDS` below already
    // says so for the event that declares the key, and refusing here would turn a
    // missing field into a lost event.
    if (!FULL_SHA.test(raw)) {
      console.error(
        `log-event: "${key}=${raw}" is ${raw.length} characters — the journal records a sha as the full 40.\n` +
        '  `gate_status` records it that way and a reader holding only the journal cannot lengthen an\n' +
        '  abbreviation, so the two formats never compare and a live verdict reads as stale.\n' +
        `  Pass the full sha: ${key}=$(git rev-parse HEAD) (never --short), or origin's own 40-character oid.`
      );
      process.exit(1);
    }
    // Validated and written from the RAW text, lower-cased: two spellings of one
    // sha do not compare either, and `coerce` would turn an all-decimal sha into
    // a Number — a forty-digit one JSON-encodes as 1.1111111111111112e+39, which
    // is the very loss this rule exists to prevent.
    rec[key] = raw.toLowerCase();
    continue;
  }
  rec[key] = coerce(raw);
}

// The fields a DECLARED event needs to be worth reading back. Warned about, not
// refused — same rule as the role check below, and for the same reason: losing a
// real event over its label is the more expensive mistake, and a half-labelled
// line is still evidence that the act happened. But `base_merge` with no `base`
// cannot answer the one question anyone asks of it ("which base moved in, into
// which head"), so it stops being silent.
const DECLARED_FIELDS = {
  base_merge: ['ticket', 'pr', 'base', 'head'],
};
const declared = DECLARED_FIELDS[event];
if (declared) {
  const missing = declared.filter((k) => rec[k] === undefined || rec[k] === '');
  if (missing.length) {
    console.error(
      `log-event: WARNING ${event} declares ${declared.join(', ')} and this one is missing ` +
      `${missing.join(', ')} — logging it anyway, but a reader cannot reconstruct what happened. ` +
      `Full form: log-event.cjs ${event} ${declared.map((k) => `${k}=…`).join(' ')}`
    );
  }
}

// ── the depth an escalation rests on (ADR-007 D2) ────────────────────────────
//
// `repeat_exhausted` claims the deeper effort has already been spent on one
// failure signature, and `failure-signature.cjs verdict` proves that claim off
// THIS row: a prior `attempt` carrying the signature whose `effort_applied` names
// a real level. So the field belongs to this writer's vocabulary, and it is the
// same vocabulary `dispatch-record.cjs` checks `--effort-applied` against — one
// list, two writers, or the rows cannot be read together (ADR-006 D5).
//
// WARNED, never refused, and the direction matters both ways. A refusal would lose
// the whole `attempt` row, and that row is what CHARGES the attempt:
// `attempt-history.cjs` derives `next_n` from it, so a lost row freezes the
// counter the oscillation backstop reads — the one thing that stops a signature
// that alternates. The reader's own rule then treats a level it does not
// recognise exactly as it treats absence: no evidence, therefore rethink again
// rather than escalate early. So the cost of a typo is one more paid round, and
// the cost of refusing is an unbounded loop.
//
// `unknown` is a VALUE, not a mistake: the Agent tool has no effort parameter, so
// an Agent-dispatched fixer runs at the session's own depth whatever the ladder
// chose, and that row's honest content is "nobody measured this". An EMPTY value
// is absence, the same rule the sha fields use. Neither is warned about, and
// neither is declared — a DECLARED_FIELDS entry would fire on every honest row.
const EFFORT_FIELDS = new Set(['effort_applied']);
const UNMEASURED_EFFORT = 'unknown';
for (const key of EFFORT_FIELDS) {
  // An empty value is absence — but a KEY holding `""` is still present, and a
  // reader that checks presence (`"effort_applied" in e`, deliver.md's ladder
  // query) would read that as CONFIRMED with a blank level rather than
  // UNCONFIRMED. So "empty" and "omitted" must produce the same record, not
  // merely the same silence: delete the key rather than leave it holding ''.
  if (rec[key] === '') { delete rec[key]; continue; }
  const level = rec[key];
  if (level === undefined || level === UNMEASURED_EFFORT) continue;
  try {
    const { EFFORTS } = require(path.join(__dirname, 'pipeline-config.cjs'));
    if (!EFFORTS.includes(level)) {
      console.error(
        `log-event: WARNING ${key}="${level}" is not an effort level, so nothing reads it as one: ` +
        `\`failure-signature.cjs verdict\` treats an unrecognised level exactly as it treats an absent ` +
        `field, which withholds \`repeat_exhausted\` and rethinks again instead. Logging it as written. ` +
        `Levels: ${EFFORTS.join(', ')}, or "${UNMEASURED_EFFORT}" where the spawn could carry no effort.`
      );
    }
  } catch { /* resolver unavailable — never block telemetry on it */ }
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
