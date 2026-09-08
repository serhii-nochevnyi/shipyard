#!/usr/bin/env node
'use strict';

// The PR SENTINEL's deterministic core — the "вартовий" that stays behind on the
// open PRs while the main delivery loop cascades on to the next tickets.
//
//   sentinel.cjs duty   [--json] [--parked a,b] [--scope a,b]
//   sentinel.cjs merge  <ticket|--all> [--dry-run] [--json]
//   sentinel.cjs report [--json] [--parked a,b] [--since <iso>]
//
// WHY THIS IS CODE AND NOT PROSE. Two things kept going wrong once delivery was
// allowed to move on while PRs were still red:
//
//   1. Nobody owned the tail. The main loop left a PR in `waiting: ci` and, with
//      the front empty, declared a fixpoint — green, approved, unmerged PRs sat
//      there and the epic branch stayed empty. `duty` names the owner of every
//      open PR and prints `sentinel: clear|NOT clear`, which is the sentinel's
//      own stop condition (front.cjs is the run's).
//   2. "Merge it into the epic" is a mechanical decision that an agent must not
//      be trusted to improvise. `merge` re-checks the gate against LIVE GitHub
//      (not the cached snapshot) and refuses on anything unproven — and it can
//      only ever merge into the STACK (the phase epic or a parent ticket
//      branch). Landing on the integration branch stays a human's call, always.
//
// Ticket PRs merge with --squash and the branch is NOT deleted here: the reaper
// owns deletion and only acts on `reapable`, because a cascade child may still
// be based on that branch.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
const { withLock, lockDirFor } = require(path.join(__dirname, 'lock.cjs'));
const { classify, CHECK_FIELDS } = require(path.join(__dirname, 'check-state.cjs'));
// The checkpoint predicates live in front.cjs and are imported, not copied.
// A `checkpointParentOf` used to exist here AND there, and the standing rule — the
// board must never offer what the guard refuses — was held by nothing but the
// two texts happening to match. front.cjs is the home because it is pure and
// importable; this file parses argv and can exit at load, so the dependency
// only runs in one direction. (Its CLI is behind `require.main`, so requiring
// it here executes nothing.)
// …and `noCiHold`/`NO_CI_WHY` for the same reason again: "a PR where nothing ran
// is not a green PR" withholds `merge` HERE and its bucket THERE, so the two
// must read one predicate and quote one sentence or the board offers what the
// guard refuses.
// …and `reviewStandsAlone`/`baseMoved` for the third and fourth time: a
// CHANGES_REQUESTED with no thread left is a PERSON's here and `waiting.human`
// there, and a base that has MOVED is `base-merge` here and a `fix` entry there.
// Both were rules the two files could only have held by their texts happening to
// match, which is the way they have already failed twice.
const {
  needsHuman, checkpointParentOf: checkpointParentIn, noCiHold, NO_CI_WHY,
  reviewStandsAlone, REVIEW_STANDS_WHY, baseMoved, baseMergeWhy,
} = require(path.join(__dirname, 'front.cjs'));
// …and the second shared predicate, in its own module for the same reason: this
// file used to own it outright, so `computeFront` had no `waiting.parent` bucket
// and offered the tickets the guard was refusing. It lives next door rather than
// in front.cjs because front.cjs imports it too, and one direction is the whole
// property. The binding is below, where PARKED exists.
const { parentIsMoving: parentIsMovingIn } = require(path.join(__dirname, 'parent-moving.cjs'));

const ROOT = process.cwd();
const GRAPH_DIR = path.join(ROOT, '.planning', 'graph');
const TICKETS = path.join(GRAPH_DIR, 'tickets.json');
const STATE = path.join(GRAPH_DIR, 'delivery-state.json');
const JOURNAL = path.join(GRAPH_DIR, 'delivery-log.jsonl');

function fail(msg, code = 1) {
  console.error(`sentinel: ${msg}`);
  process.exit(code);
}

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const asJson = argv.includes('--json');
const dryRun = argv.includes('--dry-run');
const listFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? [] : String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
};
const valueFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] || null;
};

if (!['duty', 'merge', 'report'].includes(cmd)) {
  console.error('usage: sentinel.cjs <duty|merge <ticket|--all>|report> [--json] [--dry-run] [--parked a,b] [--scope a,b] [--since <iso>]');
  process.exit(2);
}

// ── inputs ──────────────────────────────────────────────────────────────────
function readJson(file, what) {
  if (!fs.existsSync(file)) fail(`missing ${path.relative(ROOT, file)} — run state-sync.cjs first (${what})`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`${path.relative(ROOT, file)} is not valid JSON (${e.message})`);
  }
}

const graph = readJson(TICKETS, 'the ticket graph');
const tickets = graph.tickets || {};
const state = readJson(STATE, 'the delivery state');
const { config: cfg } = loadConfig(ROOT);

// auto_merge is only meaningful in epic-stacked: in direct-to-main a ticket PR
// targets the integration branch itself, and that merge is a human's.
const AUTO_MERGE = cfg.auto_merge === 'epic' && cfg.integration_mode === 'epic-stacked';
const AUTO_MERGE_WHY = cfg.auto_merge !== 'epic'
  ? 'pipeline.auto_merge is off'
  : cfg.integration_mode !== 'epic-stacked'
    ? `integration_mode is ${cfg.integration_mode} — ticket PRs target the integration branch, which only a human merges`
    : null;

// ── gh plumbing ─────────────────────────────────────────────────────────────
function gh(args, { tolerate = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim().split('\n')[0] : e.message;
    if (tolerate) return { error: detail };
    fail(`gh ${args.slice(0, 4).join(' ')} failed: ${detail}`);
  }
}
const repoArg = (repo) => (repo ? ['--repo', repo] : []);
// The repo-qualified REST prefix, in state-sync.cjs's spelling rather than a
// second one. `gh api` does NOT accept `--repo`, and its `{owner}/{repo}`
// placeholders resolve from the CURRENT repository — so a foreign-repo call
// built with `repoArg` measured the wrong repository or simply errored. Every
// `gh api <path>` in this file goes through here.
const apiBase = (repo) => (repo ? `repos/${repo}` : 'repos/{owner}/{repo}');

