'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const report = require('../../plugins/delivery-pipeline/scripts/optimization-report.cjs');

function input(overrides = {}) {
  return {
    report_id: 'report-34-01',
    treatment_id: 'phase-34-capacity-v1',
    policy_version: 'adr-011.v1',
    baseline: { revision: 'base-1', runtime: 'claude', policy: 'ladder-0', collector: 'stats-1' },
    treatment: { revision: 'treatment-1', runtime: 'claude', policy: 'ladder-0', collector: 'stats-1' },
    provider_scope: { provider: 'anthropic', account_scope: 'pro:max' },
    window: { from: '2026-09-01T00:00:00Z', to: '2026-09-17T00:00:00Z' },
    cohort: { name: 'phase-34', sample_target: 4 },
    sample_target: 4,
    rollback: { strategy: 'restore-baseline', owner: 'shipyard', trigger: 'quality-regression' },
    comparison: { metric: 'tokens_per_completed_ticket', unit: 'tokens', baseline: 100, treatment: 70 },
    runs: [
      { run_id: 'run-b-1', arm: 'baseline', status: 'completed', coverage: 'complete', usage: { units: 100 } },
      { run_id: 'run-b-2', arm: 'baseline', status: 'failed', coverage: 'complete', usage: { units: 120 } },
      { run_id: 'run-t-1', arm: 'treatment', status: 'completed', coverage: 'complete', usage: { units: 70 } },
      { run_id: 'run-t-2', arm: 'treatment', status: 'parked', coverage: 'complete', usage: { units: 80 } },
    ],
    ...overrides,
  };
}

test('complete report promotes an improved treatment and retains all run states', () => {
  const value = report.buildReport(input(), '2026-09-17T12:00:00Z');
  assert.equal(value.schema_version, report.SCHEMA_VERSION);
  assert.equal(value.evaluation.verdict, 'promote');
  assert.equal(value.evaluation.denominator, 4);
  assert.equal(value.evaluation.coverage.includes_failed, true);
  assert.equal(value.evaluation.coverage.includes_parked, true);
  assert.deepEqual(value.evaluation.arms, { baseline: 2, treatment: 2 });
});

test('partial or unknown evidence is inconclusive and produces a non-launching candidate', () => {
  const value = report.buildReport(input({
    runs: input().runs.map((run) => run.run_id === 'run-t-2' ? { ...run, coverage: 'partial' } : run),
  }));
  assert.equal(value.evaluation.verdict, 'inconclusive');
  assert.ok(value.evaluation.missing.some((reason) => /complete run coverage/.test(reason)));
  const candidate = report.candidateFromReport(value);
  assert.equal(candidate.auto_launch, false);
  assert.equal(candidate.action, 'collect-more-evidence');
  assert.equal(candidate.linked_evidence.report_id, value.report_id);
  assert.equal(candidate.report_digest, report.reportDigest(value));
});

test('quality regression rolls back even when the sample is incomplete', () => {
  const value = report.buildReport(input({
    sample_target: 10,
    quality: { false_green: 1 },
  }));
  assert.equal(value.evaluation.verdict, 'rollback');
  assert.equal(value.evaluation.eligible, false);
  assert.ok(value.evaluation.reasons.some((reason) => /false_green/.test(reason)));
});

test('report persistence is atomic and idempotent per treatment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-optimization-report-'));
  try {
    const value = report.buildReport(input(), '2026-09-17T12:00:00Z');
    const first = report.writeReport(root, value);
    const second = report.writeReport(root, value);
    assert.equal(first.written, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.written, false);
    assert.equal(fs.existsSync(first.file), true);
    assert.throws(() => report.writeReport(root, { ...value, report_id: 'different-report' }), /different report/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback history is append-only and remains linked to a candidate', () => {
  const value = report.withRollback(report.buildReport(input()), {
    reason: 'quality regression observed in treatment arm',
    evidence: ['run-t-1', 'quality-gate-7'],
  }, '2026-09-17T13:00:00Z');
  assert.equal(value.rollback_history.length, 1);
  assert.equal(value.rollback_history[0].reason, 'quality regression observed in treatment arm');
  assert.equal(value.evaluation.verdict, 'rollback');
  assert.equal(report.candidateFromReport(value).auto_launch, false);
});

test('metadata report refuses prompt and token payloads', () => {
  assert.throws(() => report.buildReport(input({ notes: { prompt: 'secret' } })), /not allowed/);
  assert.throws(() => report.buildReport(input({ runs: [{ ...input().runs[0], tokens: 10 }] })), /not allowed/);
});
