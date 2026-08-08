'use strict';

// The actionable front IS the run's stop condition, so its edge cases are the
// ones that cost whole sessions: a PR waiting on CI must not read as a fixpoint,
// and it must not read as "block here" either.

const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const { computeFront, formatFront } = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'front.cjs'
));

const checks = (failing = 0, pending = 0, total = 3) => ({ total, failing, pending, none_reported: total === 0 });

suite('front — actionable buckets');

test('a ready pending ticket is executable work', () => {
  const f = computeFront({ 'T-01-01': {} }, { 'T-01-01': { status: 'pending', ready: true } });
  assert.deepStrictEqual(f.actionable.execute, ['T-01-01']);
  assert.strictEqual(f.fixpoint, false);
});

test('a branched ticket with no PR is publish work, not a curiosity', () => {
  const f = computeFront({ 'T-01-02': {} }, { 'T-01-02': { status: 'branched', ready: true, needs_pr: true } });
  assert.deepStrictEqual(f.actionable.publish, ['T-01-02']);
  assert.strictEqual(f.fixpoint, false);
});

test('failing checks are fix work', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, checks: checks(2, 0) } });
  assert.deepStrictEqual(f.actionable.fix, ['T']);
});

test('green + draft is finalize work (threads, arch-review, conform, undraft)', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: true, checks: checks() } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('green, out of draft, review unsettled is still finalize work', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: false, review_decision: null, checks: checks() } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a PR with no checks reported counts as green rather than stalling the front', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: true, checks: checks(0, 0, 0) } });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

suite('front — waiting is not a fixpoint and not a reason to block');

test('pending checks are waiting:ci, NOT actionable, NOT a fixpoint', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, checks: checks(0, 3) } });
  assert.strictEqual(f.actionable_count, 0);
  assert.deepStrictEqual(f.waiting.ci, ['T']);
  assert.strictEqual(f.fixpoint, false, 'a running CI queue is not a fixpoint');
});

test('watching CI is only sanctioned when nothing else is actionable', () => {
  const busy = computeFront(
    { A: {}, B: {} },
    { A: { status: 'pr-open', pr: 1, checks: checks(0, 2) }, B: { status: 'pending', ready: true } }
  );
  assert.ok(formatFront(busy).join('\n').includes('actionable RIGHT NOW'));
  const idle = computeFront({ A: {} }, { A: { status: 'pr-open', pr: 1, checks: checks(0, 2) } });
  assert.ok(formatFront(idle).join('\n').includes('watch is legal here'));
});

test('approved + green + out of draft is a human merge when auto-merge is off', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: false, review_decision: 'APPROVED', checks: checks() } });
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a checkpoint ticket out of draft waits on the human, not on the run', () => {
  const f = computeFront(
    { T: { human_checkpoint: true } },
    { T: { status: 'pr-open', pr: 7, draft: false, review_decision: null, checks: checks() } }
  );
  assert.deepStrictEqual(f.waiting.human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a checkpoint ticket that has NOT been worked on is still executable', () => {
  // the failure mode: "there is a human gate" read as "do nothing at all"
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { status: 'pending', ready: true } });
  assert.deepStrictEqual(f.actionable.execute, ['T']);
  assert.strictEqual(f.fixpoint, false);
});

suite('front — auto-merge turns the merge tail into the sentinel\'s work');

const conform = { 'arch-review': 'conform', 'drift-check': 'fresh', checks: 'green' };
const landed = { status: 'pr-open', pr: 9, draft: false, checks: checks(), gate: conform, merge_scope: 'stacked', pr_base: 'epic/01-x' };

test('green + conform + stacked base is a merge the run performs itself', () => {
  const f = computeFront({ T: {} }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, ['T']);
  assert.strictEqual(f.fixpoint, false, 'an unmerged, mergeable PR is not a fixpoint');
  assert.ok(f.why.T.includes('squash into epic/01-x'));
});

test('the same PR without auto-merge stays a human action (unchanged behaviour)', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, review_decision: 'APPROVED' } });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.strictEqual(f.fixpoint, true);
});

test('a PR pointed at the integration branch is NEVER auto-merged', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, merge_scope: 'integration', pr_base: 'main' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.merge_human, ['T']);
  assert.ok(f.why.T.includes('a human'));
});

test('no gate_status trailer means the conform gate is still owed, not a merge', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, gate: undefined } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
  assert.deepStrictEqual(f.actionable.merge, []);
});

test('CHANGES_REQUESTED blocks the auto-merge even with a conform trailer', () => {
  const f = computeFront({ T: {} }, { T: { ...landed, review_decision: 'CHANGES_REQUESTED' } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.actionable.finalize, ['T']);
});

test('a human_checkpoint ticket is never auto-merged, however green', () => {
  const f = computeFront({ T: { human_checkpoint: true } }, { T: { ...landed } }, { autoMerge: true });
  assert.deepStrictEqual(f.actionable.merge, []);
  assert.deepStrictEqual(f.waiting.human, ['T']);
});

suite('front — sentinel ownership');

test('fix/finalize/merge are the sentinel\'s duty, execute/publish are not', () => {
  const f = computeFront(
    { A: {}, B: {}, C: {}, D: {} },
    {
      A: { status: 'pending', ready: true },
      B: { status: 'pr-open', pr: 1, checks: checks(1, 0) },
      C: { ...landed, pr: 2 },
      D: { status: 'branched', ready: true, needs_pr: true },
    },
    { autoMerge: true }
  );
  assert.deepStrictEqual(f.sentinel.duty.sort(), ['B', 'C']);
  assert.strictEqual(f.sentinel.clear, false);
});

test('a PR waiting on CI keeps the guard posted even with nothing actionable', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 1, checks: checks(0, 2) } });
  assert.deepStrictEqual(f.sentinel.duty, []);
  assert.deepStrictEqual(f.sentinel.waiting_ci, ['T']);
  assert.strictEqual(f.sentinel.clear, false, 'the guard is not done while CI is running');
  assert.ok(formatFront(f).join('\n').includes('sentinel: 0 duty'));
});

