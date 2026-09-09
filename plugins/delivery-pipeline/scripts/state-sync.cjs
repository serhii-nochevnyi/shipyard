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
const { computeFront, formatFront, ciEstimates, epicKey } = require(path.join(__dirname, 'front.cjs'));
const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
// The park RECORDS, never the flat `activeEscalations` view: the board's lifting
// sentence is chosen from the park's KIND, and the flat map keeps the kind only
// as a text prefix. front.cjs's CLI and dispatch-record's refreshFront already
// read it this way; this file was the last caller that did not.
const { activeParks } = require(path.join(__dirname, 'escalation-record.cjs'));
// "An agent is holding this one" — the third durable fact GitHub cannot know, and
// the one this writer used to drop. See the comment at DISPATCHED below.
const { activeDispatches } = require(path.join(__dirname, 'dispatch-record.cjs'));
const { withLock, writeAtomic, lockDirFor } = require(path.join(__dirname, 'lock.cjs'));
const { classify, isGreen, unavailableNote, CHECK_FIELDS } = require(path.join(__dirname, 'check-state.cjs'));
// The trailer's parser lives with its writer (gate-trailer.cjs), because a
// verdict the board and the guard must agree on cannot be held by three copies.
const { parseGate } = require(path.join(__dirname, 'gate-trailer.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const FRONT = path.join(GRAPH_DIR, 'delivery-front.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');
// The snapshot's own identity — WHEN its facts were observed, and which
// generation of the board they produced. Its own file, and that is not a
// preference: `delivery-state.json` is a bare `{ticket-id: entry}` map with no
// top level that is not a ticket, and `front.cjs` iterates those keys without
// filtering against tickets.json — so metadata parked in there becomes a phantom
// ticket in the buckets the stop gate reads. `delivery-front.json` cannot hold it
// either: `dispatch-record.cjs refreshFront` rewrites that file from a fixed list
// of keys, so anything else on it is dropped by the next `mark`. This file has
// exactly one writer (this script, inside the `state` lock), which is what a
// compare-and-swap subject has to have. The front gets an advisory copy for
// readers; THIS is the authority.
const META = path.join(GRAPH_DIR, 'delivery-state-meta.json');

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
const PR_FIELDS = 'number,state,isDraft,headRefName,headRefOid,baseRefName,mergedAt,createdAt,url,title';
// `headRefOid` is one scalar and carries none of the reviewDecision cost: it is
// the head the `gate_status:` trailer is bound to, so without it the board can
// read a conform verdict and not know it was rendered against a diff that has
// since been pushed over.
// `body` rides along in the open-only pass for the same reason as reviewDecision:
// it is only read for OPEN PRs (the `gate_status:` trailer the conform gate
// writes), and pulling bodies across the whole 1000-row window is expensive.
// `mergeStateStatus` rides the SAME open-only pass, and it is the fact
// `front.cjs`'s `baseMoved` reads: a green measured against a base that has since
// MOVED is not a green, so the board was offering exactly the merges
// `sentinel.cjs merge` refuses. The integrator found that predicate DEAD on the
// board (2026-09-07) for one reason — nothing wrote the field it reads. It is one
// scalar on a call that is already open-only and already asking for the two
// expensive fields, so it is paid where the answer is read and nowhere else;
// never add it to the bulk window above.
//
// `behind_by` — the mirror signal, and the reason neither alone suffices
// (GitHub reports BEHIND only where branch protection requires up-to-date
// branches) — is deliberately NOT here: no `gh pr list` field carries it, so it
// would cost one `gh api compare` PER PR PER ROUND, and state-sync's wall time is
// the conveyor's tick rate. The guard pays that compare on the duty/merge path
// only (`sentinel.cjs baseCheck`), where the answer is about to be acted on. A
// board with no `behind_by` therefore says "GitHub did not report BEHIND", which
// is exactly what `baseMoved` treats it as.
const REVIEW_FIELDS = 'number,reviewDecision,body,mergeStateStatus';

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

// The tolerant helper above answers `null` and DROPS gh's own message, which is
// enough for every call whose failure means "park this and move on". It is not
// enough for a call whose failure has to reach the board wearing a reason a
// person can act on — the epic comparison below is the one such call, and
// "integration state unknown" with no cause named is a dead end. So it goes
// through spawnSync like `ghChecks` and keeps stdout, the exit status and the
// first line of stderr apart. One call per epic per sync (not per PR), so the
// conveyor's tick rate is untouched.
function ghTry(args) {
  const t0 = TIME ? process.hrtime.bigint() : null;
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (TIME) process.stderr.write(`  ${Number(process.hrtime.bigint() - t0) / 1e9}s  gh ${args.slice(0, 4).join(' ')}\n`);
  const why = (r.stderr || '').trim().split('\n').filter(Boolean)[0]
    || (r.error ? r.error.message : '');
  return { status: r.error ? null : r.status, stdout: (r.stdout || '').trim(), stderr: why };
}

// `gh pr checks` reports CI state through its EXIT CODE (8 = some checks still
// pending, 1 = a check failed or the PR has no checks at all) while still
// printing the requested JSON on stdout. A non-zero exit is therefore DATA, not
// an error: reading it through the strict helper above made state-sync abort on
// exactly the red/pending PRs the babysit loop exists to service.
//
// But an answer that never arrived is a different fact again: gh itself failed
// (an old `gh` rejecting `bucket`, a 503, a rate limit, an expired token), and
// that is not "this PR has no checks" either. Collapsing the two into the same
// `{ rows: [] }` shape made `classify([])` read `none_reported: true, failing: 0,
// pending: 0` — the exact tally the merge gate treats as unblocked — off a call
// that never actually answered.
//
// THE SHAPE OF STDOUT DECIDES; the exit code is consulted only when stdout is
// silent. Three cases, and the middle one is the whole point:
//
//   parses to an array   trusted as-is, EMPTY OR NOT and whatever the exit code.
//                        A non-zero exit with valid JSON is the normal case
//                        above, not an error.
//   non-empty, not an    UNREADABLE, whatever the exit code. `gh` answered
//   array                something else — malformed JSON, an API error object, a
//                        notice contaminating stdout — and it exits 0 while
//                        doing so, so a `status === 0` test here reads a
//                        successful COMMAND as a readable ANSWER. This branch
//                        used to be a bare `if` after the parse attempt rather
//                        than an `else if`, so exit 0 manufactured `[]` locally;
//                        `sentinel.cjs` and `ci-wait.cjs` both had the `else if`
//                        and called the same `gh` answer unreadable, which left
//                        the board and the guard disagreeing (ADR-004 F02 names
//                        this cell "malformed JSON").
//   empty                only here does the status decide: 0 means gh succeeded
//                        and reported nothing — genuinely no checks — and
//                        anything else is unreadable.
//
// Unreadable hands `rows: null` to `check-state.cjs`, which reports it as the
// fourth state, `unavailable`. It used to hand over a synthetic
// `[{ bucket: 'unreadable' }]` row instead, to borrow `classify`'s fail-closed
// `pending`. That waited for the right reason and said the wrong thing — one
// pending check, on a PR where nothing was read — and it put the fact in two
// places at once: the row here and the flag there. The flag is the fact;
// `rows: null` is how it is spelled on the way in, and this function returns
// NOTHING else about it — `none`/`unavailable` were computed here too until the
// only caller stopped reading them, which is one more second home for a fact
// `classify` owns.
function ghChecks(prNumber, repo) {
  const args = ['pr', 'checks', String(prNumber), '--json', CHECK_FIELDS];
  if (repo) args.push('--repo', repo);
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  let rows = null;
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) rows = parsed;
    } catch { /* not JSON at all — `null` travels on to `classify` */ }
  } else if (r.status === 0) {
    rows = []; // gh succeeded and printed nothing — genuinely no checks
  }
  if (Array.isArray(rows)) return { rows };
  // The note is what reaches the board, the front's why-message and the merge
  // refusal, so it has to name the CAUSE — and it is derived by the module that
  // owns the provenance order, so the board and the guard cannot describe the
  // same `gh` answer differently.
  return { rows: null, note: unavailableNote(r) };
}

