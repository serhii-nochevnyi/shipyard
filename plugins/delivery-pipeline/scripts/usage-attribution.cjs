#!/usr/bin/env node
'use strict';

// Durable launch-to-transcript attribution for model efficiency reports.
//
// This file stores correlation facts, not prompts or token totals. The provider
// adapters own token accounting; this ledger answers which dispatch a supported
// transcript identity belongs to. It is deliberately append-only and revisioned
// so a session id learned after launch can be added without rewriting history.
//
//   usage-attribution.cjs record --stdin [--graph <dir>]
//   usage-attribution.cjs list [--json] [--graph <dir>]
//
// The record command accepts one object or an array. A record needs a dispatch id
// and at least one transcript identity (`session_id`, `request_id` or
// `message_id`). Values are metadata only; prompt text and credentials are
// rejected as unknown fields.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');
const pipeline = require('./pipeline-config.cjs');
const policy = require('./model-policy.cjs');

const LEDGER_NAME = 'usage-attribution.jsonl';
const MAX_TEXT = 1000;
const MAX_PROVENANCE_BYTES = 16 * 1024;
const RUNTIME_PROVIDER = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const BACKENDS = new Set(['agent', 'workflow', 'inline', 'codex-agent']);
const KINDS = new Set(['ordinary', 'advisor']);
const COMPLETION_STATES = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const EFFORT_STATES = new Set(['unknown', 'unsupported', ...(pipeline.EFFORTS || [])]);
const FIELDS = new Set([
  'schema_version', 'event', 'observation_id', 'revision', 'observed_at',
  'project_id', 'run_id', 'dispatch_id', 'ticket', 'role', 'task_level',
  'runtime', 'provider', 'backend', 'kind', 'source', 'session_id',
  'request_id', 'message_id', 'pass_id', 'model', 'effort', 'effort_applied',
  'observed_model', 'observed_effort', 'completion_status',
  // ADR-014 resolution/application provenance. These are deliberately stored
  // as facts supplied by the boundary; this ledger never upgrades a legacy
  // observation or manufactures a receipt.
  'policy_id', 'policy_version', 'policy_hash', 'logical_model', 'logical_rung',
  'rung', 'rung_index', 'route', 'mechanism', 'agent_file', 'agent_file_digest', 'launch_id',
  'launch_arguments', 'signals', 'signals_fired', 'requested_model',
  'requested_effort', 'applied_model', 'applied_effort', 'receipt',
  'application_receipt', 'resolution',
]);

const POLICY_ID = policy.POLICY?.id || 'ADR-014';
const POLICY_VERSION = policy.POLICY_VERSION;
const POLICY_HASH = policy.POLICY_HASH;
const UNKNOWN_EVIDENCE = new Set(['unknown', 'unsupported']);
// Reconciliation facts are an in-process optimization only. A JSON round trip
// deliberately drops this capability, so persisted rows must be reconciled
// again instead of being trusted because they happen to contain the two
// derived dimension objects below.
const RECONCILED_FACTS = new WeakSet();

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const present = (value) => value !== undefined && value !== null && value !== '';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const RECEIPT_IDENTITIES = ['policy_hash', 'dispatch_id', 'launch_id'];

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function freezeFact(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeFact(child, seen);
  return Object.freeze(value);
}

function markReconciledFact(value) {
  freezeFact(value);
  RECONCILED_FACTS.add(value);
  return value;
}

function isReconciledFact(value) {
  return object(value) && RECONCILED_FACTS.has(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function textIssue(value, field, { whitespace = false } = {}) {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (!value.trim()) return `${field} must not be blank`;
  if (value.length > MAX_TEXT) return `${field} is longer than ${MAX_TEXT} characters`;
  if (/[\x00-\x1f\x7f]/.test(value)) return `${field} contains a control character`;
  if (whitespace && /\s/.test(value)) return `${field} contains whitespace`;
  return null;
}

function provenanceIssue(value, field, allowed, { arrays = {} } = {}) {
  if (!object(value)) return `${field} must be an object`;
  let encoded;
  try { encoded = Buffer.byteLength(stableStringify(value), 'utf8'); }
  catch { return `${field} must be JSON-serializable`; }
  if (encoded > MAX_PROVENANCE_BYTES) return `${field} exceeds ${MAX_PROVENANCE_BYTES} bytes`;
  for (const [key, child] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) return `${field}.${key} is not supported`;
    const type = allowed[key];
    if (type === 'text' || type === 'nullable_text') {
      if (type === 'nullable_text' && child === null) continue;
      const issue = textIssue(child, `${field}.${key}`);
      if (issue) return issue;
    } else if (type === 'integer') {
      if (!Number.isSafeInteger(child) || child < 0) return `${field}.${key} must be a non-negative safe integer`;
    } else if (type === 'boolean') {
      if (typeof child !== 'boolean') return `${field}.${key} must be boolean`;
    } else if (type === 'scalar' || type === 'scalar_or_receipt') {
      if (type === 'scalar_or_receipt' && object(child)) {
        const issue = provenanceIssue(child, `${field}.${key}`, RECEIPT_FIELDS);
        if (issue) return issue;
        continue;
      }
      if (typeof child === 'string') {
        const issue = textIssue(child, `${field}.${key}`);
        if (issue) return issue;
      } else if (typeof child !== 'boolean' && (!Number.isSafeInteger(child) || child < 0)) {
        return `${field}.${key} must be a bounded scalar`;
      }
    } else if (type === 'object' || type === 'nullable_object') {
      if (type === 'nullable_object' && child === null) continue;
      if (!object(child)) return `${field}.${key} must be an object`;
    } else if (type === 'array') {
      if (!Array.isArray(child)) return `${field}.${key} must be an array`;
      const itemType = arrays[key] || 'text';
      if (child.some((item) => itemType === 'text'
        ? textIssue(item, `${field}.${key}`) !== null
        : !object(item))) return `${field}.${key} has an invalid item`;
    }
  }
  return null;
}

const SIGNAL_FIELDS = Object.freeze({
  type: 'text', complexity: 'text', risk: 'text', critical: 'boolean', checkpoint: 'boolean',
  contested: 'boolean', inputTokens: 'integer', signatureState: 'text', priorApplied: 'object',
});
const LAUNCH_ARGUMENT_FIELDS = Object.freeze({ model: 'text', effort: 'text', reasoning_effort: 'text' });
const PROOF_FIELDS = Object.freeze({ status: 'text', boundary: 'text', policy_hash: 'text', dispatch_id: 'text', launch_id: 'text' });
const RECEIPT_FIELDS = Object.freeze({
  receipt_type: 'text', runtime: 'text', role: 'text', dispatch_id: 'text', launch_id: 'text',
  requested_model: 'text', requested_effort: 'text', applied_model: 'text', applied_effort: 'text',
  observed_model: 'text', observed_effort: 'text', policy_id: 'text', policy_version: 'text',
  policy_hash: 'text', backend: 'text', mechanism: 'text', agent_file: 'text', agent_file_digest: 'text',
  logical_rung: 'text', rung: 'text', compliance: 'text', compliance_proof: 'object',
  launch_arguments: 'nullable_object', signals: 'object', observation_unavailable: 'boolean',
});
const RESOLUTION_FIELDS = Object.freeze({
  policy_version: 'text', policy_hash: 'text', runtime: 'text', role: 'text', task_level: 'text',
  model_key: 'text',
  logical_model: 'text', logical_rung: 'text', rung: 'text', rung_index: 'integer', model: 'text',
  effort: 'text', requested_model: 'text', requested_effort: 'text', route: 'text', backend: 'text',
  mechanism: 'text', signals_fired: 'array', signals: 'object', agent_file: 'nullable_text',
  agent_file_digest: 'text', launch_arguments: 'nullable_object', dispatch_id: 'text',
  signal_reasons: 'array', selected_signals: 'array', prior_applied: 'object',
});
const SIGNAL_REASON_FIELDS = Object.freeze({
  signal: 'text', source: 'text', value: 'scalar_or_receipt', applies: 'boolean', rung: 'nullable_text', reason: 'text',
});
const SELECTED_SIGNAL_FIELDS = Object.freeze({ signal: 'text', rung: 'text', reason: 'text' });
const PRIOR_APPLIED_FIELDS = Object.freeze({
  dispatch_id: 'text', model: 'text', effort: 'text',
});

// `priorApplied` is a receipt, not an opaque signal payload. A repair receipt
// may itself retain the predecessor's signals, so validate the complete shape
// at every level before the append-only ledger accepts it.
function validateSignalsProvenance(value, field) {
  const issue = provenanceIssue(value, field, SIGNAL_FIELDS);
  if (issue) fail(issue);
  if (value.priorApplied !== undefined) {
    validateReceiptProvenance(value.priorApplied, `${field}.priorApplied`);
  }
}

function validateReceiptProvenance(value, field) {
  const issue = provenanceIssue(value, field, RECEIPT_FIELDS);
  if (issue) fail(issue);
  if (value.compliance_proof !== undefined) {
    const proofIssue = provenanceIssue(value.compliance_proof, `${field}.compliance_proof`, PROOF_FIELDS);
    if (proofIssue) fail(proofIssue);
  }
  if (value.launch_arguments !== undefined && value.launch_arguments !== null) {
    const argsIssue = provenanceIssue(value.launch_arguments, `${field}.launch_arguments`, LAUNCH_ARGUMENT_FIELDS);
    if (argsIssue) fail(argsIssue);
  }
  if (value.signals !== undefined) validateSignalsProvenance(value.signals, `${field}.signals`);
}

function validateProvenance(record) {
  const schemas = [
    ['signals', SIGNAL_FIELDS],
    ['launch_arguments', LAUNCH_ARGUMENT_FIELDS],
    ['receipt', RECEIPT_FIELDS],
    ['application_receipt', RECEIPT_FIELDS],
    ['resolution', RESOLUTION_FIELDS, { arrays: { signals_fired: 'text', signal_reasons: 'object', selected_signals: 'object' } }],
  ];
  for (const [field, schema, options] of schemas) {
    if (record[field] === undefined) continue;
    // Static Codex selection uses an agent file and records no launch arguments.
    // Reconciliation checks whether null is valid for the selected mechanism.
    if (field === 'launch_arguments' && record[field] === null) continue;
    const issue = provenanceIssue(record[field], field, schema, options);
    if (issue) fail(issue);
    const nested = record[field];
    if (field === 'signals') validateSignalsProvenance(nested, field);
    if (field === 'receipt' || field === 'application_receipt') validateReceiptProvenance(nested, field);
    if (field === 'resolution') {
      if (nested.signals !== undefined) validateSignalsProvenance(nested.signals, `${field}.signals`);
      if (nested.launch_arguments !== undefined && nested.launch_arguments !== null) {
        const nestedIssue = provenanceIssue(nested.launch_arguments, `${field}.launch_arguments`, LAUNCH_ARGUMENT_FIELDS);
        if (nestedIssue) fail(nestedIssue);
      }
      if (nested.prior_applied !== undefined) {
        const priorIssue = provenanceIssue(nested.prior_applied, field + '.prior_applied', PRIOR_APPLIED_FIELDS);
        if (priorIssue) fail(priorIssue);
      }
      for (const [nestedField, schemaForItem] of [
        ['signal_reasons', SIGNAL_REASON_FIELDS], ['selected_signals', SELECTED_SIGNAL_FIELDS],
      ]) {
        if (nested[nestedField] === undefined) continue;
        nested[nestedField].forEach((item, index) => {
          const nestedIssue = provenanceIssue(item, `${field}.${nestedField}[${index}]`, schemaForItem);
          if (nestedIssue) fail(nestedIssue);
          if (nestedField === 'signal_reasons' && object(item.value)) {
            validateReceiptProvenance(item.value, `${field}.${nestedField}[${index}].value`);
          }
        });
      }
    }
  }
}

function graphFromArgs(argv) {
  const args = [...argv];
  const at = args.indexOf('--graph');
  if (at !== -1) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`--graph needs a directory value (got ${value === undefined ? 'nothing' : `the flag "${value}"`})`);
    }
    args.splice(at, 2);
    return { args, dir: path.resolve(value), explicit: true };
  }
  if (process.env.SHIPYARD_GRAPH_DIR) {
    return { args, dir: path.resolve(process.env.SHIPYARD_GRAPH_DIR), explicit: true };
  }
  return { args, dir: path.join(process.cwd(), '.planning', 'graph'), explicit: false };
}

