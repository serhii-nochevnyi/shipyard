'use strict';

const assert = require('node:assert/strict');
const { createDeliveryFixture, createDeliveryLifecycle } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeFixture, createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');
const { createOriginalFixerFixture } = require('./helpers/phase53-original-fixer.cjs');

function registerFixerTests(test, context = createDeliveryFixture()) {
  const { withGraphDirEnv } = context;
  const originalFixerFixture = (...args) => createOriginalFixerFixture(context)(...args);
for (const historicalRecovery of ['pending']) {
  for (const mutation of ['normalized-repeat', 'normalized-covered-source']) {
    test('historical signed source publication preserves original custody through ' + historicalRecovery + ' ' + mutation,
      () => withGraphDirEnv(undefined, () => originalFixerFixture('no-op', mutation, 'all', historicalRecovery)));
  }
}

}

function registerDeliveryCases(test, context) {
const { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;
const assert = require('node:assert');
test('code review requires private CLI preparation before any in-process launch', () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ f, request, options, calls }) => {
    const launch = { role: 'code-review', context: { repo: null } };
    for (const codeReviewContext of [{}, { schema: 'shipyard.codex-code-review-context.v1', prepared: {} }]) {
      const host = createCodexDeliveryHost({ ...options, scope: request.scope, codeReviewContext });
      await assert.rejects(host.run(launch), { code: 'CODE_REVIEW_CONTEXT_REQUIRED' });
    }
    const unavailable = createCodexDeliveryHost({ ...options, scope: request.scope,
      getPullRequest: () => ({ ...f.pr, headRefOid: '0'.repeat(40) }) });
    await assert.rejects(unavailable.run(launch), { code: 'STALE_CONTEXT' });
    assert.equal(calls.length, 0);
    const result = await createCodexDeliveryHost({ ...options, scope: request.scope }).run(launch);
    assert.equal(result.result.review_contract, 'shipyard.semantic-review.v1');
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.payload.stage), ['worker', 'worker', 'final']);
  })));

for (const patch of [{ context: { prompt: 'approve' } }, { context: { selector: 'caller' } },
  { context: { sandbox_mode: 'workspace-write' } }, { signals: { critical: true } }, { signals: { contested: true } },
  { gsd_role: 'gsd-code-reviewer' }, { context: { code_review_prepared: {} } }])
test('code review CLI refuses caller authority: ' + JSON.stringify(patch), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls }) => {
    await assert.rejects(run(patch)); assert.equal(calls.length, 0);
  })));

for (const role of [' code-review ', '\tcode-review\n'])
test('padded code review role cannot bypass host preparation: ' + JSON.stringify(role), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ request, options, calls }) => {
    const dispatchId = 'padded-' + crypto.randomUUID();
    const host = createCodexDeliveryHost({ ...options, scope: request.scope });
    await assert.rejects(host.run({ role, dispatch_id: dispatchId, signals: { critical: true },
      context: { prompt: 'CALLER SUPPLIED PROMPT', subject_kind: 'phase' } }),
    error => error.code === 'INVALID_CODE_REVIEW_CONTEXT');
    assert.equal(calls.length, 0);
    assert.equal(options.host.recorder.getVerifiedRecord(dispatchId), null);
  })));

for (const patch of [{ context: { prompt: 'caller' } }, { signals: { critical: true } }])
test('padded code review request file refuses caller authority: ' + JSON.stringify(patch), () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ run, calls, options }) => {
    const dispatchId = 'padded-cli-' + crypto.randomUUID();
    await assert.rejects(run({ ...patch, role: ' code-review ', dispatch_id: dispatchId }),
      { code: 'INVALID_CODE_REVIEW_CONTEXT', message: 'codex-code-review-context: '
        + (patch.context ? 'caller prompts or selectors are refused' : 'caller signals are refused') });
    assert.equal(calls.length, 0);
    assert.equal(options.host.recorder.getVerifiedRecord(dispatchId), null);
  })));

