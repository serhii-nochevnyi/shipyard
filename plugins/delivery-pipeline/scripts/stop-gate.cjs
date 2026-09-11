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
//   * something is actionable AND THE CAP ALLOWS IT TO BE TAKEN, OR the board's
//     only content is `waiting.ci` — the run is allowed to WAIT, but not to walk
//     away from the wait (see WAITING and CAPACITY);
//   * that work is not entirely left-behind — a phase the run has moved past is
//     "a decision, not motion" (front.cjs), and demanding motion there is how a
//     guard starts lying;
//   * we have not already refused this same ROUND — see the ledger below, which
//     is what keeps a refusal from becoming a loop without also capping the
//     number of legitimate refusals a cascade needs.
//
// ── ONE BLOCK PER ROUND, NOT ONE PER TURN ────────────────────────────────────
// `stop_hook_active` was the whole anti-loop rule, and it answers the wrong
// question. It bounds the cost of a FALSE block to one per TURN — which is why
// it exists and why it stays — but it also bounded the number of TRUE ones, and
// a stacked cascade needs one per ROUND: merge, the next child goes BEHIND,
// base-merge, push, CI, merge. The loop legitimately tries to end the turn after
// each dispatch, so the gate refused once, the loop resumed, dispatched, tried
// to stop again — and that stop went through with three tickets still to land.
//
// So a per-session ledger sits beside the chosen front:
//
//   stop-gate-ledger.json  { session_id, blocks, last_generated_at, last_moved_at }
//
// and a refusal repeats only when the BOARD ADVANCED since the last one: a newer
// `generated_at` (the loop resynced) or a qualifying journal event newer than
// the one current at that block (the world moved). Nothing advanced means
// nothing new to say, and the anti-loop rule stands exactly as before.
//
// Every path that cannot prove a round has passed falls back to that old rule —
// no `session_id` in the payload, a ledger this session does not own, an
// unreadable one, a graph directory that cannot be written. That fallback is
// load-bearing rather than tidy: without it, a ledger that never persists would
// read as "always advanced" and refuse a session forever, which is the one
// outcome this hook must never produce.
//
// `SHIPYARD_STOP_GATE_MAX_BLOCKS` (12) caps the lot. A cascade deeper than that
// in one turn is a phase to resume deliberately, not to be pushed through; past
// the cap the gate allows the stop and says on stderr which knob decided.
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
// An event is evidence only while it is YOUNGER THAN THE RESYNC CEILING. A run
// that ended on a sentinel merge leaves such an event in the journal for good,
// and this hook is GLOBAL — so an unbounded rule blocked the first stop of every
// later session in that repository, citing a merge from a run that was over.
// Same ceiling as the stale-board rule, so one knob moves both and no second
// number can drift out of step with it.
//
// Age still decides the case where the journal offers no evidence: the band
// between FRESH_MS and RESYNC_MS blocks ONCE and asks for a resync, past
// RESYNC_MS the original rule stands. Either way the refusal states the age and
// the shape and never the stale board's contents — those contents are what is
// wrong. `stop_hook_active` caps it at one block per turn, so the worst case is
// one `state-sync` and then a stop, which is the honest price of not knowing.
//
// ── WAITING IS ALLOWED; WALKING AWAY FROM IT IS NOT ──────────────────────────
// This hook used to be silent whenever nothing was actionable, which folded two
// states into one: a finished run, and a run with PRs still going through CI. The
// second is where the conveyor bled. The babysit loop is driven by
// agent-completion wake-ups, so with no agent out and only CI pending, NOTHING
// WILL EVER WAKE THE SESSION AGAIN — measured twice on the same phase, once for
// 5h46m and once for 11h43m, and the second time with the next PR green,
// `conform` and ready to land.
//
// `ci-wait.cjs` is the answer and it works by not ending the turn. But something
// has to make the loop CALL it, and deliver.md saying so is prose — the exact
// class of rule this hook exists because prose could not hold. So: a board whose
// only content is `waiting.ci` blocks, and the refusal names the script.
//
// It TERMINATES without a second special case here. `ci-wait.cjs` counts empty
// windows against escalation-record's fingerprint and escalates itself after
// three; an escalation park drops the ticket from the front, so the CI bucket
// empties and this branch stops firing through the rule it already had. A stuck
// pipeline ends with a person, not with a gate quietly giving up.
//
// Not fired when a ticket is with an agent: that wake-up is free and sooner — but
// a dispatch MARK is not that claim. The mark can be written before the launch,
// so a launch that never happened kept this branch quiet for a whole dispatch
// TTL: 90 minutes of silence with nothing coming. The hatch therefore asks
// `dispatches.json` how old the mark is, and a mark past
// `SHIPYARD_STOP_GATE_DISPATCH_SUSPECT_MS` (45m — longer than any fix round the
// proving ground has measured, shorter than the TTL) no longer opens it. POSITIVE
// EVIDENCE ONLY: no record, or one that cannot be dated, is not proof the agent
// is gone.
//
// ── CAPACITY: A FULL BOARD IS A BOARD WITH AN AGENT OUT (ADR-006 D1) ────────
// `front.cjs` publishes `capacity {max, in_flight, free}` and already refuses to
// call a capped board a fixpoint. This hook did not read the field at all, so on
// the ordinary full board — every agent the cap allows is out, more tickets ready
// — it blocked the stop and ordered the run to "take the actionable items RIGHT
// NOW": the one thing the cap exists to prevent, told to the session by the gate
// that is supposed to enforce the board. Two mechanisms reading one board and
// giving opposite orders is worse than either alone.
//
// So `free <= 0` is treated as what it is — an agent is out, and that wake-up is
// free and sooner — through the SAME hatch and the same plausibility rule as the
// CI branch below: a dispatch MARK with no agent behind it must not buy silence
// here either. When every mark is suspect the block still lands, and it now
// carries the `dispatch-record.cjs clear` line, because a phantom `in_flight` is
// exactly how a board would look full while nothing is coming.
//
// A `max` of 0 means one thing only (front.cjs guarantees it): the project config
// does not parse, so NO policy is in effect and nothing may be dispatched at all.
// A board that correctly cannot dispatch anything is not a defect to block on —
// the remedy is a person editing a file, which no refusal of a stop can produce —
// so the hook stays silent and lets front.cjs's own line say why.
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