// `gh pr checks` reports CI state through its EXIT CODE while still printing the
// JSON (8 = pending, 1 = failing or no checks at all) — see state-sync.cjs.
// Commits on <base> that <head> does not have yet — i.e. how stale this branch is.
// The mirror of epic-branch.sh's `ahead_by`, in the other direction.
//
// WHY WE ASK OURSELVES instead of trusting mergeStateStatus: GitHub only reports
// BEHIND when branch protection requires branches to be up to date. Without that
// setting a stale-but-conflict-free branch reports CLEAN, so a gate that only
// reads mergeStateStatus is silent exactly where the repo has not been hardened.
// One extra call, on the merge path only — merges are rare next to the per-round
// syncing, so this does not touch the conveyor's tick rate.
//
// TWO defects lived in one line here (external audit 2026-09-07, F06). The
// endpoint named `{owner}/{repo}` and the repo was passed as `--repo`, which
// `gh api` does not accept: the call errored for every foreign-repo ticket, and
// the `null` it returned was read by the gate as "not behind". So the answer is
// now a RESULT — `{behind}` or `{error}` — and the caller refuses on the error
// rather than treating an unknown as a pass. `apiBase` is the same spelling
// `epic-branch.sh`'s mirror-image `ahead_by` compare uses.
function behindBy(base, head, repo) {
  const out = gh(['api', `${apiBase(repo)}/compare/${head}...${base}`, '--jq', '.ahead_by'], { tolerate: true });
  if (typeof out !== 'string') return { error: (out && out.error) || 'gh api compare failed' };
  const n = parseInt(out.trim(), 10);
  if (!Number.isFinite(n)) return { error: `gh api compare answered "${out.trim().slice(0, 80)}", not a commit count` };
  return { behind: n };
}

// The vocabulary is check-state.cjs's, not this file's: the local list named
// FAILURE/ERROR/CANCELLED/TIMED_OUT and PENDING/QUEUED/IN_PROGRESS/EXPECTED, so
// every other state gh reports — ACTION_REQUIRED and STARTUP_FAILURE among them —
// fell through both filters and the gate below read `0 failing, 0 pending` and
// MERGED. The returned shape is unchanged; only who decides is.
//
// A `gh` invocation that FAILED (non-zero exit with nothing parseable on
// stdout — an old `gh` rejecting `bucket`, a 503, a rate limit, a missing
// binary) is not the same fact as "this PR genuinely has no checks configured",
// and must not collapse into it: that collapse is what let a startup failure
// read as green above. ANY stdout that parses to an array is authoritative and
// used as-is, EMPTY OR NOT and regardless of exit status — a non-zero exit
// with valid JSON is normal (the docstring above: exit code is data, not an
// error). Only when there is nothing parseable to trust does exit status
// decide: exit 0 with empty output means "no checks"; anything else unreadable
// hands `rows: null` to `classify`, which reports it as the FOURTH state,
// `unavailable`.
//
// It used to hand over a synthetic `[{ bucket: 'unreadable' }]` row to borrow
// `classify`'s fail-closed `pending`. That waited for the right reason and said
// the wrong thing — "1 check(s) still running" about a check nobody ever saw,
// on the guard's own live read — and it kept the fact in two places at once:
// the row here and the flag there. The flag is the fact.
//
// The returned shape stays a TALLY, because that is what every caller in this
// file reads (`checks.failing`, `heldForNoCi(checks)`, `c.pending`); it simply
// carries `unavailable` and the `note` now. state-sync's `ghChecks` returns rows
// instead — same distinction, different side of `classify`.
function ghChecks(pr, repo) {
  const r = spawnSync('gh', ['pr', 'checks', String(pr), ...repoArg(repo), '--json', CHECK_FIELDS], { encoding: 'utf8' });
  const stdout = (r.stdout || '').trim();
  let rows = null;
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) rows = parsed;
    } catch { /* fall through to the unreadable branch below */ }
  } else if (r.status === 0) {
    rows = []; // gh succeeded and reported nothing — genuinely no checks
  }
  // `null` travels straight through: `classify` is the one place that decides
  // what the shape of the answer means, and it answers `unavailable: true`.
  const c = classify(rows);
  const out = { failing: c.failing, pending: c.pending, total: c.total, none_reported: c.none_reported, unavailable: c.unavailable };
  if (c.unavailable) {
    // The cause, for the duty's why and the merge refusal. A spawn failure has
    // no stderr and a `null` status ("exited null" names nothing), so the spawn
    // error is read before that fallback.
    out.note = (r.stderr || '').trim().split('\n').filter(Boolean)[0]
      || (r.error ? r.error.message : '')
      || `gh pr checks exited ${r.status}`;
  }
  return out;
}

