'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const signatures = require('../../plugins/delivery-pipeline/scripts/review-signature.cjs');
const { resourceState } = require('../../plugins/delivery-pipeline/scripts/failure-signature.cjs');

const finding = (extra = {}) => ({
  id: 'PRRT_kwA',
  path: '/runner/work/app/app/src/service.ts',
  line: 42,
  comments: ['[security] validate the token before using it'],
  ...extra,
});

test('reposted review finding keeps one stable signature and preserves provenance', () => {
  const a = signatures.findingIdentity(finding());
  const b = signatures.findingIdentity(finding({ id: 'PRRT_kwB', url: 'https://example.test/thread/2' }));
  assert.equal(a.signature, b.signature);
  assert.equal(a.identity.rule_class, 'security');
  assert.equal(a.identity.path, 'src/service.ts');
  assert.equal(a.identity.line, 42);
  assert.equal(a.provenance.thread_id, 'PRRT_kwA');
});

test('new, resolved, unchanged, oscillating and unknown findings are distinguishable', () => {
  const a = signatures.snapshot([finding()]);
  const b = signatures.snapshot([finding({ id: 'PRRT_kwC', line: 43 })]);
  const c = signatures.snapshot([]);
  const d = signatures.snapshot([finding()]);
  assert.equal(signatures.compare(a, b).added.length, 1);
  assert.equal(signatures.compare(a, c).resolved.length, 1);
  assert.equal(signatures.progress([a], a).state, 'unchanged');
  assert.equal(signatures.progress([a, b, c], d).state, 'oscillating');
  const unknown = signatures.snapshot([{ id: 'no-location', comments: ['a review'] }]);
  assert.equal(unknown.coverage.unknown, 1);
  assert.equal(signatures.progress([a], unknown).state, 'unknown');
});

test('resource exhaustion is a checkpoint signal, never a failure verdict', () => {
  const got = resourceState([
    { event: 'attempt', tokens_used: 80, duration_ms: 100 },
    { event: 'attempt', tokens_used: 20, duration_ms: 100 },
  ], { tokenBudget: 100, timeBudgetMs: 500 });
  assert.equal(got.state, 'exhausted');
  assert.equal(got.checkpoint, true);
  assert.equal(got.verdict_eligible, true);
});

test('missing usage and malformed budgets remain explicit unknown or invalid', () => {
  assert.equal(resourceState([], { tokenBudget: 100 }).state, 'unknown');
  const invalid = resourceState([{ tokens_used: -1 }], { tokenBudget: 100 });
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.checkpoint, false);
});

test('a finding without a rule class stays unknown even when its sentence is stable', () => {
  const identity = signatures.findingIdentity({ body: 'Please simplify this branch.', path: 'src/task.js', line: 9 });
  assert.equal(identity.known, false);
  assert.equal(identity.reason, 'missing-rule-or-class');
});
