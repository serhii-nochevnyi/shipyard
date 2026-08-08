#!/usr/bin/env node
'use strict';

// drift-record.cjs — the durable home for a drift verdict.
//
//   drift-record.cjs mark  <ticket> <plan-path> <reason...>
//   drift-record.cjs clear <ticket>
//   drift-record.cjs list  [--json]
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

const GRAPH_DIR = path.join(process.cwd(), '.planning', 'graph');
const STORE = path.join(GRAPH_DIR, 'drift.json');

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

function save(store) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
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
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'mark') {
    const [ticket, plan, ...reason] = rest;
    if (!ticket || !plan) fail('usage: drift-record.cjs mark <ticket> <plan-path> <reason...>');
    const hash = planHash(plan);
    if (!hash) fail(`cannot read the plan at ${plan} — a verdict with no plan to bind to would never expire`);
    const store = load();
    store.tickets[ticket] = {
      plan,
      plan_hash: hash,
      reason: reason.join(' ') || 'the plan predates what shipped',
      at: new Date().toISOString(),
    };
    save(store);
    console.log(`drift recorded for ${ticket} (lifts automatically when ${plan} changes)`);
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: drift-record.cjs clear <ticket>');
    const store = load();
    if (!store.tickets[ticket]) { console.log(`no drift recorded for ${ticket}`); process.exit(0); }
    delete store.tickets[ticket];
    save(store);
    console.log(`drift cleared for ${ticket}`);
  } else if (cmd === 'list') {
    const active = activeDrift();
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
