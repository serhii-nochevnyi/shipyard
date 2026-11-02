'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const newOwners = ['phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs'];
const historicalFiles = files => files.filter(file => !newOwners.includes(file));
function historicalSelection(s, spec) {
  const files = s.unitFiles(), manifest = s.readManifest();
  const original = s.appendShard(manifest, s.unitTasks(historicalFiles(files)));
  const current = s.appendShard(manifest, s.unitTasks(files));
  const [ordinal, total] = spec.split('/').map(Number);
  assert.equal(total, original.shards.length); assert.ok(ordinal >= 1 && ordinal <= total);
  const row = original.shards[ordinal - 1], index = current.shards.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(row));
  assert.ok(index >= 0);
  return s.selectTaskShard(`${index + 1}/${current.shards.length}`);
}

const historicalCodexRuntime = new (require('node:async_hooks').AsyncLocalStorage)();
function withHistoricalCodexRuntime(createHost, action) {
  return historicalCodexRuntime.run(createHost, action);
}

const selected = () => ({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } });

function historicalCodexAuthority(scriptsRoot) {
  const deliveryPath = require.resolve(path.join(scriptsRoot, 'codex-delivery-host.cjs'));
  require(deliveryPath);
  const authorityPath = require.resolve(path.join(scriptsRoot, 'role-artifact.cjs'));
  // @invariant: Restoration retains the delivery host's authority instance after cold reader reloads.
  const original = require.cache[deliveryPath].children.find(child => child.filename === authorityPath);
  assert.ok(original, 'original restoration uses the delivery host\'s actual authority dependency');
  return original.exports;
}

function prepareHistoricalCodexV3(f, options, scriptsRoot = scripts) {
  const load = name => require(path.join(scriptsRoot, name + '.cjs'));
  const authority = historicalCodexAuthority(scriptsRoot), delivery = load('codex-delivery-host'), shared = load('claude-role-host');
  const nativeModule = load('codex-runtime-host'), collector = load('codex-arch-review-context');
  const boundary = load('dispatch-boundary'), policy = load('model-policy');
  const original = shared.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49',
    review_contract: authority.INTEGRATION_REVIEW_V3 });
  const selection = policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals: original.signals });
  const instructions = collector.instructionEvidence(options.agentDir, selection.agent_file, options.agentManifest);
  const scope = { ...options.scope, worktree: f.worktree, phase: original.phaseNumber, ticket: original.ticket,
    run_id: 'historical-v3-' + crypto.randomUUID() };
  const storageRoot = options.storageRoot || path.join(f.root, 'codex-originals');
  const review = delivery.prepareIntegrationLineage(scope, original, { ...options, nativeRuntime: 'codex',
    dispatchId: scope.run_id, storageRoot: path.join(storageRoot, scope.run_id),
    generatedInstructionBytes: instructions.generated_instruction_bytes,
    instructionBinding: { agent_file: selection.agent_file, agent_path: path.resolve(options.agentDir, selection.agent_file),
      agent_sha256: instructions.sha256, installed_files: instructions.installed_files, policy_hash: selection.policy_hash } });
  if (options.integrationCapacity !== undefined && !options.integrationCapacity?.plan_sha256
      && (!options.integrationCapacity || typeof options.integrationCapacity !== 'object' || !options.integrationCapacity.capacity))
    throw Object.assign(new Error('supplied strict capacity resources are malformed'), { code: 'INTEGRATION_CAPACITY_UNPROVEN' });
  const resources = options.integrationCapacity ||= {};
  const recorder = options.recorder || resources.recorder || boundary.createDurableRecorder(path.join(storageRoot, 'receipts'));
  if (resources.recorder && resources.recorder !== recorder) assert.equal(resources.recorder.storeDir, recorder.storeDir);
  options.recorder = recorder; resources.recorder = recorder;
  const resumed = !!resources.plan_sha256;
  const partitions = authority.prepareIntegrationPartitions({ review, capacity: resources.capacity, plan_sha256: resources.plan_sha256 });
  resources.plan_sha256 = partitions.plan.plan_sha256;
  return { load, authority, delivery, shared, nativeModule, original, scope, storageRoot, review, resources, recorder, resumed, partitions };
}

