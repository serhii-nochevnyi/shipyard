'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const provenance = require('../../plugins/delivery-pipeline/scripts/host-provenance.cjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function plugin(root) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"version":"9.9.9"}\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
}

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-'));
  plugin(root);
  git(root, 'init', '-q');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return root;
}

test('a clean checkout derives dogfood with its sha and dirty false', () => {
  const root = checkout();
  const p = provenance.current({ pluginRoot: root });
  assert.deepEqual({ ...p }, { schema: provenance.SCHEMA, install_kind: 'dogfood', version: '9.9.9',
    source_sha: git(root, 'rev-parse', 'HEAD'), dirty: false });
  assert.ok(Object.isFrozen(p));
  assert.ok(provenance.isDogfood(p));
});

test('a modified file makes the checkout dirty', () => {
  const root = checkout();
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  assert.equal(provenance.current({ pluginRoot: root }).dirty, true);
});

test('an install record wins over derivation', () => {
  const root = checkout();
  const file = provenance.writeInstallRecord(root, { install_kind: 'release', version: '1.0.0', source_sha: null, dirty: false });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  const p = provenance.current({ pluginRoot: root });
  assert.equal(p.install_kind, 'release');
  assert.equal(p.version, '1.0.0');
  assert.equal(provenance.isDogfood(p), false);
});

test('a non-git root derives release with the plugin version and no sha', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-plain-'));
  plugin(root);
  assert.deepEqual({ ...provenance.current({ pluginRoot: root }) }, { schema: provenance.SCHEMA,
    install_kind: 'release', version: '9.9.9', source_sha: null, dirty: false });
});

test('the environment sets the kind, sha and dirty flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-env-'));
  plugin(root);
  const p = provenance.fromEnv({ pluginRoot: root, version: '1.2.3+codex.abc',
    env: { SHIPYARD_INSTALL_KIND: 'dogfood', SHIPYARD_SOURCE_SHA: 'abc', SHIPYARD_SOURCE_DIRTY: '1' } });
  assert.deepEqual({ ...p }, { schema: provenance.SCHEMA, install_kind: 'dogfood',
    version: '1.2.3+codex.abc', source_sha: 'abc', dirty: true });
  assert.throws(() => provenance.fromEnv({ pluginRoot: root, env: { SHIPYARD_INSTALL_KIND: 'bogus' } }));
});
