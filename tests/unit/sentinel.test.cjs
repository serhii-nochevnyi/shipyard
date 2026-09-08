'use strict';

// The sentinel decides two things a run must never improvise: who owns each open
// PR, and whether a PR may be merged. `duty` is pure (state in, verdict out) so
// it is tested end to end; `merge` refuses before it ever calls gh for every
// mandate violation, and those refusals are the safety property worth pinning —
// an auto-merge that fires on the wrong PR is not recoverable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SENTINEL = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'sentinel.cjs');
const roots = [];

// `configRaw` writes the config file BYTE FOR BYTE, which is the only way to
// build the one fixture that matters here: a config that cannot be parsed at all.
// JSON.stringify cannot produce one.
function project({ tickets, state, config, configRaw }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sentinel-'));
  roots.push(root);
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets, epics: {} }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    configRaw !== undefined ? configRaw : JSON.stringify(config || { pipeline: {} })
  );
  return root;
}

function run(root, args, opts = {}) {
  const r = spawnSync(process.execPath, [SENTINEL, ...args], {
    cwd: root,
    encoding: 'utf8',
    // The merge path re-reads the PR from LIVE GitHub by design, so every case
    // past the pre-gh refusals needs a `gh` on PATH that answers. `stubGh`
    // below builds one; the cases that must stay hermetic pass the deny-all.
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const checks = (failing = 0, pending = 0, total = 3) => ({ total, failing, pending, none_reported: total === 0 });
const conform = { 'arch-review': 'conform', 'drift-check': 'fresh', checks: 'green' };
const green = {
  status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform,
  merge_scope: 'stacked', pr_base: 'epic/01-x', epic: 'epic/01-x', branch: 'ticket/T-01-01-x',
};

suite('sentinel duty — one action per open PR');

test('failing checks are ci-fix, pending checks are wait-ci', () => {
  const root = project({
    tickets: { A: {}, B: {} },
    state: {
      A: { status: 'pr-open', pr: 1, checks: checks(2, 0), branch: 'ticket/A' },
      B: { status: 'pr-open', pr: 2, checks: checks(0, 3), branch: 'ticket/B' },
    },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.items.find((i) => i.ticket === 'A').action, 'ci-fix');
  assert.strictEqual(d.items.find((i) => i.ticket === 'B').action, 'wait-ci');
  assert.strictEqual(d.clear, false, 'a PR waiting on CI keeps the guard on duty');
});

test('a green PR with the conform trailer is a merge', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green } } });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.auto_merge, 'epic', 'auto-merge is the default');
  assert.strictEqual(d.items[0].action, 'merge');
  assert.strictEqual(d.actionable_count, 1);
});

test('without the trailer the same PR is arch-review work, not a merge', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, gate: undefined } } });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  // Named for the role that does it, not for a stage. `finalize` bundled the
  // architecture verdict with readying the PR, so a `violation` and a clean pass
  // ended in the same action — and the name was not one the ladder could route.
  assert.strictEqual(d.items[0].action, 'arch-review');
});

test('duty holds a child whose base is an open human_checkpoint parent', () => {
  // The runs found this themselves: three of five escalations in one phase were
  // manual holds on exactly this, each citing the merge gate's base check. The
  // duty must say WHICH human and why — routing it to `human-merge` ("awaiting
  // merge") hides both.
  const root = project({
    tickets: { P: { human_checkpoint: true, branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } },
    state: {
      P: { status: 'pr-open', pr: 1, draft: false, checks: checks(), branch: 'ticket/P' },
      C: { ...green, pr: 2, pr_base: 'ticket/P', branch: 'ticket/C' },
    },
  });
  const byId = Object.fromEntries(JSON.parse(run(root, ['duty', '--json']).stdout).items.map((i) => [i.ticket, i]));
  assert.strictEqual(byId.C.action, 'wait-parent', byId.C.why);
  assert.ok(/human_checkpoint/.test(byId.C.why), byId.C.why);
});

test('and offers the merge again once that parent has landed', () => {
  const root = project({
    tickets: { P: { human_checkpoint: true, branch: 'ticket/P' }, C: { primary_parent: 'P', branch: 'ticket/C' } },
    state: {
      P: { status: 'merged', pr: 1, branch: 'ticket/P' },
      C: { ...green, pr: 2, pr_base: 'ticket/P', branch: 'ticket/C' },
    },
  });
  const byId = Object.fromEntries(JSON.parse(run(root, ['duty', '--json']).stdout).items.map((i) => [i.ticket, i]));
  assert.strictEqual(byId.C.action, 'merge', byId.C.why);
});

test('a push onto an APPROVED PR is flagged as dismissing the approval', () => {
  // Field-observed: a conveyor push over a human approval dismissed it silently
  // and cost an apology plus a re-review round. The fix still must be pushed —
  // a red check on an approved PR is real work — so this is the duty CARRYING
  // the fact, not a refusal.
  const root = project({
    tickets: { A: {}, B: {} },
    state: {
      A: { status: 'pr-open', pr: 1, checks: checks(1, 0), branch: 'ticket/A', review_decision: 'APPROVED' },
      B: { status: 'pr-open', pr: 2, checks: checks(1, 0), branch: 'ticket/B' },
    },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  const byId = Object.fromEntries(d.items.map((i) => [i.ticket, i]));
  assert.strictEqual(byId.A.action, 'ci-fix', 'the fix is still owed');
  assert.strictEqual(byId.A.dismisses_approval, true);
  assert.ok(/dismiss/.test(byId.A.why), 'the duty text must carry the warning to the fixer');
  assert.strictEqual(byId.B.dismisses_approval, undefined, 'an unapproved PR gets no such flag');
});

test('the merge action never carries the dismissal flag — merging is not a push', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, review_decision: 'APPROVED' } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.items[0].action, 'merge');
  assert.strictEqual(d.items[0].dismisses_approval, undefined);
});

test('a child stacked on an open parent waits, and the parent is served first', () => {
  const root = project({
    tickets: { P: {}, C: { primary_parent: 'P' } },
    state: {
      P: { status: 'pr-open', pr: 1, checks: { failing: 1, pending: 0 } },
      C: { status: 'pr-open', pr: 2, checks: { failing: 1, pending: 0 } },
    },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  const byId = Object.fromEntries(d.items.map((i) => [i.ticket, i]));
  assert.strictEqual(byId.P.action, 'ci-fix', 'the root is the work');
  // Anything done on the child now is provisional: the parent landing moves its
  // base, CI re-runs against different code, reviewers re-read a changed diff.
  assert.strictEqual(byId.C.action, 'wait-parent', byId.C.why);
  assert.strictEqual(d.items[0].ticket, 'P', 'shallowest first, so a caller taking the head gets the root');
  assert.strictEqual(d.actionable_count, 1, 'the child is not actionable while the parent moves');
});

test('a parent waiting on a PERSON does not freeze its subtree', () => {
  // The deadlock this guard exists for: a checkpointed parent can sit for hours,
  // and deferring behind it would stop the whole stack for exactly that long.
  const root = project({
    tickets: { P: { human_checkpoint: true }, C: { primary_parent: 'P' } },
    state: {
      P: { status: 'pr-open', pr: 1, checks: { failing: 0, pending: 0 }, gate: { 'arch-review': 'conform' } },
      C: { status: 'pr-open', pr: 2, checks: { failing: 1, pending: 0 } },
    },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  const byId = Object.fromEntries(d.items.map((i) => [i.ticket, i]));
  assert.strictEqual(byId.P.action, 'human');
  assert.strictEqual(byId.C.action, 'ci-fix', 'the child keeps moving when its parent is a human\'s to unblock');
});

test('a certified draft is only owed the undraft — no agent, no model', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, draft: true, gate: { 'arch-review': 'conform' } } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.items[0].action, 'undraft');
});

test('an uncertified draft is judged before it is readied', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, draft: true, gate: undefined } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.items[0].action, 'arch-review', 'never ready a PR whose verdict was never recorded');
});

test('auto_merge: off hands the merge back to a human', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green } },
    config: { pipeline: { auto_merge: 'off' } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.auto_merge, 'off');
  assert.strictEqual(d.items[0].action, 'human-merge');
  assert.strictEqual(d.clear, true, 'nothing left for the guard once the human owns it');
});

test('direct-to-main never auto-merges: the ticket PR targets the integration branch', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, merge_scope: undefined, pr_base: 'main' } },
    config: { pipeline: { integration_mode: 'direct-to-main' } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.auto_merge, 'off');
  assert.ok(/integration_mode is direct-to-main/.test(d.auto_merge_note));
});

test('a human_checkpoint ticket is the human\'s, whatever the gate says', () => {
  const root = project({ tickets: { A: { human_checkpoint: true } }, state: { A: { ...green } } });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.items[0].action, 'human');
});

test('a run-parked ticket stays parked instead of being re-offered forever', () => {
  const root = project({ tickets: { A: {} }, state: { A: { status: 'pr-open', pr: 1, checks: checks(1, 0), branch: 'x' } } });
  const d = JSON.parse(run(root, ['duty', '--json', '--parked', 'A']).stdout);
  assert.strictEqual(d.items[0].action, 'parked');
  assert.strictEqual(d.clear, true);
});

test('merged and pending tickets are not the guard\'s business', () => {
  const root = project({
    tickets: { A: {}, B: {} },
    state: { A: { status: 'merged', pr: 1 }, B: { status: 'pending', ready: true } },
  });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.strictEqual(d.guarded, 0);
  assert.strictEqual(d.clear, true);
});