const promotions = [
  {
    "module": "D",
    "declaration": 4487,
    "name": "public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final",
    "parameters": [],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');\n    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });\n    const historical = roleArtifacts.authenticatedArchivePins(f.worktree);\n    const receipt = structuredClone(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt);\n    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');\n    helper.write(f.worktree, 'src/consumer.cjs', 'exact Codex primary line Ω\\n'.repeat(3000)); helper.commit(f, 'complete partitioned source');\n    const { options, controls } = codexPartitionFixture(f, helper);\n    options.integrationCapacity.capacity.unit_input_bytes = 128 * 1024;\n    let interrupted = false;\n    controls.render = launch => {\n      if (controls.launches?.length === 2 && launch.kind !== 'reserved-template' && !interrupted) {\n        interrupted = true; throw new Error('fixture interruption before next native reservation');\n      }\n    };\n    controls.onLaunch = (input, payload) => {\n      assert.equal(input.includes('<AUTHENTICATED_CONTEXT_PACKET>'), false);\n      assert.equal(controls.measured.filter(item => item.reserved_template).length, 1);\n      assert.ok(controls.measured.filter(item => item.kind === 'unit').length > 1);\n      assert.equal(fs.existsSync(evidencePath), false);\n      if (payload.kind === 'phase') assert.ok(payload.unit_artifacts.length > 1);\n    };\n    const host = createCodexDeliveryHost(options), selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };\n    await assert.rejects(host.run(selected), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');\n    assert.equal(controls.launches.length, 2);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const old = fs.readFileSync(path.join(f.worktree, historical[0].path));\n    fs.appendFileSync(path.join(f.worktree, historical[0].path), 'tamper');\n    await assert.rejects(host.run(selected), /archive|pin|changed|digest/i);\n    fs.writeFileSync(path.join(f.worktree, historical[0].path), old);\n    helper.write(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR + '/unlisted/unrelated.json', '{}');\n    await assert.rejects(host.run(selected), /archive|membership/i);\n    fs.rmSync(path.join(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR, 'unlisted'), { recursive: true });\n    options.integrationCapacity.plan_sha256 = controls.measured[0].plan_sha256;\n    const restarted = createCodexDeliveryHost(options);\n    const result = await restarted.run(selected);\n    assert.equal(result.result.kind, 'phase');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(result.receipt.runtime, 'codex');\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    const units = controls.launches.filter(item => item.payload.kind === 'unit');\n    assert.equal(new Set(units.map(item => item.payload.assignment.unit_id)).size, units.length);\n    assert.equal(controls.measured.length, controls.launches.length + 1);\n    const final = controls.measured.at(-1);\n    assert.equal(final.kind, 'phase'); assert.equal(final.reserved_template, undefined);\n    assert.notEqual(final.verified_index_sha256, '0'.repeat(64));\n    assert.equal(final.unit_artifacts.length, units.length);\n    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, receipt);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const manifests = roleArtifacts.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))\n      .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));\n    assert.equal(new Set(manifests.map(item => item.producer_launch)).size, manifests.length);\n    assert.equal(manifests.filter(item => item.artifact_kind === 'integration-unit').length, units.length);\n    await assert.rejects(restarted.run(selected), /reserved|archive|membership|baseline/i);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n  });\n})",
    "callback_sha256": "e03d227e6b6d44150d435e64b52b3e4bfaafe36d226c8febca2f6649ba3ae40e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('pins', context)",
    "promoted_callback_sha256": "db5b3849731314aaf2c94633b7c67fe3eb7b53c2842da7598b7f28bc0ea7df02",
    "owner": "phase53-z29f-historical-action-repeat.test.cjs",
    "purpose": "Fresh public attempt refuses without native dispatch; historical pins, archive, tamper, restart and independent final preserved by recorded original cases.",
    "inherited_owner_sha256": "a6e6eaa07622d4f8f482a76e53675b186dbe74a5bb8cfdf7429c63bbebf1d754"
  },
  {
    "module": "D",
    "declaration": 4548,
    "name": "public Codex v3 accepts omitted capacity through original observed evidence",
    "parameters": [],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.publicIntegrationFixture(async f => {\n    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: true });\n    delete options.integrationCapacity;\n    const result = await createCodexDeliveryHost(options).run({ role: 'integrator',\n      context: { review_contract: 'shipyard.integration-review.v3' } });\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(controls.measured, undefined);\n    assert.ok(controls.launches.filter(item => item.payload.kind === 'unit').length > 0);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    assert.equal(result.operational_diagnostic.authoritative, false);\n    assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);\n    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);\n  });\n})",
    "callback_sha256": "9eafc25761bdaa2004fcb742ce8a046e3e5c5a19f794ae2319e608dbba8bc3ec",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('observed', context)",
    "promoted_callback_sha256": "e2c0ec9335aca5567e8c5a49da28e4f0c4c8e811beef06d934472f18a004e3fa",
    "owner": "phase53-z29f-historical-action-repeat.test.cjs",
    "purpose": "Fresh observed public request refuses without original plan/recorder; original optional accounting and current readers preserved by recorded observed cases.",
    "inherited_owner_sha256": "a6e6eaa07622d4f8f482a76e53675b186dbe74a5bb8cfdf7429c63bbebf1d754"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses missing-renderer with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "missing-renderer"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses unknown-window with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "unknown-window"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses foreign-window with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "foreign-window"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses foreign-counter with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "foreign-counter"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses unknown-instructions with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "unknown-instructions"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses over-bound-unit with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "over-bound-unit"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses over-bound-template with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "over-bound-template"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses over-bound-actual-final with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "over-bound-actual-final"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses changed-exact-input with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "changed-exact-input"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses wrong-output with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "wrong-output"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses incomplete-unit with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "incomplete-unit"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses failed-unit with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "failed-unit"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses source-substitution with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "source-substitution"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses native-input-substitution with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "native-input-substitution"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  },
  {
    "module": "D",
    "declaration": 4569,
    "name": "public Codex v3 refuses native-result-substitution with behavior-only capacity",
    "parameters": [
      {
        "binding": "scenario",
        "array": "['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution']",
        "value": "native-result-substitution"
      }
    ],
    "callback": "() => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n})",
    "callback_sha256": "f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e",
    "promoted_callback": "() => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario)",
    "promoted_callback_sha256": "1fb93a134d6cb5f5df7350f8d44688011a9932d831e4aa9e006baecc8ab50b64",
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "purpose": "No original authority refuses with zero public launch; exact original capacity/native/input/result fault retained at lower original recording boundary.",
    "inherited_owner_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239"
  }
];
const allocations = [
  {
    "owner": "phase53-z29f-historical-action-repeat.test.cjs",
    "old_source": "function registerDeliveryCases(test, context) {\nconst { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;\nconst assert = require('node:assert');\ntest('public integration-review.v2 completes shared preparation with coordinator-only planning', () => withGraphDirEnv(undefined, async () => {\n  const Module = require('node:module');\n  const file = require.resolve('./phase49-incremental-integration.test.cjs');\n  const loaded = new Module(file, module);\n  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));\n  const load = Module._load;\n  Module._load = function(name, ...args) {\n    if (name === 'node:test') return { test() {} };\n    return load.call(this, name, ...args);\n  };\n  try {\n    loaded._compile(fs.readFileSync(file, 'utf8')\n      + '\\nmodule.exports = { fixture, projectOptions, agent, git, write };\\n', file);\n  } finally { Module._load = load; }\n  const helper = loaded.exports;\n  const originalHomedir = os.homedir;\n  const hadCodexHome = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME');\n  const originalCodexHome = process.env.CODEX_HOME;\n  for (const large of [false, true]) {\n    await helper.fixture(async f => {\n      if (large) {\n        for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {\n          helper.write(f.worktree, file, Array.from({ length: 17000 }, (_, index) =>\n            '// ' + file + ' ' + index + ' ' + 'x'.repeat(55) + '\\n').join(''));\n        }\n        helper.git(f.worktree, 'add', '.'); helper.git(f.worktree, 'commit', '-qm', 'complete product material');\n        f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;\n      }\n      const coordinator = path.join(f.root, 'coordinator');\n      helper.git(f.worktree, 'worktree', 'add', '--detach', coordinator, f.head);\n      for (const row of Object.values(f.rows)) {\n        fs.appendFileSync(path.join(coordinator, row.plan), '\\nSelects `.planning/backlog/selected.md`.\\n'\n          + (large ? 'Complete current plan obligation.\\n'.repeat(5000) : ''));\n      }\n      helper.write(coordinator, '.planning/backlog/selected.md', '# Coordinator backlog\\n\\nComplete selected backlog.\\n'\n        + (large ? 'Selected current backlog obligation.\\n'.repeat(3000) : ''));\n      if (large) fs.appendFileSync(path.join(coordinator, '.planning/architecture/ADR-014-original.md'),\n        'Required current governing reference.\\n'.repeat(3000));\n      helper.write(coordinator, '.planning/phases/' + f.phase + '/CONTEXT.md', 'Coordinator context.\\n');\n      helper.write(coordinator, 'src/provider.cjs', 'exports.value = 99;\\n');\n      helper.git(coordinator, 'add', '.'); helper.git(coordinator, 'commit', '-qm', 'coordinator-only references');\n      helper.git(f.worktree, 'rm', '-r', '.planning');\n      helper.git(f.worktree, 'commit', '-qm', 'planning belongs to coordinator');\n      f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;\n      helper.git(f.worktree, 'update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head);\n      f.graphDir = path.join(coordinator, '.planning/graph');\n      assert.equal(fs.existsSync(path.join(f.worktree, '.planning')), false);\n      const options = helper.projectOptions(f);\n      const shared = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');\n      if (large) assert.throws(() => shared.prepareIntegratorContext(options, { worktree: f.worktree, phase: '49',\n        deferInline: true, review_contract: 'shipyard.integration-review.v2' }), /over its bound of 750000/);\n      const prepared = shared.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49' });\n      if (large) assert.ok(prepared.packet.accounting.estimated_tokens > 750000);\n      assert.equal(prepared.prompt, undefined);\n      assert.equal(shared.isPreparedIntegratorContext({ ...prepared }), false);\n      assert.equal(prepared.canonical.worktree, f.worktree);\n      assert.equal(prepared.canonical.head, f.head);\n      assert.equal(prepared.canonical.projectRoot, coordinator);\n      assert.ok(prepared.packet.required_refs.some(ref => ref.path.endsWith('ADR-014-original.md')));\n      assert.ok(prepared.packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));\n      assert.ok(prepared.packet.role_context.combined_diff.content.includes('+exports.value = 1;'));\n      assert.ok(!prepared.packet.role_context.combined_diff.content.includes('exports.value = 99;'));\n      const a = helper.agent(f, 'integrator', prepared.signals);\n      const scope = { worktree: f.worktree, repository: prepared.canonical.commonPath, phase: 49,\n        ticket: prepared.ticket, run_id: 'coordinator-integration' };\n      const publicHost = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');\n      const request = { role: 'integrator', dispatch_id: scope.run_id, signals: {},\n        context: { review_contract: 'shipyard.integration-review.v2' } };\n      const nativeOptions = { ...options, scope,\n        agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,\n        storageRoot: path.join(f.root, 'coordinator-delivery'), env: { CODEX_HOME: process.env.CODEX_HOME } };\n      const input = publicHost.prepareIntegratorInput(scope, request, nativeOptions);\n      const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');\n      const checked = context.verifyFileInput(input);\n      const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');\n      const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));\n      const original = context.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });\n      for (const verified of [original, checked]) {\n        assert.equal(verified.manifest.role, 'integrator');\n        assert.equal(verified.manifest.binding.review_contract, 'shipyard.integration-review.v2');\n        assert.equal(verified.manifest.max_chunk_reads, 4160);\n        assert.equal(verified.chunk_reads, Math.ceil(verified.manifest_bytes.length / 8192)\n          + verified.manifest.assets.reduce((sum, asset) => sum + Math.ceil(asset.bytes / 8192), 0));\n      }\n      assert.equal(input.input_bundle.review_contract, 'shipyard.integration-review.v2');\n      assert.equal(checked.manifest.binding.original_input_bundle.review_contract, 'shipyard.integration-review.v2');\n      assert.throws(() => context.prepareFileInput(scope, original.material[0], {\n        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n        binding: original.manifest.binding, integrationProducer: { ...prepared },\n        storageRoot: path.join(f.root, 'copied-producer') }), /private producer/);\n\n      for (const change of ['content', 'hash']) {\n        const changed = packets.decodeUniqueContent(JSON.parse(original.material[0]), 32 * 1024 * 1024);\n        const ref = changed.required_refs[0];\n        if (change === 'content') {\n          ref.content += '\\nAltered complete reference.\\n';\n          ref.bytes = Buffer.byteLength(ref.content);\n          ref.sha256 = crypto.createHash('sha256').update(ref.content).digest('hex');\n        } else ref.sha256 = '0'.repeat(64);\n        assert.throws(() => {\n          const encoded = packets.encodeUniqueContent(changed, 32 * 1024 * 1024);\n          return context.prepareFileInput(scope, JSON.stringify(encoded), {\n            role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n            integrationProducer: prepared, storageRoot: path.join(f.root, 'changed-reference-' + change),\n            binding: { ...original.manifest.binding, packet_digest: crypto.createHash('sha256')\n              .update(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(encoded)).digest('hex') } });\n        }, /original private producer|immutable identity/);\n      }\n\n      const canonicalPacket = value => {\n        const copy = structuredClone(value);\n        for (const key of ['logical_source_obligations', 'required_refs']) {\n          copy[key].sort((a, b) => a.path.localeCompare(b.path));\n        }\n        return copy;\n      };\n      require('node:assert').deepStrictEqual(\n        canonicalPacket(packets.decodeUniqueContent(JSON.parse(original.material[0]))),\n        canonicalPacket(prepared.packet));\n      for (const verified of [original, checked]) for (const [index, asset] of verified.manifest.assets.entries()) {\n        assert.equal(crypto.createHash('sha256').update(verified.material[index]).digest('hex'), asset.sha256);\n      }\n      for (const copy of [undefined, { ...input }, JSON.parse(JSON.stringify(input))]) {\n        assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: { ...request.context } },\n          { ...nativeOptions, fileInputContext: copy }), /private producer authority/);\n      }\n      const unassociated = context.prepareFileInput(scope, original.material[0], {\n        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n        storageRoot: path.join(f.root, 'unassociated-input') });\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n        context: { review_contract: 'shipyard.integration-review.v2', input_transport: 'host-files',\n          input_bundle: unassociated.input_bundle, prompt: unassociated.prompt } },\n        { ...nativeOptions, fileInputContext: unassociated }), /original private preparation/);\n      assert.throws(() => publicHost.prepareIntegrationLineage(scope, { ...prepared },\n        { ...nativeOptions, nativeRuntime: 'codex' }), /complete private runtime preparation/);\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n        context: { review_contract: 'shipyard.integration-review.v2', deferInline: true } },\n        { ...nativeOptions, readerCapacity: {} }), /reader|capacity|schema/i);\n      if (large) for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {\n        assert.ok(packet.role_context.combined_diff.content.includes('diff --git a/' + file));\n        assert.ok(packet.role_context.combined_diff.content.includes(file + ' 16999 '));\n      }\n      assert.equal(checked.manifest.snapshot.worktree, f.worktree);\n      assert.equal(checked.manifest.snapshot.head, f.head);\n      assert.equal(checked.manifest.snapshot.head_tree, prepared.canonical.headTree);\n      assert.equal(packet.role_context.ticket_set_digest, prepared.ticketSetDigest);\n      assert.deepEqual(packet.role_context.ticket_set, prepared.ticketSet);\n      assert.equal(packet.role_context.combined_diff.content, prepared.packet.role_context.combined_diff.content);\n      assert.equal(packet.canonical_root, coordinator);\n      assert.equal(packet.source_revision, f.head);\n      for (const ref of packet.required_refs) {\n        assert.equal(fs.existsSync(path.join(f.worktree, ref.path)), false);\n        assert.equal(ref.content, fs.readFileSync(path.join(coordinator, ref.path), 'utf8'));\n      }\n      assert.ok(packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));\n      const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);\n      fs.cpSync(path.join(coordinator, '.planning'), path.join(foreign, '.planning'), { recursive: true });\n      helper.git(foreign, 'init', '-qb', 'main'); helper.git(foreign, 'add', '.');\n      helper.git(foreign, 'commit', '-qm', 'unrelated planning graph');\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: {\n        review_contract: 'shipyard.integration-review.v2' } }, { ...options,\n        graphDir: path.join(foreign, '.planning/graph') }), /unrelated repository/);\n      fs.appendFileSync(path.join(coordinator, Object.values(f.rows)[0].plan), '\\nchanged required planning bytes\\n');\n      assert.throws(() => context.verifyFileInput(input), /changed|stale/i);\n      if (large) {\n        const oversized = 'Complete selected obligation.\\n'.repeat(1200000);\n        assert.ok(Buffer.byteLength(oversized) > 32 * 1024 * 1024);\n        fs.appendFileSync(path.join(coordinator, '.planning/backlog/selected.md'), oversized);\n        helper.git(coordinator, 'add', '.planning'); helper.git(coordinator, 'commit', '-qm', 'complete oversized planning input');\n        assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n          context: { review_contract: 'shipyard.integration-review.v2' } }, nativeOptions),\n          error => (error.code === 'CONTEXT_OVER_BOUND' && /complete material exceeds its bound/.test(error.message))\n            || (error.code === 'INVALID_CONTEXT_PACKET' && /semantic packet exceeds its bound/.test(error.message)));\n      }\n    });\n    assert.equal(os.homedir, originalHomedir);\n    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME'), hadCodexHome);\n    assert.equal(process.env.CODEX_HOME, originalCodexHome);\n  }\n}));\n\ntest('public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');\n    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });\n    const historical = roleArtifacts.authenticatedArchivePins(f.worktree);\n    const receipt = structuredClone(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt);\n    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');\n    helper.write(f.worktree, 'src/consumer.cjs', 'exact Codex primary line Ω\\n'.repeat(3000)); helper.commit(f, 'complete partitioned source');\n    const { options, controls } = codexPartitionFixture(f, helper);\n    options.integrationCapacity.capacity.unit_input_bytes = 128 * 1024;\n    let interrupted = false;\n    controls.render = launch => {\n      if (controls.launches?.length === 2 && launch.kind !== 'reserved-template' && !interrupted) {\n        interrupted = true; throw new Error('fixture interruption before next native reservation');\n      }\n    };\n    controls.onLaunch = (input, payload) => {\n      assert.equal(input.includes('<AUTHENTICATED_CONTEXT_PACKET>'), false);\n      assert.equal(controls.measured.filter(item => item.reserved_template).length, 1);\n      assert.ok(controls.measured.filter(item => item.kind === 'unit').length > 1);\n      assert.equal(fs.existsSync(evidencePath), false);\n      if (payload.kind === 'phase') assert.ok(payload.unit_artifacts.length > 1);\n    };\n    const host = createCodexDeliveryHost(options), selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };\n    await assert.rejects(host.run(selected), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');\n    assert.equal(controls.launches.length, 2);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const old = fs.readFileSync(path.join(f.worktree, historical[0].path));\n    fs.appendFileSync(path.join(f.worktree, historical[0].path), 'tamper');\n    await assert.rejects(host.run(selected), /archive|pin|changed|digest/i);\n    fs.writeFileSync(path.join(f.worktree, historical[0].path), old);\n    helper.write(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR + '/unlisted/unrelated.json', '{}');\n    await assert.rejects(host.run(selected), /archive|membership/i);\n    fs.rmSync(path.join(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR, 'unlisted'), { recursive: true });\n    options.integrationCapacity.plan_sha256 = controls.measured[0].plan_sha256;\n    const restarted = createCodexDeliveryHost(options);\n    const result = await restarted.run(selected);\n    assert.equal(result.result.kind, 'phase');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(result.receipt.runtime, 'codex');\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    const units = controls.launches.filter(item => item.payload.kind === 'unit');\n    assert.equal(new Set(units.map(item => item.payload.assignment.unit_id)).size, units.length);\n    assert.equal(controls.measured.length, controls.launches.length + 1);\n    const final = controls.measured.at(-1);\n    assert.equal(final.kind, 'phase'); assert.equal(final.reserved_template, undefined);\n    assert.notEqual(final.verified_index_sha256, '0'.repeat(64));\n    assert.equal(final.unit_artifacts.length, units.length);\n    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, receipt);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const manifests = roleArtifacts.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))\n      .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));\n    assert.equal(new Set(manifests.map(item => item.producer_launch)).size, manifests.length);\n    assert.equal(manifests.filter(item => item.artifact_kind === 'integration-unit').length, units.length);\n    await assert.rejects(restarted.run(selected), /reserved|archive|membership|baseline/i);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n  });\n}));\n\ntest('public Codex v3 accepts omitted capacity through original observed evidence', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.publicIntegrationFixture(async f => {\n    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: true });\n    delete options.integrationCapacity;\n    const result = await createCodexDeliveryHost(options).run({ role: 'integrator',\n      context: { review_contract: 'shipyard.integration-review.v3' } });\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(controls.measured, undefined);\n    assert.ok(controls.launches.filter(item => item.payload.kind === 'unit').length > 0);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    assert.equal(result.operational_diagnostic.authoritative, false);\n    assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);\n    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);\n  });\n}));\n}",
    "old_sha256": "dfa02d767b3945f42af0a6109fc09dfe9a3f3396e4d4612f19d330a347edd7fa",
    "new_source": "function registerDeliveryCases(test, context) {\nconst { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;\nconst assert = require('node:assert');\ntest('public integration-review.v2 completes shared preparation with coordinator-only planning', () => withGraphDirEnv(undefined, async () => {\n  const Module = require('node:module');\n  const file = require.resolve('./phase49-incremental-integration.test.cjs');\n  const loaded = new Module(file, module);\n  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));\n  const load = Module._load;\n  Module._load = function(name, ...args) {\n    if (name === 'node:test') return { test() {} };\n    return load.call(this, name, ...args);\n  };\n  try {\n    loaded._compile(fs.readFileSync(file, 'utf8')\n      + '\\nmodule.exports = { fixture, projectOptions, agent, git, write };\\n', file);\n  } finally { Module._load = load; }\n  const helper = loaded.exports;\n  const originalHomedir = os.homedir;\n  const hadCodexHome = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME');\n  const originalCodexHome = process.env.CODEX_HOME;\n  for (const large of [false, true]) {\n    await helper.fixture(async f => {\n      if (large) {\n        for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {\n          helper.write(f.worktree, file, Array.from({ length: 17000 }, (_, index) =>\n            '// ' + file + ' ' + index + ' ' + 'x'.repeat(55) + '\\n').join(''));\n        }\n        helper.git(f.worktree, 'add', '.'); helper.git(f.worktree, 'commit', '-qm', 'complete product material');\n        f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;\n      }\n      const coordinator = path.join(f.root, 'coordinator');\n      helper.git(f.worktree, 'worktree', 'add', '--detach', coordinator, f.head);\n      for (const row of Object.values(f.rows)) {\n        fs.appendFileSync(path.join(coordinator, row.plan), '\\nSelects `.planning/backlog/selected.md`.\\n'\n          + (large ? 'Complete current plan obligation.\\n'.repeat(5000) : ''));\n      }\n      helper.write(coordinator, '.planning/backlog/selected.md', '# Coordinator backlog\\n\\nComplete selected backlog.\\n'\n        + (large ? 'Selected current backlog obligation.\\n'.repeat(3000) : ''));\n      if (large) fs.appendFileSync(path.join(coordinator, '.planning/architecture/ADR-014-original.md'),\n        'Required current governing reference.\\n'.repeat(3000));\n      helper.write(coordinator, '.planning/phases/' + f.phase + '/CONTEXT.md', 'Coordinator context.\\n');\n      helper.write(coordinator, 'src/provider.cjs', 'exports.value = 99;\\n');\n      helper.git(coordinator, 'add', '.'); helper.git(coordinator, 'commit', '-qm', 'coordinator-only references');\n      helper.git(f.worktree, 'rm', '-r', '.planning');\n      helper.git(f.worktree, 'commit', '-qm', 'planning belongs to coordinator');\n      f.head = helper.git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;\n      helper.git(f.worktree, 'update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head);\n      f.graphDir = path.join(coordinator, '.planning/graph');\n      assert.equal(fs.existsSync(path.join(f.worktree, '.planning')), false);\n      const options = helper.projectOptions(f);\n      const shared = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');\n      if (large) assert.throws(() => shared.prepareIntegratorContext(options, { worktree: f.worktree, phase: '49',\n        deferInline: true, review_contract: 'shipyard.integration-review.v2' }), /over its bound of 750000/);\n      const prepared = shared.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49' });\n      if (large) assert.ok(prepared.packet.accounting.estimated_tokens > 750000);\n      assert.equal(prepared.prompt, undefined);\n      assert.equal(shared.isPreparedIntegratorContext({ ...prepared }), false);\n      assert.equal(prepared.canonical.worktree, f.worktree);\n      assert.equal(prepared.canonical.head, f.head);\n      assert.equal(prepared.canonical.projectRoot, coordinator);\n      assert.ok(prepared.packet.required_refs.some(ref => ref.path.endsWith('ADR-014-original.md')));\n      assert.ok(prepared.packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));\n      assert.ok(prepared.packet.role_context.combined_diff.content.includes('+exports.value = 1;'));\n      assert.ok(!prepared.packet.role_context.combined_diff.content.includes('exports.value = 99;'));\n      const a = helper.agent(f, 'integrator', prepared.signals);\n      const scope = { worktree: f.worktree, repository: prepared.canonical.commonPath, phase: 49,\n        ticket: prepared.ticket, run_id: 'coordinator-integration' };\n      const publicHost = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');\n      const request = { role: 'integrator', dispatch_id: scope.run_id, signals: {},\n        context: { review_contract: 'shipyard.integration-review.v2' } };\n      const nativeOptions = { ...options, scope,\n        agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,\n        storageRoot: path.join(f.root, 'coordinator-delivery'), env: { CODEX_HOME: process.env.CODEX_HOME } };\n      const input = publicHost.prepareIntegratorInput(scope, request, nativeOptions);\n      const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');\n      const checked = context.verifyFileInput(input);\n      const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');\n      const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));\n      const original = context.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });\n      for (const verified of [original, checked]) {\n        assert.equal(verified.manifest.role, 'integrator');\n        assert.equal(verified.manifest.binding.review_contract, 'shipyard.integration-review.v2');\n        assert.equal(verified.manifest.max_chunk_reads, 4160);\n        assert.equal(verified.chunk_reads, Math.ceil(verified.manifest_bytes.length / 8192)\n          + verified.manifest.assets.reduce((sum, asset) => sum + Math.ceil(asset.bytes / 8192), 0));\n      }\n      assert.equal(input.input_bundle.review_contract, 'shipyard.integration-review.v2');\n      assert.equal(checked.manifest.binding.original_input_bundle.review_contract, 'shipyard.integration-review.v2');\n      assert.throws(() => context.prepareFileInput(scope, original.material[0], {\n        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n        binding: original.manifest.binding, integrationProducer: { ...prepared },\n        storageRoot: path.join(f.root, 'copied-producer') }), /private producer/);\n\n      for (const change of ['content', 'hash']) {\n        const changed = packets.decodeUniqueContent(JSON.parse(original.material[0]), 32 * 1024 * 1024);\n        const ref = changed.required_refs[0];\n        if (change === 'content') {\n          ref.content += '\\nAltered complete reference.\\n';\n          ref.bytes = Buffer.byteLength(ref.content);\n          ref.sha256 = crypto.createHash('sha256').update(ref.content).digest('hex');\n        } else ref.sha256 = '0'.repeat(64);\n        assert.throws(() => {\n          const encoded = packets.encodeUniqueContent(changed, 32 * 1024 * 1024);\n          return context.prepareFileInput(scope, JSON.stringify(encoded), {\n            role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n            integrationProducer: prepared, storageRoot: path.join(f.root, 'changed-reference-' + change),\n            binding: { ...original.manifest.binding, packet_digest: crypto.createHash('sha256')\n              .update(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(encoded)).digest('hex') } });\n        }, /original private producer|immutable identity/);\n      }\n\n      const canonicalPacket = value => {\n        const copy = structuredClone(value);\n        for (const key of ['logical_source_obligations', 'required_refs']) {\n          copy[key].sort((a, b) => a.path.localeCompare(b.path));\n        }\n        return copy;\n      };\n      require('node:assert').deepStrictEqual(\n        canonicalPacket(packets.decodeUniqueContent(JSON.parse(original.material[0]))),\n        canonicalPacket(prepared.packet));\n      for (const verified of [original, checked]) for (const [index, asset] of verified.manifest.assets.entries()) {\n        assert.equal(crypto.createHash('sha256').update(verified.material[index]).digest('hex'), asset.sha256);\n      }\n      for (const copy of [undefined, { ...input }, JSON.parse(JSON.stringify(input))]) {\n        assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: { ...request.context } },\n          { ...nativeOptions, fileInputContext: copy }), /private producer authority/);\n      }\n      const unassociated = context.prepareFileInput(scope, original.material[0], {\n        role: 'integrator', dispatchId: scope.run_id, graphDir: f.graphDir,\n        storageRoot: path.join(f.root, 'unassociated-input') });\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n        context: { review_contract: 'shipyard.integration-review.v2', input_transport: 'host-files',\n          input_bundle: unassociated.input_bundle, prompt: unassociated.prompt } },\n        { ...nativeOptions, fileInputContext: unassociated }), /original private preparation/);\n      assert.throws(() => publicHost.prepareIntegrationLineage(scope, { ...prepared },\n        { ...nativeOptions, nativeRuntime: 'codex' }), /complete private runtime preparation/);\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n        context: { review_contract: 'shipyard.integration-review.v2', deferInline: true } },\n        { ...nativeOptions, readerCapacity: {} }), /reader|capacity|schema/i);\n      if (large) for (const file of ['src/complete.cjs', 'tests/complete.test.cjs', 'plugins/generated/complete.cjs']) {\n        assert.ok(packet.role_context.combined_diff.content.includes('diff --git a/' + file));\n        assert.ok(packet.role_context.combined_diff.content.includes(file + ' 16999 '));\n      }\n      assert.equal(checked.manifest.snapshot.worktree, f.worktree);\n      assert.equal(checked.manifest.snapshot.head, f.head);\n      assert.equal(checked.manifest.snapshot.head_tree, prepared.canonical.headTree);\n      assert.equal(packet.role_context.ticket_set_digest, prepared.ticketSetDigest);\n      assert.deepEqual(packet.role_context.ticket_set, prepared.ticketSet);\n      assert.equal(packet.role_context.combined_diff.content, prepared.packet.role_context.combined_diff.content);\n      assert.equal(packet.canonical_root, coordinator);\n      assert.equal(packet.source_revision, f.head);\n      for (const ref of packet.required_refs) {\n        assert.equal(fs.existsSync(path.join(f.worktree, ref.path)), false);\n        assert.equal(ref.content, fs.readFileSync(path.join(coordinator, ref.path), 'utf8'));\n      }\n      assert.ok(packet.backlog.selected.some(item => item.content.includes('Complete selected backlog.')));\n      const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);\n      fs.cpSync(path.join(coordinator, '.planning'), path.join(foreign, '.planning'), { recursive: true });\n      helper.git(foreign, 'init', '-qb', 'main'); helper.git(foreign, 'add', '.');\n      helper.git(foreign, 'commit', '-qm', 'unrelated planning graph');\n      assert.throws(() => publicHost.prepareIntegratorInput(scope, { ...request, context: {\n        review_contract: 'shipyard.integration-review.v2' } }, { ...options,\n        graphDir: path.join(foreign, '.planning/graph') }), /unrelated repository/);\n      fs.appendFileSync(path.join(coordinator, Object.values(f.rows)[0].plan), '\\nchanged required planning bytes\\n');\n      assert.throws(() => context.verifyFileInput(input), /changed|stale/i);\n      if (large) {\n        const oversized = 'Complete selected obligation.\\n'.repeat(1200000);\n        assert.ok(Buffer.byteLength(oversized) > 32 * 1024 * 1024);\n        fs.appendFileSync(path.join(coordinator, '.planning/backlog/selected.md'), oversized);\n        helper.git(coordinator, 'add', '.planning'); helper.git(coordinator, 'commit', '-qm', 'complete oversized planning input');\n        assert.throws(() => publicHost.prepareIntegratorInput(scope, { role: 'integrator', dispatch_id: scope.run_id,\n          context: { review_contract: 'shipyard.integration-review.v2' } }, nativeOptions),\n          error => (error.code === 'CONTEXT_OVER_BOUND' && /complete material exceeds its bound/.test(error.message))\n            || (error.code === 'INVALID_CONTEXT_PACKET' && /semantic packet exceeds its bound/.test(error.message)));\n      }\n    });\n    assert.equal(os.homedir, originalHomedir);\n    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME'), hadCodexHome);\n    assert.equal(process.env.CODEX_HOME, originalCodexHome);\n  }\n}));\n\ntest('public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('pins', context));\n\ntest('public Codex v3 accepts omitted capacity through original observed evidence', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('observed', context));\n}",
    "new_sha256": "df6282a2f5760c1dc3f20cc056221fdb7797c77b725f0bb4544959f423ebfc1f"
  },
  {
    "owner": "phase53-z29g-historical-action-covered.test.cjs",
    "old_source": "function registerDeliveryCases(test, context) {\nconst { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;\nconst assert = require('node:assert');\nfor (const scenario of ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution'])\ntest('public Codex v3 refuses ' + scenario + ' with behavior-only capacity', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n}));\n}",
    "old_sha256": "3c5a76f37d95cbc0c3027949469e205887bc489ed829a986814e976594560e6d",
    "new_source": "function registerDeliveryCases(test, context) {\nconst { fs, os, path, crypto, execFileSync, spawnSync, EventEmitter, codeReviewEntryFixture, codexPartitionHelpers, codexPartitionFixture, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer, require, __dirname } = context;\nconst assert = require('node:assert');\nfor (const scenario of ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n  'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'over-bound-actual-final', 'changed-exact-input',\n  'wrong-output', 'incomplete-unit', 'failed-unit', 'source-substitution', 'native-input-substitution', 'native-result-substitution'])\ntest('public Codex v3 refuses ' + scenario + ' with behavior-only capacity', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario));\n}",
    "new_sha256": "e5c8acd5ec890fb5c76cdda1c4c4141a21263f88d9e7a2699d0905963515f7b6"
  }
];
function validatePromotions(candidate = promotions) {
  assert.equal(hash(JSON.stringify(candidate)), "3235031ec5b1185f70b88aee88d5663b1b59ab49a2fbf68fd81c3b9936fe8843", 'closed exact17 source-proven promotion map');
  assert.equal(candidate.length, 17);
  assert.equal(new Set(candidate.map(row => JSON.stringify([row.module, row.declaration, row.parameters, row.name]))).size, 17);
  for (const row of candidate) {
    assert.equal(row.module, 'D'); assert.ok([4487, 4548, 4569].includes(row.declaration));
    assert.equal(hash(row.callback), row.callback_sha256);
    assert.equal(hash(row.promoted_callback), row.promoted_callback_sha256);
    assert.ok(row.purpose.length > 50);
  }
  return candidate;
}
function promoteOriginal(row) {
  const matches = validatePromotions().filter(item => item.module === row.module && item.declaration === row.declaration
    && JSON.stringify(item.parameters) === JSON.stringify(row.parameters) && item.name === row.name);
  if (!matches.length) return row;
  assert.equal(matches.length, 1);
  const item = matches[0];
  assert.equal(row.callback, item.callback); assert.equal(row.callback_sha256, item.callback_sha256);
  return { ...row, callback: item.promoted_callback, callback_sha256: item.promoted_callback_sha256 };
}
function promoteSelection(row) {
  const matches = validatePromotions().filter(item => item.name === row.name && item.callback_sha256 === row.callback_sha256);
  if (!matches.length) return row;
  assert.equal(matches.length, 1); assert.equal(row.callback, matches[0].callback);
  return { ...row, callback: matches[0].promoted_callback, callback_sha256: matches[0].promoted_callback_sha256 };
}
function promotedAllocation(owner, expected) {
  const item = allocations.find(row => row.owner === owner);
  if (!item) return expected;
  assert.equal(expected, item.old_sha256); assert.equal(hash(item.old_source), item.old_sha256);
  assert.equal(hash(item.new_source), item.new_sha256);
  return item.new_sha256;
}
async function assertFreshHistoricalRefusal(purpose, context, scenario) {
  const helper = context.codexPartitionHelpers();
  await context.withGraphDirEnv(undefined, () => helper.publicIntegrationFixture(async f => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: purpose === 'observed' });
    if (purpose === 'observed') delete options.integrationCapacity;
    await assert.rejects(context.createCodexDeliveryHost(options).run(selected()), /historical.*original|original.*recorded/i);
    assert.equal(controls.launches?.length || 0, 0);
    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);
    if (scenario !== undefined) assert.ok(promotions.some(row => row.parameters.some(parameter => parameter.value === scenario)));
  }));
}

