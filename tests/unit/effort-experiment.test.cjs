'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const MODULE_PATH = path.join(SCRIPTS, 'effort-experiment.cjs');
const effortExperiment = require(MODULE_PATH);
const overhead = require(path.join(SCRIPTS, 'orchestration-overhead.cjs'));
const { POLICY, POLICY_HASH } = require(path.join(SCRIPTS, 'model-policy.cjs'));

const {
  EXPERIMENT_SCHEMA, REPORT_SCHEMA, DECISION_SCHEMA, FLOOR,
  normalizeExperiment, report,
} = effortExperiment;

const DAY_MS = 24 * 60 * 60 * 1000;

function baseRungOf(runtime, role) {
  return POLICY.role_rungs[runtime][role].find((rung) => rung.name === 'base');
}

function criticalRungOf(runtime, role) {
  return POLICY.role_rungs[runtime][role].find((rung) => rung.name === 'critical');
}

function claudeExecutorExperiment(overrides = {}) {
  const base = baseRungOf('claude', 'executor');
  return {
    experiment_id: 'exp-claude-executor',
    runtime: 'claude',
    role: 'executor',
    model: base.model_key,
    policy_hash: POLICY_HASH,
    arms: [
      { arm_id: 'baseline', effort: base.effort, baseline: true },
      { arm_id: 'candidate', effort: 'high', baseline: false },
    ],
    ...overrides,
  };
}

function tempGraph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-effort-experiment-'));
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(path.join(graph, '.locks'), { recursive: true });
  return { root, graph };
}

function overheadRow(overrides = {}) {
  return {
    role: 'executor', runtime: 'claude', backend: 'workflow',
    stage: 'model_turn', evidence: 'usage', counts: { model_turns: 1 },
    bytes: 0, estimated_tokens: 10, attribution_status: 'observed',
    ...overrides,
  };
}

function verifiedUnit(recorder, { effort, index, day, attributionStatus = 'observed',
  runtime = 'claude', role = 'executor', model, policyHash = POLICY_HASH, tokens = 10 }) {
  const runId = `run-${effort}-${index}`;
  recorder.record(overheadRow({
    run_id: runId, dispatch_id: `dispatch-${effort}-${index}`,
    runtime, role, model, effort, policy_hash: policyHash,
    estimated_tokens: tokens, attribution_status: attributionStatus,
  }));
  return {
    ticket: `T-EXP-${effort}-${index}`, run_ids: [runId], outcome: 'verified',
    completed_at: new Date(day * DAY_MS).toISOString(),
  };
}

suite('T-44-07 — versioned effort-experiment schema, report and human-only promotion decision');

test('schema constants are versioned as the ticket contract states', () => {
  assert.equal(EXPERIMENT_SCHEMA, 'shipyard.effort-experiment.v1');
  assert.equal(REPORT_SCHEMA, 'shipyard.effort-experiment-report.v1');
  assert.equal(DECISION_SCHEMA, 'shipyard.effort-experiment-decision.v1');
  assert.deepEqual(FLOOR, { min_completions: 20, attribution: 0.95, window_days: 7 });
});

test('normalizeExperiment refuses activation.active: true', () => {
  const value = claudeExecutorExperiment({ activation: { active: true, allowed: false } });
  assert.throws(() => normalizeExperiment(value), (error) => error.code === 'INVALID_EXPERIMENT');
});

test('normalizeExperiment refuses arms that differ in model', () => {
  const base = baseRungOf('claude', 'executor');
  const value = claudeExecutorExperiment({
    arms: [
      { arm_id: 'baseline', effort: base.effort, baseline: true },
      { arm_id: 'candidate', effort: 'high', baseline: false, model: 'opus' },
    ],
  });
  assert.throws(() => normalizeExperiment(value), (error) => error.code === 'INVALID_EXPERIMENT');
});

test('normalizeExperiment refuses a Claude executor baseline other than the POLICY base rung', () => {
  const value = claudeExecutorExperiment({
    arms: [
      { arm_id: 'baseline', effort: 'high', baseline: true },
      { arm_id: 'candidate', effort: 'low', baseline: false },
    ],
  });
  assert.throws(() => normalizeExperiment(value), (error) => error.code === 'INVALID_EXPERIMENT');
});

