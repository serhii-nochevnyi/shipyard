'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');
const {
  createSessionHandoff,
  recommendRotation,
} = require('../../plugins/delivery-pipeline/scripts/session-handoff.cjs');
const {
  resolveDispatchContext,
  reportTransferCapability,
  TRANSFER_PROOF_CATEGORIES,
} = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-rotation-'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'rotation@example.invalid');
  git(root, 'config', 'user.name', 'Shipyard Rotation Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function clean(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function observation(overrides = {}) {
  const stage = overrides.stage || 'ordinary_input';
  const passKind = overrides.pass_kind === undefined
    ? (stage === 'ordinary_input' ? 'ordinary' : undefined) : overrides.pass_kind;
  return {
    observation_id: overrides.observation_id || overrides.pass_id || `observation-${Math.random()}`,
    run_id: 'run-33-09',
    dispatch_id: `dispatch-${overrides.pass_id || overrides.observation_id || 'measurement'}`,
    role: 'executor',
    runtime: 'claude',
    backend: 'workflow',
    policy_hash: 'a'.repeat(64),
    treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
    stage,
    source: 'rotation-test',
    evidence: 'controller',
    bytes: overrides.bytes === undefined ? 1000 : overrides.bytes,
    estimated_tokens: overrides.estimated_tokens === undefined ? 100 : overrides.estimated_tokens,
    ...(passKind === undefined ? {} : { pass_kind: passKind }),
    ...(overrides.pass_id === undefined ? {} : { pass_id: overrides.pass_id }),
    ...(overrides.sample_id === undefined ? {} : { sample_id: overrides.sample_id }),
    ...(overrides.observed_at === undefined ? {} : { observed_at: overrides.observed_at }),
    ...overrides,
  };
}

function startupAndPasses({ backend = 'workflow', runtime = 'claude', values = [250, 250, 250, 250, 250], startup = 100 } = {}) {
  const rows = [observation({
    observation_id: `startup-${backend}-${runtime}`,
    dispatch_id: `startup-dispatch-${backend}-${runtime}`,
    stage: 'startup',
    backend,
    runtime,
    estimated_tokens: startup,
    bytes: startup * 4,
    pass_kind: undefined,
  })];
  values.forEach((value, index) => rows.push(observation({
    observation_id: `pass-${backend}-${index + 1}`,
    dispatch_id: `pass-dispatch-${backend}-${index + 1}`,
    pass_id: `pass-${index + 1}`,
    stage: 'ordinary_input',
    backend,
    runtime,
    estimated_tokens: value,
    bytes: value * 4,
    observed_at: `2026-09-17T00:00:0${index}Z`,
  })));
  return rows;
}

function scopeStatus(handoff, options) {
  return handoff.status('phase=33;tickets=T-33-09', options).scopes[0];
}

function checkpointPayload(root) {
  return {
    plan_digest: 'a'.repeat(64), adr_digest: 'b'.repeat(64), policy_digest: 'c'.repeat(64),
    head: 'd'.repeat(40), base: 'e'.repeat(40), worktrees: [root],
    current_snapshot: { id: 'rotation-snapshot' }, pending_wait_ids: [], pending_action_ids: [],
    dispatch_reservations: [], dispatch_receipts: [],
    artifact_refs: [{
      path: 'README.md',
      digest: crypto.createHash('sha256').update('fixture\n').digest('hex'),
    }],
    treatment: { wait: 'baseline', context: 'opt-07' }, budgets: { max_tokens: 1000 },
    next_action: 'resume checkpoint',
  };
}

suite('T-33-09 — evidence-based rotation recommendation and capability refusal');

test('completed phase boundary recommends through handoff status without launching a successor', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const owner = handoff.begin({
      runId: 'run-boundary', sessionId: 'session-boundary',
      phase: '33', tickets: ['T-33-09'], runtime: 'claude',
    });
    const before = handoff.inspect();
    const status = scopeStatus(handoff, {
      phase_boundary: { completed: true, id: 'phase-33-boundary' },
      runtime_context: resolveDispatchContext(root, { runtime: 'claude', env: {} }),
    });
    assert.equal(status.rotation_recommendation.state, 'recommend');
    assert.equal(status.rotation_recommendation.basis, 'completed-phase-boundary');
    assert.deepEqual(status.rotation_recommendation.evidence.sample_ids, ['phase-33-boundary']);
    assert.equal(status.rotation_recommendation.evidence.unit, 'phase-boundary');
    assert.equal(status.rotation_recommendation.advisory, true);
    assert.equal(status.transfer_capability.automatic_transfer.allowed, false);
    assert.equal(status.transfer_capability.status, 'unsupported');
    assert.equal(status.transfer_capability.confidence, 'unproven');
    assert.equal(handoff.inspect().scopes[0].candidates.length, 0);
    assert.deepEqual(handoff.inspect().scopes[0].history, before.scopes[0].history);
    assert.doesNotThrow(() => handoff.assertOwner(owner));
  } finally {
    clean(root);
  }
});