// `valid` is the field a WRITER checks (ADR-004 D2): this script writes the board
// the loop acts on and prints the auto-merge policy the guard enforces, so an
// unparseable config must not reach either as the DEFAULTS. Absent is a different
// fact and keeps its old behaviour — the defaults are the right answer there.
const { config: cfg, warnings: cfgWarnings, valid: CFG_VALID } = loadConfig(ROOT);

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
// When THIS run started READING GitHub — which is the only timestamp that can
// decide who gets to publish. Two syncs run concurrently by design (the main loop
// and the guard), each spending minutes in `gh` calls OUTSIDE the write lock, and
// the one that started earlier can easily finish later: it then holds valid,
// coherent, OLDER facts. Ordering by who reached the lock first is exactly how a
// board rolls backwards (audit F13), so the comparison is about the age of the
// FACTS. Kept separate from `nowIso` on purpose: `nowIso` stamps `since`, the
// journal transitions and the front's `generated_at`, and the smoke case that
// ages an observation window must move one of the two and not the other.
const OBSERVED_AT = process.env.SHIPYARD_STATE_OBSERVED_AT || nowIso;

const notices = [];

// The snapshot on disk, as it stands right now. Read INSIDE the lock and nowhere
// else — a read taken before queueing for the lock is precisely the stale input
// this guard exists to reject.
//
// A file that will not parse FAILS OPEN: no snapshot is known, so this run
// publishes as generation 1 and the comparison cannot refuse anything. Failing
// closed would be worse by a wide margin — one bad byte would wedge every sync on
// the project forever — but the reader has to be told, or a generation counter
// silently restarting at 1 reads as "the board was never published".
function readMeta() {
  if (!fs.existsSync(META)) return null;   // the ordinary first run: nothing to say
  try {
    const m = JSON.parse(fs.readFileSync(META, 'utf8'));
    if (m && typeof m === 'object') return m;
    notices.push(`${path.basename(META)} does not hold an object — publishing as generation 1; nothing older can be recognised this run`);
    return null;
  } catch (e) {
    notices.push(
      `${path.basename(META)} is unreadable (${e.message}) — publishing as generation 1. ` +
      'A concurrent sync that started before this one can no longer be recognised as newer; ' +
      'delete the file if a run was killed mid-write.'
    );
    return null;
  }
}

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
        p.mergeStateStatus = r.mergeStateStatus || null;
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
  // branch-scoped, so a handful of rows: asking for the open-only fields here is
  // cheap and keeps a fallback-matched open PR from looking like it has no review,
  // no trailer and no merge state — left out, a PR reached only through this
  // fallback would arrive with `merge_state: null`, which every reader treats as
  // "GitHub did not report BEHIND".
  const out = gh(['pr', 'list', ...repoArg(repo), '--state', 'all', '--head', branch, '--limit', '50', '--json', `${PR_FIELDS},reviewDecision,body,mergeStateStatus`], { tolerate: true });
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
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
      // The head the verdict must be ABOUT, recorded beside the verdict itself:
      // `gateConform(gate, head_sha)` is absent when they disagree, so a push
      // after arch-review re-owes the verdict instead of inheriting it.
      entry.head_sha = pr.headRefOid || null;
      // GitHub's own verdict on whether this branch can still land where it
      // points, recorded under the name both readers use (`sentinel.cjs`'s
      // `settlement` reads the identical field off its own PR view). BEHIND and
      // DIRTY are what `front.cjs baseMoved` acts on; UNKNOWN — which GitHub
      // returns while it computes mergeability — is neither, and falls through to
      // the work, because "we could not tell" must never park a PR.
      entry.merge_state = pr.mergeStateStatus || null;
      const gate = parseGate(pr.body);
      if (gate) entry.gate = gate;
      const { rows, note } = ghChecks(pr.number, repo);
      // check-state.cjs classifies; this file only records. The KEYS are the
      // board's contract — front.cjs's green test, escalation-record's
      // fingerprint and the stop gate all read exactly these — so the tallies
      // are copied across by name rather than spread in.
      const c = classify(rows);
      entry.checks = {
        total: c.total,
        failing: c.failing,
        pending: c.pending,
        // Both flags come from `classify`, not from `ghChecks`: the shape of the
        // answer (`[]` versus nothing at all) is what decides, and one place
        // decides it. `none_reported` is a genuine observed empty list — this PR
        // has no checks configured. `unavailable` is the reading that did not
        // happen, and it is recorded UNCONDITIONALLY beside it, because a board
        // where the key is simply missing cannot say whether the last sync found
        // the checks readable or predates the question.
        none_reported: c.none_reported,
        unavailable: c.unavailable,
      };
      // Only ever set with `unavailable` — it is the cause `gh` printed, and it
      // is what the front's why-message and the merge refusal quote.
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
// integration PR) in every repository the phase touches. `epicKey` comes from
// front.cjs and is not spelled again here: `computeFront` LOOKS UP these very
// records to decide whether a ticket was left behind by its own phase, and a
// key written twice is a lookup that can miss while both spellings look right.
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
      // Integration state is `landed | not-landed | unknown` (ADR-004 D3), and
      // the third value is the whole point. This was `let ahead = 0; … ahead =
      // cmp ? parseInt(cmp) || 0 : 0` with `landed: !exists || ahead === 0`, so
      // a failed compare (`null`), an empty answer and a REAL zero were the same
      // number and `landed` came out TRUE off a call that never answered. The
      // audit reproduced it with a rate-limited compare (F07): a parent merged
      // into its still-unlanded epic, and every phase-N+1 child of it became
      // `ready` on a base that does not contain it. `null` means "not observed":
      // it parks the dependents with the reason and is retried on the next sync,
      // never mapped onto zero.
      let ahead = 0;
      let landed = true;
      let landedReason = `epic ${e.branch} does not exist — nothing from this phase is outside ${base}`;
      if (exists) {
        const cmpPath = `${apiBase(repo)}/compare/${base}...${e.branch}`;
        const cmp = ghTry(['api', cmpPath, '--jq', '.ahead_by']);
        // Strict on purpose: `parseInt` is what collapsed the states. A rate-limit
        // message, an HTML error page, jq's `null` and an empty answer all yield
        // NaN, and `NaN || 0` is a zero nobody measured.
        const n = cmp.status === 0 && /^\d+$/.test(cmp.stdout) ? parseInt(cmp.stdout, 10) : null;
        if (n === null) {
          ahead = null;
          landed = null;
          landedReason = cmp.status === 0
            ? `gh compare failed: ${cmpPath} answered ${JSON.stringify(cmp.stdout.slice(0, 80))}, not a commit count`
            : `gh compare failed: ${cmp.stderr || `gh api ${cmpPath} exited ${cmp.status}`}`;
        } else {
          ahead = n;
          landed = n === 0;
          landedReason = n === 0
            ? `epic ${e.branch} is 0 commits ahead of ${base} — its whole diff is in`
            : `epic ${e.branch} is ${n} commit(s) ahead of ${base}`;
        }
      }
      const pr = rd.prs.find((p) => p.headRefName === e.branch && p.state !== 'CLOSED') || null;
      // "landed" = nothing from this phase is still waiting outside the default
      // branch (either the epic never started, or its whole diff is already in);
      // `null` = the comparison did not answer, so nothing is proven either way.
      epicInfo[epicKey(phase, repo)] = { phase: String(phase), repo, branch: e.branch, base, exists, ahead, pr, landed, landed_reason: landedReason };
    }
  }
}
// `landed | not-landed | unknown` for one phase in one repository, WITH the
// observation behind it: a blocker whose reason is "unknown" has to name what
// could not be seen, or the board hands its reader a dead end. No epic record —
// direct-to-main, or a phase whose epic metadata predates epic-stacked — is
// `true`, because there is no epic that could still be ahead.
const phaseLanded = (phase, repo) => {
  if (mode !== 'epic-stacked') return { landed: true, reason: null };
  const info = epicInfo[epicKey(phase, repo)];
  if (!info) return { landed: true, reason: null };
  return { landed: info.landed, reason: info.landed_reason };
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

  // Two facts about whether this ticket can be executed AT ALL, and they hold in
  // BOTH integration modes — so they are checked BEFORE the mode split, where
  // mode-specific dependency and base logic cannot skip them. They used to live
  // inside the epic-stacked branch alone (audit F27), so in direct-to-main —
  // including the legacy fallback a pre-epic tickets.json triggers — a
  // dependency-free ticket whose declared paths escape the repo, or whose
  // repository cannot be reached at all, still came out `ready` and was
  // dispatched to an executor that would find nothing.
  //
  // A path outside the repo root is unreachable from a worktree, so the ticket
  // cannot be executed as written — park it with the reason instead of offering
  // it as `ready`.
  if (t.unreachable_paths) {
    blockers.push('plan');
    reasons.plan = 'files_modified points outside the repo — declare delivery.repo and use repo-relative paths (validate-graph warns with the exact entry)';
  }
  if (!repoData.get(repoOf(t)).available) {
    blockers.push('repo');
    reasons.repo = `repo ${repoOf(t)} is not reachable through gh — status unknown, nothing can be driven there`;
  }

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
      } else {
        // A cross-phase parent cannot be cascaded from: its contract only counts
        // once its own phase's epic is on the integration branch. THREE distinct
        // facts, so three distinct sentences — the single condition said "epic
        // still ahead" even when the parent PR was not merged at all, and said
        // the same when the comparison had simply failed. "Positive evidence"
        // means the board reports what was observed, and `unknown` is not
        // `not-landed`: it is retried, and a person reading the board is told
        // which observation is missing rather than being sent to look at an epic.
        const integ = repoData.get(repoOf(t)).defaultBranch || DEFAULT_BRANCH;
        const ph = phaseLanded(tickets[d].phase, repoOf(tickets[d]));
        if (state[d].status !== 'merged') {
          blockers.push(d);
          reasons[d] = `cross-phase parent must be MERGED and its phase ${tickets[d].phase} epic landed on ${integ} first (parent is ${state[d].status})`;
        } else if (ph.landed === null) {
          blockers.push(d);
          reasons[d] = `integration state unknown (${ph.reason}) — retried next sync`;
        } else if (ph.landed === false) {
          blockers.push(d);
          reasons[d] = `cross-phase parent must land on ${integ} first (phase ${tickets[d].phase} epic still ahead)`;
        }
      }
    }
    // THE BASE IS ONE FIELD WITH TWO JOBS (ADR-006 D3): it decides what the
    // review diff shows AND where the squash LANDS. A parent's ticket branch is
    // a legal base only while that parent's PR is still open — the post-merge
    // retarget is what then gives both properties. Once the parent has merged,
    // its branch is a limb: its content is in the epic, nothing will carry a
    // child squashed onto it any further, and PR #52 proved that failure is
    // invisible from every board the conveyor prints (the ticket read `merged`,
    // the PR read merged, and the epic did not have the work).
    //
    // Resolution is THIS reader's because it is the only one holding the live
    // parent status. Every arm carries its reason, because the one thing the
    // incident's board could not say was WHY the base it printed was the base.
    //
    // A missing fact must not resolve to a branch. `pending` is not "the parent
    // is early", it is "no branch was observed on the remote", and an
    // unreachable repo makes every status in it a non-observation — both used to
    // yield `tickets[pp].branch`, i.e. a base that may not exist at all. The
    // epic always exists (Step 0 ensures it), so it is the safe fall-back in
    // every unproven case, and `base-merge` keeps the diff a single slice.
    //
    // A stale tickets.json (generated before repos were part of the graph) can
    // still carry a foreign primary parent; never emit a base that does not
    // exist in this ticket's repo — `gh pr create --base` would just fail.
    const pp = t.primary_parent && repoOf(tickets[t.primary_parent]) === repoOf(t) ? t.primary_parent : null;
    const ppState = pp ? state[pp] : null;
    const ppBranch = pp && tickets[pp] ? tickets[pp].branch : null;
    const ppRepoOk = pp ? (repoData.get(repoOf(tickets[pp])) || {}).available === true : false;
    if (!pp) {
      s.base = t.epic;
      s.base_reason = `no primary parent — a root ticket PRs into ${t.epic}`;
    } else if (ppState && ppState.status === 'merged') {
      s.base = t.epic;
      s.base_reason = `${pp} is MERGED, so its branch is no longer where work lands — the base is ${t.epic} (base-merge it in first to keep the review diff one slice)`;
    } else if (!ppState) {
      s.base = t.epic;
      s.base_reason = `${pp}'s status could not be read (no entry in delivery state) — falling back to ${t.epic} rather than resolving a missing fact to a branch`;
    } else if (!ppRepoOk) {
      s.base = t.epic;
      s.base_reason = `${pp}'s status could not be read (repo ${repoOf(tickets[pp]) || 'this repo'} is not reachable through gh) — falling back to ${t.epic} rather than resolving a missing fact to a branch`;
    } else if (!ppBranch) {
      s.base = t.epic;
      s.base_reason = `${pp} carries no branch in the graph — falling back to ${t.epic}`;
    } else if (ppState.status === 'pending') {
      s.base = t.epic;
      s.base_reason = `${pp} has no branch on the remote yet (status pending) — ${ppBranch} is not a base that exists, so the base is ${t.epic}`;
    } else {
      s.base = ppBranch;
      s.base_reason = `${pp} is ${ppState.status} — cascade off ${ppBranch}; the sentinel retargets this PR onto ${t.epic} when ${pp} lands`;
    }
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
    const integ = repoData.get(repoOf(t)).defaultBranch || DEFAULT_BRANCH;
    s.base = unmergedDep ? tickets[unmergedDep].branch : integ;
    // Same field, same obligation to say why it holds that value — direct-to-main
    // waits for the MERGE, so an unmerged dependency is the only thing that can
    // move the base off the integration branch here.
    s.base_reason = unmergedDep
      ? `direct-to-main: ${unmergedDep} is not merged yet — stacking on ${tickets[unmergedDep].branch}`
      : `direct-to-main: no unmerged dependency in this repo — the base is ${integ}`;
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
  // `isGreen`, not the arithmetic that used to be written out here: an
  // `unavailable` reading has all-zero tallies, so `failing === 0 && pending === 0`
  // started this clock off a call that never answered — and the warning it feeds
  // says "approved+green — awaiting merge", which is a claim about checks nobody
  // read. The `entry.checks &&` guard stays: a ticket with no checks object at
  // all has no clock, which is not the same as one whose checks are empty.
  const green = entry.checks && isGreen(entry.checks);
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
// AUTO_MERGE/DRIFTED/ESCALATED do not depend on this run's own journal append,
// so they are computed here; ciEstimates DOES (see below), so computeFront
// itself moves inside the locked section, after the append. The dispatch overlay
// is read inside that section too, for a different reason — see it below.
// An unparseable config authorizes nothing, so the policy this board publishes —
// `auto_merge` in delivery-front.json, `autoMerge` into computeFront, and the
// line printed below — is `off` whatever the defaults say.
const AUTO_MERGE = CFG_VALID && cfg.auto_merge === 'epic' && mode === 'epic-stacked';
// Drift verdicts recorded by earlier runs, minus any whose plan has since been
// re-planned (drift-record binds each verdict to the plan's content hash, so the
// park lifts by itself). Without this the front hands a stale plan back to an
// executor on every run, however many times it has already been judged.
const DRIFTED = activeDrift(ROOT);
// Parks recorded by earlier runs, minus any whose subject has since moved. The
// state we just rebuilt IS the comparison, so it is passed in rather than re-read.
//
// The RECORDS ({kind, reason}), not the flat {ticket: reason} view this file used
// to read. The two park kinds expire against different subjects and are therefore
// described by different sentences, and the flat view has already thrown the kind
// away — so a `plan_defect` park arrived here wearing the ESCALATION lifetime
// ("it lifts once the PR moves"), which is false for a verdict bound to the plan
// hash: pushing to the PR lifts nothing, and the human told otherwise waits for an
// event that cannot come. escalation-record says the bare string must not be
// rendered; this was the one caller that still did.
const ESCALATED = activeParks(ROOT, state);