// HOW MANY TIMES ONE SESSION MAY BE REFUSED. The ledger un-bounds the refusals a
// cascade legitimately needs, so something has to bound them instead — and it is
// a count of rounds, not of turns.
// Never below 1: a cap of zero would be an off switch by accident, and this hook
// already has an explicit one (`SHIPYARD_STOP_GATE=off`).
const MAX_BLOCKS = Math.max(1, Math.floor(envMs('SHIPYARD_STOP_GATE_MAX_BLOCKS', 12)));

// AFTER THIS A DISPATCH MARK IS NOT AN AGENT AT WORK. Measured against the same
// journal dispatch-record.cjs sized its TTL from: the worst silent
// dispatch→publish stretch on record is 37 minutes, and the TTL is 90.
const DISPATCH_SUSPECT_MS = envMs('SHIPYARD_STOP_GATE_DISPATCH_SUSPECT_MS', 45 * 60 * 1000);

const LEDGER_NAME = 'stop-gate-ledger.json';

function allow() { process.exit(0); }

// The refusal, gated by the ledger. Every branch below calls this rather than
// deciding for itself whether a repeat is legitimate — one place asks that
// question, which is why `stop_hook_active` could be replaced without touching a
// single hatch.
function verdict(reason) {
  const gate = blockAllowance();
  if (gate.note) process.stderr.write(gate.note);
  if (!gate.mayBlock) allow();
  if (gate.blocks) recordBlock(gate.blocks);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

if (String(process.env.SHIPYARD_STOP_GATE || '').toLowerCase() === 'off') allow();

let payload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) payload = JSON.parse(raw);
} catch { /* no payload is not a reason to block */ }

// WHO IS STOPPING. The ledger counts rounds against this; a payload without one
// falls back to the old `stop_hook_active` rule, because a key we invented would
// make every stop in the repository look like a single run.
const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim()
  ? payload.session_id.trim()
  : null;

