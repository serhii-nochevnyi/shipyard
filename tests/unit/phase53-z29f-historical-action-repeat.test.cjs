'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const historicalRecovery of ['action']) {
  for (const mutation of ['normalized-repeat']) {
    test('historical signed source publication preserves original custody through ' + historicalRecovery + ' ' + mutation,
      () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation, 'all', historicalRecovery)));
  }
}

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');
test('public integration-review.v2 completes shared preparation with coordinator-only planning', () => withGraphDirEnv(undefined, async () => {
  const Module = require('node:module');
  const file = require.resolve('./phase49-incremental-integration.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return load.call(this, name, ...args);
  };
  try {
    loaded._compile(fs.readFileSync(file, 'utf8')
      + '\nmodule.exports = { fixture, projectOptions, agent, git, write };\n', file);
  } finally { Module._load = load; }
  const helper = loaded.exports;
  const originalHomedir = os.homedir;
  const hadCodexHome = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME');
  const originalCodexHome = process.env.CODEX_HOME;
  for (const large of [false, true]) {
    await helper.fixture(async f => {
      if (large) {
        for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {
          helper.write(f.worktree, file, Array.from({ length: 17000 }, (_, index) =>
            '// ' + file + ' ' + index + ' ' + 'x'.repeat(55) + '\n').join(''));
        }
        helper.git(f.worktree, 'add', '.'); helper.git(f.worktree, 'commit', '-qm', 'complete product material');
        f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
      }
      const coordinator = path.join(f.root, 'coordinator');
      helper.git(f.worktree, 'worktree', 'add', '--detach', coordinator, f.head);
      for (const row of Object.values(f.rows)) {
        fs.appendFileSync(path.join(coordinator, row.plan), '\nSelects `.planning/backlog/selected.md`.\n'
          + (large ? 'Complete current plan obligation.\n'.repeat(5000) : ''));
      }
      helper.write(coordinator, '.planning/backlog/selected.md', '# Coordinator backlog\n\nComplete selected backlog.\n'
        + (large ? 'Selected current backlog obligation.\n'.repeat(3000) : ''));
      if (large) fs.appendFileSync(path.join(coordinator, '.planning/architecture/ADR-014-original.md'),
        'Required current governing reference.\n'.repeat(3000));
      helper.write(coordinator, '.planning/phases/' + f.phase + '/CONTEXT.md', 'Coordinator context.\n');
      helper.write(coordinator, 'src/provider.cjs', 'exports.value = 99;\n');
      helper.git(coordinator, 'add', '.'); helper.git(coordinator, 'commit', '-qm', 'coordinator-only references');
      helper.git(f.worktree, 'rm', '-r', '.planning');
      helper.git(f.worktree, 'commit', '-qm', 'planning belongs to coordinator');
      f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
      helper.git(f.worktree, 'update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head);
      f.graphDir = path.join(coordinator, '.planning/graph');
      assert.equal(fs.existsSync(path.join(f.worktree, '.planning')), false);
      const options = helper.projectOptions(f);
      const shared = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
      if (large) assert.throws(() => shared.prepareIntegratorContext(options, { worktree: f.worktree, phase: '49',
        deferInline: true, review_contract: 'shipyard.integration-review.v2' }), /over its bound of 750000/);
      const prepared = shared.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49' });
      if (large) assert.ok(prepared.packet.accounting.estimated_tokens > 750000);
      assert.equal(prepared.prompt, undefined);
      assert.equal(shared.isPreparedIntegratorContext({ ...prepared }), false);
      assert.equal(prepared.canonical.worktree, f.worktree);
      assert.equal(prepared.canonical.head, f.head);
      assert.equal(prepared.canonical.projectRoot, coordinator);
      assert.ok(prepared.packet.required_refs.some(ref => ref.path.endsWith('ADR-014-original.md')));
      assert.ok(prepared.packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));
      assert.ok(prepared.packet.role_context.combined_diff.content.includes('+exports.value = 1;'));
      assert.ok(!prepared.packet.role_context.combined_diff.content.includes('exports.value = 99;'));
      const a = helper.agent(f, 'integrator', prepared.signals);
      const scope = { worktree: f.worktree, repository: prepared.canonical.commonPath, phase: 49,
        ticket: prepared.ticket, run_id: 'coordinator-integration' };
      const publicHost = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
      const request = { role: 'integrator', dispatch_id: scope.run_id, signals: {},
        context: { review_contract: 'shipyard.integration-review.v2' } };
      const nativeOptions = { ...options, scope,
        agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
        storageRoot: path.join(f.root, 'coordinator-delivery'), env: { CODEX_HOME: process.env.CODEX_HOME } };
      const input = publicHost.prepareIntegratorInput(scope, request, nativeOptions);
      const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
      const checked = context.verifyFileInput(input);
      const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
      const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));
      const original = context.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });
      for (const verified of [original, checked]) {
        assert.equal(verified.manifest.role, 'integrator');
        assert.equal(verified.manifest.binding.review_contract, 'shipyard.integration-review.v2');
        assert.equal(verified.manifest.max_chunk_reads, 4160);
        assert.equal(verified.chunk_reads, Math.ceil(verified.manifest_bytes.length / 8192)
          + verified.manifest.assets.reduce((sum, asset) => sum + Math.ceil(asset.bytes / 8192), 0));
      }
      assert.equal(input.input_bundle.review_contract, 'shipyard.integration-review.v2');
      assert.equal(checked.manifest.binding.original_input_bundle.review_contract, 'shipyard.integration-review.v2');
      assert.throws(() => context.prepareFileInput(scope, original.material[0], {
        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,
        binding: original.manifest.binding, integrationProducer: { ...prepared },
        storageRoot: path.join(f.root, 'copied-producer') }), /private producer/);

      for (const change of ['content', 'hash']) {
        const changed = packets.decodeUniqueContent(JSON.parse(original.material[0]), 32 * 1024 * 1024);
        const ref = changed.required_refs[0];
        if (change === 'content') {
          ref.content += '\nAltered complete reference.\n';
          ref.bytes = Buffer.byteLength(ref.content);
          ref.sha256 = crypto.createHash('sha256').update(ref.content).digest('hex');
        } else ref.sha256 = '0'.repeat(64);
        assert.throws(() => {
          const encoded = packets.encodeUniqueContent(changed, 32 * 1024 * 1024);
          return context.prepareFileInput(scope, JSON.stringify(encoded), {
            role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,
            integrationProducer: prepared, storageRoot: path.join(f.root, 'changed-reference-' + change),
            binding: { ...original.manifest.binding, packet_digest: crypto.createHash('sha256')
              .update(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(encoded)).digest('hex') } });
        }, /original private producer|immutable identity/);
      }

      const canonicalPacket = value => {
        const copy = structuredClone(value);
        for (const key of ['logical_source_obligations', 'required_refs']) {
          copy[key].sort((a, b) => a.path.localeCompare(b.path));
        }
        return copy;
      };
      require('node:assert').deepStrictEqual(
        canonicalPacket(packets.decodeUniqueContent(JSON.parse(original.material[0]))),
        canonicalPacket(prepared.packet));
      for (const verified of [original, checked]) for (const [index, asset] of verified.manifest.assets.entries()) {
        assert.equal(crypto.createHash('sha256').update(verified.material[index]).digest('hex'), asset.sha256);
      }
      for (const copy of [undefined, { ...input }, JSON.parse(JSON.stringify(input))]) {
        assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: { ...request.context } },
          { ...nativeOptions, fileInputContext: copy }), /private producer authority/);
      }
      const unassociated = context.prepareFileInput(scope, original.material[0], {
        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,
        storageRoot: path.join(f.root, 'unassociated-input') });
      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,
        context: { review_contract: 'shipyard.integration-review.v2', input_transport: 'host-files',
          input_bundle: unassociated.input_bundle, prompt: unassociated.prompt } },
        { ...nativeOptions, fileInputContext: unassociated }), /original private preparation/);
      assert.throws(() => publicHost.prepareIntegrationLineage(scope, { ...prepared },
        { ...nativeOptions, nativeRuntime: 'codex' }), /complete private runtime preparation/);
      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,
        context: { review_contract: 'shipyard.integration-review.v2', deferInline: true } },
        { ...nativeOptions, readerCapacity: {} }), /reader|capacity|schema/i);
      if (large) for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {
        assert.ok(packet.role_context.combined_diff.content.includes('diff --git a/' + file));
        assert.ok(packet.role_context.combined_diff.content.includes(file + ' 16999 '));
      }
      assert.equal(checked.manifest.snapshot.worktree, f.worktree);
      assert.equal(checked.manifest.snapshot.head, f.head);
      assert.equal(checked.manifest.snapshot.head_tree, prepared.canonical.headTree);
      assert.equal(packet.role_context.ticket_set_digest, prepared.ticketSetDigest);
      assert.deepEqual(packet.role_context.ticket_set, prepared.ticketSet);
      assert.equal(packet.role_context.combined_diff.content, prepared.packet.role_context.combined_diff.content);
      assert.equal(packet.canonical_root, coordinator);
      assert.equal(packet.source_revision, f.head);
      for (const ref of packet.required_refs) {
        assert.equal(fs.existsSync(path.join(f.worktree, ref.path)), false);
        assert.equal(ref.content, fs.readFileSync(path.join(coordinator, ref.path), 'utf8'));
      }
      assert.ok(packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));
      const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
      fs.cpSync(path.join(coordinator, '.planning'), path.join(foreign, '.planning'), { recursive: true });
      helper.git(foreign, 'init', '-qb', 'main'); helper.git(foreign, 'add', '.');
      helper.git(foreign, 'commit', '-qm', 'unrelated planning graph');
      assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: {
        review_contract: 'shipyard.integration-review.v2' } }, { ...options,
        graphDir: path.join(foreign, '.planning/graph') }), /unrelated repository/);
      fs.appendFileSync(path.join(coordinator, Object.values(f.rows)[0].plan), '\nchanged required planning bytes\n');
      assert.throws(() => context.verifyFileInput(input), /changed|stale/i);
      if (large) {
        const oversized = 'Complete selected obligation.\n'.repeat(1200000);
        assert.ok(Buffer.byteLength(oversized) > 32 * 1024 * 1024);
        fs.appendFileSync(path.join(coordinator, '.planning/backlog/selected.md'), oversized);
        helper.git(coordinator, 'add', '.planning'); helper.git(coordinator, 'commit', '-qm', 'complete oversized planning input');
        assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,
          context: { review_contract: 'shipyard.integration-review.v2' } }, nativeOptions),
          error => (error.code === 'CONTEXT_OVER_BOUND' && /complete material exceeds its bound/.test(error.message))
            || (error.code === 'INVALID_CONTEXT_PACKET' && /semantic packet exceeds its bound/.test(error.message)));
      }
    });
    assert.equal(os.homedir, originalHomedir);
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME'), hadCodexHome);
    assert.equal(process.env.CODEX_HOME, originalCodexHome);
  }
}));