const published = withLock(lockDirFor(ROOT), 'state', () => {
  // FIRST inside the lock, ahead of the journal append and every write. Nothing
  // this run holds was read under the lock — `prev`, the timestamps and every
  // `gh` observation were gathered minutes ago, because they have to be — so a
  // newer sync can have published in the meantime. Its JSON is valid, coherent
  // and NEWER, and replacing it rolls the board back: apparent status reversals,
  // duplicated transitions, ownership and reap decisions taken off facts that
  // have already been superseded (audit F13). The transitions go with it: they
  // were computed against a `prev` that is now the snapshot before last, so
  // appending them would journal changes that either already landed or never
  // happened.
  const onDisk = readMeta();
  const diskObserved = onDisk && onDisk.observed_at ? Date.parse(onDisk.observed_at) : NaN;
  const ourObserved = Date.parse(OBSERVED_AT);
  if (Number.isFinite(diskObserved) && Number.isFinite(ourObserved) && diskObserved > ourObserved) {
    return { stale: onDisk };
  }
  // One counter for the whole trio, bumped once per PUBLISHED snapshot — so
  // "state, yaml and front were written together" is a fact a reader can check
  // rather than a property of this file it has to trust.
  const generation = (onDisk && Number.isInteger(onDisk.generation) ? onDisk.generation : 0) + 1;

  if (transitions.length) {
    fs.appendFileSync(JOURNAL, transitions.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  // Computed AFTER the append, in the SAME locked section, so THIS run's own
  // newly observed status_change events (a ticket that just reached `merged`,
  // say) feed ciEstimates immediately. Reading the journal before the append
  // (the original placement) made the front's ordering lag one sync behind
  // what a fresh `front.cjs --json` would compute right after this write —
  // state, yaml and front still land in one locked section, so a concurrent
  // reader still never catches the trio half-updated. Found by Copilot's
  // review of this PR.
  const front = computeFront(tickets, state, {
    parked: RUN_PARKED, autoMerge: AUTO_MERGE, drifted: DRIFTED, escalated: ESCALATED,
    // The dispatches still in force — the tickets an agent is holding RIGHT NOW.
    //
    // Three writers produce delivery-front.json (front.cjs's CLI, dispatch-record's
    // `refreshFront`, and this file) and this one was blind to the overlay, so a
    // resync turned the board back into `execute: …/finalize: …` with
    // `waiting.dispatched: []` until the next `dispatch-record.cjs mark` happened
    // to rewrite it. The stop gate reads that file: in the window between, it
    // blocked over work already in flight — three times in one session on
    // 2026-09-07, each time after a background guard synced while six to ten
    // tickets were with agents, each time repaired by hand with `mark`. The guards
    // sync on their own schedule, so no sequencing of the main loop's own calls
    // closes that window; only this does. Expiry stays entirely
    // `activeDispatches`'s decision — nothing here decides how long one lives.
    //
    // READ INSIDE THE LOCK, and that is the whole reason it is not hoisted beside
    // DRIFTED/ESCALATED above. `mark` writes its store under the `dispatch-record`
    // lock and only THEN takes `state` to refresh the board, so a read taken
    // before we queue for `state` can miss a record whose own front write we are
    // about to overwrite: our older overlay wins and the ticket is offered again —
    // this ticket's defect, one window narrower. It is refreshFront's own rule
    // ("the READ, the COMPUTE and the WRITE all sit inside the `state` lock"),
    // which exists because reading first and locking only the write is the
    // lost-update this repo has already paid for twice.
    dispatched: activeDispatches(ROOT, state),
    // Expected CI length per ticket, a per-repo median over the LOCAL journal —
    // the front's last ordering key before the id (front.cjs). Note what does
    // NOT feed it: no per-PR `gh` field. Adding one to the bulk window is the
    // 41s-vs-7s regression this file already carries a warning about.
    ci_estimates: ciEstimates(GRAPH_DIR, tickets),
    // The epic observations THIS sync just made — `landed | not-landed | unknown`
    // per phase per repo, keyed by front.cjs's own `epicKey`. It is what makes
    // `left_behind` evidence instead of arithmetic: the board used to call a
    // ticket left behind whenever some HIGHER-NUMBERED phase had a merged ticket,
    // which said nothing about the ticket's own phase and mislabelled phase 24's
    // live chain the moment phase 26 landed three tickets (2026-09-07). This file
    // is the only one that has asked GitHub, so it is the only one that can
    // answer; a caller with no such observation gets no left-behind at all.
    epics: epicInfo,
  });
  writeAtomic(STATE, JSON.stringify(state, null, 2) + '\n');
  // The generation rides the human mirror as a comment: the yaml is keyed by
  // ticket id exactly like the JSON, so it has no more room for a metadata key
  // than the JSON does — but a person reading it can still see which snapshot
  // they are looking at.
  writeAtomic(path.join(GRAPH_DIR, 'delivery-state.yaml'), [
    yaml[0],
    `# snapshot generation ${generation} — observed ${OBSERVED_AT}`,
    ...yaml.slice(1),
  ].join('\n') + '\n');
  // `dispatches_applied_at` is stamped the way `refreshFront` stamps it, and
  // UNCONDITIONALLY — including when no dispatch is live. Its absence is the
  // signature of a writer blind to the overlay, which is exactly the defect this
  // stamp exists to make visible; making it conditional would restore that
  // ambiguity for every quiet board. Here it equals `generated_at` by
  // construction (one sync, one moment); after a `mark` it runs ahead, which is
  // why the stop gate reads `generated_at` alone for freshness and never this.
  //
  // `generation`/`observed_at` here are the ADVISORY copy — `refreshFront`
  // rebuilds this file from a fixed key list, so a `dispatch-record mark` drops
  // them and the board carries no generation until the next sync. That is fine
  // for a reader and would be fatal for the compare-and-swap above, which is why
  // that reads META and never this.
  writeAtomic(FRONT, JSON.stringify({ generated_at: nowIso, observed_at: OBSERVED_AT, generation, parked_by_run: RUN_PARKED, auto_merge: AUTO_MERGE ? 'epic' : 'off', dispatches_applied_at: nowIso, ...front }, null, 2) + '\n');
  // Written LAST, and that ordering is the publish itself: the generation on disk
  // only advances once the trio it describes is fully in place, so a sync that
  // dies mid-write leaves the previous generation standing and the next run
  // rewrites everything rather than trusting a half-published board.
  writeAtomic(META, JSON.stringify({
    generation,
    observed_at: OBSERVED_AT,
    generated_at: nowIso,
    by: 'state-sync',
    pid: process.pid,
  }, null, 2) + '\n');
  return { front, generation };
}, { label: 'state-sync' });

// A refusal is an OUTCOME, not a failure: the board on disk is the better of the
// two snapshots and the run that has it is the one driving. Exit 0 before any
// board line — printing a summary built from facts we just declined to publish is
// how a run acts on a rollback it decided against.
if (published.stale) {
  const m = published.stale;
  console.log(
    `state-sync: a newer snapshot (generation ${Number.isInteger(m.generation) ? m.generation : '?'}, ` +
    `observed ${m.observed_at}) landed while this one was reading — kept the newer one`
  );
  console.log(
    `  this run observed ${OBSERVED_AT} and wrote nothing. Nothing is lost: the newer board already ` +
    'reflects GitHub more recently than this read does. Re-run state-sync for the current front.'
  );
  process.exit(0);
}
const front = published.front;

// ── board summary on stdout for the /shipyard:deliver skill ──
function ageH(sinceIso) { return (Date.parse(nowIso) - Date.parse(sinceIso)) / 3_600_000; }
function ageLabel(sinceIso) { const h = ageH(sinceIso); return h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`; }

for (const w of cfgWarnings) console.log(`⚠ config: ${w}`);
if (epicNotice) console.log(`note: ${epicNotice}`);
for (const n of notices) console.log(`⚠ ${n}`);
console.log(`integration mode: ${mode}${mode === 'epic-stacked' ? ` (→ ${DEFAULT_BRANCH} via epic)` : ` (→ ${DEFAULT_BRANCH})`} [base from ${DEFAULT_BRANCH_SOURCE}]`);
console.log(`model policy: ${cfg.model_policy} | workflow: ${cfg.use_workflow === false ? 'forced-off' : 'auto'} | max attempts: ${cfg.max_attempts}`);
// The `⚠ config: … INVALID …` line comes from the warnings loop above (loadConfig
// composes it, so the board and every other reader quote one sentence). This line
// carries the CONSEQUENCE, and the epic-stacked note below it must not fire on an
// invalid config: `auto_merge` is then the default rather than something the file
// set, and blaming the integration mode for it would name the wrong cause.
const autoMergeNote = !CFG_VALID
  ? ' — the configuration does not parse, so no policy is in effect (fix .planning/config.json and re-sync)'
  : (cfg.auto_merge === 'epic' && !AUTO_MERGE
    ? ` — auto_merge is set but ${mode} targets the integration branch directly, so it does not apply`
    : '');
console.log(
  `sentinel: ${CFG_VALID ? cfg.sentinel : 'off'} | auto-merge: ${AUTO_MERGE ? `epic (ticket PRs → their base; ${DEFAULT_BRANCH} stays a human merge)` : 'off (every merge is a human action)'}` +
  autoMergeNote
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
      : (info.exists && info.ahead !== 0 ? 'no epic PR yet' : 'not started');
    // Never print a count that was not measured: `${info.ahead} ahead of main`
    // rendered an unobserved state as "null ahead of", which reads to a person
    // exactly like "nothing left to land" — the same collapse the tri-state above
    // exists to undo, one layer up.
    const aheadPart = !info.exists
      ? 'not created'
      : (info.ahead === null
        ? `integration state unknown (${info.landed_reason}) — cross-phase dependents parked, retried next sync`
        : `${info.ahead} ahead of ${info.base}`);
    console.log(`epic phase ${info.phase}${where}: ${info.branch} — ${aheadPart}, ${prPart}`);
    if (info.exists && info.ahead !== null && info.ahead > 0 && !info.pr) {
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
    console.log(`⚠ ${id} PR #${s.pr}: no CI checks reported — "green" here means "nothing to run", confirm that is expected`);
  }
  // The fourth state gets its OWN line, and the two must not share one: this
  // warning used to be the no-CI one with `(${note})` appended, which told a
  // reader that a 503 meant "nothing to run" and asked them to confirm it.
  // Nobody confirms a reading that did not happen — the note names the cause and
  // the next sync looks again, so the line says that instead.
  if (s.checks && s.checks.unavailable) {
    console.log(`⚠ ${id} PR #${s.pr}: check state UNREADABLE this sync (${s.checks.note || 'gh pr checks did not answer'}) — not "no checks" and not green; the next sync reads again`);
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
console.log(
  `wrote .planning/graph/delivery-state.json, delivery-state.yaml, delivery-front.json ` +
  `and delivery-state-meta.json (snapshot generation ${published.generation})`
);
