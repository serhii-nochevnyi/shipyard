#!/usr/bin/env node
'use strict';

// failure-signature.cjs — what a CI failure IS, and what its history means.
//
//   failure-signature.cjs compute [--log <file>] [--job <name>] [--json]      [--graph <dir>]
//   failure-signature.cjs verdict <ticket> --signature <sig> --head <sha>
//                                 [--k <n>] [--json]                          [--graph <dir>]
//   failure-signature.cjs rerun   <ticket> --signature <sig> --head <sha>
//                                 --outcome green|red [--job <name>]          [--graph <dir>]
//   failure-signature.cjs lift    <ticket> --signature <sig>                  [--graph <dir>]
//
// Why this exists (ADR-001, D1 and D3). The repair policy read an attempt COUNT:
// `attempt >= 2 → opus`. That is "try harder", and the loss it produces is the
// same wrong hypothesis re-tried by three models in sequence — phase 19's
// T-19-05 spent four attempts and three escalations on ONE deterministically
// failing job. A count cannot tell progress from repetition, and it cannot see
// the third case at all: the same job failing on an unchanged tree, which is
// instability rather than a defect and must not be charged as an attempt.
//
// So a failure is identified by a normalized SIGNATURE — error class + test/job
// id + file, hashed — and the policy reads that signature's HISTORY:
//
//   changed              → progress; hold the tier, continue
//   same twice           → repeat; change STRATEGY, not tier (T-20-02)
//   same at the same HEAD→ flake_candidate; re-run the job once before dispatching
//   K distinct, no green → plan_defect; a person in the morning, not now (T-20-03)
//
// Three properties are load-bearing, and each is pinned by a test:
//
//  1. NORMALIZATION BEFORE EXTRACTION. Two prints of one failure differ by
//     timestamps, ANSI colour, durations, line:column suffixes and the absolute
//     prefix of whichever checkout produced them. Any of those reaching the hash
//     makes every re-run look like "progress", and the policy never notices it is
//     repeating itself — the exact defect being replaced, rebuilt from noise.
//
//  2. `compute` NEVER FAILS. An unparseable log, an empty log, a `--log` file
//     that is not there: all yield a degraded (`unknown`) signature and exit 0.
//     Same ethos as state-sync treating `gh pr checks` exit codes as data — a
//     babysit round that aborts at 3am costs more than a coarse signature does.
//     It also needs no ticket graph: the fixer that computes a signature stands
//     in a WORKTREE, which has no `.planning/` at all.
//
//  3. THE JOURNAL IS THE RECORD. The quarantine has no store of its own (D2's
//     "no new subsystem", applied one decision over): `flake`, `flake_rerun` and
//     `flake_lift` events in delivery-log.jsonl are the state, read back in
//     journal order so the last word wins. The commands that write them run from
//     worktrees too, hence `--graph` in ANY position and the refusal when it is
//     absent — drift-record's rule, and for its reason: a record written beside
//     no ticket graph is not misplaced, it is unreadable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor } = require(path.join(__dirname, 'lock.cjs'));

// The pinned enum. T-20-02's ladder and T-20-06's loop switch on these literals,
// so a synonym or a seventh word is a silent no-op in whatever reads it.
const VERDICTS = ['first', 'progress', 'repeat', 'flake_candidate', 'flake', 'plan_defect'];

const DEFAULT_K = 3; // the same default T-20-02 declares as pipeline.plan_defect_signatures

// ── which graph does this invocation belong to ──────────────────────────────
// Same resolution and the same flag spelling as drift-record.cjs / log-event.cjs
// — one convention for "which project owns this record", so a caller who learns
// it once is right everywhere. Stripped from ANY position: a flag only tolerated
// at the end is a trap for the caller who puts it first.
const ARGV_ALL = process.argv.slice(2);
const GRAPH_FLAG_AT = ARGV_ALL.indexOf('--graph');
// A `--graph` with no value — at the end, or immediately followed by another
// flag — must not read as "explicit". Before this check it did: GRAPH_EXPLICIT
// only tested flag PRESENCE, so `--graph` alone resolved to `path.resolve('')`
// (the cwd) and skipped requireGraph()'s refusal entirely — a fixer's worktree
// cwd would then silently become the graph dir, exactly the class of bug the
// refusal exists to prevent, just reached by a different door.
if (GRAPH_FLAG_AT !== -1) {
  const val = ARGV_ALL[GRAPH_FLAG_AT + 1];
  if (val === undefined || val.startsWith('--')) {
    usage(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`}) — refusing to guess and land in the wrong project's journal`);
  }
}
const GRAPH_EXPLICIT = GRAPH_FLAG_AT !== -1 || !!process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_DIR = GRAPH_FLAG_AT !== -1
  ? path.resolve(ARGV_ALL[GRAPH_FLAG_AT + 1])
  : (process.env.SHIPYARD_GRAPH_DIR
    ? path.resolve(process.env.SHIPYARD_GRAPH_DIR)
    : path.join(process.cwd(), '.planning', 'graph'));
