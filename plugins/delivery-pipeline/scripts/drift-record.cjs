#!/usr/bin/env node
'use strict';

// drift-record.cjs — the durable home for a drift verdict.
//
//   drift-record.cjs mark  <ticket> <plan-path> <reason...> [--graph <dir>]
//   drift-record.cjs clear <ticket>                          [--graph <dir>]
//   drift-record.cjs list  [--json]                          [--graph <dir>]
//
// `--graph` is not optional decoration: the drift judges run from ticket
// WORKTREES, so `process.cwd()` is not the project. Without it a verdict was
// written to `<worktree>/.planning/graph/drift.json`, which state-sync never
// reads — the ticket is re-offered forever, i.e. exactly the defect this script
// exists to prevent, reintroduced through the only path that calls it. The flag
// text was also swallowed into the reason string, and the whole thing printed
// "drift recorded". Hence both the flag AND the guard below: the flag fixes the
// instruction, the guard fixes the class, because the next prompt that forgets it
// must fail loudly rather than write into the void.
//
// Why this exists: `deliver.md` promised a drifted ticket was "marked
// needs-replan", and nothing wrote or read such a mark. So the front kept
// offering it under `execute` on every run — two tickets confirmed stale on
// 2026-08-06 were still being handed to executors days later. `--parked` could
// not help: it is deliberately session-scoped, and a drift verdict is a fact
// about the PLAN, which outlives any session.
//
// The verdict is bound to the plan's CONTENT HASH, and that is the whole design.
// A verdict that never expired would be worse than none: re-plan the ticket and
// it stays parked forever, with the run insisting on staleness that was fixed.
// Hashing the plan makes the park lift by itself the moment the plan actually
// changes — no second command to remember, no stale marker to clean up.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));

// Same resolution and the same flag spelling as log-event.cjs — one convention
// for "which graph does this belong to", so a caller who learns it once is right
// everywhere. Stripped from ANY position: a flag only tolerated at the end is a
// trap for the caller who puts it first.
const ARGV_ALL = process.argv.slice(2);
const GRAPH_FLAG_AT = ARGV_ALL.indexOf('--graph');
const GRAPH_EXPLICIT = GRAPH_FLAG_AT !== -1 || !!process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_DIR = GRAPH_FLAG_AT !== -1
  ? path.resolve(ARGV_ALL[GRAPH_FLAG_AT + 1] || '')
  : (process.env.SHIPYARD_GRAPH_DIR
    ? path.resolve(process.env.SHIPYARD_GRAPH_DIR)
    : path.join(process.cwd(), '.planning', 'graph'));
// Guarded on the -1 case deliberately: `i !== GRAPH_FLAG_AT + 1` with no flag
// present reads as `i !== 0` and eats the SUBCOMMAND, so every invocation without
// `--graph` failed with a usage error — which is how the parallel-marks test
// caught it.
const ARGV = GRAPH_FLAG_AT === -1
  ? ARGV_ALL
  : ARGV_ALL.filter((_, i) => i !== GRAPH_FLAG_AT && i !== GRAPH_FLAG_AT + 1);
const STORE = path.join(GRAPH_DIR, 'drift.json');
// The lock belongs beside the STORE, never at cwd: a judge running in a worktree
// would otherwise take a lock nobody else contends for and serialize nothing.
const LOCK_ROOT = path.resolve(GRAPH_DIR, '..', '..');

function fail(msg) {
  process.stderr.write(`drift-record: ${msg}\n`);
  process.exit(1);
}

function planHash(planPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(planPath)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return raw && typeof raw === 'object' && raw.tickets ? raw : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
}

