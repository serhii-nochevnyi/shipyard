'use strict';

const { test } = require('node:test');
const { completedSourceFixture, coldMeasuredSourceFixture, coldPrelaunchFixture, coldCompletedRecordingFixture } = require('./phase49-review-continuation.test.cjs');

for (const role of ['arch-review']) {
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
  for (const cold of [false, true]) {
    for (const mutation of ['recover-native-callback', 'recover-transcript-callback', 'recover-completed-callback', 'recover-record-gap', 'recover-record-repeat', 'recover-inflight', 'recover-tip-before-write', 'recover-tip-after-write', 'recover-ledger-after-write', 'recover-tip-fsync', 'recover-ledger-fsync'])
      test('completed ' + role + ' reconciles the exact original turn after ' + mutation + (cold ? ' cold' : ' live'),
        () => completedSourceFixture(role, cold, mutation));
    for (const mutation of ['recover-prefix', 'recover-truncated', 'recover-missing-cli', 'recover-foreign-cli', 'recover-base', 'recover-source', 'recover-agent', 'recover-missing-custody'])
      test('completed ' + role + ' reconciliation refuses ' + mutation + (cold ? ' cold' : ' live'),
        () => completedSourceFixture(role, cold, mutation));
  }

}
