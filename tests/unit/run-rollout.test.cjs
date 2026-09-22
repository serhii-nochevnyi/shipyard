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

test('rollout defaults to disabled and preserves legacy behavior', () => {
  const flag = rollout.normalizeFlag(undefined);
  assert.equal(flag.status, 'disabled');
  const result = rollout.evaluate({ root: tempDir() });
  assert.equal(result.status, 'disabled');
  assert.equal(result.launches_enabled, false);
  assert.equal(result.legacy_behavior, 'unchanged');
});

test('rollout requires the exact version and both runtime flags', () => {
  assert.equal(rollout.normalizeFlag({ version: 'v0', enabled: true }).status, 'refused');
  assert.equal(rollout.normalizeFlag({ version: 'v1', enabled: true, runtimes: { claude: true } }).reason.code, 'RUNTIME_FLAG_INCOMPLETE');
  assert.equal(rollout.evaluate({ flag: {
    schema: rollout.SCHEMA,
    status: 'pending',
    rollout_version: 'v1',
    enabled: true,
    runtimes: { claude: true, codex: false },
  }, root: tempDir() }).status, 'refused');
});

test('both runtimes enable only with separate live evidence and the shared contract', () => {
  const flag = rollout.normalizeFlag({ version: 'v1', enabled: true, runtimes: { claude: true, codex: true } });
  const result = rollout.evaluate({
    root: tempDir(),
    flag,
    expectedScope,
    capabilities: { claude: evidence('claude'), codex: evidence('codex') },
  });
  assert.equal(result.status, 'enabled');
  assert.equal(result.launches_enabled, true);
  assert.equal(result.capabilities.claude.provider, 'anthropic');
  assert.equal(result.capabilities.codex.provider, 'openai');
  assert.doesNotMatch(JSON.stringify(result), /(?:api[_-]?key|secret|token_value|credential_value)/i);
});

test('missing runtime files and credentials are unavailable, never synthetic green', () => {
  const root = tempDir();
  const result = rollout.probeRuntime({ root, runtime: 'claude', env: {} });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason.code, 'MISSING_RUNTIME_CAPABILITY');
  assert.notEqual(result.status, 'available');
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

test('rollback disables launches while preserving historical state', () => {
  const result = rollout.rollback({ status: 'enabled' });
  assert.equal(result.launches_enabled, false);
  assert.equal(result.records_deleted, false);
  assert.equal(result.historical_preserved, true);
  assert.equal(result.historical_relabelled, false);
  assert.equal(result.receipts_preserved, true);
  assert.equal(result.usage_preserved, true);
});

test('rollback atomically disables the project flag and keeps unrelated config', () => {
  const root = tempDir();
  const file = path.join(root, '.planning', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    model_profile: 'balanced',
    delivery_pipeline: {
      autonomous_control_plane: { version: 'v1', enabled: true, runtimes: { claude: true, codex: true }, owner: 'operator' },
      gsd_sync: true,
    },
    pipeline: {
      autonomous_control_plane: { version: 'v1', enabled: true, runtimes: { claude: true, codex: true } },
    },
  }, null, 2));
  const result = rollout.applyRollback(root);
  assert.equal(result.status, 'disabled');
  assert.equal(result.changed, true);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.delivery_pipeline.autonomous_control_plane, {
    version: 'v1', enabled: false, runtimes: { claude: false, codex: false }, owner: 'operator',
  });
  assert.deepEqual(config.pipeline.autonomous_control_plane, {
    version: 'v1', enabled: false, runtimes: { claude: false, codex: false },
  });
  assert.equal(config.delivery_pipeline.gsd_sync, true);
  assert.equal(config.model_profile, 'balanced');
  assert.equal(rollout.execute({ command: 'rollback', root, capabilityFile: path.join(root, 'missing.json') }).code, 0);
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
