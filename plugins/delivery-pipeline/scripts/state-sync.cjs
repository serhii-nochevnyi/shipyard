#!/usr/bin/env node
'use strict';

// Cold-start resync: rebuild .planning/graph/delivery-state.json|yaml from the
// ACTUAL GitHub state (gh CLI). The local state file is a cache; GitHub is the
// source of truth. Idempotent — safe to run at every /shipyard:deliver start.
//
// Ticket status model:
//   merged   — a PR for the ticket branch is merged
//   pr-open  — PR exists and is open (checks/review detail attached)
//   pending  — no PR and no branch on the remote yet
//   branched — branch exists on remote but no PR yet
//
// Ticket↔PR matching is branch-first with a ticket-ID-marker fallback
// (ticket-pr-match.cjs): a re-decompose that renames the canonical branch slug
// must not orphan an already-merged PR.
//
// Each entry carries `since` — when the ticket entered its current status
// (carried over from the previous state file while the status is unchanged).
// Status transitions are appended to .planning/graph/delivery-log.jsonl, the
// conveyor's append-only telemetry journal (input for pipeline-stats.cjs).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');

// board staleness thresholds (hours in current status)
const STALE_MERGE_H = 4;   // approved + green, still not merged
const STALE_DRAFT_H = 24;  // still a draft PR

function fail(msg) {
  console.error(`state-sync: ${msg}`);
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

let prev = {};
if (fs.existsSync(STATE)) {
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { prev = {}; }
}
const nowIso = new Date().toISOString();

// one call: every PR whose head branch starts with ticket/
const prs = JSON.parse(
  gh(['pr', 'list', '--state', 'all', '--limit', '200',
      '--json', 'number,state,isDraft,headRefName,mergedAt,createdAt,url,reviewDecision,title'])
);

const remoteBranches = new Set(
  gh(['api', 'repos/{owner}/{repo}/branches', '--paginate', '--jq', '.[].name'])
    .split('\n').filter(Boolean)
);

const state = {};
for (const [id, t] of Object.entries(tickets)) {
  const match = matchTicketPr(id, t, prs);
  const pr = match ? match.pr : null;
  const entry = { branch: t.branch, pr: pr ? pr.number : null, status: 'pending' };
  if (match && match.matchedBy === 'marker') {
    // canonical branch in tickets.json diverged from the PR's actual head
    entry.matched_by = 'marker';
    entry.pr_branch = pr.headRefName;
  }
  if (pr) {
    if (pr.state === 'MERGED') {
      entry.status = 'merged';
    } else if (pr.state === 'OPEN') {
      entry.status = 'pr-open';
      entry.draft = pr.isDraft;
      entry.review_decision = pr.reviewDecision || null;
      entry.url = pr.url;
      const checks = JSON.parse(
        gh(['pr', 'checks', String(pr.number), '--json', 'name,state'])
      );
      entry.checks = {
        total: checks.length,
        failing: checks.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).length,
        pending: checks.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(c.state)).length,
      };
    } else {
      entry.status = 'pending'; // closed unmerged PR -> ticket back to pending
      entry.note = `PR #${pr.number} closed without merge`;
    }
  } else if (remoteBranches.has(t.branch)) {
    entry.status = 'branched';
  }
  state[id] = entry;
}

// derived readiness: every dependency merged
for (const [id, t] of Object.entries(tickets)) {
  if (state[id].status === 'pending') {
    const blockers = t.depends_on.filter((d) => state[d] && state[d].status !== 'merged');
    state[id].ready = blockers.length === 0;
    if (blockers.length) state[id].blocked_by = blockers;
  }
}

// `since` carry-over + journal every REAL status transition (a pre-`since`
// state file makes the status look unchanged — carry the status, reset the
// clock, but do not journal a no-op X→X event)
const transitions = [];
for (const [id, entry] of Object.entries(state)) {
  const before = prev[id];
  const unchanged = before && before.status === entry.status;
  entry.since = unchanged && before.since ? before.since : nowIso;
  if (!unchanged) {
    transitions.push({
      ts: nowIso,
      event: 'status_change',
      ticket: id,
      from: before ? before.status : null,
      to: entry.status,
      pr: entry.pr,
    });
  }
}

fs.mkdirSync(GRAPH_DIR, { recursive: true });
if (transitions.length) {
  fs.appendFileSync(JOURNAL, transitions.map((t) => JSON.stringify(t)).join('\n') + '\n');
}
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

const yaml = ['# generated by state-sync.cjs from live GitHub state — do not edit'];
for (const [id, s] of Object.entries(state)) {
  yaml.push(`${id}:`);
  for (const [k, v] of Object.entries(s)) {
    yaml.push(`  ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`);
  }
}
fs.writeFileSync(path.join(GRAPH_DIR, 'delivery-state.yaml'), yaml.join('\n') + '\n');

// board summary on stdout for the /shipyard:deliver skill
function ageH(sinceIso) {
  return (Date.parse(nowIso) - Date.parse(sinceIso)) / 3_600_000;
}
function ageLabel(sinceIso) {
  const h = ageH(sinceIso);
  return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
}

const buckets = {};
for (const [id, s] of Object.entries(state)) {
  const b = s.status === 'pending' ? (s.ready ? 'ready' : 'blocked') : s.status;
  (buckets[b] ??= []).push(id);
}
for (const b of ['ready', 'blocked', 'branched', 'pr-open', 'merged']) {
  if (buckets[b]) console.log(`${b}: ${buckets[b].join(', ')}`);
}

// stale warnings: the conveyor's tail (merge/review by humans) is where time
// silently disappears — surface it on every cold start
for (const [id, s] of Object.entries(state)) {
  if (s.status !== 'pr-open') continue;
  const green = s.checks && s.checks.failing === 0 && s.checks.pending === 0;
  if (!s.draft && s.review_decision === 'APPROVED' && green && ageH(s.since) >= STALE_MERGE_H) {
    console.log(`⚠ stale: ${id} PR #${s.pr} approved+green — awaiting merge for ${ageLabel(s.since)}`);
  } else if (s.draft && ageH(s.since) >= STALE_DRAFT_H) {
    console.log(`⚠ stale: ${id} PR #${s.pr} still a draft for ${ageLabel(s.since)}`);
  }
  if (s.matched_by === 'marker') {
    console.log(`⚠ branch drift: ${id} matched by title marker (PR head ${s.pr_branch} ≠ canonical ${s.branch})`);
  }
}
for (const [id, s] of Object.entries(state)) {
  if (s.status === 'merged' && s.matched_by === 'marker') {
    console.log(`⚠ branch drift: ${id} merged as PR #${s.pr} (head ${s.pr_branch} ≠ canonical ${s.branch})`);
  }
}
console.log('wrote .planning/graph/delivery-state.json and delivery-state.yaml');
