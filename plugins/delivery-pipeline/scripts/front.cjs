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
//     merge     — open PR green + conform, targeting the STACK (epic/parent):
//                 the sentinel squashes it in (auto-merge only, see below)
//   waiting (NOT actionable, and NOT a fixpoint either — motion resumes by itself):
//     ci        — checks still running
//   parked (compatible with a fixpoint — only a human or a replan moves these):
//     merge_human — green, out of draft, but the merge is a human action
//                   (auto-merge off, direct-to-main, or the PR targets the
//                   integration branch)
//     human     — a human_checkpoint ticket that has cleared its gate
//     blocked   — dependencies unsatisfied, or parked by the run (--parked)
//     done      — merged
//
// fixpoint = no actionable work AND nothing waiting on CI. A PR whose checks are
// still running is NOT a fixpoint: the round has to come back to it. But it is
// also not a reason to block — the run serves the rest of the front meanwhile,
// and only ever `--watch`es when that PR is the last thing left.
//
// OWNERSHIP. fix/finalize/merge are the PR SENTINEL's duty (sentinel.cjs), which
// runs alongside the main loop; execute/publish belong to the main loop. The
// split matters because it is what lets the run cascade onward while the tail of
// open PRs is still being driven to green — before it, an unmerged green PR was
// simply "waiting on a human" and the run declared a fixpoint on top of it.

const ORDER = ['execute', 'publish', 'fix', 'finalize', 'merge'];
const SENTINEL_BUCKETS = ['fix', 'finalize', 'merge'];

// Session-only facts (attempts > MAX, an agent that returned `escalate`) are
// invisible to state-sync, and a front that keeps re-offering an escalated PR is
// an infinite babysit loop. The caller passes those ids in.
function computeFront(tickets, state, opts = {}) {
  const parkedIds = new Set(opts.parked || []);
  // A drift verdict is a fact about the PLAN, not about a session, so unlike
  // `parked` it has to outlive the run that discovered it. Without that the front
  // re-offers the ticket as executable on every single run: two tickets confirmed
  // stale on 2026-08-06 were still being listed under `execute` days later, and
  // deliver.md's promise that a drifted ticket is "marked needs-replan" pointed
  // at a mark nothing wrote and nothing read. The caller supplies
  // {ticket: reason}; it is expected to drop entries whose plan has since been
  // re-planned, so the park lifts by itself rather than becoming permanent.
  const drifted = opts.drifted || {};
  // Auto-merge is a config decision (pipeline.auto_merge) that state-sync passes
  // in; the front never guesses it, because the difference is whether an unmerged
  // green PR is the run's work or a human's.
  const autoMerge = opts.autoMerge === true;
  const actionable = { execute: [], publish: [], fix: [], finalize: [], merge: [] };
  const waiting = { ci: [], merge_human: [], human: [] };
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

    // Checked BEFORE `merged`: a ticket can be both drifted and already landed
    // under other names, and calling that "done" would hide the stale plan.
    if (drifted[id] && s.status !== 'merged') {
      parked.blocked.push(id);
      why[id] = `drifted — ${drifted[id]}. Re-plan it (/shipyard:decompose); executing this plan builds against a codebase that moved.`;
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
      } else if (autoMerge && s.review_decision !== 'CHANGES_REQUESTED' && gateConform(s) && s.merge_scope === 'stacked') {
        // The sentinel's merge: into the epic or a parent ticket branch only.
        // `merge_scope` is set by state-sync; an integration-branch target never
        // gets it, so a phase can never land on the default branch without a
        // human. sentinel.cjs re-verifies all of this against live GitHub.
        actionable.merge.push(id);
        why[id] = `PR #${s.pr}: green + conform — squash into ${s.pr_base || s.base} (sentinel)`;
      } else if (autoMerge && gateConform(s) && s.merge_scope !== 'stacked') {
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: green + conform, but it targets ${s.pr_base || s.base} — that merge is a human's`;
      } else if (s.review_decision === 'APPROVED' && !autoMerge) {
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: approved + green — awaiting merge (human)`;
      } else if (autoMerge && !gateConform(s)) {
        // Green and out of draft, but the architecture verdict was never
        // recorded on the PR. With auto-merge on that trailer IS the gate, so
        // the run owes the work rather than parking on a human.
        actionable.finalize.push(id);
        why[id] = `PR #${s.pr}: green, no \`gate_status: arch-review=conform\` trailer — threads + arch-review still owed`;
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
    merge: actionable.merge.length,
    ci: waiting.ci.length,
    merge_human: waiting.merge_human.length,
    human: waiting.human.length,
    blocked: parked.blocked.length,
    done: parked.done.length,
  };
  const actionableCount = ORDER.reduce((n, k) => n + actionable[k].length, 0);
  const fixpoint = actionableCount === 0 && waiting.ci.length === 0;
  // What the sentinel owns (open PRs) vs what the main loop owns (new tickets).
  // deliver.md splits the run on exactly this line.
  const sentinel = {
    duty: SENTINEL_BUCKETS.flatMap((k) => actionable[k]),
    waiting_ci: waiting.ci.slice(),
  };
  sentinel.clear = sentinel.duty.length === 0 && sentinel.waiting_ci.length === 0;

  // SHALLOWEST FIRST inside every bucket. A ticket stacked on an open parent is
  // work that will have to be redone: when the parent lands, this branch's base
  // moves, CI re-runs against different code and reviewers re-read a changed
  // diff. Ordering by stack depth is what makes "drive the parents first" the
  // default rather than a thing to remember, and it costs one comparison.
  const depth = (id, seen = new Set()) => {
    const parent = ((tickets && tickets[id]) || {}).primary_parent;
    if (!parent || seen.has(id)) return 0;
    seen.add(id);
    return ((state[parent] || {}).status === 'merged' ? 0 : 1) + depth(parent, seen);
  };
  const byDepth = (a, b) => depth(a) - depth(b) || String(a).localeCompare(String(b));
  for (const k of Object.keys(actionable)) actionable[k].sort(byDepth);

  return { actionable, waiting, parked, why, counts, actionable_count: actionableCount, fixpoint, sentinel, roles: BUCKET_ROLES };
}

