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

test('investigate prose builds the four-line request in one resolvable command', () => {
  const prose = fs.readFileSync(path.join(pluginRoot, 'commands', 'investigate.md'), 'utf8');
  assert.match(prose, /deliver-dispatch\.cjs build research <INV-id>/);
  assert.match(prose, /build research "\$invId" --runtime "\$runtime"/);
  assert.match(prose, /four-line request once/);
  assert.match(prose, /verified context packet/);
  assert.match(prose, /explicit\s+empty backlog/);
  assert.match(prose, /optional file bodies exceed the token ceiling/);
  assertDispatcherResolves(prose);
});

test('decompose prose names a resolvable decomposition build command', () => {
  const prose = fs.readFileSync(path.join(pluginRoot, 'commands', 'decompose.md'), 'utf8');
  assert.match(prose, /deliver-dispatch\.cjs build decomposition\s+<INV-id\|ADR-id> --phase <N>/);
  assert.match(prose, /verified context packet with required source content/);
  assert.match(prose, /Optional file bodies are elided to fit the\s+token ceiling/);
  assert.match(prose, /codex-planning-context-host\.cjs/);
  assert.match(prose, /codex-decompose-host\.cjs/);
  assertDispatcherResolves(prose);
});

done();