// `payload.stop_hook_active` — Claude Code sets it when this stop was already
// refused once, and ignoring it would turn "you still have work" into a session
// that can never end. It is no longer read HERE, though: on its own it also
// capped the refusals a cascade needs to one per turn, so the decision moved into
// `blockAllowance()` below, where it is weighed against whether the board has
// actually advanced. Everything else in this file is unchanged by that move.

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
  const now = Date.now();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.ts || '');
    if (Number.isNaN(at) || at <= generatedAt) continue;
    // Newer than the board, AND young enough to belong to a run that is still
    // happening. A merge is in the journal forever and this hook is global, so
    // without this bound the first stop of every later session in the repository
    // was refused over a run that ended days ago. Same ceiling as the
    // stale-board rule — one knob, so the two can never disagree.
    if (now - at > RESYNC_MS) continue;
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

// ── THE LEDGER: one refusal per ROUND ───────────────────────────────────────
// These four read module state (`graphDir`, `generated`, `movedAny`, `sessionId`)
// that is resolved further down; they are only ever called from `verdict()`,
// which runs after all of it exists.

function readLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir, LEDGER_NAME), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null; // absent, corrupt, or a directory some accident left behind
  }
}

// Wrapped the way ci-wait.cjs wraps its own store write, and for the same reason:
// the bookkeeping is never worth breaking the decision for. A read-only graph
// dir, a ledger left as a DIRECTORY (measured on ci-waits.json), a rename that
// loses a race — say one line and let the verdict stand. This hook always exits 0.
function recordBlock(blocks) {
  const file = path.join(graphDir, LEDGER_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      session_id: sessionId,
      blocks,
      last_generated_at: generated === null ? null : new Date(generated).toISOString(),
      last_moved_at: movedAny ? new Date(movedAny.at).toISOString() : null,
    }, null, 2) + '\n');
    // Replaced rather than rewritten in place: a torn ledger is a ledger this
    // session does not own, which costs a round rather than nothing.
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    process.stderr.write(
      `stop-gate: the block ledger at ${file} was not updated (${e.message}).\n` +
      '  The refusal stands. Without the record this session falls back to one refusal per turn,\n' +
      '  so a deep cascade may need the loop to be nudged by hand.\n'
    );
  }
}

// Has the world moved since the refusal this ledger records? Two independent
// facts, because either alone leaves a round unrefused: a NEWER board (the loop
// resynced) or a qualifying journal event newer than the one current at that
// block (a merge or a push the board has not seen). `dispatches_applied_at` is
// never consulted, for the same reason front selection ignores it — a dispatch
// mark rewrites the file without re-deriving anything from GitHub.
function advancedSince(rec) {
  const lastGen = Date.parse(rec.last_generated_at || '');
  if (generated !== null && (!Number.isFinite(lastGen) || generated > lastGen)) return true;
  if (movedAny) {
    const lastMoved = Date.parse(rec.last_moved_at || '');
    if (!Number.isFinite(lastMoved) || movedAny.at > lastMoved) return true;
  }
  return false;
}

// May this stop be refused? Returns `{mayBlock, blocks?, note?}` — `blocks` is
// the count to record when it may, `note` a line for stderr either way.
function blockAllowance() {
  const active = !!payload.stop_hook_active;
  if (!sessionId) return { mayBlock: !active }; // the old rule, verbatim

  const prev = readLedger();
  const mine = prev && prev.session_id === sessionId ? prev : null;
  // No record for this session — absent, unreadable, or another run's. We cannot
  // prove a round has passed, and "already refused once, with nothing new to
  // show" is honestly the old rule. This branch is what keeps an unwritable
  // ledger from becoming a session that can never end: without it, a ledger that
  // never persists would read as "always advanced" and refuse forever.
  if (!mine) return active ? { mayBlock: false } : { mayBlock: true, blocks: 1 };

  const blocks = Math.max(0, Math.floor(Number(mine.blocks) || 0));
  if (blocks >= MAX_BLOCKS) {
    return {
      mayBlock: false,
      note:
        `stop-gate: ${blocks} refusals in this session already ` +
        `(SHIPYARD_STOP_GATE_MAX_BLOCKS=${MAX_BLOCKS}) — allowing this stop.\n` +
        `  The board at ${graphDir} may still hold work: a cascade needs one round per ticket, and this\n` +
        '  phase has needed more rounds than one turn should carry. Resume it deliberately, or raise the\n' +
        '  cap if the depth is real.\n',
    };
  }
  if (active && !advancedSince(mine)) return { mayBlock: false };
  return { mayBlock: true, blocks: blocks + 1 };
}

