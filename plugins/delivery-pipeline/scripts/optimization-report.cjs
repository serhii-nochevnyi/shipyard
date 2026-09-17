#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, writeAtomic, lockDirFor } = require('./lock.cjs');

const SCHEMA_VERSION = 'shipyard.optimization-report.v1';
const CANDIDATE_SCHEMA_VERSION = 'shipyard.optimization-candidate.v1';
const RUN_STATES = Object.freeze(['completed', 'failed', 'parked', 'interrupted']);
const COVERAGE_STATES = Object.freeze(['complete', 'partial', 'unknown']);
const VERDICTS = Object.freeze(['promote', 'continue_trial', 'rollback', 'inconclusive']);
const QUALITY_KEYS = Object.freeze([
  'false_green', 'invalid_carry', 'skipped_gate', 'recovery_loss', 'duplicate_dispatch',
  'orphaned_work', 'lost_constraints', 'escaped_defects', 'regressions',
]);
const SENSITIVE_KEYS = new Set([
  'prompt', 'prompts', 'transcript', 'transcripts', 'messages', 'content', 'body',
  'token', 'tokens', 'credential', 'credentials', 'secret', 'secrets', 'authorization',
]);

class OptimizationReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OptimizationReportError';
    this.code = code;
  }
}

function fail(code, message) { throw new OptimizationReportError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_REPORT', `${label} must be non-empty text`);
  }
  if (value.length > 512) fail('INVALID_REPORT', `${label} is too long`);
  return value.trim();
}
function integer(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REPORT', `${label} must be a non-negative safe integer`);
  return value;
}
function number(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_REPORT', `${label} must be finite`);
  return value;
}
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
function rejectSensitive(value, where = 'report', seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('INVALID_REPORT', `${where} contains a circular value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) fail('METADATA_ONLY', `${where}.${key} is not allowed`);
    rejectSensitive(child, `${where}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeRevision(value, label) {
  if (typeof value === 'string') return text(value, label);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  fail('INVALID_REPORT', `${label} must identify a revision`);
}

function normalizeVersionedSide(value, label) {
  if (!object(value)) fail('INVALID_REPORT', `${label} must be an object`);
  return {
    revision: normalizeRevision(value.revision ?? value.rev, `${label}.revision`),
    runtime: text(value.runtime, `${label}.runtime`),
    policy: text(value.policy || value.policy_version, `${label}.policy`),
    collector: text(value.collector || value.collector_version, `${label}.collector`),
  };
}

function normalizeScope(value) {
  if (value === undefined || value === null) return { provider: null, account_scope: null };
  if (!object(value)) fail('INVALID_REPORT', 'provider_scope must be an object');
  return {
    provider: value.provider === undefined || value.provider === null ? null : text(value.provider, 'provider_scope.provider'),
    account_scope: value.account_scope === undefined || value.account_scope === null
      ? null : text(value.account_scope, 'provider_scope.account_scope'),
  };
}

function normalizeWindow(value) {
  if (value === undefined || value === null) return { from: null, to: null };
  if (!object(value)) fail('INVALID_REPORT', 'window must be an object');
  return {
    from: value.from === undefined || value.from === null ? null : text(value.from, 'window.from'),
    to: value.to === undefined || value.to === null ? null : text(value.to, 'window.to'),
  };
}

function normalizeRollback(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) fail('INVALID_REPORT', 'rollback must be an object');
  return {
    strategy: value.strategy === undefined || value.strategy === null ? null : text(value.strategy, 'rollback.strategy'),
    owner: value.owner === undefined || value.owner === null ? null : text(value.owner, 'rollback.owner'),
    trigger: value.trigger === undefined || value.trigger === null ? null : text(value.trigger, 'rollback.trigger'),
  };
}

function normalizeQuality(value, label = 'quality') {
  const raw = value === undefined || value === null ? {} : value;
  if (!object(raw)) fail('INVALID_REPORT', `${label} must be an object`);
  const out = {};
  for (const key of QUALITY_KEYS) if (raw[key] !== undefined) out[key] = integer(raw[key], `${label}.${key}`);
  return out;
}

function normalizeRun(value, index) {
  if (!object(value)) fail('INVALID_REPORT', `runs[${index}] must be an object`);
  const status = text(value.status, `runs[${index}].status`);
  if (!RUN_STATES.includes(status)) fail('INVALID_REPORT', `runs[${index}] has unsupported status ${status}`);
  const coverage = value.coverage === undefined ? 'unknown' : text(value.coverage, `runs[${index}].coverage`);
  if (!COVERAGE_STATES.includes(coverage)) fail('INVALID_REPORT', `runs[${index}] has unsupported coverage ${coverage}`);
  const arm = value.arm === undefined || value.arm === null ? null : text(value.arm, `runs[${index}].arm`);
  if (arm !== null && !['baseline', 'treatment'].includes(arm)) fail('INVALID_REPORT', `runs[${index}] has unsupported arm ${arm}`);
  const usage = value.usage === undefined || value.usage === null ? null : value.usage;
  if (usage !== null && !object(usage)) fail('INVALID_REPORT', `runs[${index}].usage must be an object`);
  const metrics = value.metrics === undefined || value.metrics === null ? {} : value.metrics;
  if (!object(metrics)) fail('INVALID_REPORT', `runs[${index}].metrics must be an object`);
  return {
    run_id: text(value.run_id || value.id, `runs[${index}].run_id`),
    status,
    coverage,
    arm,
    ...(value.outcome === undefined || value.outcome === null ? {} : { outcome: text(value.outcome, `runs[${index}].outcome`) }),
    ...(value.started_at === undefined || value.started_at === null ? {} : { started_at: text(value.started_at, `runs[${index}].started_at`) }),
    ...(value.completed_at === undefined || value.completed_at === null ? {} : { completed_at: text(value.completed_at, `runs[${index}].completed_at`) }),
    usage: usage === null ? null : clone(usage),
    metrics: clone(metrics),
    quality: normalizeQuality(value.quality, `runs[${index}].quality`),
  };
}

function normalizeComparison(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) fail('INVALID_REPORT', 'comparison must be an object');
  const lowerIsBetter = value.lower_is_better !== false;
  const baseline = number(value.baseline, 'comparison.baseline');
  const treatment = number(value.treatment, 'comparison.treatment');
  const delta = treatment - baseline;
  return {
    metric: text(value.metric || 'cost', 'comparison.metric'),
    unit: text(value.unit || 'unknown', 'comparison.unit'),
    lower_is_better: lowerIsBetter,
    baseline,
    treatment,
    delta,
    relative_delta: baseline === 0 ? null : delta / Math.abs(baseline),
  };
}

