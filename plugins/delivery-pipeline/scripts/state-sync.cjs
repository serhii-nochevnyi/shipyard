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
//
// MULTI-REPO. A ticket may carry `repo: owner/name` (from `delivery.repo`) and
// live in another repository — a phase spanning a backend and a frontend repo is
// normal. Every GitHub query is therefore scoped to the ticket's OWN repo. When
// it wasn't, a ticket whose PR was merged in the sibling repo read as `pending`
// forever, its dependents stayed blocked, and the conveyor ran out of visible
// work while a third of the graph was deliverable. Consequences of the boundary:
//   - branches do not cascade across repos → a cross-repo parent must MERGE;
//   - the epic branch name is per phase, but it EXISTS per repo, each with its
//     own integration PR into its own default branch.
//
// Besides the board this writes `.planning/graph/delivery-front.json` and prints
// `fixpoint: YES|NO` (front.cjs) — the run's stop condition as code, not prose.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { matchTicketPr } = require(path.join(__dirname, 'ticket-pr-match.cjs'));
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
const { computeFront, formatFront } = require(path.join(__dirname, 'front.cjs'));
const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
const { withLock, writeAtomic, lockDirFor } = require(path.join(__dirname, 'lock.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const FRONT = path.join(GRAPH_DIR, 'delivery-front.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');

// Tickets the RUN parked (an agent returned `escalate`, attempts > max). GitHub
// cannot know this, and a front that keeps re-offering an escalated PR is an
// infinite babysit loop — so the caller passes them in.
const argv = process.argv.slice(2);
const parkedArg = argv.indexOf('--parked');
const RUN_PARKED = parkedArg === -1
  ? []
  : String(argv[parkedArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);

// `reviewDecision` is deliberately NOT here. It is the single most expensive
// field in `gh pr list` — on a monorepo the same 1000 rows cost 41s with it and
// 7s without — and it is only ever read for OPEN PRs. So the bulk window skips
// it and a second, open-only pass fills it in (a handful of rows, ~1s). state-sync
// runs on every babysit round, so its wall time is the conveyor's tick rate.
const PR_FIELDS = 'number,state,isDraft,headRefName,baseRefName,mergedAt,createdAt,url,title';
// `body` rides along in the open-only pass for the same reason as reviewDecision:
// it is only read for OPEN PRs (the `gate_status:` trailer the conform gate
// writes), and pulling bodies across the whole 1000-row window is expensive.
const REVIEW_FIELDS = 'number,reviewDecision,body';

function fail(msg) {
  console.error(`state-sync: ${msg}`);
  process.exit(1);
}

// SHIPYARD_TIME=1 prints how long each gh call took. state-sync runs on every
// babysit round, so its wall time is the conveyor's tick rate — when it gets slow
// (a big sibling monorepo, a wide PR window) this is how you find out where.
const TIME = process.env.SHIPYARD_TIME === '1';
function gh(args, { tolerate = false } = {}) {
  const t0 = TIME ? process.hrtime.bigint() : null;
  const done = () => {
    if (TIME) process.stderr.write(`  ${Number(process.hrtime.bigint() - t0) / 1e9}s  gh ${args.slice(0, 4).join(' ')}\n`);
  };
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    done();
    return out;
  } catch (e) {
    done();
    if (tolerate) return null;
    fail(`gh ${args.join(' ')} failed: ${e.stderr ? String(e.stderr).trim() : e.message}`);
  }
}

// `gh pr checks` reports CI state through its EXIT CODE (8 = some checks still
// pending, 1 = a check failed or the PR has no checks at all) while still
// printing the requested JSON on stdout. A non-zero exit is therefore DATA, not
// an error: reading it through the strict helper above made state-sync abort on
// exactly the red/pending PRs the babysit loop exists to service.
function ghChecks(prNumber, repo) {
  const args = ['pr', 'checks', String(prNumber), '--json', 'name,state'];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8' });
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

// GSD's `git.base_branch` is the project's integration branch — it is what
// /gsd-ship targets. Honour it over the repo's default branch: in a repo that
// integrates into `develop`, resolving from origin/HEAD alone cut every epic
// from main and pointed the integration PR at the wrong place.
function integrationBranch() {
  if (cfg.gsd.base_branch) return { name: cfg.gsd.base_branch, from: 'git.base_branch' };
  const d = gh(['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { tolerate: true });
  return { name: (d && d.trim()) || 'main', from: 'repo default' };
}
const { name: DEFAULT_BRANCH, from: DEFAULT_BRANCH_SOURCE } = integrationBranch();

// ── per-repo GitHub snapshot ────────────────────────────────────────────────
// One bulk PR call per repository the graph touches (branch-agnostic — epic PRs
// and ticket PRs alike), plus that repo's branch list and default branch.
const repoOf = (t) => (t && t.repo) || null;
const REPO_IDS = [...new Set(Object.values(tickets).map(repoOf))];
if (!REPO_IDS.includes(null)) REPO_IDS.unshift(null); // the project's own repo is always present

const repoArg = (repo) => (repo ? ['--repo', repo] : []);
const apiBase = (repo) => (repo ? `repos/${repo}` : 'repos/{owner}/{repo}');

function loadRepo(repo) {
  const label = repo || 'this repo';
  // A foreign repo can be unreachable (no access, a typo in delivery.repo). That
  // must NOT abort the sync: the rest of the graph is still deliverable, so the
  // repo is marked unavailable and its tickets are parked with that reason.
  const listed = gh(['pr', 'list', ...repoArg(repo), '--state', 'all', '--limit', String(cfg.pr_fetch_limit), '--json', PR_FIELDS], { tolerate: !!repo });
  if (repo && listed == null) {
    notices.push(`repo ${label} is not reachable through gh — its tickets are parked as external; check access or the delivery.repo slug`);
    return { repo, available: false, prs: [], branches: new Set(), truncated: false, defaultBranch: null };
  }
  let prs = [];
  try { prs = JSON.parse(listed); } catch { prs = []; }
  const truncated = prs.length >= cfg.pr_fetch_limit;
  if (truncated) {
    notices.push(`the bulk PR listing for ${label} hit its limit (${cfg.pr_fetch_limit}) — falling back to per-ticket lookups for unmatched tickets (raise pipeline.pr_fetch_limit to avoid this)`);
  }
  // the open-only review pass (see PR_FIELDS): attach reviewDecision where it is
  // actually read, without paying for it across the whole window
  if (prs.some((p) => p.state === 'OPEN')) {
    const reviewRaw = gh(['pr', 'list', ...repoArg(repo), '--state', 'open', '--limit', String(cfg.pr_fetch_limit), '--json', REVIEW_FIELDS], { tolerate: true });
    let rows = [];
    try { rows = JSON.parse(reviewRaw || '[]'); } catch { rows = []; }
    const byNumber = new Map(rows.map((r) => [r.number, r]));
    for (const p of prs) {
      if (p.state === 'OPEN' && byNumber.has(p.number)) {
        const r = byNumber.get(p.number);
        p.reviewDecision = r.reviewDecision || null;
        p.body = r.body || '';
      }
    }
  }
  const branchesRaw = gh(['api', `${apiBase(repo)}/branches`, '--paginate', '--jq', '.[].name'], { tolerate: !!repo });
  const branches = new Set(String(branchesRaw || '').split('\n').filter(Boolean));
  // git.base_branch is the PROJECT's integration branch, so it only applies to
  // the project's own repo; a sibling repo keeps its own default.
  const defaultBranch = repo
    ? ((gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { tolerate: true }) || '').trim() || 'main')
    : DEFAULT_BRANCH;
  return { repo, available: true, prs, branches, truncated, defaultBranch };
}

const repoData = new Map();
for (const r of REPO_IDS) repoData.set(r, loadRepo(r));

function prsForBranch(repo, branch) {
  // branch-scoped, so a handful of rows: asking for reviewDecision here is cheap
  // and keeps a fallback-matched open PR from looking like it has no review.
  const out = gh(['pr', 'list', ...repoArg(repo), '--state', 'all', '--head', branch, '--limit', '50', '--json', `${PR_FIELDS},reviewDecision,body`], { tolerate: true });
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// The conform gate records its verdicts as a `gate_status:` trailer in the PR
// body precisely so they survive a squash merge and can be re-read by anything.
// The front and the sentinel both key the "may this land?" decision on it, so it
// is parsed here once instead of being re-derived per consumer.
function parseGate(body) {
  const line = String(body || '').split('\n').reverse().find((l) => /^\s*gate_status:/i.test(l));
  if (!line) return null;
  const out = {};
  for (const part of line.replace(/^\s*gate_status:/i, '').split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

// ── per-ticket status ───────────────────────────────────────────────────────
const state = {};
for (const [id, t] of Object.entries(tickets)) {
  const repo = repoOf(t);
  const rd = repoData.get(repo);
  const prs = rd.prs;
  const remoteBranches = rd.branches;
  let match = rd.available ? matchTicketPr(id, t, prs) : null;
  if (!match && rd.available && rd.truncated) {
    const extra = prsForBranch(repo, t.branch);
    if (extra.length) match = matchTicketPr(id, t, prs.concat(extra));
  }
  const pr = match ? match.pr : null;
  /** @type {Record<string, any>} */
  const entry = { branch: t.branch, pr: pr ? pr.number : null, status: 'pending' };
  if (repo) entry.repo = repo;
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
      const gate = parseGate(pr.body);
      if (gate) entry.gate = gate;
      const { rows, none, note } = ghChecks(pr.number, repo);
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
// Keyed per phase AND repo: one epic NAME per phase, but a separate branch (and
// integration PR) in every repository the phase touches.
const epicKey = (phase, repo) => `${phase} ${repo || ''}`;
const epicInfo = {};
if (mode === 'epic-stacked') {
  for (const [phase, e] of Object.entries(epics)) {
    const phaseRepos = Array.isArray(e.repos) && e.repos.length
      ? e.repos.map((r) => r || null)
      : [...new Set(Object.values(tickets).filter((t) => String(t.phase) === String(phase)).map(repoOf))];
    for (const repo of (phaseRepos.length ? phaseRepos : [null])) {
      const rd = repoData.get(repo) || { available: false, prs: [], branches: new Set(), defaultBranch: null };
      const base = rd.defaultBranch || DEFAULT_BRANCH;
      const exists = rd.branches.has(e.branch);
      let ahead = 0;
      if (exists) {
        const cmp = gh(['api', `${apiBase(repo)}/compare/${base}...${e.branch}`, '--jq', '.ahead_by'], { tolerate: true });
        ahead = cmp ? parseInt(cmp.trim(), 10) || 0 : 0;
      }
      const pr = rd.prs.find((p) => p.headRefName === e.branch && p.state !== 'CLOSED') || null;
      // "landed" = nothing from this phase is still waiting outside the default
      // branch (either the epic never started, or its whole diff is already in).
      epicInfo[epicKey(phase, repo)] = { phase: String(phase), repo, branch: e.branch, base, exists, ahead, pr, landed: !exists || ahead === 0 };
    }
  }
}
const phaseLanded = (phase, repo) => {
  if (mode !== 'epic-stacked') return true;
  const info = epicInfo[epicKey(phase, repo)];
  return info ? info.landed : true;
};

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
      const sameRepo = repoOf(tickets[d]) === repoOf(t);
      const samePhase = tickets[d] && tickets[d].phase === t.phase;
      if (!sameRepo) {
        // A branch in another repository cannot be cascaded from at all, so the
        // parent has to be MERGED there (its contract is then in that repo's
        // epic). Requiring the whole foreign phase to land on main would stall
        // the consumer side for no benefit — the contract is what it needs.
        if (state[d].status !== 'merged') {
          blockers.push(d);
          reasons[d] = `cross-repo parent in ${repoOf(tickets[d]) || 'this repo'} must be MERGED first (branches do not cascade across repos)`;
        }
      } else if (samePhase) {
        // cascade: a parent only needs a BRANCH to stack off — no merge wait
        if (state[d].status === 'pending') {
          blockers.push(d);
          reasons[d] = 'parent has no branch yet (nothing to cascade from)';
        }
      } else if (!(state[d].status === 'merged' && phaseLanded(tickets[d].phase, repoOf(tickets[d])))) {
        blockers.push(d);
        reasons[d] = `cross-phase parent must land on ${repoData.get(repoOf(t)).defaultBranch || DEFAULT_BRANCH} first (phase ${tickets[d].phase} epic still ahead)`;
      }
    }
    // A path outside the repo root is unreachable from a worktree, so the ticket
    // cannot be executed as written — park it with the reason instead of
    // offering it as `ready` to an executor that will find nothing.
    if (t.unreachable_paths) {
      blockers.push('plan');
      reasons.plan = 'files_modified points outside the repo — declare delivery.repo and use repo-relative paths (validate-graph warns with the exact entry)';
    }
    if (!repoData.get(repoOf(t)).available) {
      blockers.push('repo');
      reasons.repo = `repo ${repoOf(t)} is not reachable through gh — status unknown, nothing can be driven there`;
    }
    // A stale tickets.json (generated before repos were part of the graph) can
    // still carry a foreign primary parent; never emit a base that does not
    // exist in this ticket's repo — `gh pr create --base` would just fail.
    const pp = t.primary_parent && repoOf(tickets[t.primary_parent]) === repoOf(t) ? t.primary_parent : null;
    if (!pp) s.base = t.epic;
    else s.base = state[pp] && state[pp].status === 'merged' ? t.epic : (tickets[pp] ? tickets[pp].branch : t.epic);
    s.epic = t.epic;

    // The sentinel's mandate boundary, computed rather than judged: `stacked`
    // means the open PR targets this phase's epic or a parent ticket branch IN
    // ITS OWN REPO, and landing it only moves work within the stack. Anything
    // else — above all a PR pointed at the integration branch — is `integration`
    // and stays a human merge, whatever pipeline.auto_merge says.
    if (s.status === 'pr-open') {
      const integ = (repoData.get(repoOf(t)) || {}).defaultBranch || DEFAULT_BRANCH;
      const stackable = new Set([t.epic]);
      for (const [otherId, other] of Object.entries(tickets)) {
        if (otherId !== id && repoOf(other) === repoOf(t)) stackable.add(other.branch);
      }
      s.merge_scope = s.pr_base && s.pr_base !== integ && stackable.has(s.pr_base) ? 'stacked' : 'integration';
    }
  } else {
    for (const d of deps) {
      if (!state[d]) continue;
      if (state[d].status !== 'merged') {
        blockers.push(d);
        reasons[d] = 'parent not merged (direct-to-main waits for the merge)';
      }
    }
    // stacking only works inside one repo (see the epic-stacked branch above)
    const unmergedDep = deps
      .filter((d) => state[d] && state[d].status !== 'merged' && tickets[d] && repoOf(tickets[d]) === repoOf(t))
      .sort((a, b) => (tickets[b].wave || 0) - (tickets[a].wave || 0))[0];
    s.base = unmergedDep
      ? tickets[unmergedDep].branch
      : (repoData.get(repoOf(t)).defaultBranch || DEFAULT_BRANCH);
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
  // scoped to the ticket's OWN repo: an identical branch name elsewhere says
  // nothing about whether this branch is safe to force-delete
  const pool = repoData.get(repoOf(t)).prs;
  const openFromBranch = pool.filter((p) => p.state === 'OPEN' && p.headRefName === t.branch).map((p) => p.number);
  const openOntoBranch = pool.filter((p) => p.state === 'OPEN' && p.baseRefName === t.branch).map((p) => p.number);
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

const yaml = ['# generated by state-sync.cjs from live GitHub state — do not edit'];
for (const [id, s] of Object.entries(state)) {
  yaml.push(`${JSON.stringify(id)}:`);
  for (const [k, v] of Object.entries(s)) {
    yaml.push(`  ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : JSON.stringify(v)}`);
  }
}

// ── the actionable front and the stop verdict (front.cjs) ───────────────────
// Computed before the write so state, yaml and front land in ONE locked
// section: the PR sentinel runs state-sync concurrently with the main loop, and
// a reader that catches the pair half-updated acts on a state/front mismatch.
const AUTO_MERGE = cfg.auto_merge === 'epic' && mode === 'epic-stacked';
// Drift verdicts recorded by earlier runs, minus any whose plan has since been
// re-planned (drift-record binds each verdict to the plan's content hash, so the
// park lifts by itself). Without this the front hands a stale plan back to an
// executor on every run, however many times it has already been judged.
const DRIFTED = activeDrift(ROOT);
const front = computeFront(tickets, state, { parked: RUN_PARKED, autoMerge: AUTO_MERGE, drifted: DRIFTED });

withLock(lockDirFor(ROOT), 'state', () => {
  if (transitions.length) {
    fs.appendFileSync(JOURNAL, transitions.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  writeAtomic(STATE, JSON.stringify(state, null, 2) + '\n');
  writeAtomic(path.join(GRAPH_DIR, 'delivery-state.yaml'), yaml.join('\n') + '\n');
  writeAtomic(FRONT, JSON.stringify({ generated_at: nowIso, parked_by_run: RUN_PARKED, auto_merge: AUTO_MERGE ? 'epic' : 'off', ...front }, null, 2) + '\n');
}, { label: 'state-sync' });

// ── board summary on stdout for the /shipyard:deliver skill ──
function ageH(sinceIso) { return (Date.parse(nowIso) - Date.parse(sinceIso)) / 3_600_000; }
function ageLabel(sinceIso) { const h = ageH(sinceIso); return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }

for (const w of cfgWarnings) console.log(`⚠ config: ${w}`);
if (epicNotice) console.log(`note: ${epicNotice}`);
for (const n of notices) console.log(`⚠ ${n}`);
console.log(`integration mode: ${mode}${mode === 'epic-stacked' ? ` (→ ${DEFAULT_BRANCH} via epic)` : ` (→ ${DEFAULT_BRANCH})`} [base from ${DEFAULT_BRANCH_SOURCE}]`);
console.log(`model policy: ${cfg.model_policy} | workflow: ${cfg.use_workflow === false ? 'forced-off' : 'auto'} | max attempts: ${cfg.max_attempts}`);
console.log(
  `sentinel: ${cfg.sentinel} | auto-merge: ${AUTO_MERGE ? `epic (ticket PRs → their base; ${DEFAULT_BRANCH} stays a human merge)` : 'off (every merge is a human action)'}` +
  (cfg.auto_merge === 'epic' && !AUTO_MERGE ? ` — auto_merge is set but ${mode} targets the integration branch directly, so it does not apply` : '')
);
if (cfg.gsd.base_branch) {
  console.log(`note: integrating into "${cfg.gsd.base_branch}" per git.base_branch — pass it to epic-branch.sh as the base ref`);
}

const buckets = {};
for (const [id, s] of Object.entries(state)) {
  let b = s.status;
  if (s.status === 'pending') b = s.ready ? 'ready' : 'blocked';
  else if (s.status === 'branched') b = s.ready ? 'branched-needs-pr' : 'blocked';
  (buckets[b] ??= []).push(id);
}
const repoTag = (id) => (state[id].repo ? `${id}@${state[id].repo}` : id);
for (const b of ['ready', 'branched-needs-pr', 'blocked', 'pr-open', 'merged']) {
  if (buckets[b]) console.log(`${b}: ${buckets[b].map(repoTag).join(', ')}`);
}
for (const [id, s] of Object.entries(state)) {
  if (s.blocked_by) {
    const why = s.blocked_by.map((d) => `${d} (${(s.blocked_reasons || {})[d] || 'blocked'})`).join('; ');
    console.log(`  ${id} ← awaiting ${why}`);
  }
}

// epic branches: existence + integration PR + how far ahead of the default
// branch, per repo (a phase that spans repos integrates once per repo)
if (mode === 'epic-stacked') {
  for (const info of Object.values(epicInfo)) {
    const where = info.repo ? ` [${info.repo}]` : '';
    const prPart = info.pr
      ? `PR #${info.pr.number} ${info.pr.state.toLowerCase()}${info.pr.isDraft ? ' (draft)' : ''}`
      : (info.exists && info.ahead > 0 ? 'no epic PR yet' : 'not started');
    console.log(`epic phase ${info.phase}${where}: ${info.branch} — ${info.exists ? `${info.ahead} ahead of ${info.base}` : 'not created'}, ${prPart}`);
    if (info.exists && info.ahead > 0 && !info.pr) {
      console.log(`⚠ epic ${info.branch}${where} has ${info.ahead} commit(s) but no PR into ${info.base} — open it: epic-branch.sh pr ${info.branch}${info.repo ? ` (run it inside the ${info.repo} checkout)` : ''}`);
    }
  }
}

// foreign repos: tracked either way, but only DRIVABLE when the run knows where
// the local checkout is (worktrees and git are local operations)
for (const repo of REPO_IDS) {
  if (!repo) continue;
  const localPath = (cfg.repos || {})[repo];
  const n = Object.values(tickets).filter((t) => repoOf(t) === repo).length;
  if (!localPath) {
    console.log(`⚠ repo ${repo} holds ${n} ticket(s) but has no local checkout configured — add pipeline.repos["${repo}"] = "<absolute path>" so worktrees/PRs can be driven there; without it the conveyor can only TRACK them`);
  } else if (!fs.existsSync(localPath)) {
    console.log(`⚠ repo ${repo}: pipeline.repos path "${localPath}" does not exist — fix it or the run cannot execute those ${n} ticket(s)`);
  } else {
    console.log(`repo ${repo}: ${n} ticket(s), checkout ${localPath}`);
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

// ── the actionable front and the stop verdict (front.cjs) ───────────────────
// Printed last because it is the only line that decides whether the run may
// end. Prose could not hold this rule: runs serialized on a CI watch and called
// it a fixpoint while a dozen tickets were executable.
if (RUN_PARKED.length) console.log(`parked by this run: ${RUN_PARKED.join(', ')}`);
for (const line of formatFront(front)) console.log(line);
console.log('wrote .planning/graph/delivery-state.json, delivery-state.yaml and delivery-front.json');