test('normalizeExperiment refuses a Codex definition with a candidate arm and no baseline_report_digest', () => {
  const base = baseRungOf('codex', 'executor');
  const value = {
    experiment_id: 'exp-codex-executor', runtime: 'codex', role: 'executor',
    model: base.model_key, policy_hash: POLICY_HASH,
    arms: [
      { arm_id: 'baseline', effort: base.effort, baseline: true },
      { arm_id: 'candidate', effort: 'high', baseline: false },
    ],
  };
  assert.throws(() => normalizeExperiment(value), (error) => error.code === 'INVALID_EXPERIMENT');
});

test('a Codex definition is accepted once a baseline_report_digest is supplied', () => {
  const base = baseRungOf('codex', 'executor');
  const value = {
    experiment_id: 'exp-codex-executor-ok', runtime: 'codex', role: 'executor',
    model: base.model_key, policy_hash: POLICY_HASH,
    arms: [
      { arm_id: 'baseline', effort: base.effort, baseline: true },
      { arm_id: 'candidate', effort: 'high', baseline: false },
    ],
    baseline_report_digest: 'a'.repeat(64),
  };
  const normalized = normalizeExperiment(value);
  assert.equal(normalized.runtime, 'codex');
  assert.equal(normalized.baseline_report_digest, 'a'.repeat(64));
});

test('normalizeExperiment refuses a policy_hash that is not the current POLICY_HASH', () => {
  const value = claudeExecutorExperiment({ policy_hash: 'f'.repeat(64) });
  assert.throws(() => normalizeExperiment(value), (error) => error.code === 'INVALID_EXPERIMENT');
});

test('normalizeExperiment refuses fewer than two arms and more than one baseline', () => {
  const base = baseRungOf('claude', 'executor');
  assert.throws(
    () => normalizeExperiment(claudeExecutorExperiment({ arms: [{ arm_id: 'only', effort: base.effort, baseline: true }] })),
    (error) => error.code === 'INVALID_EXPERIMENT',
  );
  assert.throws(
    () => normalizeExperiment(claudeExecutorExperiment({
      arms: [
        { arm_id: 'a', effort: base.effort, baseline: true },
        { arm_id: 'b', effort: 'high', baseline: true },
      ],
    })),
    (error) => error.code === 'INVALID_EXPERIMENT',
  );
});

test('a valid Claude executor definition with a medium baseline and a high candidate is accepted', () => {
  const normalized = normalizeExperiment(claudeExecutorExperiment());
  assert.equal(normalized.schema, EXPERIMENT_SCHEMA);
  assert.equal(normalized.runtime, 'claude');
  assert.equal(normalized.model, baseRungOf('claude', 'executor').model_key);
  assert.equal(normalized.arms.length, 2);
  assert.equal(normalized.activation.active, false);
  assert.equal(normalized.activation.allowed, false);
  assert.equal(normalized.activation.requires, 'ADR-014 amendment or separate ADR');
  assert.deepEqual(normalized.comparison, {
    arm_key: 'effort', cohort_key_excludes: ['effort'], overhead_matched_pair: false,
    reason: 'effort is an orchestration-overhead cohort key; matchedCohorts never pairs effort arms',
  });
  assert.equal(normalized.comparison.overhead_matched_pair, false);
});