test('five comparable ordinary passes above twice startup median recommend with reproducible evidence', () => {
  const rows = startupAndPasses();
  const first = recommendRotation({ observations: rows });
  const second = recommendRotation({ observations: rows });
  assert.equal(first.state, 'recommend');
  assert.equal(first.basis, 'ordinary-passes');
  assert.equal(first.evidence.metric, 'estimated_tokens');
  assert.equal(first.evidence.unit, 'tokens');
  assert.equal(first.evidence.startup_median, 100);
  assert.equal(first.evidence.threshold, 200);
  assert.deepEqual(first.evidence.sample_ids, ['pass-1', 'pass-2', 'pass-3', 'pass-4', 'pass-5']);
  assert.ok(first.evidence.samples.every((sample) => sample.comparison === 'above-threshold'));
  assert.equal(first.recommendation_id, second.recommendation_id, 'the same evidence must deduplicate');
  assert.deepEqual(first.evidence, second.evidence);
});

test('advisor-only, missing startup, and mixed-backend observations stay unknown', () => {
  const advisorOnly = startupAndPasses({ values: [250, 250, 250, 250, 250] })
    .map((row) => row.stage === 'ordinary_input' ? { ...row, pass_kind: 'advisor' } : row);
  assert.equal(recommendRotation({ observations: advisorOnly }).state, 'unknown');

  const missingStartup = startupAndPasses({ values: [250, 250, 250, 250, 250] })
    .filter((row) => row.stage !== 'startup');
  const missingResult = recommendRotation({ observations: missingStartup });
  assert.equal(missingResult.state, 'unknown');
  assert.match(missingResult.reason, /startup/i);

  const mixed = startupAndPasses({ values: [250, 250, 250, 250, 250] });
  mixed.push(observation({
    observation_id: 'startup-api', dispatch_id: 'startup-dispatch-api', stage: 'startup',
    backend: 'api', estimated_tokens: 100, bytes: 400,
  }));
  mixed.push(observation({
    observation_id: 'pass-api', dispatch_id: 'pass-dispatch-api', pass_id: 'pass-api',
    backend: 'api', estimated_tokens: 250, bytes: 1000,
    observed_at: '2026-09-17T00:00:05Z',
  }));
  const mixedResult = recommendRotation({ observations: mixed });
  assert.equal(mixedResult.state, 'unknown');
  assert.match(mixedResult.reason, /backend|comparable/i);
});

test('safe-boundary blockers remain visible and a recommendation never performs a transfer', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const owner = handoff.begin({
      runId: 'run-blocked', sessionId: 'session-blocked',
      phase: '33', tickets: ['T-33-09'], runtime: 'claude',
    });
    const status = scopeStatus(handoff, {
      observations: startupAndPasses(),
      safe_boundary_blockers: ['active child: dispatch-1', 'worktree is dirty'],
      runtime_context: resolveDispatchContext(root, { runtime: 'claude', env: {} }),
    });
    assert.equal(status.rotation_recommendation.state, 'recommend');
    assert.deepEqual(status.rotation_recommendation.safety.blockers, [
      'active child: dispatch-1', 'worktree is dirty',
    ]);
    assert.equal(status.rotation_recommendation.safety.status, 'blocked');
    const before = JSON.stringify(handoff.inspect());
    let launches = 0;
    const refusal = handoff.requestAutomaticTransfer({
      capability: status.transfer_capability,
      launch: () => { launches++; },
    });
    assert.equal(refusal.status, 'unsupported');
    assert.equal(refusal.confidence, 'unproven');
    assert.equal(refusal.side_effect, 'none');
    assert.equal(launches, 0);
    assert.equal(JSON.stringify(handoff.inspect()), before);
    assert.doesNotThrow(() => handoff.assertOwner(owner));
  } finally {
    clean(root);
  }
});

