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

function project({ tickets, state, config }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sentinel-'));
  roots.push(root);
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets, epics: {} }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config || { pipeline: {} }));
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
    'case "$argv" in',
    '  "pr view "*)',
    '    printf \'{"number":%s,"state":"OPEN","isDraft":false,"baseRefName":"%s","headRefName":"%s","mergeStateStatus":"CLEAN","reviewDecision":null,"body":"gate_status: arch-review=conform, checks=green"}\\n\' "${STUB_PR:-9}" "${STUB_BASE}" "${STUB_HEAD}" ;;',
    '  "pr checks "*) echo \'[{"name":"test-fast","state":"SUCCESS"}]\' ;;',
    '  "repo view --json owner,name"*) echo \'{"owner":{"login":"acme"},"name":"demo"}\' ;;',
    '  "repo view --json defaultBranchRef"*) echo "main" ;;',
    '  "api graphql"*) echo \'{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\' ;;',
    '  "api repos/{owner}/{repo}/compare/"*) echo "${STUB_BEHIND:-0}" ;;',
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

for (const r of roots) {
  try { execFileSync('rm', ['-rf', r]); } catch { /* best effort */ }
}

done();
