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
// Integration modes (`.planning/config.json` → pipeline.integration_mode):
//   epic-stacked (default) — one epic branch per phase; root tickets PR into
//     the epic, dependent tickets cascade (PR into the primary parent branch)
//     WITHOUT waiting for a merge. A dependent ticket is ready once its parents
//     are at least `branched`. Each entry's `base` is the branch its PR targets.
//   direct-to-main — legacy: dependents wait for parents to MERGE; base is main
//     (or the deepest unmerged dependency branch under stacking).
//
// Ticket↔PR matching is branch-first with a ticket-ID-marker fallback
// (ticket-pr-match.cjs). `since` records when a ticket entered its status;
// transitions are appended to delivery-log.jsonl (pipeline-stats.cjs input).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
const CONFIG = path.join(ROOT, '.planning', 'config.json');

// board staleness thresholds (hours in current status)
const STALE_MERGE_H = 4;   // approved + green, still not merged
const STALE_DRAFT_H = 24;  // still a draft PR

function fail(msg) {
  console.error(`state-sync: ${msg}`);
  process.exit(1);
}

function gh(args, { tolerate = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (tolerate) return null;
    fail(`gh ${args.join(' ')} failed: ${e.stderr ? String(e.stderr).trim() : e.message}`);
  }
}

if (!fs.existsSync(TICKETS)) fail('missing .planning/graph/tickets.json — run validate-graph first');
const graph = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));
const tickets = graph.tickets || {};
const epics = graph.epics || {};

let mode = 'epic-stacked';
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (cfg.pipeline && cfg.pipeline.integration_mode) mode = cfg.pipeline.integration_mode;
} catch { /* no config -> default */ }

// epic-stacked needs the graph's epic metadata; a pre-epic tickets.json falls
// back to direct-to-main with a one-line notice (re-run decompose to enable it).
const haveEpicMeta = Object.keys(epics).length > 0 &&
  Object.values(tickets).every((t) => typeof t.epic === 'string');
let epicNotice = null;
if (mode === 'epic-stacked' && !haveEpicMeta) {
  mode = 'direct-to-main';
  epicNotice = 'graph has no epic metadata — re-run /shipyard:decompose (validate-graph) to enable epic-stacked; using direct-to-main this run';
}

let prev = {};
if (fs.existsSync(STATE)) {
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { prev = {}; }
}
const nowIso = new Date().toISOString();

function defaultBranch() {
  const d = gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { tolerate: true });
  return (d && d.trim()) || 'main';
}
const DEFAULT_BRANCH = defaultBranch();

// one call: every PR (branch-agnostic) — epic PRs and ticket PRs alike
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
      const checks = JSON.parse(gh(['pr', 'checks', String(pr.number), '--json', 'name,state']));
      entry.checks = {
        total: checks.length,
        failing: checks.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).length,
        pending: checks.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(c.state)).length,
      };
    } else {
      entry.status = 'pending';
      entry.note = `PR #${pr.number} closed without merge`;
    }
  } else if (remoteBranches.has(t.branch)) {
    entry.status = 'branched';
  }
  state[id] = entry;
}

// readiness + the effective PR base each ticket should target
for (const [id, t] of Object.entries(tickets)) {
  const s = state[id];
  const deps = t.depends_on || [];
  if (mode === 'epic-stacked') {
    // cascade: a parent only needs a BRANCH to stack off — no merge wait
    const blockers = deps.filter((d) => state[d] && state[d].status === 'pending');
    // base: root -> epic; dependent -> primary parent branch, or the epic once
    // that parent has merged (GitHub retargets a merged parent's children too)
    const pp = t.primary_parent;
    if (!pp) s.base = t.epic;
    else s.base = state[pp] && state[pp].status === 'merged' ? t.epic : (tickets[pp] ? tickets[pp].branch : t.epic);
    s.epic = t.epic;
    if (s.status === 'pending') {
      s.ready = blockers.length === 0;
      if (blockers.length) s.blocked_by = blockers;
    }
  } else {
    // direct-to-main: dependents wait for parents to merge
    const blockers = deps.filter((d) => state[d] && state[d].status !== 'merged');
    const unmergedDep = deps
      .filter((d) => state[d] && state[d].status !== 'merged' && tickets[d])
      .sort((a, b) => (tickets[b].wave || 0) - (tickets[a].wave || 0))[0];
    s.base = unmergedDep ? tickets[unmergedDep].branch : DEFAULT_BRANCH;
    if (s.status === 'pending') {
      s.ready = blockers.length === 0;
      if (blockers.length) s.blocked_by = blockers;
    }
  }
}

