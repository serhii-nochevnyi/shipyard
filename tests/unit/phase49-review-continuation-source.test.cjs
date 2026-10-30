'use strict';

const { test } = require('node:test');
const { completedSourceFixture, coldMeasuredSourceFixture, coldPrelaunchFixture, coldCompletedRecordingFixture } = require('./phase49-review-continuation.test.cjs');

for (const role of ['arch-review']) {
  test('completed ' + role + ' source rejects a concurrent claimant before a second native launch',
    () => completedSourceFixture(role, false, null, null, false, true));
  test('completed ' + role + ' probe stays completed when its cold fresh final is genuinely interrupted',
    () => completedSourceFixture(role, true, 'incomplete-final'));
  for (const cold of [false, true]) test('completed ' + role + ' source is claimed once for a new original final ' + (cold ? 'after cold restoration' : 'live'),
    () => completedSourceFixture(role, cold));
  for (const cold of [false, true]) test('completed ' + role + ' source refuses subject-kind substitution ' + (cold ? 'cold' : 'live'),
    () => completedSourceFixture(role, cold, 'subject-kind'));
  test('completed ' + role + ' source refuses a moved base before cold final launch',
    () => completedSourceFixture(role, true, 'base'));
  for (const cold of [false, true]) test('completed ' + role + ' source refuses base movement after its original claim ' + (cold ? 'cold' : 'live'),
    () => completedSourceFixture(role, cold, 'base-after-claim'));
  for (const mutation of ['spawn-throw', 'invalid-child', 'stdin-throw', 'process-hook-throw', 'failed-prefix', 'failed-truncated', 'prefix', 'source', 'agent', 'old-verdict', 'intervening-turn', 'final-reread', 'model', 'effort', 'provider', 'compaction', 'parent-child-swap', 'final-prompt', 'profile', 'roster', 'subject', 'base'])
    test('completed ' + role + ' source refuses ' + mutation, () => completedSourceFixture(role, false, mutation));
}
