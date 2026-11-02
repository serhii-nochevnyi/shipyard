'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const outcome of ['source', 'no-op', 'escalate']) test('canonical builder through original static fixer seals ' + outcome + ' with host custody with four original native progress messages',
  () => withGraphDirEnv(undefined, () => originalFixerFixture(outcome)));
for (const mutation of ['missing-schema', 'foreign-schema', 'extra-result-field', 'extra-disposition-field', 'escalate-resolve'])
  test('complete multi-message escalated native fixer refuses ' + mutation + ' before any host action',
    () => withGraphDirEnv(undefined, () => originalFixerFixture('escalate', mutation)));
test('signed fixer publication recovers a lost response without replaying its confirmed push',
  () => withGraphDirEnv(undefined, () => originalFixerFixture('source', 'publication-response-loss')));
for (const mutation of ['foreign-pr', 'closed-pr', 'stale-head', 'stale-base', 'failed-page', 'overflow', 'disposition-budget', 'duplicate-feedback',
  'stalled-pagination', 'feedback-movement', 'missing-disposition', 'foreign-result', 'producer-push', 'evidence-symlink', 'evidence-bytes',
  'unknown-selector', 'caller-rung', 'caller-first', 'caller-new', 'foreign-dirty', 'self-commit', 'plan-movement', 'evidence-completion', 'missing-completion', 'duplicate-completion',
  'native-context', 'native-delegation', 'duplicate-cli-final', 'foreign-cli-session', 'mismatched-cli-final',
  'missing-native-completion', 'duplicate-native-final', 'foreign-native-final', 'mismatched-native-final',
  'missing-callback', 'duplicate-callback', 'foreign-callback', 'mismatched-callback'])
  test('original fixer custody refuses ' + mutation, () => withGraphDirEnv(undefined, () => originalFixerFixture('source', mutation)));

for (const mutation of ['thread-response-loss', 'comment-response-loss', 'resolve-response-loss',
  'companion-cli-response-loss', 'companion-cli-pending-id', 'companion-cli-legacy-id', 'companion-cli-legacy-absent',
  'companion-cli-reuse-response-loss',
  'companion-cli-refuse-head', 'companion-cli-refuse-graph', 'companion-cli-refuse-plan', 'companion-cli-refuse-ledger',
  'pending-duplicate', 'pending-author', 'pending-body', 'pending-target', 'pending-external', 'pending-missing'])
  test('original feedback action recovers ' + mutation + ' without reply replay',
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const mutation of ['reply-author-foreign', 'reply-author-login', 'reply-author-bot', 'reply-author-mannequin',
  'reply-author-organization', 'reply-author-enterprise', 'reply-author-unknown', 'reply-author-null',
  'reply-author-missing-id', 'reply-author-api-id'])
  test('serialized native fixer action and recovery refuse unauthenticated identity ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

for (const mutation of ['companion-wrong-link', 'companion-wrong-pr', 'companion-wrong-review-pr', 'companion-wrong-repo',
  'companion-wrong-target', 'companion-truncated', 'companion-review-body', 'companion-review-state', 'companion-review-author',
  'companion-extra-review', 'companion-reuse-extra-review', 'companion-reuse-review-body'])
  test('complete reply mutation and original pending recovery refuse ' + mutation,
    () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation)));

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');
test('code review builder request admits graph_dir and refuses serialized private custody', () => {
  const root = fs.mkdtempSync(path.join(temporary, 'code-request-'));
  const file = path.join(root, 'request.json');
  const request = { scope: {}, graph_dir: path.join(root, '.planning/graph'), role: 'code-review', signals: {}, context: { repo: null } };
  fs.writeFileSync(file, JSON.stringify(request));
  assert.equal(readRequestFile(file).graphDir, request.graph_dir);
  assert.equal(validateArgs({ role: 'code-review', signals: {}, context: { repo: null } }).request.role, 'code-review');
  for (const role of [' code-review ', '\tcode-review\n']) {
    assert.equal(requestValue({ role }).role, 'code-review');
    fs.writeFileSync(file, JSON.stringify({ ...request, role }));
    const parsed = readRequestFile(file);
    assert.equal(parsed.launch.role, 'code-review');
    assert.equal(parsed.graphDir, request.graph_dir);
  }
  for (const role of ['executor', 'research']) {
    fs.writeFileSync(file, JSON.stringify({ ...request, role }));
    assert.throws(() => readRequestFile(file), error => error.code === 'INVALID_INPUT');
  }
  for (const role of ['code-review', 'arch-review', 'executor']) {
    const launch = { role, context: { code_review_prepared: {} } };
    assert.throws(() => requestValue(launch), error => error.code === 'INVALID_INPUT');
    fs.writeFileSync(file, JSON.stringify({ scope: {}, ...launch }));
    assert.throws(() => readRequestFile(file), error => error.code === 'INVALID_INPUT');
  }
});

test('code review argument validation refuses caller prompts, signals and selectors', () => {
  for (const role of ['code-review', ' code-review ', '\tcode-review\n'])
  for (const patch of [{ gsd_role: 'gsd-code-reviewer' }, { signals: { contested: true } },
    { context: { prompt: 'caller' } }, { context: { selector: 'caller' } }, { context: { sandbox_mode: 'workspace-write' } }]) {
    assert.throws(() => validateArgs({ role, ...patch }), error => error.code === 'INVALID_INPUT');
  }
});

test('public Codex v3 rejects caller prompt, stage, receipt, capacity and producer authority', () => {
  const selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };
  assert.equal(requestValue(selected).context.review_contract, selected.context.review_contract);
  for (const field of ['prompt', 'kind', 'unit_id', 'plan_sha256', 'partitions', 'verified_index_sha256', 'receipt',
    'integrationCapacity', 'renderLaunch', 'measureInput', 'readWindow', 'capacity_certificate', 'input_prepared'])
    assert.throws(() => requestValue({ ...selected, context: { ...selected.context, [field]: {} } }), /host-owned/);
  for (const extra of [{ dispatch_id: 'caller-stage' }, { signals: { critical: true } }, { gsd_role: 'integrator' }])
    assert.throws(() => requestValue({ ...selected, ...extra }), /host-owned/);
});
}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['arch-review']) {
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
  test('complete original a allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer fixer-original-custody', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
