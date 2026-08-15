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

function run(root, args) {
  const r = spawnSync(process.execPath, [SENTINEL, ...args], { cwd: root, encoding: 'utf8' });
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

for (const r of roots) {
  try { execFileSync('rm', ['-rf', r]); } catch { /* best effort */ }
}

done();
