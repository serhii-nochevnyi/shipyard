'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const historicalRecovery of ['admitted']) {
  for (const mutation of ['normalized-repeat', 'normalized-covered-source']) {
    test('historical signed source publication preserves original custody through ' + historicalRecovery + ' ' + mutation,
      () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation, 'all', historicalRecovery)));
  }
}

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');
for (const partitioned of [false, true]) for (const mutation of ['missing', 'changed'])
test('code review CLI refuses original native session ' + mutation + ': partitions=' + partitioned, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run());
    assert.equal(calls.length, 2);
  }, { partitioned, afterLaunch({ launch: { nativePath } }) {
    assert.ok(fs.existsSync(nativePath));
    if (mutation === 'missing') fs.rmSync(nativePath);
    else fs.appendFileSync(nativePath, 'changed');
  } })));

for (const mutation of ['agent', 'head', 'base', 'file-input', 'receipt'])
test('code review refuses changes before verdict sealing: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run()); assert.equal(calls.length, 2);
  }, { partitioned: mutation === 'file-input', afterLaunch({ f, launch, agentDir, recorder }) {
    if (mutation === 'agent') fs.appendFileSync(path.join(agentDir, launch.selection.agent_file), '\nchanged');
    if (mutation === 'head') f.pr.headRefOid = 'a'.repeat(40);
    if (mutation === 'base') f.pr.baseRefOid = 'b'.repeat(40);
    if (mutation === 'receipt') {
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...args) => {
        const bytes = read(file, ...args);
        if (typeof file !== 'string' || !file.startsWith(recorder.storeDir + path.sep)
            || !path.basename(file).startsWith('record-')) return bytes;
        const envelope = JSON.parse(String(bytes));
        assert.ok(envelope.payload.receipt.runtime_evidence.code_review);
        delete envelope.payload.receipt.runtime_evidence.code_review;
        const changed = JSON.stringify(envelope);
        return typeof bytes === 'string' ? changed : Buffer.from(changed);
      };
    }
    if (mutation === 'file-input') {
      const filename = launch.payload.material.find(asset => asset.content.includes('large line ')).read_path;
      fs.chmodSync(filename, 0o600); fs.appendFileSync(filename, 'changed');
    }
  } })));

test('code review launch preflight refuses semicolon repository identity before preparing evidence', () => withGraphDirEnv(undefined, async () => {
  const f = fixture({ physicalPaths: true });
  const baseOptions = cliOptions(f);
  const oldRoot = f.root, root = oldRoot + ';colon';
  fs.renameSync(oldRoot, root);
  const file = path.join(f.storageRoot, 'semicolon-code-review-request.json');
  fs.mkdirSync(f.storageRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ scope: { ...f.scope, worktree: root }, role: 'code-review', signals: {}, context: {} }));
  let diagnostics = '';
  try {
    await assert.rejects(runCli(['--args-file', file], { write() {} }, {
      ...baseOptions, host: { ...f.host, scope: { ...f.scope, worktree: root } },
      preflightStderr: { write(chunk) { diagnostics += chunk; } },
    }), error => error.code === 'REPOSITORY_IDENTITY_INVALID');
    assert.match(diagnostics, /hint\[REPOSITORY_IDENTITY_INVALID\]/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, '.shipyard-code-review-evidence.md')), false);
  } finally { fs.renameSync(root, oldRoot); clean(f); }
}));

for (const mutation of ['agent', 'head', 'base'])
test('code review wrapper refuses installed or live changes immediately before launch: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run(), error => error.code === (mutation === 'agent' ? 'ARTIFACT_MUTATED' : 'STALE_CONTEXT'));
    assert.equal(calls.length, 0);
  }, { beforeLaunch({ f, agentDir, manifest, agentManifest }) {
    if (mutation === 'agent') {
      for (const file of manifest.agent_files) {
        fs.appendFileSync(path.join(agentDir, file), '\n ');
        manifest.agent_digests[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(agentDir, file))).digest('hex');
      }
      fs.writeFileSync(agentManifest, JSON.stringify(manifest));
    } else f.pr[mutation === 'head' ? 'headRefOid' : 'baseRefOid'] = 'a'.repeat(40);
  } })));
}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['integrator']) {
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
  test('each physical runtime queue waits for its own completed predecessor and continues after rejection', async () => {
    const first = createRuntimeFixture(), other = createRuntimeFixture();
    const steps = [];
    let release;
    const predecessor = first.runCompleted(() => new Promise(resolve => { release = resolve; }));
    const successor = first.runCompleted(() => { steps.push('successor'); });
    await other.runCompleted(() => { steps.push('independent'); });
    assert.deepEqual(steps, ['independent']);
    release(); await predecessor; await successor;
    assert.deepEqual(steps, ['independent', 'successor']);
    const failure = new Error('runner-owned callback failed');
    const failed = first.run(() => { throw failure; });
    const recovered = first.run(() => { steps.push('settled'); });
    await assert.rejects(failed, error => error === failure); await recovered;
    assert.deepEqual(steps, ['independent', 'successor', 'settled']);
    assert.notEqual(first.originalRuntimeCases, other.originalRuntimeCases);
    await first.settled(); await other.settled();
  });
  test('complete original d allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
  test('each explicit fixture owns a serial environment queue with rejection restoration', () =>
    context.withGraphDirEnv(undefined, async () => {
      const shared = createDeliveryFixture();
      const before = process.env.SHIPYARD_GRAPH_DIR, order = [];
      const first = shared.withGraphDirEnv('first-original-runner', async () => {
        assert.equal(process.env.SHIPYARD_GRAPH_DIR, 'first-original-runner'); order.push('first');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(process.env.SHIPYARD_GRAPH_DIR, 'first-original-runner'); order.push('first-complete');
      });
      const rejected = shared.withGraphDirEnv('rejected-original-runner', async () => {
        assert.equal(process.env.SHIPYARD_GRAPH_DIR, 'rejected-original-runner'); order.push('rejected');
        throw new Error('original queue refusal');
      });
      const recovered = shared.withGraphDirEnv(undefined, () => {
        assert.equal(process.env.SHIPYARD_GRAPH_DIR, undefined); order.push('recovered');
      });
      await first; await assert.rejects(rejected, /original queue refusal/); await recovered;
      assert.deepEqual(order, ['first', 'first-complete', 'rejected', 'recovered']);
      assert.equal(process.env.SHIPYARD_GRAPH_DIR, before);
    }));
}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer historical-admitted', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
