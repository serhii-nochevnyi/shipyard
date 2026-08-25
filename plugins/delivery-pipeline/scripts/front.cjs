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

// Facts GitHub cannot know. `parked` is the session-scoped channel — a judgement
// made mid-run that has no home on disk yet; a front that keeps re-offering an
// escalated PR is an infinite babysit loop, so the caller passes those ids in.
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
  // An escalation is the same shape of fact one level down: not about the plan,
  // but about the PR as it stood when the run gave up. It used to travel ONLY as
  // `--parked`, so it died with the session and the next run re-dispatched
  // review-fix and arch-review against a PR a human had already been asked to
  // handle — with the reason, the only part worth inheriting, gone. The caller
  // supplies {ticket: reason} and is expected to drop entries whose PR has since
  // moved, so a human answering the review lifts the park by itself.
  const escalated = opts.escalated || {};
  // Auto-merge is a config decision (pipeline.auto_merge) that state-sync passes
  // in; the front never guesses it, because the difference is whether an unmerged
  // green PR is the run's work or a human's.
  const autoMerge = opts.autoMerge === true;
  // Expected CI length per ticket, in seconds, supplied by the caller —
  // `ciEstimates` below derives it and BOTH entry points pass it in. It is data,
  // not a lookup: computeFront is a pure function over its inputs and reads no
  // file, so the journal is opened by the caller or not at all.
  const ciEst = opts.ci_estimates || {};
  // The parent ticket id when this child's base is an OPEN human_checkpoint PR,
  // else null. `sentinel.cjs` computes the same thing for its own gate — the two
  // must agree, or the front keeps offering a merge the guard refuses.
  const checkpointParent = (id) => {
    const parent = ((tickets && tickets[id]) || {}).primary_parent;
    if (!parent) return null;
    if (!((tickets && tickets[parent]) || {}).human_checkpoint) return null;
    return (state[parent] || {}).status === 'pr-open' ? parent : null;
  };

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

    // After `merged` — unlike drift. A drifted plan stays worth flagging even
    // when the work landed under other names, but an escalation is a verdict on
    // getting this PR in: if it is in, there is nothing left to escalate.
    if (escalated[id]) {
      parked.blocked.push(id);
      why[id] = `escalated — ${escalated[id]}. It lifts by itself once the PR moves (a push, a review answer, undrafting); \`escalation-record.cjs clear ${id}\` to take it back.`;
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
      } else if (autoMerge && gateConform(s) && s.merge_scope === 'stacked' && checkpointParent(id)) {
        // Ready in every respect, and still not the run's to land: the base is a
        // parent whose ticket is a human_checkpoint with an OPEN PR. Squashing
        // there rewrites the diff that person is reading, and the post-merge
        // retarget would send this child's own children to the epic — content
        // that is actually sitting in a checkpoint branch. `sentinel.cjs merge`
        // refuses it; the front must not offer what the guard will refuse, or
        // every round re-proposes the same impossible action.
        //
        // waiting.human, NOT parked: nobody owes work here, a person holds the
        // key — the same class the front already models. Three of five
        // escalations in one phase existed only to hold this by hand.
        waiting.human.push(id);
        why[id] = `PR #${s.pr}: green + conform, but its base is ${checkpointParent(id)} — a human_checkpoint PR still open. It merges once that one lands.`;
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
  // SHALLOWEST FIRST within a stack — the THIRD sort key now; the full order is
  // stated at the comparator below. A ticket stacked on an open parent is
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
  // …but depth only orders work WITHIN a stack. Across phases it says nothing,
  // and sorting by it alone promotes the oldest left-behind tickets to the head
  // of the list: a phase-2 root has depth 0, so it outranks every live child of
  // the phase being worked. Observed immediately after shipping the sort — two
  // tickets judged stale six days earlier sat first under `execute`, and a run
  // that takes the head of the list would have taken one.
  //
  // "Left behind" is a phase the run has already moved past: something newer has
  // landed. Those go LAST — still listed, because the fixpoint must not lie about
  // them, but never ahead of work that is actually in flight.
  const phaseNum = (id) => Number.parseInt(String(((tickets && tickets[id]) || {}).phase ?? ''), 10) || 0;
  const newestLandedPhase = Object.keys(state)
    .filter((id) => (state[id] || {}).status === 'merged')
    .reduce((max, id) => Math.max(max, phaseNum(id)), 0);
  const leftBehind = (id) => (phaseNum(id) < newestLandedPhase ? 1 : 0);

  // UNBLOCKING POWER — how much other work this ticket is holding up. Depth
  // orders a stack and left-behind demotes an abandoned phase, but neither says
  // which of two live roots to take, and unattended that is the decision that
  // matters: the head of the list is what the 04:00 round picks up, so it should
  // be the ticket that leaves the most work available behind it.
  //
  // Counted over `depends_on` (the whole DAG) rather than `primary_parent` (the
  // branch stack): a ticket can gate work it was never going to be the base of.
  const dependents = new Map();
  for (const [cid, t] of Object.entries(tickets || {})) {
    for (const dep of (t && t.depends_on) || []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(cid);
    }
  }
  // A FRESH visited set per root, memoised by root. validate-graph.cjs already
  // paid for the other half of this: ancestor closures computed with a set
  // SHARED across recursions cached truncated closures and rejected valid
  // diamond graphs. The mirror-image defect here is inflation — in A←B, A←C,
  // B←D, C←D, D is reachable by two paths and must still count ONCE for A. The
  // same set makes the walk cycle-tolerant: Gate 2 proves the graph acyclic, but
  // the front must not hang on a corrupt file.
  const descCache = new Map();
  const descendants = (id) => {
    if (descCache.has(id)) return descCache.get(id);
    const seen = new Set([id]);
    const stack = (dependents.get(id) || []).slice();
    let n = 0;
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      // Merged dependents are walked THROUGH — their own children are still held
      // up — but never counted: a merged ticket needs no unblocking.
      if ((state[cur] || {}).status !== 'merged') n++;
      for (const next of dependents.get(cur) || []) stack.push(next);
    }
    descCache.set(id, n);
    return n;
  };
  // Longest pipeline first: starting the slowest one earliest is what overlaps
  // its wait with the rest of the front. A missing or malformed entry ties at 0
  // rather than poisoning the comparator.
  const ciLen = (id) => Number(ciEst[id]) || 0;

  // The order inside every actionable bucket:
  //   leftBehind  ASC   an abandoned phase never leads (unchanged, still first)
  //   descendants DESC  the widest unblocker first
  //   depth       ASC   then top-down within a stack
  //   ciLen       DESC  then the longest pipeline, started earliest
  //   id          ASC   a stable tiebreak, so the board does not shuffle
  //
  // Descendants-before-depth keeps "drive the parents first" by construction
  // rather than by luck: a parent's descendant set strictly contains its
  // unmerged child's, so the parent always wins that key outright.
  const byUnblocking = (a, b) =>
    leftBehind(a) - leftBehind(b) ||
    descendants(b) - descendants(a) ||
    depth(a) - depth(b) ||
    ciLen(b) - ciLen(a) ||
    String(a).localeCompare(String(b));
  for (const k of Object.keys(actionable)) actionable[k].sort(byUnblocking);

  // What the sentinel owns (open PRs) vs what the main loop owns (new tickets).
  // deliver.md splits the run on exactly this line. Built AFTER the sort so the
  // duty line and the buckets it is drawn from cannot print two different orders
  // of the same work. (The guard's own serving order is sentinel.cjs's — this is
  // the board's view of its share.)
  const sentinel = {
    duty: SENTINEL_BUCKETS.flatMap((k) => actionable[k]),
    waiting_ci: waiting.ci.slice(),
  };
  sentinel.clear = sentinel.duty.length === 0 && sentinel.waiting_ci.length === 0;

  // How much of the actionable list is work the run has already moved past. The
  // stop condition has to distinguish "there is live work" from "there is only
  // abandoned work": on a real board `fixpoint: NO — 4 actionable` was held
  // ENTIRELY by two tickets judged stale six days earlier, so the run was being
  // told that stopping is a defect on account of work it would never take.
  const actionableIds = ORDER.flatMap((k) => actionable[k]);
  const leftBehindCount = actionableIds.filter((id) => leftBehind(id)).length;

  return { actionable, waiting, parked, why, counts, actionable_count: actionableCount, left_behind_count: leftBehindCount, fixpoint, sentinel, roles: BUCKET_ROLES };
}