async function recordHistoricalCodexV3(f, options, scriptsRoot = scripts) {
  const createHost = historicalCodexRuntime.getStore() || require(path.join(scriptsRoot, 'codex-runtime-host.cjs')).createCodexRuntimeHost;
  const retainedResources = options.integrationCapacity, sourceRecorder = options.recorder || retainedResources?.recorder;
  const authorityModule = historicalCodexAuthority(scriptsRoot);
  const finalId = retainedResources?.plan_sha256 && 'integration-final-' + retainedResources.plan_sha256;
  if (finalId && require(path.join(scriptsRoot, 'dispatch-boundary.cjs')).isDurableRecorder(sourceRecorder)
      && sourceRecorder.getVerifiedRecord(finalId)
      && fs.existsSync(path.join(f.worktree, authorityModule.ARTIFACT_ARCHIVE_DIR, hash(finalId), '.shipyard-role-artifact.json'))) {
    const current = authorityModule.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName });
    assert.equal(current?.authenticated, true); assert.equal(current.dispatch_id, finalId);
    assert.equal(current.contract, authorityModule.INTEGRATION_REVIEW_V3);
    return options;
  }
  const { load, authority, delivery, shared, nativeModule, original, scope, storageRoot, review, resources, recorder, resumed, partitions }
    = prepareHistoricalCodexV3(f, options, scriptsRoot);
  const capacityHost = authority.createIntegrationCapacityHost({ ...resources, partitions, runtime: 'codex', recorder });
  const lazy = ['shipyard.integration-partition-plan.v2', 'shipyard.integration-partition-plan.v3'].includes(partitions.plan.schema);
  const admitted = new Set(), stages = [];
  const admit = async stage => {
    if (admitted.has(stage.launch_sha256)) return;
    if (resumed) {
      try { authority.assertIntegrationAdmission({ prepared: stage, launch: stage, host: capacityHost }); admitted.add(stage.launch_sha256); return; }
      catch (error) {
        if (error.code !== 'INTEGRATION_CAPACITY_UNPROVEN' || !error.message.endsWith('exact launch has no protected capacity admission')) throw error;
      }
    }
    await authority.admitIntegrationCapacity({ prepared: stage, host: capacityHost }); admitted.add(stage.launch_sha256);
  };
  if (!lazy) {
    for (const unit of partitions.plan.units) {
      try { authority.validateIntegrationUnit({ partitions, unit_id: unit.unit_id }); continue; }
      catch (error) {
        if (error.code !== 'INTEGRATION_PARTITION_INVALID' || !error.message.endsWith('unit has no original protected index entry')) throw error;
      }
      stages.push(authority.prepareIntegrationUnit({ partitions, unit_id: unit.unit_id,
        dispatch_id: 'integration-unit-' + partitions.plan.plan_sha256 + '-' + unit.unit_id }));
    }
    if (!resumed && partitions.reserved_template) await admit(partitions.reserved_template);
    for (const stage of stages) await admit(stage);
  }
  const readResult = record => {
    const pin = record.receipt.runtime_evidence.transcript, raw = fs.readFileSync(pin.path);
    assert.equal(raw.length, pin.bytes); assert.equal(hash(raw), pin.sha256);
    const parsed = nativeModule.parseCodexStream(raw.toString('utf8'));
    assert.equal(parsed.session_id, record.receipt.runtime_evidence.session_id);
    const start = parsed.records.findLastIndex(row => row.type === 'turn.started');
    const messages = parsed.records.slice(start + 1).filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
    assert.equal(messages.length, 1);
    return JSON.parse(messages[0].item.text);
  };
  const execute = async stage => {
    delivery.recheckIntegrationReview(review, partitions);
    shared.assertEvidenceOnlyChanges(options, { ...original, integrationReview: review, integrationPartitions: partitions });
    const recorded = recorder.getVerifiedRecord(stage.dispatch_id);
    if (recorded) return readResult(recorded);
    await admit(stage);
    const nativeScope = { ...scope, run_id: 'integration-' + crypto.randomUUID() };
    const storage = path.join(storageRoot, nativeScope.run_id);
    const native = createHost({ ...options, scope: nativeScope, recorder, controller: false,
      ...(stage.mode === 'native-observed' ? { integrationIngress: request =>
        authority.createCodexIntegrationIngress({ prepared: stage, host: capacityHost, scope: nativeScope })(request) } : {}),
      transcriptDir: path.join(storage, 'transcripts'),
      additionalProtectedPaths: [authority.archiveAuthorityDirectory(scope.worktree)] });
    const pin = partitions.plan.instruction_pins.find(item => item.sha256 === stage.agent_sha256);
    const prefix = nativeModule.generatedInstructions(fs.readFileSync(path.resolve(pin.root, pin.path), 'utf8')) + '\n\n';
    assert.ok(stage.input.startsWith(prefix));
    authority.assertIntegrationAdmission({ prepared: stage, launch: stage, host: capacityHost });
    const fileInput = stage.mode === 'native-observed' && Buffer.byteLength(stage.input) > 1048576
      ? authority.prepareCodexIntegrationFileInput({ prepared: stage, host: capacityHost, scope: nativeScope,
        storageRoot: storage, graphDir: original.graph.directory }) : null;
    await load('codex-agent').launchAgent('integrator', { cwd: scope.worktree, flags: new Map(),
      signals: original.signals, dispatch_id: stage.dispatch_id, scope: nativeScope, host: native, recorder,
      capabilities: native.capabilities, agentDir: options.agentDir, agentManifest: options.agentManifest,
      env: options.env || process.env, context: { ticket: scope.ticket, phase: scope.phase, worktreePath: scope.worktree,
        runtime: 'codex', provider: 'openai', prompt: fileInput ? fileInput.prompt : stage.input.slice(prefix.length),
        ...(fileInput ? { input_transport: 'host-files', input_prepared: fileInput, input_bundle: fileInput.input_bundle } : {}) } });
    delivery.recheckIntegrationReview(review, partitions);
    shared.assertEvidenceOnlyChanges(options, { ...original, integrationReview: review, integrationPartitions: partitions });
    return readResult(recorder.getVerifiedRecord(stage.dispatch_id));
  };
  for (const unit of partitions.plan.units) {
    try { authority.validateIntegrationUnit({ partitions, unit_id: unit.unit_id }); continue; }
    catch (error) {
      if (error.code !== 'INTEGRATION_PARTITION_INVALID' || !error.message.endsWith('unit has no original protected index entry')) throw error;
    }
    const stage = stages.find(item => item.unit_id === unit.unit_id) || authority.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'integration-unit-' + partitions.plan.plan_sha256 + '-' + unit.unit_id });
    const result = await execute(stage);
    authority.sealIntegrationUnit({ prepared: stage, recorder, dispatchId: stage.dispatch_id, result });
    if (result.completeness !== 'complete' || result.outcome !== 'passed' || result.required_context.length)
      throw Object.assign(new Error('incomplete, failing or context-blocked unit requires repair'), { code: 'INTEGRATION_PARTITION_INVALID' });
  }
  const final = authority.prepareIntegrationAggregate({ partitions, dispatch_id: 'integration-final-' + partitions.plan.plan_sha256 });
  await execute(final);
  return { ...options, recorder, integrationCapacity: resources };
}

