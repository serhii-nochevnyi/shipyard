'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const rollout = require('../../plugins/delivery-pipeline/scripts/run-rollout.cjs');
const sync = require('../../plugins/delivery-pipeline/scripts/gsd-sync.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-rollout-'));
}

function evidence(runtime, overrides = {}) {
  const provider = rollout.PROVIDERS[runtime];
  return {
    schema: rollout.CAPABILITY_SCHEMA,
    version: 1,
    runtime,
    provider,
    status: 'available',
    source: 'live',
    observed: true,
    credentials: 'available',
    agent_status: 'fresh',
    model: { applied: runtime === 'claude' ? 'sonnet' : 'gpt-6-luna', inherited: false },
    scope: {
      repository_id: 'shipyard/test',
      phase: 37,
      ticket: 'T-37-08',
      worktree: '/tmp/shipyard-rollout',
      base: 'origin/ticket/T-37-06',
      base_sha: 'a'.repeat(40),
    },
    base: { status: 'fresh' },
    receipts: { status: 'verified', observed: true },
    usage: { status: 'complete', observed: true },
    telemetry: { status: 'complete', observed: true },
    run_contract: { schema: 'shipyard.run.v1', version: 1 },
    ...overrides,
  };
}

const expectedScope = {
  repository_id: 'shipyard/test',
  phase: 37,
  ticket: 'T-37-08',
  worktree: '/tmp/shipyard-rollout',
  base: 'origin/ticket/T-37-06',
  base_sha: 'a'.repeat(40),
};

function credential(runtime, status = 'available') {
  return {
    runtime,
    provider: rollout.PROVIDERS[runtime],
    status,
    source: runtime === 'claude' ? 'claude-auth-status' : 'codex-login-status',
    ...(status === 'available' && runtime === 'claude' ? { method: 'oauth' } : {}),
    ...(status === 'unavailable' ? { reason: { code: 'CREDENTIALS_UNAVAILABLE', message: 'not authenticated' } } : {}),
  };
}

