'use strict';
const { test } = require('node:test');
const { assertCompactOriginalRefused, substantiveFixtureNarrative } = require('./helpers/integration-impact-fixtures.cjs');

for (const runtime of ['codex', 'claude']) test(runtime + ' compact public custody refuses missing native usage', () =>
  assertCompactOriginalRefused(runtime, () => {}, undefined, runtime === 'codex' ? { native(rows) {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].payload?.type === 'token_count') rows.splice(i, 1);
  } } : { observation(rows, stream) {
    for (const row of [...rows, ...stream]) if (row.type === 'assistant') delete row.message.usage;
  } }));

test('compact original public sealing refuses actual complete original answer overflow', () =>
  assertCompactOriginalRefused('claude', result => { result.evidence_markdown = substantiveFixtureNarrative(result.unit_id, 132000); },
    error => error.code === 'INVALID_RESULT' && /Claude role output exceeds the result bound/.test(error.message)));
