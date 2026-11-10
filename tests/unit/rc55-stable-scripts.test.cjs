'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./rc55-fixture.cjs');

test('pinned scripts and sibling resources survive deletion of the source version', t => {
  const f = fixture(t);
  const modulePath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/pin-script-bundle.cjs');
  assert.ok(fs.existsSync(modulePath), 'stable script bundle pinning is required');
  const { pinBundle } = require(modulePath);
  const source = path.join(f.root, 'cache/rc5.5');
  f.write('cache/rc5.5/scripts/check.cjs', 'module.exports = 55;\n');
  f.write('cache/rc5.5/references/ci-fix.md', 'Complete reference.\n');
  const pinned = pinBundle({ pluginRoot: source, installRoot: path.join(f.root, 'stable') });
  assert.equal(pinBundle({ pluginRoot: source, installRoot: path.join(f.root, 'stable') }), pinned);
  fs.rmSync(source, { recursive: true });
  assert.equal(require(path.join(pinned, 'scripts/check.cjs')), 55);
  assert.equal(fs.readFileSync(path.join(pinned, 'references/ci-fix.md'), 'utf8'), 'Complete reference.\n');
});

test('Codex generation cannot bake an ambient Claude scripts path into its own bundle', () => {
  const { shipyardRewrites } = require('../../scripts/gen-codex-shipyard.cjs');
  const previous = process.env.SHIPYARD_SCRIPTS;
  try {
    process.env.SHIPYARD_SCRIPTS = '/old-claude/scripts';
    const result = shipyardRewrites('node ${SHIPYARD_SCRIPTS:-${CLAUDE_PLUGIN_ROOT}/scripts}/deliver-dispatch.cjs', '/new-codex/shipyard');
    assert.ok(result.includes('/new-codex/shipyard/scripts/'));
    assert.ok(!result.includes('/old-claude'));
  } finally {
    if (previous === undefined) delete process.env.SHIPYARD_SCRIPTS;
    else process.env.SHIPYARD_SCRIPTS = previous;
  }
});