const defaultBranchCache = new Map();
function integrationBranchOf(repo) {
  if (defaultBranchCache.has(repo || '')) return defaultBranchCache.get(repo || '');
  let name;
  if (!repo && cfg.gsd.base_branch) {
    name = cfg.gsd.base_branch;
  } else {
    const out = gh(['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { tolerate: true });
    name = typeof out === 'string' && out.trim() ? out.trim() : 'main';
  }
  defaultBranchCache.set(repo || '', name);
  return name;
}

// The arch-review verdict is recorded as a `gate_status:` trailer in the PR body
// (it survives a squash merge). state-sync parses it into state[id].gate and the
// head it was rendered against into state[id].head_sha; the merge path re-reads
// BOTH from the LIVE PR below, because merge must not trust a cache.
//
// The parser, the four-state classification and its words are imported from the
// trailer's own module rather than copied: this file and front.cjs must agree on
// whether a verdict counts, or the board offers what the guard refuses.
const { parseGate, gateKind, gateConform, gateWhy } = require(path.join(__dirname, 'gate-trailer.cjs'));

function journal(rec) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
  withLock(lockDirFor(ROOT), 'state', () => {
    fs.appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  }, { label: 'sentinel journal' });
}

// ── duty: who owns each open PR right now ───────────────────────────────────
// The `--parked` flag alone is not the parked set. The front also parks on the
// durable records (escalations, drift verdicts), and the guard runs CONCURRENTLY
// with the main loop off the same state — so reading a narrower set here means
// the guard keeps dispatching review-fix at exactly the PRs the front has set
// aside. The two must agree on what is parked or the concurrency is a race with
// a human in it.
// The park RECORDS, not the flat {ticket: reason} view: PARKED_WHY's sentence is
// chosen by the park's KIND, and the flat view keeps the kind only as a prefix on
// a reason a human typed — which a human can type by hand.
const { activeParks, escalationWhy } = require(path.join(__dirname, 'escalation-record.cjs'));
const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
const ESCALATED = activeParks(ROOT);
const DRIFTED = activeDrift(ROOT);
const PARKED = new Set([...listFlag('parked'), ...Object.keys(ESCALATED), ...Object.keys(DRIFTED)]);
// A recorded park carries a reason; the flag does not. Report the reason where
// there is one — "parked" alone is what sent the last run looking through the
// journal by hand.
const PARKED_WHY = {};
// The escalation wording is the store's, not the guard's — see escalationWhy.
// This site used to compose its own parenthetical, and once a second kind
// existed it described a plan defect with the older kind's lifting rule, in a
// sentence the board rendered differently again. Two texts for one fact is what
// let them drift; the guard and the board now quote the same one, off the same
// record.
for (const [id, park] of Object.entries(ESCALATED)) PARKED_WHY[id] = escalationWhy(id, park);
for (const [id, r] of Object.entries(DRIFTED)) PARKED_WHY[id] = `drifted — ${r} (re-plan it; the park lifts when the plan changes)`;
const SCOPE = listFlag('scope');

// Everything `reviewers.cjs unresolved` knows about one PR, or nulls where it
// could not be read. Cached: the duty pass and a later merge check ask about the
// same PRs, and the GraphQL call is the expensive part of both.
//
// It carries THREE facts now, and that is why it is one call and not two: the
// thread count, the review decision, and the PR's merge state (`mergeStateStatus`
// plus the base/head names), which reviewers.cjs reads off the same `gh pr view`
// it already makes for the decision. `duty` runs on every babysit round, so a
// second per-PR query here would be paid on every tick of the conveyor.
//
// An unreadable answer stays ALL NULL rather than collapsing into a benign one:
// "no threads", "no verdict" and "the base is fine" are three claims, and none of
// them is what a failed call proves.
const settlementCache = new Map();
function settlement(pr, repo) {
  const key = `${repo || ''}#${pr}`;
  if (settlementCache.has(key)) return settlementCache.get(key);
  const out = spawnSync('node', [path.join(__dirname, 'reviewers.cjs'), 'unresolved', String(pr), ...repoArg(repo)], { encoding: 'utf8' });
  let v = { unresolved: null, review_decision: null, merge_state: null, base: null, head: null };
  if (out.status === 0) {
    try {
      const j = JSON.parse(out.stdout);
      v = {
        unresolved: typeof j.unresolved_count === 'number' ? j.unresolved_count : null,
        review_decision: j.review_decision || null,
        merge_state: j.merge_state || null,
        base: j.base || null,
        head: j.head || null,
      };
    } catch { /* keep the all-null answer */ }
  }
  settlementCache.set(key, v);
  return v;
}

// "Has the base moved under this branch?" — the guard's reading of the same two
// signals the merge gate reads, so `duty` stops offering a merge that gate is
// about to refuse and names the remedy instead of describing it.
//
// The merge state rides on `settlement` above and costs nothing. The compare is
// one extra `gh api` for each PR that gets this far, and it is required rather
// than optional: GitHub reports BEHIND only where branch protection requires
// up-to-date branches, so without the second opinion the duty is silent exactly
// where the repo has not been hardened — and the merge path, which does ask,
// then refuses what the duty offered. It is not paid for a parked PR, a child
// behind a moving parent, or a red one: the chain below never reaches here for
// those.
//
// An UNKNOWN answer is never "not behind" (the defect T-24-05 fixed one level
// up): it reports `known: false`, the chain falls through unchanged, and the
// merge gate still refuses rather than guessing.
function baseCheck(s, repo) {
  const st = settlement(s.pr, repo);
  if (st.merge_state === 'DIRTY' || st.merge_state === 'BEHIND') {
    return { moved: baseMoved({ merge_state: st.merge_state }), known: true };
  }
  const base = st.base || s.pr_base || s.base || null;
  const head = st.head || s.branch || null;
  if (!st.merge_state || !base || !head) return { moved: null, known: false };
  const cmp = behindBy(base, head, repo);
  if (typeof cmp.behind !== 'number') return { moved: null, known: false };
  return { moved: baseMoved({ merge_state: st.merge_state, behind_by: cmp.behind }), known: true };
}

// How many unmerged tickets this one is stacked on. 0 = its PR targets the epic
// (a root); 1 = its base is a parent branch still open; and so on. The graph
// already carries `primary_parent`; nothing used it to decide what to work on.
function stackDepth(id, seen = new Set()) {
  const parent = (tickets[id] || {}).primary_parent;
  if (!parent || seen.has(id)) return 0;
  seen.add(id);
  const ps = state[parent] || {};
  if (ps.status === 'merged') return stackDepth(parent, seen); // landed: no longer above us
  return 1 + stackDepth(parent, seen);
}

// The two parent rules, bound to this process's graph. Neither rule is this
// file's any more — one predicate, two callers — so the duty chain, the merge
// gate and the board cannot disagree about which children are landable or which
// are still waiting. `checkpointParentOf` is front.cjs's; `parentIsMoving` is
// parent-moving.cjs's, including its checkpoint exception (a child is deferred
// while its parent PR is still being DRIVEN, but never behind a parent that is
// waiting on a PERSON, or the whole subtree freezes for as long as the human
// takes) and its PARKED clause, which is why the binding sits here rather than
// beside the import.
const checkpointParentOf = (id) => checkpointParentIn(id, tickets, state);
const parentIsMoving = (id) => parentIsMovingIn(id, { tickets, state, parked: PARKED });
// The third shared predicate, bound to THIS process's config: a PR with no
// reported checks is not one the guard may walk towards landing. Same function
// as the board's, so `merge` and the `merge` bucket cannot disagree.
const heldForNoCi = (checks) => noCiHold(checks, { autoMerge: AUTO_MERGE, mergeWithoutCi: cfg.merge_without_ci });

function dutyItems() {
  const items = [];
  for (const [id, s] of Object.entries(state)) {
    if (s.status !== 'pr-open') continue;
    if (SCOPE.length && !SCOPE.includes(id)) continue;
    const t = tickets[id] || {};
    const c = s.checks || {};
    const base = s.pr_base || s.base || null;
    const item = {
      ticket: id,
      pr: s.pr,
      repo: s.repo || null,
      branch: s.branch,
      base,
      epic: s.epic || null,
      worktree_hint: id,
      depth: stackDepth(id),
      action: 'none',
      why: '',
    };

    item.depth = stackDepth(id);

    if (PARKED.has(id)) {
      item.action = 'parked';
      item.why = PARKED_WHY[id]
        || 'parked by this run (escalation or attempts exhausted) — a human unparks it';
    } else if (parentIsMoving(id)) {
      // Drive the PARENT first. Anything done here is provisional: when the
      // parent lands, this branch's base moves, CI re-runs against different
      // code and reviewers re-read a changed diff — so a green reached now is a
      // green that has to be reached again. Ordering the stack is not tidiness,
      // it is the difference between paying for CI once and paying twice.
      item.action = 'wait-parent';
      item.why = `stacked on ${tickets[id].primary_parent}, whose PR is still open — driving this one to green now buys a green that the base move will undo`;
    } else if ((c.failing || 0) > 0) {
      item.action = 'ci-fix';
      item.why = `${c.failing} failing check(s) — read the failure log, fix in the worktree, push, reinit reviewers`;
    } else {
    // Threads are read here, BEFORE the pending-CI branch, and only when nothing
    // is failing (a red PR is ci-fix's regardless, and the fetch is a GraphQL
    // call we should not spend to learn that).
    //
    // Why threads outrank a running CI: reviewers answer in a minute, CI takes
    // tens of them, and servicing a thread that needs a code change ends in a
    // push that cancels the very run we would have waited for. Waiting first
    // buys two CI cycles where one would do, and the first one validates code
    // nobody intends to keep. The same reasoning already puts `ci-fix` ahead of
    // pending checks; it was simply never applied to review feedback.
    //
    // Unreadable threads do NOT become "no threads": that would silently skip
    // review servicing on an API hiccup and walk into the merge gate's refusal
    // later. They fall through to the normal ordering, and the merge gate still
    // refuses to merge blind.
    const unresolved = settlement(s.pr, s.repo || null).unresolved;
    // …and the base, read from the same call plus one compare. Recorded on the
    // item whatever the answer is, so a reader can tell "the base was checked and
    // is fine" from "nobody could check it" — the two used to look identical, and
    // one of them is the state the merge gate refuses.
    const bc = baseCheck(s, s.repo || null);
    item.base_check = bc.moved ? 'stale' : bc.known ? 'clean' : 'unknown';
    if (bc.moved) {
      // FIRST inside this block, ahead of threads and of pending CI. Everything
      // else here measures the branch against a merge base that no longer exists:
      // a thread serviced now is answered against the wrong diff, and a run we
      // wait for is validating code that is about to change anyway. It sits AFTER
      // `ci-fix` for the mirror-image reason — a failing check is the louder fact,
      // and that fixer is told to merge the base in as its own step 0.
      item.action = 'base-merge';
      if (bc.moved.behind !== null) item.behind_by = bc.moved.behind;
      item.why = baseMergeWhy(bc.moved, base);
    } else if (typeof unresolved === 'number' && unresolved > 0) {
      item.action = 'review-fix';
      item.unresolved = unresolved;
      item.why = `${unresolved} unresolved review thread(s)${(c.pending || 0) > 0 ? ` (CI still running — service them NOW: a fix pushes anyway and restarts that run)` : ''} — fix or reply with reasoning, then RESOLVE each one`;
    } else if (c.unavailable) {
      // The board could not READ this PR's check state (a 503, a rate limit, an
      // old `gh` rejecting `bucket`). Not "no checks", not "one check pending" —
      // `wait-ci` because looking again is the whole remedy, and the note says
      // what stopped the reading. Withholding only the landing actions, in the
      // same position `front.cjs` puts this bucket: base-merge and review-fix
      // above are real work that no `pr checks` failure says anything about, and
      // the permanent case (an old `gh`) would freeze them for the whole run.
      item.action = 'wait-ci';
      item.why = `check state unreadable: ${c.note || 'gh pr checks did not answer'} — not "no checks" and not green; `
        + 'the next state-sync reads again. Nothing to fix and nobody to ask.';
    } else if ((c.pending || 0) > 0) {
      item.action = 'wait-ci';
      item.why = `${c.pending} check(s) still running${unresolved === null ? ' — review threads unreadable this tick' : ''} — re-tick, do not block the main loop`;
    } else if (s.draft && !gateConform(s.gate, s.head_sha)) {
      // Certify BEFORE readying. Bundled together as one `finalize` these two
      // could not report separately, so a `violation` verdict and a clean one
      // ended the same way, and the action name itself was not a role the model
      // ladder knows — it got logged as one anyway.
      item.action = 'arch-review';
      // A verdict recorded for another head is not a missing verdict, and saying
      // "no trailer" about a body that visibly has one sends the agent looking
      // for the wrong thing. The remedies differ, so the sentences do.
      item.why = gateKind(s.gate, s.head_sha) === 'unrecorded'
        ? 'green draft, no `gate_status: arch-review=conform` trailer — judge the diff against the ADRs and record the verdict'
        : `green draft, ${gateWhy(s.gate, s.head_sha)} — judge THIS head against the ADRs and record the verdict again`;
    } else if (s.draft && heldForNoCi(c)) {
      // Certified, and the only thing left is the readying — which is the step
      // that hands the PR to this guard's own merge. Nothing ran on this branch,
      // so that step is withheld and the PR stays a draft, which is what a draft
      // says. The board answers `waiting.merge_human` for the same state.
      item.action = 'human-merge';
      item.why = `${NO_CI_WHY} Left as a draft — readying it is the step that hands it to the guard's own merge.`;
    } else if (s.draft) {
      item.action = 'undraft';
      item.why = 'green + conform, still a draft — ready it (`gh pr ready`); nothing else is owed';
    } else if (needsHuman(t)) {
      // Only an UNANSWERED checkpoint is the human's. A pre-authorized one
      // (ADR-001 D6) falls through to the ordinary chain below: the person
      // supplied that judgement while approving the ticket set, so what is left
      // is the run's. Nothing else is relaxed for it — the conform trailer, the
      // review threads and the stacked base are all still ahead.
      item.action = 'human';
      item.why = 'human_checkpoint — the approval and the merge are the human\'s';
    } else if (reviewStandsAlone(s.review_decision, unresolved)) {
      // A verdict with nothing left to service. review-fix was dispatched at it
      // regardless of the thread count, came back having done nothing, and the
      // repeated signature escalated the ticket after the attempt budget — paid
      // work re-deciding a state only a reviewer can move. NOT in ACTIONABLE:
      // the board answers `waiting.human` for the same PR.
      item.action = 'wait-human';
      item.why = REVIEW_STANDS_WHY;
    } else if (s.review_decision === 'CHANGES_REQUESTED') {
      // Reached only with an UNKNOWN thread count (a real 0 is the branch above,
      // and >0 was handled at the top of this block). Fail towards the work: the
      // fixer reads the threads itself, and an API hiccup must not park a PR on a
      // person.
      item.action = 'review-fix';
      item.why = 'CHANGES_REQUESTED, and the thread count could not be read this tick — '
        + 'read them yourself and service them (a bot can be wrong: a reasoned reply is a valid resolution)';
    } else if (!gateConform(s.gate, s.head_sha)) {
      item.action = 'arch-review';
      item.why = gateKind(s.gate, s.head_sha) === 'unrecorded'
        ? 'green and out of draft, but no `gate_status: arch-review=conform` trailer — the architecture verdict was never recorded'
        : `green and out of draft, but ${gateWhy(s.gate, s.head_sha)} — the recorded verdict does not cover what is on the branch; judge THIS head and record it again`;
    } else if (AUTO_MERGE && s.merge_scope === 'stacked' && checkpointParentOf(id)) {
      // Ready in every respect, and still not ours to land: the base is an open
      // human_checkpoint parent. `merge` would be refused by the gate anyway —
      // this exists so the duty says the true reason instead of routing it to
      // `human-merge`, whose text ("awaiting merge") hides which human and why.
      // The hold is the same for a PRE-AUTHORIZED parent — pre-authorization
      // covers that parent's own merge, never a merge INTO it — but who is being
      // waited for is not, and the remedies differ, so the reason says which.
      const cpParent = checkpointParentOf(id);
      item.action = 'wait-parent';
      item.why = needsHuman(tickets[cpParent])
        ? `green + conform, but its base is ${cpParent} — a human_checkpoint PR still open. `
          + 'Landing now would rewrite the diff that person is reading; it merges once they land theirs.'
        : `green + conform, but its base is ${cpParent} — a pre-authorized human_checkpoint PR still open. `
          + 'Nobody is reading it, but it lands first; this one follows once it does.';
    } else if (AUTO_MERGE && s.merge_scope === 'stacked' && heldForNoCi(c)) {
      // Ready in every other respect, and nothing verified it. `mergeOne` refuses
      // this against LIVE GitHub; the duty says so first, so the guard is not
      // handed an action its own gate will decline.
      item.action = 'human-merge';
      item.why = NO_CI_WHY;
    } else if (AUTO_MERGE && s.merge_scope === 'stacked') {
      item.action = 'merge';
      item.why = `green + conform → squash into ${base}`;
    } else {
      item.action = 'human-merge';
      item.why = AUTO_MERGE
        ? `PR targets ${base} (the integration branch) — only a human merges that`
        : `green and conform — awaiting merge (${AUTO_MERGE_WHY})`;
    }

    }

    // AFTER the whole chain, because ci-fix is assigned in the OUTER branch and
    // review-fix in the inner one — placed inside either, the other misses it.
    // A push to an APPROVED PR dismisses the approval — silently, from the
    // human's point of view: they approved one diff and woke up un-approving
    // another. The fix still has to be pushed (a red check or an open thread on
    // an approved PR is real work), so this is not a refusal; it is the duty
    // carrying the fact, so the fixer says so in the PR comment instead of the
    // human discovering it. Field-observed: a conveyor push over an approval
    // cost an apology and a re-review round.
    if ((item.action === 'ci-fix' || item.action === 'review-fix') && s.review_decision === 'APPROVED') {
      item.dismisses_approval = true;
      item.why += ' — NOTE: this PR is APPROVED, and your push will dismiss that approval; say so explicitly in the PR comment so the reviewer knows why they are re-approving';
    }
    if (c.none_reported) item.checks_note = 'no CI checks reported — "green" here means "nothing ran"';
    items.push(item);
  }
  // SHALLOWEST FIRST. The guard serves the list in order, so a root whose base is
  // the epic is reached before anything stacked on it — which is the whole point
  // of `wait-parent` above: the order and the deferral say the same thing twice,
  // once for a caller that reads the actions and once for a caller that just
  // takes the first item.
  return items.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || String(a.ticket).localeCompare(String(b.ticket)));
}

