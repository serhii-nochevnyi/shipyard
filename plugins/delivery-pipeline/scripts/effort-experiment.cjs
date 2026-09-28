#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const overhead = require('./orchestration-overhead.cjs');
const { POLICY } = require('./model-policy.cjs');

const EXPERIMENT_SCHEMA = 'shipyard.effort-experiment.v1';
const REPORT_SCHEMA = 'shipyard.effort-experiment-report.v1';
const DECISION_SCHEMA = 'shipyard.effort-experiment-decision.v1';
const ACTIVATION_REQUIRES = 'ADR-014 amendment or separate ADR';
const COMPARISON_REASON = 'effort is an orchestration-overhead cohort key; matchedCohorts never pairs effort arms';
const FLOOR = Object.freeze({ min_completions: 20, attribution: 0.95, window_days: 7 });
const OUTCOME_VALUES = new Set(['verified', 'failed', 'abandoned']);
const DECISION_VALUES = new Set(['promote', 'reject']);
const REPAIR_ROLES = new Set(['ci-fix', 'review-fix']);
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

class EffortExperimentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EffortExperimentError';
    this.code = code;
  }
}

function fail(code, message) { throw new EffortExperimentError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function text(value, label, code = 'INVALID_EXPERIMENT') {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${label} must be non-empty text`);
  return value;
}

// @invariant: reads POLICY only; the current fingerprint is derived, never imported separately.
const CURRENT_POLICY_HASH = digest(POLICY);

function baseRungFor(runtime, role) {
  const rungs = POLICY.role_rungs[runtime] && POLICY.role_rungs[runtime][role];
  return (rungs && rungs.find((rung) => rung.name === 'base')) || null;
}

function runtimeEfforts(runtime) {
  const roles = POLICY.role_rungs[runtime] || {};
  const efforts = new Set();
  for (const rungs of Object.values(roles)) for (const rung of rungs) efforts.add(rung.effort);
  return efforts;
}

function normalizeExperiment(value) {
  if (!object(value)) fail('INVALID_EXPERIMENT', 'experiment must be an object');
  const experimentId = text(value.experiment_id, 'experiment_id');
  const runtime = text(value.runtime, 'runtime');
  if (!POLICY.role_rungs[runtime]) fail('INVALID_EXPERIMENT', `unknown runtime ${runtime}`);
  const role = text(value.role, 'role');
  const baseRung = baseRungFor(runtime, role);
  if (!baseRung) fail('INVALID_EXPERIMENT', `unknown role ${role} for runtime ${runtime}`);
  const model = text(value.model, 'model');
  if (model !== baseRung.model_key) {
    fail('INVALID_EXPERIMENT', `model ${model} is not the ADR-014 base rung model for ${runtime}/${role}`);
  }
  const policyHashRaw = text(value.policy_hash, 'policy_hash');
  if (!SHA256_HEX.test(policyHashRaw)) fail('INVALID_EXPERIMENT', 'policy_hash must be a SHA-256 digest');
  const policyHash = policyHashRaw.toLowerCase();
  if (policyHash !== CURRENT_POLICY_HASH) {
    fail('INVALID_EXPERIMENT', 'policy_hash is not the currently active ADR-014 policy fingerprint');
  }
  if (!Array.isArray(value.arms) || value.arms.length < 2) {
    fail('INVALID_EXPERIMENT', 'arms must be an array of at least two entries');
  }

  const validEfforts = runtimeEfforts(runtime);
  const seenEffort = new Set();
  let baselineCount = 0;
  const arms = value.arms.map((raw, index) => {
    if (!object(raw)) fail('INVALID_EXPERIMENT', `arms[${index}] must be an object`);
    const armId = text(raw.arm_id, `arms[${index}].arm_id`);
    const effort = text(raw.effort, `arms[${index}].effort`);
    if (!validEfforts.has(effort)) {
      fail('INVALID_EXPERIMENT', `arms[${index}].effort ${effort} is not valid for runtime ${runtime}`);
    }
    if (seenEffort.has(effort)) fail('INVALID_EXPERIMENT', `arms[${index}].effort ${effort} duplicates another arm`);
    seenEffort.add(effort);
    if (typeof raw.baseline !== 'boolean') fail('INVALID_EXPERIMENT', `arms[${index}].baseline must be boolean`);
    if (raw.model !== undefined && raw.model !== model) {
      fail('INVALID_EXPERIMENT', `arms[${index}].model differs from the experiment model`);
    }
    if (raw.baseline) baselineCount += 1;
    return { arm_id: armId, effort, baseline: raw.baseline };
  });
  if (baselineCount !== 1) fail('INVALID_EXPERIMENT', 'exactly one arm must be the baseline');
  const baselineArm = arms.find((arm) => arm.baseline);
  if (baselineArm.effort !== baseRung.effort) {
    fail('INVALID_EXPERIMENT', `baseline effort ${baselineArm.effort} is not the ADR-014 base rung effort`);
  }

  const activationInput = value.activation === undefined ? {} : value.activation;
  if (!object(activationInput)) fail('INVALID_EXPERIMENT', 'activation must be an object');
  const active = activationInput.active === undefined ? false : activationInput.active;
  const allowed = activationInput.allowed === undefined ? false : activationInput.allowed;
  if (active !== false || allowed !== false) {
    fail('INVALID_EXPERIMENT', 'activation.active and activation.allowed must both be false');
  }
  const requires = activationInput.requires === undefined ? ACTIVATION_REQUIRES : activationInput.requires;
  if (requires !== ACTIVATION_REQUIRES) {
    fail('INVALID_EXPERIMENT', `activation.requires must read '${ACTIVATION_REQUIRES}'`);
  }

  const comparisonInput = value.comparison === undefined ? {} : value.comparison;
  if (!object(comparisonInput)) fail('INVALID_EXPERIMENT', 'comparison must be an object');
  const comparison = {
    arm_key: 'effort', cohort_key_excludes: ['effort'], overhead_matched_pair: false, reason: COMPARISON_REASON,
  };
  for (const key of Object.keys(comparison)) {
    if (comparisonInput[key] !== undefined && stable(comparisonInput[key]) !== stable(comparison[key])) {
      fail('INVALID_EXPERIMENT', `comparison.${key} does not match the fixed effort-experiment contract`);
    }
  }

  const hasCandidate = arms.some((arm) => !arm.baseline);
  let baselineReportDigest = null;
  if (value.baseline_report_digest !== undefined && value.baseline_report_digest !== null) {
    const rawDigest = text(value.baseline_report_digest, 'baseline_report_digest');
    if (!SHA256_HEX.test(rawDigest)) fail('INVALID_EXPERIMENT', 'baseline_report_digest must be a SHA-256 digest');
    baselineReportDigest = rawDigest.toLowerCase();
  }
  if (runtime === 'codex' && hasCandidate && !baselineReportDigest) {
    fail('INVALID_EXPERIMENT', 'a Codex candidate arm requires baseline_report_digest from a prior Luna/max baseline report');
  }

  const eligibility = value.eligibility === undefined ? {} : clone(value.eligibility);
  if (!object(eligibility)) fail('INVALID_EXPERIMENT', 'eligibility must be an object');

  return {
    schema: EXPERIMENT_SCHEMA,
    experiment_id: experimentId,
    runtime,
    role,
    model,
    policy_hash: policyHash,
    arms,
    eligibility,
    activation: { active: false, allowed: false, requires: ACTIVATION_REQUIRES },
    comparison,
    baseline_report_digest: baselineReportDigest,
  };
}

function normalizeOutcome(raw, index) {
  if (!object(raw)) fail('INVALID_OUTCOME', `outcomes[${index}] must be an object`);
  const ticket = text(raw.ticket, `outcomes[${index}].ticket`, 'INVALID_OUTCOME');
  if (!Array.isArray(raw.run_ids) || !raw.run_ids.length) {
    fail('INVALID_OUTCOME', `outcomes[${index}].run_ids must be a non-empty array`);
  }
  const runIds = raw.run_ids.map((id, i) => text(id, `outcomes[${index}].run_ids[${i}]`, 'INVALID_OUTCOME'));
  const outcome = text(raw.outcome, `outcomes[${index}].outcome`, 'INVALID_OUTCOME');
  if (!OUTCOME_VALUES.has(outcome)) {
    fail('INVALID_OUTCOME', `outcomes[${index}].outcome must be verified, failed or abandoned`);
  }
  const completedAt = text(raw.completed_at, `outcomes[${index}].completed_at`, 'INVALID_OUTCOME');
  return { ticket, run_ids: runIds, outcome, completed_at: completedAt };
}

function normalizeDecision(raw) {
  if (!object(raw)) fail('INVALID_DECISION', 'decision must be an object');
  const decidedBy = text(raw.decided_by, 'decision.decided_by', 'INVALID_DECISION');
  const decidedAt = text(raw.decided_at, 'decision.decided_at', 'INVALID_DECISION');
  const decisionValue = text(raw.decision, 'decision.decision', 'INVALID_DECISION');
  if (!DECISION_VALUES.has(decisionValue)) fail('INVALID_DECISION', 'decision.decision must be promote or reject');
  const rawDigest = text(raw.evidence_digest, 'decision.evidence_digest', 'INVALID_DECISION');
  if (!SHA256_HEX.test(rawDigest)) fail('INVALID_DECISION', 'decision.evidence_digest must be a SHA-256 digest');
  return {
    schema: DECISION_SCHEMA, decided_by: decidedBy, decided_at: decidedAt,
    decision: decisionValue, evidence_digest: rawDigest.toLowerCase(),
  };
}

function tokensOf(row) {
  return row && Number.isSafeInteger(row.estimated_tokens) ? row.estimated_tokens : 0;
}

function report(experiment, options = {}) {
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const outcomes = Array.isArray(options.outcomes) ? options.outcomes.map(normalizeOutcome) : [];
  const now = options.now === undefined ? new Date().toISOString() : options.now;

  const unitByRunId = new Map();
  for (const unit of outcomes) for (const runId of unit.run_ids) unitByRunId.set(runId, unit);

  const rowsByUnit = new Map(outcomes.map((unit) => [unit, []]));
  let unattributedRows = 0;
  for (const row of rows) {
    const unit = row && unitByRunId.get(row.run_id);
    if (!unit) { unattributedRows += 1; continue; }
    rowsByUnit.get(unit).push(row);
  }

  const armByEffort = new Map(experiment.arms.map((arm) => [arm.effort, arm]));
  const buckets = new Map(experiment.arms.map((arm) => [arm.arm_id, {
    verified: 0, failed: 0, abandoned: 0, rows: 0, estimated_tokens: 0,
    repair: { rows: 0, estimated_tokens: 0 },
    escalation: { rows: 0, estimated_tokens: 0 },
  }]));
  const ineligible = { runtime: 0, role: 0, model: 0, policy_mismatch: 0, effort_not_in_arms: 0, unattributed: 0 };
  const attributionRows = [];
  const eligibleDays = [];

  // @contract: the first unit row matching the experiment role decides arm assignment for the whole unit.
  for (const unit of outcomes) {
    const unitRows = rowsByUnit.get(unit);
    if (!unitRows.length) { ineligible.unattributed += 1; continue; }
    const assigning = unitRows.find((row) => row.role === experiment.role);
    if (!assigning) { ineligible.role += 1; continue; }
    if (assigning.runtime !== experiment.runtime) { ineligible.runtime += 1; continue; }
    if (assigning.model !== experiment.model) { ineligible.model += 1; continue; }
    if (assigning.policy_hash !== experiment.policy_hash) { ineligible.policy_mismatch += 1; continue; }
    const arm = armByEffort.get(assigning.effort);
    if (!arm) { ineligible.effort_not_in_arms += 1; continue; }

    const bucket = buckets.get(arm.arm_id);
    bucket[unit.outcome] += 1;
    eligibleDays.push(unit.completed_at);
    for (const row of unitRows) {
      bucket.rows += 1;
      bucket.estimated_tokens += tokensOf(row);
      if (REPAIR_ROLES.has(row.role)) {
        bucket.repair.rows += 1;
        bucket.repair.estimated_tokens += tokensOf(row);
      } else if (row.role === experiment.role && (row.model !== experiment.model || row.effort !== arm.effort)) {
        bucket.escalation.rows += 1;
        bucket.escalation.estimated_tokens += tokensOf(row);
      }
      if (row.dispatch_id) attributionRows.push(row);
    }
  }

  const attributed = attributionRows.filter((row) => row.attribution_status === 'observed').length;
  const attribution = attributionRows.length ? attributed / attributionRows.length : null;

  let windowDays = 0;
  const times = eligibleDays.map((iso) => Date.parse(iso)).filter((n) => Number.isFinite(n));
  if (times.length) windowDays = Math.floor((Math.max(...times) - Math.min(...times)) / DAY_MS);

  const arms = experiment.arms.map((arm) => {
    const bucket = buckets.get(arm.arm_id);
    const perVerified = bucket.verified > 0
      ? Math.round((bucket.estimated_tokens / bucket.verified) * 100) / 100 : null;
    return {
      arm_id: arm.arm_id, effort: arm.effort, baseline: arm.baseline,
      units: { verified: bucket.verified, failed: bucket.failed, abandoned: bucket.abandoned },
      rows: bucket.rows, estimated_tokens: bucket.estimated_tokens,
      repair: { ...bucket.repair }, escalation: { ...bucket.escalation },
      per_verified_completion: { estimated_tokens: perVerified },
      floor_met: bucket.verified >= FLOOR.min_completions,
    };
  });

  const baselineArm = arms.find((arm) => arm.baseline);
  const baselineBucket = buckets.get(baselineArm.arm_id);
  const baselineTotal = baselineBucket.verified + baselineBucket.failed + baselineBucket.abandoned;

  const reasons = [];
  let verdict;
  if (baselineTotal === 0) {
    verdict = 'baseline_pending';
    reasons.push('the baseline arm has no recorded completions yet');
  } else {
    const candidateWorse = arms.some((arm) => {
      if (arm.baseline) return false;
      const bucket = buckets.get(arm.arm_id);
      return (bucket.failed + bucket.abandoned) > (baselineBucket.failed + baselineBucket.abandoned);
    });
    if (candidateWorse) {
      verdict = 'rollback';
      reasons.push('a candidate arm has more failed or abandoned work than the baseline arm');
    } else {
      const floorMet = arms.every((arm) => arm.floor_met);
      const attributionMet = attribution !== null && attribution >= FLOOR.attribution;
      const windowMet = windowDays >= FLOOR.window_days;
      if (floorMet && attributionMet && windowMet) {
        verdict = 'ready_for_human_decision';
      } else {
        verdict = 'inconclusive';
        if (!floorMet) reasons.push(`fewer than ${FLOOR.min_completions} verified completions in at least one arm`);
        if (!attributionMet) reasons.push(`dispatch attribution coverage below ${FLOOR.attribution}`);
        if (!windowMet) reasons.push(`fewer than ${FLOOR.window_days} observed days`);
      }
    }
  }

  const core = {
    schema: REPORT_SCHEMA,
    experiment_id: experiment.experiment_id,
    runtime: experiment.runtime, role: experiment.role, model: experiment.model, policy_hash: experiment.policy_hash,
    generated_at: now,
    window_days: windowDays,
    attribution,
    arms,
    ineligible: { ...ineligible },
    unattributed_rows: unattributedRows,
    verdict,
    verdict_reasons: reasons,
    activation: { active: false, allowed: false },
    status: { implemented: true, installed: rows.length > 0, behaviorally_verified: false, efficiency_measured: false },
  };
  const reportDigest = digest(core);

  let decisionOut = null;
  let decisionIgnoredReason = null;
  if (options.decision !== undefined && options.decision !== null) {
    const decision = normalizeDecision(options.decision);
    if (verdict !== 'ready_for_human_decision') {
      decisionIgnoredReason = 'verdict is not ready_for_human_decision';
    } else if (decision.evidence_digest !== reportDigest) {
      decisionIgnoredReason = 'evidence_digest does not match the current report digest';
    } else {
      decisionOut = decision;
    }
  }

  return { ...core, report_digest: reportDigest, decision: decisionOut, decision_ignored_reason: decisionIgnoredReason };
}

function cliValue(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
}

function readJson(file, label) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(file), 'utf8'); }
  catch (error) { fail('INVALID_INPUT', `cannot read ${label}: ${error.message}`); }
  try { return JSON.parse(raw); }
  catch (error) { fail('INVALID_INPUT', `${label} is not valid JSON: ${error.message}`); }
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'validate') {
    const file = cliValue(argv, '--experiment');
    if (!file) fail('INVALID_INPUT', 'usage: effort-experiment.cjs validate --experiment FILE');
    const normalized = normalizeExperiment(readJson(file, '--experiment'));
    process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
    return 0;
  }
  if (command === 'report') {
    const experimentFile = cliValue(argv, '--experiment');
    const graphDir = cliValue(argv, '--graph');
    const outcomesFile = cliValue(argv, '--outcomes');
    if (!experimentFile || !graphDir || !outcomesFile) {
      fail('INVALID_INPUT', 'usage: effort-experiment.cjs report --experiment FILE --graph DIR --outcomes FILE [--decision FILE]');
    }
    const experiment = normalizeExperiment(readJson(experimentFile, '--experiment'));
    const rows = overhead.latestRows(overhead.readStream(graphDir).rows);
    const outcomes = readJson(outcomesFile, '--outcomes');
    const decisionFile = cliValue(argv, '--decision');
    const decision = decisionFile ? readJson(decisionFile, '--decision') : undefined;
    const output = report(experiment, { rows, outcomes, decision });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  fail('INVALID_INPUT', 'usage: effort-experiment.cjs <validate|report> ...');
}

module.exports = Object.freeze({
  EXPERIMENT_SCHEMA, REPORT_SCHEMA, DECISION_SCHEMA, FLOOR,
  EffortExperimentError, normalizeExperiment, report,
});

if (require.main === module) {
  try { process.exitCode = cli(); }
  catch (error) {
    process.stderr.write(`effort-experiment: ${error.message}\n`);
    process.exitCode = 2;
  }
}
