'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, claude, roleArtifact, hash, stable, MiB, partitionInputBytes, compactDomainJudgments, compactAggregatePayload, partitionUnitPayload, renderPartitionInput, partitionPlanRecord, assertPartitionInputBound, prepare, originalCompactFixtureAnswer, addCompactPressure, independentTables, independentEdges, independentDomain } = require('./helpers/integration-impact-fixtures.cjs');

for (const runtime of ['claude']) test(runtime + ' complete37 realistic static and original semantic fixture fits without semantic credit', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f, 37, true);
    const review = prepare(f, runtime);
    const prepared = roleArtifact.prepareIntegrationPartitions({ review });
    const plan = prepared.plan, record = partitionPlanRecord(f.worktree, plan.plan_sha256);
    const originals = new Map(), launches = [];
    const units = plan.units.map(unit => {
      const payload = partitionUnitPayload(plan, unit), input = renderPartitionInput(plan, payload);
      assertPartitionInputBound(plan, input, 'unit');
      launches.push({ input, payload });
      const result = { schema: 'shipyard.integration-unit-result.v2', review_contract: 'shipyard.integration-review.v3',
        kind: 'unit', runtime, subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: hash(input),
        completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [] };
      originalCompactFixtureAnswer(result, payload);
      result.findings = [{ id: 'NOTE-' + unit.unit_id, type: 'note', blocking: false,
        summary: 'Synthetic ' + unit.unit_id + ' retains explicit continuation and cancellation ownership.',
        evidence: 'The original source range and completion obligations remain readable and bound in this fixture input.' }];
      for (const field of Object.keys(plan.capacity.output_limits))
        assert.ok(Buffer.byteLength(stable(result[field])) <= plan.capacity.output_limits[field]);
      assert.ok(Buffer.byteLength(stable(result)) <= 131072);
      compactDomainJudgments(plan, result.seams, unit);
      originals.set(unit.unit_id, structuredClone(result));
      return { result, reference: { unit_id: unit.unit_id,
        artifact_ref: 'synthetic-structural-only/' + unit.unit_id + '/.shipyard-role-artifact.json',
        artifact_sha256: hash(stable(result)) } };
    });
    const verified = { units, index: { entries: units.map(({ result }) => ({ unit_id: result.unit_id,
      receipt_sha256: hash('synthetic-structural-only:' + result.unit_id) })) } };
    const payload = compactAggregatePayload(record, verified), input = renderPartitionInput(plan, payload);
    assertPartitionInputBound(plan, input, 'phase');
    const final = { payload, input };
    launches.push(final);
    const answer = { review_contract: 'shipyard.integration-review.v3', kind: 'phase', runtime, subject: plan.subject,
      plan_sha256: plan.plan_sha256, input_sha256: hash(input), completeness: 'complete', outcome: 'passed',
      blocking_count: 0, findings: [], ticket_set: plan.identity.ticket_set, ticket_set_digest: plan.identity.ticket_set_digest };
    originalCompactFixtureAnswer(answer, payload);
    const pairGroup = answer.coverage.seam_dispositions.find(group => group.domain === 'pairs');
    pairGroup.ranges = [[0, plan.interaction_domain.count - 1]];
    answer.coverage.seam_dispositions.push({ ...pairGroup, id: 'final-explicit-pair-exception', exception: true,
      ranges: [[plan.interaction_domain.count - 1, plan.interaction_domain.count]],
      rationale: 'Synthetic final exception: the last ordered unit pair retains its distinct source continuation and tenant cancellation context; both original unit conclusions include the complete completion obligation, preserving consumer value and retry ordering.' });
    for (const field of ['conclusions', 'findings', 'limitations', 'required_context'])
      assert.ok(Buffer.byteLength(stable(answer[field])) <= plan.capacity.output_limits[field]);
    originals.set('phase', answer);
    assert.ok(Buffer.byteLength(stable(answer)) <= 131072);
    compactDomainJudgments(plan, answer.coverage.seam_dispositions);
    assert.equal(review.coverage.semantic_credit, false);
    assert.equal(plan.schema, 'shipyard.integration-partition-plan.v3');
    assert.equal(plan.identity.ticket_set.length, 37);
    assert.ok(plan.units.length >= 183);
    assert.ok(plan.interaction_domain.count >= 16653);
    assert.deepEqual(final.payload.unit_results.map(item => item.unit_id), plan.units.map(item => item.unit_id));
    assert.ok(plan.material.length >= 384);
    assert.equal(new Set(plan.material.map(source => source.sha256)).size, plan.material.length);
    assert.ok(plan.material.reduce((sum, source) => sum + source.bytes, 0) >= 17721197);
    assert.ok(plan.material.reduce((sum, source) => sum + source.bytes, 0) < 32 * MiB);
    assert.ok(plan.material.some(source => /diff/.test(source.kind) && source.bytes >= 4 * MiB));
    assert.ok(record.operational_diagnostic.governing_source_bytes >= 1400000);
    assert.ok(record.operational_diagnostic.obligation_metadata_bytes >= 314302);
    independentDomain(plan);
    const governing = new Set(plan.obligations.filter(item => plan.governing.includes(item.id)).map(item => item.source_id));
    independentTables(plan, final.payload.tables, plan.units, id => governing.has(id));
    for (const { input, payload } of launches) {
      const expandIdentity = value => Array.isArray(value) ? value.map(expandIdentity) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandIdentity(item)])) : payload.identity.values[value];
      assert.deepEqual(expandIdentity(payload.identity.scalar_tree), plan.identity);
      independentEdges(payload.explicit_edges, payload.kind === 'unit' ? plan.seams.filter(edge => edge.from === payload.unit_id || edge.to === payload.unit_id) : plan.seams);
      const measuredBytes = partitionInputBytes(plan, input, payload.kind);
      if (runtime === 'claude') {
        const schema = claude.integrationStageSchema({ ...payload, input, input_sha256: hash(input) });
        assert.equal(measuredBytes, Buffer.byteLength(JSON.stringify({ type: 'user', message: { role: 'user', content: input } }) + '\n') + Buffer.byteLength(JSON.stringify(schema)));
      } else assert.equal(measuredBytes, Buffer.byteLength(input));
      assert.ok(measuredBytes <= (payload.kind === 'unit' ? 2097152 : 4194304));
      if (payload.kind === 'unit') {
        const unit = plan.units.find(item => item.unit_id === payload.unit_id);
        independentTables(plan, payload.tables, [unit], () => true);
        assert.equal(payload.binding.assignment_sha256, hash(stable(unit)));
        assert.equal(record.operational_diagnostic.units.find(item => item.unit_id === unit.unit_id).complete_input_bytes, measuredBytes);
      }
    }
    for (const unit of final.payload.unit_results) {
      const original = originals.get(unit.unit_id);
      assert.equal(unit.result_sha256, hash(stable(original)));
      for (const [field, index] of Object.entries(unit.fields)) assert.deepEqual(final.payload.semantic_values[index], original[field]);
      assert.match(unit.receipt_sha256, /^[a-f0-9]{64}$/);
      assert.ok(unit.reference.artifact_ref.endsWith('/.shipyard-role-artifact.json'));
    }
    assert.equal(new Set(final.payload.semantic_values.map(stable)).size, final.payload.semantic_values.length);
  });
});