test('no CI checks at all is reported as "nothing ran", not as verified', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: checks(0, 0, 0) } } });
  const d = JSON.parse(run(root, ['duty', '--json']).stdout);
  assert.ok(/nothing ran/.test(d.items[0].checks_note));
});

suite('sentinel merge — the refusals that must happen before any gh call');

test('auto_merge: off refuses outright', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green } },
    config: { pipeline: { auto_merge: 'off' } },
  });
  const { stdout } = run(root, ['merge', 'A', '--json']);
  const r = JSON.parse(stdout).results[0];
  assert.strictEqual(r.merged, false);
  assert.ok(/auto-merge refused/.test(r.blockers[0]));
});

test('a human_checkpoint ticket is refused by contract', () => {
  const root = project({ tickets: { A: { human_checkpoint: true } }, state: { A: { ...green } } });
  const r = JSON.parse(run(root, ['merge', 'A', '--json']).stdout).results[0];
  assert.strictEqual(r.merged, false);
  assert.ok(/human_checkpoint/.test(r.blockers[0]));
});

test('a ticket that is not pr-open is refused', () => {
  const root = project({ tickets: { A: {} }, state: { A: { status: 'branched', branch: 'x' } } });
  const r = JSON.parse(run(root, ['merge', 'A', '--json']).stdout).results[0];
  assert.ok(/not pr-open/.test(r.blockers[0]));
});

test('an unknown ticket is refused rather than guessed at', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green } } });
  const r = JSON.parse(run(root, ['merge', 'NOPE', '--json']).stdout).results[0];
  assert.ok(/unknown ticket/.test(r.blockers[0]));
});

test('merge --all with nothing mergeable is a no-op, not an error', () => {
  const root = project({ tickets: { A: {} }, state: { A: { status: 'pr-open', pr: 1, checks: checks(1, 0), branch: 'x' } } });
  const out = run(root, ['merge', '--all', '--json']);
  assert.strictEqual(out.status, 0);
  assert.deepStrictEqual(JSON.parse(out.stdout).results, []);
});

test('a refusal exits 0 — the guard keeps working on the other PRs', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green } },
    config: { pipeline: { auto_merge: 'off' } },
  });
  assert.strictEqual(run(root, ['merge', 'A']).status, 0);
});

suite('sentinel report');

test('the report lists what landed and what still needs a human', () => {
  const root = project({
    tickets: { A: {}, B: { human_checkpoint: true } },
    state: { A: { status: 'merged', pr: 1 }, B: { ...green, pr: 2 } },
  });
  fs.appendFileSync(
    path.join(root, '.planning', 'graph', 'delivery-log.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), event: 'merge', ticket: 'A', pr: 1, base: 'epic/01-x' }) + '\n'
  );
  const { stdout } = run(root, ['report']);
  assert.ok(stdout.includes('merged into the stack: A (PR #1 → epic/01-x)'));
  assert.ok(stdout.includes('needs a human'));
  assert.ok(/epic → integration PR stays a human merge/.test(stdout));
});

test('missing state is an actionable error, not a crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sentinel-bare-'));
  roots.push(root);
  const r = run(root, ['duty']);
  assert.strictEqual(r.status, 1);
  assert.ok(/run state-sync/.test(r.stderr));
});


// ── pre-authorization (ADR-001 D6) ──────────────────────────────────────────
//
// `delivery.preauthorized` (T-21-01) records that the judgement a
// `human_checkpoint` asks for was supplied by a person while the ticket set was
// approved. Nothing read it until now. Two properties are non-negotiable, and
// each has its own case below: pre-authorization must never reach the
// epic → integration boundary, and the board and the guard must answer every
// combination the same way — through the same predicate, not through two copies
// of it.

const { parentIsMoving } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'parent-moving.cjs'
));
const { computeFront, needsHuman } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));

// A `gh` that answers exactly the calls `sentinel.cjs merge` makes. The gate
// re-reads the PR from LIVE GitHub by design, so every assertion past the
// pre-gh refusals needs one. Answers come from the environment so a single
// script serves every case.
function stubGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ghstub-'));
  roots.push(dir);
  const script = [
    '#!/bin/sh',
    'argv="$*"',
    // Two of this ticket's rules are about the ARGUMENTS of a gh call — the
    // `--match-head-commit` on the squash, and the ABSENCE of `--repo` on the
    // compare (`gh api` does not accept it) — and an argv log is the only place
    // a test can see them. Written only when a case asks for one.
    'if [ -n "${STUB_LOG:-}" ]; then printf \'%s\\n\' "$argv" >> "$STUB_LOG"; fi',
    'case "$argv" in',
    // `headRefOid` is the live head the conform trailer is bound to, and
    // STUB_TRAILER_HEAD is the head the trailer CLAIMS. Both are unset by
    // default — an absent head on both sides is the pre-head-binding case, and
    // `${VAR:+…}` adds nothing at all rather than an empty `head=`.
    '  "pr view "*)',
    '    printf \'{"number":%s,"state":"OPEN","isDraft":false,"baseRefName":"%s","headRefName":"%s","headRefOid":"%s","mergeStateStatus":"%s","reviewDecision":null,"body":"gate_status: arch-review=conform%s, checks=green"}\\n\' "${STUB_PR:-9}" "${STUB_BASE}" "${STUB_HEAD}" "${STUB_HEAD_OID:-}" "${STUB_MERGE_STATE:-CLEAN}" "${STUB_TRAILER_HEAD:+, head=$STUB_TRAILER_HEAD}" ;;',
    // The rows carry gh's own `bucket`, because check-state.cjs reads that
    // field and a row without one is PENDING by its fail-closed rule — a
    // bucket-less stub would leave every merge case waiting on CI forever.
    // STUB_CHECKS lets one case hand over a different pipeline; `${VAR:-json}`
    // cannot carry the default (the first `}` would close the expansion).
    // STUB_CHECKS_FAIL is the call that DOES NOT ANSWER: `gh` prints the cause to
    // stderr, nothing to stdout, and exits non-zero — a 503, a rate limit, an old
    // `gh` rejecting `--json bucket`. STUB_CHECKS_EXIT is separate on purpose,
    // because `gh pr checks` reports CI state through its exit code while still
    // printing the JSON (1 = a check failed OR the PR has no checks, 8 = pending),
    // so a non-zero exit WITH output is data and must stay tellable from this.
    '  "pr checks "*)',
    '    if [ -n "${STUB_CHECKS_FAIL:-}" ]; then echo "$STUB_CHECKS_FAIL" >&2; exit "${STUB_CHECKS_EXIT:-1}"; fi',
    '    if [ -n "${STUB_CHECKS:-}" ]; then echo "$STUB_CHECKS";',
    '    else echo \'[{"name":"test-fast","state":"SUCCESS","bucket":"pass"}]\'; fi',
    '    exit "${STUB_CHECKS_EXIT:-0}" ;;',
    '  "repo view --json owner,name"*) echo \'{"owner":{"login":"acme"},"name":"demo"}\' ;;',
    // Matches both the local form (`repo view --json …`) and the foreign one
    // (`repo view acme/other --json …`) — a ticket in a sibling repository asks
    // that repository for its default branch.
    '  "repo view "*"defaultBranchRef"*) echo "${STUB_DEFAULT_BRANCH:-main}" ;;',
    '  "api graphql"*) echo \'{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\' ;;',
    // The compare endpoint is repo-QUALIFIED now (`repos/<owner>/<name>/…`), so
    // the pattern must not name the `{owner}/{repo}` placeholders. STUB_COMPARE_FAIL
    // is the "gh could not answer" case, which must refuse rather than pass.
    '  "api repos/"*"/compare/"*)',
    '    if [ -n "${STUB_COMPARE_FAIL:-}" ]; then echo "gh: HTTP 404: Not Found" >&2; exit 1; fi',
    '    echo "${STUB_BEHIND:-0}" ;;',
    // The post-merge retarget asks GitHub for each child's OPEN PR instead of
    // trusting the last sync. STUB_CHILD_FAIL is the unreachable case, which
    // falls back to the cached board and says so.
    '  "pr list --head "*)',
    '    if [ -n "${STUB_CHILD_FAIL:-}" ]; then echo "gh: could not list" >&2; exit 1; fi',
    '    echo "${STUB_CHILD_PRS:-[]}" ;;',
    '  "pr merge "*) echo "squash-merged" ;;',
    '  "pr edit "*) echo "retargeted" ;;',
    '  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return dir;
}

// The opposite stub: a `gh` that answers nothing. A refusal that must happen
// BEFORE any network call is only pinned as such if the network cannot answer.
function denyGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ghdeny-'));
  roots.push(dir);
  fs.writeFileSync(
    path.join(dir, 'gh'),
    '#!/bin/sh\necho "gh: refused — this case must not need GitHub" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  return dir;
}

const onPath = (dir, extra = {}) => ({ PATH: dir + path.delimiter + process.env.PATH, ...extra });

suite('pre-authorization — the board and the guard, driven from ONE state');

