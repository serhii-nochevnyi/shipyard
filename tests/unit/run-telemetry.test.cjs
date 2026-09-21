'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const telemetry = require('../../plugins/delivery-pipeline/scripts/run-telemetry.cjs');

function complete(runId, dispatchId, runtime, provider, account, over = {}) {
  return {
    run_id: runId,
    dispatch_id: dispatchId,
    ticket: `${dispatchId}-ticket`,
    role: 'executor',
    runtime,
    provider,
    account_scope: account,
    requested_model: runtime === 'claude' ? 'opus' : 'gpt-5.6-sol',
    requested_effort: runtime === 'claude' ? 'high' : 'xhigh',
    applied_model: runtime === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol',
    applied_effort: runtime === 'claude' ? 'high' : 'xhigh',
    observed_model: runtime === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol',
    observed_effort: runtime === 'claude' ? 'high' : 'xhigh',
    policy_id: 'ADR-014',
    policy_version: 'adr-014.v2',
    policy_hash: `${runtime}-policy`,
    treatment_id: `${runtime}-baseline`,
    arm: 'baseline',
    ...over,
  };
}

function evidence(runId, dispatchId, runtime, provider, account) {
  return [
    { ...complete(runId, dispatchId, runtime, provider, account), event: 'dispatch', phase: 'launch', observation_id: `${runId}-launch` },
    { ...complete(runId, dispatchId, runtime, provider, account), event: 'receipt', phase: 'receipt', receipt_status: 'verified', observation_id: `${runId}-receipt` },
    { ...complete(runId, dispatchId, runtime, provider, account), event: 'usage', phase: 'usage', usage: { input_tokens: 100, output_tokens: 20, tool_turns: 3 }, observation_id: `${runId}-usage` },
    { run_id: runId, dispatch_id: dispatchId, event: 'quality', phase: 'quality', quality: { status: 'passed', verified: true }, observation_id: `${runId}-quality` },
    { run_id: runId, dispatch_id: dispatchId, event: 'recovery', phase: 'recovery', recovery: { status: 'complete', verified: true }, observation_id: `${runId}-recovery` },
    { run_id: runId, dispatch_id: dispatchId, event: 'outcome', phase: 'outcome', outcome: { status: 'completed', verified: true }, observation_id: `${runId}-outcome` },
  ];
}

test('joins Claude and Codex receipts with provider-scoped usage and outcomes', () => {
  const report = telemetry.joinTelemetry([
    ...evidence('run-claude', 'dispatch-claude', 'claude', 'anthropic', 'anthropic-max'),
    ...evidence('run-codex', 'dispatch-codex', 'codex', 'openai', 'openai-chatgpt'),
  ]);
  assert.equal(report.coverage.total, 2);
  assert.equal(report.coverage.attribution_complete, 2);
  assert.equal(report.coverage.cost_ready, 2);
  assert.equal(report.coverage.treatment_ready, 2);
  assert.equal(report.savings.status, 'eligible');
  assert.deepEqual(report.groups.map((group) => group.provider).sort(), ['openai', 'anthropic'].sort());
  assert.equal(report.groups.find((group) => group.runtime === 'claude').usage.input_tokens, 100);
  assert.equal(report.groups.find((group) => group.runtime === 'codex').usage.tool_turns, 3);
  assert.equal(report.policy_fingerprints.length, 2);
  assert.equal(report.treatment_fingerprints.length, 2);
});

test('deduplicates retries inside one scope and isolates reused dispatch ids across runs', () => {
  const first = complete('run-a', 'dispatch-reused', 'claude', 'anthropic', 'anthropic-max', {
    event: 'usage', phase: 'usage', usage: { input_tokens: 5 }, observation_id: 'stream-1',
  });
  const retry = { ...first };
  const second = { ...first, run_id: 'run-b', observation_id: 'stream-1' };
  const report = telemetry.joinTelemetry([first, retry, second]);
  assert.equal(report.coverage.total, 2);
  assert.equal(report.duplicate_observations, 1);
  assert.equal(report.groups.every((group) => group.dispatch_id === 'dispatch-reused'), true);
  assert.equal(report.coverage.contradictions, 2);
  assert.equal(report.savings.status, 'incomplete');
  assert.ok(report.groups.every((group) => group.conflicts.includes('cross_run_dispatch_reuse')));
});