function graphGuard(dir, explicit) {
  if (!fs.existsSync(path.join(dir, 'tickets.json'))) {
    fail(
      `no ticket graph at ${dir} — refusing to write an attribution ledger nobody will read` +
      (explicit ? ' (the explicitly selected graph is invalid).' : '.\n') +
      (explicit ? '\n' : '') +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }
}

// Transcript paths can be supplied through a symlink (for example, a rotated
// log directory). Resolve existing paths the same way the report CLI resolves
// its explicit inputs, while retaining the absolute path for a file that does
// not exist yet. This gives the durable ledger one stable source identity.
function canonicalSource(value) {
  if (typeof value !== 'string') return value;
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function canonicalIdentity(raw) {
  return JSON.stringify([
    raw.dispatch_id,
    raw.runtime,
    raw.kind,
    raw.source || '',
    raw.session_id || '',
    raw.request_id || '',
    raw.message_id || '',
    raw.pass_id || '',
  ]);
}

function deriveObservationId(raw) {
  return `uattr-${crypto.createHash('sha256').update(canonicalIdentity(raw)).digest('hex').slice(0, 24)}`;
}

function normalizeRecord(raw, now = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('attribution record must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key));
  if (unknown.length) {
    fail(`attribution record has unsupported field(s): ${unknown.join(', ')} — prompt text and credentials are not telemetry`);
  }

  const runtime = raw.runtime;
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_PROVIDER, runtime)) {
    fail(`runtime must be one of ${Object.keys(RUNTIME_PROVIDER).join(', ')}`);
  }
  const provider = raw.provider === undefined ? RUNTIME_PROVIDER[runtime] : raw.provider;
  if (provider !== RUNTIME_PROVIDER[runtime]) {
    fail(`provider "${provider}" does not match runtime "${runtime}" — Claude stays Anthropic and Codex stays OpenAI`);
  }

  const record = {
    schema_version: 1,
    event: 'model_attribution',
    observed_at: raw.observed_at === undefined ? now : raw.observed_at,
    runtime,
    provider,
    kind: raw.kind === undefined ? 'ordinary' : raw.kind,
  };
  for (const key of [
    'project_id', 'run_id', 'dispatch_id', 'ticket', 'role', 'task_level',
    'backend', 'source', 'session_id', 'request_id', 'message_id', 'pass_id',
    'model', 'effort', 'effort_applied', 'observed_model', 'observed_effort',
    'completion_status',
  ]) {
    if (raw[key] !== undefined) record[key] = raw[key];
  }
  for (const key of [
    'policy_id', 'policy_version', 'policy_hash', 'logical_model', 'logical_rung',
    'rung', 'route', 'mechanism', 'agent_file', 'agent_file_digest', 'launch_id', 'requested_model',
    'applied_model',
  ]) {
    if (raw[key] !== undefined) record[key] = raw[key];
  }
  for (const key of ['requested_effort', 'applied_effort']) {
    if (raw[key] !== undefined) record[key] = raw[key];
  }
  for (const key of ['rung_index']) {
    if (raw[key] !== undefined) record[key] = raw[key];
  }
  for (const key of ['launch_arguments', 'signals', 'signals_fired', 'receipt', 'application_receipt', 'resolution']) {
    if (raw[key] !== undefined) record[key] = clone(raw[key]);
  }

  const date = typeof record.observed_at === 'string' ? Date.parse(record.observed_at) : NaN;
  if (!Number.isFinite(date)) {
    fail('observed_at must be a valid UTC timestamp');
  }
  if (record.kind !== 'ordinary' && record.kind !== 'advisor') {
    fail(`kind must be ordinary or advisor (got "${record.kind}")`);
  }
  for (const key of ['dispatch_id', 'project_id', 'run_id', 'ticket', 'role', 'source',
    'session_id', 'request_id', 'message_id', 'pass_id', 'model', 'observed_model']) {
    if (record[key] === undefined) continue;
    const issue = textIssue(record[key], key, { whitespace: key === 'dispatch_id' });
    if (issue) fail(issue);
  }
  for (const key of [
    'policy_id', 'policy_version', 'policy_hash', 'logical_model', 'logical_rung',
    'rung', 'route', 'mechanism', 'agent_file', 'agent_file_digest', 'launch_id', 'requested_model',
    'applied_model',
  ]) {
    if (record[key] === undefined) continue;
    const issue = textIssue(record[key], key, { whitespace: key === 'launch_id' });
    if (issue) fail(issue);
  }
  if (record.rung_index !== undefined
      && (!Number.isSafeInteger(record.rung_index) || record.rung_index < 0)) {
    fail('rung_index must be a non-negative safe integer');
  }
  validateProvenance(record);
  if (record.signals_fired !== undefined) {
    if (!Array.isArray(record.signals_fired)
        || record.signals_fired.some((value) => textIssue(value, 'signals_fired') !== null)) {
      fail('signals_fired must be an array of non-empty strings');
    }
  }
  if (record.dispatch_id === undefined) fail('dispatch_id is required — usage must be tied to one launch');
  if (!record.session_id && !record.request_id && !record.message_id) {
    fail('one transcript identity is required: session_id, request_id or message_id');
  }
  if (record.backend !== undefined && !BACKENDS.has(record.backend)) {
    fail(`backend must be one of ${[...BACKENDS].join(', ')}`);
  }
  if (record.role !== undefined && Array.isArray(pipeline.ROLES) && !pipeline.ROLES.includes(record.role)) {
    fail(`role "${record.role}" is not a Shipyard role — omit it only when no role was assigned`);
  }
  if (record.task_level !== undefined && Array.isArray(pipeline.TASK_LEVELS)
      && !pipeline.TASK_LEVELS.includes(record.task_level)) {
    fail(`task_level "${record.task_level}" is not a Shipyard task level`);
  }
  if (record.model !== undefined && Array.isArray(pipeline.TIERS) && !pipeline.TIERS.includes(record.model)) {
    fail(`model "${record.model}" is not a requested tier alias — concrete ids belong in observed_model`);
  }
  if (record.model !== undefined && typeof pipeline.tierAllowedForRuntime === 'function'
      && !pipeline.tierAllowedForRuntime(runtime, record.model)) {
    fail(`model "${record.model}" is not available on runtime "${runtime}"`);
  }
  for (const key of ['effort', 'effort_applied', 'observed_effort']) {
    if (record[key] === undefined) continue;
    if (!EFFORT_STATES.has(record[key])) {
      fail(`${key} "${record[key]}" is not a supported effort or evidence state`);
    }
  }
  for (const key of ['requested_effort', 'applied_effort']) {
    if (record[key] === undefined) continue;
    if (!EFFORT_STATES.has(record[key])) {
      fail(`${key} "${record[key]}" is not a supported effort or evidence state`);
    }
  }
  if (record.completion_status !== undefined && !COMPLETION_STATES.has(record.completion_status)) {
    fail(`completion_status must be one of ${[...COMPLETION_STATES].join(', ')}`);
  }
  // The ledger can outlive the checkout that recorded it. Store transcript
  // sources as absolute paths at write time so a later report process in a
  // different cwd can still join the durable fact to its transcript.
  if (record.source !== undefined) record.source = canonicalSource(record.source);

  record.observation_id = raw.observation_id === undefined
    ? deriveObservationId(record)
    : raw.observation_id;
  const idIssue = textIssue(record.observation_id, 'observation_id', { whitespace: true });
  if (idIssue) fail(idIssue);
  if (raw.revision !== undefined) {
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) fail('revision must be a positive safe integer');
    record.revision = raw.revision;
  }
  return record;
}