// Built once and handed to BOTH readers: the sentinel receives them through the
// project on disk, `computeFront` receives the very same objects. Two parallel
// tests, one per file, is exactly the shape this ticket exists to remove —
// `checkpointParent` lived twice (front.cjs:95, sentinel.cjs:233) and a second
// condition added to two copies is how a rule comes to contradict itself.
const agreeTickets = {
  'T-PRE': { human_checkpoint: true, preauthorized: true, branch: 'ticket/T-PRE', epic: 'epic/21-x' },
  'T-HOLD': { human_checkpoint: true, branch: 'ticket/T-HOLD', epic: 'epic/21-x' },
  'T-PLAIN': { branch: 'ticket/T-PLAIN', epic: 'epic/21-x' },
  'C-PRE': { primary_parent: 'T-PRE', branch: 'ticket/C-PRE', epic: 'epic/21-x' },
  'C-HOLD': { primary_parent: 'T-HOLD', branch: 'ticket/C-HOLD', epic: 'epic/21-x' },
  // The ORDINARY hold, added when `parentIsMoving` moved into its own module:
  // a child of a parent nobody is waiting on personally. The guard has always
  // answered `wait-parent` here; the board used to answer `merge`, so this row
  // is what puts the new `waiting.parent` bucket under the agreement invariant
  // below rather than under a table of its own.
  'C-PLAIN': { primary_parent: 'T-PLAIN', branch: 'ticket/C-PLAIN', epic: 'epic/21-x' },
};
const openGreen = (pr, branch, base) => ({
  status: 'pr-open', pr, draft: false, checks: checks(), gate: conform,
  merge_scope: 'stacked', pr_base: base, epic: 'epic/21-x', branch,
});
const agreeState = {
  'T-PRE': openGreen(11, 'ticket/T-PRE', 'epic/21-x'),
  'T-HOLD': openGreen(12, 'ticket/T-HOLD', 'epic/21-x'),
  'T-PLAIN': openGreen(13, 'ticket/T-PLAIN', 'epic/21-x'),
  'C-PRE': openGreen(14, 'ticket/C-PRE', 'ticket/T-PRE'),
  'C-HOLD': openGreen(15, 'ticket/C-HOLD', 'ticket/T-HOLD'),
  'C-PLAIN': openGreen(16, 'ticket/C-PLAIN', 'ticket/T-PLAIN'),
};

test('front and sentinel agree on every pre-authorization combination', () => {
  const root = project({ tickets: agreeTickets, state: agreeState });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  const duty = Object.fromEntries(d.items.map((i) => [i.ticket, i]));
  // project()'s default config leaves auto_merge at its 'epic' default and
  // integration_mode at 'epic-stacked', which is what AUTO_MERGE resolves to
  // inside the subprocess — so `{ autoMerge: true }` asks the board the SAME
  // question. Asserted, not assumed: a config drift here would make the two
  // sides disagree for a reason that has nothing to do with the predicate.
  assert.strictEqual(d.auto_merge, 'epic');
  const f = computeFront(agreeTickets, agreeState, { autoMerge: true });

  const bucketOf = (id) => {
    for (const [k, v] of Object.entries(f.actionable)) if (v.includes(id)) return `actionable.${k}`;
    for (const [k, v] of Object.entries(f.waiting)) if (v.includes(id)) return `waiting.${k}`;
    for (const [k, v] of Object.entries(f.parked)) if (v.includes(id)) return `parked.${k}`;
    return 'nowhere';
  };
  const expected = {
    // pre-authorized: the person answered at plan time, so the guard lands it
    'T-PRE': { action: 'merge', bucket: 'actionable.merge' },
    // an ordinary ticket — the positive control that keeps the merge sets below
    // from being trivially equal because nothing is ever mergeable
    'T-PLAIN': { action: 'merge', bucket: 'actionable.merge' },
    // un-authorized: unchanged, a person still holds the key
    'T-HOLD': { action: 'human', bucket: 'waiting.human' },
    // a child never lands into an OPEN checkpoint parent, authorized or not:
    // pre-authorization covers that parent's own merge, not merges INTO it
    'C-PRE': { action: 'wait-parent', bucket: 'waiting.human' },
    'C-HOLD': { action: 'wait-parent', bucket: 'waiting.human' },
    // …and a child of an ORDINARY open parent is the same refusal for a
    // different reason: nobody is being waited FOR, the guard is driving the
    // parent itself. Same action, a different bucket, because the remedies are
    // not the same.
    'C-PLAIN': { action: 'wait-parent', bucket: 'waiting.parent' },
  };
  for (const [id, want] of Object.entries(expected)) {
    assert.strictEqual(duty[id].action, want.action, `${id} duty says ${duty[id].action}: ${duty[id].why}`);
    assert.strictEqual(bucketOf(id), want.bucket, `${id} front says ${bucketOf(id)}: ${f.why[id]}`);
  }

  // The invariant, DERIVED from the two answers rather than restated as a third
  // table: whatever the rows above say, the guard's merge and the board's merge
  // bucket must name the same set. The front must never offer what the guard
  // refuses — nor withhold what it would take.
  const guardMerges = d.items.filter((i) => i.action === 'merge').map((i) => i.ticket).sort();
  assert.deepStrictEqual(guardMerges, f.actionable.merge.slice().sort(),
    `guard merges ${guardMerges} vs board merges ${f.actionable.merge}`);
  // Same for actionability as a whole — `wait-parent` and `human` are the
  // guard's two ways of saying "not now", and both must leave the board's
  // actionable buckets empty of that ticket.
  const GUARD_ACTIONABLE = new Set(['ci-fix', 'review-fix', 'arch-review', 'undraft', 'merge']);
  const guardActionable = d.items.filter((i) => GUARD_ACTIONABLE.has(i.action)).map((i) => i.ticket).sort();
  const boardActionable = Object.values(f.actionable).flat().sort();
  assert.deepStrictEqual(guardActionable, boardActionable,
    `guard actionable ${guardActionable} vs board actionable ${boardActionable}`);
  // Negative control for both deepStrictEquals: two empty lists are equal, so
  // the agreement above is only evidence if the sets are non-empty and are the
  // ones the table named.
  assert.deepStrictEqual(guardMerges, ['T-PLAIN', 'T-PRE']);

  // A hold is a hold, not a park: nobody owes work on a checkpoint child.
  assert.deepStrictEqual(f.parked.blocked, []);
  // Each held child's reason names WHICH parent, and the pre-authorized one
  // says the parent lands first rather than implying a person is reading it.
  assert.ok(/T-PRE/.test(f.why['C-PRE']), f.why['C-PRE']);
  assert.ok(/pre-authorized/.test(f.why['C-PRE']), f.why['C-PRE']);
  assert.ok(/T-PRE/.test(duty['C-PRE'].why), duty['C-PRE'].why);
  assert.ok(/pre-authorized/.test(duty['C-PRE'].why), duty['C-PRE'].why);
  assert.ok(/T-HOLD/.test(f.why['C-HOLD']), f.why['C-HOLD']);
  assert.ok(/human_checkpoint/.test(f.why['C-HOLD']), f.why['C-HOLD']);
  // The ordinary hold names its parent too, and the board says which parent
  // ci-wait.cjs should be watching.
  assert.ok(/T-PLAIN/.test(f.why['C-PLAIN']), f.why['C-PLAIN']);
  assert.strictEqual(f.parent_of['C-PLAIN'], 'T-PLAIN');
});

test('parentIsMoving is the one both files ask, and it answers over the caller\'s graph', () => {
  // The extraction's own assertion. Paired with the agreement test above, which
  // is what actually catches a second copy being reintroduced.
  assert.strictEqual(parentIsMoving('C-PLAIN', { tickets: agreeTickets, state: agreeState }), true);
  assert.strictEqual(parentIsMoving('T-PLAIN', { tickets: agreeTickets, state: agreeState }), false,
    'a root has no parent');
  assert.strictEqual(parentIsMoving('C-HOLD', { tickets: agreeTickets, state: agreeState }), false,
    'a checkpoint parent never holds its child from being driven to green');
  assert.strictEqual(parentIsMoving('C-PRE', { tickets: agreeTickets, state: agreeState }), false,
    'nor a PRE-AUTHORIZED one: the exception reads human_checkpoint, not needsHuman');
  assert.strictEqual(
    parentIsMoving('C-PLAIN', { tickets: agreeTickets, state: agreeState, parked: new Set(['T-PLAIN']) }),
    false,
    'a parked parent is not being driven — the guard reads its own PARKED set here',
  );
  assert.strictEqual(
    parentIsMoving('C-PLAIN', { tickets: agreeTickets, state: agreeState, parked: ['T-PLAIN'] }),
    false,
    'and an array is accepted as well as a Set, because the two callers hold it differently',
  );
  assert.strictEqual(
    parentIsMoving('C-PLAIN', {
      tickets: agreeTickets,
      state: { ...agreeState, 'T-PLAIN': { ...agreeState['T-PLAIN'], status: 'merged' } },
    }),
    false,
    'a landed parent has already moved the base',
  );
});

test('the shared predicate is the one both files import', () => {
  // The reduction to one home is the ticket's goal, not an aside. If a second
  // copy is ever reintroduced this assertion still passes — so it is paired
  // with the agreement test above, which is what actually catches divergence.
  assert.strictEqual(typeof needsHuman, 'function');
  assert.strictEqual(needsHuman({ human_checkpoint: true }), true);
  assert.strictEqual(needsHuman({ human_checkpoint: true, preauthorized: true }), false);
});

suite('pre-authorization — the epic → integration boundary is not negotiable');

const epicTickets = {
  'T-PRE': { human_checkpoint: true, preauthorized: true, branch: 'ticket/T-PRE', epic: 'epic/21-x' },
  'T-TWO': { human_checkpoint: true, preauthorized: true, branch: 'ticket/T-TWO', epic: 'epic/21-x' },
};
// `git.base_branch` makes integrationBranchOf() answer without asking gh, so
// the stub only has to serve the PR itself.
const epicConfig = { pipeline: {}, git: { base_branch: 'main' } };

