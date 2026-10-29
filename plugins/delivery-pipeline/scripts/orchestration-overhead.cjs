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
const ESTIMATOR_VERSION = 'utf8-bytes-div4-v1';
const TREATMENT_KEYS = Object.freeze(['wait_events', 'bounded_context']);
const TREATMENT_VALUES = Object.freeze({
  wait_events: new Set(['baseline', 'opt-06']),
  bounded_context: new Set(['baseline', 'opt-07']),
});
const STAGES = new Set([
  'startup', 'ordinary_input', 'parent_reingestion', 'checkpoint_collection',
  'successor_startup', 'successor_reread', 'cache_warmup', 'wait_poll', 'model_turn', 'tool_call',
]);
const HANDOFF_COST_STAGES = new Set(['checkpoint_collection', 'successor_startup', 'cache_warmup', 'successor_reread']);
const LIFECYCLE_CLASS_VALUES = Object.freeze(['resume', 'fork', 'compaction', 'fresh_start']);
const PASS_KINDS = new Set(['ordinary', 'advisor']);
const EVIDENCE = new Set(['usage', 'transcript', 'wait-event', 'controller', 'none']);
const COUNT_KEYS = Object.freeze(['polls', 'model_turns', 'tool_calls', 'retries']);
const ACTORS = new Set(['parent', 'child', 'host']);
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
  const actor = raw.actor === undefined || raw.actor === null ? null : text(raw.actor, 'actor');
  if (actor !== null && !ACTORS.has(actor)) fail('INVALID_OBSERVATION', `unsupported actor ${actor}`);
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
  const instructionDigest = raw.instruction_digest === undefined || raw.instruction_digest === null
    ? null : text(raw.instruction_digest, 'instruction_digest');
  if (instructionDigest !== null && !/^[a-f0-9]{64}$/i.test(instructionDigest)) fail('INVALID_OBSERVATION', 'instruction_digest must be SHA-256 when present');
  const lifecycleClass = raw.lifecycle_class === undefined || raw.lifecycle_class === null
    ? null : text(raw.lifecycle_class, 'lifecycle_class');
  if (lifecycleClass !== null && !LIFECYCLE_CLASS_VALUES.includes(lifecycleClass)) fail('INVALID_OBSERVATION', `unsupported lifecycle_class ${lifecycleClass}`);
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
    model: raw.model === undefined || raw.model === null ? null : text(raw.model, 'model'),
    effort: raw.effort === undefined || raw.effort === null ? null : text(raw.effort, 'effort'),
    actor,
    ...(raw.requested_model !== undefined && raw.requested_model !== null
      ? { requested_model: text(raw.requested_model, 'requested_model') } : {}),
    ...(raw.requested_effort !== undefined && raw.requested_effort !== null
      ? { requested_effort: text(raw.requested_effort, 'requested_effort') } : {}),
    ...(raw.observed_model !== undefined && raw.observed_model !== null
      ? { observed_model: text(raw.observed_model, 'observed_model') } : {}),
    ...(raw.observed_effort !== undefined && raw.observed_effort !== null
      ? { observed_effort: text(raw.observed_effort, 'observed_effort') } : {}),
    account_scope: raw.account_scope === undefined || raw.account_scope === null
      ? null : text(raw.account_scope, 'account_scope'),
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
    // @invariant: omit absent keys so old rows keep their observation_id digest
    ...(instructionDigest !== null ? { instruction_digest: instructionDigest } : {}),
    ...(lifecycleClass !== null ? { lifecycle_class: lifecycleClass } : {}),
  };
  const identityDimensions = { ...dimensions };
  if (actor === null) delete identityDimensions.actor;
  const observationId = raw.observation_id === undefined || raw.observation_id === null
    ? digest({ ...identityDimensions, sequence: raw.poll_sequence === undefined ? null : safeInteger(raw.poll_sequence, 'poll_sequence') }).slice(0, 48)
    : text(raw.observation_id, 'observation_id');
  const revision = raw.revision === undefined ? 1 : safeInteger(raw.revision, 'revision');
  return {
    schema: 'shipyard.orchestration-overhead.v1', version: SCHEMA_VERSION,
    observation_id: observationId, revision: Math.max(1, revision),
    observed_at: raw.observed_at === undefined ? now : text(raw.observed_at, 'observed_at'),
    ...dimensions, treatment_id: treatmentId(treatment),
  };
}