// ── IS ANYONE ACTUALLY WORKING? ─────────────────────────────────────────────
// The CI-only branch stays silent when a ticket is with an agent, because that
// wake-up is free and sooner. A dispatch MARK is a weaker claim than that: it can
// be written before the launch, so a launch that never happened held this branch
// quiet for the whole dispatch TTL.
//
// POSITIVE EVIDENCE ONLY. No record, or one that cannot be dated, is not proof
// the agent is gone — and between a spurious refusal and a silent stall, only one
// of the two gets this hook uninstalled.
function dispatchAges(dir, ids) {
  let recs = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'dispatches.json'), 'utf8'));
    if (raw && typeof raw === 'object' && raw.tickets && typeof raw.tickets === 'object') {
      recs = raw.tickets;
    }
  } catch { /* no store is no suspicion */ }
  const now = Date.now();
  const plausible = [];
  const suspect = [];
  for (const id of ids) {
    const rec = recs[id];
    const at = Date.parse((rec && rec.at) || '');
    if (!Number.isFinite(at) || now - at < DISPATCH_SUSPECT_MS) { plausible.push(id); continue; }
    suspect.push({ id, role: (rec && rec.role) || 'an agent', mins: Math.round((now - at) / 60000) });
  }
  return { plausible, suspect };
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

// The cap, read defensively: a `delivery-front.json` written before capacity
// existed outlives an upgrade, so an absent or unreadable field is `null` — "no
// cap is in force" — and must never open the hatches below.
const capacity = (front.capacity && typeof front.capacity === 'object') ? front.capacity : null;
// `front.cjs` only ever emits non-negative counts (`Math.max(0, …)` for `free`,
// a length or a collapsed sum for `max`/`in_flight`), so a negative value here
// is not a smaller cap — it is a corrupted or hand-edited front, and must read
// as unreadable exactly like `null`/a string/an object would.
const capNum = (k) => (capacity !== null && typeof capacity[k] === 'number'
  && Number.isFinite(capacity[k]) && capacity[k] >= 0 ? capacity[k] : null);
const capMax = capNum('max');
const capFree = capNum('free');
// Read for the phantom-capacity message below the same defensive way as
// max/free: capacityFull only guarantees capMax/capFree are finite, not
// `in_flight`, so the message must not print a raw, possibly-garbled field.
const capInFlight = capNum('in_flight');
// Only front.cjs can express 0, and only for one reason: the project config does
// not parse, so no policy is in effect. Nothing may be dispatched, and no refusal
// of a stop can fix a file.
if (capMax === 0) allow();
// A full board: every agent the policy allows is out, so nothing on the board may
// be taken this round however much of it is actionable.
const capacityFull = capMax !== null && capMax > 0 && capFree !== null && capFree <= 0;

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

// WHO IS OUT — read at most once, and only when a branch below actually asks. A
// mark opens a hatch only while it can still plausibly have an agent behind it
// (see dispatchAges): a mark can be written before the launch, so a launch that
// never happened was 90 minutes of silence with nothing coming.
let agesCache = null;
const agentsOut = () => (agesCache || (agesCache = dispatchAges(graphDir, dispatched)));

// The dispatch marks that did NOT keep this quiet, as a sentence. Shared by the
// CI branch and the front-is-not-empty verdict below: on a board the cap called
// FULL, a suspect mark is the whole explanation for why the gate is blocking
// anyway, so the reader must get the same line either way.
const goneText = () => {
  const { suspect } = agentsOut();
  const suspectId = suspect[0] && suspect[0].id;
  const suspectDispatch = suspectId ? dispatched[suspectId] : null;
  const suspectDispatchId = suspectDispatch && suspectDispatch.dispatch_id
    ? suspectDispatch.dispatch_id
    : '<dispatch_id>';
  return suspect.length
    ? '\nThe dispatch mark(s) on this board did NOT keep this quiet: ' +
      `${suspect.map((d) => `${d.id} → ${d.role}, marked ${d.mins}m ago`).join('; ')}.\n` +
      'A mark that old is not an agent at work — it is what a mark written before a launch that never\n' +
      'happened looks like. If that work really is out it will wake you; if it is gone, return the\n' +
      'ticket to the board with\n' +
      `  \`dispatch-record.cjs clear ${suspectId} ${suspectDispatchId} --graph ${graphDir}\`\n` +
      'The --graph is not optional: this hook\'s cwd is the SESSION\'s, and a clear run from the wrong\n' +
      'one reports "no dispatch recorded" and changes nothing.'
    : '';
};

