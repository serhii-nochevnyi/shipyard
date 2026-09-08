'use strict';

// "IS THIS TICKET'S PARENT STILL MOVING?" — asked by the guard and by the board,
// and until this ticket it was implemented once, inside sentinel.cjs.
//
// The consequence was measured, not theorised: `duty` answered `wait-parent`
// while `computeFront` put the very same ticket in `finalize`/`fix`/`merge`. The
// main loop dispatched nothing (those buckets belong to the guard), the guard
// answered `wait-parent` again, `ci-wait.cjs` refused because something was
// "actionable", and the stop gate blocked on top of it — round after round, with
// the guard "declining the work the front offered".
//
// So the ONE thing this file has to prove is that the two answers come from one
// place. Every test below drives BOTH readers from the SAME fixture: the sentinel
// through a project on disk, `computeFront` over the very same objects. Two
// parallel suites, one per file, is the shape that let them drift.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const SENTINEL = path.join(SCRIPTS, 'sentinel.cjs');
const { movingParentOf, parentIsMoving, movingParentWhy } = require(path.join(SCRIPTS, 'parent-moving.cjs'));
const { computeFront, formatFront } = require(path.join(SCRIPTS, 'front.cjs'));

const roots = [];

// The stubbed-gh setup from sentinel.test.cjs. `duty` is pure over the cached
// state for everything under test here, so the only `gh` any case needs is one
// that REFUSES: it proves no assertion below depends on GitHub.
function project({ tickets, state, config }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-parentmoving-'));
  roots.push(root);
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets, epics: {} }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config || { pipeline: {} }));
  return root;
}

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

function duty(root, args = []) {
  const r = spawnSync(process.execPath, [SENTINEL, 'duty', '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: denyGh() + path.delimiter + process.env.PATH },
  });
  const d = JSON.parse(r.stdout);
  return { summary: d, byId: Object.fromEntries(d.items.map((i) => [i.ticket, i])) };
}

const checks = (failing = 0, pending = 0, total = 3) => ({ total, failing, pending, none_reported: total === 0 });
const conform = { 'arch-review': 'conform', 'drift-check': 'fresh', checks: 'green' };

// THE FIXTURE, shared by both readers. A parent whose PR is open with checks
// still running, and a child that is green, conform and stacked on the parent's
// branch — i.e. a ticket that is ready in every respect except that its base is
// about to move under it.
const tickets = {
  P: { branch: 'ticket/P', epic: 'epic/24-x' },
  C: { primary_parent: 'P', branch: 'ticket/C', epic: 'epic/24-x' },
};
const state = {
  P: {
    status: 'pr-open', pr: 1, draft: false, checks: checks(0, 2),
    branch: 'ticket/P', epic: 'epic/24-x', pr_base: 'epic/24-x', merge_scope: 'stacked',
  },
  C: {
    status: 'pr-open', pr: 2, draft: false, checks: checks(), gate: conform,
    branch: 'ticket/C', epic: 'epic/24-x', pr_base: 'ticket/P', merge_scope: 'stacked',
  },
};

const bucketOf = (f, id) => {
  for (const [k, v] of Object.entries(f.actionable)) if (v.includes(id)) return `actionable.${k}`;
  for (const [k, v] of Object.entries(f.waiting)) if (v.includes(id)) return `waiting.${k}`;
  for (const [k, v] of Object.entries(f.parked)) if (v.includes(id)) return `parked.${k}`;
  return 'nowhere';
};

suite('parent-moving — the guard and the board answer from one predicate');

test('a green child of a moving parent is wait-parent for the guard AND waiting.parent on the board', () => {
  const root = project({ tickets, state });
  const { summary, byId } = duty(root);
  // project()'s default config leaves auto_merge at 'epic' and integration_mode
  // at 'epic-stacked', which is what AUTO_MERGE resolves to inside the
  // subprocess — so `{ autoMerge: true }` asks the board the SAME question.
  // Asserted rather than assumed: a config drift here would make the two sides
  // disagree for a reason that has nothing to do with the predicate.
  assert.strictEqual(summary.auto_merge, 'epic');
  const f = computeFront(tickets, state, { autoMerge: true });

  assert.strictEqual(byId.C.action, 'wait-parent', byId.C.why);
  assert.strictEqual(bucketOf(f, 'C'), 'waiting.parent', `${bucketOf(f, 'C')}: ${f.why.C}`);
  // …and the parent is the pipeline being waited for, on both sides.
  assert.strictEqual(byId.P.action, 'wait-ci', byId.P.why);
  assert.strictEqual(bucketOf(f, 'P'), 'waiting.ci', `${bucketOf(f, 'P')}: ${f.why.P}`);

  // The invariant, DERIVED from the two answers rather than restated as a third
  // table: the guard's actionable names and the board's actionable buckets must
  // hold the same set. This fixture's answer is "nothing", which is exactly the
  // case that used to disagree — the board offered `merge: C`.
  const GUARD_ACTIONABLE = new Set(['ci-fix', 'review-fix', 'arch-review', 'undraft', 'merge']);
  const guardActionable = summary.items.filter((i) => GUARD_ACTIONABLE.has(i.action)).map((i) => i.ticket).sort();
  const boardActionable = Object.values(f.actionable).flat().sort();
  assert.deepStrictEqual(guardActionable, boardActionable,
    `guard actionable ${guardActionable} vs board actionable ${boardActionable}`);
  assert.deepStrictEqual(boardActionable, [], 'and there is nothing to start while the parent runs');
  assert.strictEqual(f.actionable_count, 0);
  assert.strictEqual(f.fixpoint, false, 'a parent still moving is not an ending');
});