test('an all-merged graph leaves no guard behind', () => {
  const f = computeFront({ T: {} }, { T: { status: 'merged' } });
  assert.strictEqual(f.sentinel.clear, true);
  assert.ok(formatFront(f).join('\n').includes('sentinel: clear'));
});

suite('front — parked');

test('blocked tickets are parked with their reason and do not prevent a fixpoint', () => {
  const f = computeFront(
    { T: {} },
    { T: { status: 'pending', ready: false, blocked_by: ['P'], blocked_reasons: { P: 'parent has no branch yet' } } }
  );
  assert.deepStrictEqual(f.parked.blocked, ['T']);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(f.why.T.includes('parent has no branch yet'));
});

test('a run-parked PR leaves the front (otherwise babysit loops forever)', () => {
  const state = { T: { status: 'pr-open', pr: 7, checks: checks(1, 0) } };
  assert.strictEqual(computeFront({ T: {} }, state).actionable_count, 1);
  const f = computeFront({ T: {} }, state, { parked: ['T'] });
  assert.strictEqual(f.actionable_count, 0);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(f.why.T.includes('parked by this run'));
});

test('merged tickets are done, and an all-merged graph is a fixpoint', () => {
  const f = computeFront({ T: {} }, { T: { status: 'merged', pr: 7 } });
  assert.deepStrictEqual(f.parked.done, ['T']);
  assert.strictEqual(f.fixpoint, true);
  assert.ok(formatFront(f).join('\n').includes('fixpoint: YES'));
});

test('counts cover every ticket exactly once', () => {
  const tickets = { A: {}, B: {}, C: {}, D: {} };
  const state = {
    A: { status: 'pending', ready: true },
    B: { status: 'pr-open', pr: 1, checks: checks(0, 1) },
    C: { status: 'merged' },
    D: { status: 'pending', ready: false, blocked_by: ['A'] },
  };
  const f = computeFront(tickets, state);
  const total = Object.values(f.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 4);
});

test('a drift verdict parks the ticket, and expires when the plan is re-planned', () => {
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const script = path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'drift-record.cjs'
  );
  const { activeDrift } = require(script);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-drift-'));
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  const plan = path.join(dir, 'PLAN.md');
  fs.writeFileSync(plan, '# plan v1\n');

  execFileSync('node', [script, 'mark', 'T-01-01', plan, 'landed under other names'], { cwd: dir });
  const first = activeDrift(dir);
  assert.strictEqual(first['T-01-01'], 'landed under other names');

  // A ready ticket that would otherwise be executable must be parked instead.
  const tickets = { 'T-01-01': { phase: '1' } };
  const state = { 'T-01-01': { status: 'pending', ready: true } };
  const parkedFront = computeFront(tickets, state, { drifted: first });
  assert.strictEqual(parkedFront.actionable.execute.length, 0, 'a drifted ticket must not be executable');
  assert.ok(parkedFront.parked.blocked.includes('T-01-01'));
  assert.ok(/re-plan/i.test(parkedFront.why['T-01-01']), parkedFront.why['T-01-01']);

  // …and re-planning the ticket must lift the park without anyone remembering
  // to clear it. A verdict that outlived its plan would be the worse failure:
  // the run would insist on staleness that had already been fixed.
  fs.writeFileSync(plan, '# plan v2 — re-planned against what shipped\n');
  assert.deepStrictEqual(activeDrift(dir), {}, 'the verdict must expire when the plan changes');
  const freshFront = computeFront(tickets, state, { drifted: activeDrift(dir) });
  assert.deepStrictEqual(freshFront.actionable.execute, ['T-01-01']);
});

test('every actionable bucket names roles the model ladder actually knows', () => {
  const { ROLES } = require(path.join(
    __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'
  ));
  const { roles } = computeFront({}, {});
  assert.ok(roles && typeof roles === 'object', 'the front must publish its bucket → role mapping');

  // The buckets and the ladder are two vocabularies for the same work
  // (`execute` vs `executor`, `merge` vs `pr-sentinel`). A run that reads the
  // board and logs the BUCKET name gets a role the ladder declines to route —
  // observed in the field as attempts logged under `finalize` and `merge`. The
  // mapping is what makes that unnecessary, so it has to stay true.
  for (const [bucket, list] of Object.entries(roles)) {
    assert.ok(Array.isArray(list), `roles.${bucket} must be an array`);
    for (const r of list) {
      assert.ok(ROLES.includes(r), `roles.${bucket} names "${r}", which is not a pipeline role`);
    }
  }

  // Every bucket the front can put work in must be covered — a new bucket with
  // no entry is exactly how the gap reappears.
  const { actionable } = computeFront({}, {});
  for (const bucket of Object.keys(actionable)) {
    assert.ok(bucket in roles, `bucket "${bucket}" has no entry in the role mapping`);
  }
});

done();