function coverageFor(report) {
  const counts = Object.fromEntries(COVERAGE_STATES.map((value) => [value, report.runs.filter((run) => run.coverage === value).length]));
  const complete = counts.complete === report.runs.length && report.runs.length > 0;
  return {
    ...counts,
    state: complete ? 'complete' : counts.unknown ? 'unknown' : 'partial',
    denominator: report.runs.length,
    includes_failed: report.runs.some((run) => run.status === 'failed'),
    includes_parked: report.runs.some((run) => run.status === 'parked'),
    includes_interrupted: report.runs.some((run) => run.status === 'interrupted'),
  };
}

function qualityFor(report) {
  const out = Object.fromEntries(QUALITY_KEYS.map((key) => [key, 0]));
  for (const key of QUALITY_KEYS) {
    out[key] = (report.quality && Number.isSafeInteger(report.quality[key]) ? report.quality[key] : 0)
      + report.runs.reduce((sum, run) => sum + (run.quality[key] || 0), 0);
  }
  return out;
}

function normalizeReport(input = {}) {
  if (!object(input)) fail('INVALID_REPORT', 'report must be an object');
  rejectSensitive(input);
  const runs = Array.isArray(input.runs) ? input.runs.map(normalizeRun) : [];
  const treatmentId = input.treatment_id
    || (typeof input.treatment === 'string' ? input.treatment : input.treatment_name);
  const treatmentSide = input.treatment_revision || input.treatment_definition
    || (object(input.treatment) ? input.treatment : null);
  const report = {
    schema_version: SCHEMA_VERSION,
    report_id: text(input.report_id || input.id, 'report_id'),
    treatment_id: text(treatmentId, 'treatment_id'),
    policy_version: text(input.policy_version, 'policy_version'),
    baseline: normalizeVersionedSide(input.baseline, 'baseline'),
    treatment: normalizeVersionedSide(treatmentSide, 'treatment'),
    provider_scope: normalizeScope(input.provider_scope || (input.provider || input.account_scope
      ? { provider: input.provider, account_scope: input.account_scope } : null)),
    window: normalizeWindow(input.window),
    cohort: {
      name: text((input.cohort && input.cohort.name) || input.cohort_name || 'default', 'cohort.name'),
    },
    sample_target: integer(input.sample_target === undefined ? input.cohort && input.cohort.sample_target : input.sample_target, 'sample_target'),
    rollback: normalizeRollback(input.rollback),
    comparison: normalizeComparison(input.comparison),
    metrics: input.metrics === undefined || input.metrics === null ? {} : clone(input.metrics),
    quality: normalizeQuality(input.quality),
    runs,
    rollback_history: Array.isArray(input.rollback_history) ? clone(input.rollback_history) : [],
  };
  if (report.sample_target < 1) fail('INVALID_REPORT', 'sample_target must be positive');
  return report;
}

