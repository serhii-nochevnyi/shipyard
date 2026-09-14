'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { resolveRuntime, resolveDispatchContext } = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');

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

suite('routed runtime context fails closed');

test('active aliases agree and expose the canonical fingerprint and dispatch identity', () => {
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const result = resolveDispatchContext(project('claude'), {
    runtime: 'Codex App', env: { GSD_RUNTIME: 'codex-cli', SHIPYARD_RUNTIME: 'codex' },
    dispatch_id: 'T-36-02-executor',
  });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.policy_hash, policy.POLICY_HASH);
  assert.equal(result.policy_version, policy.POLICY_VERSION);
  assert.equal(result.dispatch_id, 'T-36-02-executor');
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result.conflict, { persisted: 'claude', effective: 'codex' });
});

test('conflicting active signals name both sources instead of using precedence', () => {
  const cases = [
    [{ runtime: 'codex', env: { GSD_RUNTIME: 'claude' } }, 'GSD_RUNTIME', 'option.runtime'],
    [{ env: { SHIPYARD_RUNTIME: 'codex', GSD_RUNTIME: 'claude' } }, 'GSD_RUNTIME', 'SHIPYARD_RUNTIME'],
    [{ env: { CODEX_SANDBOX: '1', CLAUDE_CODE_ENTRYPOINT: 'claude' } }, 'claude-session-env', 'codex-session-env'],
    [{ runtime: 'claude', scriptPath: '/tmp/.codex/shipyard/script.cjs', env: {} }, 'bundle-path', 'option.runtime'],
  ];
  for (const [options, source, other] of cases) {
    assert.throws(() => resolveRuntime(project(undefined), { ...options, routed: true }), (error) =>
      error.code === 'AMBIGUOUS_RUNTIME' && error.details.source === source && error.message.includes(other));
  }
});

test('unknown or malformed explicit runtimes never fall through to a known host', () => {
  for (const runtime of ['future', 'both', '', 'codex/../../', 'co\ndex', 1, false]) {
    assert.throws(() => resolveDispatchContext(null, { runtime, env: { CODEX_SANDBOX: '1' } }), (error) =>
      error.code === 'UNKNOWN_RUNTIME' && error.details.source === 'option.runtime');
  }
  assert.throws(() => resolveDispatchContext(null, { runtime: 'codex', env: { GSD_RUNTIME: 'typo' } }), /GSD_RUNTIME/);
});

test('empty runtime handshake variables are absent, so active session evidence still wins', () => {
  const result = resolveDispatchContext(null, {
    env: { SHIPYARD_RUNTIME: '', GSD_RUNTIME: '', CODEX_SANDBOX: '1' },
  });
  assert.equal(result.runtime, 'codex');
  assert.equal(result.source, 'codex-session-env');
});

test('project, installed-home and default runtime values remain compatibility-only', () => {
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-runtime-install-'));
  fs.writeFileSync(path.join(installed, 'config.toml'), '');
  for (const options of [{ env: {} }, { defaultRuntime: 'codex', env: {} }, { env: { CODEX_HOME: installed } }]) {
    assert.throws(() => resolveDispatchContext(project('codex'), options), { code: 'AMBIGUOUS_RUNTIME' });
  }
});

test('installed markers are active evidence but a corrupt marker is refused', () => {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-routed-marker-'));
  const file = path.join(core, '.gsd-runtime');
  fs.writeFileSync(file, 'claude\n');
  assert.equal(resolveDispatchContext(null, { gsdCoreHome: core, env: {} }).runtime, 'claude');
  assert.throws(() => resolveDispatchContext(null, { runtime: 'codex', gsdCoreHome: core, env: {} }), /option.gsdCoreHome/);
  fs.writeFileSync(file, 'claude/');
  assert.throws(() => resolveDispatchContext(null, { gsdCoreHome: core, env: {} }), { code: 'UNKNOWN_RUNTIME' });
});

test('malformed supplied launch identity is not replaced or generated', () => {
  for (const dispatch_id of ['', null, 42, 'two ids', 'id\n']) {
    assert.throws(() => resolveDispatchContext(null, { runtime: 'codex', env: {}, dispatch_id }), /dispatch_id/);
  }
  assert.equal(resolveDispatchContext(null, { runtime: 'codex', env: {} }).dispatch_id, undefined);
});

done();