test('a RED child is held too, because the guard tests the parent BEFORE the checks', () => {
  // `dutyItems` puts `parentIsMoving` ahead of `ci-fix`: fixing a child now buys
  // a green that the base move undoes — CI re-runs against different code and
  // reviewers re-read a changed diff. If the board tested the checks first, the
  // two would disagree on precisely the tickets that cost CI twice.
  const redChild = { ...state, C: { ...state.C, checks: checks(2, 0) } };
  const { byId } = duty(project({ tickets, state: redChild }));
  const f = computeFront(tickets, redChild, { autoMerge: true });
  assert.strictEqual(byId.C.action, 'wait-parent', byId.C.why);
  assert.strictEqual(bucketOf(f, 'C'), 'waiting.parent', f.why.C);
  assert.deepStrictEqual(f.actionable.fix, [], 'not fix work while the base is about to move');
});

test('a landed parent releases the child on both sides at once', () => {
  // The control. Without it every assertion above would be satisfied by a rule
  // that simply never releases anything.
  const landed = { ...state, P: { ...state.P, status: 'merged' } };
  const { byId } = duty(project({ tickets, state: landed }));
  const f = computeFront(tickets, landed, { autoMerge: true });
  assert.strictEqual(byId.C.action, 'merge', byId.C.why);
  assert.deepStrictEqual(f.actionable.merge, ['C'], f.why.C);
  assert.deepStrictEqual(f.waiting.parent, []);
});

test('a PARKED parent is not a moving parent — for the guard and for the board', () => {
  // The parked clause of the predicate. Nobody is driving a parked parent, so
  // waiting behind it would freeze the subtree for as long as the park lasts. The
  // guard reads `--parked` ∪ escalations ∪ drift verdicts; the board holds the
  // same three facts under three option names and must build the same union.
  const { byId } = duty(project({ tickets, state }), ['--parked', 'P']);
  const f = computeFront(tickets, state, { autoMerge: true, parked: ['P'] });
  assert.strictEqual(byId.C.action, 'merge', byId.C.why);
  assert.deepStrictEqual(f.actionable.merge, ['C'], f.why.C);
  assert.deepStrictEqual(f.waiting.parent, []);
  // A drift verdict on the parent is the same fact through the board's other
  // channel, and must not answer differently.
  const drifted = computeFront(tickets, state, { autoMerge: true, drifted: { P: 'plan predates what shipped' } });
  assert.deepStrictEqual(drifted.waiting.parent, []);
  assert.deepStrictEqual(drifted.actionable.merge, ['C']);
});

test('a CHECKPOINT parent is the OTHER hold, and the two are not confused', () => {
  // `human_checkpoint` and NOT `needsHuman`, deliberately: this exception is
  // about driving a child to GREEN. Narrowing it to un-authorized parents would
  // make the guard answer `wait-parent` for a red child of a pre-authorized
  // parent while the board answers `fix`. The MERGE-side hold on a checkpoint
  // parent is a separate rule and is unaffected — the child still does not land,
  // it just waits on a person rather than on the guard.
  const cpTickets = { ...tickets, P: { ...tickets.P, human_checkpoint: true } };
  const cpState = { ...state, P: { ...state.P, checks: checks(), gate: conform } };
  const { byId } = duty(project({ tickets: cpTickets, state: cpState }));
  const f = computeFront(cpTickets, cpState, { autoMerge: true });
  assert.strictEqual(byId.C.action, 'wait-parent', byId.C.why);
  assert.ok(/human_checkpoint/.test(byId.C.why), byId.C.why);
  assert.strictEqual(bucketOf(f, 'C'), 'waiting.human', f.why.C);
  assert.deepStrictEqual(f.waiting.parent, [], 'nobody is DRIVING a checkpoint parent');
  // And the predicate itself says so, at both spellings of the flag.
  assert.strictEqual(parentIsMoving('C', { tickets: cpTickets, state: cpState }), false);
  assert.strictEqual(
    parentIsMoving('C', {
      tickets: { ...cpTickets, P: { ...cpTickets.P, preauthorized: true } }, state: cpState,
    }),
    false,
    'pre-authorization does not turn a checkpoint parent into one the guard is driving',
  );
});

