'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const mutation of ['normalized-repeat', 'normalized-cli-repeat', 'normalized-external', 'normalized-forged-actions', 'normalized-reply-body',
  'normalized-default-home', 'normalized-cli-default-home', 'normalized-default-os-home', 'normalized-cli-default-os-home',
  'normalized-default-missing-manifest', 'normalized-default-stale-manifest',
  'normalized-reply-author', 'normalized-reply-id', 'normalized-reply-target', 'normalized-source', 'normalized-reopened', 'normalized-missing-actions',
  'normalized-companion-body', 'normalized-companion-author', 'normalized-companion-missing', 'normalized-companion-link',
  'normalized-companion-forged', 'normalized-location-shift', 'normalized-location-null'])
  test('original complete feedback and authenticated host output ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));
for (const mutation of ['normalized-source-repeat', 'normalized-cli-source-repeat'])
  test('authenticated confirmed replies retain repeat policy through the original signed fixer source transition ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('source', mutation)));

for (const mutation of ['normalized-covered-source', 'normalized-covered-source-forged', 'normalized-covered-source-plan',
  'normalized-covered-source-owners', 'normalized-uncovered-source', 'normalized-covered-source-reply-body',
  'normalized-covered-source-reply-author', 'normalized-covered-source-reply-id', 'normalized-covered-source-reply-target',
  'normalized-covered-source-companion-link', 'normalized-covered-source-location-shift', 'normalized-covered-source-location-null',
  'normalized-covered-source-location-path', 'normalized-covered-source-location-original-line',
  'normalized-covered-source-location-thread-id', 'normalized-covered-source-location-reopened',
  'normalized-covered-source-location-negative', 'normalized-covered-source-location-string',
  'normalized-covered-source-location-zero', 'normalized-covered-source-location-false', 'normalized-covered-source-location-empty',
  'normalized-covered-source-location-body', 'normalized-covered-source-location-author',
  'normalized-covered-source-location-forged', 'normalized-uncovered-source-location-shift'])
  test('confirmed no-op feedback authenticates subsequent native executor source coverage ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const evolution of ['plan', 'owners', 'allowlist', 'base', 'all', 'stale-plan', 'unsigned-base', 'base-merge', 'base-merge-extra'])
  test('historical confirmed action provenance permits a fresh current signed scope ' + evolution,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', 'normalized-covered-source', evolution)));
test('historical scope alone starts a fresh current round without prior semantic approval',
  () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', 'normalized-repeat', 'plan')));

for (const mutation of ['issue-repost', 'issue-oscillation', 'issue-unknown', 'issue-ambiguous', 'issue-shift'])
test('known issue history uses the original applied predecessor across reposts: ' + mutation,
  () => withGraphDirEnv(undefined, () => originalFixerFixture('escalate', mutation)));

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');

}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['integrator']) {
for (const mutation of ['tampered-receipt', 'foreign-receipt', 'source', 'base', 'agent', 'native', 'unknown-pid', 'live-pid'])
    test('original recorded ' + role + ' refuses ' + mutation + ' cold',
      () => require('./phase49-review-continuation.test.cjs').completedSourceReceiptRecoveryFixture(role, true, 'outcome-write', mutation));
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
  test('complete original b allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
  test('packaged selected names and retained z23 callback/assertion source stay exact', () => {
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const hash = value => crypto.createHash('sha256').update(value.trim()).digest('hex');
    const { original } = require('./phase53-z29g-historical-action-covered.test.cjs');
    const packaged = fs.readFileSync(path.join(__dirname, 'phase49-package-publication.test.cjs'), 'utf8');
    const start = packaged.indexOf("test('same-generation packaged fixer");
    const names = packaged.indexOf('  const names = [', start), exercise = packaged.indexOf('  const exercise =', names);
    assert.equal(hash(packaged.slice(names, exercise)), original.consumer_sources.package_names_sha256);
    const z23 = fs.readFileSync(path.join(__dirname, 'phase53-z23-verification-owner-heartbeat.test.cjs'), 'utf8');
    const seam = z23.indexOf("  const helpers = require('./helpers/phase53-delivery-fixture.cjs').createDeliveryFixture({");
    const next = z23.indexOf('  const f = helpers.fixture(', seam);
    assert.ok(seam > 0 && next > seam);
    assert.equal(hash(z23.slice(0, seam) + z23.slice(next)), original.consumer_sources.z23_retained_sha256);
  });
}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer fixer-source-history', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
