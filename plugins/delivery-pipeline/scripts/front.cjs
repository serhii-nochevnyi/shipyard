#!/usr/bin/env node
'use strict';

// The ACTIONABLE FRONT — the conveyor's stop condition, as code.
//
// /shipyard:deliver's first principle is "never end the run while there is
// somewhere to go", and until now that was prose the orchestrating model had to
// re-derive from a board printout every round. It got it wrong in exactly the
// two ways prose fails: it serialized on `gh pr checks --watch` (calling a
// waiting PR "the run") and it read a human_checkpoint as "do nothing at all".
// Both times the run reported a fixpoint while a dozen tickets were executable.
//
// So the verdict is computed here instead, from delivery-state, and printed as
// `fixpoint: YES|NO`. Stopping is legal on YES only.
//
//   actionable now (work the run can start this second, no waiting involved):
//     execute   — undelivered, ready, no branch yet
//     publish   — branch pushed, PR missing (an executor died between the two)
//     fix       — open PR with failing checks
//     finalize  — open PR, checks green: threads/arch-review/conform gate/undraft
//   waiting (NOT actionable, and NOT a fixpoint either — motion resumes by itself):
//     ci        — checks still running
//   parked (compatible with a fixpoint — only a human or a replan moves these):
//     merge     — green, approved, out of draft: the merge is a human action
//     human     — a human_checkpoint ticket that has cleared its gate
//     blocked   — dependencies unsatisfied, or parked by the run (--parked)
//     done      — merged
//
// fixpoint = no actionable work AND nothing waiting on CI. A PR whose checks are
// still running is NOT a fixpoint: the round has to come back to it. But it is
// also not a reason to block — the run serves the rest of the front meanwhile,
// and only ever `--watch`es when that PR is the last thing left.

const ORDER = ['execute', 'publish', 'fix', 'finalize'];

// Session-only facts (attempts > MAX, an agent that returned `escalate`) are
// invisible to state-sync, and a front that keeps re-offering an escalated PR is
// an infinite babysit loop. The caller passes those ids in.
function computeFront(tickets, state, opts = {}) {
  const parkedIds = new Set(opts.parked || []);
  const actionable = { execute: [], publish: [], fix: [], finalize: [] };
  const waiting = { ci: [], merge: [], human: [] };
  const parked = { blocked: [], done: [] };
  const why = {};

  for (const id of Object.keys(state)) {
    const s = state[id] || {};
    const t = (tickets && tickets[id]) || {};

    if (parkedIds.has(id)) {
      parked.blocked.push(id);
      why[id] = 'parked by this run (escalation or attempts exhausted)';
      continue;
    }

    if (s.status === 'merged') {
      parked.done.push(id);
      continue;
    }

    if (s.status === 'pr-open') {
      const c = s.checks || {};
      // `none_reported` means nothing ran, not that everything passed —
      // state-sync warns about it separately; for the front it counts as green
      // so the gate can still be driven (the human is told what "green" meant).
      const green = !((c.failing || 0) > 0) && !((c.pending || 0) > 0);
      if ((c.failing || 0) > 0) {
        actionable.fix.push(id);
        why[id] = `PR #${s.pr}: ${c.failing} failing check(s)`;
      } else if ((c.pending || 0) > 0) {
        waiting.ci.push(id);
        why[id] = `PR #${s.pr}: ${c.pending} check(s) still running`;
      } else if (s.draft) {
        // Draft is the pre-gate state: threads, arch-review and the conform gate
        // are all still ahead, and every one of them is work the run can do now.
        actionable.finalize.push(id);
        why[id] = `PR #${s.pr}: green and still a draft — threads, arch-review, conform gate`;
      } else if (t.human_checkpoint && green) {
        // Out of draft on a checkpoint ticket = the gate was cleared and the
        // approval/merge is the human's. A checkpoint parks the PUBLISH step
        // only; it never justifies leaving the code unwritten (see deliver.md).
        waiting.human.push(id);
        why[id] = `PR #${s.pr}: human_checkpoint — awaiting approval/merge`;
      } else if (s.review_decision === 'APPROVED') {
        waiting.merge.push(id);
        why[id] = `PR #${s.pr}: approved + green — awaiting merge (human)`;
      } else {
        // Green, out of draft, not approved: bot/human review is still open, so
        // there are threads to service and an arch-review verdict to record.
        actionable.finalize.push(id);
        why[id] = `PR #${s.pr}: green, review not settled (${s.review_decision || 'no decision'})`;
      }
      continue;
    }

    if (s.status === 'branched') {
      if (s.ready) {
        actionable.publish.push(id);
        why[id] = 'branch exists, PR missing — run the did-work gate and publish';
      } else {
        parked.blocked.push(id);
        why[id] = blockedWhy(s);
      }
      continue;
    }

    // pending
    if (s.ready) {
      actionable.execute.push(id);
      why[id] = 'ready — worktree + executor';
    } else {
      parked.blocked.push(id);
      why[id] = blockedWhy(s);
    }
  }

  const counts = {
    execute: actionable.execute.length,
    publish: actionable.publish.length,
    fix: actionable.fix.length,
    finalize: actionable.finalize.length,
    ci: waiting.ci.length,
    merge: waiting.merge.length,
    human: waiting.human.length,
    blocked: parked.blocked.length,
    done: parked.done.length,
  };
  const actionableCount = ORDER.reduce((n, k) => n + actionable[k].length, 0);
  const fixpoint = actionableCount === 0 && waiting.ci.length === 0;

  return { actionable, waiting, parked, why, counts, actionable_count: actionableCount, fixpoint };
}