test('a PR targeting the integration branch is refused though every ticket is pre-authorized', () => {
  const root = project({
    tickets: epicTickets,
    state: {
      'T-PRE': { ...openGreen(9, 'ticket/T-PRE', 'main'), merge_scope: 'integration' },
      'T-TWO': openGreen(10, 'ticket/T-TWO', 'epic/21-x'),
    },
    config: epicConfig,
  });
  const env = onPath(stubGh(), { STUB_BASE: 'main', STUB_HEAD: 'ticket/T-PRE', STUB_PR: '9' });
  const r = JSON.parse(run(root, ['merge', 'T-PRE', '--json'], { env }).stdout).results[0];
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.ok(r.blockers.some((b) => /integration branch/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /human/.test(b)), r.blockers.join('; '));
});

test('...and the SAME pre-authorized ticket does land on its epic (the control)', () => {
  // Without this the refusal above proves nothing: a gate that refuses
  // everything would satisfy it.
  const root = project({
    tickets: epicTickets,
    state: { 'T-PRE': openGreen(9, 'ticket/T-PRE', 'epic/21-x'), 'T-TWO': openGreen(10, 'ticket/T-TWO', 'epic/21-x') },
    config: epicConfig,
  });
  const env = onPath(stubGh(), { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-PRE', STUB_PR: '9' });
  const r = JSON.parse(run(root, ['merge', 'T-PRE', '--json', '--dry-run'], { env }).stdout).results[0];
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
  assert.strictEqual(r.preauthorized, true, 'the result records WHY the checkpoint was passable');
});

test('an un-authorized checkpoint is still refused, in today\'s words, before any gh call', () => {
  const root = project({
    tickets: { 'T-HOLD': { human_checkpoint: true, branch: 'ticket/T-HOLD', epic: 'epic/21-x' } },
    state: { 'T-HOLD': openGreen(9, 'ticket/T-HOLD', 'epic/21-x') },
    config: epicConfig,
  });
  const r = JSON.parse(run(root, ['merge', 'T-HOLD', '--json'], { env: onPath(denyGh()) }).stdout).results[0];
  assert.strictEqual(r.merged, false);
  assert.deepStrictEqual(r.blockers, ['human_checkpoint ticket — the merge is the human\'s by contract']);
  assert.strictEqual(r.preauthorized, undefined, 'nothing to record — no pre-authorization was involved');
});

suite('pre-authorization — a child still waits for its parent to land');

const childTickets = {
  'T-PRE': { human_checkpoint: true, preauthorized: true, branch: 'ticket/T-PRE', epic: 'epic/21-x' },
  'C-PRE': { primary_parent: 'T-PRE', branch: 'ticket/C-PRE', epic: 'epic/21-x' },
};
const childEnv = () => onPath(stubGh(), { STUB_BASE: 'ticket/T-PRE', STUB_HEAD: 'ticket/C-PRE', STUB_PR: '14' });

test('the guard refuses a child whose base is an OPEN pre-authorized checkpoint parent', () => {
  const root = project({
    tickets: childTickets,
    state: { 'T-PRE': openGreen(11, 'ticket/T-PRE', 'epic/21-x'), 'C-PRE': openGreen(14, 'ticket/C-PRE', 'ticket/T-PRE') },
    config: epicConfig,
  });
  const r = JSON.parse(run(root, ['merge', 'C-PRE', '--json'], { env: childEnv() }).stdout).results[0];
  assert.strictEqual(r.merged, false);
  assert.ok(r.blockers.some((b) => /T-PRE/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /pre-authorized/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /lands first/.test(b)), r.blockers.join('; '));
});

test('...and takes it once that parent has ACTUALLY merged (the control)', () => {
  const root = project({
    tickets: childTickets,
    state: {
      'T-PRE': { ...openGreen(11, 'ticket/T-PRE', 'epic/21-x'), status: 'merged' },
      'C-PRE': openGreen(14, 'ticket/C-PRE', 'ticket/T-PRE'),
    },
    config: epicConfig,
  });
  const r = JSON.parse(run(root, ['merge', 'C-PRE', '--json', '--dry-run'], { env: childEnv() }).stdout).results[0];
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

suite('pre-authorization — the journal has to be able to tell the two apart');

test('the merge event carries preauthorized=true, and only when that is why', () => {
  // Design-time authorization is only defensible if it is auditable afterwards:
  // without this the board cannot distinguish "a human approved this in advance"
  // from "the guard merged a checkpoint it should have refused".
  const root = project({
    tickets: {
      'T-PRE': { human_checkpoint: true, preauthorized: true, branch: 'ticket/T-PRE', epic: 'epic/21-x' },
      'T-PLAIN': { branch: 'ticket/T-PLAIN', epic: 'epic/21-x' },
    },
    state: { 'T-PRE': openGreen(9, 'ticket/T-PRE', 'epic/21-x'), 'T-PLAIN': openGreen(10, 'ticket/T-PLAIN', 'epic/21-x') },
    config: epicConfig,
  });
  const gh = stubGh();
  const a = JSON.parse(run(root, ['merge', 'T-PRE', '--json'],
    { env: onPath(gh, { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-PRE', STUB_PR: '9' }) }).stdout).results[0];
  const b = JSON.parse(run(root, ['merge', 'T-PLAIN', '--json'],
    { env: onPath(gh, { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-PLAIN', STUB_PR: '10' }) }).stdout).results[0];
  assert.strictEqual(a.merged, true, (a.blockers || []).join('; '));
  assert.strictEqual(b.merged, true, (b.blockers || []).join('; '));

  const journal = fs.readFileSync(path.join(root, '.planning', 'graph', 'delivery-log.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const pre = journal.find((e) => e.event === 'merge' && e.ticket === 'T-PRE');
  const plain = journal.find((e) => e.event === 'merge' && e.ticket === 'T-PLAIN');
  assert.strictEqual(pre.preauthorized, true, JSON.stringify(pre));
  assert.ok(!Object.prototype.hasOwnProperty.call(plain, 'preauthorized'),
    `an ordinary merge must claim no pre-authorization: ${JSON.stringify(plain)}`);
});

suite('the merge gate reads gh\'s bucket, never a hand-written state list');

// One vocabulary, three consumers. The gate's own copy of the list named
// FAILURE/ERROR/CANCELLED/TIMED_OUT failing and PENDING/QUEUED/IN_PROGRESS/
// EXPECTED pending, so every OTHER state gh can report fell through both filters
// and counted as passed — `failing === 0 && pending === 0` is the green test.
// The merge path is the only place in this file that calls `gh pr checks` for
// real (`duty` reads state-sync's cached tallies), so it is where the change is
// observable.
const arRoot = () => project({
  tickets: { 'T-AR': { branch: 'ticket/T-AR', epic: 'epic/21-x' } },
  state: { 'T-AR': openGreen(9, 'ticket/T-AR', 'epic/21-x') },
  config: epicConfig,
});
const arEnv = (rows) => onPath(stubGh(), {
  STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-AR', STUB_PR: '9', STUB_CHECKS: JSON.stringify(rows),
});
const arMerge = (rows) => JSON.parse(
  run(arRoot(), ['merge', 'T-AR', '--json', '--dry-run'], { env: arEnv(rows) }).stdout
).results[0];

test('ACTION_REQUIRED is a failing check, and the merge is refused', () => {
  // gh calls this row bucket `fail`. The gate's list named neither the state nor
  // the bucket, saw 0 failing / 0 pending, and MERGED.
  const r = arMerge([{ name: 'x', state: 'ACTION_REQUIRED', bucket: 'fail' }]);
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.ok(r.blockers.some((b) => /1 failing check\(s\)/.test(b)), r.blockers.join('; '));
});

test('a cancelled check is failing too — no verdict is not a passing verdict', () => {
  const r = arMerge([{ name: 'x', state: 'CANCELLED', bucket: 'cancel' }]);
  assert.strictEqual(r.would_merge, undefined);
  assert.ok(r.blockers.some((b) => /1 failing check\(s\)/.test(b)), r.blockers.join('; '));
});

test('a row whose bucket the gate cannot read keeps it WAITING, not landing', () => {
  // Fail closed: an unreadable check cannot be green. Pending costs only time —
  // the ticket stays in `waiting.ci` and the next sync looks again.
  const r = arMerge([{ name: 'x', state: 'WAITING' }]);
  assert.strictEqual(r.would_merge, undefined);
  assert.ok(r.blockers.some((b) => /1 check\(s\) still running/.test(b)), r.blockers.join('; '));
});

test('...and a green pipeline still lands (the control)', () => {
  // Without this the three refusals above prove nothing: a gate that refuses
  // everything would satisfy them.
  const r = arMerge([{ name: 'x', state: 'SUCCESS', bucket: 'pass' }]);
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

test('a skipped check is neither failing nor pending, and does not hold the merge', () => {
  const r = arMerge([
    { name: 'x', state: 'SUCCESS', bucket: 'pass' },
    { name: 'y', state: 'SKIPPED', bucket: 'skipping' },
  ]);
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
  assert.strictEqual(r.checks.total, 2, 'a skip is still a check that existed');
});

suite('a conform verdict is bound to the head it judged');

// Б1/D5. The trailer says WHICH diff arch-review judged; nothing used to check
// that the PR still carries that diff. The observed sequence: verdict → undraft
// → a bot review lands on the now-undrafted PR → review-fix pushes → CI goes
// green again → the untouched trailer still reads `conform`, and the guard lands
// a diff the architecture verdict never covered. The T-24-02 guard hit this and
// stripped the trailer by hand to force a re-review; this is that fix.

const SHA_JUDGED = '1111111111111111111111111111111111111111';
const SHA_LIVE = '2222222222222222222222222222222222222222';

test('duty: a trailer for a superseded head is arch-review work, not a merge', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, gate: { ...conform, head: SHA_JUDGED }, head_sha: SHA_LIVE } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'arch-review', d.items[0].why);
  // Both SHAs, or the remedy is a guess: "no conform trailer" would be a lie —
  // there IS one, for code that is no longer on the branch.
  assert.ok(/1111111/.test(d.items[0].why), d.items[0].why);
  assert.ok(/2222222/.test(d.items[0].why), d.items[0].why);
});

test('duty: the same head is a merge (the control)', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, gate: { ...conform, head: SHA_LIVE }, head_sha: SHA_LIVE } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'merge', d.items[0].why);
});

test('duty: a headless trailer on a board that knows the head is absent', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, head_sha: SHA_LIVE } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'arch-review', d.items[0].why);
  assert.ok(/predates head binding/.test(d.items[0].why), d.items[0].why);
});

test('duty: neither side carries a head — the previous release\'s verdict stands', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'merge', d.items[0].why);
});

// The merge gate compares the trailer against the LIVE head, not against the
// board's: the cached head is minutes old, and "it was that diff last tick" is
// the same reasoning the whole live re-verification exists to refuse.
const hbRoot = () => project({
  tickets: { 'T-HB': { branch: 'ticket/T-HB', epic: 'epic/21-x' } },
  state: { 'T-HB': openGreen(9, 'ticket/T-HB', 'epic/21-x') },
  config: epicConfig,
});
const hbMerge = (trailerHead, liveHead) => JSON.parse(run(
  hbRoot(),
  ['merge', 'T-HB', '--json', '--dry-run'],
  {
    env: onPath(stubGh(), {
      STUB_BASE: 'epic/21-x',
      STUB_HEAD: 'ticket/T-HB',
      STUB_PR: '9',
      ...(trailerHead ? { STUB_TRAILER_HEAD: trailerHead } : {}),
      ...(liveHead ? { STUB_HEAD_OID: liveHead } : {}),
    }),
  }
).stdout).results[0];

test('merge refuses a conform trailer that names another head, and names both', () => {
  const r = hbMerge(SHA_JUDGED, SHA_LIVE);
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  const b = r.blockers.join('; ');
  assert.ok(/1111111/.test(b), b);
  assert.ok(/2222222/.test(b), b);
  assert.ok(/arch-review/.test(b), b);
});

test('...and lands it when the trailer names the live head (the control)', () => {
  const r = hbMerge(SHA_LIVE, SHA_LIVE);
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

test('merge refuses a headless trailer once the PR reports a head', () => {
  const r = hbMerge(null, SHA_LIVE);
  assert.strictEqual(r.would_merge, undefined);
  assert.ok(r.blockers.some((x) => /predates head binding/.test(x)), r.blockers.join('; '));
});

test('merge still lands a pre-head-binding PR whose head nothing reports', () => {
  // The upgrade case, and the only direction compatibility runs in.
  const r = hbMerge(null, null);
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

suite('a PR where nothing ran is not a green PR');

// Б3. `none_reported` counted as green all the way through the duty and the
// merge gate, so a PR in a repo whose CI never registered was squashed into the
// epic with no test having run — state-sync's warning about it is a line nobody
// reads at 3am. The honest answer is that the merge is a human's, unless the
// project SAYS it has no CI.

const noCiChecks = { total: 0, failing: 0, pending: 0, none_reported: true };

test('duty: a green + conform PR where nothing ran is a human\'s merge', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: noCiChecks } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'human-merge', d.items[0].why);
  assert.ok(/merge_without_ci/.test(d.items[0].why), d.items[0].why);
  assert.strictEqual(d.actionable_count, 0, 'the guard has nothing it may do here');
});

test('duty: merge_without_ci hands the same PR back to the guard (the control)', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, checks: noCiChecks } },
    config: { pipeline: { merge_without_ci: true } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'merge', d.items[0].why);
});

test('duty: a certified draft where nothing ran is not readied either', () => {
  // `undraft` is one `gh pr ready`, and readying is the step that hands the PR
  // to the guard's own merge. Withholding it leaves the draft flag saying what a
  // draft says while nothing has verified the branch.
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: noCiChecks, draft: true } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'human-merge', d.items[0].why);
  assert.ok(/merge_without_ci/.test(d.items[0].why), d.items[0].why);
});

test('duty: an UNCERTIFIED draft where nothing ran still owes the arch-review', () => {
  // Only the two LANDING actions are withheld. The architecture verdict and the
  // review threads are real work whatever CI did.
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, checks: noCiChecks, draft: true, gate: undefined } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'arch-review', d.items[0].why);
});

test('duty: with auto-merge off the draft is still readied for the human who will merge it', () => {
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, checks: noCiChecks, draft: true } },
    config: { pipeline: { auto_merge: 'off' } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'undraft', d.items[0].why);
});