async function assertOriginalRecordingFault(scenario, context) {
  const { withGraphDirEnv, codexPartitionHelpers, codexPartitionFixture } = context;
  return (() => withGraphDirEnv(undefined, async () => {
  const helper = codexPartitionHelpers();
  await helper.fixture(async f => {
    const { options, resources, controls } = codexPartitionFixture(f, helper);
    if (scenario === 'missing-renderer') delete resources.renderLaunch;
    if (scenario === 'unknown-window') controls.noWindow = true;
    controls.mutate = (proof, kind, payload) => {
      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';
      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';
      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;
      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'
          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template
          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)
        proof.input_tokens_upper_bound = 100000000;
      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';
    };
    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };
    controls.result = result => {
      if (scenario === 'wrong-output') result.runtime = 'claude';
      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';
      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }
    };
    controls.native = rows => {
      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';
      if (scenario === 'native-result-substitution') {
        const final = rows.find(row => row.payload?.phase === 'final_answer');
        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];
        final.payload.content[0].text = JSON.stringify(result);
        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);
      }
    };
    await assert.rejects(recordHistoricalCodexV3(f, options),
      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));
    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',
      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);
    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);
    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);
  });
}))();
}

async function assertOriginalHistoricalPins(context) {
  const { withGraphDirEnv, codexPartitionHelpers, codexPartitionFixture, createCodexDeliveryHost } = context;
  return (() => withGraphDirEnv(undefined, async () => {
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
    const selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };
    await assert.rejects(recordHistoricalCodexV3(f, options), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.equal(controls.launches.length, 2);
    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);
    const old = fs.readFileSync(path.join(f.worktree, historical[0].path));
    fs.appendFileSync(path.join(f.worktree, historical[0].path), 'tamper');
    await assert.rejects(recordHistoricalCodexV3(f, options), /archive|pin|changed|digest/i);
    fs.writeFileSync(path.join(f.worktree, historical[0].path), old);
    helper.write(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR + '/unlisted/unrelated.json', '{}');
    await assert.rejects(recordHistoricalCodexV3(f, options), /archive|membership/i);
    fs.rmSync(path.join(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR, 'unlisted'), { recursive: true });
    options.integrationCapacity.plan_sha256 = controls.measured[0].plan_sha256;
    const restarted = createCodexDeliveryHost(options);
    await recordHistoricalCodexV3(f, options);
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
    await assert.rejects(restarted.run(selected), { code: 'STALE_CONTEXT' });
    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
  });
}))();
}

let fixtureContext;
function contextForFixtures() {
  return fixtureContext ||= require('./helpers/phase53-delivery-fixture.cjs').createDeliveryFixture();
}
function integrationFixture(action) {
  const context = contextForFixtures();
  return context.withGraphDirEnv(undefined, () => {
    const helper = context.codexPartitionHelpers();
    return helper.publicIntegrationFixture(f => action(f, helper));
  });
}

const sourcePromotions = [
  {
    "path": "tests/unit/phase53-z29f-historical-action-repeat.test.cjs",
    "inherited_sha256": "a6e6eaa07622d4f8f482a76e53675b186dbe74a5bb8cfdf7429c63bbebf1d754",
    "deltas": [
      {
        "before": "test('public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');\n    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });\n    const historical = roleArtifacts.authenticatedArchivePins(f.worktree);\n    const receipt = structuredClone(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt);\n    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');\n    helper.write(f.worktree, 'src/consumer.cjs', 'exact Codex primary line \u03a9\\n'.repeat(3000)); helper.commit(f, 'complete partitioned source');\n    const { options, controls } = codexPartitionFixture(f, helper);\n    options.integrationCapacity.capacity.unit_input_bytes = 128 * 1024;\n    let interrupted = false;\n    controls.render = launch => {\n      if (controls.launches?.length === 2 && launch.kind !== 'reserved-template' && !interrupted) {\n        interrupted = true; throw new Error('fixture interruption before next native reservation');\n      }\n    };\n    controls.onLaunch = (input, payload) => {\n      assert.equal(input.includes('<AUTHENTICATED_CONTEXT_PACKET>'), false);\n      assert.equal(controls.measured.filter(item => item.reserved_template).length, 1);\n      assert.ok(controls.measured.filter(item => item.kind === 'unit').length > 1);\n      assert.equal(fs.existsSync(evidencePath), false);\n      if (payload.kind === 'phase') assert.ok(payload.unit_artifacts.length > 1);\n    };\n    const host = createCodexDeliveryHost(options), selected = { role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } };\n    await assert.rejects(host.run(selected), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');\n    assert.equal(controls.launches.length, 2);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const old = fs.readFileSync(path.join(f.worktree, historical[0].path));\n    fs.appendFileSync(path.join(f.worktree, historical[0].path), 'tamper');\n    await assert.rejects(host.run(selected), /archive|pin|changed|digest/i);\n    fs.writeFileSync(path.join(f.worktree, historical[0].path), old);\n    helper.write(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR + '/unlisted/unrelated.json', '{}');\n    await assert.rejects(host.run(selected), /archive|membership/i);\n    fs.rmSync(path.join(f.worktree, roleArtifacts.ARTIFACT_ARCHIVE_DIR, 'unlisted'), { recursive: true });\n    options.integrationCapacity.plan_sha256 = controls.measured[0].plan_sha256;\n    const restarted = createCodexDeliveryHost(options);\n    const result = await restarted.run(selected);\n    assert.equal(result.result.kind, 'phase');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(result.receipt.runtime, 'codex');\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    const units = controls.launches.filter(item => item.payload.kind === 'unit');\n    assert.equal(new Set(units.map(item => item.payload.assignment.unit_id)).size, units.length);\n    assert.equal(controls.measured.length, controls.launches.length + 1);\n    const final = controls.measured.at(-1);\n    assert.equal(final.kind, 'phase'); assert.equal(final.reserved_template, undefined);\n    assert.notEqual(final.verified_index_sha256, '0'.repeat(64));\n    assert.equal(final.unit_artifacts.length, units.length);\n    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, receipt);\n    for (const pin of historical) roleArtifacts.assertArchivePin(f.worktree, pin);\n    const manifests = roleArtifacts.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))\n      .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));\n    assert.equal(new Set(manifests.map(item => item.producer_launch)).size, manifests.length);\n    assert.equal(manifests.filter(item => item.artifact_kind === 'integration-unit').length, units.length);\n    await assert.rejects(restarted.run(selected), /reserved|archive|membership|baseline/i);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n  });\n}));\n",
        "after": "test('public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('pins', context));\n"
      },
      {
        "before": "test('public Codex v3 accepts omitted capacity through original observed evidence', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.publicIntegrationFixture(async f => {\n    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: true });\n    delete options.integrationCapacity;\n    const result = await createCodexDeliveryHost(options).run({ role: 'integrator',\n      context: { review_contract: 'shipyard.integration-review.v3' } });\n    assert.equal(result.receipt.compliance, 'verified');\n    assert.equal(result.result.outcome, 'passed');\n    assert.equal(controls.measured, undefined);\n    assert.ok(controls.launches.filter(item => item.payload.kind === 'unit').length > 0);\n    assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);\n    assert.equal(result.operational_diagnostic.authoritative, false);\n    assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);\n    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);\n  });\n}));\n",
        "after": "test('public Codex v3 accepts omitted capacity through original observed evidence', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('observed', context));\n"
      }
    ]
  },
  {
    "path": "tests/unit/phase53-z29g-historical-action-covered.test.cjs",
    "inherited_sha256": "a940188bf86e929b87fdf8ba1e5200cf68b2580fbeb18107bed169f3b548e239",
    "deltas": [
      {
        "before": "test('public Codex v3 refuses ' + scenario + ' with behavior-only capacity', () => withGraphDirEnv(undefined, async () => {\n  const helper = codexPartitionHelpers();\n  await helper.fixture(async f => {\n    const { options, resources, controls } = codexPartitionFixture(f, helper);\n    if (scenario === 'missing-renderer') delete resources.renderLaunch;\n    if (scenario === 'unknown-window') controls.noWindow = true;\n    controls.mutate = (proof, kind, payload) => {\n      if (scenario === 'foreign-window' && kind === 'window') proof.runtime = 'claude';\n      if (scenario === 'foreign-counter' && kind === 'measurement') proof.runtime = 'claude';\n      if (scenario === 'unknown-instructions' && kind === 'request') delete proof.frame.base_instructions;\n      if (scenario === 'over-bound-unit' && kind === 'measurement' && payload.kind === 'unit'\n          || scenario === 'over-bound-template' && kind === 'measurement' && payload.reserved_template\n          || scenario === 'over-bound-actual-final' && kind === 'measurement' && payload.kind === 'phase' && !payload.reserved_template)\n        proof.input_tokens_upper_bound = 100000000;\n      if (scenario === 'changed-exact-input' && kind === 'request' && controls.measured?.length >= 2) proof.input += 'changed';\n    };\n    controls.onLaunch = () => { if (scenario === 'source-substitution') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), 'changed'); };\n    controls.result = result => {\n      if (scenario === 'wrong-output') result.runtime = 'claude';\n      if (scenario === 'incomplete-unit') result.completeness = 'incomplete';\n      if (scenario === 'failed-unit') { result.outcome = 'human-review-required'; result.required_context = ['Unresolved interaction.']; }\n    };\n    controls.native = rows => {\n      if (scenario === 'native-input-substitution') rows.find(row => row.payload?.role === 'user').payload.content[0].text += 'changed';\n      if (scenario === 'native-result-substitution') {\n        const final = rows.find(row => row.payload?.phase === 'final_answer');\n        const result = JSON.parse(final.payload.content[0].text); result.conclusions = ['Substituted original native result.'];\n        final.payload.content[0].text = JSON.stringify(result);\n        rows.find(row => row.payload?.type === 'task_complete').payload.last_agent_message = JSON.stringify(result);\n      }\n    };\n    await assert.rejects(createCodexDeliveryHost(options).run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }),\n      error => /INTEGRATION_|STALE_|WORKTREE_|REVIEW_|INVALID_|ARTIFACT_|RUNTIME_/.test(error.code || ''));\n    const prelaunch = ['missing-renderer', 'unknown-window', 'foreign-window', 'foreign-counter',\n      'unknown-instructions', 'over-bound-unit', 'over-bound-template', 'changed-exact-input'].includes(scenario);\n    assert.equal(controls.launches?.length || 0, prelaunch ? 0 : 1);\n    assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);\n  });\n}));\n",
        "after": "test('public Codex v3 refuses ' + scenario + ' with behavior-only capacity', () => require('./phase53-z29i-recorded-integration-compatibility.test.cjs').assertFreshHistoricalRefusal('capacity', context, scenario));\n"
      },
      {
        "before": "    const key = JSON.stringify([record.module, record.name, record.callback, record.callback_sha256]);\n",
        "after": "    const promoted = require('./phase53-z29i-recorded-integration-compatibility.test.cjs').promoteOriginal(record);\n    const key = JSON.stringify([promoted.module, promoted.name, promoted.callback, promoted.callback_sha256]);\n"
      },
      {
        "before": "    assert.equal(hash(sources[family]), expected[family + '_sha256'], 'original declaration parameters/body: ' + family);\n",
        "after": "    assert.equal(hash(sources[family]), family === 'delivery'\n      ? require('./phase53-z29i-recorded-integration-compatibility.test.cjs').promotedAllocation(owner, expected.delivery_sha256)\n      : expected[family + '_sha256'], 'original declaration parameters/body: ' + family);\n"
      },
      {
        "before": "      assert.deepEqual(records, original.records.filter(selected));\n",
        "after": "      assert.deepEqual(records, original.records.filter(selected).map(require('./phase53-z29i-recorded-integration-compatibility.test.cjs').promoteSelection));\n"
      },
      {
        "before": "    const files = s.unitFiles(), tasks = s.unitTasks(files);\n",
        "after": "    const files = require('./phase53-z29i-recorded-integration-compatibility.test.cjs').historicalFiles(s.unitFiles()), tasks = s.unitTasks(files);\n"
      },
      {
        "before": "      assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`), actual.shards[index]);\n",
        "after": "      assert.deepEqual(require('./phase53-z29i-recorded-integration-compatibility.test.cjs').historicalSelection(s, `${index + 1}/${actual.shards.length}`), actual.shards[index]);\n"
      }
    ]
  },
  {
    "path": "tests/unit/phase49-incremental-integration.test.cjs",
    "inherited_sha256": "e6c67d966bad622a699518651a9c4dfa28b6b9174f15c7a53c4e92f871b55bb6",
    "deltas": [
      {
        "before": "async function supportedPartitionCaller(f, nativeRuntime, options) {\n",
        "after": "async function supportedPartitionCaller(f, nativeRuntime, options) {\n  if (nativeRuntime === 'codex')\n    options = await require('./phase53-z29i-recorded-integration-compatibility.test.cjs').recordHistoricalCodexV3(f, options);\n"
      },
      {
        "before": "async function withCodexIngressHost(intercept, action) {\n  const runtimePath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');\n  const deliveryPath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');\n  const authorityPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');\n  const evidenceHostPath = require.resolve('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');\n  const originalRuntime = require.cache[runtimePath].exports, originalDelivery = require.cache[deliveryPath];\n  const originalAuthority = require.cache[authorityPath], originalReader = authority;\n  const originalEvidenceHost = require.cache[evidenceHostPath];\n  try {\n    require.cache[runtimePath].exports = { ...originalRuntime,\n      createCodexRuntimeHost: options => intercept(options, originalRuntime.createCodexRuntimeHost) };\n    delete require.cache[evidenceHostPath];\n    require(evidenceHostPath);\n    delete require.cache[deliveryPath];\n    require(deliveryPath);\n    require.cache[runtimePath].exports = originalRuntime;\n    await action();\n  } finally {\n    require.cache[runtimePath].exports = originalRuntime;\n    require.cache[deliveryPath] = originalDelivery;\n    require.cache[evidenceHostPath] = originalEvidenceHost;\n    require.cache[authorityPath] = originalAuthority;\n    authority = originalReader;\n  }\n}\n",
        "after": "async function withCodexIngressHost(intercept, action) {\n  const runtimePath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');\n  const deliveryPath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');\n  const authorityPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');\n  const evidenceHostPath = require.resolve('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');\n  const originalRuntime = require.cache[runtimePath].exports, originalDelivery = require.cache[deliveryPath];\n  const originalAuthority = require.cache[authorityPath], originalReader = authority;\n  const originalEvidenceHost = require.cache[evidenceHostPath];\n  try {\n    const createCodexRuntimeHost = options => intercept(options, originalRuntime.createCodexRuntimeHost);\n    require.cache[runtimePath].exports = { ...originalRuntime, createCodexRuntimeHost };\n    delete require.cache[evidenceHostPath];\n    require(evidenceHostPath);\n    delete require.cache[deliveryPath];\n    require(deliveryPath);\n    require.cache[runtimePath].exports = originalRuntime;\n    await require('./phase53-z29i-recorded-integration-compatibility.test.cjs').withHistoricalCodexRuntime(createCodexRuntimeHost, action);\n  } finally {\n    require.cache[runtimePath].exports = originalRuntime;\n    require.cache[deliveryPath] = originalDelivery;\n    require.cache[evidenceHostPath] = originalEvidenceHost;\n    require.cache[authorityPath] = originalAuthority;\n    authority = originalReader;\n  }\n}\n"
      }
    ]
  },
  {
    "path": "tests/unit/integration-test-partitions.test.cjs",
    "inherited_sha256": "42b068bd56d2c0a2e64063ad0a030596d6e1784dce93691bd2247b0ca5633197",
    "deltas": [
      {
        "before": "const suffixDigest = 'c4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1';\n",
        "after": "const suffixDigest = '385077bd669ec7a0437d51882546c78457b1a5bb400807130d6cc49a680877ae';\n"
      }
    ]
  }
];
function assertSourcePromotions() {
  for (const row of sourcePromotions) {
    let restored = fs.readFileSync(path.resolve(__dirname, '../..', row.path), 'utf8');
    for (const delta of [...row.deltas].reverse()) {
      assert.equal(restored.split(delta.after).length - 1, 1, 'one exact authorized source delta: ' + row.path);
      restored = restored.replace(delta.after, delta.before);
    }
    assert.equal(hash(restored), row.inherited_sha256, 'complete inherited actual32 source and every unpromoted byte');
  }
}

