#!/usr/bin/env node
'use strict';

// Metadata-only accounting for orchestration treatments. Provider usage stays
// in usage-attribution; this stream records the bytes and observations needed
// to compare waiting with bounded context without storing prompts or evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');

const SCHEMA_VERSION = 1;
const STREAM_NAME = 'orchestration-overhead.jsonl';
const REPORT_SCHEMA = 'shipyard.orchestration-overhead-report.v1';
const ESTIMATOR_VERSION = 'utf8-bytes-div4-v1';
const DEFAULT_MIN_COMPLETED = 20;
const DEFAULT_ATTRIBUTION_TARGET = 0.95;
const TREATMENT_KEYS = Object.freeze(['wait_events', 'bounded_context']);
const TREATMENT_VALUES = Object.freeze({
  wait_events: new Set(['baseline', 'opt-06']),
  bounded_context: new Set(['baseline', 'opt-07']),
});
const STAGES = new Set([
  'startup', 'ordinary_input', 'parent_reingestion', 'checkpoint_collection',
  'successor_startup', 'cache_warmup', 'wait_poll', 'model_turn', 'tool_call',
]);
const HANDOFF_COST_STAGES = new Set(['checkpoint_collection', 'successor_startup', 'cache_warmup']);
const PASS_KINDS = new Set(['ordinary', 'advisor']);
const EVIDENCE = new Set(['usage', 'transcript', 'wait-event', 'controller', 'none']);
const COUNT_KEYS = Object.freeze(['polls', 'model_turns', 'tool_calls']);
const QUALITY_KEYS = Object.freeze([
  'false_green', 'invalid_carry', 'skipped_gate', 'recovery_loss',
  'duplicate_dispatch', 'orphaned_work', 'lost_constraints', 'escaped_defects',
  'reopens', 'started', 'completed', 'failed', 'parked', 'interrupted',
]);
const SENSITIVE_KEYS = new Set([
  'prompt', 'prompts', 'transcript', 'transcripts', 'credential', 'credentials',
  'secret', 'secrets', 'token', 'access_token', 'refresh_token', 'authorization',
  'content', 'body', 'input', 'output', 'messages',
]);

class OverheadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OverheadError';
    this.code = code;
  }
}

function fail(code, message) { throw new OverheadError(code, message); }
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

function text(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_OBSERVATION', `${label} must be non-empty text`);
  }
  if (value.length > 512) fail('INVALID_OBSERVATION', `${label} is too long`);
  return value;
}

function safeInteger(value, label, { nullable = false } = {}) {
  if (value === undefined && nullable) return null;
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_COUNTER', `${label} must be a non-negative safe integer`);
  return value;
}

function optionalNumber(value, label) {
  if (value === undefined || value === null) return null;
  return safeInteger(value, label);
}

