'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRecord, readLedger, latestRecords, recordBatch,
  reconcileTelemetry, summarizeTelemetry, POLICY_HASH, POLICY_VERSION,
} = require('../../plugins/delivery-pipeline/scripts/usage-attribution.cjs');
const modelPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const { report } = require('../../plugins/delivery-pipeline/scripts/usage-report.cjs');

const CLI = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/usage-attribution.cjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-uattr-'));
  const graph = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {} }));
  return { dir, graph };
}

const base = (over = {}) => ({
  observation_id: 'obs-1',
  observed_at: '2026-09-10T12:00:00.000Z',
  dispatch_id: 'dispatch-1',
  runtime: 'claude',
  provider: 'anthropic',
  session_id: 'claude-session',
  ticket: 'T-01-01',
  role: 'executor',
  task_level: 'routine',
  backend: 'workflow',
  model: 'opus',
  effort: 'high',
  effort_applied: 'high',
  observed_model: 'claude-opus-5',
  observed_effort: 'high',
  ...over,
});

function applicationReceipt(resolution, over = {}) {
  const receipt = {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    launch_id: `launch-${resolution.dispatch_id}`,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.requested_model,
    applied_effort: resolution.requested_effort,
    observed_model: resolution.requested_model,
    observed_effort: resolution.requested_effort,
    policy_hash: resolution.policy_hash,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: `launch-${resolution.dispatch_id}`,
    },
    ...(resolution.agent_file ? {
      agent_file: resolution.agent_file,
      agent_file_digest: 'a'.repeat(64),
    } : {}),
    ...over,
  };
  if (!over.compliance_proof) {
    receipt.compliance_proof = {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: receipt.policy_hash,
      dispatch_id: receipt.dispatch_id,
      launch_id: receipt.launch_id,
    };
  }
  return receipt;
}

function routed(runtime, role, signals, dispatch_id, over = {}) {
  const resolution = modelPolicy.resolveDispatch({ runtime, role, signals, dispatch_id });
  return {
    ...resolution,
    ...over,
  };
}

test('usage attribution keeps provider/runtime pairs explicit', () => {
  const record = normalizeRecord(base());
  assert.equal(record.provider, 'anthropic');
  assert.equal(record.runtime, 'claude');
  assert.throws(
    () => normalizeRecord(base({ provider: 'openai' })),
    /does not match runtime/
  );
  assert.throws(
    () => normalizeRecord(base({ runtime: 'codex', provider: 'anthropic' })),
    /does not match runtime/
  );
  assert.throws(
    () => normalizeRecord(base({ prompt: 'secret' })),
    /unsupported field.*prompt/
  );
});

test('transcript sources are canonicalized before the durable ledger is written', () => {
  const transcript = path.join(os.tmpdir(), 'shipyard-source-root', 'logs', 'session.jsonl');
  const relative = path.relative(process.cwd(), transcript);
  const record = normalizeRecord(base({ source: relative }));
  assert.equal(record.source, transcript);
  const result = report([
    { source: transcript, rows: [claude] },
  ], { attributions: [record] });
  assert.equal(result.coverage.attributed_observations, 1);
  assert.equal(result.observations[0].attribution_status, 'session');
});