// ── ADR-014 telemetry reconciliation ──────────────────────────────────────
//
// Dispatch records and usage-attribution rows deliberately have different
// lifetimes. A dispatch journal line is a launch fact; an attribution row is a
// later transcript join. Keep the reconciliation reader in this module so both
// producers use the same vocabulary without making either one rewrite history.
// In particular, a row without policy provenance is not upgraded merely
// because its old model alias happens to resemble today's policy.

function firstValue(sources, field) {
  for (const source of sources) {
    if (source && hasOwn(source, field) && source[field] !== undefined) return source[field];
  }
  return undefined;
}

function firstConcreteValue(sources, field, concrete = concreteValue, valid = concrete) {
  const values = sources
    .filter((source) => source && hasOwn(source, field) && source[field] !== undefined)
    .map((source) => source[field]);
  return values.find(concrete) ?? values.find(valid) ?? values[0];
}

function receiptOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (object(raw.application_receipt)) return raw.application_receipt;
  if (object(raw.receipt)) return raw.receipt;
  if (raw.receipt_type === 'adr-014.application') return raw;
  return null;
}

function receiptSources(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const sources = [raw.application_receipt, raw.receipt]
    .filter(object);
  if (raw.receipt_type === 'adr-014.application') sources.push(raw);
  return sources;
}

function resolutionOf(raw) {
  return raw && object(raw.resolution) ? raw.resolution : raw;
}

function unknownEvidence(value) {
  return typeof value === 'string' && UNKNOWN_EVIDENCE.has(value.trim().toLowerCase());
}

function concreteValue(value) {
  return typeof value === 'string' && value.trim() !== '' && !unknownEvidence(value);
}

function effortValue(value) {
  return typeof value === 'string' && Array.isArray(pipeline.EFFORTS)
    && pipeline.EFFORTS.includes(value);
}

function observationValueValid(field, value) {
  if (field === 'observed_model') return typeof value === 'string' && value.trim() !== '';
  if (field === 'observed_effort') return effortValue(value) || unknownEvidence(value);
  return false;
}

function observationConcreteValue(field, value) {
  return field === 'observed_effort' ? effortValue(value) : concreteValue(value);
}

function identityPresent(value) {
  return Boolean(value && (present(value.session_id) || present(value.request_id) || present(value.message_id)));
}

function hasTranscriptIdentity(value) {
  return identityPresent(value);
}

function supportedRuntime(value) {
  return Object.prototype.hasOwnProperty.call(RUNTIME_PROVIDER, value);
}

function policyMarkerPresent(raw, resolution, receipt) {
  // Older dispatch rows already contain some of the same-shaped facts (for
  // example `agent_file` and `launch_id`). Only an explicit policy fingerprint,
  // receipt or nested resolution can prove that a row is from the ADR-014
  // schema; otherwise it stays legacy even when today's policy could happen to
  // produce the same model.
  const fields = [
    'policy_id', 'policy_version', 'policy_hash', 'resolution', 'receipt',
    'application_receipt',
  ];
  return Boolean(receipt)
    || fields.some((field) => hasOwn(raw, field) || hasOwn(resolution, field) || hasOwn(receipt, field));
}

function expectedSelection(runtime, role, rung) {
  if (!supportedRuntime(runtime)) return null;
  const grids = policy.RUNTIME_ROLE_RUNG_DEFINITIONS || {};
  const entries = grids[runtime] && grids[runtime][role];
  if (!Array.isArray(entries)) return null;
  const definition = entries.find((entry) => entry && entry.name === rung);
  if (!definition) return null;
  const modelMap = runtime === 'codex' ? policy.CODEX_MODEL_IDS : policy.CLAUDE_MODEL_ALIASES;
  const model = modelMap && modelMap[definition.model_key];
  if (!model) return null;
  const staticCodex = runtime === 'codex'
    && Array.isArray(policy.CODEX_STATIC_ROLES)
    && policy.CODEX_STATIC_ROLES.includes(role);
  if (runtime === 'claude') {
    return {
      model_key: definition.model_key,
      rung_index: entries.indexOf(definition),
      logical_model: definition.logical_model || definition.model_key,
      model,
      effort: definition.effort,
      backend: 'workflow',
      mechanism: 'workflow-explicit-selection',
      launch_arguments: { model, effort: definition.effort },
      agent_file: null,
    };
  }
  if (staticCodex) {
    return {
      model_key: definition.model_key,
      rung_index: entries.indexOf(definition),
      logical_model: definition.logical_model || definition.model_key,
      model,
      effort: definition.effort,
      backend: 'codex-agent',
      mechanism: 'generated-agent-file',
      agent_file: typeof policy.codexAgentFile === 'function'
        ? policy.codexAgentFile(role, rung)
        : null,
      launch_arguments: null,
    };
  }
  return {
    model_key: definition.model_key,
    rung_index: entries.indexOf(definition),
    logical_model: definition.logical_model || definition.model_key,
    model,
    effort: definition.effort,
    backend: 'agent',
    mechanism: 'explicit-launch-arguments',
    launch_arguments: { model, reasoning_effort: definition.effort },
    agent_file: null,
  };
}

function canonicalAgentFile(value) {
  if (!present(value) || typeof value !== 'string') return value;
  return value.endsWith('.toml') ? value : `${value}.toml`;
}

function evidenceMatches(expected, actual, field) {
  // Provider observations are allowed to become unknown while a persisted
  // repair fact is being reconciled. Keep that compatibility for nested
  // predecessor copies, but compare every selection/provenance field exactly.
  if (['observed_model', 'observed_effort'].includes(field)
      && (unknownEvidence(expected) || unknownEvidence(actual))) return true;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return Array.isArray(expected) && Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((value, index) => evidenceMatches(value, actual[index], field));
  }
  if (object(expected) || object(actual)) {
    if (!object(expected) || !object(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => hasOwn(expected, key) && hasOwn(actual, key)
      && evidenceMatches(expected[key], actual[key], key));
  }
  return stableStringify(expected) === stableStringify(actual);
}

function canonicalRouteParts(route) {
  if (typeof route !== 'string') return null;
  const match = /^role=([^\s]+)\s+rung=([^\s]+)\s+model=([^\s]+)\s+signals=(\S+)$/.exec(route.trim());
  return match ? { role: match[1], rung: match[2], model_key: match[3], signals: match[4] } : null;
}

function verifiedReceiptProof(receipt) {
  const proof = receipt?.compliance_proof;
  return receipt?.receipt_type === 'adr-014.application'
    && receipt.compliance === 'verified' && object(proof)
    && proof.status === 'verified' && proof.boundary === 'adr-014.dispatch-boundary'
    && RECEIPT_IDENTITIES.every((field) => nonEmptyString(receipt[field])
      && nonEmptyString(proof[field]) && proof[field] === receipt[field]);
}

