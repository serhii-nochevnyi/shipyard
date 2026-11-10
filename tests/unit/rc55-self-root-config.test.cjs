'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rc55-fixture.cjs');
const { loadConfig } = require('../../plugins/delivery-pipeline/scripts/pipeline-config.cjs');

test('only a proven matching repository may omit its own project-root mapping', t => {
  const f = fixture(t);
  f.write('.planning/config.json', JSON.stringify({ pipeline: { repos: { 'acme/app': f.root } } }));
  let result = loadConfig(f.root, { env: {} });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.config.repos['acme/app'], undefined);
  f.write('.planning/config.json', JSON.stringify({ pipeline: { repos: { 'foreign/app': f.root } } }));
  result = loadConfig(f.root, { env: {} });
  assert.ok(result.warnings.some(message => message.includes('project root')));
  assert.equal(result.config.repos['foreign/app'], f.root);
});
