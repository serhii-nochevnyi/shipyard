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
//   * the front is FRESH — a stale file must never trap a session forever;
//   * something is actionable, and not merely waiting on CI (the run is allowed
//     to wait when waiting is all that is left);
//   * that work is not entirely left-behind — a phase the run has moved past is
//     "a decision, not motion" (front.cjs), and demanding motion there is how a
//     guard starts lying;
//   * we have not already blocked this stop (`stop_hook_active`), which is what
//     keeps a refusal from becoming a loop.

const fs = require('fs');
const path = require('path');

const FRONT = path.join(process.cwd(), '.planning', 'graph', 'delivery-front.json');
// Older than this and the front describes a run that is no longer happening.
const FRESH_MS = Number(process.env.SHIPYARD_STOP_GATE_FRESH_MS || 45 * 60 * 1000);

function allow() { process.exit(0); }

let payload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) payload = JSON.parse(raw);
} catch { /* no payload is not a reason to block */ }

// Claude Code sets this when the stop was already blocked once. Ignoring it
// would turn "you still have work" into a session that can never end.
if (payload.stop_hook_active) allow();

if (!fs.existsSync(FRONT)) allow();

let front;
try {
  front = JSON.parse(fs.readFileSync(FRONT, 'utf8'));
} catch {
  allow(); // an unreadable front is a bug to fix elsewhere, not a trap to spring here
}

const generated = Date.parse(front.generated_at || '');
if (!Number.isNaN(generated) && Date.now() - generated > FRESH_MS) allow();

const count = Number(front.actionable_count || 0);
if (count <= 0) allow();
if (Number(front.left_behind_count || 0) >= count) allow();

const ORDER = ['execute', 'publish', 'fix', 'finalize', 'merge'];
const named = ORDER
  .filter((k) => (front.actionable?.[k] || []).length)
  .map((k) => `${k}: ${front.actionable[k].join(', ')}`)
  .join(' | ');

process.stdout.write(JSON.stringify({
  decision: 'block',
  reason:
    `shipyard: the delivery front is not empty — ${count} item(s) are actionable RIGHT NOW (${named}).\n` +
    'Ending the run here is a defect, not a choice (deliver.md, the Principle). Do not summarise and stop:\n' +
    '  1. `state-sync.cjs` for fresh state and a fresh front;\n' +
    '  2. take the actionable items — shallowest stack depth first, the guard owns fix/review/arch-review/merge;\n' +
    '  3. loop back and recompute. Stop only on `fixpoint: YES`.\n' +
    'If an item genuinely must not be taken, park it with a reason (`drift-record.cjs mark` when the plan\n' +
    'predates what shipped) so the front stops offering it — do not leave it listed and walk away.',
}) + '\n');
process.exit(0);
