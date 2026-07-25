#!/usr/bin/env node
'use strict';

// Cold-start resync: rebuild .planning/graph/delivery-state.json|yaml from the
// ACTUAL GitHub state (gh CLI). The local state file is a cache; GitHub is the
// source of truth. Idempotent — safe to run at every /shipyard:deliver start.
//
// Ticket status model:
//   merged   — a PR for the ticket branch is merged
//   pr-open  — PR exists and is open (checks/review detail attached)
//   branched — branch exists on remote but no PR yet (still actionable: the PR
//              step has to be finished, so `ready` is computed for it too)
//   pending  — no PR and no branch on the remote yet
//
// Integration modes (`.planning/config.json` → pipeline.integration_mode):
//   epic-stacked (default) — one epic branch per phase; root tickets PR into
//     the epic, dependent tickets cascade (PR into the primary parent branch)
//     WITHOUT waiting for a merge. A same-phase parent is enough at `branched`.
//     A CROSS-phase parent cannot cascade — it only counts once its own phase's
//     epic has landed on the default branch.
//   direct-to-main — legacy: dependents wait for parents to MERGE; base is main
//     (or the deepest unmerged dependency branch under stacking).
//
// Ticket↔PR matching is branch-first with a ticket-ID-marker fallback
// (ticket-pr-match.cjs). `since` records when a ticket entered its status;
// transitions are appended to delivery-log.jsonl (pipeline-stats.cjs input).

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');

const PR_FIELDS = 'number,state,isDraft,headRefName,baseRefName,mergedAt,createdAt,url,reviewDecision,title';

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

// `gh pr checks` reports CI state through its EXIT CODE (8 = some checks still
// pending, 1 = a check failed or the PR has no checks at all) while still
// printing the requested JSON on stdout. A non-zero exit is therefore DATA, not
// an error: reading it through the strict helper above made state-sync abort on
// exactly the red/pending PRs the babysit loop exists to service.
function ghChecks(prNumber) {
  const r = spawnSync('gh', ['pr', 'checks', String(prNumber), '--json', 'name,state'], { encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  if (stdout) {
    try {
      const rows = JSON.parse(stdout);
      if (Array.isArray(rows)) return { rows, none: rows.length === 0 };
    } catch { /* fall through to the no-data branch */ }
  }
  if (r.status === 0) return { rows: [], none: true };
  const why = (r.stderr || '').trim().split('\n')[0] || `gh pr checks exited ${r.status}`;
  return { rows: [], none: true, note: why };
}

const { config: cfg, warnings: cfgWarnings } = loadConfig(ROOT);

if (!fs.existsSync(TICKETS)) fail('missing .planning/graph/tickets.json — run validate-graph first');
let graph;
try {
  graph = JSON.parse(fs.readFileSync(TICKETS, 'utf8'));
} catch (e) {
  fail(`.planning/graph/tickets.json is not valid JSON (${e.message}) — re-run validate-graph`);
}
const tickets = graph.tickets || {};
const epics = graph.epics || {};
if (!Object.keys(tickets).length) fail('tickets.json contains no tickets — re-run validate-graph');

let mode = cfg.integration_mode;

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
const notices = [];

function defaultBranch() {
  const d = gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { tolerate: true });
  return (d && d.trim()) || 'main';
}
const DEFAULT_BRANCH = defaultBranch();

// one bulk call: every PR (branch-agnostic) — epic PRs and ticket PRs alike.
const prs = JSON.parse(
  gh(['pr', 'list', '--state', 'all', '--limit', String(cfg.pr_fetch_limit), '--json', PR_FIELDS])
);
// A hard `--limit` used to silently truncate: in a busy repo a ticket's PR fell
// outside the window, the ticket read as `pending`, and the conveyor re-did
// already-merged work. If the window was actually filled we can no longer treat
// "no match" as authoritative, so every unmatched ticket gets an exact,
// branch-scoped lookup as well.
const truncated = prs.length >= cfg.pr_fetch_limit;
if (truncated) {
  notices.push(`the bulk PR listing hit its limit (${cfg.pr_fetch_limit}) — falling back to per-ticket lookups for unmatched tickets (raise pipeline.pr_fetch_limit to avoid this)`);
}

const remoteBranchesRaw = gh(['api', 'repos/{owner}/{repo}/branches', '--paginate', '--jq', '.[].name']);
const remoteBranches = new Set(String(remoteBranchesRaw || '').split('\n').filter(Boolean));

function prsForBranch(branch) {
  const out = gh(['pr', 'list', '--state', 'all', '--head', branch, '--limit', '50', '--json', PR_FIELDS], { tolerate: true });
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// ── per-ticket status ───────────────────────────────────────────────────────
const state = {};
for (const [id, t] of Object.entries(tickets)) {
  let pool = prs;
  let match = matchTicketPr(id, t, pool);
  if (!match && truncated) {
    const extra = prsForBranch(t.branch);
    if (extra.length) {
      pool = prs.concat(extra);
      match = matchTicketPr(id, t, pool);
    }
  }
  const pr = match ? match.pr : null;
  /** @type {Record<string, any>} */
  const entry = { branch: t.branch, pr: pr ? pr.number : null, status: 'pending' };
  if (match && match.matchedBy === 'marker') {
    entry.matched_by = 'marker';
    entry.pr_branch = pr.headRefName;
  }
  if (pr) {
    if (pr.state === 'MERGED') {
      entry.status = 'merged';
      entry.url = pr.url;
    } else if (pr.state === 'OPEN') {
      entry.status = 'pr-open';
      entry.draft = pr.isDraft;
      entry.review_decision = pr.reviewDecision || null;
      entry.url = pr.url;
      entry.pr_base = pr.baseRefName;
      entry.pr_created_at = pr.createdAt;
      const { rows, none, note } = ghChecks(pr.number);
      entry.checks = {
        total: rows.length,
        failing: rows.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).length,
        pending: rows.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(c.state)).length,
        none_reported: none,
      };
      if (note) entry.checks.note = note;
    } else {
      entry.status = remoteBranches.has(t.branch) ? 'branched' : 'pending';
      entry.note = `PR #${pr.number} closed without merge`;
    }
  } else if (remoteBranches.has(t.branch)) {
    entry.status = 'branched';
  }
  state[id] = entry;
}