function evaluateReport(input = {}) {
  const report = normalizeReport(input);
  const coverage = coverageFor(report);
  const quality = qualityFor(report);
  const reasons = [];
  const missing = [];
  const denominator = report.runs.length;
  const arms = new Set(report.runs.map((run) => run.arm).filter(Boolean));
  if (denominator < report.sample_target) missing.push(`sample target (${denominator}/${report.sample_target})`);
  if (!arms.has('baseline') || !arms.has('treatment')) missing.push('baseline and treatment arms');
  if (coverage.state !== 'complete') missing.push(`complete run coverage (${coverage.state})`);
  if (!report.provider_scope.provider || !report.provider_scope.account_scope) missing.push('provider and account scope');
  if (!report.window.from || !report.window.to) missing.push('measurement window');
  if (!report.rollback || !report.rollback.strategy || !report.rollback.owner) missing.push('rollback owner and strategy');
  if (!report.comparison) missing.push('baseline/treatment comparison metric');
  const regressions = QUALITY_KEYS.filter((key) => quality[key] > 0);
  if (regressions.length) reasons.push(`quality regression requires rollback: ${regressions.join(', ')}`);
  let verdict;
  if (reasons.length) verdict = 'rollback';
  else if (missing.length) verdict = 'inconclusive';
  else {
    const improved = report.comparison.lower_is_better
      ? report.comparison.treatment < report.comparison.baseline
      : report.comparison.treatment > report.comparison.baseline;
    verdict = improved ? 'promote' : 'continue_trial';
    if (!improved) reasons.push('treatment has not improved the comparison metric');
  }
  return {
    verdict,
    eligible: verdict === 'promote' || verdict === 'continue_trial',
    reasons,
    missing,
    denominator,
    coverage,
    quality,
    arms: Object.fromEntries(['baseline', 'treatment'].map((arm) => [arm, report.runs.filter((run) => run.arm === arm).length])),
  };
}

function buildReport(input = {}, now = new Date().toISOString()) {
  const report = normalizeReport(input);
  const evaluation = evaluateReport(report);
  return {
    ...report,
    created_at: input.created_at === undefined ? now : text(input.created_at, 'created_at'),
    evaluation,
  };
}

function reportDigest(report) { return digest(report); }
function reportFile(root, treatmentId) {
  return path.join(path.resolve(root), '.planning', 'graph', 'optimization-reports', `${digest(treatmentId).slice(0, 24)}.json`);
}