test('an eligible unit counts a ci-fix repair row and a critical-rung escalation row toward its arm, '
  + 'while a row attached to no outcome is excluded as unattributed', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const critical = criticalRungOf('claude', 'executor');

    recorder.record(overheadRow({
      observation_id: 'assign', run_id: 'run-1', dispatch_id: 'dispatch-1',
      role: 'executor', model: experiment.model, effort: 'medium', policy_hash: experiment.policy_hash,
      estimated_tokens: 100,
    }));
    recorder.record(overheadRow({
      observation_id: 'repair', run_id: 'run-1', dispatch_id: 'dispatch-2',
      role: 'ci-fix', model: baseRungOf('claude', 'ci-fix').model_key, effort: baseRungOf('claude', 'ci-fix').effort, policy_hash: experiment.policy_hash,
      estimated_tokens: 50,
    }));
    recorder.record(overheadRow({
      observation_id: 'escalation', run_id: 'run-1', dispatch_id: 'dispatch-3',
      role: 'executor', model: critical.model_key, effort: critical.effort, policy_hash: experiment.policy_hash,
      estimated_tokens: 30,
    }));
    recorder.record(overheadRow({
      observation_id: 'orphan', run_id: 'run-unknown', dispatch_id: 'dispatch-4',
      role: 'executor', model: experiment.model, effort: 'medium', policy_hash: experiment.policy_hash,
      estimated_tokens: 999,
    }));

    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, {
      rows,
      outcomes: [{ ticket: 'T-UNIT', run_ids: ['run-1'], outcome: 'verified', completed_at: new Date(0).toISOString() }],
    });

    const baselineArm = result.arms.find((arm) => arm.baseline);
    assert.equal(baselineArm.units.verified, 1);
    assert.equal(baselineArm.repair.rows, 1);
    assert.equal(baselineArm.repair.estimated_tokens, 50);
    assert.equal(baselineArm.escalation.rows, 1);
    assert.equal(baselineArm.escalation.estimated_tokens, 30);
    assert.equal(baselineArm.rows, 3, 'all three attributed rows count toward the unit\'s arm');
    assert.equal(baselineArm.estimated_tokens, 180);
    assert.equal(result.unattributed_rows, 1, 'a row whose run_id is in no outcome is excluded as unattributed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('below the floor, under attribution, or under seven observed days the verdict is inconclusive; '
  + 'no input yields a verdict of promote', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(verifiedUnit(recorder, { effort: 'medium', index: i, day: 0, model: experiment.model }));
    }
    for (let i = 0; i < 25; i++) {
      outcomes.push(verifiedUnit(recorder, { effort: 'high', index: i, day: 0, model: experiment.model }));
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.equal(result.verdict, 'inconclusive', 'the baseline arm has only 5 verified completions');
    assert.notEqual(result.verdict, 'promote');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('under 0.95 attribution the verdict is inconclusive even with both arms above the floor', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (const effort of ['medium', 'high']) {
      for (let i = 0; i < 20; i++) {
        const attributionStatus = effort === 'medium' && i < 4 ? 'missing' : 'observed';
        outcomes.push(verifiedUnit(recorder, { effort, index: i, day: 0, model: experiment.model, attributionStatus }));
      }
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.ok(result.attribution < 0.95);
    assert.equal(result.verdict, 'inconclusive');
    assert.notEqual(result.verdict, 'promote');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('under seven observed days the verdict is inconclusive even with floor and attribution met', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (const effort of ['medium', 'high']) {
      for (let i = 0; i < 20; i++) {
        outcomes.push(verifiedUnit(recorder, { effort, index: i, day: 0, model: experiment.model }));
      }
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.equal(result.window_days, 0);
    assert.equal(result.verdict, 'inconclusive');
    assert.notEqual(result.verdict, 'promote');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('above the floor, at full attribution and spanning seven days the verdict is ready_for_human_decision', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (const effort of ['medium', 'high']) {
      for (let i = 0; i < 20; i++) {
        outcomes.push(verifiedUnit(recorder, { effort, index: i, day: i % 2 === 0 ? 0 : 7, model: experiment.model }));
      }
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.equal(result.attribution, 1);
    assert.ok(result.window_days >= 7);
    assert.ok(result.arms.every((arm) => arm.floor_met));
    assert.equal(result.verdict, 'ready_for_human_decision');
    assert.notEqual(result.verdict, 'promote');
    assert.deepEqual(result.status, {
      implemented: true, installed: true, behaviorally_verified: false, efficiency_measured: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a decision record with a stale evidence_digest is ignored with a reason; '
  + 'a matching promote decision is included and activation.allowed stays false', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (const effort of ['medium', 'high']) {
      for (let i = 0; i < 20; i++) {
        outcomes.push(verifiedUnit(recorder, { effort, index: i, day: i % 2 === 0 ? 0 : 7, model: experiment.model }));
      }
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const now = '2024-01-08T00:00:00.000Z';
    const base = report(experiment, { rows, outcomes, now });
    assert.equal(base.verdict, 'ready_for_human_decision');

    const stale = report(experiment, {
      rows, outcomes, now,
      decision: { decided_by: 'alice', decided_at: now, decision: 'promote', evidence_digest: 'b'.repeat(64) },
    });
    assert.equal(stale.decision, null);
    assert.ok(stale.decision_ignored_reason && stale.decision_ignored_reason.length > 0);
    assert.equal(stale.activation.allowed, false);

    const matched = report(experiment, {
      rows, outcomes, now,
      decision: { decided_by: 'alice', decided_at: now, decision: 'promote', evidence_digest: base.report_digest },
    });
    assert.ok(matched.decision);
    assert.equal(matched.decision.decision, 'promote');
    assert.equal(matched.decision_ignored_reason, null);
    assert.equal(matched.activation.allowed, false);
    assert.equal(matched.activation.active, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate arm with more failed or abandoned work than the baseline yields rollback', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (let i = 0; i < 20; i++) {
      outcomes.push(verifiedUnit(recorder, { effort: 'medium', index: i, day: 0, model: experiment.model }));
    }
    for (let i = 0; i < 12; i++) {
      outcomes.push(verifiedUnit(recorder, { effort: 'high', index: i, day: 0, model: experiment.model }));
    }
    for (let i = 0; i < 6; i++) {
      const runId = `run-high-failed-${i}`;
      recorder.record(overheadRow({
        run_id: runId, dispatch_id: `dispatch-high-failed-${i}`,
        model: experiment.model, effort: 'high', policy_hash: experiment.policy_hash,
      }));
      outcomes.push({ ticket: `T-FAILED-${i}`, run_ids: [runId], outcome: 'failed', completed_at: new Date(0).toISOString() });
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.equal(result.verdict, 'rollback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a baseline arm with no recorded completions yields baseline_pending', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    const outcomes = [];
    for (let i = 0; i < 20; i++) {
      outcomes.push(verifiedUnit(recorder, { effort: 'high', index: i, day: 0, model: experiment.model }));
    }
    const rows = overhead.latestRows(overhead.readStream(graph).rows);
    const result = report(experiment, { rows, outcomes });
    assert.equal(result.verdict, 'baseline_pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orchestration-overhead exports are unaffected by loading effort-experiment.cjs', () => {
  assert.deepEqual(overhead.TREATMENT_KEYS, ['wait_events', 'bounded_context']);
  assert.equal(overhead.REPORT_SCHEMA, 'shipyard.orchestration-overhead-report.v1');
});

test('the module requires no dangerous built-ins and never calls resolveDispatch', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.ok(!/resolveDispatch\s*\(/.test(source), 'must not call resolveDispatch');
  assert.ok(
    !/require\(\s*['"](?:child_process|net|http|https|dgram)['"]\s*\)/.test(source),
    'must not require a networking or process-spawning built-in',
  );
});

test('the report CLI leaves the graph dir byte-unchanged and exits 2 on invalid input', () => {
  const { root, graph } = tempGraph();
  try {
    const recorder = overhead.createRecorder(graph);
    const experiment = normalizeExperiment(claudeExecutorExperiment());
    verifiedUnit(recorder, { effort: 'medium', index: 0, day: 0, model: experiment.model });

    const experimentFile = path.join(root, 'experiment.json');
    const outcomesFile = path.join(root, 'outcomes.json');
    fs.writeFileSync(experimentFile, JSON.stringify(claudeExecutorExperiment()));
    fs.writeFileSync(outcomesFile, JSON.stringify([
      { ticket: 'T-CLI', run_ids: ['run-medium-0'], outcome: 'verified', completed_at: new Date(0).toISOString() },
    ]));

    const streamFile = path.join(graph, overhead.STREAM_NAME);
    const before = fs.readFileSync(streamFile, 'utf8');
    const listingBefore = fs.readdirSync(graph).sort();

    const ok = spawnSync('node', [
      MODULE_PATH, 'report', '--experiment', experimentFile, '--graph', graph, '--outcomes', outcomesFile,
    ], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.schema, REPORT_SCHEMA);
    assert.notEqual(parsed.verdict, 'promote');

    const after = fs.readFileSync(streamFile, 'utf8');
    const listingAfter = fs.readdirSync(graph).sort();
    assert.equal(after, before, 'the report CLI must leave the graph stream byte-unchanged');
    assert.deepEqual(listingAfter, listingBefore, 'the report CLI must create no new file in the graph dir');

    const invalid = spawnSync('node', [MODULE_PATH, 'validate', '--experiment', path.join(root, 'missing.json')],
      { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the validate CLI accepts a well-formed experiment and prints its normalized schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-effort-experiment-cli-'));
  try {
    const experimentFile = path.join(root, 'experiment.json');
    fs.writeFileSync(experimentFile, JSON.stringify(claudeExecutorExperiment()));
    const ok = spawnSync('node', [MODULE_PATH, 'validate', '--experiment', experimentFile], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.schema, EXPERIMENT_SCHEMA);
    assert.equal(parsed.comparison.overhead_matched_pair, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