// Guarded on the -1 case deliberately: `i !== GRAPH_FLAG_AT + 1` with no flag
// present reads as `i !== 0` and eats the SUBCOMMAND.
const ARGV = GRAPH_FLAG_AT === -1
  ? ARGV_ALL
  : ARGV_ALL.filter((_, i) => i !== GRAPH_FLAG_AT && i !== GRAPH_FLAG_AT + 1);
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
// The lock belongs beside the JOURNAL, never at cwd: a lock taken at a worktree
// cwd serializes nothing, which is how six concurrent marks became five records.
const LOCK_ROOT = path.resolve(GRAPH_DIR, '..', '..');

function fail(msg) {
  process.stderr.write(`failure-signature: ${msg}\n`);
  process.exit(1);
}

function usage(msg) {
  process.stderr.write(`failure-signature: ${msg}\n`);
  process.exit(2);
}

// ── normalization ───────────────────────────────────────────────────────────

// CSI sequences first: colour codes wrap timestamps, paths and class names, so
// nothing else matches reliably until they are gone.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

// The segments a repo-relative path can plausibly START at. Deliberately
// conservative: `app` is NOT here, because GitHub's checkout path is
// /home/runner/work/<repo>/<repo>/… — anchoring on a repo name would make the
// runner's copy (`app/app/src/x.ts`) and a developer's (`app/src/x.ts`) two
// different files, i.e. two signatures for one failure.
const ANCHORS = new Set([
  'src', 'source', 'lib', 'pkg', 'internal', 'cmd', 'packages', 'plugins',
  'scripts', 'tests', 'test', 'spec', 'specs', 'e2e', 'integration',
]);