function runtimeRoot() {
  const root = tempDir();
  for (const file of [...rollout.SHARED_FILES, ...rollout.RUNTIME_FILES.claude, ...rollout.RUNTIME_FILES.codex]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  return root;
}

function credentials(claude = 'available', codex = 'available') {
  return { claude: credential('claude', claude), codex: credential('codex', codex) };
}

test('rollout defaults to disabled and preserves legacy behavior', () => {
  const flag = rollout.normalizeFlag(undefined);
  assert.equal(flag.status, 'disabled');
  const result = rollout.evaluate({ root: tempDir(), credentialStatuses: credentials('unavailable', 'unavailable') });
  assert.equal(result.status, 'disabled');
  assert.equal(result.launches_enabled, false);
  assert.deepEqual(result.runtime_launches_enabled, { claude: false, codex: false });
  assert.equal(result.legacy_behavior, 'unchanged');
});

test('rollout migrates v1 flags and accepts independent v2 opt-ins', () => {
  assert.equal(rollout.normalizeFlag({ version: 'v0', enabled: true }).status, 'refused');
  assert.equal(rollout.normalizeFlag({ version: 'v1', enabled: true, runtimes: { claude: true } }).reason.code, 'RUNTIME_FLAG_INCOMPLETE');
  assert.equal(rollout.normalizeFlag({ version: 'v1', schema: rollout.SCHEMA, enabled: false }).reason.code, 'INVALID_SCHEMA');
  assert.equal(rollout.normalizeFlag({ version: 'v1', enabled: false, runtimes: { codex: 'yes' } }).reason.code, 'INVALID_FLAG');
  assert.equal(rollout.normalizeFlag({ version: 'v1', enabled: false, runtimes: { claude: false, codex: false, other: true } }).reason.code, 'UNKNOWN_RUNTIME');
  const legacy = rollout.normalizeFlag({ version: 'v1', enabled: true, runtimes: { claude: true, codex: true } });
  assert.equal(legacy.schema, rollout.SCHEMA);
  assert.equal(legacy.rollout_version, 'v2');
  assert.equal(legacy.migrated_from, 'v1');
  assert.deepEqual(legacy.runtimes, { claude: true, codex: true });
  const independent = rollout.normalizeFlag({ version: 'v2', runtimes: { claude: true } });
  assert.equal(independent.status, 'pending');
  assert.deepEqual(independent.runtimes, { claude: true, codex: false });
  assert.equal(rollout.normalizeFlag({ version: 'v2', enabled: false, runtimes: { claude: true } }).status, 'refused');
  assert.equal(rollout.normalizeFlag({ version: 'v2', schema: rollout.LEGACY_SCHEMA, runtimes: { claude: true } }).reason.code, 'INVALID_SCHEMA');
  assert.equal(rollout.normalizeFlag({ version: 'v2', runtimes: { claude: true, other: true } }).reason.code, 'UNKNOWN_RUNTIME');
});

test('evaluation preserves an invalid rollout flag as refused', () => {
  const result = rollout.evaluate({
    root: runtimeRoot(),
    flag: rollout.normalizeFlag({ version: 'v0', enabled: true }),
    credentialStatuses: credentials(),
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.launches_enabled, false);
  assert.equal(result.reason.code, 'UNSUPPORTED_ROLLOUT_VERSION');
});

test('Claude can enable with its own live evidence while Codex is unavailable', () => {
  const flag = rollout.normalizeFlag({ version: 'v2', runtimes: { claude: true, codex: false } });
  const result = rollout.evaluate({
    root: runtimeRoot(),
    flag,
    expectedScope,
    capabilities: { claude: evidence('claude') },
    credentialStatuses: credentials('available', 'unavailable'),
  });
  assert.equal(result.status, 'enabled');
  assert.equal(result.launches_enabled, true);
  assert.deepEqual(result.runtime_launches_enabled, { claude: true, codex: false });
  assert.equal(result.runtimes.claude.status, 'enabled');
  assert.equal(result.runtimes.codex.status, 'disabled');
  assert.equal(result.capabilities.claude.provider, 'anthropic');
  assert.equal(result.capabilities.codex.provider, 'openai');
  assert.doesNotMatch(JSON.stringify(result), /(?:secret|token_value|credential_value|raw_output|stdout|stderr)/i);
});

test('Codex can enable while Claude is unavailable and both runtimes can be partially ready', () => {
  const root = runtimeRoot();
  const codexOnly = rollout.evaluate({
    root,
    flag: rollout.normalizeFlag({ version: 'v2', runtimes: { codex: true } }),
    expectedScope,
    capabilities: { codex: evidence('codex') },
    credentialStatuses: credentials('unavailable', 'available'),
  });
  assert.equal(codexOnly.status, 'enabled');
  assert.deepEqual(codexOnly.runtime_launches_enabled, { claude: false, codex: true });

  const partial = rollout.evaluate({
    root,
    flag: rollout.normalizeFlag({ version: 'v2', runtimes: { claude: true, codex: true } }),
    expectedScope,
    capabilities: { claude: evidence('claude'), codex: null },
    credentialStatuses: credentials('available', 'available'),
  });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.runtime_launches_enabled, { claude: true, codex: false });
  assert.equal(partial.runtimes.codex.capability.reason.code, 'LIVE_PROBE_REQUIRED');
});

test('missing runtime files and credentials are unavailable, never synthetic green', () => {
  const root = tempDir();
  const result = rollout.probeRuntime({ root, runtime: 'claude', credentialEvidence: credential('claude', 'available') });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason.code, 'MISSING_RUNTIME_CAPABILITY');
  assert.equal(result.credential_status.status, 'available');
  assert.notEqual(result.status, 'available');
  const completeRoot = runtimeRoot();
  const roleHost = rollout.RUNTIME_FILES.claude.find((file) => file.endsWith('/claude-role-host.cjs'));
  fs.unlinkSync(path.join(completeRoot, roleHost));
  const missingRoleHost = rollout.probeRuntime({ root: completeRoot, runtime: 'claude',
    credentialEvidence: credential('claude', 'available') });
  assert.equal(missingRoleHost.status, 'unavailable');
  assert.ok(missingRoleHost.missing_files.includes(roleHost));
});