function rejectSensitive(value, where = 'observation', seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('INVALID_OBSERVATION', `${where} contains a circular value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) fail('METADATA_ONLY', `${where}.${key} is not allowed in metadata-only telemetry`);
    rejectSensitive(child, `${where}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeTreatment(value) {
  const raw = value === undefined || value === null ? {} : value;
  if (!object(raw)) fail('INVALID_TREATMENT', 'treatment must be an object');
  const aliases = {
    wait: 'wait_events', waitEvents: 'wait_events', 'opt-06': 'wait_events',
    context: 'bounded_context', boundedContext: 'bounded_context', 'opt-07': 'bounded_context',
  };
  const out = { wait_events: 'baseline', bounded_context: 'baseline' };
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = aliases[rawKey] || rawKey;
    if (!TREATMENT_KEYS.includes(key)) fail('INVALID_TREATMENT', `unknown treatment dimension ${rawKey}`);
    const valueText = text(rawValue, `treatment.${key}`);
    const canonical = valueText === 'on' ? (key === 'wait_events' ? 'opt-06' : 'opt-07')
      : valueText === 'off' ? 'baseline' : valueText;
    if (!TREATMENT_VALUES[key].has(canonical)) fail('INVALID_TREATMENT', `unsupported ${key} treatment ${valueText}`);
    out[key] = canonical;
  }
  return out;
}

function treatmentId(treatment) {
  const value = normalizeTreatment(treatment);
  return TREATMENT_KEYS.map((key) => `${key}=${value[key]}`).join(';');
}

function normalizeSourceRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('INVALID_OBSERVATION', 'source_refs must be an array');
  return value.map((raw, index) => {
    if (!object(raw)) fail('INVALID_OBSERVATION', `source_refs[${index}] must be an object`);
    const source = text(raw.path, `source_refs[${index}].path`);
    if (path.isAbsolute(source) || source.split(/[\\/]+/).includes('..')) {
      fail('SOURCE_PATH_ESCAPE', `source_refs[${index}] must be repository-relative`);
    }
    const sha256 = text(raw.sha256 || raw.digest, `source_refs[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/i.test(sha256)) fail('INVALID_OBSERVATION', `source_refs[${index}].sha256 must be SHA-256`);
    return {
      path: source.split(path.sep).join('/'),
      sha256: sha256.toLowerCase(),
      bytes: safeInteger(raw.bytes, `source_refs[${index}].bytes`, { nullable: true }),
    };
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
}

function normalizeProviderTokens(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) fail('INVALID_COUNTER', 'provider_tokens must be an object or null');
  const allowed = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'reasoning_output_tokens'];
  const out = {};
  for (const key of allowed) if (value[key] !== undefined) out[key] = safeInteger(value[key], `provider_tokens.${key}`);
  return Object.keys(out).length ? out : null;
}

function normalizeCounts(value, stage) {
  const raw = value === undefined || value === null ? {} : value;
  if (!object(raw)) fail('INVALID_COUNTER', 'counts must be an object');
  const out = {};
  for (const key of COUNT_KEYS) out[key] = raw[key] === undefined ? null : optionalNumber(raw[key], `counts.${key}`);
  if (stage === 'wait_poll' && out.polls === null) out.polls = 1;
  return out;
}

function normalizeQuality(value) {
  const raw = value === undefined || value === null ? {} : value;
  if (!object(raw)) fail('INVALID_COUNTER', 'quality must be an object');
  const out = {};
  for (const key of QUALITY_KEYS) if (raw[key] !== undefined) out[key] = safeInteger(raw[key], `quality.${key}`);
  return out;
}

function normalizeObservation(raw, now = new Date().toISOString()) {
  if (!object(raw)) fail('INVALID_OBSERVATION', 'overhead observation must be an object');
  rejectSensitive(raw);
  const stage = text(raw.stage, 'stage');
  if (!STAGES.has(stage)) fail('INVALID_OBSERVATION', `unsupported observation stage ${stage}`);
  const treatment = normalizeTreatment(raw.treatment === undefined ? raw.treatments : raw.treatment);
  const counts = normalizeCounts(raw.counts, stage);
  const evidence = raw.evidence === undefined ? 'none' : text(raw.evidence, 'evidence');
  if (!EVIDENCE.has(evidence)) fail('INVALID_OBSERVATION', `unsupported evidence kind ${evidence}`);
  if (counts.model_turns !== null && counts.model_turns > 0 && !['usage', 'transcript'].includes(evidence)) {
    fail('UNSUPPORTED_TURN_EVIDENCE', 'model turns require supported usage or transcript evidence');
  }
  const providerTokens = normalizeProviderTokens(raw.provider_tokens);
  const bytes = safeInteger(raw.bytes === undefined ? 0 : raw.bytes, 'bytes');
  const estimatedTokens = safeInteger(raw.estimated_tokens, 'estimated_tokens', { nullable: true });
  const estimatorVersion = raw.estimator_version === undefined
    ? (estimatedTokens === null ? null : ESTIMATOR_VERSION) : text(raw.estimator_version, 'estimator_version');
  const policyHash = raw.policy_hash === undefined || raw.policy_hash === null
    ? null : text(raw.policy_hash, 'policy_hash');
  if (policyHash !== null && !/^[a-f0-9]{64}$/i.test(policyHash)) fail('INVALID_OBSERVATION', 'policy_hash must be SHA-256 when present');
  const policyId = raw.policy_id === undefined || raw.policy_id === null ? null : text(raw.policy_id, 'policy_id');
  const policyVersion = raw.policy_version === undefined || raw.policy_version === null
    ? null : text(raw.policy_version, 'policy_version');
  const passKind = raw.pass_kind === undefined || raw.pass_kind === null
    ? null : text(raw.pass_kind, 'pass_kind');
  if (passKind !== null && !PASS_KINDS.has(passKind)) fail('INVALID_OBSERVATION', `unsupported pass_kind ${passKind}`);
  const passId = raw.pass_id === undefined || raw.pass_id === null
    ? (raw.sample_id === undefined || raw.sample_id === null ? null : text(raw.sample_id, 'sample_id'))
    : text(raw.pass_id, 'pass_id');
  const dimensions = {
    run_id: text(raw.run_id || raw.runId, 'run_id'),
    dispatch_id: raw.dispatch_id === undefined || raw.dispatch_id === null ? null : text(raw.dispatch_id, 'dispatch_id'),
    role: text(raw.role, 'role'),
    runtime: text(raw.runtime, 'runtime'),
    backend: raw.backend === undefined || raw.backend === null ? 'unknown' : text(raw.backend, 'backend'),
    policy_id: policyId,
    policy_version: policyVersion,
    policy_hash: policyHash,
    treatment,
    stage,
    source: raw.source === undefined || raw.source === null ? null : text(raw.source, 'source'),
    pass_id: passId,
    pass_kind: passKind,
    cost_category: raw.cost_category === undefined || raw.cost_category === null
      ? 'orchestration' : text(raw.cost_category, 'cost_category'),
    source_refs: normalizeSourceRefs(raw.source_refs),
    counts,
    bytes,
    estimated_tokens: estimatedTokens,
    estimator_version: estimatorVersion,
    provider_tokens: providerTokens,
    evidence,
    attribution_status: raw.attribution_status === undefined ? 'unknown' : text(raw.attribution_status, 'attribution_status'),
    quality: normalizeQuality(raw.quality),
    completed_at: raw.completed_at === undefined ? null : text(raw.completed_at, 'completed_at', { nullable: true }),
  };
  const observationId = raw.observation_id === undefined || raw.observation_id === null
    ? digest({ ...dimensions, sequence: raw.poll_sequence === undefined ? null : safeInteger(raw.poll_sequence, 'poll_sequence') }).slice(0, 48)
    : text(raw.observation_id, 'observation_id');
  const revision = raw.revision === undefined ? 1 : safeInteger(raw.revision, 'revision');
  return {
    schema: 'shipyard.orchestration-overhead.v1', version: SCHEMA_VERSION,
    observation_id: observationId, revision: Math.max(1, revision),
    observed_at: raw.observed_at === undefined ? now : text(raw.observed_at, 'observed_at'),
    ...dimensions, treatment_id: treatmentId(treatment),
  };
}

function readStream(graphDir) {
  const file = path.join(path.resolve(graphDir), STREAM_NAME);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { rows: [], warnings: [], file };
    throw error;
  }
  const rows = [], warnings = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!object(value)) throw new Error('row is not an object');
      rows.push(value);
    } catch (error) { warnings.push(`${STREAM_NAME}:${index + 1}: malformed JSON (${error.message})`); }
  }
  return { rows, warnings, file };
}

function latestRows(rows) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.observation_id !== 'string') continue;
    const prior = latest.get(row.observation_id);
    const revision = Number.isSafeInteger(row.revision) ? row.revision : 1;
    const previousRevision = prior && Number.isSafeInteger(prior.revision) ? prior.revision : 1;
    if (!prior || revision >= previousRevision) latest.set(row.observation_id, row);
  }
  return [...latest.values()];
}

function sameObservation(a, b) {
  const clean = (value) => { const copy = clone(value); delete copy.revision; delete copy.observed_at; return copy; };
  return stable(clean(a)) === stable(clean(b));
}

function identityShape(row) {
  return stable({ run_id: row.run_id, dispatch_id: row.dispatch_id, role: row.role,
    runtime: row.runtime, policy_id: row.policy_id, policy_version: row.policy_version,
    policy_hash: row.policy_hash, treatment_id: row.treatment_id });
}

function recordBatch(graphDir, raw) {
  const input = Array.isArray(raw) ? raw : [raw];
  if (!input.length) return { recorded: [], skipped: 0 };
  const graph = path.resolve(graphDir);
  fs.mkdirSync(graph, { recursive: true });
  const normalized = input.map((value) => normalizeObservation(value));
  const ids = new Set();
  for (const row of normalized) {
    if (ids.has(row.observation_id)) fail('DUPLICATE_OBSERVATION', `duplicate observation_id ${row.observation_id} in one batch`);
    ids.add(row.observation_id);
  }
  return withLock(path.join(graph, '.locks'), 'orchestration-overhead', () => {
    const current = readStream(graph).rows;
    const latest = new Map(latestRows(current).map((row) => [row.observation_id, row]));
    const toAppend = [];
    for (const row of normalized) {
      const prior = latest.get(row.observation_id);
      if (prior && identityShape(prior) !== identityShape(row)) {
        fail('OBSERVATION_ID_CONFLICT', `observation_id ${row.observation_id} is bound to different identity dimensions`);
      }
      if (prior && sameObservation(prior, row)) continue;
      const previousRevision = prior && Number.isSafeInteger(prior.revision) ? prior.revision : 0;
      const next = { ...row, revision: Math.max(previousRevision + 1, row.revision || 1) };
      toAppend.push(next); latest.set(next.observation_id, next);
    }
    if (toAppend.length) fs.appendFileSync(path.join(graph, STREAM_NAME), toAppend.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return { recorded: toAppend, skipped: normalized.length - toAppend.length,
      duplicate: toAppend.length === 0 && normalized.length === 1 };
  }, { label: 'orchestration-overhead' });
}

function recordMeasurement(recorder, value) {
  if (recorder === undefined || recorder === null) return { recorded: false, skipped: 'no-recorder' };
  if (typeof recorder === 'function') return recorder(value);
  if (!recorder || typeof recorder.record !== 'function') fail('RECORDER_INVALID', 'overheadRecorder must expose record(observation)');
  return recorder.record(value);
}

function recordHandoffCost(recorder, value = {}) {
  if (!object(value)) fail('INVALID_OBSERVATION', 'handoff cost must be an object');
  if (!HANDOFF_COST_STAGES.has(value.stage)) {
    fail('INVALID_OBSERVATION', `handoff cost stage must be one of ${[...HANDOFF_COST_STAGES].join(', ')}`);
  }
  return recordMeasurement(recorder, {
    ...value,
    evidence: value.evidence === undefined ? 'controller' : value.evidence,
    source: value.source === undefined ? 'session-handoff' : value.source,
  });
}

function recordModelEvidence(recorder, value = {}) {
  if (!object(value)) fail('INVALID_OBSERVATION', 'model evidence must be an object');
  const stage = value.stage || 'model_turn';
  if (!['model_turn', 'tool_call'].includes(stage)) fail('INVALID_OBSERVATION', 'model evidence stage must be model_turn or tool_call');
  const evidence = value.evidence;
  if (!['usage', 'transcript'].includes(evidence)) {
    fail('UNSUPPORTED_TURN_EVIDENCE', 'model evidence requires usage or transcript evidence');
  }
  const countKey = stage === 'tool_call' ? 'tool_calls' : 'model_turns';
  const count = value.count === undefined ? 1 : value.count;
  const counts = { polls: null, model_turns: null, tool_calls: null, ...(value.counts || {}) };
  counts[countKey] = count;
  return recordMeasurement(recorder, { ...value, stage, evidence, counts });
}

function metricStats(values) {
  const usable = values.filter((value) => Number.isSafeInteger(value) && value >= 0).sort((a, b) => a - b);
  if (!usable.length) return { value: null, count: 0, sum: null, median: null, p90: null };
  const percentile = (fraction) => usable[Math.min(usable.length - 1, Math.ceil(usable.length * fraction) - 1)];
  const sum = usable.reduce((total, value) => total + value, 0);
  return { value: sum, count: usable.length, sum, median: percentile(0.5), p90: percentile(0.9) };
}

function supportedEvidence(row) { return row && ['usage', 'transcript'].includes(row.evidence); }

function joinAttribution(rows, attributions) {
  const list = Array.isArray(attributions) ? attributions : [];
  return rows.map((row) => {
    if (!row.dispatch_id) return { ...row, attribution_status: row.attribution_status || 'unknown' };
    const matches = list.filter((candidate) => candidate && candidate.dispatch_id === row.dispatch_id
      && (!candidate.runtime || candidate.runtime === row.runtime));
    return { ...row, attribution_status: matches.length === 1 ? 'observed'
      : matches.length > 1 ? 'ambiguous' : (row.attribution_status || 'missing') };
  });
}

function qualityTotals(rows, supplied) {
  const out = {};
  for (const key of QUALITY_KEYS) {
    const values = rows.map((row) => row.quality && row.quality[key]).filter((value) => Number.isSafeInteger(value));
    out[key] = (supplied && Number.isSafeInteger(supplied[key]) ? supplied[key] : 0)
      + values.reduce((sum, value) => sum + value, 0);
  }
  return out;
}

function metricSet(rows) {
  const sumStage = (stage, field) => metricStats(rows.filter((row) => row.stage === stage).map((row) => row[field]));
  const count = (field, supportedOnly = false) => metricStats(rows
    .filter((row) => !supportedOnly || supportedEvidence(row))
    .map((row) => row.counts && row.counts[field]));
  const modelTurns = count('model_turns', true);
  const toolCalls = count('tool_calls', true);
  if (!rows.some((row) => supportedEvidence(row) && row.counts && row.counts.model_turns !== null)) {
    Object.assign(modelTurns, { value: null, sum: null, median: null, p90: null });
  }
  if (!rows.some((row) => supportedEvidence(row) && row.counts && row.counts.tool_calls !== null)) {
    Object.assign(toolCalls, { value: null, sum: null, median: null, p90: null });
  }
  const providerRows = rows.filter((row) => supportedEvidence(row) && row.provider_tokens && object(row.provider_tokens));
  const providerTokens = metricStats(providerRows.map((row) => Object.values(row.provider_tokens).reduce((sum, value) => sum + value, 0)));
  return {
    startup_bytes: sumStage('startup', 'bytes'),
    parent_reingestion_bytes: sumStage('parent_reingestion', 'bytes'),
    startup_estimated_tokens: metricStats(rows.filter((row) => row.stage === 'startup').map((row) => row.estimated_tokens)),
    parent_reingestion_estimated_tokens: metricStats(rows.filter((row) => row.stage === 'parent_reingestion').map((row) => row.estimated_tokens)),
    checkpoint_collection_bytes: sumStage('checkpoint_collection', 'bytes'),
    checkpoint_collection_estimated_tokens: sumStage('checkpoint_collection', 'estimated_tokens'),
    successor_startup_bytes: sumStage('successor_startup', 'bytes'),
    successor_startup_estimated_tokens: sumStage('successor_startup', 'estimated_tokens'),
    cache_warmup_bytes: sumStage('cache_warmup', 'bytes'),
    cache_warmup_estimated_tokens: sumStage('cache_warmup', 'estimated_tokens'),
    wait_polls: count('polls'), model_turns: modelTurns, tool_calls: toolCalls, provider_tokens: providerTokens,
  };
}

function report(input = {}, options = {}) {
  const opts = Array.isArray(input) ? options : input;
  let rows = Array.isArray(input) ? input : opts.rows;
  if (!rows && opts.graphDir) rows = readStream(opts.graphDir).rows;
  rows = joinAttribution(latestRows(rows || []), opts.attributions || opts.usageAttributions || opts.attributionRecords);
  const quality = qualityTotals(rows, opts.quality);
  const reasons = [], missing = [];
  const attributionRows = rows.filter((row) => supportedEvidence(row) && row.dispatch_id);
  const attributed = attributionRows.filter((row) => row.attribution_status === 'observed').length;
  const attributionCoverage = opts.attribution_coverage === undefined
    ? attributionRows.length ? attributed / attributionRows.length : null : opts.attribution_coverage;
  const usageRows = rows.filter((row) => supportedEvidence(row));
  const providerCoverage = usageRows.length === 0 ? 'unknown'
    : usageRows.every((row) => row.provider_tokens && object(row.provider_tokens)) ? 'observed'
      : usageRows.some((row) => row.provider_tokens && object(row.provider_tokens)) ? 'partial' : 'unknown';
  const metrics = metricSet(rows);
  if (metrics.model_turns.value === null) missing.push('supported transcript/usage evidence for model turns');
  if (metrics.tool_calls.value === null) missing.push('supported transcript evidence for tool calls');
  if (providerCoverage !== 'observed') missing.push('provider token observations');
  if (attributionCoverage === null || attributionCoverage < DEFAULT_ATTRIBUTION_TARGET) missing.push('dispatch attribution coverage >= 95%');
  if (opts.finalized_output_coverage !== 'observed') missing.push('finalized output coverage');
  if (opts.experiment_boundary !== true) missing.push('declared experiment boundary');
  const treatmentIds = new Set(rows.map((row) => row.treatment_id));
  if (treatmentIds.size < 2) missing.push('comparable baseline and treatment arms');
  const completed = Number.isSafeInteger(opts.completed_tickets) ? opts.completed_tickets : quality.completed;
  const minCompleted = Number.isSafeInteger(opts.min_completed) ? opts.min_completed : DEFAULT_MIN_COMPLETED;
  if (completed < minCompleted) missing.push(`completed-ticket cohort (${completed}/${minCompleted})`);
  if (opts.defect_window_days === undefined || opts.defect_window_days < 7) missing.push('seven-day defect window');
  if (quality.false_green || quality.invalid_carry || quality.skipped_gate || quality.recovery_loss
      || quality.duplicate_dispatch || quality.orphaned_work || quality.lost_constraints) {
    const failed = ['false_green', 'invalid_carry', 'skipped_gate', 'recovery_loss',
      'duplicate_dispatch', 'orphaned_work', 'lost_constraints'].filter((key) => quality[key]);
    reasons.push(`quality/recovery failure (${failed.join(', ')}) requires rollback`);
  }
  let verdict = reasons.length ? 'rollback' : 'inconclusive';
  if (!reasons.length && !missing.length) verdict = opts.verdict === 'continue_trial' ? 'continue_trial' : 'promote';
  if (verdict === 'inconclusive') reasons.push('evidence is incomplete; no savings or quota claim is permitted');
  const treatments = [...new Map(rows.map((row) => [row.treatment_id, row.treatment])).values()];
  const byTreatment = [...new Map(rows.map((row) => [row.treatment_id, row.treatment])).entries()]
    .map(([id, treatment]) => ({ id, treatment, metrics: metricSet(rows.filter((row) => row.treatment_id === id)) }));
  const byCategory = [...new Set(rows.map((row) => row.cost_category || 'orchestration'))]
    .sort().map((category) => ({ category, metrics: metricSet(rows.filter((row) => (row.cost_category || 'orchestration') === category)) }));
  return {
    schema: REPORT_SCHEMA, version: SCHEMA_VERSION, experiment_id: opts.experiment_id || null,
    rows: rows.length, treatments, by_treatment: byTreatment, by_category: byCategory, metrics,
    coverage: { provider_tokens: providerCoverage, attribution: attributionCoverage,
      attributed_rows: attributed, dispatch_rows: attributionRows.length,
      finalized_output: opts.finalized_output_coverage === undefined ? 'unknown' : opts.finalized_output_coverage },
    quality, missing_coverage: missing, verdict, verdict_reasons: reasons,
  };
}

function createRecorder(graphDir) {
  const graph = path.resolve(graphDir);
  return Object.freeze({
    graphDir: graph,
    record: (value) => recordBatch(graph, value),
    recordBatch: (value) => recordBatch(graph, value),
    read: () => readStream(graph),
    latest: () => latestRows(readStream(graph).rows),
    report: (options = {}) => report({ ...options, graphDir: graph, rows: options.rows || latestRows(readStream(graph).rows) }),
  });
}

function cliValue(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'report';
  const graph = path.resolve(cliValue(argv, '--graph', process.env.SHIPYARD_GRAPH_DIR
    || path.join(process.cwd(), '.planning', 'graph')));
  const recorder = createRecorder(graph);
  if (command === 'record') {
    let value;
    try { value = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch (error) { fail('INVALID_INPUT', `stdin is not valid JSON: ${error.message}`); }
    process.stdout.write(JSON.stringify(recorder.record(value), null, 2) + '\n');
    return 0;
  }
  if (command === 'list') {
    process.stdout.write(JSON.stringify(recorder.latest(), null, 2) + '\n');
    return 0;
  }
  if (command === 'report') {
    const completed = cliValue(argv, '--completed-tickets');
    const attribution = cliValue(argv, '--attribution-coverage');
    const output = recorder.report({
      experiment_id: cliValue(argv, '--experiment-id'),
      ...(completed === null ? {} : { completed_tickets: Number(completed) }),
      ...(attribution === null ? {} : { attribution_coverage: Number(attribution) }),
      ...(argv.includes('--experiment-boundary') ? { experiment_boundary: true } : {}),
      ...(argv.includes('--finalized-output') ? { finalized_output_coverage: 'observed' } : {}),
    });
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output.verdict === 'rollback' ? 3 : 0;
  }
  fail('INVALID_INPUT', 'usage: orchestration-overhead.cjs <record|list|report> [--graph PATH]');
}

module.exports = Object.freeze({
  SCHEMA_VERSION, STREAM_NAME, REPORT_SCHEMA, ESTIMATOR_VERSION, STAGES,
  HANDOFF_COST_STAGES, PASS_KINDS,
  TREATMENT_KEYS, TREATMENT_VALUES, OverheadError, normalizeTreatment, treatmentId,
  normalizeObservation, recordBatch, recordMeasurement, recordHandoffCost, recordModelEvidence,
  readStream, latestRows, report, createRecorder,
});

if (require.main === module) {
  try { process.exitCode = cli(); }
  catch (error) {
    process.stderr.write(`orchestration-overhead: ${error.message}\n`);
    process.exitCode = error.code === 'INVALID_INPUT' ? 2 : 1;
  }
}
