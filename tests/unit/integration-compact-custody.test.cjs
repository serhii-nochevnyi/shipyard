'use strict';
const { test } = require('node:test');
const { assertCompactOriginalRefused } = require('./helpers/integration-impact-fixtures.cjs');

test('codex compact public custody refuses missing native usage', () =>
  assertCompactOriginalRefused('codex', () => {}, undefined, { native(rows) {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].payload?.type === 'token_count') rows.splice(i, 1);
  } }));
