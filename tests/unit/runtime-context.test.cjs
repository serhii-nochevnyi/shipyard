'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { resolveRuntime } = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');

function project(runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-runtime-context-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (runtime !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ runtime }, null, 2),
    );
  }
  return dir;
}

suite('runtime context is per invocation, not persisted project state');

test('explicit Shipyard context wins over a legacy project runtime', () => {
  const result = resolveRuntime(project('claude'), { env: { SHIPYARD_RUNTIME: 'codex' } });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'shipyard-env');
  assert.deepEqual(result.conflict, { persisted: 'claude', effective: 'codex' });
});

test('GSD_RUNTIME is accepted as the official runtime handshake', () => {
  const result = resolveRuntime(project('claude'), { env: { GSD_RUNTIME: 'codex' } });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'gsd-env');
});

test('the installed GSD marker resolves a checkout with no project runtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-runtime-marker-'));
  const core = path.join(home, 'gsd-core');
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, '.gsd-runtime'), 'codex\n');
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), '');
  const result = resolveRuntime(project(undefined), {
    env: { GSD_TOOLS: path.join(core, 'bin', 'gsd-tools.cjs') },
  });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'gsd-tools-marker');
});

test('an installed bundle path is a runtime signal without touching config.json', () => {
  const dir = project(undefined);
  const result = resolveRuntime(dir, {
    scriptPath: '/tmp/operator/.codex/shipyard/scripts/pipeline-config.cjs',
  });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'bundle-path');
  assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
});

test('the active Codex session outranks a stale Claude project runtime', () => {
  const result = resolveRuntime(project('claude'), { env: { CODEX_SANDBOX: '1' } });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'codex-session-env');
  assert.deepEqual(result.conflict, { persisted: 'claude', effective: 'codex' });
});

test('the active Claude session outranks a stale Codex project runtime', () => {
  const result = resolveRuntime(project('codex'), { env: { CLAUDE_CODE_ENTRYPOINT: '/usr/bin/claude' } });
  assert.equal(result.runtime, 'claude');
  assert.equal(result.source, 'claude-session-env');
  assert.deepEqual(result.conflict, { persisted: 'codex', effective: 'claude' });
});

test('a legacy project runtime remains a compatibility fallback', () => {
  const result = resolveRuntime(project('claude'), { env: {} });
  assert.equal(result.runtime, 'claude');
  assert.equal(result.source, 'project-config-legacy');
  assert.equal(result.conflict, null);
});

test('no signal is reported as ambiguous rather than guessed', () => {
  const result = resolveRuntime(project(undefined), { env: {} });
  assert.equal(result.runtime, null);
  assert.equal(result.source, 'ambiguous');
});

done();