test('public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final', () => withGraphDirEnv(undefined, async () => {
  const helper = codexPartitionHelpers();
  await helper.fixture(async f => {
    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });
    const historical = roleArtifacts.authenticatedArchivePins(f.worktree);
    const receipt = structuredClone(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt);
    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    helper.write(f.worktree, 'src/consumer.cjs', 'exact Codex primary line Ω\n'.repeat(3000)); helper.commit(f, 'complete partitioned source');
    const { options, controls } = codexPartitionFixture(f, helper);
    options.integrationCapacity.capacity.unit_input_bytes = 128 * 1024;
    let interrupted = false;
    controls.render = launch => {
      if (controls.launches?.length === 2 && launch.kind !== 'reserved-template' && !interrupted) {
        interrupted = true; throw new Error('fixture interruption before next native reservation');
      }
    };
    controls.onLaunch = (input, payload) => {
      assert.equal(input.includes('<AUTHENTICATED_CONTEXT_PACKET>'), false);
      assert.equal(controls.measured.filter(item => item.reserved_template).length, 1);
      assert.ok(controls.measured.filter(item => item.kind === 'unit').length > 1);
      assert.equal(fs.existsSync(evidencePath), false);
      if (payload.kind === 'phase') assert.ok(payload.unit_artifacts.length > 1);
    };
    const host = createCodexDeliveryHost(options), selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };
    await assert.rejects(host.run(selected), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.equal(controls.launches.length, 2);
    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);
    const old = fs.readFileSync(path.join(f.worktree, historical[0].path));
    fs.appendFileSync(path.join(f.worktree, historical[0].path), 'tamper');
    await assert.rejects(host.run(selected), /archive|pin|changed|digest/i);
    fs.writeFileSync(path.join(f.worktree, historical[0].path), old);
    helper.write(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR + '/unlisted/unrelated.json', '{}');
    await assert.rejects(host.run(selected), /archive|membership/i);
    fs.rmSync(path.join(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR, 'unlisted'), { recursive: true });
    options.integrationCapacity.plan_sha256 = controls.measured[0].plan_sha256;
    const restarted = createCodexDeliveryHost(options);
    const result = await restarted.run(selected);
    assert.equal(result.result.kind, 'phase');
    assert.equal(result.result.outcome, 'passed');
    assert.equal(result.receipt.runtime, 'codex');
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
    const units = controls.launches.filter(item => item.payload.kind === 'unit');
    assert.equal(new Set(units.map(item => item.payload.assignment.unit_id)).size, units.length);
    assert.equal(controls.measured.length, controls.launches.length + 1);
    const final = controls.measured.at(-1);
    assert.equal(final.kind, 'phase'); assert.equal(final.reserved_template, undefined);
    assert.notEqual(final.verified_index_sha256, '0'.repeat(64));
    assert.equal(final.unit_artifacts.length, units.length);
    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, receipt);
    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);
    const manifests = roleArtifacts.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))
      .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));
    assert.equal(new Set(manifests.map(item => item.producer_launch)).size, manifests.length);
    assert.equal(manifests.filter(item => item.artifact_kind === 'integration-unit').length, units.length);
    await assert.rejects(restarted.run(selected), /reserved|archive|membership|baseline/i);
    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
  });
}));

