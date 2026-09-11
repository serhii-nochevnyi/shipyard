#!/usr/bin/env node
'use strict';

// Conveyor retro-metrics: aggregate the telemetry journal
// (.planning/graph/delivery-log.jsonl) + live GitHub PR data into per-ticket
// and per-phase delivery stats. Read-only; safe to run any time.
//
//   pipeline-stats.cjs [--json]
//
// Sources:
//   tickets.json         ticket graph (required)
//   delivery-log.jsonl   attempts / fix rounds / escalations / status history
//   gh pr list           created→merged timing, review decision (one call)
//
// Improvement loop this feeds: escalation rate per risk tier (is the
// role×risk×attempt ladder tuned right?), fix rounds per ticket (are the
// ci-fix/review-fix prompts effective?), no-op share (wasted rounds),
// time-to-merge (conveyor throughput incl. the human merge tail), and the
// reuse-scan hit rate (drift-check runs on a cheap tier — if it never finds an
// existing implementation, that is either a clean codebase or too small a model,
// and without the counter the two are indistinguishable).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));
const { loadConfig, ROLES, EFFORTS, parseRoute } = require(path.join(__dirname, 'pipeline-config.cjs'));

const GRAPH_DIR = path.join(process.cwd(), '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
const asJson = process.argv.includes('--json');

// The WARNINGS need a window; the totals do not. The journal is append-only and
// the graph is regenerated per phase, so without one every warning reports the
// whole history forever: a practice that stopped days ago keeps shouting, and a
// merge a person made last week is still presented as something to look at. That
// is how a report trains its reader to skim it. Rows and counts stay lifetime —
// those are the record. `--since all` restores the old behaviour.
const sinceArg = (() => {
  const i = process.argv.indexOf('--since');
  return i === -1 ? '14d' : String(process.argv[i + 1] || '14d');
})();
const sinceTs = (() => {
  if (sinceArg === 'all') return null;
  const rel = /^(\d+)d$/.exec(sinceArg);
  if (rel) return Date.now() - Number(rel[1]) * 86_400_000;
  const t = Date.parse(sinceArg);
  return Number.isNaN(t) ? Date.now() - 14 * 86_400_000 : t;
})();
const withinWindow = (iso) => {
  if (sinceTs === null) return true;
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? true : t >= sinceTs; // undated → report it rather than hide it
};
const windowLabel = sinceTs === null ? 'all time' : `since ${sinceArg}`;

function fail(msg) {
  console.error(`pipeline-stats: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(TICKETS)) fail('missing .planning/graph/tickets.json — run validate-graph first');
const { tickets } = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));

const journal = fs.existsSync(JOURNAL)
  ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
  : [];

const loadedConfig = loadConfig(process.cwd());
const { config: cfg } = loadedConfig;

// One PR window PER REPO the graph touches. `state-sync` learned this the hard
// way — watching the wrong repository made a ticket whose PR was merged next
// door read as `pending` forever — but the lesson stopped there, and this script
// kept asking only about the repo it happens to run in. A phase living entirely
// in a sibling repo then reports 0 merged with every ticket "no PR matched",
// which reads as a stalled phase rather than an unasked question. Worse, an
// unguarded merge over there cannot be detected at all: the PR is never fetched,
// so its MERGED state never contradicts the missing journal event.
// `reviewDecision` is deliberately ABSENT from the bulk window and fetched by a
// separate open-only pass. It is the one field that dominates the call: on a
// 12k-PR monorepo the same 3000-row request takes 17s without it and 116s WITH
// it — ending in `HTTP 502` from the GraphQL API, i.e. the whole repo silently
// drops out of the numbers. state-sync already carries this rule; it simply
// never reached here. Only OPEN PRs are ever asked about it (the `approved`
// column), and that window is small.
const PR_FIELDS = 'number,state,isDraft,headRefName,baseRefName,mergedAt,createdAt,url,title';
const OPEN_FIELDS = 'number,reviewDecision';
const repoOf = (t) => (t && t.repo) || null;
const REPO_IDS = [...new Set(Object.values(tickets).map(repoOf))];
if (!REPO_IDS.includes(null)) REPO_IDS.unshift(null); // the project's own repo is always in play

const prsByRepo = new Map();
let prsTruncated = false;
const unreachableRepos = [];
for (const repo of REPO_IDS) {
  const args = ['pr', 'list', '--state', 'all', '--limit', String(cfg.pr_fetch_limit), '--json', PR_FIELDS];
  if (repo) args.push('--repo', repo);
  let rows;
  try {
    rows = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    // A sibling repo we cannot reach is a gap in the numbers, not a reason to
    // print nothing: the rest of the graph is still worth reporting on.
    unreachableRepos.push(repo);
    rows = [];
  }
  if (rows.length >= cfg.pr_fetch_limit) prsTruncated = true;

  // Second, cheap pass: review decisions for the OPEN PRs only.
  try {
    const openArgs = ['pr', 'list', '--state', 'open', '--limit', String(cfg.pr_fetch_limit), '--json', OPEN_FIELDS];
    if (repo) openArgs.push('--repo', repo);
    const decisions = new Map(
      JSON.parse(execFileSync('gh', openArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
        .map((p) => [p.number, p.reviewDecision])
    );
    for (const p of rows) if (decisions.has(p.number)) p.reviewDecision = decisions.get(p.number);
  } catch {
    // No review decisions for this repo — the `approved` column goes blank there
    // rather than the whole repo dropping out, which is the trade this split buys.
  }

  prsByRepo.set(repo, rows);
}
const prsFor = (t) => prsByRepo.get(repoOf(t)) || [];

const now = Date.now();
const hours = (a, b) => Math.round(((b - a) / 3_600_000) * 10) / 10;

const rows = [];
for (const [id, t] of Object.entries(tickets)) {
  const events = journal.filter((e) => e.ticket === id);
  const attempts = events.filter((e) => e.event === 'attempt');
  const fixRounds = events.filter((e) => e.event === 'fix_round');
  const outcome = (o) => fixRounds.filter((e) => e.outcome === o).length;
  const escalations =
    events.filter((e) => e.event === 'escalation').length +
    fixRounds.filter((e) => e.outcome === 'escalate').length;

  const match = matchTicketPr(id, t, prsFor(t));
  const pr = match ? match.pr : null;
  // The guard's own merge record for this ticket, if it made one.
  const guardMerge = events.find((e) => e.event === 'merge' && e.by === 'sentinel') || null;
  const checkpointMerged = !!(pr && pr.state === 'MERGED' && t.human_checkpoint
    && withinWindow(pr.mergedAt));
  const row = {
    ticket: id,
    phase: t.phase,
    risk: t.risk,
    status: !pr ? 'pending' : pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'pr-open' : 'pending',
    pr: pr ? pr.number : null,
    hours_open_to_merge: pr && pr.mergedAt ? hours(Date.parse(pr.createdAt), Date.parse(pr.mergedAt)) : null,
    hours_open: pr && pr.state === 'OPEN' ? hours(Date.parse(pr.createdAt), now) : null,
    // The open-only review-decision pass is best-effort. Missing data means the
    // API query failed (or did not return this PR), not that GitHub answered
    // CHANGES_REQUESTED; preserve that distinction for the report consumer.
    approved: pr && pr.state === 'OPEN'
      ? (typeof pr.reviewDecision === 'string' ? pr.reviewDecision === 'APPROVED' : null)
      : null,
    attempts: attempts.length ? Math.max(...attempts.map((e) => Number(e.n) || 0), attempts.length) : 0,
    fix_fixed: outcome('fixed'),
    fix_noop: outcome('no-op'),
    escalations,
    // A ticket PR that reached MERGED with no `merge` event never went through
    // `sentinel.cjs merge`, i.e. the gate did not run for it: nobody re-verified
    // green checks, zero unresolved threads, the arch-review conform trailer, or
    // that the base was inside the stack. The journal alone cannot show this — a
    // raw `gh pr merge` writes nothing, so a bypass is indistinguishable from an
    // idle ticket. Only GitHub's own MERGED state, which we already fetched,
    // makes the silence legible.
    // Windowed like the other warnings: a merge a person made last week is a
    // fact, not a thing to act on, and repeating it every run buries the one
    // that happened this morning.
    // EXCEPT on a human_checkpoint ticket, where a merge outside this predicate
    // is the contract and not an anomaly. Measured before the exclusion: 10 of
    // 23 tickets flagged, and all 10 were exactly the 10 checkpoints — a warning
    // that fires only on correct behaviour, which is how a user learns to ignore
    // warnings. Checkpoints are attributed by the three predicates below instead.
    unguarded_merge: !!(pr && pr.state === 'MERGED' && !events.some((e) => e.event === 'merge')
      && !t.human_checkpoint
      && withinWindow(pr.mergedAt)),
    // WHO merged a checkpoint, read off the `by`/`preauthorized` fields the
    // guard's own `merge` event already carries. This was ONE neutral count, on
    // the reasoning that `sentinel.cjs merge` refuses checkpoints outright ("the
    // merge is the human's by contract"), so a guarded one is impossible by
    // construction — true when it was written, and retired by a mechanism three
    // files away: `delivery.preauthorized` shipped, `needsHuman()` returns false
    // for a pre-authorized ticket, and the guard merges it after re-verifying
    // every other gate. Measured on phase 27: three of the eight PRs the report
    // called "merged by a person" were `{"by":"sentinel","preauthorized":true}`
    // in the same journal this script reads.
    //
    // The discriminator is `by: 'sentinel'`, never the mere presence of a `merge`
    // event: journals in the wild carry records a run wrote by hand (see the
    // dedupe below), and such a record proves a merge happened, not who made it.
    //
    // Two legitimate cases, counted SEPARATELY because the pre-authorized one is
    // the only measurement of what asking that question at plan time actually
    // saved — the sole evidence that asking it was worth the operator's
    // attention. The third is neither: a guard merge with NO pre-authorization
    // recorded means the guard merged a checkpoint nobody authorized, so it is a
    // WARNING. Folded into the neutral line, it was invisible.
    checkpoint_human_merge: checkpointMerged && !guardMerge,
    checkpoint_preauthorized_merge: checkpointMerged && !!guardMerge && guardMerge.preauthorized === true,
    checkpoint_unauthorized_merge: checkpointMerged && !!guardMerge && guardMerge.preauthorized !== true,
  };
  rows.push(row);
}

// per-phase aggregates
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};
const phases = {};
for (const r of rows) {
  const p = (phases[r.phase] ??= {
    tickets: 0, merged: 0, pr_open: 0,
    merge_hours: [], attempts: 0, fix_fixed: 0, fix_noop: 0, escalations: 0,
  });
  p.tickets++;
  if (r.status === 'merged') p.merged++;
  if (r.status === 'pr-open') p.pr_open++;
  if (r.hours_open_to_merge != null) p.merge_hours.push(r.hours_open_to_merge);
  p.attempts += r.attempts;
  p.fix_fixed += r.fix_fixed;
  p.fix_noop += r.fix_noop;
  p.escalations += r.escalations;
}
const phaseRows = Object.entries(phases).map(([phase, p]) => ({
  phase,
  tickets: p.tickets,
  merged: p.merged,
  pr_open: p.pr_open,
  median_hours_to_merge: median(p.merge_hours),
  attempts: p.attempts,
  fix_fixed: p.fix_fixed,
  fix_noop: p.fix_noop,
  escalations: p.escalations,
}));

// Reuse-scan yield. `hits` counts existing implementations drift-check told an
// executor to build on; a long run of scans with zero hits is the signal to look
// at the tier drift-check runs on, not proof the codebase has no duplication.
const reuseScans = journal.filter((e) => e.event === 'reuse_scan');
const reuseHits = reuseScans.reduce((n, e) => n + (Number(e.hits) || 0), 0);

// Merges that skipped the guard, and attempts logged under a role the model
// ladder does not know. Both are silent failures of the same kind: the conveyor
// keeps working, the numbers still look like progress, and the thing that was
// supposed to be enforced simply did not run.
const unguarded = rows.filter((r) => r.unguarded_merge);
// One merge is one PR landing, however many times it was written down. Journals
// in the wild carry duplicates — the guard writes its own record and a run wrote
// another by hand seconds later — and counting both overstated "sentinel landed
// N" while the hand-written copy, having no `base`, printed an empty entry in
// the epic list. log-event now refuses those, but the journals that already have
// them still have to read correctly.
const guardedMerges = [...new Map(
  journal.filter((e) => e.event === 'merge')
    .map((e) => [`${e.repo || ''}#${e.pr ?? e.ticket}`, e])
    // Keep the record that knows the most: the guard's carries `by` and `base`.
    .sort(([, a], [, b]) => (a.by === 'sentinel' ? 1 : 0) - (b.by === 'sentinel' ? 1 : 0))
).values()];
const unknownRoles = [...new Set(
  journal
    .filter((e) => e.event === 'attempt' && e.role && !ROLES.includes(e.role) && withinWindow(e.ts))
    .map((e) => e.role)
)];

// Model-ladder coverage is kept separate from ticket outcomes because a
// dispatch can be recorded before its ticket changes state. The windowed view
// makes this report useful for the current rollout while the ticket rows remain
// lifetime facts. Missing fields are intentional findings: an old or inline
// path that omits the resolver result cannot be used to tune the ladder.
const ladderEvents = journal.filter((e) => e.event === 'dispatch' && withinWindow(e.ts));
const countField = (field) => {
  const counts = new Map();
  for (const event of ladderEvents) {
    const value = event[field];
    if (value === undefined || value === null || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
  );
};
// Coverage is three separate claims, not one boolean. A dispatch can carry the
// resolver's requested policy while the spawn did not expose applied effort,
// and it can carry both while the runtime still hid the concrete model. Folding
// these into one "has telemetry" count would make an incomplete treatment look
// comparable. The required fields mirror `dispatch-record.cjs`; a static Codex
// role also needs the generated file because that file is where its concrete
// model lives. The dynamic executor is resolved at launch and has no file.
const present = (event, field) =>
  event[field] !== undefined && event[field] !== null && event[field] !== '';
const concreteEffort = (value) => Array.isArray(EFFORTS) && EFFORTS.includes(value);
const staticCodexNeedsFile = (event) =>
  event.runtime === 'codex' && event.role !== 'executor' && !present(event, 'agent_file');
// A parseable route is not enough: the structured columns are the values that
// downstream comparisons actually group by. If they disagree with the route
// sentence, treating the row as comparable would silently compare one policy
// against another. The dispatch recorder writes these fields from the route,
// so equality is the integrity check for older or hand-written journal rows.
const routeValid = (event) => {
  if (!present(event, 'reason')) return false;
  const route = parseRoute(event.reason);
  return Boolean(route)
    && route.tier.model === event.model
    && route.effort.effort === event.effort;
};
const requestedMissing = (event) => [
  'model', 'effort', 'reason', 'task_level', 'runtime', 'backend', 'role',
].filter((field) => !present(event, field));
const requestedComparable = (event) =>
  requestedMissing(event).length === 0 && routeValid(event) && !staticCodexNeedsFile(event);
const appliedComparable = (event) =>
  requestedComparable(event) && concreteEffort(event.effort_applied);
const observedComparable = (event) =>
  requestedComparable(event) && present(event, 'observed_model') && concreteEffort(event.observed_effort);
const usageJoinComparable = (event) =>
  observedComparable(event) && present(event, 'dispatch_id');
const attributionStatus = (event) => {
  if (observedComparable(event)) return 'observed_complete';
  if (appliedComparable(event)) return 'applied_complete';
  if (requestedComparable(event)) return 'requested_complete';
  return 'incomplete';
};
const missingAttribution = Object.fromEntries([
  'model', 'effort', 'reason', 'task_level', 'runtime', 'backend', 'role', 'agent_file',
  'effort_applied', 'observed_model', 'observed_effort', 'dispatch_id',
].map((field) => [field, ladderEvents.filter((e) => {
  if (field === 'agent_file') return staticCodexNeedsFile(e);
  if (field === 'effort_applied' || field === 'observed_effort') return !concreteEffort(e[field]);
  return !present(e, field);
}).length]));
const ladder = {
  mode: cfg.model_ladder,
  policy_valid: loadedConfig.valid,
  ...(loadedConfig.valid ? {} : { policy_error: loadedConfig.error }),
  window: windowLabel,
  dispatches: ladderEvents.length,
  missing_model: ladderEvents.filter((e) => !e.model).length,
  missing_effort: ladderEvents.filter((e) => !e.effort).length,
  missing_effort_applied: ladderEvents.filter((e) => !concreteEffort(e.effort_applied)).length,
  missing_route: ladderEvents.filter((e) => !routeValid(e)).length,
  missing_task_level: ladderEvents.filter((e) => !e.task_level).length,
  missing_runtime: ladderEvents.filter((e) => !e.runtime).length,
  missing_backend: ladderEvents.filter((e) => !e.backend).length,
  missing_observed_model: ladderEvents.filter((e) => !e.observed_model).length,
  missing_observed_effort: ladderEvents.filter((e) => !concreteEffort(e.observed_effort)).length,
  missing_dispatch_id: ladderEvents.filter((e) => !e.dispatch_id).length,
  missing_agent_file: ladderEvents.filter((e) => e.runtime === 'codex' && e.role !== 'executor' && !e.agent_file).length,
  requested_comparable: ladderEvents.filter(requestedComparable).length,
  applied_comparable: ladderEvents.filter(appliedComparable).length,
  observed_comparable: ladderEvents.filter(observedComparable).length,
  usage_join_comparable: ladderEvents.filter(usageJoinComparable).length,
  missing_attribution: missingAttribution,
  by_role: countField('role'),
  by_task_level: countField('task_level'),
  by_model: countField('model'),
  by_effort: countField('effort'),
  by_effort_applied: countField('effort_applied'),
  by_runtime: countField('runtime'),
  by_backend: countField('backend'),
  by_agent_file: countField('agent_file'),
  by_observed_model: countField('observed_model'),
  by_observed_effort: countField('observed_effort'),
  by_dispatch_id: countField('dispatch_id'),
};
// Keep the status grouping derived from the same predicates above. It is added
// after the generic field counters so the journal rows themselves are never
// mutated and the existing `by_*` vocabulary remains stable.
ladder.by_attribution_status = Object.fromEntries(
  [...new Set(ladderEvents.map(attributionStatus))]
    .sort()
    .map((value) => [value, ladderEvents.filter((e) => attributionStatus(e) === value).length])
);

// Tickets the board keeps offering that no run ever takes. A run scopes itself
// to the phase it is working, so a ticket from an older phase can sit under
// `execute` indefinitely: never selected, therefore never drift-gated, therefore
// never parked — and `fixpoint: NO` forever, over work nobody intends to do.
// Two such tickets were still being offered six days after being judged stale,
// because the judging only happens to tickets a run has already chosen.
// "Left behind" is not "not started". A pending ticket in the phase currently
// being worked is simply next in line; a pending ticket in a phase the run has
// already moved PAST is one the board will keep offering and no run will take.
// An escalation makes that more true, not less — the first version of this check
// excluded escalated tickets and so missed the only two real cases on hand.
const phaseNum = (p) => Number.parseInt(String(p), 10);
const newestLandedPhase = rows
  .filter((r) => r.status === 'merged')
  .reduce((max, r) => Math.max(max, phaseNum(r.phase) || 0), 0);
const stranded = rows.filter((r) =>
  r.status === 'pending' && !r.pr && !r.attempts && (phaseNum(r.phase) || 0) < newestLandedPhase);

if (asJson) {
  console.log(JSON.stringify({
    tickets: rows,
    phases: phaseRows,
    sentinel_merges: guardedMerges.length,
    unguarded_merges: unguarded.map((r) => ({ ticket: r.ticket, pr: r.pr })),
    unknown_roles: unknownRoles,
    reuse_scans: reuseScans.length,
    reuse_hits: reuseHits,
    journal_events: journal.length,
    prs_truncated: prsTruncated,
    // A zero-row result is not the same as a reachable repository with no
    // matching PRs. Keep the outage visible to JSON consumers too; otherwise
    // automation can treat incomplete GitHub data as a clean pending board.
    unreachable_repos: unreachableRepos,
    ladder,
  }, null, 2));
  process.exit(0);
}
if (prsTruncated) {
  console.log(`⚠ the PR listing hit its limit (${cfg.pr_fetch_limit}) — some tickets may show as pending; raise pipeline.pr_fetch_limit`);
}
if (unreachableRepos.length) {
  const unreachableLabels = unreachableRepos.map((repo) => repo || 'the project repository');
  console.log(`⚠ could not list PRs for ${unreachableLabels.join(', ')} — every ticket in ${unreachableRepos.length > 1 ? 'those repos' : 'that repo'} reads as pending here regardless of what actually shipped`);
}
if (ladder.dispatches) {
  console.log(
    `ladder [${windowLabel}]: ${ladder.mode}, ${ladder.dispatches} dispatches; ` +
    `${ladder.dispatches - ladder.missing_model}/${ladder.dispatches} with model, ` +
    `${ladder.dispatches - ladder.missing_task_level}/${ladder.dispatches} with task level, ` +
    `${ladder.dispatches - ladder.missing_effort_applied}/${ladder.dispatches} with applied effort, ` +
    `${ladder.dispatches - ladder.missing_observed_model}/${ladder.dispatches} with observed model; ` +
    `${ladder.requested_comparable}/${ladder.dispatches} routing-comparable, ` +
    `${ladder.applied_comparable}/${ladder.dispatches} applied-comparable, ` +
    `${ladder.observed_comparable}/${ladder.dispatches} observed-comparable, ` +
    `${ladder.usage_join_comparable}/${ladder.dispatches} usage-join-comparable`
  );
  const gaps = [];
  if (ladder.missing_model) gaps.push(`${ladder.missing_model} missing model`);
  if (ladder.missing_effort) gaps.push(`${ladder.missing_effort} missing requested effort`);
  if (ladder.missing_effort_applied) gaps.push(`${ladder.missing_effort_applied} missing applied effort`);
  if (ladder.missing_route) gaps.push(`${ladder.missing_route} missing route`);
  if (ladder.missing_task_level) gaps.push(`${ladder.missing_task_level} missing task level`);
  if (ladder.missing_runtime) gaps.push(`${ladder.missing_runtime} missing runtime`);
  if (ladder.missing_backend) gaps.push(`${ladder.missing_backend} missing backend`);
  if (ladder.missing_agent_file) gaps.push(`${ladder.missing_agent_file} Codex dispatches missing agent file`);
  if (ladder.missing_observed_model) gaps.push(`${ladder.missing_observed_model} missing observed model`);
  if (ladder.missing_observed_effort) gaps.push(`${ladder.missing_observed_effort} missing observed effort`);
  if (ladder.missing_dispatch_id) gaps.push(`${ladder.missing_dispatch_id} missing dispatch correlation id`);
  if (gaps.length) {
    console.log(`⚠ [${windowLabel}] ladder telemetry gaps: ${gaps.join(', ')} — those dispatches cannot be compared for cost or quality`);
  }
}

const pad = (v, w) => String(v ?? '—').padEnd(w);
console.log(pad('TICKET', 10) + pad('RISK', 8) + pad('STATUS', 9) + pad('PR', 6) +
            pad('→MERGE', 8) + pad('OPEN', 6) + pad('ATT', 5) + pad('FIX', 5) + pad('NOOP', 6) + 'ESC');
for (const r of rows) {
  console.log(
    pad(r.ticket, 10) + pad(r.risk, 8) + pad(r.status, 9) + pad(r.pr, 6) +
    pad(r.hours_open_to_merge != null ? `${r.hours_open_to_merge}h` : null, 8) +
    pad(r.hours_open != null ? `${r.hours_open}h` : null, 6) +
    pad(r.attempts || null, 5) + pad(r.fix_fixed || null, 5) + pad(r.fix_noop || null, 6) +
    (r.escalations || '—')
  );
}
console.log('');
for (const p of phaseRows) {
  console.log(
    `phase ${p.phase}: ${p.merged}/${p.tickets} merged, ${p.pr_open} open` +
    (p.median_hours_to_merge != null ? `, median ${p.median_hours_to_merge}h to merge` : '') +
    (p.attempts ? `, ${p.attempts} babysit attempts` : '') +
    (p.fix_noop ? `, ${p.fix_noop} no-op fix rounds` : '') +
    (p.escalations ? `, ${p.escalations} escalations` : '')
  );
}
// Who actually landed the work. A phase where the sentinel merged nothing while
// PRs sat green is the signature of auto_merge being off (or of a gate the guard
// could never satisfy) — worth seeing next to the merge times.
if (guardedMerges.length) {
  // A cascade child lands on its PARENT's branch, not on an epic, so this list
  // legitimately mixes both. Empty entries are dropped rather than printed as a
  // gap: they only ever came from a record that did not know its own base.
  const bases = [...new Set(guardedMerges.map((e) => e.base).filter(Boolean))];
  console.log(`sentinel landed ${guardedMerges.length} ticket PR(s) into the stack (${bases.join(', ')})`);
}
// Say this even when it is the only merge line: a guarded count printed alone
// reads as "this is how the work landed", and the tickets below landed some
// other way entirely.
if (unguarded.length) {
  // WHO merged it decides whether this line is alarming or routine, and the
  // report could not tell them apart: an operator merging deliberately looked
  // exactly like a run skipping its own gate. `mergedBy` answers it, but it is a
  // `reviewDecision`-class field — 3s→10s per 500 rows — so it is never asked in
  // the bulk window, only for the handful already flagged.
  const CAP = 20;
  const asked = unguarded.slice(0, CAP);
  const who = new Map();
  for (const r of asked) {
    const t = tickets[r.ticket] || {};
    const args = ['pr', 'view', String(r.pr), '--json', 'mergedBy', '--jq', '.mergedBy.login'];
    if (t.repo) args.push('--repo', t.repo);
    try {
      const login = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (login) who.set(r.ticket, login);
    } catch { /* unknown is a fair answer; the line still names the PR */ }
  }
  const label = (r) => `${r.ticket}#${r.pr}${who.has(r.ticket) ? ` (${who.get(r.ticket)})` : ''}`;
  console.log(
    `⚠ [${windowLabel}] ${unguarded.length} ticket PR(s) are MERGED with no guarded merge — the gate in \`sentinel.cjs merge\` ` +
    `did not run for them (green checks, zero unresolved threads, the arch-review conform trailer, base inside ` +
    `the stack): ${asked.map(label).join(', ')}` +
    (unguarded.length > CAP ? `, +${unguarded.length - CAP} more (not attributed)` : '')
  );
  console.log(
    '  A name in brackets is who merged it: a person merging deliberately is not the same finding as a run ' +
    'going around its own guard, and this line used to report both identically.'
  );
}
// Stated, not warned — twice, because a checkpoint can legitimately be landed by
// either actor and one line cannot say both. Neither line may name a ticket the
// other one landed: the single line this replaced credited the guard's three
// pre-authorized merges to a person, and read as a correct sentence while doing
// it.
const label8 = (list) =>
  list.slice(0, 8).map((r) => `${r.ticket}#${r.pr}`).join(', ') +
  (list.length > 8 ? `, +${list.length - 8} more` : '');

const humanMerges = rows.filter((r) => r.checkpoint_human_merge);
if (humanMerges.length) {
  console.log(
    `[${windowLabel}] ${humanMerges.length} human_checkpoint ticket PR(s) were merged by a person, as the ` +
    `contract requires (no merge of the guard's is recorded for them): ${label8(humanMerges)}`
  );
}
// Worth its own line rather than a footnote: this is the measurement of how much
// waiting the pre-authorization question saved, and the only evidence that
// asking it was worth the operator's attention.
const preauthorizedMerges = rows.filter((r) => r.checkpoint_preauthorized_merge);
if (preauthorizedMerges.length) {
  console.log(
    `[${windowLabel}] ${preauthorizedMerges.length} human_checkpoint ticket PR(s) were merged by the guard under ` +
    `pre-authorization — a plan-time approval that saved that many waits: ${label8(preauthorizedMerges)}`
  );
}
const unauthorizedCheckpointMerges = rows.filter((r) => r.checkpoint_unauthorized_merge);
if (unauthorizedCheckpointMerges.length) {
  console.log(
    `⚠ [${windowLabel}] ${unauthorizedCheckpointMerges.length} human_checkpoint ticket PR(s) were merged by the ` +
    `guard with NO pre-authorization recorded: ${label8(unauthorizedCheckpointMerges)}. ` +
    'Either `sentinel.cjs merge` landed a checkpoint nobody authorized, or an approval was made and never ' +
    'written into the plan\'s `delivery.preauthorized` — the journal cannot tell those apart, and both want ' +
    'a person.'
  );
}
if (stranded.length) {
  console.log(
    `⚠ ${stranded.length} ticket(s) in phases that have otherwise landed were never attempted: ` +
    `${stranded.map((r) => r.ticket).join(', ')}. The board offers them every run and no run takes them, ` +
    `so they are never drift-gated and never parked — take them, or record why not ` +
    `(\`drift-record.cjs mark\` when the plan predates what shipped).`
  );
}
if (unknownRoles.length) {
  console.log(
    `⚠ [${windowLabel}] attempts logged under ${unknownRoles.length} role(s) the model ladder does not know: ${unknownRoles.join(', ')}. ` +
    `Those dispatches resolved no model from role × risk × attempt — someone picked one by hand. Known roles: ${ROLES.join(', ')}.`
  );
}
if (reuseScans.length) {
  const withHits = reuseScans.filter((e) => (Number(e.hits) || 0) > 0).length;
  console.log(
    `reuse scan: ${reuseHits} existing implementation(s) surfaced across ${reuseScans.length} drift-checked ticket(s) ` +
    `(${withHits} ticket(s) had at least one)` +
    (reuseHits === 0 ? ' — zero hits over a long run points at the drift-check tier, not at a duplicate-free codebase' : '')
  );
}
if (!journal.length) {
  console.log('note: delivery-log.jsonl is empty — attempts/fix-round columns fill up as /shipyard:deliver logs events');
}
