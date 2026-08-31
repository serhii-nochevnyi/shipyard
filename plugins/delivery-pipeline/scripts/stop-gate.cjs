#!/usr/bin/env node
'use strict';

// stop-gate.cjs — the Stop hook that makes the conveyor's stop condition
// mechanical instead of remembered.
//
// Every other gate in shipyard is a script with an exit code: Gate 2, the
// did-work gate, the scope gate, the merge gate, the drift verdict. The one
// decision left to prose was the biggest — "never end the run while the front is
// non-empty". deliver.md states it as a mandatory five-step loop-back, and runs
// end early anyway; one wrote it down itself: "Робота є, і я справді зупинився
// зарано — знову." The failure is structural, not careless. The moment of
// stopping is not a step, so nothing runs there; and it arrives exactly when the
// model's attention is on composing a summary, which reads like completion.
//
// So: read the front the conveyor already computes, and refuse the stop while
// there is live work. Reads stdin (the hook payload), writes a hook verdict.
//
// It stays silent unless ALL of these hold, because a Stop hook that fires
// anywhere else is worse than none:
//   * this project has a conveyor front at all;
//   * the front is FRESH — or stale in the narrow way that means the LOOP forgot
//     to resync rather than that the run is over (see THE TWO STALE CASES);
//   * something is actionable, and not merely waiting on CI (the run is allowed
//     to wait when waiting is all that is left);
//   * that work is not entirely left-behind — a phase the run has moved past is
//     "a decision, not motion" (front.cjs), and demanding motion there is how a
//     guard starts lying;
//   * we have not already blocked this stop (`stop_hook_active`), which is what
//     keeps a refusal from becoming a loop.
//
// ── WHICH FRONT (measured, 2026-08-30) ───────────────────────────────────────
// The hook's cwd is the SESSION's cwd, and the conveyor does not run there. The
// main loop `cd`s into a phase worktree inside every Bash call, so the session
// stays parked in the checkout it was opened in — a different branch of the same
// repo, carrying its own tracked `.planning/graph/` from whatever phase that
// branch last saw.
//
// In the pdffiller proving ground that made this hook completely inert. Twelve
// stops in one day, the gate ran on every one (46-71ms) and blocked none: it was
// reading the main checkout's front from the PREVIOUS day, which honestly said
// `fixpoint: true, actionable_count: 0`, while the live phase-21 front two
// directories away said `finalize: 4, fixpoint: false`. Not an abstention — an
// affirmative all-clear from the wrong board. One of those stops cost 5h46m of
// silence, ended only by the operator asking "що тут?".
//
// This is the class `graph-dir.cjs` exists for, and graph-dir cannot solve it:
// its cwd step would find the stale front and stop looking, because that file
// does exist and does parse. A hook also gets no flags and no env from the
// caller, so the explicit answer that rescues every other gate is unavailable.
//
// So resolve by EVIDENCE instead: every worktree of the cwd's repository is a
// candidate, and the front with the newest `generated_at` is the one describing
// a run that is actually happening. Selection uses `generated_at` alone and
// never `dispatches_applied_at` — dispatch marks touch the file without
// resyncing, so counting them as freshness would hide exactly the case below.
//
// Two sessions delivering different phases of one repo would let the busier
// board answer for the quieter one. That is bounded to a single block per turn
// by `stop_hook_active`, and the alternative is measured at six hours.
//
// ── THE TWO STALE CASES ──────────────────────────────────────────────────────
// "A stale front never traps a session" was one rule covering two different
// facts, and the 12:30 stop is the one it got wrong:
//
//   the run ENDED — a board from yesterday, from a phase that shipped, from a
//     session that is gone. Nothing to enforce; stay silent. This is the case the
//     rule was written for and it is unchanged.
//   the loop FORGOT TO RESYNC — the board is an hour old because the run has been
//     dispatching agents off it without re-deriving it from GitHub. The front is
//     wrong, and it is wrong in the direction that ends runs: at 12:30 it still
//     said `execute: 4` for four tickets whose PRs were already open, so every
//     later reading of it was fiction. Staying silent here is how the gate
//     abstains at the exact moment its answer matters.
//
// The first cut of this separated them by AGE, and age is the wrong instrument —
// measured the very next morning, on the run this hook was written for. The
// session resumed after an 11h43m silence, merged a PR, resolved a cascade
// conflict, pushed, and never synced. The board was then 13 hours old: past
// RESYNC_MS, so the gate went silent on all three of that morning's stops while
// the phase sat 1/4 merged with one PR ready and nobody driving it.
//
// A board's AGE is a fact about the last SYNC. It says nothing about whether the
// RUN is over. So ask the run instead: `delivery-log.jsonl` gets an event on
// every merge and every push, and `merge`/`status_change` are owned by
// `sentinel.cjs merge`/`state-sync.cjs` alone (log-event.cjs refuses them by
// hand). An event that MOVED THE WORLD, timestamped after `generated_at`, is
// therefore proof the board is behind reality — no estimate involved:
//
//   merge                     a PR is gone and its children were retargeted
//   attempt … outcome=pushed  a branch moved, so checks re-ran
//   fix_round … pushed=true   the same, from the fix path
//   escalation                a ticket was parked; the front still offers it
//
// `status_change` is EXCLUDED because state-sync writes it, so it is
// contemporaneous with the front by construction; `dispatch` is excluded because
// dispatch-record already overlays it onto the front. Counting either would
// re-create the false block that fired five times across phases 20 and 22 — the
// failure mode that gets a gate uninstalled.
//
// Age still decides the case where the journal offers no evidence: the band
// between FRESH_MS and RESYNC_MS blocks ONCE and asks for a resync, past
// RESYNC_MS the original rule stands. Either way the refusal states the age and
// the shape and never the stale board's contents — those contents are what is
// wrong. `stop_hook_active` caps it at one block per turn, so the worst case is
// one `state-sync` and then a stop, which is the honest price of not knowing.
//
// `SHIPYARD_STOP_GATE=off` turns the whole hook off in one word. An operator who
// wants silence should be able to say so plainly, rather than discovering that
// shrinking a freshness window happens to have that effect.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Older than this and the front no longer describes the board as it stands.
const FRESH_MS = envMs('SHIPYARD_STOP_GATE_FRESH_MS', 45 * 60 * 1000);
// Older than THIS and it describes a run that is no longer happening at all.
const RESYNC_MS = envMs('SHIPYARD_STOP_GATE_RESYNC_MS', 4 * 60 * 60 * 1000);