test('public Codex v3 accepts omitted capacity through original observed evidence', () => withGraphDirEnv(undefined, async () => {
  const helper = codexPartitionHelpers();
  await helper.publicIntegrationFixture(async f => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: true });
    delete options.integrationCapacity;
    const result = await createCodexDeliveryHost(options).run({ role: 'integrator',
      context: { review_contract: 'shipyard.integration-review.v3' } });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.result.outcome, 'passed');
    assert.equal(controls.measured, undefined);
    assert.ok(controls.launches.filter(item => item.payload.kind === 'unit').length > 0);
    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
    assert.equal(result.operational_diagnostic.authoritative, false);
    assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);
    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);
  });
}));
}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['integrator']) {
for (const fault of ['unmeasured-empty', 'unmeasured-failed']) test('cold unused original reservation recovers ' + role + ' ' + fault, async () => {
    await require('./phase49-review-continuation.test.cjs').coldMeasuredSourceFixture(role, fault);
  });
test('unmeasured candidate refuses a concurrent physical probe ' + role, async () => {
    await require('./phase49-review-continuation.test.cjs').completedSourceFixture(role, false, 'concurrent-probe');
  });
test('missing ledger never replays an original recorded measurement ' + role, async () => {
    await require('./phase49-review-continuation.test.cjs').coldMeasuredSourceFixture(role, 'envelope-write', 'missing-ledger');
  });
for (const mutation of ['profile', 'material', 'roster', 'subject', 'candidate-custody'])
    test('cold unmeasured candidate refuses substitution ' + role + ' ' + mutation, async () => {
      await require('./phase49-review-continuation.test.cjs').coldMeasuredSourceFixture(role, 'unmeasured-failed', mutation);
    });
test('cold unmeasured candidate refuses original pending probe ' + role, async () => {
    await require('./phase49-review-continuation.test.cjs').coldMeasuredSourceFixture(role, 'unmeasured-pending', 'pending');
  });
for (const fault of ['missing-cli', 'partial-native', 'tampered-snapshot']) test('retained partial failed final costs remain unknown ' + role + ' ' + fault, async () => {
    await require('./phase49-review-continuation.test.cjs').partialFailedSourceFixture(role, fault);
  });
for (const cold of [false, true]) for (const fault of ['record-link-response', 'outcome-write', 'outcome-file-fsync'])
    test('automatic original recorded ' + role + ' completes unchanged consumers after ' + fault + ' ' + (cold ? 'restored' : 'live'),
      () => require('./phase49-review-continuation.test.cjs').automaticCompletedReviewFixture(role, cold, false, false, fault));
test('automatic original recorded ' + role + ' cold controller releases only its actually dead owner',
    () => require('./phase49-review-continuation.test.cjs').coldRecordedSourceControllerFixture(role));
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
  test('complete original f allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
  test('cold helper and physical registration imports have no lifecycle or test side effects', () => {
    const { execFileSync } = require('node:child_process');
    const path = require('node:path');
    const exercise = `
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      const cp = require('node:child_process'), Module = require('node:module');
      const before = { ...process.env };
      const listeners = process.eventNames().map(event => [event, process.listeners(event)]);
      for (const method of ['execFileSync', 'spawnSync', 'spawn', 'execFile'])
        cp[method] = () => { throw new Error('import/registration launched a child: ' + method); };
      for (const method of ['mkdtempSync', 'mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync'])
        fs[method] = () => { throw new Error('import/registration wrote a fixture: ' + method); };
      const load = Module._load;
      Module._load = function(request, ...args) {
        if (request === 'node:test' || request.endsWith('assert-harness.cjs'))
          throw new Error('import/registration loaded an executing harness');
        return load.call(this, request, ...args);
      };
      const unit = process.argv[1];
      const support = require(path.join(unit, 'helpers/phase53-delivery-fixture.cjs'));
      const fixer = require(path.join(unit, 'helpers/phase53-original-fixer.cjs'));
      const runtime = require(path.join(unit, 'helpers/phase53-runtime-fixture.cjs'));
      const runtimeContext = runtime.createRuntimeFixture();
      assert.equal(runtimeContext.__dirname, unit);
      const read = fs.readFileSync;
      fs.readFileSync = (target, ...args) => {
        if (String(target).includes('/tests/fixtures/')) throw new Error('registration read native fixture');
        return read(target, ...args);
      };
      const g = require(path.join(unit, 'phase53-z29g-historical-action-covered.test.cjs'));
      const lifecycle = support.createDeliveryLifecycle();
      lifecycle.cleanup();
      const context = support.createDeliveryFixture();
      assert.equal(typeof fixer.createOriginalFixerFixture(context), 'function');
      let count = 0;
      for (const owner of ['codex-runtime-host.test.cjs', ...g.owners]) require(path.join(unit, owner)).registerTests((name, callback) => {
        assert.equal(typeof name, 'string'); assert.equal(typeof callback, 'function'); count++;
      }, context);
      assert.equal(count, 593);
      assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
      for (const key of Object.keys(before)) assert.equal(process.env[key] === before[key], true, 'environment changed: ' + key);
      assert.deepEqual(process.eventNames().map(event => [event, process.listeners(event)]), listeners);
      process.stdout.write('inert-original-registration');
    `;
    const output = execFileSync(process.execPath, ['-e', exercise, path.resolve(__dirname)], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(output, 'inert-original-registration');
  });
  test('explicit signing lifecycles restore present and absent HOME/CODEX/GPG/environment values', () =>
    context.withGraphDirEnv(undefined, () => {
      const fs = require('node:fs'), path = require('node:path');
      const keys = ['HOME', 'CODEX_HOME', 'GNUPGHOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'SHIPYARD_COVERAGE_ROOT'];
      const snapshot = () => keys.map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key), process.env[key]]);
      const initial = snapshot(), listeners = process.listeners('exit');
      const roots = [];
      try {
        for (const absent of [false, true]) {
          if (absent) for (const key of keys) delete process.env[key];
          const before = snapshot(), lifecycle = createDeliveryLifecycle();
          assert.deepEqual(snapshot(), before);
          const nested = lifecycle.start(); roots.push(nested.temporary);
          try {
            assert.equal(fs.realpathSync(nested.temporary), nested.temporary);
            assert.ok(process.env.HOME.startsWith(nested.temporary + path.sep));
            assert.equal(process.env.CODEX_HOME, path.join(process.env.HOME, '.codex'));
            assert.equal(process.env.GNUPGHOME, path.join(nested.temporary, 'gnupg'));
            assert.equal(fs.statSync(process.env.GNUPGHOME).mode & 0o777, 0o700);
            assert.match(nested.signer, /^[A-F0-9]{40}$/);
            assert.throws(() => lifecycle.start(), /already started/);
          } finally { lifecycle.cleanup(); }
          assert.deepEqual(snapshot(), before);
          assert.deepEqual(process.listeners('exit'), listeners);
          assert.equal(fs.existsSync(nested.temporary), false);
          assert.equal(fs.existsSync(context.temporary), true);
          assert.equal(fs.existsSync(path.join(context.temporary, 'gnupg')), true);
          lifecycle.cleanup();
          assert.deepEqual(snapshot(), before);
        }
        assert.notEqual(roots[0], roots[1]);
      } finally {
        for (const [key, present, value] of initial) {
          if (present) process.env[key] = value; else delete process.env[key];
        }
      }
      assert.deepEqual(snapshot(), initial);
    }));
}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer historical-action-repeat', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
