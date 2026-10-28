'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const scripts = path.resolve(__dirname, '../../../plugins/delivery-pipeline/scripts');
const authority = require(path.join(scripts, 'role-artifact.cjs'));
const host = require(path.join(scripts, 'claude-role-host.cjs'));
const delivery = require(path.join(scripts, 'codex-delivery-host.cjs'));
const { createDurableRecorder, createDispatchBoundary } = require(path.join(scripts, 'dispatch-boundary.cjs'));
const { createClaudeDispatchAdapter } = require(path.join(scripts, 'claude-dispatch-adapter.cjs'));
const { createRunScope } = require(path.join(scripts, 'run-scope.cjs'));

async function recordHistoricalClaudeV3(f, options, request) {
  f = { ...f, worktree: f.worktree || f.root };
  assert.equal(typeof options.createRuntimeHost, 'function', 'historical fixture requires its hermetic runtime factory');
  const original = host.prepareNativeIntegratorContext(options, request || { worktree: f.worktree, phase: '49',
    review_contract: authority.INTEGRATION_REVIEW_V3 });
  const referencePath = require(path.join(scripts, 'claude-reference-content.cjs')).REFERENCE_PATHS.integrator;
  const reference = fs.readFileSync(referencePath);
  const storageRoot = options.storageRoot || f.root;
  const scope = { worktree: f.worktree, ticket: original.ticket, phase: original.phaseNumber, run_id: 'historical-v3-' + crypto.randomUUID() };
  const review = delivery.prepareIntegrationLineage(scope, original, { ...options, nativeRuntime: 'claude',
    dispatchId: scope.run_id, storageRoot: path.join(storageRoot, scope.run_id), generatedInstructionBytes: reference.length,
    instructionBinding: { agent_file: path.basename(referencePath), agent_path: referencePath,
      agent_sha256: crypto.createHash('sha256').update(reference).digest('hex'), installed_files: [],
      policy_hash: require(path.join(scripts, 'model-policy.cjs')).POLICY_HASH } });
  if (options.integrationCapacity !== undefined && !options.integrationCapacity?.plan_sha256
      && (!options.integrationCapacity || typeof options.integrationCapacity !== 'object' || !options.integrationCapacity.capacity))
    throw Object.assign(new Error('supplied strict capacity resources are malformed'), { code: 'INTEGRATION_CAPACITY_UNPROVEN' });
  const resources = options.integrationCapacity ||= {};
  const recorder = resources.recorder || createDurableRecorder(path.join(storageRoot, 'claude-public-receipts'));
  const resumed = Boolean(resources.plan_sha256);
  resources.recorder = recorder;
  const partitions = authority.prepareIntegrationPartitions({ review, capacity: resources.capacity, plan_sha256: resources.plan_sha256 });
  resources.plan_sha256 = partitions.plan.plan_sha256;
  const capacityHost = authority.createIntegrationCapacityHost({ ...resources,
    ...(typeof resources.renderLaunch === 'function' ? { renderLaunch: stage => resources.renderLaunch(stage, {
      model: stage.model, effort: stage.effort, schema: host.integrationStageSchema(stage), readOnly: true }) } : {}),
    partitions, runtime: 'claude', recorder });
  const stages = partitions.plan.units.map(unit => () => {
    try { authority.validateIntegrationUnit({ partitions, unit_id: unit.unit_id }); return null; }
    catch (error) {
      if (error.code !== 'INTEGRATION_PARTITION_INVALID' || !error.message.endsWith('unit has no original protected index entry')) throw error;
    }
    return authority.prepareIntegrationUnit({ partitions, unit_id: unit.unit_id,
      dispatch_id: 'integration-unit-' + partitions.plan.plan_sha256 + '-' + unit.unit_id });
  });
  const lazy = ['shipyard.integration-partition-plan.v2', 'shipyard.integration-partition-plan.v3'].includes(partitions.plan.schema);
  const admitted = new Set();
  const admit = async stage => {
    if (!admitted.has(stage.launch_sha256)) {
      if (resumed && stage.kind === 'unit' && !lazy)
        authority.assertIntegrationAdmission({ prepared: stage, launch: stage, host: capacityHost });
      else await authority.admitIntegrationCapacity({ prepared: stage, host: capacityHost });
      admitted.add(stage.launch_sha256);
    }
  };
  const preparedStages = lazy ? stages : stages.map(prepare => prepare());
  if (!lazy && !resumed) for (const stage of [partitions.reserved_template, ...preparedStages].filter(Boolean)) await admit(stage);
  const execute = async stage => {
    delivery.recheckIntegrationReview(review, partitions);
    const recorded = recorder.getVerifiedRecord(stage.dispatch_id);
    if (recorded) {
      const pin = recorded.receipt.transcript;
      authority.assertArchivePin(path.dirname(pin.path), { ...pin, path: path.basename(pin.path) });
      const parsed = require(path.join(scripts, 'claude-runtime-host.cjs')).parseClaudeStream(fs.readFileSync(pin.path, 'utf8'));
      assert.equal(parsed.session_id, recorded.receipt.session_id);
      const result = parsed.result.structured_output ?? parsed.result.result;
      return typeof result === 'string' ? JSON.parse(result) : result;
    }
    await admit(stage);
    const native = options.createRuntimeHost({ scope: createRunScope({ run_id: stage.dispatch_id,
      repository_id: original.canonical.commonPath, phase: original.phaseNumber, ticket: original.rows[0].id,
      worktree: f.worktree, runtime: 'claude', owner_id: 'historical-fixture-owner',
      dispatch: { runtime: 'claude', role: 'integrator', dispatch_id: stage.dispatch_id } }), recorder,
      recorderDir: recorder.storeDir, transcriptDir: path.join(storageRoot, stage.dispatch_id, 'transcripts') });
    assert.equal(native.recorder, recorder);
    let completed;
    const adapter = createClaudeDispatchAdapter({ capabilities: native.capabilities, host: { async launch(selection) {
      completed = await native.agent(stage.input, { model: selection.model, effort: selection.effort,
        schema: host.integrationStageSchema(stage), readOnly: true });
      return native.applicationEvidence({ result: completed });
    } } });
    const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder, cwd: f.worktree });
    authority.assertIntegrationAdmission({ prepared: stage, launch: stage, host: capacityHost });
    await boundary.dispatch({ runtime: 'claude', role: 'integrator', signals: original.signals, dispatch_id: stage.dispatch_id }, {
      ticket: original.ticket, role: 'integrator', phase: original.phase, worktreePath: original.canonical.projectRoot,
      sourceRevision: original.canonical.head, contextPacket: original.packet });
    delivery.recheckIntegrationReview(review, partitions);
    return typeof completed.output === 'string' ? JSON.parse(completed.output) : completed.output;
  };
  for (let index = 0; index < preparedStages.length; index++) {
    try { authority.validateIntegrationUnit({ partitions, unit_id: partitions.plan.units[index].unit_id }); continue; }
    catch (error) {
      if (error.code !== 'INTEGRATION_PARTITION_INVALID' || !error.message.endsWith('unit has no original protected index entry')) throw error;
    }
    const prepared = preparedStages[index];
    const stage = lazy ? prepared() : prepared;
    if (!stage) continue;
    const result = await execute(stage);
    authority.sealIntegrationUnit({ prepared: stage, recorder, dispatchId: stage.dispatch_id, result });
    if (result.completeness !== 'complete' || result.outcome !== 'passed' || result.required_context.length)
      throw Object.assign(new Error('incomplete, failing or context-blocked unit requires repair'), { code: 'INTEGRATION_PARTITION_INVALID' });
  }
  const final = authority.prepareIntegrationAggregate({ partitions, dispatch_id: 'integration-final-' + partitions.plan.plan_sha256 });
  await execute(final);
  return { ...options, integrationCapacity: { ...resources, plan_sha256: partitions.plan.plan_sha256, recorder } };
}

module.exports = Object.freeze({ recordHistoricalClaudeV3 });