function assertHelperPromotion() {
  const file = path.join(__dirname, 'phase49-incremental-integration.test.cjs'), source = fs.readFileSync(file, 'utf8');
  const deltas = sourcePromotions.find(row => row.path === 'tests/unit/phase49-incremental-integration.test.cjs').deltas;
  assert.equal(deltas.length, 2);
  let restored = source;
  for (const delta of [...deltas].reverse()) {
    assert.equal(restored.split(delta.after).length - 1, 1);
    restored = restored.replace(delta.after, delta.before);
  }
  assert.equal(hash(restored), 'e6c67d966bad622a699518651a9c4dfa28b6b9174f15c7a53c4e92f871b55bb6');
  const anchor = "const assert = require('node:assert/strict');";
  assert.equal(hash(restored.slice(restored.indexOf(anchor))), 'c4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1');
  const pin = fs.readFileSync(path.join(__dirname, 'integration-test-partitions.test.cjs'), 'utf8')
    .match(/const suffixDigest = '([a-f0-9]{64})';/)[1];
  assert.equal(hash(source.slice(source.indexOf(anchor))), pin);
  const partitions = JSON.parse(source.match(/const integrationPartitionEntries = Object.freeze\((\[[\s\S]*?\])\);/)[1]);
  assert.equal(partitions.length, 107);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(number => partitions.filter(([, value]) => value === number).length), [1, 1, 24, 25, 28, 28]);
}