// Every actionable name here is either a role the model ladder knows
// (`ci-fix`, `review-fix`, `arch-review`) or a mechanical step the guard does
// itself (`undraft` — one `gh pr ready`, no agent, no model). The old catch-all
// `finalize` was neither, which is how it ended up in the journal as a role
// `model <role>` declines to route.
//
// `base-merge` is the mechanical kind: `base-merge.cjs` does the work and the
// only judgement left is a conflict inside the ticket's own declared files, so a
// fixer dispatched for it runs at the `ci-fix` tier (that IS the role to pass to
// `model <role>` and to record on an attempt — `base-merge` is an action, never a
// role). It journals itself as `base_merge`, which is deliberately not an
// `attempt`: charging a mechanical merge to a ticket's repair record would spend
// its attempt budget on work no hypothesis was ever wrong about.
const ACTIONABLE = new Set(['ci-fix', 'review-fix', 'arch-review', 'undraft', 'merge', 'base-merge']);

function dutySummary() {
  const items = dutyItems();
  const actionable = items.filter((i) => ACTIONABLE.has(i.action));
  const waiting = items.filter((i) => i.action === 'wait-ci');
  // `wait-human` joins them: a standing CHANGES_REQUESTED nobody can service is
  // a PR waiting on a person exactly as a checkpoint is, and counting it as
  // anything else would report it as either work or a fixpoint.
  const human = items.filter((i) => i.action === 'human' || i.action === 'human-merge' || i.action === 'wait-human');
  const parked = items.filter((i) => i.action === 'parked');
  return {
    auto_merge: AUTO_MERGE ? 'epic' : 'off',
    auto_merge_note: AUTO_MERGE ? null : AUTO_MERGE_WHY,
    guarded: items.length,
    items,
    actionable_count: actionable.length,
    waiting_count: waiting.length,
    human_count: human.length,
    parked_count: parked.length,
    // The sentinel's own stop condition: nothing to do AND nothing still moving.
    // A PR waiting on CI is NOT clear — the guard has to come back to it.
    clear: actionable.length === 0 && waiting.length === 0,
  };
}

