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
// ci-fix/review-fix prompts effective?), no-op share (wasted rounds), and
// time-to-merge (conveyor throughput incl. the human merge tail).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));

const GRAPH_DIR = path.join(process.cwd(), '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
const asJson = process.argv.includes('--json');

function fail(msg) {
  console.error(`pipeline-stats: ${msg}`);
  process.exit(1);
}

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`gh ${args.join(' ')} failed: ${e.stderr ? String(e.stderr).trim() : e.message}`);
  }
}

if (!fs.existsSync(TICKETS)) fail('missing .planning/graph/tickets.json — run validate-graph first');
const { tickets } = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));

const journal = fs.existsSync(JOURNAL)
  ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
  : [];

const { config: cfg } = loadConfig(process.cwd());
const prs = JSON.parse(
  gh(['pr', 'list', '--state', 'all', '--limit', String(cfg.pr_fetch_limit),
      '--json', 'number,state,isDraft,headRefName,baseRefName,mergedAt,createdAt,url,reviewDecision,title'])
);
// stats are advisory, but a truncated window silently understates delivery —
// say so rather than printing confident numbers over partial data.
const prsTruncated = prs.length >= cfg.pr_fetch_limit;

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

  const match = matchTicketPr(id, t, prs);
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

if (asJson) {
  console.log(JSON.stringify({
    tickets: rows,
    phases: phaseRows,
    sentinel_merges: journal.filter((e) => e.event === 'merge').length,
    journal_events: journal.length,
    prs_truncated: prsTruncated,
  }, null, 2));
  process.exit(0);
}
if (prsTruncated) {
  console.log(`⚠ the PR listing hit its limit (${cfg.pr_fetch_limit}) — some tickets may show as pending; raise pipeline.pr_fetch_limit`);
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
const landed = journal.filter((e) => e.event === 'merge');
if (landed.length) {
  console.log(`sentinel landed ${landed.length} ticket PR(s) into the stack (${[...new Set(landed.map((e) => e.base))].join(', ')})`);
}
if (!journal.length) {
  console.log('note: delivery-log.jsonl is empty — attempts/fix-round columns fill up as /shipyard:deliver logs events');
}