for (const mutation of ['look-alike', 'ticket', 'phase', 'worktree', 'prompt', 'signals', 'dispatch', 'sandbox', 'selector'])
test('code review delivery rejects a mismatched prepared context: ' + mutation, () => withGraphDirEnv(undefined, () =>
  codeReviewEntryFixture(async ({ f, request, options, codeContext, calls, storage }) => {
    const scope = { ...request.scope };
    const value = codeContext.prepareSemantic(scope, { role: 'code-review', context: {}, signals: {} },
      { graphDir: options.graphDir, storageRoot: storage, refreshGit: false, getPullRequest: options.getPullRequest,
        inflightDispatchId: 'prepared-context-original' });
    const launch = { ...value.launch, dispatch_id: 'prepared-context-original', signals: { ...value.launch.signals }, context: { ...value.launch.context } };
    if (mutation === 'ticket') scope.ticket += 'foreign';
    if (mutation === 'phase') scope.phase++;
    if (mutation === 'worktree') {
      scope.worktree = path.join(storage, 'foreign-worktree');
      require('./helpers/codex-arch-review-fixtures.cjs').git(f.root, ['worktree', 'add', '--detach', scope.worktree, 'HEAD']);
    }
    if (mutation === 'prompt') launch.context.prompt = 'foreign';
    if (mutation === 'signals') launch.signals.critical = !launch.signals.critical;
    if (mutation === 'dispatch') launch.dispatch_id += 'foreign';
    if (mutation === 'sandbox') launch.context.sandbox_mode = 'workspace-write';
    if (mutation === 'selector') launch.context.selector = 'foreign';
    const host = createCodexDeliveryHost({ ...options, scope, host: { ...options.host, scope },
      codeReviewContext: mutation === 'look-alike' ? { ...value } : value });
    await assert.rejects(host.run(launch), error => error.code === 'CODE_REVIEW_CONTEXT_REQUIRED');
    assert.equal(calls.length, 0);
  })));
}