// The arch-review verdict is recorded as a `gate_status:` trailer in the PR body
// (it survives a squash merge) and parsed by state-sync into state[id].gate.
function gateConform(s) {
  return String(((s && s.gate) || {})['arch-review'] || '').toLowerCase() === 'conform';
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
// Which ladder ROLE each actionable bucket dispatches. The front's buckets and
// the model ladder's roles are two different vocabularies for the same work
// (`execute` vs `executor`, `merge` vs `pr-sentinel`), and nothing used to map
// between them — so a run reading the board naturally logged `role=finalize` or
// `role=merge`, names `pipeline-config.cjs model <role>` rejects. The dispatch
// then resolved no model from role × risk × attempt and someone picked one by
// hand. Publishing has no agent at all: the main loop pushes and opens the PR
// itself, deliberately, so that the "did work" gate is not run by the thing it
// checks. Stating the mapping here is what makes the invented names unnecessary.
const BUCKET_ROLES = {
  execute: ['executor'],
  publish: [],
  fix: ['ci-fix', 'review-fix'],
  finalize: ['review-fix', 'arch-review'],
  merge: ['pr-sentinel'],
};

function formatFront(front) {
  const lines = [];
  const parts = ORDER.filter((k) => front.actionable[k].length)
    .map((k) => `${k}: ${front.actionable[k].join(', ')}`);
  lines.push(`front: ${front.actionable_count} actionable now${parts.length ? ` — ${parts.join(' | ')}` : ''}`);
  // Name the role each live bucket dispatches, so the run resolves a model with
  // `model <role>` instead of passing the bucket's own name — which the ladder
  // does not know and silently declines to route.
  const live = ORDER.filter((k) => front.actionable[k].length && (BUCKET_ROLES[k] || []).length);
  if (live.length) {
    lines.push(`  dispatch roles (for "model <role>"): ${live.map((k) => `${k} → ${BUCKET_ROLES[k].join(' / ')}`).join(', ')}`);
  }

  const wparts = [];
  if (front.waiting.ci.length) wparts.push(`ci: ${front.waiting.ci.join(', ')}`);
  if (front.waiting.merge_human.length) wparts.push(`merge (human): ${front.waiting.merge_human.join(', ')}`);
  if (front.waiting.human.length) wparts.push(`checkpoint (human): ${front.waiting.human.join(', ')}`);
  if (wparts.length) lines.push(`waiting: ${wparts.join(' | ')}`);

  // The sentinel's share of the front, named separately: it is the part that a
  // background guard can take over so the main loop keeps cascading.
  const s = front.sentinel || { duty: [], waiting_ci: [], clear: true };
  lines.push(s.clear
    ? 'sentinel: clear — no open PR needs guarding'
    : `sentinel: ${s.duty.length} duty${s.duty.length ? ` (${s.duty.join(', ')})` : ''}` +
      `${s.waiting_ci.length ? ` + ${s.waiting_ci.length} waiting on CI` : ''} — post/keep the guard, do NOT wait on it`);

  if (front.fixpoint) {
    lines.push(
      front.counts.blocked || front.counts.merge_human || front.counts.human
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
  // auto_merge decides whether an unmerged green PR is the sentinel's work or a
  // human's, so the standalone CLI has to read it too (state-sync passes it in).
  const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
  const { config } = loadConfig(root);
  const autoMerge = config.auto_merge === 'epic' && config.integration_mode === 'epic-stacked';
  const front = computeFront(tickets, state, { parked, autoMerge });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(front, null, 2) + '\n');
  } else {
    for (const line of formatFront(front)) console.log(line);
  }
  process.exit(0);
}