// ── epic state (needed BEFORE readiness: a cross-phase dependency is only
//    satisfied once its own phase's epic has landed on the default branch) ────
const epicInfo = {};
if (mode === 'epic-stacked') {
  for (const [phase, e] of Object.entries(epics)) {
    const exists = remoteBranches.has(e.branch);
    let ahead = 0;
    if (exists) {
      const cmp = gh(['api', `repos/{owner}/{repo}/compare/${DEFAULT_BRANCH}...${e.branch}`, '--jq', '.ahead_by'], { tolerate: true });
      ahead = cmp ? parseInt(cmp.trim(), 10) || 0 : 0;
    }
    const pr = prs.find((p) => p.headRefName === e.branch && p.state !== 'CLOSED') || null;
    // "landed" = nothing from this phase is still waiting outside the default
    // branch (either the epic never started, or its whole diff is already in).
    epicInfo[phase] = { branch: e.branch, exists, ahead, pr, landed: !exists || ahead === 0 };
  }
}
const phaseLanded = (phase) => (mode === 'epic-stacked' ? (epicInfo[phase] ? epicInfo[phase].landed : true) : true);

// ── readiness + the effective PR base each ticket should target ─────────────
// `ready` is computed for every not-yet-delivered status, `branched` included:
// a branch pushed without a PR is unfinished work, and leaving it out of the
// actionable front made a run declare "fixpoint" while a ticket sat idle.
const UNDELIVERED = new Set(['pending', 'branched']);
for (const [id, t] of Object.entries(tickets)) {
  const s = state[id];
  const deps = t.depends_on || [];
  const blockers = [];
  const reasons = {};

  if (mode === 'epic-stacked') {
    for (const d of deps) {
      if (!state[d]) continue;
      const samePhase = tickets[d] && tickets[d].phase === t.phase;
      if (samePhase) {
        // cascade: a parent only needs a BRANCH to stack off — no merge wait
        if (state[d].status === 'pending') {
          blockers.push(d);
          reasons[d] = 'parent has no branch yet (nothing to cascade from)';
        }
      } else if (!(state[d].status === 'merged' && phaseLanded(tickets[d].phase))) {
        blockers.push(d);
        reasons[d] = `cross-phase parent must land on ${DEFAULT_BRANCH} first (phase ${tickets[d].phase} epic still ahead)`;
      }
    }
    const pp = t.primary_parent;
    if (!pp) s.base = t.epic;
    else s.base = state[pp] && state[pp].status === 'merged' ? t.epic : (tickets[pp] ? tickets[pp].branch : t.epic);
    s.epic = t.epic;
  } else {
    for (const d of deps) {
      if (!state[d]) continue;
      if (state[d].status !== 'merged') {
        blockers.push(d);
        reasons[d] = 'parent not merged (direct-to-main waits for the merge)';
      }
    }
    const unmergedDep = deps
      .filter((d) => state[d] && state[d].status !== 'merged' && tickets[d])
      .sort((a, b) => (tickets[b].wave || 0) - (tickets[a].wave || 0))[0];
    s.base = unmergedDep ? tickets[unmergedDep].branch : DEFAULT_BRANCH;
  }

  if (UNDELIVERED.has(s.status)) {
    s.ready = blockers.length === 0;
    if (blockers.length) {
      s.blocked_by = blockers;
      s.blocked_reasons = reasons;
    }
    // a branched ticket is ready AND already has its branch: the missing step is
    // the PR, not the code — the board says so explicitly.
    if (s.status === 'branched') s.needs_pr = true;
  }
}