// Garbage in an env var must not disable a hatch: NaN poisons every comparison
// into "never stale", and "a stale front never traps a session" is this hook's
// own stated invariant.
function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function allow() { process.exit(0); }

function verdict(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

if (String(process.env.SHIPYARD_STOP_GATE || '').toLowerCase() === 'off') allow();

let payload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) payload = JSON.parse(raw);
} catch { /* no payload is not a reason to block */ }

// Claude Code sets this when the stop was already blocked once. Ignoring it
// would turn "you still have work" into a session that can never end.
if (payload.stop_hook_active) allow();

// ── candidate fronts ─────────────────────────────────────────────────────────

function frontFileIn(dir) {
  return path.join(dir, '.planning', 'graph', 'delivery-front.json');
}

// Every worktree of the cwd's repository, main checkout included. `git worktree
// list` reports them all from any one of them, so the session's own parked
// checkout is enough to reach the phase worktree the loop is actually driving.
function worktreesOf(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
}

// Only the tail: a hook has a ~75ms budget and this journal grows for the life of
// the project (584 status_changes in the proving ground already). The newest
// events are at the end, which is the only end we need.
const JOURNAL_TAIL_BYTES = 64 * 1024;

// Did the run move the world after this board was computed? Returns the newest
// such event, or null. See the header for why each event is in or out.
function movedSince(graphDir, generatedAt) {
  if (generatedAt === null) return null;
  const file = path.join(graphDir, 'delivery-log.jsonl');
  let text;
  let seeked = false;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - JOURNAL_TAIL_BYTES);
    seeked = start > 0;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return null; // no journal is no evidence, never a reason to block
  }
  const lines = text.split('\n');
  // A seek into the middle of the file lands mid-line, so the first line is a
  // fragment. ONLY then: dropping it unconditionally ate the only event in a
  // short journal, which is every project that has not been running for weeks.
  if (seeked) lines.shift();

  let newest = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.ts || '');
    if (Number.isNaN(at) || at <= generatedAt) continue;
    const moved =
      e.event === 'merge' ||
      e.event === 'escalation' ||
      (e.event === 'attempt' && e.outcome === 'pushed') ||
      (e.event === 'fix_round' && (e.pushed === true || e.pushed === 'true'));
    if (!moved) continue;
    if (!newest || at > newest.at) newest = { at, event: e };
  }
  return newest;
}

function readFront(file) {
  let front;
  try {
    front = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing, or a bug to fix elsewhere — never a trap to spring here
  }
  // JSON.parse("null") succeeds; front.generated_at would then throw, and an
  // uncaught throw breaks "it always exits 0".
  if (!front || typeof front !== 'object') return null;
  const at = Date.parse(front.generated_at || '');
  return { file, front, at: Number.isNaN(at) ? null : at };
}

const cwd = process.cwd();
const candidates = [];
const seen = new Set();
for (const dir of [cwd, ...worktreesOf(cwd)]) {
  const file = frontFileIn(dir);
  if (seen.has(file)) continue;
  seen.add(file);
  const c = readFront(file);
  if (c) candidates.push(c);
}
if (!candidates.length) allow();

// The newest board wins. An undateable `generated_at` sorts last rather than
// out: it is still a front, and if it is the only one we should read it.
candidates.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
const { front, at: generated, file: frontFile } = candidates[0];

