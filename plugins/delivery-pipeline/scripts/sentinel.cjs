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
function behindBy(base, head, repo) {
  const out = gh(['api', `repos/{owner}/{repo}/compare/${head}...${base}`,
    ...repoArg(repo), '--jq', '.ahead_by'], { tolerate: true });
  if (typeof out !== 'string') return null; // unreachable/unknown — never guess a number
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function ghChecks(pr, repo) {
  const r = spawnSync('gh', ['pr', 'checks', String(pr), ...repoArg(repo), '--json', 'name,state'], { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse((r.stdout || '').trim() || '[]'); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  return {
    failing: rows.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)).length,
    pending: rows.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(c.state)).length,
    total: rows.length,
    none_reported: rows.length === 0,
  };
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
// (it survives a squash merge). state-sync parses it into state[id].gate; parse
// it again here from the LIVE body, because merge must not trust a cache.
function parseGate(body) {
  const line = String(body || '').split('\n').reverse().find((l) => /^gate_status:/i.test(l.trim()));
  if (!line) return {};
  const out = {};
  for (const part of line.replace(/^\s*gate_status:/i, '').split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
const gateConform = (gate) => String((gate || {})['arch-review'] || '').toLowerCase() === 'conform';

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

// Unresolved review threads for one PR, or null when they cannot be read.
// Cached: the duty pass and a later merge check ask about the same PRs, and the
// GraphQL call is the expensive part of both.
const threadCache = new Map();
function unresolvedThreads(pr, repo) {
  const key = `${repo || ''}#${pr}`;
  if (threadCache.has(key)) return threadCache.get(key);
  const out = spawnSync('node', [path.join(__dirname, 'reviewers.cjs'), 'unresolved', String(pr), ...repoArg(repo)], { encoding: 'utf8' });
  let n = null;
  if (out.status === 0) {
    try { const v = JSON.parse(out.stdout).unresolved_count; if (typeof v === 'number') n = v; } catch { n = null; }
  }
  threadCache.set(key, n);
  return n;
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

// A child is deferred while its parent PR is still being driven — but never
// behind a parent that is waiting on a PERSON, or the whole subtree freezes for
// as long as the human takes.
// The parent ticket id when this child's base is an OPEN human_checkpoint PR,
// else null. Shared by the duty chain and the merge gate so the two cannot
// disagree about which children are landable.
function checkpointParentOf(id) {
  const parent = (tickets[id] || {}).primary_parent;
  if (!parent) return null;
  if (!(tickets[parent] || {}).human_checkpoint) return null;
  return (state[parent] || {}).status === 'pr-open' ? parent : null;
}

function parentIsMoving(id) {
  const parent = (tickets[id] || {}).primary_parent;
  if (!parent) return false;
  const ps = state[parent];
  if (!ps || ps.status !== 'pr-open') return false;
  if (PARKED.has(parent)) return false;
  if ((tickets[parent] || {}).human_checkpoint) return false;
  return true;
}

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
    const unresolved = unresolvedThreads(s.pr, s.repo || null);
    if (typeof unresolved === 'number' && unresolved > 0) {
      item.action = 'review-fix';
      item.unresolved = unresolved;
      item.why = `${unresolved} unresolved review thread(s)${(c.pending || 0) > 0 ? ` (CI still running — service them NOW: a fix pushes anyway and restarts that run)` : ''} — fix or reply with reasoning, then RESOLVE each one`;
    } else if ((c.pending || 0) > 0) {
      item.action = 'wait-ci';
      item.why = `${c.pending} check(s) still running${unresolved === null ? ' — review threads unreadable this tick' : ''} — re-tick, do not block the main loop`;
    } else if (s.draft && !gateConform(s.gate)) {
      // Certify BEFORE readying. Bundled together as one `finalize` these two
      // could not report separately, so a `violation` verdict and a clean one
      // ended the same way, and the action name itself was not a role the model
      // ladder knows — it got logged as one anyway.
      item.action = 'arch-review';
      item.why = 'green draft, no `gate_status: arch-review=conform` trailer — judge the diff against the ADRs and record the verdict';
    } else if (s.draft) {
      item.action = 'undraft';
      item.why = 'green + conform, still a draft — ready it (`gh pr ready`); nothing else is owed';
    } else if (t.human_checkpoint) {
      item.action = 'human';
      item.why = 'human_checkpoint — the approval and the merge are the human\'s';
    } else if (s.review_decision === 'CHANGES_REQUESTED') {
      item.action = 'review-fix';
      item.why = 'CHANGES_REQUESTED — service the threads (a bot can be wrong: a reasoned reply is a valid resolution)';
    } else if (!gateConform(s.gate)) {
      item.action = 'arch-review';
      item.why = 'green and out of draft, but no `gate_status: arch-review=conform` trailer — the architecture verdict was never recorded';
    } else if (AUTO_MERGE && s.merge_scope === 'stacked' && checkpointParentOf(id)) {
      // Ready in every respect, and still not ours to land: the base is an open
      // human_checkpoint parent. `merge` would be refused by the gate anyway —
      // this exists so the duty says the true reason instead of routing it to
      // `human-merge`, whose text ("awaiting merge") hides which human and why.
      item.action = 'wait-parent';
      item.why = `green + conform, but its base is ${checkpointParentOf(id)} — a human_checkpoint PR still open. `
        + 'Landing now would rewrite the diff that person is reading; it merges once they land theirs.';
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
const ACTIONABLE = new Set(['ci-fix', 'review-fix', 'arch-review', 'undraft', 'merge']);

function dutySummary() {
  const items = dutyItems();
  const actionable = items.filter((i) => ACTIONABLE.has(i.action));
  const waiting = items.filter((i) => i.action === 'wait-ci');
  const human = items.filter((i) => i.action === 'human' || i.action === 'human-merge');
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
  if (t.human_checkpoint) return block('human_checkpoint ticket — the merge is the human\'s by contract');

  const repo = s.repo || null;
  const view = gh(['pr', 'view', String(s.pr), ...repoArg(repo), '--json',
    'number,state,isDraft,baseRefName,headRefName,mergeStateStatus,reviewDecision,body'], { tolerate: true });
  if (typeof view !== 'string') return block(`gh pr view failed: ${view.error}`);
  let pr;
  try { pr = JSON.parse(view); } catch (e) { return block(`gh pr view returned unparseable JSON (${e.message})`); }

  res.base = pr.baseRefName;
  if (pr.state !== 'OPEN') return block(`PR is ${pr.state}, not OPEN`);
  if (pr.isDraft) return block('PR is still a draft — the conform gate has not been passed');

  // The stack boundary. A ticket PR may only land on the phase epic or on a
  // parent ticket's branch, both inside its own repo. Anything else — above all
  // the integration branch — is out of the sentinel's mandate.
  const integration = integrationBranchOf(repo);
  const sameRepoTicketBranches = new Set(
    Object.entries(tickets)
      .filter(([, o]) => (o.repo || null) === repo)
      .map(([, o]) => o.branch)
  );
  const allowed = new Set([s.epic, t.epic, ...sameRepoTicketBranches].filter(Boolean));
  if (pr.baseRefName === integration) {
    return block(`PR targets the integration branch ${integration} — landing a phase there is a human's decision, never the sentinel's`);
  }
  if (!allowed.has(pr.baseRefName)) {
    return block(`PR base "${pr.baseRefName}" is neither the phase epic nor a parent ticket branch in this repo — refusing to merge outside the stack`);
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
      return block(
        `base "${pr.baseRefName}" is ${baseId}, a human_checkpoint ticket whose PR is still open — ` +
        'squashing into it would rewrite the diff a person is reviewing. It merges once they land theirs.'
      );
    }
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') return block('review decision is CHANGES_REQUESTED');

  const gate = parseGate(pr.body);
  if (!gateConform(gate)) {
    return block('the PR body carries no `gate_status: arch-review=conform` trailer — the architecture verdict is not recorded');
  }
  res.gate = gate;

  const checks = ghChecks(s.pr, repo);
  res.checks = checks;
  if (checks.failing > 0) return block(`${checks.failing} failing check(s)`);
  if (checks.pending > 0) return block(`${checks.pending} check(s) still running`);
  if (checks.none_reported) res.checks_note = 'no CI checks reported — merged on a PR where nothing ran';

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
  const staleBy = pr.mergeStateStatus === 'BEHIND'
    ? (behindBy(pr.baseRefName, pr.headRefName, repo) ?? 'some')
    : behindBy(pr.baseRefName, pr.headRefName, repo);
  if (pr.mergeStateStatus === 'BEHIND' || (typeof staleBy === 'number' && staleBy > 0)) {
    res.behind_by = staleBy;
    return block(
      `the base moved: ${pr.baseRefName} is ${staleBy} commit(s) ahead of this branch, so the green checks were ` +
      'measured against a merge base that no longer exists. In the ticket worktree: ' +
      '`git fetch origin && git merge origin/<base>` (NEVER rebase — the PR is pushed), push, let CI re-run.'
    );
  }

  if (dryRun) {
    res.would_merge = true;
    return res;
  }

  // --squash: one ticket, one commit on the epic. The branch is deliberately NOT
  // deleted — the reaper owns that and only for `reapable` tickets, because a
  // cascade child may still be based on this branch.
  const merged = gh(['pr', 'merge', String(s.pr), ...repoArg(repo), '--squash'], { tolerate: true });
  if (typeof merged !== 'string') return block(`gh pr merge failed: ${merged.error}`);
  res.merged = true;
  journal({ event: 'merge', ticket: id, pr: s.pr, base: pr.baseRefName, repo, by: 'sentinel' });

  // Cascade children based on THIS branch now have to move onto the epic —
  // GitHub does it by itself when the head branch is deleted, and we do not
  // delete it here, so finish the job idempotently.
  const epic = s.epic || t.epic;
  if (epic) {
    for (const [childId, childState] of Object.entries(state)) {
      if (childState.status !== 'pr-open' || !childState.pr) continue;
      if ((childState.repo || null) !== repo) continue;
      if (childState.pr_base !== pr.headRefName) continue;
      const out = gh(['pr', 'edit', String(childState.pr), ...repoArg(repo), '--base', epic], { tolerate: true });
      res.retargeted.push({ ticket: childId, pr: childState.pr, base: epic, ok: typeof out === 'string', error: typeof out === 'string' ? null : out.error });
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