test('Claude auth status reads OAuth fields without exposing raw output', () => {
  const calls = [];
  const result = rollout.readCredentialStatus('claude', {
    env: {},
    commandRunner(command, args, options) {
      calls.push({ command, args, env: options.env });
      return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'private@example.test' }), stderr: 'secret output' };
    },
  });
  assert.deepEqual(calls, [{ command: 'claude', args: ['auth', 'status', '--json'], env: {} }]);
  assert.equal(result.status, 'available');
  assert.equal(result.method, 'oauth');
  assert.doesNotMatch(JSON.stringify(result), /private@example|secret output|stdout|stderr/i);
});

test('Claude auth status refuses malformed and non-Anthropic credential evidence', () => {
  const malformed = rollout.readCredentialStatus('claude', {
    commandRunner: () => ({ status: 0, stdout: '{bad json}' }),
  });
  assert.equal(malformed.status, 'refused');
  assert.equal(malformed.reason.code, 'AUTH_STATUS_INVALID');
  const wrongProvider = rollout.readCredentialStatus('claude', {
    commandRunner: () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }) }),
  });
  assert.equal(wrongProvider.status, 'refused');
  assert.equal(wrongProvider.reason.code, 'WRONG_PROVIDER');
});

test('Codex login status accepts subscription auth without environment API keys', () => {
  const calls = [];
  const result = rollout.readCredentialStatus('codex', {
    env: {},
    commandRunner(command, args, options) {
      calls.push({ command, args, env: options.env });
      return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    },
  });
  assert.deepEqual(calls, [{ command: 'codex', args: ['login', 'status'], env: {} }]);
  assert.equal(result.status, 'available');
  assert.doesNotMatch(JSON.stringify(result), /ChatGPT|stdout|stderr/i);
  const absent = rollout.readCredentialStatus('codex', {
    env: {},
    commandRunner: () => ({ status: 1, stdout: '', stderr: 'Not logged in' }),
  });
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.reason.code, 'CREDENTIALS_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(absent), /Not logged in/);
});

test('wrong runtime/provider, synthetic evidence, inherited model, scope and base are refused', () => {
  const cases = [
    [evidence('claude', { runtime: 'codex' }), 'WRONG_RUNTIME'],
    [evidence('claude', { provider: 'openai' }), 'WRONG_PROVIDER'],
    [evidence('claude', { source: 'synthetic' }), 'NON_LIVE_CAPABILITY'],
    [evidence('claude', { model: { inherited: true } }), 'INHERITED_MODEL'],
    [evidence('claude', { scope: { ...expectedScope, ticket: 'T-37-01' } }), 'WRONG_SCOPE'],
    [evidence('claude', { base: { status: 'stale' } }), 'STALE_BASE'],
  ];
  for (const [value, code] of cases) {
    const result = rollout.validateCapabilityEvidence(value, { runtime: 'claude', expectedScope });
    assert.equal(result.status, 'refused', code);
    assert.equal(result.reason.code, code);
  }
});

test('incomplete usage is refused and missing receipts or telemetry stay unavailable', () => {
  const incomplete = rollout.validateCapabilityEvidence(evidence('codex', { usage: { status: 'partial', observed: true } }), {
    runtime: 'codex', expectedScope,
  });
  assert.equal(incomplete.status, 'refused');
  assert.equal(incomplete.reason.code, 'INCOMPLETE_USAGE');

  const receiptMissing = rollout.validateCapabilityEvidence(evidence('codex', { receipts: { status: 'missing', observed: false } }), {
    runtime: 'codex', expectedScope,
  });
  assert.equal(receiptMissing.status, 'unavailable');
  assert.equal(receiptMissing.reason.code, 'RECEIPTS_UNAVAILABLE');

  const telemetryMissing = rollout.validateCapabilityEvidence(evidence('codex', { telemetry: { status: 'partial', observed: true } }), {
    runtime: 'codex', expectedScope,
  });
  assert.equal(telemetryMissing.status, 'unavailable');
  assert.equal(telemetryMissing.reason.code, 'TELEMETRY_UNAVAILABLE');
});

test('runtime rollback disables launches while preserving historical state', () => {
  const result = rollout.rollback({ runtime: 'claude', status: 'enabled' });
  assert.equal(result.runtime, 'claude');
  assert.equal(result.launches_enabled, false);
  assert.equal(result.records_deleted, false);
  assert.equal(result.historical_preserved, true);
  assert.equal(result.historical_relabelled, false);
  assert.equal(result.receipts_preserved, true);
  assert.equal(result.usage_preserved, true);
});