// WHERE the board lives, and why every verdict has to say it. The session
// receiving a refusal is parked in the checkout that caused the defect; told
// only to "run state-sync", it runs it THERE and regenerates that branch's own
// board — a phase that shipped, so `fixpoint: true` with a brand-new
// `generated_at`, which then WINS the selection above and silences the gate.
// Advice that reconstructs the condition it was written to fix is worse than
// none, so the refusal names the directory the same way the merge gate names how
// many commits behind a branch is: the remedy must not be a guess.
const graphDir = path.dirname(frontFile);
const wrongCwd = path.resolve(graphDir) !== path.resolve(path.join(cwd, '.planning', 'graph'));
const whereToSync = wrongCwd
  ? `\nThe board that decided this is \`${graphDir}\` — NOT your cwd (\`${cwd}\`), which carries its own\n` +
    'board from whatever phase its branch last saw. Run state-sync from that worktree; running it here\n' +
    'regenerates the wrong board and silences this gate.'
  : '';

// ── what the board says is live ──────────────────────────────────────────────

const count = Number(front.actionable_count || 0);
const leftBehind = Number(front.left_behind_count || 0);
const dispatched = (front.waiting && front.waiting.dispatched) || [];

// Actionable work nobody has taken, or a dispatch that outlived the run that
// made it. The second is the silent-stall shape dispatch-record.cjs is built to
// expire out of; on a board this old the expiry has not been recomputed, so the
// entry is evidence that the loop left mid-flight.
const liveWork = (count > 0 && leftBehind < count) || dispatched.length > 0;

const age = generated === null ? null : Date.now() - generated;
const mins = age === null ? null : Math.round(age / 60000);

// EVIDENCE FIRST. A journalled merge or push after this board was computed proves
// the board is behind reality, whatever the clock says — and this is the branch
// that catches a run which resumed on yesterday's board, which the age bands
// below cannot see by construction.
const movedAny = movedSince(graphDir, generated);
if (movedAny) {
  const e = movedAny.event;
  const what = e.event === 'attempt' || e.event === 'fix_round'
    ? `a push on ${e.ticket || 'a ticket'}${e.pr ? ` (PR #${e.pr})` : ''}`
    : e.event === 'merge'
      ? `${e.ticket || 'a ticket'} was MERGED${e.pr ? ` (PR #${e.pr})` : ''}`
      : `${e.ticket || 'a ticket'} was escalated`;
  verdict(
    `shipyard: the board was computed ${mins === null ? 'at an unknown time' : `${mins} minutes ago`}, and the run has ` +
    `moved the world since — the journal records ${what} at ${e.ts}.\n` +
    'So the board is provably behind reality: a merge retargets children and rewrites their history, a push\n' +
    're-runs checks. Whatever it lists now is fiction, including any "nothing left". Do not summarise and stop:\n' +
    '  1. `state-sync.cjs` — re-derive from GitHub, which is the only place this state is real;\n' +
    '  2. read the fresh front and take what it offers (the guard owns fix/finalize/merge);\n' +
    '  3. loop back. Stop only on `fixpoint: YES` against a front you have just regenerated.\n' +
    'A cascade is not finished when one ticket lands: each merge makes the next child DIRTY, so the phase\n' +
    'needs one round per ticket and the board is the only thing that knows which round you are on.' + whereToSync
  );
}

if (age !== null && age > RESYNC_MS) allow();  // the run ended; nothing to enforce

if (age !== null && age > FRESH_MS) {
  if (!liveWork) allow();
  verdict(
    `shipyard: the delivery board is ${mins} minutes old and the last sync showed live work ` +
    `(${count} actionable, ${dispatched.length} dispatched). It is describing a board that has moved.\n` +
    'This is the shape that ends runs silently: agents get dispatched off a board nobody re-derived, and\n' +
    'the run reads its own stale "nothing left" as completion. Do not summarise and stop:\n' +
    '  1. `state-sync.cjs` from the phase worktree — re-derive the board from GitHub;\n' +
    '  2. read the fresh front and take what it now offers (the guard owns fix/finalize/merge);\n' +
    '  3. loop back. Stop only on `fixpoint: YES` against a front you have just regenerated.\n' +
    'If the run really is over, one `state-sync.cjs` says so and this stops asking.' + whereToSync
  );
}

if (count <= 0) allow();
if (leftBehind >= count) allow();

const ORDER = ['execute', 'publish', 'fix', 'finalize', 'merge'];
const named = ORDER
  .filter((k) => (front.actionable?.[k] || []).length)
  .map((k) => `${k}: ${front.actionable[k].join(', ')}`)
  .join(' | ');

verdict(
  `shipyard: the delivery front is not empty — ${count} item(s) are actionable RIGHT NOW (${named}).\n` +
  'Ending the run here is a defect, not a choice (deliver.md, the Principle). Do not summarise and stop:\n' +
  '  1. `state-sync.cjs` for fresh state and a fresh front;\n' +
  '  2. take the actionable items — shallowest stack depth first, the guard owns fix/review/arch-review/merge;\n' +
  '  3. loop back and recompute. Stop only on `fixpoint: YES`.\n' +
  'If an item genuinely must not be taken, park it with a reason (`drift-record.cjs mark` when the plan\n' +
  'predates what shipped) so the front stops offering it — do not leave it listed and walk away.' + whereToSync
);