const noCiEnv = () => onPath(stubGh(), {
  STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-NC', STUB_PR: '9', STUB_CHECKS: '[]',
});
const noCiMerge = (config) => JSON.parse(run(
  project({
    tickets: { 'T-NC': { branch: 'ticket/T-NC', epic: 'epic/21-x' } },
    state: { 'T-NC': openGreen(9, 'ticket/T-NC', 'epic/21-x') },
    config,
  }),
  ['merge', 'T-NC', '--json', '--dry-run'],
  { env: noCiEnv() }
).stdout).results[0];

test('merge refuses a PR with no reported checks, and names the setting that would allow it', () => {
  const r = noCiMerge(epicConfig);
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.ok(r.blockers.some((b) => /merge_without_ci/.test(b)), r.blockers.join('; '));
});

test('...and lands it when the project has declared it has no CI (the control)', () => {
  const r = noCiMerge({ ...epicConfig, pipeline: { merge_without_ci: true } });
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
  assert.ok(/nothing ran/.test(r.checks_note || ''), r.checks_note);
});

suite('a check state that could not be READ is neither empty nor green');

// The fourth state, on both of the guard's paths. `duty` reads it off the board
// state-sync wrote; `merge` reads it LIVE, and that read is the one that lands
// PRs. An unreadable `gh pr checks` used to arrive as an empty list (all-zero
// tallies — the exact shape the merge gate treats as unblocked) and then as a
// synthetic unknown-bucket row, which waits for the right reason while telling
// the operator that one check is still running on a PR nobody read.
//
// Every assertion below therefore pins the TALLY and the WORDS, not only the
// action: `wait-ci` was already the answer under the synthetic row, so a test
// that checked the action alone would pass on the code this replaces.

const unread = (note = 'gh: HTTP 503: Service Unavailable') =>
  ({ total: 0, failing: 0, pending: 0, none_reported: false, unavailable: true, note });

test('duty: an unreadable check state is wait-ci, and the reason names the cause', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: unread() } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  const i = d.items[0];
  assert.strictEqual(i.action, 'wait-ci', i.why);
  assert.ok(/unreadable/.test(i.why), i.why);
  assert.ok(/HTTP 503/.test(i.why), 'the cause gh printed is what makes it actionable');
  assert.ok(!/still running/.test(i.why), 'the synthetic row said exactly that about a check nobody saw');
  assert.strictEqual(d.actionable_count, 0, 'the guard has nothing it may do — and nothing to ask a person');
  assert.strictEqual(d.clear, false, 'nor is the guard done: the next sync reads again');
});

test('duty: it is not the no-CI hold — nobody is asked to confirm a reading that did not happen', () => {
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: unread() } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.notStrictEqual(d.items[0].action, 'human-merge', d.items[0].why);
  assert.ok(!/merge_without_ci/.test(d.items[0].why), d.items[0].why);
});

test('duty: merge_without_ci does not lift it either', () => {
  // The setting is a person saying "this repository has no CI". It says nothing
  // about a call that failed.
  const root = project({
    tickets: { A: {} },
    state: { A: { ...green, checks: unread() } },
    config: { pipeline: { merge_without_ci: true } },
  });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'wait-ci', d.items[0].why);
});

test('duty: a certified draft is not readied on an unreadable answer', () => {
  // `undraft` is the step that hands the PR to this guard's own merge, so it is
  // withheld for the same reason the merge is.
  const root = project({ tickets: { A: {} }, state: { A: { ...green, checks: unread(), draft: true } } });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'wait-ci', d.items[0].why);
});