test('merges a later partial revision without counting the observation twice', () => {
  const initial = complete('run-revision', 'dispatch-revision', 'claude', 'anthropic', 'anthropic-max', {
    event: 'usage', phase: 'usage', revision: 1, observation_id: 'revision-1',
    usage: { input_tokens: 12, output_tokens: 4 },
  });
  const update = {
    run_id: initial.run_id,
    dispatch_id: initial.dispatch_id,
    event: 'usage',
    phase: 'usage',
    revision: 2,
    observation_id: initial.observation_id,
    usage: { output_tokens: 6 },
  };
  const report = telemetry.joinTelemetry([initial, update]);
  assert.equal(report.duplicate_observations, 0);
  assert.equal(report.groups[0].usage.input_tokens, 12);
  assert.equal(report.groups[0].usage.output_tokens, 6);
  assert.deepEqual(report.groups[0].observations.map((item) => item.observation_id), ['revision-1']);
});

test('keeps unknown and unsupported selection evidence out of applied coverage', () => {
  const report = telemetry.joinTelemetry([
    {
      run_id: 'run-unknown',
      dispatch_id: 'dispatch-unknown',
      runtime: 'codex',
      provider: 'openai',
      requested_model: 'gpt-5.6-sol',
      requested_effort: 'xhigh',
      applied_model: 'unknown',
      applied_effort: 'unsupported',
      observed_model: 'unknown',
      observed_effort: 'unknown',
      event: 'receipt',
      phase: 'receipt',
      observation_id: 'unknown-receipt',
    },
  ]);
  const group = report.groups[0];
  assert.equal(group.applied_status, 'unsupported');
  assert.equal(group.observed_status, 'unknown');
  assert.equal(report.coverage.unknown, 1);
  assert.equal(report.coverage.unsupported, 1);
  assert.equal(report.coverage.attribution_complete, 0);
  assert.equal(report.savings.status, 'incomplete');
  assert.ok(report.savings.reasons.includes('incomplete_attribution'));
});

test('does not infer applied facts from requested facts', () => {
  const record = telemetry.normalize({
    run_id: 'run-requested',
    dispatch_id: 'dispatch-requested',
    runtime: 'claude',
    provider: 'anthropic',
    requested_model: 'opus',
    requested_effort: 'high',
    event: 'launch',
  });
  assert.equal(record.requested_model, 'opus');
  assert.equal(record.applied_model, null);
  assert.equal(record.applied_status, 'missing');
  assert.equal(record.observed_model, null);
});

test('does not treat partial quality, recovery or outcome facts as savings evidence', () => {
  const records = evidence('run-partial-facts', 'dispatch-partial-facts', 'claude', 'anthropic', 'anthropic-max')
    .map((record) => record.phase === 'quality' ? { ...record, quality: { score: 1 } }
      : record.phase === 'recovery' ? { ...record, recovery: { attempts: 1 } }
        : record.phase === 'outcome' ? { ...record, outcome: { kind: 'completed' } } : record);
  const report = telemetry.joinTelemetry(records);
  assert.equal(report.coverage.quality, 0);
  assert.equal(report.coverage.recovery, 0);
  assert.equal(report.coverage.outcome, 0);
  assert.equal(report.coverage.treatment_ready, 0);
  assert.equal(report.savings.status, 'incomplete');
  assert.ok(report.savings.reasons.includes('incomplete_quality'));
  assert.ok(report.savings.reasons.includes('incomplete_recovery'));
  assert.ok(report.savings.reasons.includes('incomplete_outcome'));
});
