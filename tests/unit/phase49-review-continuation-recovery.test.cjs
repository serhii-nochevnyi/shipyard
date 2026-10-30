'use strict';

const { test } = require('node:test');
const { assert, fs, path, runtime, authority, completedSourceFixture, automaticCompletedReviewFixture } = require('./phase49-review-continuation.test.cjs');

for (const role of ['arch-review']) {
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
    () => automaticCompletedReviewFixture(role, cold, failure));