function assertDiscovery() {
  const g = require('./phase53-z29g-historical-action-covered.test.cjs'), s = require('./shard-files.cjs');
  const files = s.unitFiles(), tasks = s.unitTasks(files), manifest = s.readManifest();
  assert.deepEqual(manifest.shards, g.original.baseline16); assert.equal(manifest.shards.length, 16);
  const baseline = g.original.shards.flat(), seven = g.owners.slice(1);
  const roleOwners = ['phase53-z29t-role-architecture-archives.test.cjs', 'phase53-z29u-role-containment.test.cjs',
    'phase53-z29v-role-code-review.test.cjs', 'phase53-z29w-role-integration.test.cjs'];
  const inherited = s.appendShard(manifest, [...baseline, ...seven, ...roleOwners].sort());
  assert.equal(inherited.shards.length, 62);
  assert.equal(hash(JSON.stringify(inherited.shards.slice(0, 50))), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
  assert.deepEqual(inherited.shards.slice(0, 51), g.original.shards);
  assert.deepEqual(inherited.shards.slice(51, 58), seven.map(owner => [owner]));
  const current = s.appendShard(manifest, tasks);
  assert.deepEqual(current.shards.slice(0, 58), inherited.shards.slice(0, 58));
  assert.deepEqual(current.shards.slice(58, 60), newOwners.map(owner => [owner]));
  assert.deepEqual(current.shards.slice(60, 64), roleOwners.map(owner => [owner]));
  let nextIndex = 0;
  for (const row of inherited.shards) {
    while (nextIndex < current.shards.length && JSON.stringify(current.shards[nextIndex]) !== JSON.stringify(row)) nextIndex++;
    assert.ok(nextIndex++ < current.shards.length, 'every delivered32 row is an ordered subsequence');
  }
  assert.equal(current.shards.length, 64 + tasks.filter(task => !inherited.shards.flat().includes(task) && !newOwners.includes(task)).length);
  assert.equal(current.shards.length + 3, 67 + current.shards.length - 64);
  assert.equal(new Set(current.shards.flat()).size, tasks.length);
  assert.deepEqual([...current.shards.flat()].sort(), tasks);
  for (let index = 0; index < current.shards.length; index++)
    assert.deepEqual(s.selectTaskShard(`${index + 1}/${current.shards.length}`), current.shards[index]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z29i-discovery-'));
  try {
    for (const file of files) fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    const stages = [
      [['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs', 'phase53-z29z-generated-base-merge.test.cjs'], 67, 70],
      [['phase53-z30-semantic-material-retention.test.cjs', 'phase53-z30b-semantic-material-retention.test.cjs', 'phase53-z30c-semantic-material-retention.test.cjs',
        'phase53-z30d-semantic-material-retention.test.cjs', 'phase53-z30e-semantic-material-retention.test.cjs', 'phase53-z30f-semantic-material-retention.test.cjs'], 73, 76],
    ];
    const plannedTasks = [...inherited.shards.flat(), ...newOwners];
    for (const [additions, units, ci] of stages) {
      plannedTasks.push(...additions);
      const planned = s.appendShard(manifest, [...plannedTasks].sort());
      assert.equal(planned.shards.length, units); assert.equal(units + 3, ci);
      assert.deepEqual(planned.shards.slice(0, 64), current.shards.slice(0, 64));
      for (const file of additions) if (!fs.existsSync(path.join(directory, file)))
        fs.writeFileSync(path.join(directory, file), "'use strict';\nrequire('node:test')('future declared task', () => {});\n");
      const discovered = s.unitTasks(s.unitFiles(directory)), actual = s.appendShard(manifest, discovered);
      assert.deepEqual([...actual.shards.flat()].sort(), discovered);
      for (let index = 0; index < actual.shards.length; index++)
        assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`, directory, manifest), actual.shards[index]);
    }
    const before = s.appendShard(manifest, s.unitTasks(s.unitFiles(directory)));
    const future = 'zz-genuine-future-discovery.test.cjs';
    fs.writeFileSync(path.join(directory, future), "'use strict';\nrequire('node:test')('future discovery', () => {});\n");
    const actual = s.appendShard(before, s.unitTasks(s.unitFiles(directory)));
    assert.deepEqual(actual.shards.slice(0, before.shards.length), before.shards);
    assert.deepEqual(actual.shards.at(-1), [future]);
    for (let index = 0; index < actual.shards.length; index++)
      assert.deepEqual(s.selectTaskShard(`${index + 1}/${actual.shards.length}`, directory, before), actual.shards[index]);
    assert.throws(() => s.selectTaskShard(`1/${before.shards.length}`, directory, before), /shard count must match manifest/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function packageInventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = prefix + entry.name, stat = fs.lstatSync(path.join(root, name));
    assert.equal(stat.isSymbolicLink(), false);
    const row = { path: name, type: entry.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o7777,
      ...(entry.isDirectory() ? {} : { bytes: stat.size, sha256: hash(fs.readFileSync(path.join(root, name))) }) };
    return entry.isDirectory() ? [row, ...packageInventory(root, name + '/')] : [row];
  });
}
function assertWholePackage(generated, repository = path.resolve(__dirname, '../..'), packaged = path.join(repository, 'plugins/shipyard')) {
  assert.deepEqual(packageInventory(packaged), packageInventory(generated));
  for (const source of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    assert.deepEqual(packageInventory(path.join(packaged, 'host', source)), packageInventory(path.join(repository, source)));
  const digest = crypto.createHash('sha256');
  for (const row of packageInventory(packaged).filter(row => row.type === 'file' && !['package-build.json', '.codex-plugin/plugin.json'].includes(row.path))) {
    digest.update(row.path + '\0'); digest.update(fs.readFileSync(path.join(packaged, row.path)));
  }
  const sourceDigest = digest.digest('hex'), manifest = fs.readFileSync(path.join(packaged, '.codex-plugin/plugin.json'));
  const version = JSON.parse(fs.readFileSync(path.join(repository, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version
    + '+codex.' + sourceDigest.slice(0, 16);
  assert.equal(JSON.parse(manifest).version, version);
  const identity = JSON.parse(fs.readFileSync(path.join(packaged, 'package-build.json')));
  assert.equal(identity.version, version);
  assert.equal(identity.digest, crypto.createHash('sha256').update(sourceDigest).update('\0').update(manifest).digest('hex'));
  return identity;
}

function coldRecordedConsumption(f, options, scriptsRoot = scripts) {
  const input = { f: Object.fromEntries(['root', 'worktree', 'head', 'base', 'phase', 'graphDir', 'rows', 'state', 'memberHead', 'pr'].map(key => [key, f[key]])),
    options: Object.fromEntries(['scope', 'storageRoot', 'agentDir', 'agentManifest', 'capabilities', 'probe', 'env'].map(key => [key, options[key]])),
    plan: options.integrationCapacity.plan_sha256, store: options.recorder.storeDir, scriptsRoot };
  const file = path.join(f.root, 'cold-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  try {
    const output = require('node:child_process').execFileSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
      const input = JSON.parse(fs.readFileSync(process.argv[1])), { f, options, scriptsRoot } = input;
      os.homedir = () => f.root; process.env.CODEX_HOME = options.env.CODEX_HOME;
      const helper = require(process.argv[2]).createDeliveryFixture().codexPartitionHelpers();
      const recorder = require(path.join(scriptsRoot, 'dispatch-boundary.cjs')).createDurableRecorder(input.store);
      let launches = 0;
      const host = require(path.join(scriptsRoot, 'codex-delivery-host.cjs')).createCodexDeliveryHost({
        ...helper.projectOptions(f), ...options, recorder, integrationCapacity: { plan_sha256: input.plan, recorder },
        spawn() { launches++; throw new Error('cold compatibility must never launch'); } });
      host.run({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v3' } }).then(result => {
        const current = require(path.join(scriptsRoot, 'role-artifact.cjs')).currentIntegrationVerdict({
          worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base, graphDir: f.graphDir,
          headBranch: f.pr.headRefName });
        process.stdout.write(JSON.stringify({ dispatch_id: result.dispatch_id, receipt: result.receipt,
          result: result.result, current, launches }));
      }).catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
    `, file, path.join(__dirname, 'helpers/phase53-delivery-fixture.cjs')], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(output);
  } finally { fs.unlinkSync(file); }
}


const gitReaderDeltas = [
  {
    "before": "",
    "after": "function createReviewGitReader(root, entries, maximumBytes) {\n  const limit = 16 * 1024 * 1024;\n  const objects = [...new Set(entries.filter(entry => entry.type === 'blob'\n    && ['100644', '100755'].includes(entry.mode)).map(entry => entry.object))];\n  const invalid = () => fail('REVIEW_IMPACT_UNCERTAIN', 'invalid complete Git object batch');\n  if (objects.some(object => !/^[a-f0-9]{40}$/.test(object))) invalid();\n  const request = selected => {\n    const input = Buffer.from(selected.join('\\n') + '\\n', 'ascii');\n    if (input.length > limit) fail('CONTEXT_OVER_BOUND', 'complete Git object request exceeds its bound');\n    return input;\n  };\n  const parse = (raw, selected, sizes) => {\n    if (!Buffer.isBuffer(raw) || raw.length > limit) invalid();\n    let offset = 0;\n    const result = [];\n    for (let index = 0; index < selected.length; index++) {\n      const end = raw.indexOf(10, offset);\n      if (end < offset || end - offset > 128) invalid();\n      const header = raw.subarray(offset, end).toString('latin1');\n      const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(header);\n      const size = match && Number(match[2]);\n      if (!match || match[1] !== selected[index] || !Number.isSafeInteger(size) || size < 0) invalid();\n      offset = end + 1;\n      if (sizes) {\n        if (size !== sizes[index] || size > raw.length - offset - 1 || raw[offset + size] !== 10) invalid();\n        result.push(raw.subarray(offset, offset + size));\n        offset += size + 1;\n      } else result.push(size);\n    }\n    if (offset !== raw.length) invalid();\n    return result;\n  };\n  let sizes, cursor = 0, pending = [], pendingStart = 0;\n  return (object, total) => {\n    if (object !== objects[cursor]) invalid();\n    if (!sizes) sizes = parse(execFileSync('git', ['-C', root, 'cat-file', '--batch-check'], {\n      input: request(objects), timeout: 30000, maxBuffer: limit,\n    }), objects);\n    const size = sizes[cursor];\n    if (size > limit || total + size > maximumBytes)\n      fail('CONTEXT_OVER_BOUND', 'complete impact sources exceed their bound');\n    let raw;\n    if (cursor < pendingStart + pending.length) {\n      raw = pending[cursor - pendingStart];\n      pending[cursor - pendingStart] = null;\n    } else if (Buffer.byteLength(object + ' blob ' + size + '\\n') + size + 1 > limit) {\n      raw = execFileSync('git', ['-C', root, 'cat-file', 'blob', object], { maxBuffer: limit });\n      if (!Buffer.isBuffer(raw) || raw.length !== size) invalid();\n    } else {\n      let framedBytes = 0, bodyBytes = 0, end = cursor;\n      while (end < objects.length) {\n        const next = sizes[end];\n        if (next > limit) break;\n        const framed = Buffer.byteLength(objects[end] + ' blob ' + next + '\\n') + next + 1;\n        if (framed > limit - framedBytes || next > maximumBytes - total - bodyBytes) break;\n        framedBytes += framed; bodyBytes += next; end++;\n      }\n      const selected = objects.slice(cursor, end);\n      pending = parse(execFileSync('git', ['-C', root, 'cat-file', '--batch'], {\n        input: request(selected), maxBuffer: limit,\n      }), selected, sizes.slice(cursor, end));\n      pendingStart = cursor;\n      raw = pending[0]; pending[0] = null;\n    }\n    cursor++;\n    return raw;\n  };\n}\n\n"
  },
  {
    "before": "",
    "after": "  let readGit = createReviewGitReader(root, [...previousInventory, ...inventory]\n    .filter(entry => /\\.(?:cjs|mjs|js|ts|tsx|jsx)$/.test(entry.path)), maximumBytes);\n"
  },
  {
    "before": "    const size = Number(reviewGit(root, ['cat-file', '-s', entry.object]));\n    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || total + size > maximumBytes)\n      fail('CONTEXT_OVER_BOUND', 'complete impact sources exceed their bound');\n    const raw = execFileSync('git', ['-C', root, 'cat-file', 'blob', entry.object], { maxBuffer: 16 * 1024 * 1024 });\n",
    "after": "    const raw = readGit(entry.object, total);\n"
  },
  {
    "before": "",
    "after": "  readGit = createReviewGitReader(root, [...affected].sort().map(name => now.get(name) || previous.get(name)).filter(Boolean), maximumBytes);\n"
  }
];

function originalGitReaderSource(source = fs.readFileSync(path.join(scripts, 'role-artifact.cjs'), 'utf8')) {
  let original = source;
  for (const { before, after } of gitReaderDeltas) {
    assert.equal(original.split(after).length - 1, 1, 'only the exact private Git reader seam may be inverted');
    original = original.replace(after, before);
  }
  assert.equal(hash(original), '7b8e6c9fde7b4b5f505c0149d651caca6730dfa3cad236e56588d42797d78f5e');
  return original;
}

function isolatedImpactReader(source, exec) {
  const Module = require('node:module'), file = path.join(scripts, 'role-artifact.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(scripts);
  const load = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:child_process' && exec ? { execFileSync: exec } : load(name);
  loaded._compile(source + `
    module.exports = (input, selection, checked) => {
      admissionReviewInputs.set(input, { checked, identity: selection.current });
      try { return rebuildReviewImpactPacket(input, selection); }
      finally { admissionReviewInputs.delete(input); }
    };`, file);
  return loaded.exports;
}

function assertGitPacketParity(review) {
  const child = require('node:child_process'), calls = [];
  const exec = (name, argv, options) => {
    calls.push({ argv, options });
    return child.execFileSync(name, argv, options);
  };
  const checked = require(path.join(scripts, 'codex-arch-review-context.cjs')).verifyFileInput(review.currentInput);
  const direct = isolatedImpactReader(originalGitReaderSource());
  const batch = isolatedImpactReader(fs.readFileSync(path.join(scripts, 'role-artifact.cjs'), 'utf8'), exec);
  const expected = direct(review.currentInput, review.selection, checked);
  const actual = batch(review.currentInput, review.selection, checked);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(actual, expected);
  assert.ok(calls.filter(row => row.argv.includes('--batch-check')).length >= 2, 'each original pass reads fresh metadata');
  assert.ok(calls.filter(row => row.argv.includes('--batch')).length >= 2, 'each original pass reads fresh content');
  assert.equal(calls.some(row => row.argv.includes('-s')), false);
  return actual;
}

function fixtureGit(root, ...args) {
  return contextForFixtures().git(root, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args);
}

function prepareGitReview(f, options) {
  const shared = require(path.join(scripts, 'claude-role-host.cjs'));
  const prepared = shared.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49' });
  const policy = require(path.join(scripts, 'model-policy.cjs'));
  const selection = policy.resolveDispatch({ runtime: 'codex', role: 'integrator', signals: prepared.signals });
  const instructions = require(path.join(scripts, 'codex-arch-review-context.cjs'))
    .instructionEvidence(options.agentDir, selection.agent_file, options.agentManifest);
  const scope = { ...options.scope, worktree: f.worktree, phase: prepared.phaseNumber, ticket: prepared.ticket,
    run_id: 'git-reader-' + crypto.randomUUID() };
  return require(path.join(scripts, 'codex-delivery-host.cjs')).prepareIntegrationLineage(scope, prepared, {
    ...options, nativeRuntime: 'codex', dispatchId: scope.run_id, storageRoot: path.join(f.root, scope.run_id),
    generatedInstructionBytes: instructions.generated_instruction_bytes,
    instructionBinding: { agent_file: selection.agent_file, agent_path: path.resolve(options.agentDir, selection.agent_file),
      agent_sha256: instructions.sha256, installed_files: instructions.installed_files, policy_hash: selection.policy_hash },
  });
}

function isolatedGitReader(exec) {
  const Module = require('node:module'), file = path.join(scripts, 'role-artifact.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(scripts);
  const load = loaded.require.bind(loaded);
  loaded.require = name => name === 'node:child_process' && exec ? { execFileSync: exec } : load(name);
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { createReviewGitReader };', file);
  return loaded.exports.createReviewGitReader;
}

function gitBatchBoundary(bodies, mutate = (raw) => raw) {
  const calls = [];
  const exec = (program, argv, options) => {
    assert.equal(program, 'git'); assert.deepEqual(argv.slice(0, 3), ['-C', '/fixture', 'cat-file']);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    assert.equal(options.encoding, undefined);
    const kind = argv[3], objects = kind === 'blob' ? [argv[4]] : options.input.toString('ascii').trimEnd().split('\n');
    if (kind === '--batch-check') assert.equal(options.timeout, 30000);
    else assert.equal(options.timeout, undefined);
    calls.push({ kind, objects, input: options.input });
    const raw = kind === 'blob' ? bodies.get(objects[0]) : Buffer.concat(objects.map(object => {
      const body = bodies.get(object), header = Buffer.from(object + ' blob ' + body.length + '\n');
      return kind === '--batch-check' ? header : Buffer.concat([header, body, Buffer.from('\n')]);
    }));
    return mutate(raw, kind, calls);
  };
  return { exec, calls };
}

function registerTests(test) {
  test('known-parent Git oracle rejects unrelated edits, missing deltas and duplicate seams', () => {
    originalGitReaderSource();
    const current = fs.readFileSync(path.join(scripts, 'role-artifact.cjs'), 'utf8');
    for (const changed of [current + '\n', current.replace(gitReaderDeltas[0].after, ''),
      current + gitReaderDeltas[0].after, current.replace("'complete impact packet exceeds its bound: raw_lineage_bytes observed '", "'changed bound '")])
      assert.throws(() => originalGitReaderSource(changed));
  });
  test('fresh recorded operations recheck source, head, base, references, preflight, archive, native and index after success', () => integrationFixture(async (f, helper) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z29i-fresh-reader-'));
    try {
      const generated = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'package'));
      const staged = path.join(generated, 'host/plugins/delivery-pipeline/scripts');
      const { options, controls } = helper.publicPartitionFixture(f, 'codex');
      options.recorder = require(path.join(staged, 'dispatch-boundary.cjs')).createDurableRecorder(path.join(f.root, 'fresh-original-receipts'));
      await recordHistoricalCodexV3(f, options, staged);
      const { partitions } = prepareHistoricalCodexV3(f, options, staged), plan = partitions.plan;
      const authority = require(path.join(staged, 'role-artifact.cjs'));
      const host = require(path.join(staged, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options);
      const count = controls.launches.length;
      const original = await host.run(selected());
      assert.equal(original.result.outcome, 'passed');
      const refuse = async label => {
        await assert.rejects(host.run(selected()), undefined, label);
        assert.equal(controls.launches.length, count, label + ' must never launch');
      };
      const protectedRoot = authority.archiveAuthorityDirectory(f.worktree);
      const finalId = 'integration-final-' + plan.plan_sha256;
      const record = options.recorder.getVerifiedRecord(finalId);
      const nativePin = record.receipt.runtime_evidence.native_session_evidence;
      const nativeCandidates = require(path.join(staged, 'codex-runtime-host.cjs')).nativeSessionCandidates(
        path.join(process.env.CODEX_HOME, 'sessions'), nativePin.session_id);
      assert.equal(nativeCandidates.length, 1);
      const native = typeof nativeCandidates[0] === 'string' ? nativeCandidates[0] : nativeCandidates[0].path;
      const files = [
        ['source', path.join(f.worktree, 'src/provider.cjs')],
        ['instructions', path.join(options.agentDir, plan.identity.agent_file)],
        ['criteria reference', require(path.join(staged, 'claude-reference-content.cjs')).REFERENCE_PATHS.integrator],
        ['producer source', path.join(staged, 'phase-integrator-preflight.cjs')],
        ['planning reference', path.join(f.worktree, Object.values(f.rows)[0].plan)],
        ['preflight graph', path.join(f.graphDir, 'delivery-state.json')],
        ['protected plan', path.join(protectedRoot, 'integration-plan-' + plan.plan_sha256 + '.json')],
        ['protected index', path.join(protectedRoot, 'integration-units-' + plan.plan_sha256 + '.json')],
        ['original archive', path.join(f.worktree, authority.ARTIFACT_ARCHIVE_DIR, hash(finalId), 'INTEGRATION.md')],
        ['native transcript', record.receipt.runtime_evidence.transcript.path], ['native session', native],
      ];
      for (const [label, file] of files) {
        const bytes = fs.readFileSync(file);
        fs.appendFileSync(file, '\nchanged after original successful reconstruction\n');
        try { await refuse(label); } finally { fs.writeFileSync(file, bytes); }
      }
      const baseRef = fixtureGit(f.worktree, 'rev-parse', '--symbolic-full-name', plan.identity.base_ref);
      assert.match(baseRef, /^refs\//);
      const baseOid = fixtureGit(f.worktree, 'rev-parse', '--verify', baseRef + '^{commit}');
      assert.equal(baseOid, plan.identity.base);
      assert.equal(baseOid, f.base);
      const changedBase = fixtureGit(f.worktree, 'rev-parse', '--verify', f.head + '^{commit}');
      assert.notEqual(changedBase, baseOid);
      for (const [ref, changed, restored] of [['HEAD', f.base, f.head], [baseRef, changedBase, baseOid]]) {
        fixtureGit(f.worktree, 'update-ref', ref, changed);
        try { await refuse(ref); } finally { fixtureGit(f.worktree, 'update-ref', ref, restored); }
      }
      const object = fixtureGit(f.worktree, 'rev-parse', f.head + ':src/provider.cjs');
      const replacementFile = path.join(f.root, 'replacement-source');
      fs.writeFileSync(replacementFile, 'exports.replacedAfterSuccess = true;\n');
      const replacement = fixtureGit(f.worktree, 'hash-object', '-w', replacementFile);
      fixtureGit(f.worktree, 'replace', object, replacement);
      try { await refuse('fresh replacement source facts'); } finally { fixtureGit(f.worktree, 'replace', '-d', object); }
      const again = await host.run(selected());
      assert.deepEqual(again.result, original.result); assert.equal(again.dispatch_id, original.dispatch_id);
      assert.equal(controls.launches.length, count);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }));
  test('Git batch chunks include every frame byte and retain direct maximum-body fallback', () => {
    const limit = 16 * 1024 * 1024, objects = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const entry = object => ({ object, type: 'blob', mode: '100644' });
    const overhead = size => Buffer.byteLength(objects[0] + ' blob ' + size + '\n') + 1;
    const firstSize = 8 * 1024 * 1024;
    const secondSize = limit - firstSize - overhead(firstSize) - overhead(firstSize);
    for (const extra of [0, 1]) {
      const bodies = new Map([[objects[0], Buffer.alloc(firstSize, 97)], [objects[1], Buffer.alloc(secondSize + extra, 98)], [objects[2], Buffer.alloc(0)]]);
      const boundary = gitBatchBoundary(bodies);
      const read = isolatedGitReader(boundary.exec)('/fixture', objects.map(entry), 32 * 1024 * 1024);
      let total = 0;
      for (const object of objects) { assert.deepEqual(read(object, total), bodies.get(object)); total += bodies.get(object).length; }
      const batches = boundary.calls.filter(call => call.kind === '--batch');
      assert.deepEqual(batches.map(call => call.objects), extra ? [[objects[0]], [objects[1], objects[2]]] : [[objects[0], objects[1]], [objects[2]]]);
      assert.equal(boundary.calls.some(call => call.kind === 'blob'), false);
    }
    for (const size of [limit - overhead(limit), limit - overhead(limit) + 1, limit, limit + 1]) {
      const body = Buffer.alloc(size, 32), boundary = gitBatchBoundary(new Map([[objects[0], body]]));
      const read = isolatedGitReader(boundary.exec)('/fixture', [entry(objects[0])], 32 * 1024 * 1024);
      if (size > limit) {
        assert.throws(() => read(objects[0], 0), { code: 'CONTEXT_OVER_BOUND' });
        assert.deepEqual(boundary.calls.map(call => call.kind), ['--batch-check']);
      } else {
        assert.deepEqual(read(objects[0], 0), body);
        assert.deepEqual(boundary.calls.map(call => call.kind), ['--batch-check', size + overhead(size) > limit ? 'blob' : '--batch']);
      }
    }
    const fallback = gitBatchBoundary(new Map([[objects[0], Buffer.alloc(limit)]]),
      (raw, kind) => kind === 'blob' ? raw.subarray(0, raw.length - 1) : raw);
    assert.throws(() => isolatedGitReader(fallback.exec)('/fixture', [entry(objects[0])], limit)(objects[0], 0),
      { code: 'REVIEW_IMPACT_UNCERTAIN' });
    assert.deepEqual(fallback.calls.map(call => call.kind), ['--batch-check', 'blob']);
  });
  test('Git batch read-ahead stays within each separate logical pass including binary bytes', () => {
    const objects = ['a'.repeat(40), 'b'.repeat(40)], entries = objects.map(object => ({ object, type: 'blob', mode: '100644' }));
    const bodies = new Map(objects.map(object => [object, Buffer.from([0, 255, 10])]));
    const boundary = gitBatchBoundary(bodies), create = isolatedGitReader(boundary.exec);
    for (let pass = 0; pass < 2; pass++) {
      const read = create('/fixture', entries, 5);
      assert.deepEqual(read(objects[0], 0), bodies.get(objects[0]));
      assert.throws(() => read(objects[1], 3), { code: 'CONTEXT_OVER_BOUND' });
    }
    assert.deepEqual(boundary.calls.map(call => [call.kind, call.objects]), [
      ['--batch-check', objects], ['--batch', [objects[0]]], ['--batch-check', objects], ['--batch', [objects[0]]],
    ]);
    const fresh = create('/fixture', entries, 6);
    assert.deepEqual(fresh(objects[0], 0), bodies.get(objects[0]));
    assert.deepEqual(fresh(objects[1], 3), bodies.get(objects[1]));
    assert.deepEqual(boundary.calls.at(-1).objects, objects);
  });
  test('Git batch retains separate 16 and 32 MiB material budgets without framing or binary credit', () => {
    const MiB = 1024 * 1024, objects = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const entries = objects.map(object => ({ object, type: 'blob', mode: '100644' }));
    const bodies = new Map(objects.map(object => [object, Buffer.alloc(12 * MiB)]));
    for (const limit of [16 * MiB, 32 * MiB]) {
      const boundary = gitBatchBoundary(bodies), create = isolatedGitReader(boundary.exec);
      for (let pass = 0; pass < 2; pass++) {
        const read = create('/fixture', entries, limit);
        const count = Math.floor(limit / (12 * MiB));
        for (let index = 0; index < count; index++) assert.deepEqual(read(objects[index], index * 12 * MiB), bodies.get(objects[index]));
        assert.throws(() => read(objects[count], count * 12 * MiB), { code: 'CONTEXT_OVER_BOUND' });
      }
      assert.equal(boundary.calls.filter(call => call.kind === '--batch-check').length, 2);
      assert.deepEqual(boundary.calls.filter(call => call.kind === '--batch').flatMap(call => call.objects),
        [...objects.slice(0, Math.floor(limit / (12 * MiB))), ...objects.slice(0, Math.floor(limit / (12 * MiB)))]);
    }
  });
  test('real Git complete packets match the exact inherited direct reader including replacements and both passes', () => integrationFixture(async (f, helper) => {
    const sources = {
      'scan/empty.cjs': '', 'scan/empty-alias.cjs': '',
      'scan/multiline.cjs': "require('./empty.cjs');\nexports.value = 'Ω';\n",
      'scan/binary.cjs': Buffer.from([0, 10, 97]), 'scan/binary-alias.cjs': Buffer.from([0, 10, 97]),
      'scan/invalid.cjs': Buffer.from([255, 254, 10]), 'scan/executable.cjs': 'exports.value = 7;\n',
      'scan/regular-alias.cjs': 'exports.value = 7;\n',
      'scan/maximum-binary.cjs': Buffer.alloc(16 * 1024 * 1024),
      'scan/removed.txt': 'original removed source\n', 'scan/rename.cjs': 'exports.rename = true;\n',
    };
    for (const [name, content] of Object.entries(sources)) helper.write(f.worktree, name, content);
    fs.chmodSync(path.join(f.worktree, 'scan/executable.cjs'), 0o755);
    fs.symlinkSync('empty.cjs', path.join(f.worktree, 'scan/nonregular.cjs'));
    fixtureGit(f.worktree, 'add', '.'); fixtureGit(f.worktree, 'commit', '-qm', 'original scan endpoint');
    f.base = fixtureGit(f.worktree, 'rev-parse', 'HEAD'); f.pr.baseRefOid = f.base;
    fixtureGit(f.worktree, 'update-ref', 'refs/heads/main', f.base);
    fixtureGit(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
    fs.unlinkSync(path.join(f.worktree, 'scan/removed.txt'));
    fs.renameSync(path.join(f.worktree, 'scan/rename.cjs'), path.join(f.worktree, 'scan/renamed.cjs'));
    helper.write(f.worktree, 'src/provider.cjs', "require('../scan/multiline.cjs');\nrequire('../scan/binary.cjs');\n");
    fixtureGit(f.worktree, 'add', 'scan');
    helper.commit(f, 'changed full scan endpoint'); f.memberHead = f.head;
    const { options } = helper.publicPartitionFixture(f, 'codex');
    const review = prepareGitReview(f, options);
    const before = assertGitPacketParity(review);
    assert.ok(before.endpoint_delta.some(row => row.status.startsWith('R')));
    assert.ok(before.newly_reviewed.some(row => row.deleted && row.path === 'scan/removed.txt'));
    assert.ok(before.source_inventories.current.some(row => row.path === 'scan/executable.cjs' && row.mode === '100755'));
    assert.ok(before.newly_reviewed.some(row => row.path === 'scan/empty.cjs' && row.content === '' && row.bytes === 0));
    assert.ok(before.limitations.some(row => row.boundaries?.some(boundary => boundary.path === 'scan/nonregular.cjs'
      && boundary.reason === 'non-regular-source-boundary')));
    for (const name of ['scan/binary.cjs', 'scan/binary-alias.cjs', 'scan/invalid.cjs'])
      assert.ok(before.limitations.some(row => row.boundaries?.some(boundary => boundary.path === name && boundary.reason === 'binary-source-boundary')));
    const object = fixtureGit(f.worktree, 'rev-parse', f.head + ':scan/multiline.cjs');
    helper.write(f.worktree, 'replacement-body', "require('./executable.cjs');\nexports.replaced = true;\n");
    const replacement = fixtureGit(f.worktree, 'hash-object', '-w', 'replacement-body');
    fs.unlinkSync(path.join(f.worktree, 'replacement-body'));
    fixtureGit(f.worktree, 'replace', object, replacement);
    try {
      const replaced = assertGitPacketParity(review);
      assert.notEqual(replaced.digest, before.digest);
      assert.ok(replaced.newly_reviewed.some(row => row.path === 'scan/multiline.cjs' && row.content.includes('replaced')));
    } finally { fixtureGit(f.worktree, 'replace', '-d', object); }
    assert.equal(assertGitPacketParity(review).digest, before.digest);
  }));
  test('complete serialized lineage retains its separate final bound after a permitted direct raw read', () => integrationFixture(async (f, helper) => {
    helper.write(f.worktree, 'assets/escaped.json', '\\'.repeat(16 * 1024 * 1024 - 1));
    fixtureGit(f.worktree, 'add', 'assets'); fixtureGit(f.worktree, 'commit', '-qm', 'original maximum material endpoint');
    f.base = fixtureGit(f.worktree, 'rev-parse', 'HEAD'); f.pr.baseRefOid = f.base;
    fixtureGit(f.worktree, 'update-ref', 'refs/heads/main', f.base);
    fixtureGit(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
    helper.write(f.worktree, 'src/provider.cjs', "require('../assets/escaped.json');\n");
    helper.commit(f, 'affected maximum raw source'); f.memberHead = f.head;
    const { options } = helper.publicPartitionFixture(f, 'codex');
    assert.throws(() => prepareGitReview(f, options), error => error.code === 'CONTEXT_OVER_BOUND'
      && /complete impact packet exceeds its bound: raw_lineage_bytes observed/.test(error.message));
  }));
  test('Git batch parser preserves raw bodies and first object order without public exports', () => {
    const objects = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
    const bodies = new Map(objects.map((object, index) => [object, [Buffer.alloc(0), Buffer.from('line\nΩ\n'), Buffer.from([0, 255, 10])][index]]));
    const boundary = gitBatchBoundary(bodies);
    const entries = [objects[0], objects[1], objects[0], objects[2]].map(object => ({ object, type: 'blob', mode: '100644' }));
    entries.unshift({ object: 'd'.repeat(40), type: 'blob', mode: '120000' });
    const read = isolatedGitReader(boundary.exec)('/fixture', entries, 1024);
    let total = 0;
    for (const object of objects) { const raw = read(object, total); assert.deepEqual(raw, bodies.get(object)); total += raw.length; }
    assert.deepEqual(boundary.calls.map(row => [row.kind, row.objects]), [['--batch-check', objects], ['--batch', objects]]);
    assert.equal(Object.hasOwn(require(path.join(scripts, 'role-artifact.cjs')), 'createReviewGitReader'), false);
  });
  test('Git batch parser refuses malformed metadata and content at the subprocess boundary', () => {
    const a = 'a'.repeat(40), b = 'b'.repeat(40), bodies = new Map([[a, Buffer.from('a\n')], [b, Buffer.from('b\n')]]);
    const entries = [a, b].map(object => ({ object, type: 'blob', mode: '100644' }));
    const faults = [
      raw => Buffer.from(raw.toString().replace(a, b)),
      raw => Buffer.from(raw.toString().replace('blob', 'tree')),
      raw => Buffer.from(raw.toString().replace('blob 2', 'blob -1')),
      raw => Buffer.from(raw.toString().replace('blob 2', 'blob 9007199254740992')),
      raw => Buffer.from(raw.toString().replace('blob 2', 'blob 02')),
      raw => Buffer.from(raw.toString().replace(a + ' blob 2', a + ' missing')),
      raw => Buffer.from(raw.toString().replace(a + ' blob 2', a + ' blob ' + '9'.repeat(129))),
      raw => raw.subarray(0, raw.length - 1),
      raw => raw.subarray(0, raw.indexOf(10) + 1),
      raw => Buffer.concat([raw, Buffer.from('\n')]),
      raw => Buffer.concat([raw, raw]),
      () => Buffer.alloc(16 * 1024 * 1024 + 1),
      () => 'text instead of bytes',
      () => { throw Object.assign(new Error('git failed'), { code: 'ENOBUFS' }); },
      () => { throw Object.assign(new Error('git failed'), { status: 128 }); },
    ];
    for (const kind of ['--batch-check', '--batch']) for (const [index, fault] of faults.entries()) {
      const boundary = gitBatchBoundary(bodies, (raw, actual) => actual === kind ? fault(raw) : raw);
      assert.throws(() => isolatedGitReader(boundary.exec)('/fixture', entries, 1024)(a, 0), undefined, kind + '/' + index);
      assert.equal(boundary.calls.some(call => call.kind === 'blob'), false);
    }
    for (const fault of [
      raw => { const copy = Buffer.from(raw); copy[copy.indexOf(10) + 3] = 0; return copy; },
      raw => Buffer.from(raw.toString().replace('blob 2', 'blob 3')),
      raw => raw.subarray(0, raw.indexOf(10) + 2),
    ]) {
      const boundary = gitBatchBoundary(bodies, (raw, kind) => kind === '--batch' ? fault(raw) : raw);
      assert.throws(() => isolatedGitReader(boundary.exec)('/fixture', entries, 1024)(a, 0));
      assert.equal(boundary.calls.some(call => call.kind === 'blob'), false);
    }
  });
  test('original runtime handoff restores nested failures and isolates concurrent actions', async () => {
    const first = () => {}, second = () => {}, nested = () => {};
    const failure = new Error('action failed');
    assert.equal(historicalCodexRuntime.getStore(), undefined);
    await withHistoricalCodexRuntime(first, async () => {
      assert.equal(historicalCodexRuntime.getStore(), first);
      assert.throws(() => withHistoricalCodexRuntime(nested, () => {
        assert.equal(historicalCodexRuntime.getStore(), nested);
        throw failure;
      }), error => error === failure);
      assert.equal(historicalCodexRuntime.getStore(), first);
      await assert.rejects(withHistoricalCodexRuntime(nested, async () => {
        await Promise.resolve();
        assert.equal(historicalCodexRuntime.getStore(), nested);
        throw failure;
      }), error => error === failure);
      assert.equal(historicalCodexRuntime.getStore(), first);
    });
    let releaseFirst, releaseSecond;
    const firstReady = new Promise(resolve => { releaseFirst = resolve; });
    const secondReady = new Promise(resolve => { releaseSecond = resolve; });
    await Promise.all([
      withHistoricalCodexRuntime(first, async () => {
        releaseFirst();
        await secondReady;
        assert.equal(historicalCodexRuntime.getStore(), first);
      }),
      withHistoricalCodexRuntime(second, async () => {
        releaseSecond();
        await firstReady;
        assert.equal(historicalCodexRuntime.getStore(), second);
      }),
    ]);
    assert.equal(historicalCodexRuntime.getStore(), undefined);
  });
  test('fresh explicit v3 refuses without launching original work', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    await assert.rejects(require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected()),
      /original|recorded|historical/i);
    assert.equal(controls.launches?.length || 0, 0);
  }));
  test('genuine recorded original units and final publish with zero compatibility launches', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    await recordHistoricalCodexV3(f, options);
    const count = controls.launches.length;
    const measurements = controls.measured.length;
    options.integrationCapacity = { plan_sha256: options.integrationCapacity.plan_sha256, recorder: options.recorder };
    assert.ok(count > 1);
    assert.equal(controls.launches.filter(row => row.payload.kind === 'phase').length, 1);
    const result = await require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected());
    assert.equal(result.receipt.compliance, 'verified'); assert.equal(result.result.outcome, 'passed');
    assert.equal(controls.launches.length, count);
    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);
    await recordHistoricalCodexV3(f, options);
    const again = await require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected());
    assert.equal(again.dispatch_id, result.dispatch_id); assert.equal(controls.launches.length, count);
    assert.equal(controls.measured.length, measurements);
  }));
  test('caller-created genuine frozen plan with missing originals grants zero launch authority', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    prepareHistoricalCodexV3(f, options);
    await assert.rejects(require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected()),
      /recorded|original/i);
    assert.equal(controls.launches?.length || 0, 0);
  }));

  for (const scenario of promotions.filter(row => row.declaration === 4569).map(row => row.parameters[0].value))
    test('original lower native recording preserves refusal: ' + scenario, () => assertOriginalRecordingFault(scenario, contextForFixtures()));
  test('closed promotions reject missing, duplicate, foreign hash and extra identities', () => {
    validatePromotions();
    for (const changed of [promotions.slice(1), [...promotions, promotions[0]],
      promotions.map((row, index) => index ? row : { ...row, callback_sha256: 'f'.repeat(64) }),
      promotions.map((row, index) => index ? row : { ...row, promoted_callback_sha256: 'f'.repeat(64) }),
      promotions.map((row, index) => index ? row : { ...row, declaration: 4609 }),
      promotions.map((row, index) => index ? row : { ...row, parameters: [{ value: 'foreign' }] })])
      assert.throws(() => validatePromotions(changed));
    const g = require('./phase53-z29g-historical-action-covered.test.cjs');
    for (const row of promotions) {
      const original = g.originalSuites.D.records.find(item => item.declaration === row.declaration && item.name === row.name);
      assert.deepEqual(promoteOriginal(original), { ...original, callback: row.promoted_callback, callback_sha256: row.promoted_callback_sha256 });
      const actual = g.rowsFor(row.owner).find(item => item.name === row.name);
      assert.equal(actual.callback, row.promoted_callback); assert.equal(actual.callback_sha256, row.promoted_callback_sha256);
    }
    for (const item of allocations) {
      const definitions = require('./' + item.owner);
      assert.equal(definitions.registerDeliveryCases.toString(), item.new_source);
      let restored = item.new_source;
      for (const declaration of [...new Set(promotions.filter(row => row.owner === item.owner).map(row => row.declaration))]) {
        const row = promotions.find(row => row.declaration === declaration);
        assert.equal(restored.split(row.promoted_callback).length - 1, 1);
        restored = restored.replace(row.promoted_callback, row.callback);
      }
      assert.equal(restored, item.old_source); assert.equal(hash(restored), item.old_sha256);
    }
    for (const module of ['D', 'R']) g.assertOriginalUnion(g.collectionsFor(module), module);
    const caller = g.originalSuites.D.records.find(row => row.declaration === 4609);
    assert.equal(caller.callback_sha256, 'f73916184520d5968c2081c0904ad63c2b785759f3d3e753d755f1d5b752ab1a');
    assert.equal(promoteOriginal(caller), caller);
  });

  test('sole helper suffix promotion retains the exact original107-case partition source', assertHelperPromotion);
  test('complete current prefix and genuine future tasks retain every delivered row', assertDiscovery);

  test('recorded observed originals retain optional unknown accounting and cold current consumption', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex', { observed: true });
    delete options.integrationCapacity;
    await recordHistoricalCodexV3(f, options);
    assert.equal(controls.measured, undefined);
    const count = controls.launches.length;
    assert.ok(count > 1); assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
    const result = await require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected());
    assert.equal(result.receipt.compliance, 'verified'); assert.equal(result.result.outcome, 'passed');
    assert.equal(result.operational_diagnostic.authoritative, false);
    assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);
    assert.equal(controls.launches.length, count); assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);
    const cold = coldRecordedConsumption(f, options);
    assert.equal(cold.launches, 0); assert.equal(cold.current.authenticated, true);
    assert.deepEqual(cold.receipt, result.receipt); assert.deepEqual(cold.result, result.result);
  }));

  test('recorded historical originals retain archive pins, exact restart and one independent actual final',
    () => assertOriginalHistoricalPins(contextForFixtures()));

  test('missing original unit/final, foreign recorder, native and current identity tamper refuse with zero public launches', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    await recordHistoricalCodexV3(f, options);
    const prepared = prepareHistoricalCodexV3(f, options);
    const authority = require(path.join(scripts, 'role-artifact.cjs'));
    const host = () => require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options);
    const count = controls.launches.length, originalRecorder = options.recorder;
    const refuse = async () => {
      await assert.rejects(host().run(selected()));
      assert.equal(controls.launches.length, count);
    };
    const dispatches = ['integration-unit-' + prepared.partitions.plan.plan_sha256 + '-' + prepared.partitions.plan.units[0].unit_id,
      'integration-final-' + prepared.partitions.plan.plan_sha256];
    for (const dispatch of dispatches) {
      const file = path.join(originalRecorder.storeDir, 'record-' + hash(dispatch) + '.json'), bytes = fs.readFileSync(file);
      fs.unlinkSync(file);
      try { await refuse(); } finally { fs.writeFileSync(file, bytes, { mode: 0o600 }); }
    }
    const originalPlan = options.integrationCapacity.plan_sha256;
    options.integrationCapacity.plan_sha256 = 'f'.repeat(64);
    try { await refuse(); } finally { options.integrationCapacity.plan_sha256 = originalPlan; }
    for (const copy of [false, true]) {
      const store = path.join(f.root, copy ? 'copied-recorder' : 'empty-recorder');
      if (copy) fs.cpSync(originalRecorder.storeDir, store, { recursive: true });
      const foreign = require(path.join(scripts, 'dispatch-boundary.cjs')).createDurableRecorder(store);
      options.recorder = foreign; options.integrationCapacity.recorder = foreign;
      try { await refuse(); } finally { options.recorder = originalRecorder; options.integrationCapacity.recorder = originalRecorder; }
    }
    const authorityDirectory = authority.archiveAuthorityDirectory(f.worktree);
    for (const file of [path.join(authorityDirectory, 'integration-plan-' + originalPlan + '.json'),
      path.join(authorityDirectory, 'integration-units-' + originalPlan + '.json')]) {
      const bytes = fs.readFileSync(file), envelope = JSON.parse(bytes);
      envelope.payload = { ...envelope.payload, substituted: true };
      fs.writeFileSync(file, JSON.stringify(envelope));
      try { await refuse(); } finally { fs.writeFileSync(file, bytes); }
    }
    const finalRecord = originalRecorder.getVerifiedRecord(dispatches[1]);
    const stream = finalRecord.receipt.runtime_evidence.transcript.path;
    const bytes = fs.readFileSync(stream); fs.appendFileSync(stream, 'malformed');
    try { await refuse(); } finally { fs.writeFileSync(stream, bytes); }
    const nativePin = finalRecord.receipt.runtime_evidence.native_session_evidence;
    const candidates = require(path.join(scripts, 'codex-runtime-host.cjs')).nativeSessionCandidates(path.join(process.env.CODEX_HOME, 'sessions'), nativePin.session_id);
    assert.equal(candidates.length, 1);
    const nativeFile = typeof candidates[0] === 'string' ? candidates[0] : candidates[0].path;
    const native = fs.readFileSync(nativeFile); fs.appendFileSync(nativeFile, '\n');
    try { await refuse(); } finally { fs.writeFileSync(nativeFile, native); }
    for (const file of [path.join(f.worktree, Object.values(f.rows)[0].plan),
      path.join(options.agentDir, prepared.partitions.plan.identity.agent_file), path.join(f.worktree, 'src/provider.cjs')]) {
      const original = fs.readFileSync(file); fs.appendFileSync(file, '\nchanged original identity\n');
      try { await refuse(); } finally { fs.writeFileSync(file, original); }
    }
    helper.write(f.worktree, 'unexpected-product.cjs', 'unrelated local change');
    try { await refuse(); } finally { fs.unlinkSync(path.join(f.worktree, 'unexpected-product.cjs')); }
    const result = await host().run(selected());
    assert.equal(result.result.outcome, 'passed'); assert.equal(controls.launches.length, count);
  }));
  test('failed index persistence retains incomplete original custody and refuses any compatibility replay', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    const rename = fs.renameSync;
    const stop = new Error('fixture interruption before original index acknowledgement');
    let stopped = false;
    fs.renameSync = (from, to) => {
      if (!stopped && /integration-units-[a-f0-9]{64}\.json$/.test(String(to))
          && JSON.parse(fs.readFileSync(from)).payload.entries.length) { stopped = true; throw stop; }
      return rename(from, to);
    };
    try { await assert.rejects(recordHistoricalCodexV3(f, options), error => error === stop); }
    finally { fs.renameSync = rename; }
    assert.equal(stopped, true); assert.equal(controls.launches.length, 1);
    const host = require(path.join(scripts, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(host.run(selected()), error => error.code === 'ENOENT'
        && error.message.includes('.shipyard-role-artifacts/') && error.message.includes('.shipyard-role-artifact.json'));
      assert.equal(controls.launches.length, 1);
    }
    const payload = controls.launches[0].payload;
    const dispatch = 'integration-unit-' + payload.plan_sha256 + '-' + payload.assignment.unit_id;
    assert.equal(options.recorder.getVerifiedRecord(dispatch).receipt.compliance, 'verified');
  }));

  test('ordinary semantic integration still runs two actual workers and one independent actual final', () => integrationFixture(async (f, helper) => {
    const Module = require('node:module'), file = path.join(__dirname, 'phase53-codex-integration.test.cjs');
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(__dirname);
    const originalLoad = Module._load;
    try {
      Module._load = function(name, ...args) { return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args); };
      loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { semanticFixture, supportedPartitionCaller, captureOriginals };', file);
    } finally { Module._load = originalLoad; }
    const prepared = loaded.exports.semanticFixture(f);
    const result = await loaded.exports.supportedPartitionCaller(f, 'codex', prepared.options);
    assert.equal(result.result.review_contract, 'shipyard.semantic-review.v1');
    assert.deepEqual(prepared.completed, ['consumer-acceptance', 'producer-contract', 'final']);
    assert.equal(prepared.launches.filter(item => item.payload.stage === 'worker').length, 2);
    assert.equal(prepared.launches.filter(item => item.payload.stage === 'final').length, 1);
    assert.equal(new Set(prepared.launches.map(item => item.session)).size, 3);
    assert.equal(loaded.exports.captureOriginals(f, prepared).length, 2);
    assert.equal(helper.currentPartitionConsumer(f)?.authenticated, true);
  }));
  test('whole builder package and both identities authenticate every entry and reject each independent tamper', () => {
    const root = path.resolve(__dirname, '../..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z29i-package-'));
    try {
      const generated = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'generated'));
      assertWholePackage(generated);
      const repository = path.join(directory, 'source');
      for (const name of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
        fs.cpSync(path.join(root, name), path.join(repository, name), { recursive: true });
      const copy = path.join(repository, 'plugins/shipyard');
      fs.cpSync(generated, copy, { recursive: true });
      assertWholePackage(generated, repository, copy);
      for (const [base, name] of [
        [repository, 'plugins/delivery-pipeline/scripts/phase-code-review.cjs'],
        [repository, 'plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'],
        [repository, 'plugins/delivery-pipeline/scripts/role-artifact.cjs'],
        [copy, 'host/plugins/delivery-pipeline/scripts/phase-code-review.cjs'],
        [copy, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'],
        [copy, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs'],
        [copy, '.codex-plugin/plugin.json'], [copy, 'package-build.json'],
      ]) {
        const file = path.join(base, name), original = fs.readFileSync(file);
        fs.appendFileSync(file, '\nsubstituted');
        try { assert.throws(() => assertWholePackage(generated, repository, copy)); }
        finally { fs.writeFileSync(file, original); }
        assertWholePackage(generated, repository, copy);
      }
      const file = path.join(copy, 'host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'), mode = fs.statSync(file).mode & 0o7777;
      fs.chmodSync(file, mode ^ 0o100);
      try { assert.throws(() => assertWholePackage(generated, repository, copy)); } finally { fs.chmodSync(file, mode); }
      fs.writeFileSync(path.join(copy, 'unexpected-member'), 'foreign');
      try { assert.throws(() => assertWholePackage(generated, repository, copy)); } finally { fs.unlinkSync(path.join(copy, 'unexpected-member')); }
      assertWholePackage(generated, repository, copy);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  test('whole generated package consumes its genuine recorded native originals through a cold process', () => integrationFixture(async (f, helper) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z29i-cold-package-'));
    try {
      const generated = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'package'));
      const staged = path.join(generated, 'host/plugins/delivery-pipeline/scripts');
      const { options, controls } = helper.publicPartitionFixture(f, 'codex');
      options.recorder = require(path.join(staged, 'dispatch-boundary.cjs')).createDurableRecorder(path.join(f.root, 'staged-original-receipts'));
      await recordHistoricalCodexV3(f, options, staged);
      const count = controls.launches.length;
      const result = await require(path.join(staged, 'codex-delivery-host.cjs')).createCodexDeliveryHost(options).run(selected());
      assert.equal(result.result.outcome, 'passed'); assert.equal(controls.launches.length, count);
      const cold = coldRecordedConsumption(f, options, staged);
      assert.equal(cold.launches, 0); assert.equal(cold.current.authenticated, true);
      assert.equal(cold.dispatch_id, result.dispatch_id); assert.deepEqual(cold.receipt, result.receipt);
      assert.deepEqual(cold.result, result.result);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }));

  test('recorded original before unit sealing recovers its missing index with zero compatibility native work', () => integrationFixture(async (f, helper) => {
    const { options, controls } = helper.publicPartitionFixture(f, 'codex');
    const read = fs.readFileSync, stop = new Error('fixture lost original return before unit sealing');
    let stopped = false, checking = false;
    fs.readFileSync = function(file, ...args) {
      if (!checking && !stopped && typeof file === 'string' && file.endsWith('.jsonl') && file.includes('/transcripts/') && controls.launches?.length) {
        checking = true;
        let record;
        try {
          const payload = controls.launches[0].payload;
          record = options.recorder?.getVerifiedRecord('integration-unit-' + payload.plan_sha256 + '-' + payload.assignment.unit_id);
        } finally { checking = false; }
        if (record) { stopped = true; throw stop; }
      }
      return read.call(this, file, ...args);
    };
    try { await assert.rejects(recordHistoricalCodexV3(f, options), error => error === stop); }
    finally { fs.readFileSync = read; }
    assert.equal(stopped, true); assert.equal(controls.launches.length, 1);
    const delivery = require(path.join(scripts, 'codex-delivery-host.cjs'));
    await assert.rejects(delivery.createCodexDeliveryHost(options).run(selected()), { code: 'MISSING_RECEIPT' });
    assert.equal(controls.launches.length, 1);
    await recordHistoricalCodexV3(f, options);
    const count = controls.launches.length;
    const result = await delivery.createCodexDeliveryHost(options).run(selected());
    assert.equal(result.result.outcome, 'passed'); assert.equal(controls.launches.length, count);
    assert.equal(controls.launches.filter(row => row.payload.kind === 'phase').length, 1);
  }));

  test('complete four-owner inverse deltas source-prove every original against inherited actual32', assertSourcePromotions);

  test('whole generated cold publisher recovers exact unsent state and reconciles original remote effects', () => contextForFixtures().withGraphDirEnv(undefined, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'z29i-publisher-'));
    try {
      const generated = require('../../scripts/package-shipyard-codex.cjs').build(path.join(directory, 'package'));
      const publisher = require(path.join(generated, 'host/plugins/delivery-pipeline/scripts/phase-code-review.cjs'));
      require('./phase53-z29h-publication-unsent-recovery.test.cjs').publicationFixture(f => {
        f.seal();
        f.setDrift(live => f.operation('status')?.stage === 'prepared' ? { ...live, headRefOid: f.base } : live);
        assert.equal(publisher.publish(f.input(), f.options).status.ok, false);
        assert.equal(f.writes.filter(row => row.kind === 'status').length, 0);
        f.setDrift(null); f.seal();
        f.setMutation((kind, result) => { if (kind === 'status') throw new Error('lost original response'); return result; });
        assert.equal(publisher.publish(f.input(), f.options).status.ok, false);
        f.setMutation(null);
        assert.equal(publisher.publish(f.input(), f.options).status.ok, true);
        assert.equal(f.writes.filter(row => row.kind === 'status').length, 1);
      });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }));

  test('original restoration retains the original public fixture runtime interception', async () => {
    await integrationFixture(async (f, helper) => {
      const Module = require('node:module'), file = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
      const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(__dirname);
      const originalLoad = Module._load;
      try {
        Module._load = function(name, ...args) { return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args); };
        loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { withCodexIngressHost };', file);
      } finally { Module._load = originalLoad; }
      const stop = new Error('original native interception diagnostic');
      const prepared = helper.publicPartitionFixture(f, 'codex', { observed: true, onLaunch() { throw stop; } });
      let intercepted = 0;
      await loaded.exports.withCodexIngressHost((options, createHost) => {
        if (options.integrationIngress) intercepted++;
        return createHost(options);
      }, async () => {
        await assert.rejects(recordHistoricalCodexV3(f, prepared.options), /original native interception diagnostic/);
      });
      assert.equal(prepared.controls.launches.length, 1);
      assert.equal(intercepted, 1, 'original ingress and native adversarial assertions must reach their actual runtime factory');
    });
    await integrationFixture(async (f, helper) => {
      const prepared = helper.publicPartitionFixture(f, 'codex', { observed: true, native(rows) {
        rows.find(row => row.payload?.type === 'token_count').payload.info.model_context_window = 0;
      } });
      const authorityPath = require.resolve(path.join(scripts, 'role-artifact.cjs'));
      const originalAuthority = require.cache[authorityPath];
      try {
        delete require.cache[authorityPath];
        assert.notEqual(require(authorityPath), originalAuthority.exports, 'preceding cold readers replace the cached authority instance');
        await assert.rejects(recordHistoricalCodexV3(f, prepared.options), error =>
          error.code === 'INTEGRATION_PARTITION_INVALID' && /original native context window/.test(error.message));
        assert.equal(prepared.controls.launches.length, 1, 'cold reader reload preserves the next real original native refusal boundary');
      } finally { require.cache[authorityPath] = originalAuthority; }
    });
  });

}