function blockedWhy(s) {
  if (s.blocked_by && s.blocked_by.length) {
    return s.blocked_by
      .map((d) => `${d} (${(s.blocked_reasons || {})[d] || 'blocked'})`)
      .join('; ');
  }
  return 'not ready';
}

// The board lines. Deliberately blunt: the last line is the stop verdict, and it
// names the rule so a run cannot quietly reinterpret it.
function formatFront(front) {
  const lines = [];
  const parts = ORDER.filter((k) => front.actionable[k].length)
    .map((k) => `${k}: ${front.actionable[k].join(', ')}`);
  lines.push(`front: ${front.actionable_count} actionable now${parts.length ? ` — ${parts.join(' | ')}` : ''}`);

  const wparts = [];
  if (front.waiting.ci.length) wparts.push(`ci: ${front.waiting.ci.join(', ')}`);
  if (front.waiting.merge.length) wparts.push(`merge (human): ${front.waiting.merge.join(', ')}`);
  if (front.waiting.human.length) wparts.push(`checkpoint (human): ${front.waiting.human.join(', ')}`);
  if (wparts.length) lines.push(`waiting: ${wparts.join(' | ')}`);

  if (front.fixpoint) {
    lines.push(
      front.counts.blocked || front.counts.merge || front.counts.human
        ? 'fixpoint: YES — nothing actionable and no checks running; only human actions and blockers remain → Step 5'
        : 'fixpoint: YES — everything in scope is delivered → Step 5'
    );
  } else if (front.actionable_count === 0) {
    lines.push(
      `fixpoint: NO — ${front.counts.ci} PR(s) still running CI. Do NOT end the run: serve them when they report ` +
      '(watch is legal here — they are the only thing left).'
    );
  } else {
    lines.push(
      `fixpoint: NO — ${front.actionable_count} item(s) are actionable RIGHT NOW. Ending the run here is a defect ` +
      '(deliver.md Principle). Do not block on `gh pr checks --watch` while this list is non-empty.'
    );
  }
  return lines;
}

module.exports = { computeFront, formatFront };

// ── CLI: read the state files this project already has and print the verdict ──
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const root = process.cwd();
  const dir = path.join(root, '.planning', 'graph');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let tickets = {};
  let state = {};
  try {
    tickets = (read('tickets.json') || {}).tickets || {};
    state = read('delivery-state.json');
  } catch (e) {
    process.stderr.write(`front: cannot read .planning/graph (${e.message}) — run state-sync.cjs first\n`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const pIdx = argv.indexOf('--parked');
  const parked = pIdx === -1 ? [] : String(argv[pIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const front = computeFront(tickets, state, { parked });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(front, null, 2) + '\n');
  } else {
    for (const line of formatFront(front)) console.log(line);
  }
  process.exit(0);
}