test('rollback migrates legacy state and disables only the selected runtime', () => {
  const root = tempDir();
  const file = path.join(root, '.planning', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    model_profile: 'balanced',
    delivery_pipeline: {
      autonomous_control_plane: { schema: rollout.LEGACY_SCHEMA, version: 'v1', enabled: true, runtimes: { claude: true, codex: true }, owner: 'operator' },
      gsd_sync: true,
    },
    pipeline: {
      autonomous_control_plane: { version: 'v1', enabled: true, runtimes: { claude: true, codex: true } },
    },
  }, null, 2));
  const result = rollout.applyRollback(root, 'claude');
  assert.equal(result.status, 'partial');
  assert.equal(result.changed, true);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.delivery_pipeline.autonomous_control_plane, {
    schema: rollout.SCHEMA, version: 'v2', runtimes: { claude: false, codex: true }, owner: 'operator',
  });
  assert.deepEqual(config.pipeline.autonomous_control_plane, {
    schema: rollout.SCHEMA, version: 'v2', runtimes: { claude: false, codex: true },
  });
  assert.equal(config.delivery_pipeline.gsd_sync, true);
  assert.equal(config.model_profile, 'balanced');
  assert.equal(rollout.execute({ command: 'rollback', root, runtime: 'codex' }).code, 0);
  const disabled = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disabled.delivery_pipeline.autonomous_control_plane.runtimes, { claude: false, codex: false });
  assert.equal(rollout.execute({ command: 'rollback', root }).code, 11);
});

test('rollback CLI requires exactly one provider and status never exposes CLI output', () => {
  assert.throws(() => rollout.parseArgs(['rollback']), /requires --runtime/);
  assert.throws(() => rollout.parseArgs(['rollback', '--runtime', 'claude', '--runtime', 'codex']), /specified only once/);
  assert.throws(() => rollout.parseArgs(['status', '--runtime', 'claude']), /only by rollback/);
  const result = rollout.execute({ command: 'status', root: runtimeRoot(), capabilityOnly: true,
    credentialStatuses: credentials('available', 'available') });
  assert.equal(result.result.rollout_version, 'v2');
  assert.doesNotMatch(JSON.stringify(result.result), /api-key|private@example|Logged in using|secret output/i);
});

test('GSD controller projection excludes heartbeat and lease volatility', () => {
  const store = {
    runs: {
      'run-1': {
        run: {
          run_id: 'run-1',
          repository: { repository_id: 'shipyard/test' },
          phase: { phase: 37 },
          ticket: { ticket: 'T-37-08' },
          state: 'waiting',
          wait_kind: 'ci',
          state_revision: { value: 2 },
          runtime: { runtime: 'claude', provider: 'anthropic' },
          dispatch: { dispatch_id: 'dispatch-1', model: 'sonnet', effort: 'high' },
        },
        owner: { heartbeat_at: 10, expires_at: 20, acquired_at: 1 },
        retry: { attempts: 1, max_attempts: 5, state: 'waiting', condition: 'ci', exhausted: false },
      },
    },
    generation: 1,
    updated_at: '2026-09-20T10:00:00Z',
  };
  const first = sync.controllerStateProjection(store, []);
  store.generation = 2;
  store.updated_at = '2026-09-20T10:00:01Z';
  store.runs['run-1'].owner.heartbeat_at = 11;
  store.runs['run-1'].owner.expires_at = 21;
  const heartbeat = sync.controllerStateProjection(store, []);
  assert.deepEqual(heartbeat, first);

  store.runs['run-1'].run.wait_kind = 'review';
  const changed = sync.controllerStateProjection(store, []);
  assert.notDeepEqual(changed, first);
  assert.equal(changed.runs[0].wait_kind, 'review');

  const joined = sync.controllerStateProjection(store, [
    { run_id: 'run-1', dispatch_id: 'dispatch-1', runtime: 'claude', completion_status: 'completed', usage_status: 'complete' },
    { run_id: 'run-missing', dispatch_id: 'dispatch-2', runtime: 'codex', completion_status: 'unknown' },
  ]);
  assert.equal(joined.runs[0].usage[0].usage_status, 'complete');
  assert.equal(joined.observations[0].run_id, 'run-missing');
});