function repairReceiptMatches(runtime, role, receipt, linkage, consumerDispatchId,
  expectedRungName, seen = new Set(), depth = 0) {
  // A persisted chain is untrusted at every depth. The depth fence is a
  // defensive bound for malformed cyclic/object-heavy input; normal policy
  // chains are no longer than the ordered rung table.
  try {
    const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime]?.[role];
    if (!Array.isArray(rungs) || depth > rungs.length || !object(receipt) || seen.has(receipt)) return false;
    seen.add(receipt);
    const expected = expectedSelection(runtime, role, expectedRungName);
    if (!expected
        || !verifiedReceiptProof(receipt)
        || receipt.runtime !== runtime || receipt.role !== role
        || receipt.policy_hash !== POLICY_HASH
        || (receipt.policy_version !== undefined && receipt.policy_version !== POLICY_VERSION)
        || receipt.dispatch_id === consumerDispatchId
        || !object(linkage) || linkage.dispatch_id !== receipt.dispatch_id
        || linkage.model !== expected.model || linkage.effort !== expected.effort
        || receipt.requested_model !== expected.model || receipt.applied_model !== expected.model
        || receipt.requested_effort !== expected.effort || receipt.applied_effort !== expected.effort) return false;

    if (receipt.policy_id !== undefined && receipt.policy_id !== POLICY_ID) return false;
    for (const field of ['backend', 'mechanism']) {
      if (hasOwn(receipt, field) && receipt[field] !== expected[field]) return false;
    }
    if (hasOwn(receipt, 'launch_arguments')
        && stableStringify(receipt.launch_arguments) !== stableStringify(expected.launch_arguments)) return false;
    for (const field of ['rung', 'logical_rung']) {
      if (hasOwn(receipt, field) && receipt[field] !== expectedRungName) return false;
    }
    for (const [field, want] of [
      ['model_key', expected.model_key], ['logical_model', expected.logical_model],
      ['rung_index', expected.rung_index],
    ]) {
      if (hasOwn(receipt, field) && receipt[field] !== want) return false;
    }

    // A predecessor is allowed to report unknown observations, but a supplied
    // malformed value cannot be ignored in favour of another copy.
    if (!hasOwn(receipt, 'observed_model') || !observationValueValid('observed_model', receipt.observed_model)
        || (!unknownEvidence(receipt.observed_model) && receipt.observed_model !== expected.model)
        || !hasOwn(receipt, 'observed_effort') || !observationValueValid('observed_effort', receipt.observed_effort)
        || (!unknownEvidence(receipt.observed_effort) && receipt.observed_effort !== expected.effort)) return false;

    const hasSignalClaims = ['route', 'signals_fired', 'signal_reasons', 'selected_signals']
      .some((field) => hasOwn(receipt, field));
    const hasSignals = hasOwn(receipt, 'signals');
    if (hasSignalClaims && !hasSignals) return false;
    if (hasSignals) {
      if (!object(receipt.signals)) return false;
      const evaluation = policy.evaluateSignals(role, receipt.signals, { runtime });
      if (stableStringify(evaluation.signals) !== stableStringify(receipt.signals)) return false;
      let authorizedRung = rungs[0];
      const selectedNames = new Set(evaluation.selected.map((entry) => entry.rung));
      for (const candidate of rungs) {
        if (selectedNames.has(candidate.name)) authorizedRung = candidate;
      }
      if (!authorizedRung || authorizedRung.name !== expectedRungName) return false;
      const selectedRoute = evaluation.selected.length
        ? evaluation.selected.map((entry) => `${entry.signal}->${entry.rung}`).join('+')
        : 'base';
      const expectedRoute = `role=${role} rung=${authorizedRung.name} model=${authorizedRung.model_key} signals=${selectedRoute}`;
      if (hasOwn(receipt, 'route') && receipt.route !== expectedRoute) return false;
      if (hasOwn(receipt, 'signals_fired')
          && (!Array.isArray(receipt.signals_fired)
            || stableStringify(evaluation.signals_fired) !== stableStringify(receipt.signals_fired))) return false;
      if (hasOwn(receipt, 'signal_reasons')
          && (!Array.isArray(receipt.signal_reasons)
            || !evidenceMatches(evaluation.reasons, receipt.signal_reasons))) return false;
      if (hasOwn(receipt, 'selected_signals')
          && (!Array.isArray(receipt.selected_signals)
            || !evidenceMatches(evaluation.selected, receipt.selected_signals))) return false;

      const nestedHasPrior = hasOwn(receipt.signals, 'priorApplied');
      const nestedState = receipt.signals.signatureState;
      const nestedPrerequisite = policy.RUNTIME_REPAIR_PREREQUISITES[runtime]?.[role]?.[nestedState];
      if (nestedHasPrior !== Boolean(nestedPrerequisite)) return false;
      if (nestedHasPrior) {
        const nestedIndex = rungs.findIndex((entry) => entry.name === nestedState);
        const nestedPrevious = nestedIndex > 0 ? rungs[nestedIndex - 1] : null;
        if (!nestedPrevious || !object(receipt.signals.priorApplied)) return false;
        const nestedLinkage = hasOwn(receipt, 'prior_applied')
          ? receipt.prior_applied
          : {
            dispatch_id: receipt.signals.priorApplied.dispatch_id,
            model: nestedPrerequisite.model,
            effort: nestedPrerequisite.effort,
          };
        if (!repairReceiptMatches(
          runtime, role, receipt.signals.priorApplied, nestedLinkage,
          receipt.dispatch_id, nestedPrevious.name, seen, depth + 1
        )) return false;
      } else if (hasOwn(receipt, 'prior_applied')) {
        return false;
      }
    } else if (hasOwn(receipt, 'prior_applied')) {
      return false;
    }

    if (expected.agent_file) {
      if (canonicalAgentFile(receipt.agent_file) !== canonicalAgentFile(expected.agent_file)
          || !/^[a-f0-9]{64}$/.test(receipt.agent_file_digest || '')) return false;
    } else if (receipt.agent_file !== undefined && receipt.agent_file !== null) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function repairEvidenceMatches(runtime, role, signals, priorApplied, dispatchId) {
  const prerequisite = policy.RUNTIME_REPAIR_PREREQUISITES[runtime]?.[role]?.[signals.signatureState];
  if (!prerequisite) return true;
  const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime]?.[role];
  const rungIndex = Array.isArray(rungs)
    ? rungs.findIndex((entry) => entry.name === signals.signatureState)
    : -1;
  const previousRung = rungIndex > 0 ? rungs[rungIndex - 1] : null;
  // Persisted telemetry cannot carry the boundary's object-identity capability.
  // Check its recorded proof and every recursively supplied predecessor link
  // against the same ordered prerequisite table used by dispatch-boundary;
  // never authorize a launch here.
  return Boolean(previousRung) && repairReceiptMatches(
    runtime, role, signals.priorApplied, priorApplied, dispatchId, previousRung.name
  );
}

// dispatch-boundary.reconcile deliberately returns durable dispatch facts, not
// a duplicate resolver object. Its projection predates logical_model and
// rung_index, but those values are deterministic only after the signed receipt
// and every persisted selection fact agree with the active policy. Derive no
// other field and never use this for legacy or stale records.
function boundaryProjection(receipt, values, expected) {
  if (!receipt || !expected
      || values.policyVersion !== POLICY_VERSION || values.policyHash !== POLICY_HASH
      || values.runtime !== receipt.runtime || values.role !== receipt.role
      || values.dispatchId !== receipt.dispatch_id
      || !present(values.taskLevel)
      || values.requestedModel !== receipt.requested_model
      || values.requestedEffort !== receipt.requested_effort
      || values.backend !== expected.backend || values.mechanism !== expected.mechanism
      || values.requestedModel !== expected.model || values.requestedEffort !== expected.effort
      || values.rung !== values.logicalRung) return null;
  const route = canonicalRouteParts(values.route);
  if (!verifiedReceiptProof(receipt)
      || receipt.policy_hash !== values.policyHash
      || !route || route.role !== values.role || route.rung !== values.rung
      || route.model_key !== expected.model_key) return null;
  return { logical_model: expected.logical_model, rung_index: expected.rung_index };
}

function conflictBetween(sources, field) {
  const values = sources
    .filter((source) => source && hasOwn(source, field) && source[field] !== undefined)
    .map((source) => field === 'agent_file' ? canonicalAgentFile(source[field]) : source[field]);
  return values.length > 1 && values.some((value) => stableStringify(value) !== stableStringify(values[0]));
}

function concreteConflictBetween(sources, field, concrete = concreteValue) {
  const values = sources
    .filter((source) => source && hasOwn(source, field) && concrete(source[field]))
    .map((source) => source[field]);
  return values.length > 1 && values.some((value) => stableStringify(value) !== stableStringify(values[0]));
}

function aliasConflictBetween(sources, fields) {
  const values = [];
  for (const source of sources) {
    for (const field of fields) {
      if (source && hasOwn(source, field)) values.push(source[field]);
    }
  }
  return values.length > 1 && values.some((value) => stableStringify(value) !== stableStringify(values[0]));
}

