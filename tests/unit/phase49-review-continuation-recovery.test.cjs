'use strict';

const { test } = require('node:test');
const { assert, fs, path, runtime, authority, completedSourceFixture, automaticCompletedReviewFixture } = require('./phase49-review-continuation.test.cjs');

for (const role of ['integrator']) {
  for (const cold of [false, true]) {
    for (const mutation of ['recover-native-callback', 'recover-transcript-callback', 'recover-completed-callback', 'recover-record-gap', 'recover-record-repeat', 'recover-inflight', 'recover-tip-before-write', 'recover-tip-after-write', 'recover-ledger-after-write', 'recover-tip-fsync', 'recover-ledger-fsync'])
      test('completed ' + role + ' reconciles the exact original turn after ' + mutation + (cold ? ' cold' : ' live'),
        () => completedSourceFixture(role, cold, mutation));
    for (const mutation of ['recover-prefix', 'recover-truncated', 'recover-missing-cli', 'recover-foreign-cli', 'recover-base', 'recover-source', 'recover-agent', 'recover-missing-custody'])
      test('completed ' + role + ' reconciliation refuses ' + mutation + (cold ? ' cold' : ' live'),
        () => completedSourceFixture(role, cold, mutation));
  }
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

for (const role of ['arch-review', 'integrator']) {
  test('completed ' + role + ' accounting retains failed probe costs without interrupted-probe credit',
    () => completedSourceFixture(role, true, null, null, true));
  test('completed ' + role + ' accounting keeps truncated failed output costs unknown in the full denominator',
    () => completedSourceFixture(role, true, null, null, true, false, true));
  test('completed ' + role + ' accounting refuses a missing original all-attempt ledger',
    () => completedSourceFixture(role, false, null, ({ source, input, recorder }) => {
      const sealed = authority.readCompletedReviewSource({ worktree: input.manifest.snapshot.worktree, reference: source });
      const directory = path.dirname(sealed.snapshot.path);
      const ledger = fs.readdirSync(directory).filter(file => /^review-tip-/.test(file)).find(file => {
        try { return JSON.parse(fs.readFileSync(path.join(directory, file))).payload.schema === 'shipyard.review-source-attempts.v1'; } catch { return false; }
      });
      assert.ok(ledger); fs.unlinkSync(path.join(directory, ledger));
      assert.throws(() => runtime.verifyCompletedReviewConsumption({ worktree: sealed.identity.worktree, source,
        receipt_store: recorder.storeDir, dispatch_id: sealed.identity.dispatch_id }));
    }));
}

for (const role of ['arch-review']) for (const cold of [false, true])
  test('whole automatic ' + role + ' measurement and genuinely fresh ' + (cold ? 'cold' : 'live') + ' final reaches unchanged consumer',
    () => automaticCompletedReviewFixture(role, cold));

for (const role of ['arch-review']) for (const cold of [false, true]) for (const failure of ['callback', 'record', 'record-repeat', 'seal-envelope', 'seal-tip'])
  test('whole automatic ' + role + ' reconciles original ' + failure + ' failure through unchanged consumer ' + (cold ? 'cold' : 'live'),
    () => automaticCompletedReviewFixture(role, cold, false, false, failure));

for (const cold of [false, true]) test('large ordinary canonical integration preserves whole input through automatic ' + (cold ? 'cold' : 'live') + ' final',
  () => automaticCompletedReviewFixture('integrator', cold, true));

for (const cold of [false, true]) test('automatic ordinary integration refuses canonical base movement after its original probe ' + (cold ? 'cold' : 'live'),
  () => automaticCompletedReviewFixture('integrator', cold, true, true));