// The arch-review verdict is recorded as a `gate_status:` trailer in the PR body
// (it survives a squash merge) and parsed by state-sync into state[id].gate.
function gateConform(s) {
  return String(((s && s.gate) || {})['arch-review'] || '').toLowerCase() === 'conform';
}

// EXPECTED CI LENGTH, as a per-repo median over the delivery journal.
//
// A PROXY, and named as one: what is journalled is the PR's LIFETIME (first
// `pr-open` → first `merged`), not CI wall time — nothing records the latter, so
// this number carries review latency and merge-queue waiting with it. That is
// exactly why it is the front's LAST key before the id: it breaks ties between
// otherwise indistinguishable tickets and never outranks unblocking power or
// stack depth.
//
// Grouped by repo because a phase spanning a backend and a frontend repo has two
// unrelated pipelines, and a median from one says nothing about the other.
// MEDIAN, not mean: one PR that sat over a weekend must not redefine its repo.
//
// It reads the LOCAL journal only. Nothing here may grow into a per-PR `gh`
// field — that is the 41s-vs-7s lesson state-sync's bulk window records.
function ciEstimates(graphDir, tickets = {}) {
  const fs = require('fs');
  const path = require('path');
  const repoKey = (id) => String(((tickets && tickets[id]) || {}).repo || '');
  const out = {};
  for (const id of Object.keys(tickets || {})) out[id] = 0;

  let raw;
  try {
    raw = fs.readFileSync(path.join(graphDir, 'delivery-log.jsonl'), 'utf8');
  } catch (e) {
    // No journal yet (a first run, or a fresh graph): everyone estimates 0 and
    // the term falls through to the id, which is the pre-existing order.
    return out;
  }

  // FIRST occurrence wins. The journal is append-only, so the earliest entry for
  // a (ticket, status) pair is when the ticket actually reached that status; a
  // later duplicate is a resync re-observing it.
  const firstAt = new Map();
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    // state-sync appends under a lock this read does not take, so a torn tail is
    // reachable. It must cost one sample, never the whole front.
    try { e = JSON.parse(s); } catch (_) { continue; }
    if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    const key = `${e.ticket}\u0000${e.to}`;
    if (!firstAt.has(key)) firstAt.set(key, ms);
  }

  const samples = new Map();
  for (const key of firstAt.keys()) {
    const sep = key.indexOf('\u0000');
    if (key.slice(sep + 1) !== 'merged') continue;
    const id = key.slice(0, sep);
    const opened = firstAt.get(`${id}\u0000pr-open`);
    // Merged with no journalled `pr-open` (imported history, a PR opened before
    // the conveyor watched it): there is no lifetime to measure, so no sample.
    if (!Number.isFinite(opened)) continue;
    const secs = (firstAt.get(key) - opened) / 1000;
    if (!(secs > 0)) continue;
    const r = repoKey(id);
    if (!samples.has(r)) samples.set(r, []);
    samples.get(r).push(secs);
  }

  const medians = new Map();
  for (const [r, xs] of samples) {
    const sorted = xs.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    medians.set(r, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }
  // Every ticket gets its OWN repo's median; a repo with no merged sample yet
  // estimates nothing, which ties it at 0.
  for (const id of Object.keys(out)) out[id] = medians.get(repoKey(id)) || 0;
  return out;
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
  } else if (front.left_behind_count && front.left_behind_count === front.actionable_count) {
    // Every actionable item is in a phase the run has already moved past. Saying
    // "ending the run is a defect" here is false: continuing would mean taking
    // work that has been offered and declined every round for days. The honest
    // verdict names the two exits instead of demanding motion.
    lines.push(
      `fixpoint: NO — but ALL ${front.actionable_count} actionable item(s) are in phases already moved past ` +
      `(${front.actionable.execute.concat(front.actionable.fix, front.actionable.finalize).slice(0, 6).join(', ')}). ` +
      'Nothing live remains. These are a decision, not motion: take them, or record why not ' +
      '(`drift-record.cjs mark` when the plan predates what shipped) — after which this reads `fixpoint: YES`.'
    );
  } else {
    lines.push(
      `fixpoint: NO — ${front.actionable_count} item(s) are actionable RIGHT NOW. Ending the run here is a defect ` +
      '(deliver.md Principle). Do not block on `gh pr checks --watch` while this list is non-empty.'
    );
  }
  return lines;
}

module.exports = { computeFront, formatFront, ciEstimates };

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
  // The durable parks — drift verdicts and escalations — must be read here too.
  // deliver.md advertises this CLI as "re-runnable on its own", and it silently
  // was not equivalent: state-sync passed both in, so the same graph produced two
  // different verdicts depending on which command you ran. A ticket parked as
  // drifted read back as `execute` — the exact re-offering drift-record exists
  // to stop.
  const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
  const { activeEscalations } = require(path.join(__dirname, 'escalation-record.cjs'));
  const front = computeFront(tickets, state, {
    parked, autoMerge, drifted: activeDrift(root), escalated: activeEscalations(root, state),
    // …and the ORDER has the same requirement as the verdict: state-sync derives
    // this from the journal, so the CLI must too, or the two commands rank the
    // same graph differently.
    ci_estimates: ciEstimates(dir, tickets),
  });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(front, null, 2) + '\n');
  } else {
    for (const line of formatFront(front)) console.log(line);
  }
  process.exit(0);
}
