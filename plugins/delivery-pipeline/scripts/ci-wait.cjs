#!/usr/bin/env node
'use strict';

// ci-wait.cjs — the one legitimate way for the conveyor to wait.
//
//   ci-wait.cjs [--graph <dir>] [--timeout <s>] [--interval <s>] [--json]
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The babysit loop is not a loop. It is driven by agent-completion wake-ups: an
// agent finishes, the session is re-invoked, it does a round, it stops. That is
// the right design and it costs nothing while agents work. It has one hole, and
// it is structural: WHEN THE ONLY THING LEFT IS WAITING, NOTHING WILL EVER WAKE
// THE SESSION AGAIN. The front says so honestly — waiting on CI is "not a
// fixpoint, and not a reason to block" — and the stop gate honours it. So the run
// stops, correctly, and never comes back.
//
// Measured on the pdffiller proving ground. The operator asked, in three words,
// for the phase to be merged. A stacked cascade turns that into one CI round PER
// TICKET: the sentinel squashes a child into the epic, GitHub retargets the
// grandchild, the squash has rewritten history so the grandchild goes DIRTY,
// base-merge fixes it, the push re-runs 17 checks. Four tickets, four serialized
// waits. The run survived none of them: it merged one ticket, resolved one
// conflict, stopped to wait — and sat there with the next PR green, conform and
// ready, until a person came back. "Merge everything" needed three wake-ups that
// do not exist in the system.
//
// ── WHY WAITING IN THE FOREGROUND IS CORRECT HERE, AND WAS NOT BEFORE ────────
// This repo removed `gh pr checks --watch` for good reason: a run that blocks on
// one PR's checks stops driving every other ticket, which is the defect front.cjs
// was written to fix. That reasoning is about OPPORTUNITY COST, and it evaporates
// exactly when the board has nothing else to offer. If the front is empty but for
// `waiting.ci`, there is no other work to serialize against — and blocking means
// the TURN NEVER ENDS, so no wake-up is needed at all. The hole closes itself.
//
// The distinction has to be MECHANICAL, or the old defect walks back in the first
// time someone runs this at the wrong moment. Hence: this script REFUSES to wait
// whenever the board holds anything actionable, and says what to do instead.
// Under `--json` a refusal is data (`waited: false` + `refusal`), because the
// caller is a loop, not a person.
//
// It also refuses when tickets are `waiting.dispatched`: an agent completion is a
// wake-up the runtime gives for free and gives sooner. Waiting on CI while an
// agent works would only add latency to a round that was already going to happen.
//
// ── EXITS ────────────────────────────────────────────────────────────────────
//   0  something settled, or the timeout passed — either way, go round again
//   3  refused: the board has work, or there is nothing to wait for
//   2  usage
// Never anything else: a waiter that dies noisily teaches the loop to stop
// calling it, and then the hole is back.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

function flag(name, dflt) {
  const at = argv.indexOf(name);
  if (at === -1) return dflt;
  const v = Number(argv[at + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    process.stderr.write(`ci-wait: ${name} needs a positive number of seconds\n`);
    process.exit(2);
  }
  return v;
}

// Long enough to cover a real CI run on this repo's own scale (17 checks, ~8-12
// minutes observed), short enough that one call is a bounded commitment the
// caller can decide to repeat. The loop re-syncs and re-decides between calls,
// so a stuck pipeline costs one window, not a night.
const TIMEOUT_S = flag('--timeout', 15 * 60);
const INTERVAL_S = flag('--interval', 30);

// Same resolution and the same flag spelling as log-event.cjs / drift-record.cjs
// — one convention for "which graph is this", and a flag-shaped token is not a
// directory.
function resolveGraphDir() {
  const at = argv.indexOf('--graph');
  if (at !== -1) {
    const v = argv[at + 1];
    if (v === undefined || v.startsWith('--')) {
      process.stderr.write(`ci-wait: --graph needs a directory value (got ${v === undefined ? 'nothing' : `the flag "${v}"`})\n`);
      process.exit(2);
    }
    return path.resolve(v);
  }
  if (process.env.SHIPYARD_GRAPH_DIR) return path.resolve(process.env.SHIPYARD_GRAPH_DIR);
  return path.join(process.cwd(), '.planning', 'graph');
}

const GRAPH = resolveGraphDir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function refuse(reason, hint) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ waited: false, refusal: reason, hint }, null, 2) + '\n');
  } else {
    process.stdout.write(`ci-wait: refusing to wait — ${reason}\n  ${hint}\n`);
  }
  process.exit(3);
}

function finish(payload, human) {
  if (JSON_OUT) process.stdout.write(JSON.stringify({ waited: true, ...payload }, null, 2) + '\n');
  else process.stdout.write(human + '\n');
  process.exit(0);
}