function recorderPaths(graphDir) {
  const resolved = path.resolve(graphDir);
  const parts = resolved.split(path.sep);
  const planning = parts.indexOf('.planning');
  let anchor = planning === -1 ? path.dirname(resolved) : parts.slice(0, planning).join(path.sep) || path.sep;
  while (!fs.existsSync(anchor)) {
    try { fs.lstatSync(anchor); fail('RECORDER_ALIAS', 'recorder anchor is not physically trusted'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    anchor = path.dirname(anchor);
  }
  const relative = path.relative(anchor, resolved);
  const canonical = fs.realpathSync(anchor);
  if (!fs.statSync(canonical).isDirectory()) fail('RECORDER_ALIAS', 'recorder anchor is not a directory');
  return { anchor: canonical, graph: path.join(canonical, relative) };
}

function validateRecorderPaths(paths) {
  const { anchor, graph } = paths;
  const lock = path.join(graph, '.locks', 'orchestration-overhead.lock');
  let directory = anchor;
  for (const component of path.relative(anchor, lock).split(path.sep)) {
    directory = path.join(directory, component);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RECORDER_ALIAS', 'recorder directory is not physically trusted');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of [path.join(graph, STREAM_NAME), path.join(graph, '.locks', 'orchestration-overhead.lock', 'owner.json')]) {
    try {
      if (!fs.lstatSync(file).isFile()) fail('RECORDER_ALIAS', 'recorder leaf is not physically trusted');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function streamIO(file, append) {
  const flags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    | (append === undefined ? fs.constants.O_RDONLY : fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    const entry = fs.lstatSync(file);
    if (!stat.isFile() || !entry.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.nlink !== 1)
      fail('RECORDER_ALIAS', 'recorder stream must be the opened regular file');
    if (append !== undefined) return fs.writeFileSync(fd, append);
    const raw = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== after[key])
        || current.dev !== stat.dev || current.ino !== stat.ino)
      fail('RECORDER_CHANGED', 'recorder stream changed during read');
    return raw;
  } finally { fs.closeSync(fd); }
}

function readStream(graphDir) {
  return readRecorderStream(recorderPaths(graphDir));
}

function readRecorderStream(paths) {
  const file = path.join(paths.graph, STREAM_NAME);
  let raw;
  try { validateRecorderPaths(paths); raw = streamIO(file); }
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
  const clean = (value) => {
    const copy = clone(value);
    delete copy.revision; delete copy.observed_at;
    if (!Object.hasOwn(copy, 'actor')) copy.actor = null;
    return copy;
  };
  return stable(clean(a)) === stable(clean(b));
}

function identityShape(row) {
  return stable({ run_id: row.run_id, dispatch_id: row.dispatch_id, role: row.role,
    runtime: row.runtime, actor: row.actor || null, policy_id: row.policy_id, policy_version: row.policy_version,
    policy_hash: row.policy_hash, treatment_id: row.treatment_id });
}

function recordBatch(graphDir, raw) {
  const input = Array.isArray(raw) ? raw : [raw];
  if (!input.length) return { recorded: [], skipped: 0 };
  const paths = recorderPaths(graphDir);
  const { graph } = paths;
  validateRecorderPaths(paths);
  fs.mkdirSync(graph, { recursive: true, mode: 0o700 });
  validateRecorderPaths(paths);
  const normalized = input.map((value) => normalizeObservation(value));
  const ids = new Set();
  for (const row of normalized) {
    if (ids.has(row.observation_id)) fail('DUPLICATE_OBSERVATION', `duplicate observation_id ${row.observation_id} in one batch`);
    ids.add(row.observation_id);
  }
  return withLock(path.join(graph, '.locks'), 'orchestration-overhead', () => {
    const current = readRecorderStream(paths).rows;
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
    validateRecorderPaths(paths);
    if (toAppend.length) streamIO(path.join(graph, STREAM_NAME), toAppend.map((row) => JSON.stringify(row)).join('\n') + '\n');
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

function sumField(rows, getter) {
  if (!rows.length) return null;
  return rows.every((row) => Number.isSafeInteger(getter(row)))
    ? rows.reduce((total, row) => total + getter(row), 0) : null;
}

function handoffCostSummary(rows) {
  const list = latestRows(Array.isArray(rows) ? rows : []);
  const stages = [...HANDOFF_COST_STAGES];
  const byLifecycleClass = LIFECYCLE_CLASS_VALUES.map((lifecycleClass) => {
    const classRows = list.filter((row) => row.lifecycle_class === lifecycleClass);
    const totals = {};
    const missingStages = [];
    for (const stage of stages) {
      const stageRows = classRows.filter((row) => row.stage === stage);
      if (!stageRows.length) { missingStages.push(stage); continue; }
      totals[stage] = {
        bytes: sumField(stageRows, (row) => row.bytes),
        estimated_tokens: sumField(stageRows, (row) => row.estimated_tokens),
      };
    }
    return { lifecycle_class: lifecycleClass, stages: totals, missing_stages: missingStages, rows: classRows.length };
  });
  const installed = list.some((row) => row.lifecycle_class && HANDOFF_COST_STAGES.has(row.stage));
  return {
    schema: 'shipyard.handoff-cost-summary.v1', version: SCHEMA_VERSION,
    by_lifecycle_class: byLifecycleClass,
    status: { implemented: true, installed, behaviorally_verified: false, efficiency_measured: false },
    verdict: 'inconclusive',
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
  });
}

function cliValue(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const graph = path.resolve(cliValue(argv, '--graph', process.env.SHIPYARD_GRAPH_DIR
    || require('./graph-dir.cjs').resolveGraphDir().dir));
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
  fail('INVALID_INPUT', 'usage: orchestration-overhead.cjs <record|list> [--graph PATH]');
}

module.exports = Object.freeze({
  SCHEMA_VERSION, STREAM_NAME, ESTIMATOR_VERSION, STAGES,
  HANDOFF_COST_STAGES, LIFECYCLE_CLASS_VALUES, PASS_KINDS,
  TREATMENT_KEYS, TREATMENT_VALUES, OverheadError, normalizeTreatment, treatmentId,
  normalizeObservation, recordBatch, recordMeasurement, recordHandoffCost,
  handoffCostSummary, readStream, latestRows, createRecorder,
});

if (require.main === module) {
  try { process.exitCode = cli(); }
  catch (error) {
    process.stderr.write(`orchestration-overhead: ${error.message}\n`);
    process.exitCode = error.code === 'INVALID_INPUT' ? 2 : 1;
  }
}