// ── reap safety (the reaper force-deletes branches, so it must be mechanical) ─
// A ticket is reapable only when its work is merged AND nothing live still hangs
// off its branch: no OPEN PR from it, and no OPEN PR targeting it as a base
// (deleting the branch would orphan a cascade child).
for (const [id, t] of Object.entries(tickets)) {
  const s = state[id];
  const openFromBranch = prs.filter((p) => p.state === 'OPEN' && p.headRefName === t.branch).map((p) => p.number);
  const openOntoBranch = prs.filter((p) => p.state === 'OPEN' && p.baseRefName === t.branch).map((p) => p.number);
  s.reapable = s.status === 'merged' && openFromBranch.length === 0 && openOntoBranch.length === 0;
  if (s.status === 'merged' && !s.reapable) {
    s.reap_blocked_by = { open_from_branch: openFromBranch, open_onto_branch: openOntoBranch };
  }
}

// ── timestamps + journal every REAL status transition ───────────────────────
const transitions = [];
for (const [id, entry] of Object.entries(state)) {
  const before = prev[id];
  const unchanged = before && before.status === entry.status;
  entry.since = unchanged && before.since ? before.since : nowIso;

  // "awaiting merge" is its OWN clock: `since` only moves on a status change, so
  // measuring the merge tail with it reported the age of the PR instead of the
  // time it has been mergeable. Carry a dedicated stamp, and when there is no
  // local history fall back to the PR's creation time (a conservative floor)
  // rather than inventing "0h" and suppressing the warning entirely.
  const green = entry.checks && entry.checks.failing === 0 && entry.checks.pending === 0;
  const mergeable = entry.status === 'pr-open' && !entry.draft && entry.review_decision === 'APPROVED' && green;
  if (mergeable) {
    entry.mergeable_since = (before && before.mergeable_since) || entry.pr_created_at || nowIso;
    entry.mergeable_since_is_floor = !(before && before.mergeable_since);
  }
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
  yaml.push(`${JSON.stringify(id)}:`);
  for (const [k, v] of Object.entries(s)) {
    yaml.push(`  ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : JSON.stringify(v)}`);
  }
}
fs.writeFileSync(path.join(GRAPH_DIR, 'delivery-state.yaml'), yaml.join('\n') + '\n');

// ── board summary on stdout for the /shipyard:deliver skill ──
function ageH(sinceIso) { return (Date.parse(nowIso) - Date.parse(sinceIso)) / 3_600_000; }
function ageLabel(sinceIso) { const h = ageH(sinceIso); return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }

for (const w of cfgWarnings) console.log(`⚠ config: ${w}`);
if (epicNotice) console.log(`note: ${epicNotice}`);
for (const n of notices) console.log(`⚠ ${n}`);
console.log(`integration mode: ${mode}${mode === 'epic-stacked' ? ` (→ ${DEFAULT_BRANCH} via epic)` : ` (→ ${DEFAULT_BRANCH})`}`);
console.log(`model policy: ${cfg.model_policy} | workflow: ${cfg.use_workflow === false ? 'forced-off' : 'auto'} | max attempts: ${cfg.max_attempts}`);

const buckets = {};
for (const [id, s] of Object.entries(state)) {
  let b = s.status;
  if (s.status === 'pending') b = s.ready ? 'ready' : 'blocked';
  else if (s.status === 'branched') b = s.ready ? 'branched-needs-pr' : 'blocked';
  (buckets[b] ??= []).push(id);
}
for (const b of ['ready', 'branched-needs-pr', 'blocked', 'pr-open', 'merged']) {
  if (buckets[b]) console.log(`${b}: ${buckets[b].join(', ')}`);
}
for (const [id, s] of Object.entries(state)) {
  if (s.blocked_by) {
    const why = s.blocked_by.map((d) => `${d} (${(s.blocked_reasons || {})[d] || 'blocked'})`).join('; ');
    console.log(`  ${id} ← awaiting ${why}`);
  }
}

// epic branches: existence + integration PR + how far ahead of the default branch
if (mode === 'epic-stacked') {
  for (const [phase, info] of Object.entries(epicInfo)) {
    const prPart = info.pr
      ? `PR #${info.pr.number} ${info.pr.state.toLowerCase()}${info.pr.isDraft ? ' (draft)' : ''}`
      : (info.exists && info.ahead > 0 ? 'no epic PR yet' : 'not started');
    console.log(`epic phase ${phase}: ${info.branch} — ${info.exists ? `${info.ahead} ahead of ${DEFAULT_BRANCH}` : 'not created'}, ${prPart}`);
    if (info.exists && info.ahead > 0 && !info.pr) {
      console.log(`⚠ epic ${info.branch} has ${info.ahead} commit(s) but no PR into ${DEFAULT_BRANCH} — open it: epic-branch.sh pr ${info.branch}`);
    }
  }
}

// stale warnings: the conveyor's tail (merge/review by humans) is where time
// silently disappears — surface it on every cold start
for (const [id, s] of Object.entries(state)) {
  if (s.status !== 'pr-open') continue;
  if (s.mergeable_since && ageH(s.mergeable_since) >= cfg.stale_merge_hours) {
    const qualifier = s.mergeable_since_is_floor ? ' (no local history — measured from PR creation)' : '';
    console.log(`⚠ stale: ${id} PR #${s.pr} approved+green — awaiting merge for ${ageLabel(s.mergeable_since)}${qualifier}`);
  } else if (s.draft && ageH(s.since) >= cfg.stale_draft_hours) {
    console.log(`⚠ stale: ${id} PR #${s.pr} still a draft for ${ageLabel(s.since)}`);
  }
  if (s.checks && s.checks.none_reported) {
    console.log(`⚠ ${id} PR #${s.pr}: no CI checks reported${s.checks.note ? ` (${s.checks.note})` : ''} — "green" here means "nothing to run", confirm that is expected`);
  }
}
for (const [id, s] of Object.entries(state)) {
  if (s.matched_by === 'marker') {
    const how = s.status === 'merged' ? `merged as PR #${s.pr}` : 'matched by title marker';
    console.log(`⚠ branch drift: ${id} ${how} (PR head ${s.pr_branch} ≠ canonical ${s.branch})`);
  }
  if (s.status === 'merged' && !s.reapable) {
    const b = s.reap_blocked_by;
    console.log(`⚠ ${id} is merged but NOT reapable — open PRs still depend on its branch (from: ${b.open_from_branch.join(', ') || 'none'}; onto: ${b.open_onto_branch.join(', ') || 'none'}). Retarget them before deleting ${s.branch}.`);
  }
}
console.log('wrote .planning/graph/delivery-state.json and delivery-state.yaml');
