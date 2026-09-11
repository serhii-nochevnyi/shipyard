'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRecord, readLedger, latestRecords, recordBatch,
} = require('../../plugins/delivery-pipeline/scripts/usage-attribution.cjs');
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