// The whole read-modify-write, under one lock. drift-gate dispatches its judges
// in PARALLEL and tells each to record its own verdict, so unsynchronized
// load→save loses updates: six concurrent marks reliably produced five records,
// and a lost verdict is a stale plan handed to an executor. writeAtomic on top,
// because state-sync and the sentinel read this store while it is being written
// and a torn read silently un-parks the ticket for that round.
function mutate(fn) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  return withLock(lockDirFor(LOCK_ROOT), 'drift-record', () => {
    const store = load();
    const result = fn(store);
    writeAtomic(STORE, JSON.stringify(store, null, 2) + '\n');
    return result;
  }, { label: 'drift-record' });
}

/**
 * The verdicts still in force: an entry survives only while the plan it was
 * recorded against is byte-identical. Returns {ticket: reason}, the shape
 * `computeFront` takes as `opts.drifted`. Callers get expiry for free.
 */
function activeDrift(cwd = process.cwd()) {
  const store = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'graph', 'drift.json'), 'utf8'));
      return raw && raw.tickets ? raw.tickets : {};
    } catch {
      return {};
    }
  })();
  const out = {};
  for (const [id, rec] of Object.entries(store)) {
    if (!rec || !rec.plan) continue;
    const current = planHash(path.isAbsolute(rec.plan) ? rec.plan : path.join(cwd, rec.plan));
    // No plan file at all → the ticket was removed or the path moved; treat the
    // verdict as spent rather than parking on a plan nobody can read.
    if (!current || current !== rec.plan_hash) continue;
    out[id] = rec.reason || 'the plan predates what shipped';
  }
  return out;
}

if (require.main === module) {
  const [cmd, ...rest] = ARGV;

  // The guard that makes the flag's absence loud. Modelled on log-event.cjs: a
  // store written beside no ticket graph is unreadable, not merely misplaced —
  // state-sync only ever looks in the project, so the verdict is lost AND a
  // stray .planning/ appears in whatever checkout the agent happened to stand in.
  if (!GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) {
    fail(
      `no ticket graph at ${GRAPH_DIR} — refusing to record a verdict nothing will read.\n` +
      '  state-sync reads the PROJECT\'s store; one written in a worktree is silently ignored,\n' +
      '  so the ticket keeps being offered as executable — the very thing this record prevents.\n' +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph\n' +
      '  (or set SHIPYARD_GRAPH_DIR) — which is what a drift judge in a worktree must do.'
    );
  }

  if (cmd === 'mark') {
    const [ticket, plan, ...reason] = rest;
    if (!ticket || !plan) fail('usage: drift-record.cjs mark <ticket> <plan-path> <reason...> [--graph <dir>]');
    const hash = planHash(plan);
    if (!hash) fail(`cannot read the plan at ${plan} — a verdict with no plan to bind to would never expire`);
    // Stored absolute: `mark` runs from a worktree while `activeDrift` reads from
    // the project root, so a path relative to either one resolves in the other.
    const planAbs = path.resolve(plan);
    mutate((store) => {
      store.tickets[ticket] = {
        plan: planAbs,
        plan_hash: hash,
        reason: reason.join(' ') || 'the plan predates what shipped',
        at: new Date().toISOString(),
      };
    });
    console.log(`drift recorded for ${ticket} in ${STORE} (lifts automatically when ${planAbs} changes)`);
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: drift-record.cjs clear <ticket> [--graph <dir>]');
    const had = mutate((store) => {
      const present = !!store.tickets[ticket];
      delete store.tickets[ticket];
      return present;
    });
    console.log(had ? `drift cleared for ${ticket}` : `no drift recorded for ${ticket}`);
  } else if (cmd === 'list') {
    const active = activeDrift(path.resolve(GRAPH_DIR, '..', '..'));
    if (rest.includes('--json')) {
      console.log(JSON.stringify(active, null, 2));
    } else if (!Object.keys(active).length) {
      console.log('no drift verdicts in force');
    } else {
      for (const [id, reason] of Object.entries(active)) console.log(`${id}: ${reason}`);
    }
  } else {
    fail('usage: drift-record.cjs <mark|clear|list> …');
  }
}

module.exports = { activeDrift, planHash };
