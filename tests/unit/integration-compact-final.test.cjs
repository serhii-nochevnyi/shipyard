'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, hash, stable, originalCompactFixtureAnswer, addCompactPressure } = require('./helpers/integration-impact-fixtures.cjs');


for (const unresolvedFinal of [false, true]) test(unresolvedFinal
  ? 'compact independent unresolved final refuses current discovery'
  : 'compact locally complete unresolved original units retain uncertainty until independent final resolves', async () => {
  for (const runtime of ['codex']) await publicIntegrationFixture(async f => {
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
