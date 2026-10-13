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

for (const role of ['integrator']) {
  for (const mutation of ['subject', 'material', 'profile', 'role', 'roster', 'source', 'plan', 'base', 'ancestry', 'agent', 'native', 'truncated', 'cli', 'receipt', 'forged-measurement', 'stale-measurement'])
    test('post-measure ' + role + ' refuses ' + mutation + ' after actual owner exit without new credit',
      () => coldMeasuredSourceFixture(role, 'tip-link', mutation));
  for (const target of ['envelope', 'tip']) for (const fault of ['write', 'link', 'file-fsync', 'directory-fsync'])
    test('post-measure ' + role + ' recovers after actual owner exit at ' + target + '-' + fault,
      () => coldMeasuredSourceFixture(role, target + '-' + fault));
  for (const cold of [false, true]) for (const target of ['envelope', 'tip'])
    for (const fault of ['write', 'link', 'file-fsync', 'directory-fsync'])
      test('post-measure ' + role + ' recovers original capacity after ' + target + '-' + fault + (cold ? ' restored host' : ' live'),
        () => completedSourceFixture(role, cold, 'seal-' + target + '-' + fault));
  for (const cold of [false, true])
    for (const fault of ['ledger-before-write', 'ledger-after-write', 'ledger-fsync', 'ledger-file-fsync',
      'tip-before-write', 'tip-after-write', 'tip-fsync', 'tip-file-fsync', 'tip-fsync-repeat'])
      test('prelaunch ' + role + ' retains no-spawn custody after ' + fault + (cold ? ' cold' : ' live'),
        () => completedSourceFixture(role, cold, 'prelaunch-' + fault));
  test('prelaunch ' + role + ' recovers the original unused final after the claimant process exits',
    () => coldPrelaunchFixture(role));
  test('prelaunch ' + role + ' refuses an unknown started launch without append after the claimant process exits',
    () => coldPrelaunchFixture(role, true));
  test('completed ' + role + ' records its exact original turn after the original host really exits before callbacks and receipt',
    () => coldCompletedRecordingFixture(role));
  test('completed ' + role + ' releases dead reconciliation ownership after the actual owner exits',
    () => coldCompletedRecordingFixture(role, true));

}