function reconcileTelemetry(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return markReconciledFact({
      resolution_status: 'missing',
      application_status: 'missing_receipt',
      observation_status: 'unknown',
      usage_join_status: 'missing_dispatch_id',
      policy_resolution: { status: 'missing', resolved: false, current: false, complete: false },
      runtime_application: { status: 'missing_receipt', applied: false, verified: false, receipt_present: false },
      provider_observation: { status: 'unknown', observed: false, unknown: true, missing: true },
      usage_join: { status: 'missing_dispatch_id', joined: false },
      findings: ['missing_receipt', 'unknown_observation'],
      legacy: false,
      compliant: false,
      comparison_ready: false,
    });
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};

  const baseResolution = resolutionOf(raw);
  const baseReceipts = receiptSources(raw);
  const baseReceipt = receiptOf(raw);
  const receiptClaimed = hasOwn(raw, 'receipt') || hasOwn(raw, 'application_receipt')
    || raw.receipt_type === 'adr-014.application';
  const initialSources = [baseResolution, baseResolution === raw ? null : raw, baseReceipt];
  const initialRuntime = firstValue(initialSources, 'runtime');
  const initialDispatchId = firstValue(initialSources, 'dispatch_id');
  const suppliedMatches = Array.isArray(options.usageMatches) ? options.usageMatches
    : Array.isArray(options.usageRecords) ? options.usageRecords : [];
  const usageMatches = suppliedMatches.filter((candidate) => candidate
    && candidate.dispatch_id === initialDispatchId
    && supportedRuntime(initialRuntime)
    && candidate.runtime === initialRuntime
    && candidate.provider === RUNTIME_PROVIDER[initialRuntime]
    && identityPresent(candidate));
  const usageEvidence = usageMatches.length === 1 ? usageMatches[0] : null;
  const usageResolution = usageEvidence ? resolutionOf(usageEvidence) : null;
  const receipt = baseReceipt || (usageEvidence ? receiptOf(usageEvidence) : null);
  const receipts = [...baseReceipts, ...(usageEvidence ? receiptSources(usageEvidence) : [])];
  const resolutionSources = [
    baseResolution, baseResolution === raw ? null : raw,
    usageResolution, usageResolution === usageEvidence ? null : usageEvidence,
  ];
  const allSources = [...resolutionSources, ...receipts];
  const applicationSources = [...receipts, ...resolutionSources];
  const runtime = firstValue(allSources, 'runtime');
  const role = firstValue(allSources, 'role');
  const dispatchId = firstValue(allSources, 'dispatch_id');
  const policyId = firstValue(allSources, 'policy_id');
  const policyVersion = firstValue(allSources, 'policy_version');
  const policyHash = firstValue(allSources, 'policy_hash');
  let logicalModel = firstValue(resolutionSources, 'logical_model');
  const logicalRung = firstValue(resolutionSources, 'logical_rung') ?? firstValue(resolutionSources, 'rung');
  const rung = firstValue(resolutionSources, 'rung') ?? logicalRung;
  let rungIndex = firstValue(resolutionSources, 'rung_index');
  const route = firstValue(resolutionSources, 'route') ?? firstValue(resolutionSources, 'reason');
  const backend = firstValue(allSources, 'backend');
  const mechanism = firstValue(allSources, 'mechanism');
  const agentFile = firstValue(allSources, 'agent_file');
  const agentFileDigest = firstValue(allSources, 'agent_file_digest');
  // A receipt reports what it claims was launched. Prefer the selected dispatch
  // identity (including the journal's legacy agent_id projection) so the two
  // facts are actually compared instead of allowing the receipt to select it.
  const explicitLaunchId = firstValue(resolutionSources, 'launch_id');
  const dispatchLaunchId = explicitLaunchId !== undefined
    ? explicitLaunchId : firstValue(resolutionSources, 'agent_id');
  const launchId = dispatchLaunchId !== undefined ? dispatchLaunchId : firstValue(receipts, 'launch_id');
  const launchArguments = firstValue(resolutionSources, 'launch_arguments');
  const signals = firstValue(resolutionSources, 'signals');
  const signalsFired = firstValue(resolutionSources, 'signals_fired');
  const requestedModel = firstValue(resolutionSources, 'requested_model')
    ?? firstValue(resolutionSources, 'model');
  const requestedEffort = firstValue(resolutionSources, 'requested_effort')
    ?? firstValue(resolutionSources, 'effort');
  const appliedModel = firstConcreteValue(applicationSources, 'applied_model')
    ?? firstValue(resolutionSources, 'model_applied');
  const appliedEffort = firstConcreteValue(applicationSources, 'applied_effort')
    ?? firstValue(resolutionSources, 'effort_applied');
  const observedModel = firstConcreteValue(
    applicationSources, 'observed_model', concreteValue,
    (value) => observationValueValid('observed_model', value),
  );
  const observedEffort = firstConcreteValue(
    applicationSources, 'observed_effort',
    (value) => observationConcreteValue('observed_effort', value),
    (value) => observationValueValid('observed_effort', value),
  );
  const policyAware = policyMarkerPresent(raw, baseResolution, baseReceipt)
    || Boolean(usageEvidence && policyMarkerPresent(usageEvidence, usageResolution, receiptOf(usageEvidence)));
  const legacy = !policyAware;

  const expected = expectedSelection(runtime, role, rung);
  const projection = boundaryProjection(receipt, {
    runtime, role, dispatchId, taskLevel: firstValue(resolutionSources, 'task_level'), policyVersion, policyHash, logicalRung, rung,
    requestedModel, requestedEffort, route, backend, mechanism,
  }, expected);
  if (!present(logicalModel) && projection) logicalModel = projection.logical_model;
  if ((rungIndex === undefined || rungIndex === null) && projection) rungIndex = projection.rung_index;
  const resolutionMissing = [];
  if (!present(runtime)) resolutionMissing.push('runtime');
  if (!present(role)) resolutionMissing.push('role');
  if (!present(policyVersion)) resolutionMissing.push('policy_version');
  if (!present(policyHash)) resolutionMissing.push('policy_hash');
  if (!present(logicalModel)) resolutionMissing.push('logical_model');
  if (!present(rung) || !present(logicalRung)) resolutionMissing.push('rung');
  if (rungIndex === undefined || rungIndex === null) resolutionMissing.push('rung_index');
  if (!present(requestedModel)) resolutionMissing.push('requested_model');
  if (!present(requestedEffort)) resolutionMissing.push('requested_effort');
  if (!present(route)) resolutionMissing.push('route');
  if (!present(backend)) resolutionMissing.push('backend');
  if (!present(mechanism)) resolutionMissing.push('mechanism');
  if (!Array.isArray(signalsFired)) resolutionMissing.push('signals_fired');
  if (!object(signals)) resolutionMissing.push('signals');
  if (runtime === 'codex' && expected && expected.agent_file && !present(agentFile)) resolutionMissing.push('agent_file');
  if (expected && !expected.agent_file && (!launchArguments || !object(launchArguments))) {
    resolutionMissing.push('launch_arguments');
  }
  const resolutionContradictions = [];
  if (resolutionSources.some((source) => source?.agent_file !== undefined
      && source.agent_file !== null && !nonEmptyString(source.agent_file))) {
    resolutionContradictions.push('agent_file');
  }
  if (runtime !== undefined && !supportedRuntime(runtime)) resolutionContradictions.push('unsupported_runtime');
  if (aliasConflictBetween(allSources, ['effort', 'requested_effort'])) {
    resolutionContradictions.push('requested_effort');
  }
  for (const source of allSources) {
    for (const field of ['effort', 'requested_effort']) {
      if (hasOwn(source, field) && !EFFORT_STATES.has(source[field])) {
        resolutionContradictions.push(field);
      }
    }
  }
  for (const field of [
    'runtime', 'role', 'policy_id', 'policy_version', 'policy_hash', 'logical_model',
    'logical_rung', 'rung', 'rung_index', 'dispatch_id', 'route', 'backend', 'mechanism',
    'agent_file', 'launch_arguments', 'signals', 'signals_fired', 'requested_model',
    'requested_effort',
  ]) {
    if (conflictBetween(resolutionSources, field)) resolutionContradictions.push(`${field}_conflict`);
  }
  const stalePolicy = policyAware && (
    (present(policyVersion) && policyVersion !== POLICY_VERSION)
    || (present(policyHash) && policyHash !== POLICY_HASH)
  );
  const currentPolicy = policyAware && policyVersion === POLICY_VERSION && policyHash === POLICY_HASH;
  const reportedPolicyId = policyId ?? (currentPolicy ? POLICY_ID : null);
  if (policyAware && policyId !== undefined && policyId !== POLICY_ID) {
    resolutionContradictions.push('policy_id');
  }
  if (expected && !stalePolicy) {
    if (expected && requestedModel !== undefined && requestedModel !== expected.model) {
      resolutionContradictions.push('requested_model');
    }
    if (expected && requestedEffort !== undefined && requestedEffort !== expected.effort) {
      resolutionContradictions.push('requested_effort');
    }
    if (expected && logicalModel !== undefined && logicalModel !== expected.logical_model) {
      resolutionContradictions.push('logical_model');
    }
    const routeParts = canonicalRouteParts(route);
    if (!routeParts || routeParts.role !== role || routeParts.rung !== rung || routeParts.model_key !== expected.model_key) {
      resolutionContradictions.push('route');
    }
    if (!object(signals)) {
      resolutionContradictions.push('signals');
    } else {
      try {
        if (!repairEvidenceMatches(runtime, role, signals,
          firstValue(resolutionSources, 'prior_applied'), dispatchId)
            || conflictBetween(resolutionSources, 'prior_applied')) {
          resolutionContradictions.push('signals');
        }
        const evaluation = policy.evaluateSignals(role, signals, { runtime });
        const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[runtime][role];
        const selectedNames = new Set(evaluation.selected.map((entry) => entry.rung));
        let authorizedRung = rungs[0];
        for (const candidate of rungs) {
          if (selectedNames.has(candidate.name)) authorizedRung = candidate;
        }
        if (rung !== authorizedRung.name || logicalRung !== authorizedRung.name) {
          resolutionContradictions.push('rung');
        }
        const selectedRoute = evaluation.selected.length
          ? evaluation.selected.map((entry) => `${entry.signal}->${entry.rung}`).join('+')
          : 'base';
        const expectedRoute = `role=${role} rung=${authorizedRung.name} model=${authorizedRung.model_key} signals=${selectedRoute}`;
        if (stableStringify(evaluation.signals) !== stableStringify(signals)
            || route !== expectedRoute
            || stableStringify(evaluation.signals_fired) !== stableStringify(signalsFired)
            || resolutionSources.some((source) => hasOwn(source, 'signal_reasons')
              && (!Array.isArray(source.signal_reasons)
                || !evidenceMatches(evaluation.reasons, source.signal_reasons)))) {
          resolutionContradictions.push('signals');
        }
      } catch {
        resolutionContradictions.push('signals');
      }
    }
    if (rungIndex !== undefined && rungIndex !== expected.rung_index) resolutionContradictions.push('rung_index');
    if (expected && backend !== expected.backend) resolutionContradictions.push('backend');
    if (expected && mechanism !== expected.mechanism) resolutionContradictions.push('mechanism');
    if (expected && expected.agent_file
        && canonicalAgentFile(agentFile) !== canonicalAgentFile(expected.agent_file)) {
      resolutionContradictions.push('agent_file');
    }
    if (expected && !expected.agent_file && agentFile !== undefined && agentFile !== null) {
      resolutionContradictions.push('agent_file');
    }
    if (object(expected.launch_arguments) && launchArguments !== undefined
        && (!object(launchArguments)
          || stableStringify(launchArguments) !== stableStringify(expected.launch_arguments))) {
      resolutionContradictions.push('launch_arguments');
    }
    if (expected.launch_arguments === null && launchArguments !== undefined && launchArguments !== null) {
      resolutionContradictions.push('launch_arguments');
    }
  } else if (policyAware && runtime && role && !expected) {
    resolutionContradictions.push('runtime_role_rung');
  }
  const uniqueResolutionContradictions = [...new Set(resolutionContradictions)];
  const resolutionComplete = policyAware && resolutionMissing.length === 0;
  const resolutionResolved = resolutionComplete && uniqueResolutionContradictions.length === 0;
  const resolutionStatus = !policyAware
    ? 'legacy'
    : uniqueResolutionContradictions.length
      ? 'contradictory'
      : resolutionMissing.length
        ? 'missing'
        : stalePolicy
          ? 'stale'
          : 'resolved';
  const policyResolution = {
    status: resolutionStatus,
    resolved: resolutionResolved,
    current: resolutionResolved && currentPolicy,
    complete: resolutionComplete,
    stale: stalePolicy,
    contradictory: uniqueResolutionContradictions.length > 0,
    legacy,
    policy_id: reportedPolicyId,
    policy_version: policyVersion ?? null,
    policy_hash: policyHash ?? null,
    runtime: runtime ?? null,
    role: role ?? null,
    logical_model: logicalModel ?? null,
    rung: rung ?? null,
    rung_index: rungIndex ?? null,
    requested_model: requestedModel ?? null,
    requested_effort: requestedEffort ?? null,
    signals: object(signals) ? clone(signals) : null,
    signals_fired: Array.isArray(signalsFired) ? [...signalsFired] : [],
    route: route ?? null,
    backend: backend ?? null,
    mechanism: mechanism ?? null,
    missing_fields: resolutionMissing,
    contradictions: uniqueResolutionContradictions,
  };

  const applicationMissing = [];
  const applicationContradictions = [];
  const observationContradictions = [];
  if (aliasConflictBetween(allSources, ['effort_applied', 'applied_effort'])) {
    applicationContradictions.push('applied_effort');
  }
  for (const source of allSources) {
    for (const field of ['effort_applied', 'applied_effort']) {
      if (hasOwn(source, field) && !EFFORT_STATES.has(source[field])) {
        applicationContradictions.push(field);
      }
    }
    for (const field of ['observed_model', 'observed_effort']) {
      if (hasOwn(source, field) && !observationValueValid(field, source[field])) {
        observationContradictions.push(field);
      }
    }
  }
  for (const source of allSources) {
    for (const field of ['launch_id', 'agent_id']) {
      if (!hasOwn(source, field)) continue;
      if (!nonEmptyString(source[field])) applicationMissing.push(field);
      if (source[field] !== launchId) applicationContradictions.push('launch_id_source_conflict');
    }
  }
  if (conflictBetween(resolutionSources, 'launch_id')) applicationContradictions.push('launch_id_source_conflict');
  for (const source of [raw, usageEvidence]) {
    for (const field of ['receipt', 'application_receipt']) {
      if (hasOwn(source, field) && !object(source[field])) applicationMissing.push(field);
    }
  }
  for (const field of [
    'receipt_type', 'runtime', 'role', 'dispatch_id', 'launch_id', 'requested_model',
    'requested_effort', 'applied_model', 'applied_effort', 'observed_model', 'observed_effort',
    'policy_hash', 'backend', 'mechanism', 'agent_file', 'agent_file_digest',
  ]) {
    if (conflictBetween(receipts, field)) applicationContradictions.push(`${field}_source_conflict`);
  }
  if (concreteConflictBetween(applicationSources, 'applied_model')) applicationContradictions.push('applied_model');
  if (concreteConflictBetween(applicationSources, 'applied_effort', effortValue)) applicationContradictions.push('applied_effort');
  if (concreteConflictBetween(applicationSources, 'observed_model')) {
    applicationContradictions.push('observed_model');
    observationContradictions.push('observed_model');
  }
  if (concreteConflictBetween(applicationSources, 'observed_effort', effortValue)) {
    applicationContradictions.push('observed_effort');
    observationContradictions.push('observed_effort');
  }
  let receiptStalePolicy = false;
  if (policyAware && concreteValue(appliedModel) && concreteValue(requestedModel) && appliedModel !== requestedModel) {
    applicationContradictions.push('applied_model');
  }
  if (policyAware && effortValue(appliedEffort) && effortValue(requestedEffort) && appliedEffort !== requestedEffort) {
    applicationContradictions.push('applied_effort');
  }
  if (expected && currentPolicy && concreteValue(appliedModel) && appliedModel !== expected.model) {
    applicationContradictions.push('applied_model');
  }
  if (expected && currentPolicy && effortValue(appliedEffort) && appliedEffort !== expected.effort) {
    applicationContradictions.push('applied_effort');
  }
  const receiptFields = [
    'receipt_type', 'runtime', 'role', 'dispatch_id', 'launch_id',
    'requested_model', 'requested_effort', 'applied_model', 'applied_effort',
    'policy_hash', 'compliance', 'compliance_proof',
  ];
  if (expected && expected.agent_file) receiptFields.push('agent_file', 'agent_file_digest');
  if (!receipt) {
    applicationMissing.push('receipt');
  }
  // Preferred evidence supplies report values, but cannot mask a malformed or
  // contradictory copy supplied alongside it (including joined usage evidence).
  for (const receipt of receipts) {
    if (hasOwn(receipt, 'signals') && (!object(receipt.signals)
        || stableStringify(receipt.signals) !== stableStringify(signals))) {
      applicationContradictions.push('signals');
    }
    if (receipt.agent_file !== undefined && receipt.agent_file !== null
        && !nonEmptyString(receipt.agent_file)) applicationContradictions.push('agent_file');
    for (const field of receiptFields) {
      if (!hasOwn(receipt, field)
          || (field !== 'compliance_proof' && !nonEmptyString(receipt[field]))) applicationMissing.push(field);
    }
    if (receipt.receipt_type !== undefined && receipt.receipt_type !== 'adr-014.application') {
      applicationContradictions.push('receipt_type');
    }
    if (receipt.runtime !== undefined && runtime !== undefined && receipt.runtime !== runtime) {
      applicationContradictions.push('runtime');
    }
    if (receipt.role !== undefined && role !== undefined && receipt.role !== role) {
      applicationContradictions.push('role');
    }
    if (nonEmptyString(receipt.dispatch_id) && dispatchId !== undefined && receipt.dispatch_id !== dispatchId) {
      applicationContradictions.push('dispatch_id');
    }
    if (nonEmptyString(receipt.launch_id) && dispatchLaunchId !== undefined
        && receipt.launch_id !== dispatchLaunchId) {
      applicationContradictions.push('launch_id');
    }
    if (nonEmptyString(receipt.policy_hash) && policyHash !== undefined && receipt.policy_hash !== policyHash) {
      applicationContradictions.push('policy_hash');
    }
    if (receipt.policy_version !== undefined && policyVersion !== undefined
        && receipt.policy_version !== policyVersion) {
      applicationContradictions.push('policy_version');
    }
    if (receipt.policy_version !== undefined && receipt.policy_version !== POLICY_VERSION) {
      receiptStalePolicy = true;
    }
    if (receipt.policy_id !== undefined && receipt.policy_id !== POLICY_ID) {
      applicationContradictions.push('policy_id');
    }
    if (nonEmptyString(receipt.policy_hash) && receipt.policy_hash !== POLICY_HASH) {
      // A receipt from a different policy is both an application mismatch and
      // a stale-policy fact. The finding is added below without collapsing the
      // two dimensions into one status.
      receiptStalePolicy = true;
    }
    if (receipt.requested_model !== undefined && requestedModel !== undefined
        && receipt.requested_model !== requestedModel) applicationContradictions.push('requested_model');
    if (receipt.requested_effort !== undefined && requestedEffort !== undefined
        && receipt.requested_effort !== requestedEffort) applicationContradictions.push('requested_effort');
    if (concreteValue(receipt.applied_model) && concreteValue(appliedModel)
        && receipt.applied_model !== appliedModel) applicationContradictions.push('applied_model');
    if (effortValue(receipt.applied_effort) && effortValue(appliedEffort)
        && receipt.applied_effort !== appliedEffort) applicationContradictions.push('applied_effort');
    for (const source of applicationSources) {
      if (concreteValue(source?.observed_model) && concreteValue(receipt.applied_model)
          && source.observed_model !== receipt.applied_model) {
        applicationContradictions.push('observed_model');
        observationContradictions.push('observed_model');
      }
      if (effortValue(source?.observed_effort) && effortValue(receipt.applied_effort)
          && source.observed_effort !== receipt.applied_effort) {
        applicationContradictions.push('observed_effort');
        observationContradictions.push('observed_effort');
      }
    }
    if (receipt.backend !== undefined && backend !== undefined && receipt.backend !== backend) {
      applicationContradictions.push('backend');
    }
    if (receipt.mechanism !== undefined && mechanism !== undefined && receipt.mechanism !== mechanism) {
      applicationContradictions.push('mechanism');
    }
    if (receipt.agent_file !== undefined && agentFile !== undefined
        && canonicalAgentFile(receipt.agent_file) !== canonicalAgentFile(agentFile)) {
      applicationContradictions.push('agent_file');
    }
    if (receipt.agent_file_digest !== undefined && agentFileDigest !== undefined
        && receipt.agent_file_digest !== agentFileDigest) {
      applicationContradictions.push('agent_file_digest');
    }
    if (receipt.compliance === 'verified' && object(receipt.compliance_proof)) {
      const proof = receipt.compliance_proof;
      for (const field of RECEIPT_IDENTITIES) {
        if (!nonEmptyString(proof[field])) applicationMissing.push(`compliance_proof.${field}`);
      }
      if (proof.status !== 'verified'
          || proof.boundary !== 'adr-014.dispatch-boundary'
          || RECEIPT_IDENTITIES.some((field) => nonEmptyString(proof[field])
            && nonEmptyString(receipt[field]) && proof[field] !== receipt[field])) {
        applicationContradictions.push('compliance_proof');
      }
    } else {
      applicationMissing.push('compliance_proof');
    }
    // Static boundary receipts use null to denote selection by agent file.
    const staticArgumentsAbsent = expected?.agent_file && receipt.launch_arguments === null;
    if (hasOwn(receipt, 'launch_arguments') && !staticArgumentsAbsent && !object(receipt.launch_arguments)) {
      applicationContradictions.push('launch_arguments');
    }
    if (expected && currentPolicy) {
      for (const field of ['rung', 'logical_rung']) {
        if (hasOwn(receipt, field) && receipt[field] !== rung) applicationContradictions.push(field);
      }
      if (concreteValue(receipt.applied_model) && receipt.applied_model !== expected.model) {
        applicationContradictions.push('applied_model');
      }
      if (effortValue(receipt.applied_effort) && receipt.applied_effort !== expected.effort) {
        applicationContradictions.push('applied_effort');
      }
      if (receipt.mechanism !== undefined && receipt.mechanism !== expected.mechanism) {
        applicationContradictions.push('mechanism');
      }
      if (receipt.backend !== undefined && receipt.backend !== expected.backend) {
        applicationContradictions.push('backend');
      }
      if (expected.agent_file && receipt.agent_file !== undefined
          && canonicalAgentFile(receipt.agent_file) !== canonicalAgentFile(expected.agent_file)) {
        applicationContradictions.push('agent_file');
      }
      if (expected.agent_file && receipt.agent_file_digest !== undefined
          && agentFileDigest !== undefined && receipt.agent_file_digest !== agentFileDigest) {
        applicationContradictions.push('agent_file_digest');
      }
      if (!expected.agent_file && receipt.agent_file !== undefined && receipt.agent_file !== null) {
        applicationContradictions.push('agent_file');
      }
      if (hasOwn(receipt, 'launch_arguments')
          && (!expected.launch_arguments && !staticArgumentsAbsent
            || stableStringify(receipt.launch_arguments) !== stableStringify(expected.launch_arguments))) {
        applicationContradictions.push('launch_arguments');
      }
    }
    if (!concreteValue(receipt.applied_model)) applicationMissing.push('applied_model');
    if (!effortValue(receipt.applied_effort)) applicationMissing.push('applied_effort');
    if (expected && expected.agent_file
        && !/^[a-f0-9]{64}$/.test(receipt.agent_file_digest || '')) applicationMissing.push('agent_file_digest');
  }
  const proofPresent = Boolean(receipt && receipt.compliance === 'verified' && object(receipt.compliance_proof));
  const applicationVerified = Boolean(
    receipt
      && applicationMissing.length === 0
      && applicationContradictions.length === 0
      && proofPresent
  );
  const uniqueApplicationMissing = [...new Set(applicationMissing)];
  const uniqueApplicationContradictions = [...new Set(applicationContradictions)];
  const applicationStatus = !receipt
    ? (receiptClaimed ? 'unverifiable' : 'missing_receipt')
    : uniqueApplicationContradictions.length
      ? 'contradictory'
      : uniqueApplicationMissing.length || !proofPresent
        ? 'unverifiable'
        : 'applied';
  const runtimeApplication = {
    status: applicationStatus,
    applied: applicationVerified,
    verified: applicationVerified,
    receipt_present: Boolean(receipt),
    receipt_type: receipt?.receipt_type ?? null,
    launch_id: launchId ?? null,
    agent_file_digest: agentFileDigest ?? null,
    applied_model: appliedModel ?? null,
    applied_effort: appliedEffort ?? null,
    missing_fields: uniqueApplicationMissing,
    contradictions: uniqueApplicationContradictions,
    stale_policy: receiptStalePolicy,
  };

  const uniqueObservationContradictions = [...new Set(observationContradictions)];
  const observedModelMissing = !present(observedModel);
  const observedEffortMissing = !present(observedEffort);
  const observationUnknown = observedModelMissing || observedEffortMissing
    || unknownEvidence(observedModel) || unknownEvidence(observedEffort)
    || !concreteValue(observedModel) || !effortValue(observedEffort);
  const observationStatus = uniqueObservationContradictions.length
    ? 'contradictory' : observationUnknown ? 'unknown' : 'observed';
  const providerObservation = {
    status: observationStatus,
    observed: !observationUnknown && uniqueObservationContradictions.length === 0,
    unknown: observationUnknown,
    missing: observedModelMissing || observedEffortMissing,
    contradictory: uniqueObservationContradictions.length > 0,
    contradictions: uniqueObservationContradictions,
    unavailable: Boolean(raw.observation_unavailable),
    model: observedModel ?? null,
    effort: observedEffort ?? null,
  };

  let usageJoinStatus;
  if (!present(dispatchId)) {
    usageJoinStatus = 'missing_dispatch_id';
  } else if (options.usage_join_status) {
    usageJoinStatus = String(options.usage_join_status);
  } else if (options.usageJoined === true || options.usage_joined === true) {
    usageJoinStatus = 'joined';
  } else if (options.usageJoined === false || options.usage_joined === false) {
    usageJoinStatus = 'unjoined';
  } else if (Array.isArray(options.usageMatches)) {
    usageJoinStatus = usageMatches.length > 1
      ? 'ambiguous'
      : usageMatches.length ? 'joined' : 'unjoined';
  } else if (Array.isArray(options.usageRecords)) {
    usageJoinStatus = usageMatches.length > 1
      ? 'ambiguous'
      : usageMatches.length ? 'joined' : 'unjoined';
  } else {
    usageJoinStatus = identityPresent(raw) ? 'joined' : 'unjoined';
  }
  if (!['joined', 'unjoined', 'ambiguous', 'missing_dispatch_id'].includes(usageJoinStatus)) {
    usageJoinStatus = 'unjoined';
  }
  const usageJoin = {
    status: usageJoinStatus,
    joined: usageJoinStatus === 'joined',
    ambiguous: usageJoinStatus === 'ambiguous',
    dispatch_id: dispatchId ?? null,
    matches: usageMatches.length,
  };

  const findings = [];
  if (stalePolicy || receiptStalePolicy) findings.push('stale_policy');
  if (uniqueApplicationContradictions.length) findings.push('contradictory_application');
  if (uniqueObservationContradictions.length) findings.push('contradictory_observation');
  if (!receipt) findings.push('missing_receipt');
  if (observationUnknown) findings.push('unknown_observation');
  if (legacy) findings.push('legacy');
  const uniqueFindings = [...new Set(findings)];

  const compliant = policyResolution.current && runtimeApplication.verified
    && !receiptStalePolicy && uniqueObservationContradictions.length === 0;
  const comparisonReady = compliant && providerObservation.observed && usageJoin.joined;
  return markReconciledFact({
    dispatch_id: dispatchId ?? null,
    runtime: runtime ?? null,
    role: role ?? null,
    policy_id: reportedPolicyId,
    policy_version: policyVersion ?? null,
    policy_hash: policyHash ?? null,
    logical_model: logicalModel ?? null,
    logical_rung: logicalRung ?? null,
    rung: rung ?? null,
    rung_index: rungIndex ?? null,
    route: route ?? null,
    mechanism: mechanism ?? null,
    agent_file: agentFile ?? null,
    agent_file_digest: agentFileDigest ?? null,
    launch_id: launchId ?? null,
    launch_arguments: object(launchArguments) ? clone(launchArguments) : null,
    signals: object(signals) ? clone(signals) : null,
    signals_fired: Array.isArray(signalsFired) ? [...signalsFired] : [],
    requested_model: requestedModel ?? null,
    requested_effort: requestedEffort ?? null,
    applied_model: appliedModel ?? null,
    applied_effort: appliedEffort ?? null,
    observed_model: observedModel ?? null,
    observed_effort: observedEffort ?? null,
    resolution_status: resolutionStatus,
    application_status: applicationStatus,
    observation_status: observationStatus,
    usage_join_status: usageJoinStatus,
    policy_resolution_status: resolutionStatus,
    runtime_application_status: applicationStatus,
    provider_observation_status: observationStatus,
    usage_join_coverage: usageJoinStatus,
    policy_resolution: policyResolution,
    runtime_application: runtimeApplication,
    provider_observation: providerObservation,
    usage_join: usageJoin,
    findings: uniqueFindings,
    legacy,
    resolved: policyResolution.resolved,
    applied: runtimeApplication.applied,
    observed: providerObservation.observed,
    usage_joined: usageJoin.joined,
    compliant,
    comparison_ready: comparisonReady,
  });
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    if (!present(value)) continue;
    const key = String(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function factsFor(records, options = {}) {
  return (Array.isArray(records) ? records : []).map((record) =>
    isReconciledFact(record)
      ? record
      : reconcileTelemetry(record, options)
  );
}

function compactTelemetryFact(fact) {
  return {
    dispatch_id: fact.dispatch_id,
    runtime: fact.runtime,
    role: fact.role,
    policy_id: fact.policy_id,
    policy_version: fact.policy_version,
    policy_hash: fact.policy_hash,
    logical_model: fact.logical_model,
    logical_rung: fact.logical_rung,
    rung: fact.rung,
    rung_index: fact.rung_index,
    backend: fact.policy_resolution?.backend ?? null,
    mechanism: fact.mechanism,
    agent_file: fact.agent_file,
    agent_file_digest: fact.agent_file_digest,
    signals_fired: fact.signals_fired,
    requested_model: fact.requested_model,
    requested_effort: fact.requested_effort,
    applied_model: fact.applied_model,
    applied_effort: fact.applied_effort,
    observed_model: fact.observed_model,
    observed_effort: fact.observed_effort,
    resolution_status: fact.resolution_status,
    application_status: fact.application_status,
    observation_status: fact.observation_status,
    usage_join_status: fact.usage_join_status,
    resolved: fact.resolved,
    applied: fact.applied,
    observed: fact.observed,
    usage_joined: fact.usage_joined,
    policy_resolution: {
      status: fact.policy_resolution?.status ?? null,
      resolved: fact.policy_resolution?.resolved === true,
      current: fact.policy_resolution?.current === true,
      complete: fact.policy_resolution?.complete === true,
      stale: fact.policy_resolution?.stale === true,
      contradictory: fact.policy_resolution?.contradictory === true,
      legacy: fact.policy_resolution?.legacy === true,
      contradictions: fact.policy_resolution?.contradictions || [],
    },
    runtime_application: {
      status: fact.runtime_application?.status ?? null,
      applied: fact.runtime_application?.applied === true,
      verified: fact.runtime_application?.verified === true,
      receipt_present: fact.runtime_application?.receipt_present === true,
      agent_file_digest: fact.runtime_application?.agent_file_digest ?? null,
      stale_policy: fact.runtime_application?.stale_policy === true,
      contradictions: fact.runtime_application?.contradictions || [],
    },
    provider_observation: {
      status: fact.provider_observation?.status ?? null,
      observed: fact.provider_observation?.observed === true,
      unknown: fact.provider_observation?.unknown === true,
      missing: fact.provider_observation?.missing === true,
      contradictory: fact.provider_observation?.contradictory === true,
      contradictions: fact.provider_observation?.contradictions || [],
    },
    usage_join: {
      status: fact.usage_join?.status ?? null,
      joined: fact.usage_join?.joined === true,
      ambiguous: fact.usage_join?.ambiguous === true,
    },
    findings: fact.findings,
    legacy: fact.legacy,
    compliant: fact.compliant,
    comparison_ready: fact.comparison_ready,
  };
}

function summarizeTelemetry(records, options = {}) {
  const facts = factsFor(records, options);
  const count = (predicate) => facts.filter(predicate).length;
  const statusCounts = (selector) => countValues(facts.map(selector));
  const findings = [
    'stale_policy', 'contradictory_application', 'contradictory_observation', 'missing_receipt',
    'unknown_observation', 'legacy',
  ];
  const findingCounts = Object.fromEntries(findings.map((name) => [
    name, count((fact) => Array.isArray(fact.findings) && fact.findings.includes(name)),
  ]));
  const concreteModels = facts
    .map((fact) => concreteValue(fact.observed_model)
      ? fact.observed_model
      : concreteValue(fact.applied_model) ? fact.applied_model : undefined);
  const concreteModelsWithUnknown = concreteModels.map((value) => value || 'unknown');
  const appliedModels = facts.map((fact) => fact.applied_model);
  const observedModels = facts.map((fact) => fact.observed_model);
  const requestedModels = facts.map((fact) => fact.requested_model);
  const requestedEfforts = facts.map((fact) => fact.requested_effort);
  const appliedEfforts = facts.map((fact) => fact.applied_effort);
  const observedEfforts = facts.map((fact) => fact.observed_effort);
  const firedSignals = facts.flatMap((fact) => Array.isArray(fact.signals_fired) ? fact.signals_fired : []);
  const coverage = {
    policy_resolution: {
      total: facts.length,
      resolved: count((fact) => fact.policy_resolution?.resolved === true),
      current: count((fact) => fact.policy_resolution?.current === true),
      stale: count((fact) => fact.policy_resolution?.stale === true),
      missing: count((fact) => fact.policy_resolution?.status === 'missing'),
      contradictory: count((fact) => fact.policy_resolution?.contradictory === true),
      legacy: count((fact) => fact.policy_resolution?.legacy === true),
    },
    runtime_application: {
      total: facts.length,
      applied: count((fact) => fact.runtime_application?.applied === true),
      verified: count((fact) => fact.runtime_application?.verified === true),
      missing_receipt: count((fact) => fact.application_status === 'missing_receipt'),
      unverifiable: count((fact) => fact.application_status === 'unverifiable'),
      contradictory: count((fact) => fact.application_status === 'contradictory'),
    },
    provider_observation: {
      total: facts.length,
      observed: count((fact) => fact.provider_observation?.observed === true),
      unknown: count((fact) => fact.provider_observation?.unknown === true),
      missing: count((fact) => fact.provider_observation?.missing === true),
      contradictory: count((fact) => fact.provider_observation?.contradictory === true),
    },
    usage_join: {
      total: facts.length,
      joined: count((fact) => fact.usage_join?.joined === true),
      unjoined: count((fact) => fact.usage_join_status === 'unjoined'),
      ambiguous: count((fact) => fact.usage_join_status === 'ambiguous'),
      missing_dispatch_id: count((fact) => fact.usage_join_status === 'missing_dispatch_id'),
    },
  };
  const byStatus = {
    policy_resolution: statusCounts((fact) => fact.resolution_status),
    runtime_application: statusCounts((fact) => fact.application_status),
    provider_observation: statusCounts((fact) => fact.observation_status),
    usage_join: statusCounts((fact) => fact.usage_join_status),
  };
  return {
    total: facts.length,
    resolved: coverage.policy_resolution.resolved,
    applied: coverage.runtime_application.applied,
    observed: coverage.provider_observation.observed,
    usage_joined: coverage.usage_join.joined,
    compliant: count((fact) => fact.compliant === true),
    comparison_ready: count((fact) => fact.comparison_ready === true),
    coverage,
    findings: findingCounts,
    finding_counts: findingCounts,
    by_finding: findingCounts,
    by_status: byStatus,
    // Short aliases keep the four claims easy to consume for callers that do
    // not need the longer provenance names. They remain separate objects.
    policy_resolution: coverage.policy_resolution,
    runtime_application: coverage.runtime_application,
    provider_observation: coverage.provider_observation,
    usage_join: coverage.usage_join,
    resolution: coverage.policy_resolution,
    application: coverage.runtime_application,
    observation: coverage.provider_observation,
    by_runtime: countValues(facts.map((fact) => fact.runtime)),
    by_role: countValues(facts.map((fact) => fact.role)),
    by_rung: countValues(facts.map((fact) => fact.rung)),
    by_concrete_model: countValues(concreteModels),
    by_concrete_model_with_unknown: countValues(concreteModelsWithUnknown),
    by_applied_model: countValues(appliedModels.filter(concreteValue)),
    by_observed_model: countValues(observedModels.filter(concreteValue)),
    by_model: countValues(requestedModels),
    by_requested_model: countValues(requestedModels),
    by_effort: countValues(requestedEfforts),
    by_requested_effort: countValues(requestedEfforts),
    by_applied_effort: countValues(appliedEfforts),
    by_observed_effort: countValues(observedEfforts),
    by_fired_signal: countValues(firedSignals),
    records: facts.map(compactTelemetryFact),
  };
}

function parseLedger(raw, file = LEDGER_NAME) {
  const records = [];
  const warnings = [];
  for (const [index, line] of String(raw || '').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record is not an object');
      records.push(value);
    } catch (error) {
      warnings.push(`${path.basename(file)}:${index + 1}: malformed JSON (${error.message})`);
    }
  }
  return { records, warnings };
}