// `since` carry-over + journal every REAL status transition
const transitions = [];
for (const [id, entry] of Object.entries(state)) {
  const before = prev[id];
  const unchanged = before && before.status === entry.status;
  entry.since = unchanged && before.since ? before.since : nowIso;
  if (!unchanged) {
    transitions.push({ ts: nowIso, event: 'status_change', ticket: id, from: before ? before.status : null, to: entry.status, pr: entry.pr });
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

// ── board summary on stdout for the /shipyard:deliver skill ──
function ageH(sinceIso) { return (Date.parse(nowIso) - Date.parse(sinceIso)) / 3_600_000; }
function ageLabel(sinceIso) { const h = ageH(sinceIso); return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }

if (epicNotice) console.log(`note: ${epicNotice}`);
console.log(`integration mode: ${mode}${mode === 'epic-stacked' ? ` (→ ${DEFAULT_BRANCH} via epic)` : ` (→ ${DEFAULT_BRANCH})`}`);

const buckets = {};
for (const [id, s] of Object.entries(state)) {
  const b = s.status === 'pending' ? (s.ready ? 'ready' : 'blocked') : s.status;
  (buckets[b] ??= []).push(id);
}
for (const b of ['ready', 'blocked', 'branched', 'pr-open', 'merged']) {
  if (buckets[b]) console.log(`${b}: ${buckets[b].join(', ')}`);
}

// epic branches: existence + integration PR + how far ahead of the default branch
if (mode === 'epic-stacked') {
  for (const [phase, e] of Object.entries(epics)) {
    const exists = remoteBranches.has(e.branch);
    const epicPr = prs.find((p) => p.headRefName === e.branch && p.state !== 'CLOSED');
    let ahead = 0;
    if (exists) {
      const cmp = gh(['api', `repos/{owner}/{repo}/compare/${DEFAULT_BRANCH}...${e.branch}`, '--jq', '.ahead_by'], { tolerate: true });
      ahead = cmp ? parseInt(cmp.trim(), 10) || 0 : 0;
    }
    const prPart = epicPr
      ? `PR #${epicPr.number} ${epicPr.state.toLowerCase()}${epicPr.isDraft ? ' (draft)' : ''}`
      : (exists && ahead > 0 ? 'no epic PR yet' : 'not started');
    console.log(`epic phase ${phase}: ${e.branch} — ${exists ? `${ahead} ahead of ${DEFAULT_BRANCH}` : 'not created'}, ${prPart}`);
    if (exists && ahead > 0 && !epicPr) {
      console.log(`⚠ epic ${e.branch} has ${ahead} commit(s) but no PR into ${DEFAULT_BRANCH} — open it: epic-branch.sh pr ${e.branch}`);
    }
  }
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
}
for (const [id, s] of Object.entries(state)) {
  if (s.matched_by === 'marker') {
    const how = s.status === 'merged' ? `merged as PR #${s.pr}` : 'matched by title marker';
    console.log(`⚠ branch drift: ${id} ${how} (PR head ${s.pr_branch} ≠ canonical ${s.branch})`);
  }
}
console.log('wrote .planning/graph/delivery-state.json and delivery-state.yaml');