module.exports = { withHistoricalCodexRuntime, historicalSelection, sourcePromotions, assertSourcePromotions, coldRecordedConsumption, packageInventory, assertWholePackage, assertHelperPromotion, assertDiscovery, assertOriginalRecordingFault, newOwners, historicalFiles, promotions, validatePromotions, promoteOriginal, promoteSelection, promotedAllocation, assertFreshHistoricalRefusal, prepareHistoricalCodexV3, recordHistoricalCodexV3, integrationFixture, registerTests };
function runPhysicalCase(name, signal) {
  const code = `
    const assert = require('node:assert/strict'), owner = require(process.argv[1]);
    const cases = new Map();
    owner.registerTests((name, callback) => { assert.equal(cases.has(name), false); cases.set(name, callback); });
    assert.equal(cases.has(process.argv[2]), true);
    Promise.resolve().then(cases.get(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(process.execPath, ['-e', code, __filename, name], {
      cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0, output = '', overflow = false;
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, 180000); timer.unref();
    signal.addEventListener('abort', stop, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { overflow = true; stop(); }
      else output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status, termination) => {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      if (overflow || status !== 0 || termination) reject(new Error(name + ': ' + (overflow ? 'child exceeded8MiB' : output || termination || status)));
      else resolve();
    });
  });
}
if (require.main === module) {
  const { describe, test } = require('node:test');
  describe('Recorded original integration compatibility', { concurrency: 2 }, () =>
    registerTests(name => test(name, { timeout: 180000 }, context => runPhysicalCase(name, context.signal))));
}