// An absolute path is machine-specific; the same failure prints a different one
// in CI and locally. Cut it down to the first anchored segment, else to the
// basename — both are stable across checkouts, which is the only property the
// signature needs.
function relativize(p) {
  const segs = p.split('/').filter(Boolean);
  const at = segs.findIndex((s) => ANCHORS.has(s));
  if (at !== -1) return segs.slice(at).join('/');
  return segs.length ? segs[segs.length - 1] : p;
}

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(ANSI, '')
    .replace(/\r/g, '')
    // ISO timestamps, then bare clock times.
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '')
    // line:column suffixes — on a file token first, then the bare form a
    // module-ish frame leaves behind (node:internal/…:95:5).
    .replace(/([\w./@+-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/g, '$1')
    .replace(/:\d+:\d+\b/g, '')
    // absolute paths → repo-relative
    .replace(/(^|[\s(<'"`=])(\/[^\s)<>'"`:]+)/g, (_m, pre, p) => pre + relativize(p))
    // durations: 12.3s, (345 ms), 0.00s
    .replace(/\(?\b\d+(?:[.,]\d+)?\s?(?:ms|ns|us|s|sec|secs|seconds)\b\)?/g, '')
    // hex addresses / object ids
    .replace(/\b0x[0-9a-fA-F]+\b/g, '');
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// PRIORITY order, not first-line order. A jest log prints `FAIL src/x.test.ts`
// before the `TypeError` that actually failed it; classifying on whichever
// marker appears first would collapse a TypeError and an AssertionError in the
// same test into one signature, and D1 loses exactly the discrimination it is
// for.
function errorClass(text) {
  const named = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Failure))\b/.exec(text);
  if (named) return named[1];
  if (/^\s*--- FAIL:/m.test(text)) return 'go-test-fail';
  if (/^\s*not ok\b/m.test(text)) return 'tap-not-ok';
  if (/\bFAILED\b/.test(text) || /(^|\s)FAIL\b/m.test(text)) return 'test-failed';
  const exit = /\bexit(?:ed)?\s+(?:code|status)[: ]*(\d+)/i.exec(text)
    || /\bexit code[: ]*(\d+)/i.exec(text);
  if (exit && exit[1] !== '0') return `exit-${exit[1]}`;
  return 'unknown';
}

// The failing test, most specific form first. `--job` is the floor: a log with no
// test identifier at all (a build step, an install) is still identified by the
// check that produced it.
function testId(text, job) {
  const go = /^\s*--- FAIL:\s+(\S+)/m.exec(text);
  if (go) return tidy(go[1]);
  const tap = /^\s*not ok\s+(?:\d+\s*)?(?:-\s*)?(.+)$/m.exec(text);
  if (tap) return tidy(tap[1]);
  const bullet = /^\s*[✕×✗]\s+(.+)$/m.exec(text);
  if (bullet) return tidy(bullet[1]);
  // jest's failure block header. `● Console` and `● Test suite failed to run`
  // are headings, not test names.
  for (const m of text.matchAll(/^\s*●\s+(.+)$/gm)) {
    const name = tidy(m[1]);
    if (name && !/^Console\b/.test(name)) return name;
  }
  const fail = /^\s*FAIL\s+(\S+)/m.exec(text);
  if (fail) return tidy(fail[1]);
  return tidy(job);
}

const FILE_RE = /(?:^|[\s(<'"`=:[])((?:[\w.@+-]+\/)*[\w.@+-]+\.(?:ts|tsx|js|jsx|cjs|mjs|go|py|rb|rs|java|kt|kts|php|cs|c|cc|cpp|h|hpp|swift|scala|sh|bash|sql|vue|svelte|tf|yml|yaml))\b/;

function failingFile(text) {
  const m = FILE_RE.exec(text);
  return m ? m[1] : '';
}

/**
 * A CI failure log in, one stable identity out. Never throws, never rejects an
 * input: an unrecognizable log is `unknown` + whatever the job was called, which
 * still distinguishes two different checks from each other.
 */
function computeSignature(rawLog, job = '') {
  const text = normalize(rawLog);
  const error_class = errorClass(text);
  const test_id = testId(text, job);
  const file = failingFile(text);
  const signature = crypto.createHash('sha256')
    .update(`${error_class}\n${test_id}\n${file}`)
    .digest('hex')
    .slice(0, 16);
  return { signature, error_class, test_id, file };
}

// ── the journal, and the verdict read from it ───────────────────────────────

function readJournal(ticket) {
  let raw;
  try {
    raw = fs.readFileSync(JOURNAL, 'utf8');
  } catch {
    return []; // no journal yet is a fresh ticket, not a failure
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // a torn line is skipped, never fatal
    if (!e || typeof e !== 'object') continue;
    if (e.ticket !== ticket) continue;
    out.push(e);
  }
  return out;
}

/**
 * One verdict from the pinned enum, by the rules in ADR-001 D1/D3 — in THIS
 * order, because the order is the design:
 *
 *   1. quarantined (a `flake` with no later `flake_lift`) → flake
 *   2. the same signature at the same HEAD, not yet disproved by a red re-run
 *      → flake_candidate (the tree did not move; re-run before dispatching)
 *   3. k distinct signatures, current one included → plan_defect
 *   4. nothing on record → first
 *   5. the same as the most recent one → repeat (change strategy, hold the tier)
 *   6. otherwise → progress
 *
 * Events are read in JOURNAL order, not by `ts`: the journal is append-only and
 * two events in the same second are ordered by their lines, not their clocks.
 *
 * `seen` is how many prior attempts carried THIS signature — the number the
 * "same twice → change strategy" consumer reads; `distinct` is the breadth the
 * k-rule reads.
 */
function computeVerdict(events, { signature, head, k = DEFAULT_K }) {
  let lastFlake = -1;
  let lastLift = -1;
  let lastSame = -1;          // most recent prior attempt carrying THIS signature
  const priorSignatures = [];

  events.forEach((e, i) => {
    if (e.event === 'flake' && e.signature === signature) lastFlake = i;
    else if (e.event === 'flake_lift' && e.signature === signature) lastLift = i;
    else if (e.event === 'attempt' && typeof e.signature === 'string' && e.signature) {
      // Attempt events from before this phase carry no `signature` key at all.
      // That reads as "no signature recorded", never as an error.
      priorSignatures.push(e.signature);
      if (e.signature === signature) lastSame = i;
    }
  });

  const distinct = new Set([...priorSignatures, signature]).size;
  const seen = priorSignatures.filter((s) => s === signature).length;
  const base = { signature, head, distinct, k, seen };

  if (lastFlake !== -1 && lastFlake > lastLift) return { verdict: 'flake', ...base };

  if (lastSame !== -1 && head && events[lastSame].head === head) {
    // A red re-run at this exact (signature, head) already proved the failure
    // deterministic — without this the loop orbits flake_candidate forever.
    const disproved = events.some((e, i) => i > lastSame
      && e.event === 'flake_rerun'
      && e.signature === signature
      && e.head === head
      && e.outcome === 'red');
    if (!disproved) return { verdict: 'flake_candidate', ...base };
  }

  if (distinct >= k) return { verdict: 'plan_defect', ...base };
  if (!priorSignatures.length) return { verdict: 'first', ...base };
  if (priorSignatures[priorSignatures.length - 1] === signature) return { verdict: 'repeat', ...base };
  return { verdict: 'progress', ...base };
}

// One act, one locked section, the same shape as escalation-record's park: the
// journal IS the quarantine, so an append that escaped the lock is a lost
// verdict, not merely a lost metric.
function journalAppend(entry) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  withLock(lockDirFor(LOCK_ROOT), 'failure-signature', () => {
    fs.appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');
  }, { label: 'failure-signature' });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// The value-taking flags are enumerated rather than inferred: a generic
// `--key value` parser eats the token after `--json` and silently loses a
// positional argument.
const VALUE_FLAGS = new Set(['--log', '--job', '--signature', '--head', '--outcome', '--k']);

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { flags.json = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) usage(`${a} needs a value`);
      flags[a.slice(2)] = args[++i];
      continue;
    }
    if (a.startsWith('--')) usage(`unknown flag ${a}`);
    positional.push(a);
  }
  return { flags, positional };
}

// Only the subcommands that TOUCH the journal need a graph. `compute` is read-in
// / write-out and is called from ticket worktrees, so the guard must not reach
// it — a verbatim copy of drift-record's placement would break it in its primary
// habitat.
function requireGraph() {
  if (GRAPH_EXPLICIT || fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) return;
  fail(
    `no ticket graph at ${GRAPH_DIR} — refusing to read or write a flake record nothing will see.\n` +
    '  The babysit loop reads the PROJECT\'s journal; one written in a worktree is silently ignored,\n' +
    '  so the same failure is charged as a fresh attempt on every round.\n' +
    '  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n' +
    '  (or set SHIPYARD_GRAPH_DIR) — which is what a fixer standing in a worktree must do.'
  );
}

function readLog(flags) {
  if (flags.log) {
    try {
      return fs.readFileSync(flags.log, 'utf8');
    } catch (e) {
      // Degraded data, never a stopped round: a missing temp file at 3am must
      // still produce a signature the loop can compare.
      process.stderr.write(`failure-signature: cannot read ${flags.log} (${e.code || e.message}) — signing a degraded failure\n`);
      return '';
    }
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (require.main === module) {
  const { flags, positional } = parseArgs(ARGV);
  const [cmd, ticket] = positional;

  if (cmd === 'compute') {
    const got = computeSignature(readLog(flags), flags.job || '');
    console.log(flags.json ? JSON.stringify(got) : got.signature);
    process.exit(0);
  }

  if (cmd === 'verdict') {
    if (!ticket) usage('usage: failure-signature.cjs verdict <ticket> --signature <sig> --head <sha> [--k <n>] [--json]');
    if (!flags.signature) usage('verdict needs --signature <sig> — compute it first');
    if (!flags.head) usage('verdict needs --head <sha>: "same failure, unchanged tree" is the flake test');
    const k = Number(flags.k);
    requireGraph();
    const got = computeVerdict(readJournal(ticket), {
      signature: flags.signature,
      head: flags.head,
      k: Number.isFinite(k) && k > 0 ? k : DEFAULT_K,
    });
    console.log(flags.json ? JSON.stringify(got) : got.verdict);
    process.exit(0);
  }

  if (cmd === 'rerun') {
    if (!ticket) usage('usage: failure-signature.cjs rerun <ticket> --signature <sig> --head <sha> --outcome green|red [--job <name>]');
    if (!flags.signature) usage('rerun needs --signature <sig>');
    if (!flags.head) usage('rerun needs --head <sha> — a re-run at a different head proves nothing about this one');
    if (flags.outcome !== 'green' && flags.outcome !== 'red') {
      usage('rerun needs --outcome green|red — the one-shot re-run either passed or it did not');
    }
    requireGraph();
    const ts = new Date().toISOString();
    if (flags.outcome === 'green') {
      // The quarantine IS this line — there is no store to also update.
      journalAppend({
        ts, event: 'flake', ticket, signature: flags.signature, head: flags.head,
        job: flags.job || '', by: 'failure-signature',
      });
      console.log(`${ticket}: ${flags.signature} quarantined as a flake — it is not charged as an attempt until \`lift\``);
    } else {
      journalAppend({
        ts, event: 'flake_rerun', ticket, signature: flags.signature, head: flags.head,
        outcome: 'red', by: 'failure-signature',
      });
      console.log(`${ticket}: ${flags.signature} failed again at the same head — deterministic, the next verdict reads it as \`repeat\``);
    }
    process.exit(0);
  }

  if (cmd === 'lift') {
    if (!ticket) usage('usage: failure-signature.cjs lift <ticket> --signature <sig>');
    if (!flags.signature) usage('lift needs --signature <sig>');
    requireGraph();
    journalAppend({
      ts: new Date().toISOString(), event: 'flake_lift', ticket,
      signature: flags.signature, by: 'failure-signature',
    });
    console.log(`${ticket}: quarantine lifted for ${flags.signature} — it counts as a real failure again`);
    process.exit(0);
  }

  usage('usage: failure-signature.cjs <compute|verdict|rerun|lift> … [--graph <dir>]');
}

module.exports = { computeSignature, computeVerdict, normalize, relativize, VERDICTS, DEFAULT_K };
