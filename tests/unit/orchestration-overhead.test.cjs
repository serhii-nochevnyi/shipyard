'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');

const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');
const waitEvents = require('../../plugins/delivery-pipeline/scripts/wait-events.cjs');
const roleArtifact = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const { CLAUDE_MODEL_ALIASES } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { registerClaudeWorkflowHost } = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');
const { execFileSync } = require('node:child_process');
const {
  buildContextPacket,
} = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-'));
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(path.join(graph, '.locks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'backlog'), { recursive: true });
  const policy = 'Live delivery policy: preserve all mandatory gates.\n';
  const plan = '# T-33-07\n\n## Scope\n- src/example.js\n';
  fs.writeFileSync(path.join(root, 'POLICY.md'), policy);
  fs.writeFileSync(path.join(root, 'PLAN.md'), plan);
  fs.writeFileSync(path.join(root, 'src-example.js'), 'module.exports = true;\n');
  return { root, graph, policy, plan };
}

function identity(overrides = {}) {
  return {
    observation_id: 'startup-1',
    run_id: 'run-33-07',
    dispatch_id: 'dispatch-33-07',
    role: 'executor',
    runtime: 'claude',
    backend: 'workflow',
    policy_hash: 'a'.repeat(64),
    treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
    stage: 'startup',
    bytes: 400,
    estimated_tokens: 100,
    estimator_version: overhead.ESTIMATOR_VERSION,
    provider_tokens: null,
    ...overrides,
  };
}

function packetOptions(f, recorder, overrides = {}) {
  return {
    root: f.root,
    role: 'executor',
    subject: 'T-33-07',
    sourceRevision: 'b'.repeat(40),
    policy: { path: path.join(f.root, 'POLICY.md'), content: f.policy },
    policyHash: sha256(f.policy),
    planPath: path.join(f.root, 'PLAN.md'),
    scope: { files_modified: ['src-example.js'] },
    acceptance: ['Preserve mandatory gates.'],
    verification: ['node tests/unit/orchestration-overhead.test.cjs'],
    backend: 'workflow',
    selectedBacklogIds: [],
    dispatchId: 'dispatch-packet',
    runId: 'run-packet',
    runtime: 'claude',
    treatments: { wait_events: 'baseline', bounded_context: 'opt-07' },
    overheadRecorder: recorder,
    ...overrides,
  };
}

function git(root, args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }

suite('T-33-07 — orchestration overhead and independent treatments');

test('records metadata-only observations idempotently and rejects cross-runtime identity reuse', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const first = recorder.record(identity({
      source_refs: [{ path: 'PLAN.md', sha256: sha256(f.plan), bytes: Buffer.byteLength(f.plan) }],
    }));
    assert.equal(first.recorded.length, 1);
    const duplicate = recorder.record(identity({
      source_refs: [{ path: 'PLAN.md', sha256: sha256(f.plan), bytes: Buffer.byteLength(f.plan) }],
    }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(recorder.read().rows.length, 1, 'a retry must not double count an observation');
    assert.throws(
      () => recorder.record(identity({ runtime: 'codex' })),
      (error) => error && error.code === 'OBSERVATION_ID_CONFLICT',
    );
    const raw = fs.readFileSync(path.join(f.graph, overhead.STREAM_NAME), 'utf8');
    assert.equal(raw.includes(f.plan), false, 'the stream must not contain source or prompt bodies');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('the real packet builder records startup bytes and estimated tokens with treatment identity', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const packet = buildContextPacket(packetOptions(f, recorder));
    const rows = recorder.read().rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'startup');
    assert.equal(rows[0].bytes, packet.accounting.estimated_bytes);
    assert.equal(rows[0].estimated_tokens, packet.accounting.estimated_tokens);
    assert.equal(rows[0].estimator_version, overhead.ESTIMATOR_VERSION);
    assert.equal(rows[0].treatment.bounded_context, 'opt-07');
    assert.ok(rows[0].source_refs.some((ref) => ref.path === 'PLAN.md'));
    assert.equal(rows[0].source_refs[0].content, undefined);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('unchanged wait polls count as polls, never as model turns, and preserve independent treatment switches', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const ctx = {
      graphDir: f.graph,
      run_id: 'run-wait', ticket: 'T-33-07', repository: 'acme/widgets', pr: 3307, head: 'head-a',
      observation: { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] },
      treatments: { wait_events: 'opt-06', bounded_context: 'baseline' },
      overheadRecorder: recorder,
    };
    waitEvents.observe({ ...ctx, poll_sequence: 1 }, { now: 1000 });
    waitEvents.observe({ ...ctx, poll_sequence: 2 }, { now: 2000 });
    const report = recorder.report({ experiment_id: 'exp-wait', completed_tickets: 0 });
    assert.equal(report.metrics.wait_polls.value, 2);
    assert.equal(report.metrics.model_turns.value, null, 'missing response evidence is unknown, not zero');
    assert.equal(report.metrics.tool_calls.value, null, 'missing transcript evidence is unknown, not zero');
    assert.equal(report.treatments[0].wait_events, 'opt-06');
    assert.equal(report.treatments[0].bounded_context, 'baseline');
    assert.equal(report.verdict, 'inconclusive');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('delivered wait actions are measured once and survive a treatment switch', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const ctx = {
      graphDir: f.graph, run_id: 'run-action', ticket: 'T-33-07', repository: 'acme/widgets', pr: 3307, head: 'head-a',
      treatments: { wait_events: 'opt-06', bounded_context: 'baseline' }, overheadRecorder: recorder,
    };
    const pending = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
    const failed = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
    waitEvents.observe({ ...ctx, observation: pending }, { now: 1000 });
    const transition = waitEvents.observe({ ...ctx, observation: failed }, { now: 2000 });
    const delivered = waitEvents.pending(ctx, { now: 2100 });
    assert.ok(transition.action);
    assert.equal(delivered.measurement.recorded.length, 1);
    const switched = waitEvents.observe({ ...ctx, observation: failed,
      treatments: { wait_events: 'baseline', bounded_context: 'opt-07' } }, { now: 2200 });
    assert.equal(switched.pending_action.action_id, transition.action.action_id,
      'switching treatment cannot erase an unacknowledged action');
    assert.equal(recorder.latest().filter((row) => row.stage === 'ordinary_input').length, 1,
      'replaying the delivered action must remain idempotent');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('supported transcript evidence counts model responses and tools separately from wait events', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    overhead.recordModelEvidence(recorder, {
      observation_id: 'turn-1',
      run_id: 'run-33-07', dispatch_id: 'dispatch-33-07', role: 'executor', runtime: 'claude', backend: 'workflow',
      policy_hash: 'a'.repeat(64), treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
      bytes: 0,
      estimated_tokens: null,
      provider_tokens: null,
      evidence: 'transcript',
      count: 1, counts: { tool_calls: 3 },
    });
    const report = recorder.report({ experiment_id: 'exp-turns', completed_tickets: 1, attribution_coverage: 1 });
    assert.equal(report.metrics.model_turns.value, 1);
    assert.equal(report.metrics.tool_calls.value, 3);
    assert.equal(report.coverage.provider_tokens, 'unknown');
    assert.equal(report.verdict, 'inconclusive', 'one fixture row cannot promote a treatment');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('targeted role-artifact consumption records selected bytes separately from the full evidence file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-artifact-'));
  const ticket = 'T-33-07-artifact';
  const graph = path.join(root, '.planning', 'graph');
  const receipts = path.join(root, 'receipts');
  fs.mkdirSync(graph, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'overhead@example.test']);
  git(root, ['config', 'user.name', 'Overhead Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'overhead base']);
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  const recorder = createDurableRecorder(receipts);
  const overheadRecorder = overhead.createRecorder(graph);
  const resultByValue = new WeakMap();
  const host = registerClaudeWorkflowHost({
    agent: async (_prompt, launchOptions) => {
      fs.writeFileSync(path.join(root, '.shipyard-pr-body.md'), `Ticket: ${ticket}\n\nsummary\n`);
      fs.writeFileSync(path.join(root, '.shipyard-evidence.md'), 'complete evidence body for targeted parent reads\n');
      fs.writeFileSync(path.join(root, 'implemented.txt'), 'implemented\n');
      git(root, ['add', 'implemented.txt']);
      git(root, ['commit', '--quiet', '-m', `feat(${ticket}): implementation`]);
      const result = { id: ticket, status: 'committed', summary: 'done', blocking_count: 0 };
      resultByValue.set(result, transcriptEvidence({
        launch_id: 'overhead-artifact-launch', applied_model: launchOptions.model,
        applied_effort: launchOptions.effort, observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      }));
      return result;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: {
      supportedModels: [CLAUDE_MODEL_ALIASES.sonnet], supportedEfforts: ['max'],
      observedModel: true, observedEffort: true,
    },
    recorder,
    applicationEvidence: ({ result }) => resultByValue.get(result),
  });
  try {
    const [artifact] = await host.run('executors', { args: { tickets: [{
      id: ticket, title: 'artifact', planPath: path.join(root, 'PLAN.md'),
      branch: `ticket/${ticket}`, worktreePath: root, prBase: 'main', model: 'sonnet', effort: 'max',
    }] } });
    const fullEvidence = fs.readFileSync(path.join(root, '.shipyard-evidence.md'), 'utf8');
    const selected = roleArtifact.read({
      worktreePath: root, base: 'main', role: 'executor', ticket,
      recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest, run_id: 'run-artifact', runtime: 'claude',
      treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
      overheadRecorder, evidenceRange: [0, 8],
    });
    const row = overheadRecorder.latest().find((item) => item.stage === 'parent_reingestion');
    assert.equal(selected.evidence_range.content, fullEvidence.slice(0, 8));
    assert.ok(row, 'the selected consumer path must emit a measurement');
    assert.equal(row.bytes, Buffer.byteLength(selected.evidence_range.content, 'utf8'));
    assert.ok(row.bytes < Buffer.byteLength(fullEvidence, 'utf8'));
    assert.equal(row.treatment.bounded_context, 'opt-07');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid counters and sensitive bodies fail closed, while false-green quality forces rollback', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    assert.throws(() => recorder.record(identity({ bytes: -1 })), /non-negative/);
    assert.throws(() => recorder.record(identity({ prompt: 'secret' })), /metadata-only/);
    recorder.record(identity({
      observation_id: 'quality-1',
      stage: 'model_turn',
      evidence: 'usage',
      counts: { model_turns: 1 },
      quality: { false_green: 1 },
    }));
    const result = recorder.report({
      experiment_id: 'exp-quality',
      completed_tickets: 20,
      attribution_coverage: 1,
      quality: { false_green: 1 },
    });
    assert.equal(result.verdict, 'rollback');
    assert.ok(result.verdict_reasons.some((reason) => /false.green/i.test(reason)));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('complete usage and cohort counters still cannot claim total cost without finalized output evidence', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const common = {
      run_id: 'run-complete', role: 'executor', runtime: 'claude', backend: 'workflow',
      policy_hash: 'a'.repeat(64), evidence: 'usage', bytes: 0,
      stage: 'model_turn',
      estimated_tokens: null, provider_tokens: { input_tokens: 10, output_tokens: 2 },
      counts: { model_turns: 1, tool_calls: 0 },
    };
    recorder.record({ ...common, observation_id: 'baseline-turn', dispatch_id: 'baseline-dispatch',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } });
    recorder.record({ ...common, observation_id: 'treatment-turn', dispatch_id: 'treatment-dispatch',
      treatment: { wait_events: 'opt-06', bounded_context: 'baseline' } });
    const result = recorder.report({
      experiment_id: 'exp-complete', completed_tickets: 20, attribution_coverage: 1,
      defect_window_days: 7, experiment_boundary: true,
    });
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(result.missing_coverage.includes('finalized output coverage'));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('reopens and escaped defects also force rollback, not only the original quality keys', () => {
  const f1 = fixture();
  try {
    const recorder = overhead.createRecorder(f1.graph);
    recorder.record(identity({ observation_id: 'reopen-1', stage: 'model_turn', evidence: 'usage',
      counts: { model_turns: 1 }, quality: { reopens: 2 } }));
    const result = recorder.report({ experiment_id: 'exp-reopen' });
    assert.equal(result.verdict, 'rollback');
    assert.ok(result.verdict_reasons.some((reason) => reason.includes('reopens')));
  } finally {
    fs.rmSync(f1.root, { recursive: true, force: true });
  }
  const f2 = fixture();
  try {
    const recorder = overhead.createRecorder(f2.graph);
    recorder.record(identity({ observation_id: 'escaped-1', stage: 'model_turn', evidence: 'usage',
      counts: { model_turns: 1 }, quality: { escaped_defects: 1 } }));
    const result = recorder.report({ experiment_id: 'exp-escaped' });
    assert.equal(result.verdict, 'rollback');
    assert.ok(result.verdict_reasons.some((reason) => reason.includes('escaped_defects')));
  } finally {
    fs.rmSync(f2.root, { recursive: true, force: true });
  }
});

test('matched cohorts compute totals and percentiles per verified completion when runtime/model/effort/role/account are held fixed', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const common = { run_id: 'run-cohort', role: 'executor', runtime: 'claude', model: 'opus', effort: 'high',
      account_scope: 'anthropic-max', backend: 'workflow', policy_hash: 'a'.repeat(64), evidence: 'usage', bytes: 100,
      stage: 'model_turn', estimated_tokens: null, counts: { model_turns: 1, tool_calls: 0 } };
    recorder.record({ ...common, observation_id: 'baseline-a', dispatch_id: 'dispatch-a',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } });
    recorder.record({ ...common, observation_id: 'treatment-b', dispatch_id: 'dispatch-b',
      treatment: { wait_events: 'opt-06', bounded_context: 'baseline' } });
    const result = recorder.report({
      experiment_id: 'exp-cohort',
      verified_completions: [{ ticket: 'T-41-06-a', run_id: 'run-cohort', dispatch_ids: ['dispatch-a'] }],
    });
    assert.equal(result.matched_cohorts.length, 1);
    assert.equal(result.matched_cohorts[0].matched, true);
    assert.equal(result.matched_cohorts[0].model, 'opus');
    assert.equal(result.matched_cohorts[0].account_scope, 'anthropic-max');
    assert.ok(!result.missing_coverage.some((m) => m.includes('comparable baseline')));
    assert.equal(result.metrics_per_completion.completions, 1);
    assert.equal(result.metrics_per_completion.bytes.value, 100);
    assert.equal(result.metrics_per_completion.model_turns.value, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a treatment change bundled with a runtime change is not a matched cohort and stays inconclusive', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    recorder.record(identity({ observation_id: 'claude-baseline', runtime: 'claude', role: 'executor',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } }));
    recorder.record(identity({ observation_id: 'codex-treatment', runtime: 'codex', role: 'executor',
      treatment: { wait_events: 'opt-06', bounded_context: 'baseline' } }));
    const result = recorder.report({ experiment_id: 'exp-mismatch', completed_tickets: 20, attribution_coverage: 1 });
    assert.equal(result.matched_cohorts.length, 2);
    assert.ok(result.matched_cohorts.every((cohort) => cohort.matched === false));
    assert.ok(result.missing_coverage.some((m) => m.includes('matched by runtime/model/effort/role/account')));
    assert.equal(result.verdict, 'inconclusive');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('every readiness gate satisfied together with a matched cohort and verified completions yields a promote verdict', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const common = { run_id: 'run-promote', role: 'executor', runtime: 'claude', model: 'opus', effort: 'high',
      account_scope: 'anthropic-max', backend: 'workflow', policy_hash: 'a'.repeat(64), evidence: 'usage',
      bytes: 0, stage: 'model_turn', estimated_tokens: null,
      provider_tokens: { input_tokens: 10, output_tokens: 2 }, counts: { model_turns: 1, tool_calls: 0 } };
    recorder.record({ ...common, observation_id: 'promote-baseline', dispatch_id: 'dispatch-promote-baseline',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } });
    recorder.record({ ...common, observation_id: 'promote-treatment', dispatch_id: 'dispatch-promote-treatment',
      treatment: { wait_events: 'opt-06', bounded_context: 'baseline' } });
    const result = recorder.report({
      experiment_id: 'exp-promote', min_completed: 1, attribution_coverage: 1,
      defect_window_days: 7, experiment_boundary: true, finalized_output_coverage: 'observed',
      verified_completions: [
        { ticket: 'T-41-06-promote', run_id: 'run-promote', dispatch_ids: ['dispatch-promote-baseline'] },
      ],
    });
    assert.deepEqual(result.missing_coverage, []);
    assert.equal(result.verdict, 'promote');
    assert.deepEqual(result.status, {
      implemented: true, installed: true, behaviorally_verified: true, efficiency_measured: true,
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

const PROMOTE_OPTIONS = Object.freeze({ min_completed: 1, attribution_coverage: 1, defect_window_days: 7,
  experiment_boundary: true, finalized_output_coverage: 'observed' });

function promoteRow(overrides = {}) {
  return { run_id: 'run-gate', role: 'executor', runtime: 'claude', model: 'opus', effort: 'high',
    account_scope: 'anthropic-max', backend: 'workflow', policy_hash: 'a'.repeat(64), evidence: 'usage',
    bytes: 0, stage: 'model_turn', estimated_tokens: null,
    provider_tokens: { input_tokens: 10, output_tokens: 2 }, counts: { model_turns: 1, tool_calls: 0 }, ...overrides };
}

test('arms that change both treatments at once are not a matched cohort and stay inconclusive', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    recorder.record(promoteRow({ observation_id: 'both-baseline', dispatch_id: 'dispatch-both-baseline',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } }));
    recorder.record(promoteRow({ observation_id: 'both-treated', dispatch_id: 'dispatch-both-treated',
      treatment: { wait_events: 'opt-06', bounded_context: 'opt-07' } }));
    const result = recorder.report({ experiment_id: 'exp-bundled', ...PROMOTE_OPTIONS,
      verified_completions: [{ ticket: 'T-41-06-both', run_id: 'run-gate', dispatch_ids: ['dispatch-both-baseline'] }] });
    assert.equal(result.matched_cohorts[0].matched, false);
    assert.deepEqual(result.matched_cohorts[0].comparisons, []);
    assert.ok(result.missing_coverage.some((m) => m.includes('single-treatment difference')));
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.status.efficiency_measured, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a cohort with unknown model, effort or account identity is never matched', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const unknown = { model: null, effort: null, account_scope: null };
    recorder.record(promoteRow({ ...unknown, observation_id: 'null-baseline', dispatch_id: 'dispatch-null-baseline',
      treatment: { wait_events: 'baseline', bounded_context: 'baseline' } }));
    recorder.record(promoteRow({ ...unknown, observation_id: 'null-treated', dispatch_id: 'dispatch-null-treated',
      treatment: { wait_events: 'opt-06', bounded_context: 'baseline' } }));
    const result = recorder.report({ experiment_id: 'exp-null', ...PROMOTE_OPTIONS,
      verified_completions: [{ ticket: 'T-41-06-null', run_id: 'run-gate', dispatch_ids: ['dispatch-null-baseline'] }] });
    assert.equal(result.matched_cohorts[0].matched, false);
    assert.deepEqual(result.matched_cohorts[0].missing_identity, ['model', 'effort', 'account_scope']);
    assert.ok(result.missing_coverage.includes('cohort identity for claude/executor (missing model, effort, account_scope)'));
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.status.efficiency_measured, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('per-completion numerator is all cohort consumption, with failed attempts joined and the rest unassigned', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const arm = { treatment: { wait_events: 'baseline', bounded_context: 'baseline' } };
    recorder.record(promoteRow({ ...arm, observation_id: 'attempt-failed', run_id: 'run-failed',
      dispatch_id: 'dispatch-failed', bytes: 5 }));
    recorder.record(promoteRow({ ...arm, observation_id: 'attempt-recovery', run_id: 'run-recovery',
      dispatch_id: 'dispatch-recovery', bytes: 12 }));
    recorder.record(promoteRow({ ...arm, observation_id: 'attempt-other', run_id: 'run-other',
      dispatch_id: 'dispatch-other', bytes: 20 }));
    recorder.record(promoteRow({ ...arm, observation_id: 'attempt-orphan', run_id: 'run-orphan',
      dispatch_id: 'dispatch-orphan', bytes: 3 }));
    const result = recorder.report({ experiment_id: 'exp-numerator', verified_completions: [
      { ticket: 'T-41-06-recovered', run_id: 'run-recovery', dispatch_ids: ['dispatch-failed', 'dispatch-recovery'] },
      { ticket: 'T-41-06-other', run_id: 'run-other', dispatch_ids: ['dispatch-other'] },
    ] });
    const per = result.metrics_per_completion;
    assert.deepEqual(per.rows.map((row) => [row.ticket, row.bytes, row.model_turns]),
      [['T-41-06-recovered', 17, 2], ['T-41-06-other', 20, 1]]);
    assert.deepEqual([per.bytes.sum, per.bytes.median, per.bytes.p90, per.bytes.cohort_total, per.bytes.per_completion],
      [37, 17, 20, 40, 20]);
    assert.deepEqual([per.model_turns.sum, per.model_turns.cohort_total, per.model_turns.per_completion], [3, 4, 2]);
    assert.deepEqual(per.unassigned_overhead, { rows: 1, bytes: 3, estimated_tokens: null, wait_polls: null,
      model_turns: 1, tool_calls: 0, retries: null });
    assert.equal(per.shared_overhead.rows, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('retries are counted as their own metric, separate from wait polls and model turns', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    recorder.record(identity({ observation_id: 'retry-1', stage: 'model_turn', evidence: 'controller',
      counts: { retries: 3 } }));
    const result = recorder.report({ experiment_id: 'exp-retries' });
    assert.equal(result.metrics.retries.value, 3);
    assert.equal(result.metrics.wait_polls.value, null);
    assert.equal(result.metrics.model_turns.value, null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

done();