test('duty: a MOVED BASE still outranks it — the same order the board holds', () => {
  // The permanent case is an old `gh` that cannot answer `--json bucket` at all;
  // routing to `wait-ci` ahead of this would freeze base-merge for the whole run.
  // `merge_state` rides on the review read, which no `pr checks` failure touches.
  const root = project({
    tickets: { 'T-BM': { branch: 'ticket/T-BM', epic: 'epic/21-x' } },
    state: { 'T-BM': { ...openGreen(9, 'ticket/T-BM', 'epic/21-x'), checks: unread() } },
    config: epicConfig,
  });
  const d = JSON.parse(run(root, ['duty', '--json'], {
    env: onPath(stubGh(), { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-BM', STUB_PR: '9', STUB_MERGE_STATE: 'BEHIND' }),
  }).stdout);
  assert.strictEqual(d.items[0].action, 'base-merge', d.items[0].why);
});

// The live read, and the path that actually lands PRs.
const unreadMerge = (env, config) => JSON.parse(run(
  project({
    tickets: { 'T-UR': { branch: 'ticket/T-UR', epic: 'epic/21-x' } },
    state: { 'T-UR': openGreen(9, 'ticket/T-UR', 'epic/21-x') },
    config: config || epicConfig,
  }),
  ['merge', 'T-UR', '--json', '--dry-run'],
  { env: onPath(stubGh(), { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-UR', STUB_PR: '9', ...env }) }
).stdout).results[0];

test('merge refuses when the live check read fails, and quotes what gh said', () => {
  const r = unreadMerge({ STUB_CHECKS_FAIL: 'gh: HTTP 503: Service Unavailable (api.github.com)' });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.ok(r.blockers.some((b) => /HTTP 503/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /could not be read/.test(b)), r.blockers.join('; '));
  assert.strictEqual((r.checks || {}).unavailable, true, 'the fact is recorded, not just refused');
  assert.strictEqual((r.checks || {}).pending, 0, 'no phantom check: nothing was read');
  assert.strictEqual((r.checks || {}).none_reported, false, 'and it is not "this PR has no checks"');
});

test('...and it is refused even where the project declared it has no CI', () => {
  const r = unreadMerge(
    { STUB_CHECKS_FAIL: 'gh: HTTP 503: Service Unavailable' },
    { ...epicConfig, pipeline: { merge_without_ci: true } }
  );
  assert.strictEqual(r.merged, false);
  assert.ok(r.blockers.some((b) => /HTTP 503/.test(b)), r.blockers.join('; '));
});

test('an old gh that rejects --json bucket is the same refusal, not a green', () => {
  // This is the case that made the state permanent rather than transient: the
  // binary cannot answer at all, so every round reads the same nothing.
  const r = unreadMerge({ STUB_CHECKS_FAIL: 'unknown JSON field: "bucket"', STUB_CHECKS_EXIT: '1' });
  assert.strictEqual(r.merged, false);
  assert.ok(r.blockers.some((b) => /bucket/.test(b)), r.blockers.join('; '));
});

test('EXIT CODE IS DATA: exit 1 with a valid [] is an observed empty list, not a failure', () => {
  // `gh pr checks` exits 1 both for a failing check and for a PR with no checks
  // at all, so this is the ordinary no-CI path. It must reach the no-CI hold —
  // the refusal that names the setting — and not the unreadable one.
  const r = unreadMerge({ STUB_CHECKS: '[]', STUB_CHECKS_EXIT: '1' });
  assert.strictEqual(r.merged, false);
  assert.ok(r.blockers.some((b) => /merge_without_ci/.test(b)), r.blockers.join('; '));
  assert.strictEqual((r.checks || {}).none_reported, true);
  assert.strictEqual((r.checks || {}).unavailable, false);
});

test('...and exit 1 with a PASSING row still lands (the exit-code-is-data control)', () => {
  const r = unreadMerge({ STUB_CHECKS: '[{"name":"build","state":"SUCCESS","bucket":"pass"}]', STUB_CHECKS_EXIT: '1' });
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

suite('the squash pins the head the gate was checked against');

// Б5. Every gate above the merge was measured against a head a concurrent push
// can replace between the check and the `gh pr merge`. `gh` has the flag for
// exactly this race, and after T-24-04 the head is already in hand.

function logFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shipyard-ghlog-${tag}-`));
  roots.push(dir);
  return path.join(dir, 'argv.log');
}
const callsIn = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

test('gh pr merge carries --match-head-commit for the head the live view reported', () => {
  const root = project({
    tickets: { 'T-MH': { branch: 'ticket/T-MH', epic: 'epic/21-x' } },
    state: { 'T-MH': openGreen(9, 'ticket/T-MH', 'epic/21-x') },
    config: epicConfig,
  });
  const log = logFile('match');
  const r = JSON.parse(run(root, ['merge', 'T-MH', '--json'], {
    env: onPath(stubGh(), {
      STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-MH', STUB_PR: '9',
      STUB_HEAD_OID: SHA_LIVE, STUB_TRAILER_HEAD: SHA_LIVE, STUB_LOG: log,
    }),
  }).stdout).results[0];
  assert.strictEqual(r.merged, true, (r.blockers || []).join('; '));
  const merge = callsIn(log).find((c) => c.startsWith('pr merge '));
  assert.ok(merge, callsIn(log).join(' | '));
  assert.ok(merge.includes(`--match-head-commit ${SHA_LIVE}`), merge);
});

test('a PR whose head nothing reports still merges — the flag needs a value to pin', () => {
  // The upgrade case: `--match-head-commit ''` would be a malformed call, and a
  // pre-head-binding PR is the one direction compatibility runs in.
  const root = project({
    tickets: { 'T-MH': { branch: 'ticket/T-MH', epic: 'epic/21-x' } },
    state: { 'T-MH': openGreen(9, 'ticket/T-MH', 'epic/21-x') },
    config: epicConfig,
  });
  const log = logFile('nomatch');
  const r = JSON.parse(run(root, ['merge', 'T-MH', '--json'], {
    env: onPath(stubGh(), { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-MH', STUB_PR: '9', STUB_LOG: log }),
  }).stdout).results[0];
  assert.strictEqual(r.merged, true, (r.blockers || []).join('; '));
  const merge = callsIn(log).find((c) => c.startsWith('pr merge '));
  assert.ok(!/--match-head-commit/.test(merge), merge);
});

suite('the stack a child may land into is its OWN phase\'s stack');

// The allowed set was every ticket branch in the repository, from every phase. A
// `pr_base` naming another phase's branch — hand-edited, or read off a stale
// graph by a resumed run — passed the stack check and would have been squashed
// there. A phase is the unit the epic quarantines, so it is the unit the
// boundary measures.

const phaseTickets = {
  'T-24-01': { phase: 24, branch: 'ticket/T-24-01', epic: 'epic/24-x' },
  'T-24-02': { phase: 24, branch: 'ticket/T-24-02', epic: 'epic/24-x', primary_parent: 'T-24-01' },
  'T-23-09': { phase: 23, branch: 'ticket/T-23-09', epic: 'epic/23-x' },
};
const inPhase = (pr, branch, base, epic) => ({ ...openGreen(pr, branch, base), epic });
const phaseMerge = (base) => JSON.parse(run(
  project({
    tickets: phaseTickets,
    state: {
      'T-24-01': inPhase(1, 'ticket/T-24-01', 'epic/24-x', 'epic/24-x'),
      'T-24-02': inPhase(2, 'ticket/T-24-02', base, 'epic/24-x'),
      'T-23-09': inPhase(3, 'ticket/T-23-09', 'epic/23-x', 'epic/23-x'),
    },
    config: epicConfig,
  }),
  ['merge', 'T-24-02', '--json', '--dry-run'],
  { env: onPath(stubGh(), { STUB_BASE: base, STUB_HEAD: 'ticket/T-24-02', STUB_PR: '2' }) }
).stdout).results[0];

test('a base that is another phase\'s ticket branch is outside the stack', () => {
  const r = phaseMerge('ticket/T-23-09');
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.ok(r.blockers.some((b) => /outside the stack/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /ticket\/T-23-09/.test(b)), r.blockers.join('; '));
});

test('...and a parent branch from its own phase is accepted (the control)', () => {
  const r = phaseMerge('ticket/T-24-01');
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

suite('base freshness is measured in the ticket\'s OWN repository, and an unknown answer refuses');

// External audit 2026-09-07, F06. `behindBy` ran `gh api repos/{owner}/{repo}/…
// --repo <o/n>`: `gh api` does not accept `--repo`, and the placeholders resolve
// from the CURRENT repository — so the call errored, `behindBy` returned null,
// and the gate read null as "not behind". The stale-base check was silently
// absent for every foreign-repo ticket.

const foreignRoot = () => project({
  tickets: { 'T-FR': { phase: 24, branch: 'ticket/T-FR', epic: 'epic/24-x', repo: 'acme/other' } },
  state: { 'T-FR': { ...inPhase(9, 'ticket/T-FR', 'epic/24-x', 'epic/24-x'), repo: 'acme/other' } },
  config: epicConfig,
});
const foreignMerge = (env) => JSON.parse(run(foreignRoot(), ['merge', 'T-FR', '--json', '--dry-run'], {
  env: onPath(stubGh(), { STUB_BASE: 'epic/24-x', STUB_HEAD: 'ticket/T-FR', STUB_PR: '9', ...env }),
}).stdout).results[0];

test('the compare is repo-qualified and passes no --repo flag', () => {
  const log = logFile('compare');
  const r = foreignMerge({ STUB_LOG: log });
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
  const cmp = callsIn(log).find((c) => c.startsWith('api repos/') && c.includes('/compare/'));
  assert.ok(cmp, callsIn(log).join(' | '));
  assert.ok(cmp.startsWith('api repos/acme/other/compare/'), `the ticket's own repo, not {owner}/{repo}: ${cmp}`);
  assert.ok(!/--repo/.test(cmp), `gh api does not accept --repo: ${cmp}`);
});

test('a compare gh cannot answer refuses the merge instead of reading as "not behind"', () => {
  const r = foreignMerge({ STUB_COMPARE_FAIL: '1' });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.would_merge, undefined);
  assert.ok(r.blockers.some((b) => /base freshness unproven/.test(b)), r.blockers.join('; '));
  assert.ok(r.blockers.some((b) => /404/.test(b)), 'the gh error itself, or the reason is unactionable');
});

test('GitHub\'s own BEHIND verdict still refuses when the compare cannot be read', () => {
  const r = foreignMerge({ STUB_COMPARE_FAIL: '1', STUB_MERGE_STATE: 'BEHIND' });
  assert.strictEqual(r.would_merge, undefined);
  assert.ok(r.blockers.some((b) => /the base moved/.test(b)), r.blockers.join('; '));
});

suite('the children retargeted after a merge are the ones GitHub has NOW');

// The loop walked cached `state`, so a child whose PR opened after the last sync
// was never retargeted: it went DIRTY on the next sync and waited for a person.
// One `gh pr list --head` per child, on the merge path only — the conveyor's tick
// rate is state-sync's, and this is not it.

const cascadeTickets = {
  'T-P': { phase: 24, branch: 'ticket/T-P', epic: 'epic/24-x' },
  'T-C': { phase: 24, branch: 'ticket/T-C', epic: 'epic/24-x', primary_parent: 'T-P' },
};
const cascadeRoot = (childState) => project({
  tickets: cascadeTickets,
  state: { 'T-P': inPhase(9, 'ticket/T-P', 'epic/24-x', 'epic/24-x'), 'T-C': childState },
  config: epicConfig,
});
const cascadeMerge = (root, log, env) => JSON.parse(run(root, ['merge', 'T-P', '--json'], {
  env: onPath(stubGh(), {
    STUB_BASE: 'epic/24-x', STUB_HEAD: 'ticket/T-P', STUB_PR: '9', STUB_LOG: log, ...env,
  }),
}).stdout).results[0];

test('a child whose PR the board has never seen is retargeted from the live query', () => {
  // As far as the board knows T-C is only branched — its PR is younger than the
  // last sync, which is precisely the case the cached loop could not see.
  const log = logFile('cascade');
  const r = cascadeMerge(
    cascadeRoot({ status: 'branched', branch: 'ticket/T-C', epic: 'epic/24-x', ready: true }),
    log,
    { STUB_CHILD_PRS: JSON.stringify([{ number: 77, baseRefName: 'ticket/T-P' }]) }
  );
  assert.strictEqual(r.merged, true, (r.blockers || []).join('; '));
  assert.deepStrictEqual(
    r.retargeted.map((x) => [x.ticket, x.pr, x.base, x.ok, x.from]),
    [['T-C', 77, 'epic/24-x', true, 'live']]
  );
  const calls = callsIn(log).join('\n');
  assert.ok(/pr list --head ticket\/T-C/.test(calls), calls);
  assert.ok(/pr edit 77 --base epic\/24-x/.test(calls), calls);
});

test('a child already pointed elsewhere is left alone', () => {
  const log = logFile('cascade-elsewhere');
  const r = cascadeMerge(
    cascadeRoot({ status: 'branched', branch: 'ticket/T-C', epic: 'epic/24-x', ready: true }),
    log,
    { STUB_CHILD_PRS: JSON.stringify([{ number: 77, baseRefName: 'epic/24-x' }]) }
  );
  assert.strictEqual(r.merged, true, (r.blockers || []).join('; '));
  assert.deepStrictEqual(r.retargeted, [], 'it is already on the epic — retargeting is idempotent, not repeated');
});

test('when the live query fails the cached board is used, and the result says so', () => {
  const log = logFile('cascade-fallback');
  const r = cascadeMerge(
    cascadeRoot({
      status: 'pr-open', pr: 88, branch: 'ticket/T-C', epic: 'epic/24-x', pr_base: 'ticket/T-P', draft: false,
    }),
    log,
    { STUB_CHILD_FAIL: '1' }
  );
  assert.strictEqual(r.merged, true, (r.blockers || []).join('; '));
  assert.deepStrictEqual(
    r.retargeted.map((x) => [x.ticket, x.pr, x.base, x.ok, x.from]),
    [['T-C', 88, 'epic/24-x', true, 'cache']]
  );
  // A silent fallback is how a stale base becomes a person's problem.
  assert.ok((r.retarget_warnings || []).some((w) => /T-C/.test(w)), JSON.stringify(r.retarget_warnings));
});

suite('duty — a CHANGES_REQUESTED nobody can service belongs to a person');

// A10. `review_decision === 'CHANGES_REQUESTED'` routed to review-fix regardless
// of the thread count. A reviewer who requested changes in a summary comment (or
// a bot whose threads were all resolved while its verdict stood) leaves ZERO
// threads, so review-fix returned having done nothing, the failure signature
// repeated, and the attempt budget escalated a ticket nobody owed work on.

const crRoot = () => project({
  tickets: { 'T-CR': { branch: 'ticket/T-CR', epic: 'epic/24-x' } },
  state: {
    'T-CR': {
      status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform,
      merge_scope: 'stacked', pr_base: 'epic/24-x', epic: 'epic/24-x',
      branch: 'ticket/T-CR', review_decision: 'CHANGES_REQUESTED',
    },
  },
  config: epicConfig,
});
const crEnv = (extra = {}) => onPath(stubGh(), {
  STUB_BASE: 'epic/24-x', STUB_HEAD: 'ticket/T-CR', STUB_PR: '9', ...extra,
});

test('zero unresolved threads → wait-human, with the remedy a person can act on', () => {
  const d = JSON.parse(run(crRoot(), ['duty', '--json'], { env: crEnv() }).stdout);
  const i = d.items[0];
  assert.strictEqual(i.action, 'wait-human', i.why);
  assert.ok(/re-review or dismiss/.test(i.why), i.why);
  assert.strictEqual(d.actionable_count, 0, 'it must not be offered as work');
  assert.strictEqual(d.human_count, 1, 'and it is counted as a PR waiting on a human');
});

test('threads that cannot be read are NOT zero threads — review-fix stands', () => {
  // Fail towards the work: an API hiccup must not park a PR on a human.
  const d = JSON.parse(run(crRoot(), ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.items[0].action, 'review-fix', d.items[0].why);
});

suite('duty — a base that moved is a duty with a remedy, not a refusal');

// Б7. `mergeOne` refused DIRTY/BEHIND with a message and no action; `duty` had no
// action for it at all, so the board offered the merge the gate was about to
// refuse and the documented fix (`base-merge.cjs`) was reachable by prose alone.

const bmRoot = () => project({
  tickets: { 'T-BM': { branch: 'ticket/T-BM', epic: 'epic/24-x' } },
  state: {
    'T-BM': {
      status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform,
      merge_scope: 'stacked', pr_base: 'epic/24-x', epic: 'epic/24-x', branch: 'ticket/T-BM',
    },
  },
  config: epicConfig,
});
const bmDuty = (extra = {}) => JSON.parse(run(bmRoot(), ['duty', '--json'], {
  env: onPath(stubGh(), { STUB_BASE: 'epic/24-x', STUB_HEAD: 'ticket/T-BM', STUB_PR: '9', ...extra }),
}).stdout);

test('mergeStateStatus BEHIND is an actionable base-merge naming the script', () => {
  const d = bmDuty({ STUB_MERGE_STATE: 'BEHIND' });
  const i = d.items[0];
  assert.strictEqual(i.action, 'base-merge', i.why);
  assert.ok(/base-merge\.cjs/.test(i.why), i.why);
  assert.ok(/NEVER rebase|never rebase/.test(i.why), 'the rule travels with the remedy: ' + i.why);
  assert.strictEqual(d.actionable_count, 1, 'the guard can do this one now');
});

test('a stale-but-clean branch is caught by the compare, which reports how far', () => {
  // GitHub only says BEHIND where branch protection requires up-to-date
  // branches; everywhere else a stale branch reports CLEAN.
  const i = bmDuty({ STUB_BEHIND: '3' }).items[0];
  assert.strictEqual(i.action, 'base-merge', i.why);
  assert.strictEqual(i.behind_by, 3);
  assert.ok(/3 commit/.test(i.why), i.why);
});

test('DIRTY names the conflicts instead of a commit count', () => {
  const i = bmDuty({ STUB_MERGE_STATE: 'DIRTY' }).items[0];
  assert.strictEqual(i.action, 'base-merge', i.why);
  assert.ok(/conflict/.test(i.why), i.why);
});

test('an up-to-date branch still merges, and says the base was checked', () => {
  const i = bmDuty().items[0];
  assert.strictEqual(i.action, 'merge', i.why);
  assert.strictEqual(i.base_check, 'clean');
});

test('a base freshness gh could not answer falls through rather than inventing work', () => {
  const i = JSON.parse(run(bmRoot(), ['duty', '--json'], { env: onPath(denyGh()) }).stdout).items[0];
  assert.strictEqual(i.action, 'merge', i.why);
  assert.strictEqual(i.base_check, 'unknown');
});

test('the board answers the same for the same PR — one predicate, two readers', () => {
  const tickets = { 'T-BM': { branch: 'ticket/T-BM', epic: 'epic/24-x' } };
  const state = {
    'T-BM': {
      status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform,
      merge_scope: 'stacked', pr_base: 'epic/24-x', epic: 'epic/24-x', branch: 'ticket/T-BM',
      merge_state: 'BEHIND',
    },
  };
  const f = computeFront(tickets, state, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.fix, ['T-BM']);
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.ok(/base-merge/.test(f.why['T-BM']), f.why['T-BM']);
});

suite('the fix round carries the remedy the duty named');

// The other half of this ticket's rule, and it lives here because the two halves
// are one rule: a duty answer nobody can act on is the defect, so the `base-merge`
// action has to reach the fixer as an instruction. The workflow file cannot be
// imported or `node --check`ed on its own (top-level `return` — the Workflow
// runtime wraps the body in an async function), so it is evaluated exactly the
// way that runtime evaluates it, with `agent` stubbed to capture the prompt.

const FIX_ROUND = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'workflows', 'fix-round.mjs'
);

function runFixRound(args) {
  const src = fs.readFileSync(FIX_ROUND, 'utf8').replace(/^export const meta/m, 'const meta');
  // eslint-disable-next-line no-new-func
  const wf = new Function('agent', 'parallel', 'phase', 'log', 'args',
    `return (async () => {\n${src}\n})()`);
  const prompts = [];
  const agent = (prompt) => {
    prompts.push(prompt);
    return Promise.resolve({ pushed: true, status: 'fixed', notes: 'n', hypothesis: 'h' });
  };
  const parallel = (fns) => Promise.all(fns.map((f) => f()));
  return { prompts, result: wf(agent, parallel, () => {}, () => {}, args) };
}

const FIX_ARGS = (over = {}) => ({
  prs: [{
    id: 'T-24-06', pr: 42, branch: 'ticket/T-24-06', worktreePath: '/wt/T-24-06',
    planPath: '/proj/.planning/phases/24/24-06-PLAN.md', needsCiFix: true,
    base: 'epic/24-x', ...over,
  }],
  ciFixRefPath: '/refs/ci-fix.md',
  reviewFixRefPath: '/refs/review-fix.md',
  reinitScript: '/scripts/reviewers.cjs',
});

test('args that arrived as an unparseable string THROW instead of no-opping', async () => {
  // F25 (external audit 2026-09-07). The catch returned `{}`, so `prs` was
  // empty, the round returned `[]` — and `[]` is exactly what a healthy empty
  // round returns. A malformed dispatch reported success.
  // The message must be the PARSE error: "ciFixRefPath is required" is what the
  // file threw before, and it sent the reader looking at the wrong argument.
  await assert.rejects(() => runFixRound('{invalid').result, /JSON/);
});

test('...and so does a dispatch with no prs array at all', async () => {
  await assert.rejects(() => runFixRound({ ciFixRefPath: 'a', reviewFixRefPath: 'b', reinitScript: 'c' }).result, /prs/);
});

test('an EXPLICITLY empty round is still a success — two facts, two outcomes', async () => {
  assert.deepStrictEqual(await runFixRound({ prs: [] }).result, []);
});

test('needsBaseMerge makes the base merge the FIRST numbered step', async () => {
  const r = runFixRound(FIX_ARGS({ needsBaseMerge: true }));
  await r.result;
  const prompt = r.prompts[0];
  const first = prompt.split('\n').find((l) => /^\s*\d\)/.test(l));
  assert.ok(first, prompt);
  assert.ok(/base-merge\.cjs/.test(first + prompt), first);
  const cmd = prompt.split('\n').find((l) => /base-merge\.cjs/.test(l));
  assert.ok(/--worktree \/wt\/T-24-06/.test(cmd), cmd);
  assert.ok(/--base epic\/24-x/.test(cmd), cmd);
  // Before A) — the base merge is not one remedy among several, it is the step
  // that makes the others measure the right thing.
  assert.ok(prompt.indexOf(cmd) < prompt.indexOf('A) CI is failing'), prompt);
});

test('without it the prompt is byte-identical to the one the fixer got before', async () => {
  const plain = runFixRound(FIX_ARGS());
  await plain.result;
  const moved = runFixRound(FIX_ARGS({ needsBaseMerge: true }));
  await moved.result;
  assert.ok(!/base-merge/.test(plain.prompts[0]), 'no base-merge instruction where the base has not moved');
  const lines = moved.prompts[0].split('\n');
  const from = lines.findIndex((l) => /base-merge/.test(l));
  assert.ok(from >= 0, 'the moved-base prompt must actually carry the instruction');
  let to = from;
  while (to < lines.length && /base-merge/.test(lines[to])) to++;
  if (lines[to] === '') to++;
  assert.strictEqual(lines.slice(0, from).concat(lines.slice(to)).join('\n'), plain.prompts[0]);
});

suite('a corrupt configuration permits no mutation (ADR-004 D2)');

// The audit's own fixture, byte for byte: a config TRUNCATED mid-object that
// contained `auto_merge: "off"`. Before this ticket loadConfig turned it into the
// DEFAULTS — `auto_merge: epic` — dropped the warning, and the guard reported
// `would_merge: true` for a PR the file forbade merging. The ticket that could
// not be told apart from an absent file is the whole defect.
const TRUNCATED = '{"pipeline": {"auto_merge": "off"';
const cfgTickets = { 'T-OK': { branch: 'ticket/T-OK', epic: 'epic/21-x' } };
const cfgState = { 'T-OK': openGreen(9, 'ticket/T-OK', 'epic/21-x') };
const cfgEnv = () => onPath(stubGh(), { STUB_BASE: 'epic/21-x', STUB_HEAD: 'ticket/T-OK', STUB_PR: '9' });

test('the control: with a VALID config this very PR is a dry-run merge', () => {
  // Without this the refusal below proves nothing — a gate that refused
  // everything would satisfy it just as well.
  const root = project({ tickets: cfgTickets, state: cfgState, config: { pipeline: {}, git: { base_branch: 'main' } } });
  const r = JSON.parse(run(root, ['merge', 'T-OK', '--json', '--dry-run'], { env: cfgEnv() }).stdout).results[0];
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

test('merge --dry-run refuses on a truncated config and NAMES the file', () => {
  const root = project({ tickets: cfgTickets, state: cfgState, configRaw: TRUNCATED });
  const out = JSON.parse(run(root, ['merge', 'T-OK', '--json', '--dry-run'], { env: cfgEnv() }).stdout);
  const r = out.results[0];
  assert.strictEqual(r.would_merge, undefined, 'not even a dry run may say it would land');
  assert.strictEqual(r.merged, false);
  assert.ok(/config unreadable/.test(r.blockers[0]), r.blockers.join('; '));
  assert.ok(r.blockers[0].includes(path.join('.planning', 'config.json')),
    `the refusal must name the file a person can open: ${r.blockers[0]}`);
  assert.ok(/not valid JSON/.test(r.blockers[0]), r.blockers[0]);
  assert.strictEqual(out.auto_merge, 'off', 'the default epic policy must not be reported as in effect');
  assert.strictEqual(out.config_valid, false);
});

test('the config refusal comes FIRST — before the ticket lookup', () => {
  // `unknown ticket` would send a reader to the graph looking for a defect that
  // is in one file it can open.
  const root = project({ tickets: cfgTickets, state: cfgState, configRaw: TRUNCATED });
  const r = JSON.parse(run(root, ['merge', 'NOPE', '--json'], { env: onPath(denyGh()) }).stdout).results[0];
  assert.ok(/config unreadable/.test(r.blockers[0]), r.blockers.join('; '));
});

test('merge --all does not report an empty board — it reports the refusal', () => {
  // `results: []` alone reads as "nothing is mergeable right now", which is the
  // silent success this rule exists to forbid.
  const root = project({ tickets: cfgTickets, state: cfgState, configRaw: TRUNCATED });
  const out = run(root, ['merge', '--all', '--json'], { env: onPath(denyGh()) });
  assert.strictEqual(out.status, 0, 'a refusal is data, not a crash');
  const j = JSON.parse(out.stdout);
  assert.deepStrictEqual(j.results, []);
  assert.ok(/config unreadable/.test(j.refusal), j.refusal);
  const text = run(root, ['merge', '--all'], { env: onPath(denyGh()) }).stdout;
  assert.ok(/refused/.test(text) && /config unreadable/.test(text), text);
  assert.ok(!/nothing is mergeable/.test(text), text);
});

test('duty emits ONE config-invalid line and no actions at all', () => {
  const root = project({ tickets: cfgTickets, state: cfgState, configRaw: TRUNCATED });
  const d = JSON.parse(run(root, ['duty', '--json'], { env: onPath(denyGh()) }).stdout);
  assert.strictEqual(d.config_valid, false);
  assert.deepStrictEqual(d.items, [], 'every action is a dispatch decision taken from the policy');
  assert.strictEqual(d.actionable_count, 0);
  assert.strictEqual(d.auto_merge, 'off');
  assert.strictEqual(d.clear, false, 'nothing is finished — a person owes a one-line fix');
  const lines = run(root, ['duty'], { env: onPath(denyGh()) }).stdout.trim().split('\n');
  assert.strictEqual(lines.length, 1, `one line, not a board: ${lines.join(' | ')}`);
  assert.ok(/^config-invalid: /.test(lines[0]), lines[0]);
  assert.ok(lines[0].includes(path.join('.planning', 'config.json')), lines[0]);
});

test('a config that parses to null is a refusal, not a stack trace', () => {
  // `JSON.parse('null')` returns null and `raw.pipeline` threw a TypeError on it,
  // so this fixture used to take the whole guard down with a Node stack.
  const root = project({ tickets: cfgTickets, state: cfgState, configRaw: 'null' });
  const out = run(root, ['merge', 'T-OK', '--json'], { env: onPath(denyGh()) });
  assert.strictEqual(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout).results[0];
  assert.ok(/not a JSON object/.test(r.blockers[0]), r.blockers.join('; '));
});

test('an ABSENT config is untouched by all of this — the defaults still apply', () => {
  // The other half of the distinction. Nobody has configured this project yet,
  // and `epic` is the right answer.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sentinel-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: cfgTickets, epics: {} }));
  fs.writeFileSync(path.join(root, '.planning', 'graph', 'delivery-state.json'), JSON.stringify(cfgState));
  const r = JSON.parse(run(root, ['merge', 'T-OK', '--json', '--dry-run'], { env: cfgEnv() }).stdout).results[0];
  assert.strictEqual(r.would_merge, true, (r.blockers || []).join('; '));
});

for (const r of roots) {
  try { execFileSync('rm', ['-rf', r]); } catch { /* best effort */ }
}

done();
