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
    source_sha: git(root, 'rev-parse', 'HEAD'), dirty: false, source_root: fs.realpathSync(root) });
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

test('derive on a checkout records its own toplevel as source_root', () => {
  const root = checkout();
  const p = provenance.derive({ pluginRoot: root });
  assert.equal(p.source_root, fs.realpathSync(root));
});

test('a non-git root derives release with no source_root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-plain2-'));
  plugin(root);
  assert.equal('source_root' in provenance.derive({ pluginRoot: root }), false);
});

test('fromEnv with SHIPYARD_SOURCE_ROOT records it realpathed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-envroot-'));
  plugin(root);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-envsrc-'));
  const p = provenance.fromEnv({ pluginRoot: root, version: '1.0.0',
    env: { SHIPYARD_INSTALL_KIND: 'dogfood', SHIPYARD_SOURCE_SHA: 'abc', SHIPYARD_SOURCE_DIRTY: '0',
      SHIPYARD_SOURCE_ROOT: sourceDir } });
  assert.equal(p.source_root, fs.realpathSync(sourceDir));
});

test('fromEnv without SHIPYARD_SOURCE_ROOT records no source_root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provenance-envnoroot-'));
  plugin(root);
  const p = provenance.fromEnv({ pluginRoot: root, version: '1.0.0',
    env: { SHIPYARD_INSTALL_KIND: 'dogfood', SHIPYARD_SOURCE_SHA: 'abc', SHIPYARD_SOURCE_DIRTY: '0' } });
  assert.equal('source_root' in p, false);
});

test('an install record round-trips a valid source_root and drops an invalid one', () => {
  const root = checkout();
  const validRoot = fs.realpathSync(root);
  const file = provenance.writeInstallRecord(root, { install_kind: 'dogfood', version: '1.0.0',
    source_sha: 'abc', dirty: false, source_root: validRoot });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).source_root, validRoot);
  assert.equal(provenance.readRecord(root).source_root, validRoot);

  provenance.writeInstallRecord(root, { install_kind: 'dogfood', version: '1.0.0',
    source_sha: 'abc', dirty: false, source_root: 'relative/path' });
  assert.equal('source_root' in JSON.parse(fs.readFileSync(file, 'utf8')), false);

  provenance.writeInstallRecord(root, { install_kind: 'dogfood', version: '1.0.0',
    source_sha: 'abc', dirty: false, source_root: 123 });
  assert.equal('source_root' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
});
