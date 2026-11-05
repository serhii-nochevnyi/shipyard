'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const historicalRecovery of ['direct']) {
  for (const mutation of ['normalized-repeat', 'normalized-covered-source']) {
    test('historical signed source publication preserves original custody through ' + historicalRecovery + ' ' + mutation,
      () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation, 'all', historicalRecovery)));
  }
}

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');
for (const config of [{}, { role: ' code-review ' }, { critical: true }, { checkpoint: 'merge' }, { incomplete: true }, { partitioned: true }, { label: 'with space' }, { label: 'répertoire-ü' }])
test('code review CLI seals one static phase verdict: ' + JSON.stringify(config), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls, request }) => {
    const { result, output } = await run(config.role ? { role: config.role } : {});
    assert.equal(result.schema, 'shipyard.codex-delivery-result.v1');
    assert.deepEqual(JSON.parse(output), result);
    assert.equal(output.trim().split('\n').length, 1);
    assert.equal(result.artifact.outcome, config.incomplete ? 'incomplete' : 'pass');
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map(launch => launch.session)).size, 3);
    assert.equal(calls[0].selection.agent_file, config.critical || config.checkpoint
      ? 'shipyard-code-review-critical.toml' : 'shipyard-code-review.toml');
    assert.equal(result.receipt.runtime_evidence.sandbox_evidence.base_profile, ':read-only');
    assert.equal(calls[0].payload.role, 'code-review');
    assert.equal(calls[0].payload.stage, 'worker');
    assert.equal(calls[2].payload.stage, 'final');
    assert.equal(result.dispatch.ticket, request.scope.ticket);
    assert.equal(result.dispatch.subject_kind, 'phase');
    assert.equal(result.receipt.runtime_evidence.ticket, request.scope.ticket);
    assert.equal(result.receipt.runtime_evidence.code_review.review_contract, 'shipyard.semantic-review.v1');
    assert.equal(result.receipt.runtime_evidence.code_review.stage, 'final');
    if (config.partitioned) {
      assert.equal(calls[0].payload.input_transport, 'host-files');
      assert.ok(calls[0].payload.material.some(asset => asset.content.includes('large line ')));
      assert.ok(calls[2].payload.originals.length === 2);
    }
  }, config)));
}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['arch-review']) {
for (const cold of [false, true])
    test('completed ' + role + ' authenticates and accounts for progress before the last final ' + (cold ? 'cold' : 'live'),
      () => require('./phase49-review-continuation.test.cjs').completedSourceFixture(role, cold, null, null, false, false, false, true));
test('completed ' + role + ' refuses an orphan reservation before any native launch',
    () => require('./phase49-review-continuation.test.cjs').completedSourceFixture(role, false, 'orphan-reservation'));
for (const cold of [false, true]) for (const fault of ['initial-record-link-response', 'initial-record-directory-fsync',
    'record-link-response', 'record-directory-fsync',
    'outcome-write', 'outcome-file-fsync', 'outcome-rename-response', 'outcome-directory-fsync'])
    test('original recorded ' + role + ' reconciles ' + fault + ' ' + (cold ? 'cold' : 'live'),
      () => require('./phase49-review-continuation.test.cjs').completedSourceReceiptRecoveryFixture(role, cold, fault));
}
}

function registerDeliveryTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'D', family: 'delivery' });
  registerFixerTests(test, context);
  registerDeliveryCases(test, context);
}

function registerTests(test, context = createDeliveryFixture()) {
  registerDeliveryTests(test, context);
  registerRuntimeTests(test, context);
}

function registerChecks(test, context = createDeliveryFixture()) {
  test('runtime original predecessors settle before the real code-review HOME mutation and rejection cleanup', async () => {
    const fs = require('node:fs'), os = require('node:os');
    const runtime = createRuntimeFixture();
    let reject, entered = false, owned;
    const pending = new Promise((resolve, fail) => { reject = fail; });
    const predecessor = runtime.runOriginal(() => pending);
    const failure = new Error('deferred original predecessor');
    const failureObserved = assert.rejects(predecessor, error => error === failure);
    const home = os.homedir, read = fs.readFileSync;
    const callbackFailure = new Error('original callback cleanup');
    const review = runtime.codeReviewRuntimeFixture(async f => {
      entered = true; owned = [f.f.root, f.storage];
      assert.equal(os.homedir(), f.storage);
      throw callbackFailure;
    });
    const reviewObserved = assert.rejects(review, error => error === callbackFailure);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(entered, false);
    assert.equal(os.homedir, home);
    reject(failure);
    await failureObserved; await reviewObserved;
    assert.equal(entered, true);
    assert.equal(os.homedir, home);
    assert.equal(fs.readFileSync, read);
    for (const root of owned) assert.equal(fs.existsSync(root), false);
  });
  test('complete original c allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
  test('fixture definitions resolve unit roots and retain caller scripts and finalizer refusal', () => {
    const path = require('node:path');
    const scripts = path.resolve(__dirname, '../../plugins/shipyard/host/plugins/delivery-pipeline/scripts');
    const refusal = () => { throw Object.assign(new Error('fixture candidate retained'), { code: 'Z23_CANDIDATE' }); };
    const configured = createDeliveryFixture({ scripts, finalizeCommit: refusal, temporary: '/unused', signer: 'inert' });
    assert.equal(configured.__dirname, __dirname);
    assert.equal(path.resolve(configured.scriptsRoot, 'codex-delivery-host.cjs'),
      path.join(scripts, 'codex-delivery-host.cjs'));
    assert.equal(configured.require.resolve('./phase49-incremental-integration.test.cjs'),
      path.join(__dirname, 'phase49-incremental-integration.test.cjs'));
    assert.equal(configured.require.resolve('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'),
      path.join(scripts, 'codex-delivery-host.cjs'));
    assert.equal(configured.createCodexDeliveryHost, require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost);
    assert.equal(configured.finalizeCommit, refusal);
    assert.throws(configured.finalizeCommit, { code: 'Z23_CANDIDATE' });
    assert.equal(createDeliveryFixture().require.resolve('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'),
      path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'));
  });
}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer historical-direct', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
