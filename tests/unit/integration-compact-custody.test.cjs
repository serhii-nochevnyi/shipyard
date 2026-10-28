'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, originalCompactFixtureAnswer, addCompactPressure, substantiveFixtureNarrative } = require('./helpers/integration-impact-fixtures.cjs');

for (const runtime of ['codex', 'claude']) test(runtime + ' compact public custody refuses missing native usage', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    let compactReached = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1'); compactReached = true; originalCompactFixtureAnswer(result, payload);
    },
      ...(runtime === 'codex' ? { native(rows) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].payload?.type === 'token_count') rows.splice(i, 1);
      } } : { observation(rows, stream) {
        for (const row of [...rows, ...stream]) if (row.type === 'assistant') delete row.message.usage;
      } }) };
    const fixture = publicPartitionFixture(f, runtime, controls);
    await assert.rejects(supportedPartitionCaller(f, runtime, fixture.options));
    assert.equal(compactReached, true);
    assert.ok(controls.launches.length > 0 && controls.launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
  });
});

test('compact original public sealing refuses actual complete original answer overflow', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    let compactReached = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1');
      compactReached = true;
      originalCompactFixtureAnswer(result, payload);
      result.evidence_markdown = substantiveFixtureNarrative(result.unit_id, 132000);
    } };
    const fixture = publicPartitionFixture(f, 'claude', controls);
    await assert.rejects(supportedPartitionCaller(f, 'claude', fixture.options),
      error => error.code === 'INVALID_RESULT' && /Claude role output exceeds the result bound/.test(error.message));
    assert.equal(compactReached, true);
    assert.ok(controls.launches.length > 0 && controls.launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
  });
});