for (const unresolvedFinal of [false, true]) test(unresolvedFinal
  ? 'compact independent unresolved final refuses current discovery'
  : 'compact locally complete unresolved original units retain uncertainty until independent final resolves', async () => {
  for (const runtime of [unresolvedFinal ? 'claude' : 'codex']) await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    const originals = new Map();
    let independentFinal = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1');
      originalCompactFixtureAnswer(result, payload);
      if (payload.kind === 'unit') {
        for (const group of result.seams) {
          group.disposition = 'unresolved';
          group.rationale = 'Synthetic local review establishes complete assigned provider values and cancellation ownership. Joint consumer ordering across this exact incident domain awaits the independent final with every original unit conclusion; this uncertainty does not indicate missing local primary context.';
        }
        assert.equal(result.completeness, 'complete');
        assert.equal(result.blocking_count, 0);
        assert.deepEqual(result.required_context, []);
        originals.set(payload.unit_id, structuredClone(result));
      } else {
        independentFinal = true;
        assert.equal(payload.unit_results.length, originals.size);
        for (const unit of payload.unit_results) {
          const original = originals.get(unit.unit_id);
          assert.ok(original);
          assert.equal(unit.result_sha256, hash(stable(original)));
          for (const [field, index] of Object.entries(unit.fields)) assert.deepEqual(payload.semantic_values[index], original[field]);
          assert.ok(payload.semantic_values[unit.fields.seams].every(group => group.disposition === 'unresolved'));
        }
        result.conclusions = ['Synthetic independent joint review compared every original provider and consumer conclusion with the complete governing contract. Their value ordering and cancellation ownership agree across the exhaustive pair and explicit-edge domains; the original local cross-unit uncertainty is resolved by this fresh joint conclusion.'];
        if (unresolvedFinal) {
          result.coverage.seam_dispositions[0].disposition = 'unresolved';
          result.coverage.seam_dispositions[0].rationale = 'Synthetic independent joint review cannot establish consumer ordering across this entire selected domain from the original unit conclusions; this final uncertainty must refuse a phase pass.';
        } else {
          result.limitations = ['Synthetic independent final still lacks execution evidence for the joint consumer ordering conclusion.'];
        }
      }
    } };
    const fixture = publicPartitionFixture(f, runtime, controls);
    await assert.rejects(supportedPartitionCaller(f, runtime, fixture.options),
      error => error.code === 'INTEGRATION_PARTITION_INVALID' && /unsupported compact final cannot pass/.test(error.message));
    assert.equal(independentFinal, true);
    assert.ok(originals.size > 1);
  });
});