function writeReport(root, report, options = {}) {
  const normalized = buildReport(report, report.created_at || new Date().toISOString());
  const file = options.file ? path.resolve(options.file) : reportFile(root, normalized.treatment_id);
  const projectRoot = path.resolve(root);
  return withLock(lockDirFor(projectRoot), 'optimization-report', () => {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('REPORT_STORE_INVALID', `cannot read ${file}: ${error.message}`); }
    if (existing) {
      if (existing.report_id !== normalized.report_id || reportDigest(existing) !== reportDigest(normalized)) {
        fail('REPORT_CONFLICT', `report file already contains a different report for ${normalized.treatment_id}`);
      }
      return { written: false, idempotent: true, file, report: existing };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
    return { written: true, idempotent: false, file, report: normalized };
  }, { label: 'optimization-report' });
}

function withRollback(report, entry, now = new Date().toISOString()) {
  const normalized = buildReport(report, report.created_at || now);
  if (!object(entry)) fail('INVALID_ROLLBACK', 'rollback entry must be an object');
  const reason = text(entry.reason, 'rollback.reason');
  const evidence = entry.evidence === undefined ? [] : entry.evidence;
  if (!Array.isArray(evidence) || evidence.some((value) => typeof value !== 'string' || !value.trim())) {
    fail('INVALID_ROLLBACK', 'rollback evidence must be an array of text references');
  }
  const event = {
    at: entry.at === undefined ? now : text(entry.at, 'rollback.at'),
    reason,
    evidence: evidence.map((value) => text(value, 'rollback.evidence[]')),
  };
  const history = [...normalized.rollback_history, event];
  const next = { ...normalized, rollback_history: history };
  const evaluated = evaluateReport(next);
  const evaluation = { ...evaluated, verdict: 'rollback', eligible: false,
    reasons: [...evaluated.reasons, `rollback recorded: ${reason}`] };
  return { ...next, evaluation };
}

function candidateFromReport(report) {
  const normalized = report.schema_version === SCHEMA_VERSION ? clone(report) : buildReport(report);
  const evaluation = normalized.evaluation || evaluateReport(normalized);
  const reportHash = reportDigest(normalized);
  return {
    schema_version: CANDIDATE_SCHEMA_VERSION,
    candidate_id: `candidate-${reportHash.slice(0, 24)}`,
    report_id: normalized.report_id,
    report_digest: reportHash,
    treatment_id: normalized.treatment_id,
    verdict: evaluation.verdict,
    linked_evidence: {
      report_id: normalized.report_id,
      report_digest: reportHash,
      policy_version: normalized.policy_version,
      coverage: evaluation.coverage,
    },
    action: evaluation.verdict === 'promote' ? 'review-before-launch' : 'collect-more-evidence',
    auto_launch: false,
  };
}

function cliValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'evaluate';
  const inputFile = cliValue(argv, '--input');
  if (!inputFile) fail('INVALID_INPUT', '--input is required');
  let input;
  try { input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8')); }
  catch (error) { fail('INVALID_INPUT', `cannot read input JSON: ${error.message}`); }
  let output;
  if (command === 'candidate') output = candidateFromReport(buildReport(input));
  else if (command === 'create' || command === 'evaluate') {
    output = buildReport(input);
    if (command === 'create' && cliValue(argv, '--root')) output = writeReport(cliValue(argv, '--root'), output).report;
  } else fail('INVALID_INPUT', 'usage: optimization-report.cjs <evaluate|create|candidate> --input FILE [--root PROJECT]');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output.evaluation && output.evaluation.verdict === 'rollback' ? 3 : 0;
}

module.exports = Object.freeze({
  SCHEMA_VERSION, CANDIDATE_SCHEMA_VERSION, RUN_STATES, COVERAGE_STATES, VERDICTS,
  OptimizationReportError, normalizeReport, evaluateReport, buildReport, reportDigest,
  reportFile, writeReport, withRollback, candidateFromReport,
});

if (require.main === module) {
  try { process.exitCode = cli(); }
  catch (error) {
    process.stderr.write(`optimization-report: ${error.message}\n`);
    process.exitCode = error.code === 'INVALID_INPUT' ? 2 : 1;
  }
}