function readLedger(graphDir) {
  const file = path.join(graphDir, LEDGER_NAME);
  try {
    return { ...parseLedger(fs.readFileSync(file, 'utf8'), file), file };
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], warnings: [], file };
    throw error;
  }
}

function latestRecords(records) {
  const latest = new Map();
  for (const record of records) {
    if (!record || typeof record.observation_id !== 'string') continue;
    const previous = latest.get(record.observation_id);
    const revision = Number.isSafeInteger(record.revision) ? record.revision : 1;
    const previousRevision = previous && Number.isSafeInteger(previous.revision) ? previous.revision : 1;
    if (!previous || revision >= previousRevision) latest.set(record.observation_id, record);
  }
  return [...latest.values()];
}

function sameRecord(a, b) {
  const clean = (value) => {
    const copy = { ...value };
    delete copy.revision;
    // `observed_at` is filled by the writer when a caller omits it. A retry of
    // the same launch fact must therefore stay idempotent even though the retry
    // happens a few milliseconds later.
    delete copy.observed_at;
    return copy;
  };
  return stableStringify(clean(a)) === stableStringify(clean(b));
}

function recordBatch(graphDir, raw) {
  const input = Array.isArray(raw) ? raw : [raw];
  if (!input.length) return { recorded: [], skipped: 0 };
  const dir = path.resolve(graphDir);
  graphGuard(dir, true);
  // Validate all items before taking the lock or changing the file.
  const now = new Date().toISOString();
  const normalized = input.map((item) => normalizeRecord(item, now));
  const ids = new Set();
  for (const item of normalized) {
    if (ids.has(item.observation_id)) fail(`duplicate observation_id "${item.observation_id}" in one batch`);
    ids.add(item.observation_id);
  }

  // The ledger can be explicitly selected outside the usual project layout.
  // Lock beside that ledger, otherwise `/tmp/graph` would contend on
  // `/.planning/graph/.locks` while two writers to the selected file race.
  return withLock(path.join(dir, '.locks'), 'usage-attribution', () => {
    const current = readLedger(dir).records;
    const latest = new Map(latestRecords(current).map((item) => [item.observation_id, item]));
    const toAppend = [];
    for (const item of normalized) {
      const prior = latest.get(item.observation_id);
      if (prior && sameRecord(prior, item)) continue;
      const priorRevision = prior && Number.isSafeInteger(prior.revision) ? prior.revision : 0;
      toAppend.push({ ...item, revision: Math.max(priorRevision + 1, item.revision || 1) });
    }
    if (toAppend.length) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, LEDGER_NAME),
        toAppend.map((item) => JSON.stringify(item)).join('\n') + '\n'
      );
    }
    return { recorded: toAppend, skipped: normalized.length - toAppend.length };
  }, { label: 'usage-attribution' });
}