test('checkpoint, successor startup, and cache warm-up are recorded as separate overhead costs', () => {
  const graph = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-rotation-overhead-'));
  try {
    const recorder = overhead.createRecorder(graph);
    for (const [stage, estimated_tokens] of [
      ['checkpoint_collection', 30], ['successor_startup', 90], ['cache_warmup', 20],
    ]) {
      const result = overhead.recordHandoffCost(recorder, {
        observation_id: `handoff-${stage}`,
        run_id: 'run-handoff-cost', dispatch_id: `dispatch-${stage}`,
        role: 'executor', runtime: 'claude', backend: 'workflow',
        policy_hash: 'b'.repeat(64),
        treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
        stage, bytes: estimated_tokens * 4, estimated_tokens,
        evidence: 'controller', source: 'session-handoff',
      });
      assert.equal(result.recorded.length, 1);
    }
    const rows = recorder.latest();
    assert.deepEqual(rows.map((row) => row.stage).sort(), [
      'cache_warmup', 'checkpoint_collection', 'successor_startup',
    ]);
    const report = recorder.report({ experiment_id: 'handoff-costs' });
    assert.equal(report.metrics.checkpoint_collection_estimated_tokens.sum, 30);
    assert.equal(report.metrics.successor_startup_estimated_tokens.sum, 90);
    assert.equal(report.metrics.cache_warmup_estimated_tokens.sum, 20);
  } finally {
    clean(graph);
  }
});

test('the controller records observed checkpoint and successor lifecycle costs and the CLI consumes status', () => {
  const root = repoFixture();
  const graph = path.join(root, 'overhead');
  try {
    const recorder = overhead.createRecorder(graph);
    const handoff = createSessionHandoff({
      cwd: root, overheadRecorder: recorder, runtime: 'claude', backend: 'workflow',
    });
    const owner = handoff.begin({
      runId: 'run-lifecycle', sessionId: 'session-lifecycle',
      phase: '33', tickets: ['T-33-09'], runtime: 'claude',
    });
    handoff.checkpoint(owner, checkpointPayload(root));
    const candidate = handoff.resume({
      runId: 'run-successor', sessionId: 'session-successor',
      phase: '33', tickets: ['T-33-09'], runtime: 'claude',
    });
    handoff.acknowledge(candidate, {
      revalidate: () => ({ valid: true, clean: true, children: [] }),
      cache_warmup: { bytes: 80, estimated_tokens: 20 },
    });
    assert.deepEqual(recorder.latest().map((row) => row.stage).sort(), [
      'cache_warmup', 'checkpoint_collection', 'successor_startup',
    ]);
    const cli = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/session-handoff.cjs'),
      'status', '--cwd', root, '--scope-id', 'phase=33;tickets=T-33-09', '--phase-boundary', '--runtime', 'codex',
    ], { encoding: 'utf8', env: { ...process.env, SHIPYARD_RUNTIME: '', GSD_RUNTIME: '' } });
    assert.equal(cli.status, 0, cli.stderr);
    const status = JSON.parse(cli.stdout).scopes[0];
    assert.equal(status.rotation_recommendation.state, 'recommend');
    assert.equal(status.transfer_capability.automatic_transfer.allowed, false);
    assert.equal(status.transfer_capability.confidence, 'unproven');
  } finally {
    clean(root);
  }
});

test('capability evidence is strict and synthetic or stale claims cannot enable automatic transfer', () => {
  const root = repoFixture();
  try {
    const context = resolveDispatchContext(root, { runtime: 'codex', env: {} });
    const synthetic = Object.fromEntries(TRANSFER_PROOF_CATEGORIES.map((category) => [category, {
      status: 'proven', source: 'synthetic-fixture', runtime: 'codex', host_version: '999.0.0',
      evidence_id: crypto.randomUUID(),
    }]));
    const report = reportTransferCapability({
      runtime_context: context,
      host: { runtime: 'codex', version: '999.0.0' },
      evidence: synthetic,
      automatic: true,
    });
    assert.equal(report.status, 'unsupported');
    assert.equal(report.confidence, 'unproven');
    assert.equal(report.automatic_transfer.allowed, false);
    assert.match(report.reason, /proving ground|unproven|review/i);
    assert.ok(report.missing_evidence.length > 0);
    assert.equal(report.runtime, 'codex');
    assert.equal(report.policy_hash, context.policy_hash);
  } finally {
    clean(root);
  }
});

done();