test('transcript source symlinks use the same realpath identity as the report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-source-link-'));
  const target = path.join(dir, 'actual.jsonl');
  const link = path.join(dir, 'alias.jsonl');
  fs.writeFileSync(target, '');
  fs.symlinkSync(target, link);
  try {
    const record = normalizeRecord(base({ source: link }));
    assert.equal(record.source, fs.realpathSync(link));
    const result = report([{ source: link, rows: [claude] }], { attributions: [record] });
    assert.equal(result.coverage.attributed_observations, 1);
    assert.equal(result.observations[0].attribution_status, 'session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recording is atomic, revisioned and idempotent', () => {
  const { graph } = project();
  try {
    const first = recordBatch(graph, [base(), base({
      observation_id: 'obs-2', dispatch_id: 'dispatch-2', runtime: 'codex', provider: 'openai',
      session_id: 'codex-session', ticket: 'T-01-02', role: 'review-fix', model: 'sonnet',
      observed_model: 'gpt-5.6-luna', observed_effort: 'high', effort_applied: 'high',
    })]);
    assert.equal(first.recorded.length, 2);
    assert.equal(readLedger(graph).records.length, 2);

    const retry = recordBatch(graph, [base()]);
    assert.equal(retry.recorded.length, 0, 'retrying the same observation must not append a duplicate');

    const update = recordBatch(graph, [base({ observed_model: 'claude-opus-5.1' })]);
    assert.equal(update.recorded.length, 1, 'a changed observation is a new revision');
    const current = latestRecords(readLedger(graph).records);
    assert.equal(current.length, 2);
    assert.equal(current.find((r) => r.observation_id === 'obs-1').revision, 2);
    assert.equal(current.find((r) => r.observation_id === 'obs-1').observed_model, 'claude-opus-5.1');
  } finally {
    fs.rmSync(path.resolve(graph, '..', '..'), { recursive: true, force: true });
  }
});

test('record retries stay idempotent when only key order differs', () => {
  const { graph } = project();
  try {
    assert.equal(recordBatch(graph, [base()]).recorded.length, 1);
    const reordered = {
      observed_model: 'claude-opus-5',
      effort_applied: 'high',
      model: 'opus',
      ticket: 'T-01-01',
      backend: 'workflow',
      role: 'executor',
      provider: 'anthropic',
      task_level: 'routine',
      event: 'model_attribution',
      session_id: 'claude-session',
      observed_effort: 'high',
      dispatch_id: 'dispatch-1',
      runtime: 'claude',
      effort: 'high',
      observation_id: 'obs-1',
      schema_version: 1,
    };
    assert.equal(recordBatch(graph, [reordered]).recorded.length, 0,
      'reordered keys describe the same latest fact and must not append a revision');
  } finally {
    fs.rmSync(path.resolve(graph, '..', '..'), { recursive: true, force: true });
  }
});

test('the CLI records a batch and can list the latest revisions', () => {
  const { dir, graph } = project();
  try {
    const env = { ...process.env, SHIPYARD_GRAPH_DIR: '' };
    const payload = JSON.stringify(base());
    const recorded = spawnSync(process.execPath, [CLI, 'record', '--stdin', '--graph', graph], {
      cwd: dir, env, input: payload, encoding: 'utf8',
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    const listed = spawnSync(process.execPath, [CLI, 'list', '--json', '--graph', graph], {
      cwd: dir, env, encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit graph path must contain the project marker before writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-uattr-missing-'));
  const missing = path.join(dir, 'not-a-graph');
  try {
    const result = spawnSync(process.execPath, [CLI, 'record', '--stdin', '--graph', missing], {
      cwd: dir, input: JSON.stringify(base()), encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /explicitly selected graph is invalid/);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the write API refuses a graph directory without the project marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-uattr-api-missing-'));
  const missing = path.join(dir, 'not-a-graph');
  try {
    assert.throws(
      () => recordBatch(missing, base()),
      /refusing to write an attribution ledger nobody will read/
    );
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a custom graph serializes writers beside its own ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-uattr-custom-'));
  const graph = path.join(dir, 'custom-graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {} }));
  try {
    const result = recordBatch(graph, base());
    assert.equal(result.recorded.length, 1);
    assert.ok(fs.existsSync(path.join(graph, 'usage-attribution.jsonl')));
    assert.ok(fs.existsSync(path.join(graph, '.locks')), 'the lock root follows the selected ledger');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex attributions reject Claude-only requested tiers', () => {
  assert.throws(
    () => normalizeRecord(base({ runtime: 'codex', provider: 'openai', model: 'fable' })),
    /not available on runtime "codex"/
  );
});

const claude = {
  type: 'assistant', sessionId: 'claude-session', requestId: 'claude-request',
  message: {
    id: 'claude-message', model: 'claude-opus-5',
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 4 },
    stop_reason: 'end_turn',
  },
};
const codex = {
  type: 'event_msg', timestamp: '2026-09-10T12:01:00.000Z',
  payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0,
    output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 108,
  } } },
};
const codexCurrent = {
  type: 'token_usage_record', timestamp: '2026-09-10T12:02:00.000Z',
  payload: {
    session_id: 'codex-current-session', response_id: 'response-1', turn_id: 'turn-1',
    usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 },
    thread_token_usage: {
      input_tokens: 120, cached_input_tokens: 40, cache_write_input_tokens: 0,
      output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 128,
    },
  },
};
const codexCurrent2 = {
  type: 'token_usage_record', timestamp: '2026-09-10T12:03:00.000Z',
  payload: {
    session_id: 'codex-current-session', response_id: 'response-2', turn_id: 'turn-1',
    usage: { input_tokens: 108, cached_input_tokens: 36, output_tokens: 6, reasoning_output_tokens: 2 },
    thread_token_usage: {
      input_tokens: 120, cached_input_tokens: 40, cache_write_input_tokens: 0,
      output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 128,
    },
  },
};

test('usage report joins both providers and keeps model/effort in the efficiency rows', () => {
  const result = report([
    { source: 'claude.jsonl', rows: [claude] },
    { source: 'codex.jsonl', rows: [{ type: 'session_meta', payload: { id: 'codex-session' } }, codex] },
  ], { attributions: [
    base({
      observation_id: 'claude-link', dispatch_id: 'dispatch-claude', message_id: 'claude-message',
      session_id: 'claude-session', source: 'claude.jsonl', observed_model: 'claude-opus-5',
    }),
    base({
      observation_id: 'codex-link', dispatch_id: 'dispatch-codex', runtime: 'codex', provider: 'openai',
      session_id: 'codex-session', source: 'codex.jsonl', ticket: 'T-01-02', role: 'review-fix',
      model: 'sonnet', observed_model: 'gpt-5.6-luna', observed_effort: 'high',
    }),
  ] });
  assert.equal(result.coverage.attributed_observations, 2);
  assert.equal(result.coverage.model_effort_rate_percent, 100);
  assert.equal(result.coverage.ticket_efficiency_rate_percent, 100);
  assert.equal(result.efficiency.comparison_ready, true);
  assert.equal(result.efficiency.rows.length, 2);
  const codexGroup = result.groups.find((group) => group.runtime === 'codex');
  assert.equal(codexGroup.model, 'gpt-5.6-luna');
  assert.equal(codexGroup.observed_effort, 'high');
  assert.equal(codexGroup.input_tokens, 100, 'Codex cumulative input is not added to cache read again');
  assert.ok(!JSON.stringify(result).includes('secret'), 'the report contains metadata and counters only');
});

test('ambiguous session attribution is visible and excluded from efficiency comparisons', () => {
  const result = report([
    { source: 'codex.jsonl', rows: [{ type: 'session_meta', payload: { id: 'same-session' } }, codex] },
  ], { attributions: [
    base({ observation_id: 'a', runtime: 'codex', provider: 'openai', session_id: 'same-session', source: 'codex.jsonl', dispatch_id: 'dispatch-a', observed_model: 'gpt-5.6-luna' }),
    base({ observation_id: 'b', runtime: 'codex', provider: 'openai', session_id: 'same-session', source: 'codex.jsonl', dispatch_id: 'dispatch-b', observed_model: 'gpt-6-astra' }),
  ] });
  assert.equal(result.coverage.ambiguous_observations, 1);
  assert.equal(result.efficiency.eligible_model_effort_observations, 0);
  assert.equal(result.observations[0].model, null);
});

test('current Codex token_usage_record uses cumulative thread usage', () => {
  const result = report([
    { source: 'codex-current.jsonl', rows: [
      { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-luna', effort: 'max' } },
      codexCurrent,
      codexCurrent2,
    ] },
  ], { attributions: [base({
    observation_id: 'codex-current-link', runtime: 'codex', provider: 'openai',
    session_id: 'codex-current-session', source: 'codex-current.jsonl',
    dispatch_id: 'dispatch-current', ticket: 'T-01-03', role: 'executor',
    model: 'sonnet', observed_model: 'gpt-5.6-luna', observed_effort: 'max',
  })] });
  assert.equal(result.coverage.codex_sessions, 1);
  assert.equal(result.coverage.attributed_observations, 2);
  assert.equal(result.observations[0].model, 'gpt-5.6-luna');
  assert.equal(result.observations[0].observed_effort, 'max');
  assert.equal(result.groups[0].input_tokens, 120);
  assert.equal(result.groups[0].cache_read_input_tokens, 40);
  assert.equal(result.groups[0].output_tokens, 8);
  assert.equal(result.efficiency.rows[0].eligible, true);
});

test('unknown observed effort stays visible but is excluded from eligible rows', () => {
  const result = report([
    { source: 'claude.jsonl', rows: [claude] },
  ], { attributions: [base({
    observation_id: 'unknown-effort', message_id: 'claude-message',
    session_id: 'claude-session', source: 'claude.jsonl', observed_effort: 'unknown',
  })] });
  assert.equal(result.coverage.effort_observed, 0);
  assert.equal(result.efficiency.eligible_model_effort_observations, 0);
  assert.equal(result.efficiency.eligible_rows, 0);
  assert.equal(result.efficiency.ineligible_rows, 1);
  assert.equal(result.efficiency.rows[0].eligible, false);
  assert.deepEqual(result.efficiency.rows[0].exclusion_reasons, ['missing_or_nonconcrete_effort']);
});

test('policy-aware attribution retains provenance and compares nested facts idempotently', () => {
  const resolution = modelPolicy.resolveDispatch({
    runtime: 'codex', role: 'executor', signals: { critical: true }, dispatch_id: 'policy-dispatch',
  });
  const receipt = applicationReceipt(resolution, {
    observed_model: 'unknown', observed_effort: 'unknown',
  });
  const record = normalizeRecord(base({
    observation_id: 'policy-observation', dispatch_id: resolution.dispatch_id,
    runtime: 'codex', provider: 'openai', session_id: 'codex-policy-session',
    model: 'sonnet', effort: 'low', effort_applied: 'low',
    observed_model: 'unknown', observed_effort: 'unknown',
    policy_id: 'ADR-014', policy_version: POLICY_VERSION, policy_hash: POLICY_HASH,
    logical_model: resolution.logical_model, logical_rung: resolution.logical_rung,
    rung: resolution.rung, rung_index: resolution.rung_index, route: resolution.route,
    mechanism: resolution.mechanism, launch_id: 'launch-policy-dispatch',
    launch_arguments: resolution.launch_arguments, signals: resolution.signals,
    signals_fired: resolution.signals_fired, requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort, applied_model: resolution.requested_model,
    applied_effort: resolution.effort, receipt, application_receipt: receipt,
    resolution,
  }));
  assert.equal(record.policy_hash, POLICY_HASH);
  assert.equal(record.resolution.rung, 'critical');
  assert.deepEqual(record.application_receipt.compliance_proof, receipt.compliance_proof);

  const reordered = normalizeRecord({
    ...record,
    launch_arguments: { ...record.launch_arguments },
    signals: { ...record.signals },
    receipt: { ...record.receipt, compliance_proof: { ...record.receipt.compliance_proof } },
    application_receipt: { ...record.application_receipt, compliance_proof: { ...record.application_receipt.compliance_proof } },
    resolution: { ...record.resolution, signals: { ...record.resolution.signals } },
  });
  const { graph } = project();
  try {
    assert.equal(recordBatch(graph, [record]).recorded.length, 1);
    assert.equal(recordBatch(graph, [reordered]).recorded.length, 0,
      'nested policy objects with different insertion order are the same observation');
  } finally {
    fs.rmSync(path.resolve(graph, '..', '..'), { recursive: true, force: true });
  }
});

test('boundary resolution accepts task level and bounded repair provenance', () => {
  const resolved = routed('claude', 'executor', {}, 'boundary-resolution');
  const resolution = {
    ...resolved,
    task_level: 'routine',
    prior_applied: { dispatch_id: 'boundary-prior', model: resolved.model, effort: resolved.effort },
  };
  const record = normalizeRecord(base({ resolution }));
  assert.equal(record.resolution.task_level, 'routine');
  assert.deepEqual(record.resolution.prior_applied, resolution.prior_applied);
  assert.throws(
    () => normalizeRecord(base({
      resolution: { ...resolution, prior_applied: { ...resolution.prior_applied, prompt: 'secret' } },
    })),
    /resolution\.prior_applied\.prompt is not supported/,
  );
});

test('nested provenance accepts only bounded schema fields', () => {
  assert.throws(
    () => normalizeRecord(base({ receipt: { prompt: 'secret' } })),
    /receipt\.prompt is not supported/
  );
  assert.throws(
    () => normalizeRecord(base({ receipt: Object.fromEntries([
      'receipt_type', 'runtime', 'role', 'dispatch_id', 'launch_id', 'requested_model',
      'requested_effort', 'applied_model', 'applied_effort', 'observed_model', 'observed_effort',
      'policy_id', 'policy_version', 'policy_hash', 'backend', 'mechanism', 'agent_file',
      'agent_file_digest', 'logical_rung', 'rung', 'compliance',
    ].map((field) => [field, 'a'.repeat(900)])) })),
    /receipt exceeds 16384 bytes/
  );

  for (const [field, value, pattern] of [
    ['compliance_proof', { prompt: 'secret' }, /signals\.priorApplied\.compliance_proof\.prompt is not supported/],
    ['launch_arguments', { credential: 'secret' }, /signals\.priorApplied\.launch_arguments\.credential is not supported/],
    ['signals', { priorApplied: { signals: { prompt: 'secret' } } }, /signals\.priorApplied\.signals\.priorApplied\.signals\.prompt is not supported/],
  ]) {
    assert.throws(
      () => normalizeRecord(base({ signals: { priorApplied: { [field]: value } } })),
      pattern,
    );
  }

  const resolution = routed('claude', 'executor', {}, 'signal-reason-provenance');
  const priorReceipt = applicationReceipt(resolution);
  const withReceiptValue = {
    ...resolution,
    signal_reasons: [{
      signal: 'priorApplied', source: 'boundary', value: priorReceipt,
      applies: true, rung: null, reason: 'verified predecessor',
    }],
  };
  assert.deepEqual(
    normalizeRecord(base({ resolution: withReceiptValue })).resolution.signal_reasons[0].value,
    priorReceipt,
  );
  assert.throws(
    () => normalizeRecord(base({
      resolution: {
        ...withReceiptValue,
        signal_reasons: [{ ...withReceiptValue.signal_reasons[0], value: { prompt: 'secret' } }],
      },
    })),
    /resolution\.signal_reasons\[0\]\.value\.prompt is not supported/,
  );
});

test('reconciliation rejects conflicting application copies and unsupported provenance', () => {
  const resolution = routed('claude', 'executor', {}, 'conflicting-copies');
  const application = applicationReceipt(resolution);
  const copies = reconcileTelemetry({
    ...resolution,
    application_receipt: application,
    receipt: { ...application, applied_model: 'opus' },
    applied_model: 'opus',
  });
  assert.equal(copies.application_status, 'contradictory');
  assert.ok(copies.findings.includes('contradictory_application'));

  const unsupported = reconcileTelemetry({
    ...resolution,
    runtime: 'unsupported-runtime',
    application_receipt: { ...application, runtime: 'unsupported-runtime' },
  });
  assert.equal(unsupported.resolution_status, 'contradictory');
  assert.ok(unsupported.policy_resolution.contradictions.includes('unsupported_runtime'));
  assert.equal(unsupported.compliant, false);
});

test('reconciliation keeps unknown application evidence separate and rejects mismatched dispatch joins', () => {
  const resolution = routed('claude', 'executor', {}, 'outer-dispatch');
  const receipt = applicationReceipt(resolution);
  const unknown = reconcileTelemetry({
    ...resolution,
    application_receipt: { ...receipt, applied_model: 'unknown', applied_effort: 'unknown' },
  });
  assert.equal(unknown.application_status, 'unverifiable');
  assert.equal(unknown.findings.includes('contradictory_application'), false);

  const mismatchedId = reconcileTelemetry({
    ...resolution,
    resolution: { ...resolution, dispatch_id: 'nested-dispatch' },
    application_receipt: receipt,
  });
  assert.equal(mismatchedId.resolution_status, 'contradictory');
  assert.ok(mismatchedId.policy_resolution.contradictions.includes('dispatch_id_conflict'));

  const missing = reconcileTelemetry({ ...resolution, receipt: null });
  assert.equal(missing.application_status, 'unverifiable');
  assert.ok(missing.findings.includes('missing_receipt'));

  const usageRecords = [
    { dispatch_id: resolution.dispatch_id, runtime: 'claude', provider: 'anthropic', session_id: 'one' },
    { dispatch_id: resolution.dispatch_id, runtime: 'claude', provider: 'anthropic', session_id: 'two' },
  ];
  assert.equal(reconcileTelemetry({ ...resolution, application_receipt: receipt }, { usageRecords }).usage_join_status, 'ambiguous');
});

test('reconciliation rejects concrete observed values that disagree with the applied receipt', () => {
  const resolution = routed('claude', 'executor', {}, 'observed-mismatch');
  const receipt = applicationReceipt(resolution);
  const modelMismatch = reconcileTelemetry({
    ...resolution,
    application_receipt: { ...receipt, observed_model: 'different-provider-model' },
  });
  assert.equal(modelMismatch.application_status, 'contradictory');
  assert.ok(modelMismatch.runtime_application.contradictions.includes('observed_model'));
  assert.equal(modelMismatch.comparison_ready, false);

  const otherEffort = resolution.requested_effort === 'max' ? 'high' : 'max';
  const effortMismatch = reconcileTelemetry({
    ...resolution,
    application_receipt: { ...receipt, observed_effort: otherEffort },
  });
  assert.equal(effortMismatch.application_status, 'contradictory');
  assert.ok(effortMismatch.runtime_application.contradictions.includes('observed_effort'));
});

test('reconciliation derives only the omitted deterministic fields from a complete boundary projection', () => {
  const resolution = routed('claude', 'executor', {}, 'boundary-projection');
  const receipt = applicationReceipt(resolution);
  const boundaryProjection = {
    dispatch_id: resolution.dispatch_id,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    role: resolution.role,
    task_level: 'routine',
    logical_rung: resolution.logical_rung,
    rung: resolution.rung,
    signals: resolution.signals,
    signals_fired: resolution.signals_fired,
    route: resolution.route,
    runtime: resolution.runtime,
    backend: resolution.backend,
    mechanism: resolution.mechanism,
    launch_id: receipt.launch_id,
    agent_file: resolution.agent_file,
    launch_arguments: resolution.launch_arguments || null,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: receipt.applied_model,
    applied_effort: receipt.applied_effort,
    observed_model: receipt.observed_model,
    observed_effort: receipt.observed_effort,
    application_receipt: receipt,
  };
  const facts = reconcileTelemetry(boundaryProjection);
  assert.equal(facts.resolution_status, 'resolved');
  assert.equal(facts.policy_resolution.current, true);
  assert.equal(facts.policy_resolution.logical_model, resolution.logical_model);
  assert.equal(facts.policy_resolution.rung_index, resolution.rung_index);
});

test('policy reconciliation requires complete resolver provenance and reconciles its full signal route', () => {
  const resolution = routed('codex', 'executor', { critical: true }, 'complete-signals');
  const incomplete = { ...resolution, application_receipt: applicationReceipt(resolution) };
  delete incomplete.logical_model;
  delete incomplete.signals;
  const incompleteFacts = reconcileTelemetry(incomplete);
  assert.equal(incompleteFacts.policy_resolution.current, false);
  assert.ok(incompleteFacts.policy_resolution.missing_fields.includes('logical_model'));
  assert.ok(incompleteFacts.policy_resolution.missing_fields.includes('signals'));

  const mismatched = reconcileTelemetry({
    ...resolution,
    route: resolution.route.replace('critical->critical', 'base'),
    application_receipt: applicationReceipt(resolution),
  });
  assert.equal(mismatched.resolution_status, 'contradictory');
  assert.ok(mismatched.policy_resolution.contradictions.includes('signals'));

  const wrongIndex = reconcileTelemetry({
    ...resolution, rung_index: 99, application_receipt: applicationReceipt(resolution),
  });
  assert.ok(wrongIndex.policy_resolution.contradictions.includes('rung_index'));
});

test('reconciliation evaluates repair signal provenance without re-invoking receipt-gated resolution', () => {
  const prior = applicationReceipt(routed('claude', 'executor', {}, 'repair-prior'));
  const runtime = 'claude';
  const role = 'review-fix';
  const rung = modelPolicy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime][role]
    .find((entry) => entry.name === 'repeat');
  const model = modelPolicy.CLAUDE_MODEL_ALIASES[rung.model_key];
  const evaluation = modelPolicy.evaluateSignals(role, {
    signatureState: 'repeat', priorApplied: prior,
  }, { runtime });
  const resolution = {
    policy_version: POLICY_VERSION,
    policy_hash: POLICY_HASH,
    runtime,
    role,
    model_key: rung.model_key,
    logical_model: rung.logical_model || rung.model_key,
    logical_rung: rung.name,
    rung: rung.name,
    rung_index: modelPolicy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime][role].indexOf(rung),
    model,
    effort: rung.effort,
    requested_model: model,
    requested_effort: rung.effort,
    route: `role=${role} rung=${rung.name} model=${rung.model_key} signals=repeat->repeat`,
    backend: 'workflow',
    mechanism: 'workflow-explicit-selection',
    launch_arguments: { model, effort: rung.effort },
    signals: evaluation.signals,
    signals_fired: evaluation.signals_fired,
    dispatch_id: 'repair-current',
  };
  const facts = reconcileTelemetry({
    ...resolution,
    application_receipt: applicationReceipt(resolution),
  });
  assert.equal(facts.resolution_status, 'resolved');
  assert.equal(facts.policy_resolution.contradictions.includes('signals'), false);
  assert.equal(facts.compliant, true);
});

test('reconciliation rejects a receipt whose launch differs from the selected dispatch launch', () => {
  const resolution = routed('claude', 'executor', {}, 'launch-mismatch');
  const receipt = applicationReceipt(resolution, { launch_id: 'launch-other' });
  const facts = reconcileTelemetry({
    ...resolution,
    agent_id: 'launch-selected',
    application_receipt: receipt,
  });
  assert.equal(facts.application_status, 'contradictory');
  assert.ok(facts.runtime_application.contradictions.includes('launch_id'));
  assert.equal(facts.compliant, false);
});

test('static Codex application receipts require a lowercase SHA-256 agent digest', () => {
  const resolution = routed('codex', 'arch-review', {}, 'digest-shape');
  const facts = reconcileTelemetry({
    ...resolution,
    application_receipt: applicationReceipt(resolution, { agent_file_digest: 'not-a-digest' }),
  });
  assert.equal(facts.application_status, 'unverifiable');
  assert.ok(facts.runtime_application.missing_fields.includes('agent_file_digest'));
  assert.equal(facts.compliant, false);
});

test('static Codex reconciliation canonicalizes suffix-free legacy agent filenames', () => {
  const resolution = routed('codex', 'research', {}, 'legacy-agent-file');
  const legacyResolution = {
    ...resolution,
    agent_file: resolution.agent_file.replace(/\.toml$/, ''),
  };
  const facts = reconcileTelemetry({
    ...legacyResolution,
    application_receipt: applicationReceipt(resolution),
  });
  assert.equal(facts.resolution_status, 'resolved');
  assert.equal(facts.application_status, 'applied');
  assert.equal(facts.agent_file, legacyResolution.agent_file);
  assert.equal(facts.compliant, true);
});

test('reconciliation reports independent findings and never marks stale or legacy history compliant', () => {
  const currentResolution = modelPolicy.resolveDispatch({
    runtime: 'claude', role: 'executor', signals: {}, dispatch_id: 'current',
  });
  const good = {
    ...currentResolution,
    application_receipt: applicationReceipt(currentResolution),
    session_id: 'joined-session',
  };
  const stale = {
    ...currentResolution,
    dispatch_id: 'stale', policy_version: 'adr-014.v2', policy_hash: 'old-hash',
    application_receipt: applicationReceipt(
      { ...currentResolution, dispatch_id: 'stale', policy_hash: 'old-hash' },
      { observed_model: 'unknown', observed_effort: 'unknown' },
    ),
    observed_model: 'unknown', observed_effort: 'unknown',
  };
  const contradictory = {
    ...currentResolution,
    dispatch_id: 'contradictory',
    application_receipt: applicationReceipt(
      { ...currentResolution, dispatch_id: 'contradictory' },
      { applied_model: 'opus', observed_model: 'opus' },
    ),
  };
  const missing = { ...currentResolution, dispatch_id: 'missing' };
  const legacy = base({ dispatch_id: 'legacy', observed_model: 'unknown', observed_effort: 'unknown' });

  const goodFacts = reconcileTelemetry(good, { usageJoined: true });
  assert.equal(goodFacts.resolution_status, 'resolved');
  assert.equal(goodFacts.application_status, 'applied');
  assert.equal(goodFacts.observation_status, 'observed');
  assert.equal(goodFacts.usage_join_status, 'joined');
  assert.equal(goodFacts.compliant, true);
  assert.equal(goodFacts.comparison_ready, true);

  const facts = [
    goodFacts,
    reconcileTelemetry(stale),
    reconcileTelemetry(contradictory),
    reconcileTelemetry(missing),
    reconcileTelemetry(legacy),
  ];
  assert.equal(facts[1].resolution_status, 'stale');
  assert.equal(facts[1].compliant, false);
  assert.ok(facts[1].findings.includes('stale_policy'));
  assert.equal(facts[2].application_status, 'contradictory');
  assert.ok(facts[2].findings.includes('contradictory_application'));
  assert.equal(facts[3].application_status, 'missing_receipt');
  assert.ok(facts[3].findings.includes('missing_receipt'));
  assert.ok(facts[3].findings.includes('unknown_observation'));
  assert.equal(facts[4].legacy, true);
  assert.equal(facts[4].compliant, false);

  const summary = summarizeTelemetry(facts);
  assert.deepEqual(summary.coverage.policy_resolution, {
    total: 5, resolved: 4, current: 3, stale: 1, missing: 0, contradictory: 0, legacy: 1,
  });
  assert.equal(summary.findings.stale_policy, 1);
  assert.equal(summary.findings.contradictory_application, 1);
  assert.equal(summary.findings.missing_receipt, 2);
  assert.equal(summary.findings.unknown_observation, 3);
  assert.equal(summary.findings.legacy, 1);
  assert.equal(summary.compliant, 1);
  assert.equal(summary.comparison_ready, 1);
});

test('Codex and Claude retain separate concrete model palettes in policy dimensions', () => {
  const codex = routed('codex', 'executor', { critical: true }, 'codex-palette');
  const claude = routed('claude', 'research', { complexity: 'very-complex' }, 'claude-palette');
  const summary = summarizeTelemetry([
    reconcileTelemetry({ ...codex, application_receipt: applicationReceipt(codex) }),
    reconcileTelemetry({ ...claude, application_receipt: applicationReceipt(claude) }),
  ]);
  assert.deepEqual(summary.by_runtime, { claude: 1, codex: 1 });
  assert.deepEqual(summary.by_rung, { 'very-complex': 1, critical: 1 });
  assert.equal(summary.by_concrete_model['gpt-6-astra'], 1);
  assert.equal(summary.by_concrete_model.fable, 1);
  assert.equal(summary.by_concrete_model.astra, undefined);
  assert.equal(claude.requested_model, 'fable', 'Claude keeps its native Fable alias');
  assert.equal(codex.requested_model, 'gpt-6-astra', 'Codex uses its concrete Astra id');
});