// THE CAPACITY HATCH, ahead of the arithmetic below and deliberately not inside
// it: the with-an-agent hatch used to sit behind `count <= 0`, so a full board
// with work on it never reached it. An agent IS out here — the cap says so — and
// its completion is the wake-up this session is waiting for.
if (capacityFull && agentsOut().plausible.length) allow();

// The board is fresh (the branches above returned for anything older) and offers
// no move. If PRs are still in CI, the run may wait — with `ci-wait.cjs`, in the
// foreground — but it may not stop, because nothing will bring it back.
if (count <= 0 || leftBehind >= count) {
  const ci = (front.waiting && front.waiting.ci) || [];
  if (!ci.length) allow();
  if (agentsOut().plausible.length) allow();
  const gone = goneText();
  verdict(
    `shipyard: nothing is actionable, but ${ci.length} PR(s) are still in CI (${ci.join(', ')}) — ` +
    'so this is a WAIT, not a fixpoint, and stopping here ends the run for good.\n' +
    'The babysit loop is woken by agents finishing. No agent is out, so nothing will wake this session:\n' +
    'measured at 5h46m once and 11h43m the next night, the second time with the next PR green, conform\n' +
    'and ready to land. Do not summarise and stop:\n' +
    '  1. `ci-wait.cjs` — it waits in the FOREGROUND, so the turn never ends and nothing has to wake it;\n' +
    '     it returns the moment any watched PR settles, green or red, and after ~15m either way;\n' +
    '  2. `state-sync.cjs`, then take the round the settled PR opened;\n' +
    '  3. loop back. Stop only on `fixpoint: YES`.\n' +
    'A cascade needs one such round PER TICKET: each squash-merge makes the next child DIRTY, which\n' +
    'costs a base-merge, a push and a full CI run. Three empty waits and `ci-wait.cjs` escalates by\n' +
    'itself, which parks the ticket and makes this refusal stop — a stuck pipeline ends with a person.' +
    gone + whereToSync
  );
}

const ORDER = ['execute', 'publish', 'fix', 'finalize', 'merge'];
const named = ORDER
  .filter((k) => (front.actionable?.[k] || []).length)
  .map((k) => `${k}: ${front.actionable[k].join(', ')}`)
  .join(' | ');

// The one way to reach this line on a FULL board: every dispatch mark is suspect,
// so the `in_flight` that made it look full has no agent behind it. Say that,
// with the clear command — otherwise the refusal reads as an order to dispatch
// past a cap the board says is spent.
const phantom = capacityFull
  ? `\nThe board reports capacity ${capInFlight ?? '?'}/${capMax} agents in flight, i.e. FULL — but no `
    + 'mark on it is recent enough to be an agent at work, so nothing is coming to wake this session.'
    + goneText()
  : '';

verdict(
  `shipyard: the delivery front is not empty — ${count} item(s) are actionable RIGHT NOW (${named}).\n` +
  'Ending the run here is a defect, not a choice (deliver.md, the Principle). Do not summarise and stop:\n' +
  '  1. `state-sync.cjs` for fresh state and a fresh front;\n' +
  '  2. take the actionable items — shallowest stack depth first, the guard owns fix/review/arch-review/merge;\n' +
  '  3. loop back and recompute. Stop only on `fixpoint: YES`.\n' +
  'If an item genuinely must not be taken, park it with a reason (`drift-record.cjs mark` when the plan\n' +
  'predates what shipped) so the front stops offering it — do not leave it listed and walk away.'
  + phantom + whereToSync
);