function main(argv) {
  const parsed = graphFromArgs(argv);
  const [command, ...rest] = parsed.args;
  const cwdGraph = parsed.dir;
  if (!command || command === '--help') {
    console.log('usage: usage-attribution.cjs record --stdin [--graph <dir>]');
    console.log('       usage-attribution.cjs list [--json] [--graph <dir>]');
    return;
  }
  graphGuard(cwdGraph, parsed.explicit);
  if (command === 'record') {
    if (rest.length !== 1 || rest[0] !== '--stdin') fail('record requires --stdin');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch (error) { fail(`stdin is not valid JSON (${error.message})`, 2); }
    const result = recordBatch(cwdGraph, raw);
    console.log(`usage attribution: recorded ${result.recorded.length}, skipped ${result.skipped} identical record(s)`);
    return;
  }
  if (command === 'list') {
    if (rest.length && !(rest.length === 1 && rest[0] === '--json')) fail('usage: usage-attribution.cjs list [--json] [--graph <dir>]');
    const result = latestRecords(readLedger(cwdGraph).records);
    if (rest[0] === '--json') console.log(JSON.stringify(result, null, 2));
    else result.forEach((item) => console.log(`${item.observation_id}: ${item.runtime}/${item.kind} ${item.dispatch_id}`));
    return;
  }
  fail(`unknown command "${command}"`);
}

module.exports = {
  LEDGER_NAME,
  RUNTIME_PROVIDER,
  BACKENDS,
  KINDS,
  COMPLETION_STATES,
  EFFORT_STATES,
  POLICY_ID,
  POLICY_VERSION,
  POLICY_HASH,
  graphGuard,
  normalizeRecord,
  reconcileTelemetry,
  reconcileRecord: reconcileTelemetry,
  reconcileAttribution: reconcileTelemetry,
  summarizeTelemetry,
  aggregateTelemetry: summarizeTelemetry,
  parseLedger,
  readLedger,
  latestRecords,
  recordBatch,
  canonicalSource,
  hasTranscriptIdentity,
  textIssue,
};

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`usage-attribution: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}