function formatDuty(d) {
  const lines = [`sentinel duty: ${d.guarded} PR(s) under guard | auto-merge: ${d.auto_merge}${d.auto_merge_note ? ` (${d.auto_merge_note})` : ''}`];
  for (const i of d.items) {
    const where = i.repo ? `@${i.repo}` : '';
    lines.push(`  ${i.action.padEnd(11)} ${i.ticket}${where} PR #${i.pr} — ${i.why}`);
    if (i.checks_note) lines.push(`    ⚠ ${i.checks_note}`);
  }
  lines.push(d.clear
    ? `sentinel: clear — nothing to drive${d.human_count ? `; ${d.human_count} PR(s) wait on a human` : ''}`
    : `sentinel: NOT clear — ${d.actionable_count} actionable now, ${d.waiting_count} waiting on CI. Keep guarding.`);
  return lines;
}

if (cmd === 'duty') {
  const d = dutySummary();
  if (asJson) process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  else for (const line of formatDuty(d)) console.log(line);
  process.exit(0);
}

// ── merge: the guarded ticket-PR → stack merge ──────────────────────────────
// Everything here is re-verified against live GitHub. The cached snapshot is
// minutes old, and "it was green last tick" is exactly the reasoning that lands
// a red commit on the epic.
function mergeOne(id) {
  const s = state[id];
  const t = tickets[id] || {};
  const res = { ticket: id, pr: s ? s.pr : null, merged: false, dry_run: dryRun, blockers: [], retargeted: [] };
  const block = (why) => { res.blockers.push(why); return res; };

  if (!s) return block('unknown ticket (not in delivery-state.json)');
  if (!AUTO_MERGE) return block(`auto-merge refused: ${AUTO_MERGE_WHY}`);
  if (s.status !== 'pr-open') return block(`status is ${s.status}, not pr-open`);
  if (!s.pr) return block('no PR recorded for the ticket');
  if (needsHuman(t)) return block('human_checkpoint ticket — the merge is the human\'s by contract');
  // WHY this checkpoint was passable, recorded on the result and, below, on the
  // journal line. Design-time authorization is only defensible if it is auditable
  // afterwards: without this the board cannot tell "a human approved this in
  // advance" from "the guard merged a checkpoint it should have refused".
  // Set here rather than at the merge call so a `--dry-run` reports it too.
  if (t.human_checkpoint && t.preauthorized === true) res.preauthorized = true;

  const repo = s.repo || null;
  const view = gh(['pr', 'view', String(s.pr), ...repoArg(repo), '--json',
    'number,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,reviewDecision,body'], { tolerate: true });
  if (typeof view !== 'string') return block(`gh pr view failed: ${view.error}`);
  let pr;
  try { pr = JSON.parse(view); } catch (e) { return block(`gh pr view returned unparseable JSON (${e.message})`); }

  res.base = pr.baseRefName;
  if (pr.state !== 'OPEN') return block(`PR is ${pr.state}, not OPEN`);
  if (pr.isDraft) return block('PR is still a draft — the conform gate has not been passed');

  // The stack boundary. A ticket PR may only land on the phase epic or on a
  // parent ticket's branch, both inside its own repo AND inside its own PHASE.
  // Anything else — above all the integration branch — is out of the sentinel's
  // mandate.
  //
  // The set used to be every ticket branch in the repository, from every phase.
  // A `pr_base` naming another phase's branch — hand-edited, or read off a stale
  // graph by a resumed run — passed this check and would have been squashed
  // there, into an epic quarantining different work. A phase is the unit the
  // epic quarantines, so it is the unit the boundary measures. A graph whose
  // tickets carry no `phase` at all is unaffected: they then all share the same
  // (absent) phase, which is the pre-existing behaviour.
  const integration = integrationBranchOf(repo);
  const phaseOf = (o) => (o && o.phase !== undefined && o.phase !== null ? String(o.phase) : null);
  const myPhase = phaseOf(t);
  const samePhaseTicketBranches = Object.entries(tickets)
    .filter(([, o]) => (o.repo || null) === repo && phaseOf(o) === myPhase)
    .map(([, o]) => o.branch);
  const allowed = new Set([s.epic, t.epic, ...samePhaseTicketBranches].filter(Boolean));
  if (pr.baseRefName === integration) {
    return block(`PR targets the integration branch ${integration} — landing a phase there is a human's decision, never the sentinel's`);
  }
  if (!allowed.has(pr.baseRefName)) {
    return block(
      `PR base "${pr.baseRefName}" is neither the phase epic nor a ticket branch of this ticket's own phase` +
      `${myPhase ? ` (${myPhase})` : ''} in this repo — refusing to merge outside the stack`
    );
  }

  // The base may be inside the stack and STILL be a branch nobody may land on
  // yet: a parent whose ticket is a human_checkpoint and whose PR is still open.
  // Line 393 above refuses a checkpoint ticket's OWN merge; it says nothing about
  // merging INTO one, and that gap cost three of five escalations in a single
  // phase — the runs caught it themselves and held the merge by hand, citing this
  // exact check. Two things go wrong if the squash happens:
  //   * it folds the child's diff into the one a person is actively reading;
  //   * the post-merge retarget below sends that child's own children to the
  //     EPIC, which is incoherent with content sitting in a checkpoint branch.
  // Deliberately scoped to an OPEN parent: once the human lands it, the child
  // proceeds, which is exactly the unblock procedure those escalations described.
  // `parentIsMoving` is untouched on purpose — the checkpoint exception there is
  // right for driving a child to GREEN and wrong only for merging it.
  const baseTicket = Object.entries(tickets).find(
    ([, o]) => (o.repo || null) === repo && o.branch === pr.baseRefName
  );
  if (baseTicket) {
    const [baseId, baseObj] = baseTicket;
    if (baseObj.human_checkpoint && (state[baseId] || {}).status === 'pr-open') {
      // Pre-authorization does NOT lift this. It is a person approving THAT
      // ticket's diff at plan time, so it covers the parent's own merge and not
      // merges INTO it: a child squashed in first changes what lands under that
      // approval, and the post-merge retarget still sends the grandchildren to
      // the epic. The wait is the same; only who is being waited for differs, so
      // the refusal says which — the remedies are not the same.
      return block(needsHuman(baseObj)
        ? `base "${pr.baseRefName}" is ${baseId}, a human_checkpoint ticket whose PR is still open — ` +
          'squashing into it would rewrite the diff a person is reviewing. It merges once they land theirs.'
        : `base "${pr.baseRefName}" is ${baseId}, a pre-authorized human_checkpoint ticket whose PR is still ` +
          'open — nothing lands inside the diff that authorization named. It lands first; this one follows.');
    }
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') return block('review decision is CHANGES_REQUESTED');

  // The trailer AND the head it names, both from the live view: a verdict is
  // only a verdict about the diff it was rendered against. `head_sha` on the
  // board is minutes old, and "it was that diff last tick" is the same reasoning
  // this whole live re-verification exists to refuse.
  const gate = parseGate(pr.body);
  if (!gateConform(gate, pr.headRefOid)) {
    return block(gateKind(gate, pr.headRefOid) === 'unrecorded'
      ? 'the PR body carries no `gate_status: arch-review=conform` trailer — the architecture verdict is not recorded'
      : `${gateWhy(gate, pr.headRefOid)} — arch-review is owed again on this head before it can land`);
  }
  res.gate = gate;

  const checks = ghChecks(s.pr, repo);
  res.checks = checks;
  // ASKED FIRST, ahead of the tallies, because an `unavailable` answer has all of
  // them at zero: `failing === 0 && pending === 0` is the green test, so the
  // arithmetic below would pass a PR whose checks nobody read. This is the same
  // shape of refusal as the errored `gh compare` at the end of this gate — an
  // unknown is not a pass — and the note is quoted so the refusal is actionable
  // rather than a dead end. No park and no human is asked: the next tick reads
  // again, and `state-sync` records the same fact for the board.
  if (checks.unavailable) {
    return block(
      `the check state could not be read: ${checks.note || 'gh pr checks did not answer'} — a green cannot be told ` +
      'from a red without it, so the merge is refused rather than guessed. Nothing to fix; the next tick reads again.'
    );
  }
  if (checks.failing > 0) return block(`${checks.failing} failing check(s)`);
  if (checks.pending > 0) return block(`${checks.pending} check(s) still running`);
  // Б3. `failing === 0 && pending === 0` is the green test, and an EMPTY check
  // list satisfies it without anything having run. This used to merge and leave
  // a note about it; the note was the only witness, and nobody reads a note at
  // 3am. The refusal names the setting, because the remedy is a decision a
  // person makes once per repository rather than work anyone can do.
  if (heldForNoCi(checks)) return block(NO_CI_WHY);
  if (checks.none_reported) {
    res.checks_note = 'no CI checks reported — merged on a PR where nothing ran '
      + '(allowed by delivery_pipeline.merge_without_ci)';
  }

  const threads = spawnSync('node', [path.join(__dirname, 'reviewers.cjs'), 'unresolved', String(s.pr), ...repoArg(repo)], { encoding: 'utf8' });
  if (threads.status !== 0) {
    return block(`could not read the review threads (reviewers.cjs unresolved exited ${threads.status}) — refusing to merge blind`);
  }
  let unresolved = null;
  try { unresolved = JSON.parse(threads.stdout).unresolved_count; } catch { unresolved = null; }
  if (typeof unresolved !== 'number') return block('review threads unreadable — refusing to merge blind');
  if (unresolved > 0) return block(`${unresolved} unresolved review thread(s)`);
  res.unresolved = 0;

  // DIRTY = merge conflicts, BEHIND = the base moved under it. Both need work in
  // the worktree, not a retry: say which, so the guard fixes the right thing.
  // MERGE the base in; do not rebase. A ticket branch with an open PR has been
  // pushed, so rebasing it requires a force-push — which this same guard forbids
  // two rules down, dismisses a human approval, and re-anchors every reviewer
  // thread we just drove to zero. The usual argument for rebasing is a clean
  // history, and it does not apply here: the PR lands with `--squash`, so the
  // epic gets exactly one commit per ticket whatever the branch looks like.
  if (pr.mergeStateStatus === 'DIRTY') {
    return block(
      'merge conflicts with the base — in the ticket worktree: `git fetch origin && git merge origin/<base>`, ' +
      'resolve, commit, push (NO force). Do not rebase a branch that already has a PR.'
    );
  }
  if (pr.mergeStateStatus === 'BLOCKED') return block('GitHub reports the merge as BLOCKED (branch protection: a required review or check is missing)');

  // The green that is the most expensive to trust: CI passed against a base that
  // has since moved. Retargeting a cascade child updates WHERE it points; it does
  // not re-run anything, so the check result still describes a merge base that no
  // longer exists. Landing a night of those produces an epic where every ticket
  // was green and the whole is broken.
  //
  // The comment two rules up has named BEHIND since this gate was written, and
  // nothing ever checked it. Both readings are used, because neither alone is
  // enough: mergeStateStatus is authoritative but only speaks when branch
  // protection requires up-to-date branches, and our own comparison works
  // everywhere but is a second opinion, not GitHub's verdict.
  const cmp = behindBy(pr.baseRefName, pr.headRefName, repo);
  if (pr.mergeStateStatus === 'BEHIND' || (cmp.behind || 0) > 0) {
    // GitHub's own verdict is reported first and needs no second opinion; our
    // count only sharpens the remedy when it is available.
    const staleBy = typeof cmp.behind === 'number' ? cmp.behind : 'some';
    res.behind_by = staleBy;
    return block(
      `the base moved: ${pr.baseRefName} is ${staleBy} commit(s) ahead of this branch, so the green checks were ` +
      'measured against a merge base that no longer exists. In the ticket worktree: ' +
      '`git fetch origin && git merge origin/<base>` (NEVER rebase — the PR is pushed), push, let CI re-run.'
    );
  }
  // An UNKNOWN answer is not "not behind". The old code returned null on an
  // errored compare and the comparison `null > 0` read as a pass — which is how
  // this whole gate came to be silently absent for every foreign-repo ticket
  // (the endpoint was unqualified, so the call always errored). Fail closed and
  // quote the gh error, or the refusal is unactionable.
  if (cmp.error) {
    return block(
      `base freshness unproven — gh compare failed: ${cmp.error}. A green measured against a base that has ` +
      'since moved cannot be told from a real green without it, so the merge is refused rather than guessed.'
    );
  }

  if (dryRun) {
    res.would_merge = true;
    return res;
  }

  // --squash: one ticket, one commit on the epic. The branch is deliberately NOT
  // deleted — the reaper owns that and only for `reapable` tickets, because a
  // cascade child may still be based on this branch.
  //
  // --match-head-commit: every gate above was checked against `pr.headRefOid`,
  // and a concurrent push can replace the head between the last check and this
  // call — the fixer that is servicing this very PR is one such push. `gh` has
  // the flag for exactly that race, so the merge either lands the diff the gate
  // judged or fails loudly. Omitted when the live view reports no head at all
  // (a pre-head-binding PR): the flag needs a value to pin, and an empty one is
  // a malformed call, not a weaker check.
  const merged = gh(['pr', 'merge', String(s.pr), ...repoArg(repo), '--squash',
    ...(pr.headRefOid ? ['--match-head-commit', pr.headRefOid] : [])], { tolerate: true });
  if (typeof merged !== 'string') return block(`gh pr merge failed: ${merged.error}`);
  if (pr.headRefOid) res.merged_head = pr.headRefOid;
  res.merged = true;
  // `preauthorized` is present only when it is WHY the merge was allowed, so a
  // reader can count design-time approvals without re-deriving them from the
  // graph — and an ordinary merge never claims one.
  journal({ event: 'merge', ticket: id, pr: s.pr, base: pr.baseRefName, repo, by: 'sentinel',
    ...(res.preauthorized ? { preauthorized: true } : {}) });

  // Cascade children based on THIS branch now have to move onto the epic —
  // GitHub does it by itself when the head branch is deleted, and we do not
  // delete it here, so finish the job idempotently.
  //
  // The children come from the GRAPH and their PRs are read LIVE. This loop used
  // to walk cached `state` alone, so a child whose PR opened after the last sync
  // was invisible to it: that PR kept pointing at a branch whose content had
  // just been squashed away, went DIRTY on the next sync, and waited for a
  // person. ONE `gh pr list --head` per child — a new call, and it is on the
  // MERGE path, not the tick: the conveyor's tick rate is state-sync's, and a
  // merge is rare next to a round of syncing.
  const epic = s.epic || t.epic;
  if (epic) {
    // Candidates from both directions, so neither a graph without state nor
    // state without a graph edge is missed. The graph half is the fix; the state
    // half preserves what the old loop could already see (a child whose
    // `primary_parent` the graph does not record, but whose PR points here).
    const candidates = new Map();
    for (const [childId, o] of Object.entries(tickets)) {
      if ((o.repo || null) !== repo) continue;
      if (o.primary_parent !== id) continue;
      if (o.branch) candidates.set(childId, o.branch);
    }
    for (const [childId, childState] of Object.entries(state)) {
      if ((childState.repo || null) !== repo) continue;
      if (childState.pr_base !== pr.headRefName) continue;
      if (childState.branch) candidates.set(childId, childState.branch);
    }
    for (const [childId, branch] of candidates) {
      const live = gh(['pr', 'list', '--head', branch, ...repoArg(repo), '--state', 'open',
        '--json', 'number,baseRefName'], { tolerate: true });
      let rows = null;
      if (typeof live === 'string') {
        try {
          const parsed = JSON.parse(live);
          if (Array.isArray(parsed)) rows = parsed.map((r) => ({ ...r, from: 'live' }));
        } catch { /* fall through to the cached answer below */ }
      }
      if (rows === null) {
        // gh could not answer. Fall back to the cached board — it is what we had
        // before this query existed — and SAY SO on the result: a silent
        // fallback is how a child left on a squashed base becomes a person's
        // problem hours later.
        const cs = state[childId] || {};
        rows = cs.status === 'pr-open' && cs.pr && cs.pr_base === pr.headRefName
          ? [{ number: cs.pr, baseRefName: cs.pr_base, from: 'cache' }]
          : [];
        (res.retarget_warnings = res.retarget_warnings || []).push(
          `${childId}: could not list its open PRs (${typeof live === 'string' ? 'unreadable output' : live.error}) — ` +
          `used the cached board instead${rows.length ? '' : ', which knows of no PR on this base'}`
        );
      }
      for (const row of rows) {
        if (row.baseRefName !== pr.headRefName) continue; // already retargeted, or never based here
        const out = gh(['pr', 'edit', String(row.number), ...repoArg(repo), '--base', epic], { tolerate: true });
        res.retargeted.push({
          ticket: childId, pr: row.number, base: epic, from: row.from,
          ok: typeof out === 'string', error: typeof out === 'string' ? null : out.error,
        });
      }
    }
  }
  return res;
}

if (cmd === 'merge') {
  const target = argv[1];
  let ids;
  if (target === '--all' || argv.includes('--all')) {
    ids = dutyItems().filter((i) => i.action === 'merge').map((i) => i.ticket);
  } else if (target && !target.startsWith('--')) {
    ids = [target];
  } else {
    fail('usage: sentinel.cjs merge <ticket|--all> [--dry-run] [--json]', 2);
  }

  const results = ids.map(mergeOne);
  if (asJson) {
    process.stdout.write(JSON.stringify({ auto_merge: AUTO_MERGE ? 'epic' : 'off', results }, null, 2) + '\n');
  } else if (!results.length) {
    console.log('sentinel merge: nothing is mergeable right now');
  } else {
    for (const r of results) {
      if (r.merged) {
        console.log(`merged ${r.ticket} PR #${r.pr} → ${r.base} (squash)${r.checks_note ? ` [${r.checks_note}]` : ''}`);
        for (const rt of r.retargeted) {
          console.log(`  retargeted ${rt.ticket} PR #${rt.pr} onto ${rt.base}${rt.ok ? '' : ` — FAILED: ${rt.error}`}`);
        }
      } else if (r.would_merge) {
        console.log(`would merge ${r.ticket} PR #${r.pr} → ${r.base} (dry run)`);
      } else {
        console.log(`refused ${r.ticket}${r.pr ? ` PR #${r.pr}` : ''}: ${r.blockers.join('; ')}`);
      }
    }
  }
  // A refusal is data, not a crash: the guard keeps working on the other PRs.
  process.exit(0);
}

// ── report: what the sentinel did and what it hands back ────────────────────
const since = valueFlag('since');
function mergedByGuard() {
  if (!fs.existsSync(JOURNAL)) return [];
  const floor = since ? Date.parse(since) : null;
  const out = [];
  for (const line of fs.readFileSync(JOURNAL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.event !== 'merge') continue;
    if (floor && Date.parse(rec.ts) < floor) continue;
    out.push(rec);
  }
  return out;
}

const duty = dutySummary();
const merges = mergedByGuard();
const epicsTouched = [...new Set(Object.values(state).filter((s) => s.epic).map((s) => s.epic))];

if (asJson) {
  process.stdout.write(JSON.stringify({ ...duty, merged: merges, epics: epicsTouched }, null, 2) + '\n');
  process.exit(0);
}

console.log('## Sentinel report');
console.log(`merged into the stack: ${merges.length ? merges.map((m) => `${m.ticket} (PR #${m.pr} → ${m.base})`).join(', ') : 'none'}`);
for (const line of formatDuty(duty)) console.log(line);
const human = duty.items.filter((i) => i.action === 'human' || i.action === 'human-merge');
if (human.length) {
  console.log('needs a human:');
  for (const i of human) console.log(`  ${i.ticket} PR #${i.pr} — ${i.why}`);
}
if (epicsTouched.length) {
  console.log(`epic branch(es) receiving this work: ${epicsTouched.join(', ')} — the epic → integration PR stays a human merge`);
}
process.exit(0);
