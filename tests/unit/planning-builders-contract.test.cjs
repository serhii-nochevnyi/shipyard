'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

suite('planning builder command contract');

const pluginRoot = path.resolve(__dirname, '../../plugins/delivery-pipeline');
const documentedDispatcher = '${CLAUDE_PLUGIN_ROOT}/scripts/deliver-dispatch.cjs';

function assertDispatcherResolves(prose) {
  assert.ok(prose.includes(documentedDispatcher));
  const resolved = documentedDispatcher.replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  assert.equal(require.resolve(resolved), path.resolve(pluginRoot, 'scripts/deliver-dispatch.cjs'));
}

test('investigate prose names a resolvable research build command', () => {
  const prose = fs.readFileSync(path.join(pluginRoot, 'commands', 'investigate.md'), 'utf8');
  assert.match(prose, /deliver-dispatch\.cjs build research <INV-id>\s+--line <name>/);
  assertDispatcherResolves(prose);
});

test('decompose prose names a resolvable decomposition build command', () => {
  const prose = fs.readFileSync(path.join(pluginRoot, 'commands', 'decompose.md'), 'utf8');
  assert.match(prose, /deliver-dispatch\.cjs build decomposition\s+<INV-id\|ADR-id> --phase <N>/);
  assertDispatcherResolves(prose);
});

done();