suite('parent-moving — what the board hands to ci-wait.cjs');

test('the board names the parent, so the waiter watches the right pipeline', () => {
  // `ci-wait.cjs` reads the front and delivery-state, and nothing else. The front
  // is therefore the one place that answers "what is this run waiting for" — the
  // waiter must not re-derive `primary_parent` from tickets.json, which is the
  // duplication this whole ticket removes.
  const f = computeFront(tickets, state, { autoMerge: true });
  assert.deepStrictEqual(f.waiting.parent, ['C']);
  assert.strictEqual(f.parent_of.C, 'P');
  assert.strictEqual(Object.keys(f.parent_of).length, 1, 'only held children appear');
});

test('the held child is counted, rendered and owned', () => {
  const f = computeFront(tickets, state, { autoMerge: true });
  assert.strictEqual(f.counts.parent, 1, 'counted, so no summary can omit it');
  assert.deepStrictEqual(f.sentinel.waiting_parent, ['C'], 'the guard owns it (deliver.md marks it [SENTINEL])');
  assert.strictEqual(f.sentinel.clear, false, 'so the board never calls the guard clear over a held subtree');
  const out = formatFront(f).join('\n');
  assert.ok(/waiting: [^\n]*parent: C→P/.test(out), out);
  assert.ok(/ci-wait\.cjs/.test(out), 'and the verdict names the one legitimate wait');
  assert.ok(!/watch is legal/.test(out), 'never a `gh pr checks --watch`');
});

suite('parent-moving — the module in isolation');

test('movingParentOf returns the parent id, and parentIsMoving is the same answer', () => {
  assert.strictEqual(movingParentOf('C', { tickets, state }), 'P');
  assert.strictEqual(parentIsMoving('C', { tickets, state }), true);
  assert.strictEqual(movingParentOf('P', { tickets, state }), null, 'a root has no parent');
  assert.strictEqual(parentIsMoving('P', { tickets, state }), false);
});

test('a parent that has not been published yet is nothing to wait for', () => {
  const unpublished = { ...state, P: { status: 'pending', ready: true } };
  assert.strictEqual(movingParentOf('C', { tickets, state: unpublished }), null);
  const branched = { ...state, P: { status: 'branched', ready: true } };
  assert.strictEqual(movingParentOf('C', { tickets, state: branched }), null);
});

test('the parked argument takes a Set, an array, or nothing at all', () => {
  assert.strictEqual(parentIsMoving('C', { tickets, state, parked: new Set(['P']) }), false);
  assert.strictEqual(parentIsMoving('C', { tickets, state, parked: ['P'] }), false);
  assert.strictEqual(parentIsMoving('C', { tickets, state, parked: new Set(['X']) }), true, 'someone else\'s park');
  assert.strictEqual(parentIsMoving('C', { tickets, state, parked: null }), true, 'a caller that tracks no parks');
});

test('a missing or malformed graph answers false rather than throwing', () => {
  // Both callers hand this whatever they read off disk. A predicate the board
  // consults for every open PR must not be the thing that takes a sync down.
  assert.strictEqual(parentIsMoving('C', {}), false);
  assert.strictEqual(parentIsMoving('C', { tickets: {}, state: {} }), false);
  assert.strictEqual(parentIsMoving('nope', { tickets, state }), false);
  assert.strictEqual(movingParentOf('C', { tickets, state: {} }), null, 'a parent with no state row');
});

test('the reason says what the parent is DOING, not merely that it exists', () => {
  // "stacked on P" with no verb makes the reader open GitHub to find out whether
  // anyone is driving it — which is the question the board exists to answer.
  assert.ok(/2 check\(s\) still running/.test(movingParentWhy('P', state)), movingParentWhy('P', state));
  assert.ok(/3 failing/.test(movingParentWhy('P', { P: { pr: 1, checks: checks(3, 0) } })));
  assert.ok(/draft/.test(movingParentWhy('P', { P: { pr: 1, draft: true, checks: checks() } })));
  assert.ok(/green/.test(movingParentWhy('P', { P: { pr: 1, checks: checks() } })));
  assert.ok(/its PR/.test(movingParentWhy('P', {})), 'and it never invents a PR number');
});

for (const r of roots) {
  try { execFileSync('rm', ['-rf', r]); } catch { /* best effort */ }
}

done();