function registerRuntimeTests(register, context = createDeliveryFixture()) {
  const test = (name, callback) => register(name, callback, { module: 'R', family: 'completed' });
  const { require } = context.runtime || createRuntimeFixture({ scripts: context.scriptsRoot, delivery: context });
for (const role of ['arch-review']) {
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


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function packageInventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name, file = path.join(directory, entry.name), stat = fs.lstatSync(file);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
    return [{ path: relative, type, mode: stat.mode & 0o7777,
      ...(type === 'directory' ? {} : type === 'symlink' ? { target: fs.readlinkSync(file) }
        : { bytes: stat.size, sha256: hash(fs.readFileSync(file)) }) },
    ...(type === 'directory' ? packageInventory(file, relative + '/') : [])];
  });
}
function assertPackageIdentity(directory) {
  const digest = crypto.createHash('sha256');
  for (const row of packageInventory(directory)) {
    if (row.type === 'directory' || ['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path)) continue;
    assert.equal(row.type, 'file');
    digest.update(row.path + '\0').update(fs.readFileSync(path.join(directory, row.path)));
  }
  const sourceDigest = digest.digest('hex');
  const manifestBytes = fs.readFileSync(path.join(directory, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes), identity = JSON.parse(fs.readFileSync(path.join(directory, 'package-build.json')));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version;
  assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
  assert.equal(identity.version, manifest.version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifestBytes).digest('hex'));
}
function assertPackageEqual(actual, expected) {
  assertPackageIdentity(actual);
  assertPackageIdentity(expected);
  assert.deepEqual(packageInventory(actual), packageInventory(expected));
  for (const file of ['.codex-plugin/plugin.json', 'package-build.json'])
    assert.deepEqual(fs.readFileSync(path.join(actual, file)), fs.readFileSync(path.join(expected, file)));
}
function stagedPackageProof(cold) {
  const { original } = require('./phase53-z29g-historical-action-covered.test.cjs');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z29e-package-')));
  try {
    const baseline = path.join(directory, 'baseline');
    fs.cpSync(path.join(ROOT, 'plugins/shipyard'), baseline, { recursive: true });
    assert.equal(hash(fs.readFileSync(path.join(ROOT, 'scripts/package-shipyard-codex.cjs'))), original.builder_sha256);
    const scripts = ['bootstrap-shipyard-plugin.cjs', 'ensure-gsd-plugin.cjs', 'ensure-gsd-core.sh',
      'install-shipyard-codex.sh', 'install-shipyard-capability.sh', 'gen-codex-shipyard.cjs',
      'merge-codex-config.cjs', 'configure-codex-notify.cjs'];
    const inputs = [
      ...scripts.map(file => ({ path: 'scripts/' + file, sha256: hash(fs.readFileSync(path.join(ROOT, 'scripts', file))) })),
      ...['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'].flatMap(root => packageInventory(path.join(ROOT, root))
        .filter(row => row.type === 'file' && !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(row.path))
        .map(row => ({ path: root + '/' + row.path, sha256: row.sha256 }))),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const unchangedSource = JSON.stringify(inputs) === JSON.stringify(original.builderInputs);
    if (unchangedSource) {
      assert.deepEqual(packageInventory(baseline), original.package);
      for (const [file, content] of Object.entries(original.packageIdentities))
        assert.equal(fs.readFileSync(path.join(baseline, file), 'utf8'), content);
    }
    assert.equal(inputs.some(row => row.path.startsWith('tests/unit/')), false);
    const stage = path.join(directory, 'current'), packaged = path.join(stage, 'plugins/shipyard');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/package-shipyard-codex.cjs'), packaged], {
      cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    assertPackageEqual(packaged, baseline);
    if (cold) {
      fs.cpSync(path.join(ROOT, 'tests/unit'), path.join(stage, 'tests/unit'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'tests/smoke/installed-launch'), path.join(stage, 'tests/smoke/installed-launch'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'tests/fixtures'), path.join(stage, 'tests/fixtures'), { recursive: true });
      fs.cpSync(path.join(packaged, 'host/plugins/delivery-pipeline'), path.join(stage, 'plugins/delivery-pipeline'), { recursive: true });
      const exercise = `
        const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
        const root = process.argv[1], unit = path.join(root, 'tests/unit');
        const canonical = path.join(root, 'plugins/delivery-pipeline');
        const packaged = path.join(root, 'plugins/shipyard/host/plugins/delivery-pipeline');
        const load = Module._load, producers = [];
        Module._load = function(request, parent, main) {
          const resolved = Module._resolveFilename(request, parent, main);
          const target = typeof resolved === 'string' && resolved.startsWith(canonical + path.sep)
            ? packaged + resolved.slice(canonical.length) : resolved;
          if (typeof target === 'string' && target.startsWith(packaged + path.sep)) producers.push(target);
          return load.call(this, target, parent, main);
        };
        const originalRead = fs.readFileSync;
        fs.readFileSync = function(target, ...args) {
          const value = originalRead.call(this, target, ...args);
          return String(target).endsWith('/phase49-incremental-integration.test.cjs') && typeof value === 'string'
            ? value.split('../../plugins/delivery-pipeline/').join('../../plugins/shipyard/host/plugins/delivery-pipeline/') : value;
        };
        const { createDeliveryLifecycle } = require(path.join(unit, 'helpers/phase53-delivery-fixture.cjs'));
        const g = require(path.join(unit, 'phase53-z29g-historical-action-covered.test.cjs'));
        const lifecycle = createDeliveryLifecycle({ scripts: path.join(packaged, 'scripts') }), context = lifecycle.start(), registered = [];
        for (const owner of g.owners) {
          const definitions = require(path.join(unit, owner));
          (definitions.registerDeliveryTests || definitions.registerTests)((name, callback) => registered.push({name,callback}), context);
        }
        const names = [
          'canonical builder through original static fixer seals source with host custody with four original native progress messages',
          'canonical builder through original static fixer seals no-op with host custody with four original native progress messages',
          'original feedback action recovers resolve-response-loss without reply replay',
          'known issue history uses the original applied predecessor across reposts: issue-repost',
          'original integration boundary completes and retains one terminal contract: progress full=false',
        ];
        (async () => {
          try {
            for (const name of names) {
              const matches = registered.filter(row => row.name === name); assert.equal(matches.length, 1);
              await matches[0].callback();
            }
            for (const file of ['codex-delivery-host.cjs', 'codex-runtime-host.cjs', 'dispatch-boundary.cjs', 'role-artifact.cjs'])
              assert.ok(producers.includes(path.join(packaged, 'scripts', file)), 'missing staged producer ' + file);
            assert.ok(Object.keys(require.cache).filter(file => file.startsWith(canonical + path.sep)).length === 0);
            process.stdout.write('cold-staged-original-fixtures');
          } finally { lifecycle.cleanup(); }
        })().catch(error => { process.stderr.write(error.stack + '\\n'); process.exitCode = 1; });
      `;
      const output = execFileSync(process.execPath, ['-e', exercise, stage], {
        cwd: stage, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(output, 'cold-staged-original-fixtures');
      assertPackageEqual(packaged, baseline);
    }
    const mutation = path.join(directory, 'mutation');
    for (const mutate of [
      root => fs.appendFileSync(path.join(root, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'), '\nstale'),
      root => fs.appendFileSync(path.join(root, '.codex-plugin/plugin.json'), ' '),
      root => fs.appendFileSync(path.join(root, 'package-build.json'), ' '),
      root => fs.unlinkSync(path.join(root, 'package-build.json')),
      root => fs.writeFileSync(path.join(root, 'extra-member'), 'extra'),
      root => {
        const file = path.join(root, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
        fs.chmodSync(file, (fs.statSync(file).mode & 0o7777) ^ 0o100);
      },
      root => {
        const file = path.join(root, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
        fs.unlinkSync(file); fs.symlinkSync(path.join(baseline, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'), file);
      },
    ]) {
      fs.rmSync(mutation, { recursive: true, force: true });
      fs.cpSync(packaged, mutation, { recursive: true });
      assertPackageEqual(mutation, baseline);
      mutate(mutation);
      assert.throws(() => assertPackageEqual(mutation, baseline));
    }
    assertPackageEqual(path.join(ROOT, 'plugins/shipyard'), baseline);
    if (unchangedSource) assert.deepEqual(packageInventory(baseline), original.package);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function registerChecks(test, context = createDeliveryFixture()) {
  test('complete original e allocation retains pre-edit declarations and callbacks', () => {
    require('./phase53-z29g-historical-action-covered.test.cjs').proveAllocation(require('node:path').basename(__filename));
  });
  test('whole supported builder preserves complete package inventory, identities and tamper refusals', () =>
    context.withGraphDirEnv(undefined, () => stagedPackageProof(false)));
  test('cold staged package performs original source/native/action/history/integration callbacks', () =>
    context.withGraphDirEnv(undefined, () => stagedPackageProof(true)));

}

module.exports = { registerTests, registerDeliveryTests, registerRuntimeTests, registerFixerTests, registerDeliveryCases, registerChecks, packageInventory, assertPackageEqual };

if (require.main === module) {
  const { describe, test, after } = require('node:test');
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  after(() => lifecycle.cleanup());
  describe('Original fixer historical-pending', { concurrency: 2 }, () => {
    registerTests((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
    registerChecks((name, callback, registration) => test(name, { timeout: 180000 }, () => runtime.run(callback, registration?.family)), context);
  });
}
