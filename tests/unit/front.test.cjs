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

test('approved + green + out of draft is a human merge — fixpoint-compatible', () => {
  const f = computeFront({ T: {} }, { T: { status: 'pr-open', pr: 7, draft: false, review_decision: 'APPROVED', checks: checks() } });
  assert.deepStrictEqual(f.waiting.merge, ['T']);
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

done();
