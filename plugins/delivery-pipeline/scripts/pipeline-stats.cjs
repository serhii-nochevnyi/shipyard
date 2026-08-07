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
const { loadConfig, ROLES } = require(path.join(__dirname, 'pipeline-config.cjs'));

const GRAPH_DIR = path.join(process.cwd(), '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
const asJson = process.argv.includes('--json');

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

const { config: cfg } = loadConfig(process.cwd());

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
  const row = {
    ticket: id,
    phase: t.phase,
    risk: t.risk,
    status: !pr ? 'pending' : pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'pr-open' : 'pending',
    pr: pr ? pr.number : null,
    hours_open_to_merge: pr && pr.mergedAt ? hours(Date.parse(pr.createdAt), Date.parse(pr.mergedAt)) : null,
    hours_open: pr && pr.state === 'OPEN' ? hours(Date.parse(pr.createdAt), now) : null,
    approved: pr && pr.state === 'OPEN' ? pr.reviewDecision === 'APPROVED' : null,
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
    unguarded_merge: !!(pr && pr.state === 'MERGED' && !events.some((e) => e.event === 'merge')),
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
const guardedMerges = journal.filter((e) => e.event === 'merge');
const unknownRoles = [...new Set(
  journal.filter((e) => e.event === 'attempt' && e.role && !ROLES.includes(e.role)).map((e) => e.role)
)];

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
  }, null, 2));
  process.exit(0);
}
if (prsTruncated) {
  console.log(`⚠ the PR listing hit its limit (${cfg.pr_fetch_limit}) — some tickets may show as pending; raise pipeline.pr_fetch_limit`);
}
if (unreachableRepos.length) {
  console.log(`⚠ could not list PRs for ${unreachableRepos.join(', ')} — every ticket in ${unreachableRepos.length > 1 ? 'those repos' : 'that repo'} reads as pending here regardless of what actually shipped`);
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
  console.log(`sentinel landed ${guardedMerges.length} ticket PR(s) into the stack (${[...new Set(guardedMerges.map((e) => e.base))].join(', ')})`);
}
// Say this even when it is the only merge line: a guarded count printed alone
// reads as "this is how the work landed", and the tickets below landed some
// other way entirely.
if (unguarded.length) {
  console.log(
    `⚠ ${unguarded.length} ticket PR(s) are MERGED with no guarded merge — the gate in \`sentinel.cjs merge\` ` +
    `did not run for them (green checks, zero unresolved threads, the arch-review conform trailer, base inside ` +
    `the stack): ${unguarded.slice(0, 12).map((r) => `${r.ticket}#${r.pr}`).join(', ')}` +
    (unguarded.length > 12 ? `, +${unguarded.length - 12} more` : '')
  );
}
if (unknownRoles.length) {
  console.log(
    `⚠ attempts logged under ${unknownRoles.length} role(s) the model ladder does not know: ${unknownRoles.join(', ')}. ` +
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