const front = readJson(path.join(GRAPH, 'delivery-front.json'));
const state = readJson(path.join(GRAPH, 'delivery-state.json'));
if (!front || !state) {
  refuse(`no board at ${GRAPH}`,
    'Run state-sync.cjs from the project (or pass --graph <project>/.planning/graph).');
}

// THE GUARD. Anything actionable and left-behind-adjusted means the run owes work
// now, and waiting instead is the serialization defect this script exists not to
// reintroduce.
const actionableCount = Number(front.actionable_count || 0);
const leftBehind = Number(front.left_behind_count || 0);
if (actionableCount > 0 && leftBehind < actionableCount) {
  const named = ['execute', 'publish', 'fix', 'finalize', 'merge']
    .filter((k) => (front.actionable?.[k] || []).length)
    .map((k) => `${k}: ${front.actionable[k].join(', ')}`)
    .join(' | ');
  refuse(`the board has ${actionableCount} actionable item(s) (${named})`,
    'Take that work first. Waiting while the board has moves is what front.cjs was written to stop.');
}

const dispatched = (front.waiting && front.waiting.dispatched) || [];
if (dispatched.length) {
  refuse(`${dispatched.length} ticket(s) are with an agent (${dispatched.join(', ')})`,
    'An agent completion wakes the run for free and sooner; this would only add latency.');
}

const ciTickets = (front.waiting && front.waiting.ci) || [];
if (!ciTickets.length) {
  refuse('nothing is waiting on CI',
    front.fixpoint === true
      ? 'The board reports a fixpoint — this run is done.'
      : 'Re-read the front: whatever is left is not a wait this script can shorten.');
}

// One watch target per ticket, scoped to the ticket's OWN repo — the same rule
// state-sync obeys, and for the same reason: watching the wrong repository
// reports a foreign PR as pending forever.
const watch = [];
for (const id of ciTickets) {
  const s = state[id];
  if (!s || !s.pr) continue;
  watch.push({ id, pr: s.pr, repo: s.repo || null });
}
if (!watch.length) {
  refuse(`the ${ciTickets.length} ticket(s) waiting on CI have no PR recorded (${ciTickets.join(', ')})`,
    'That is a board bug, not a wait: re-run state-sync.cjs.');
}

// `gh pr checks` reports CI state through its EXIT CODE (8 = pending, 1 =
// failing/no checks) while still printing JSON — so a non-zero exit here is
// DATA, not an error. state-sync.cjs carries the same note; getting it wrong
// makes a pending pipeline look like a broken command.
function checksOf({ pr, repo }) {
  const args = ['pr', 'checks', String(pr), '--json', 'state,name'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60000 });
  let rows;
  try { rows = JSON.parse(r.stdout || '[]'); } catch { rows = null; }
  if (!Array.isArray(rows)) return null; // unreachable this round; try the next
  const pending = rows.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(c.state));
  const failing = rows.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.state));
  return { total: rows.length, pending: pending.length, failing: failing.length };
}

const startedAt = Date.now();
const deadline = startedAt + TIMEOUT_S * 1000;
const label = watch.map((w) => `${w.id}#${w.pr}`).join(', ');
if (!JSON_OUT) {
  process.stdout.write(
    `ci-wait: the board offers nothing but CI — waiting on ${label}\n` +
    `  up to ${Math.round(TIMEOUT_S / 60)}m, polling every ${INTERVAL_S}s; returns the moment one settles\n`);
}

// Node has no synchronous sleep, and a busy loop would burn a core for fifteen
// minutes. Sleeping in a child process is the portable version.
const sleep = (s) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.round(s * 1000)})`], { timeout: (s + 5) * 1000 });

let rounds = 0;
for (;;) {
  rounds += 1;
  const seen = [];
  for (const w of watch) {
    const c = checksOf(w);
    seen.push({ ...w, checks: c });
    // Settled means the answer exists: green or red, both change the board and
    // both are the caller's business, not this script's. A waiter that only
    // returned on GREEN would hold a run hostage to a red pipeline.
    if (c && c.total > 0 && c.pending === 0) {
      finish(
        { settled: w.id, pr: w.pr, checks: c, rounds, waited_s: Math.round((Date.now() - startedAt) / 1000), watched: seen },
        `ci-wait: ${w.id} (PR #${w.pr}) settled after ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
        `${c.total - c.failing}/${c.total} green${c.failing ? `, ${c.failing} failing` : ''}. ` +
        'Re-sync and take the round.');
    }
  }
  if (Date.now() >= deadline) {
    finish(
      { settled: null, timed_out: true, rounds, waited_s: Math.round((Date.now() - startedAt) / 1000), watched: seen },
      `ci-wait: ${Math.round(TIMEOUT_S / 60)}m passed and nothing settled (${label}). ` +
      'Re-sync anyway — the board may have moved for other reasons — then decide whether to wait again.');
  }
  sleep(Math.min(INTERVAL_S, Math.max(1, (deadline - Date.now()) / 1000)));
}
