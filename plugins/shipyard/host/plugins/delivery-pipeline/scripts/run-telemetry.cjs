#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const SCHEMA = 'shipyard.run-telemetry.v1';
const VERSION = 1;
const RUNTIME_PROVIDER = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const EVIDENCE_STATES = new Set(['unknown', 'unsupported']);
const PHASES = new Set(['launch', 'receipt', 'usage', 'quality', 'recovery', 'outcome']);
const SAFE_ID = /^[A-Za-z0-9._:/@+-]+$/;
const TEXT_LIMIT = 512;
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens', 'tool_turns'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function text(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > TEXT_LIMIT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be bounded text`);
  }
  return value;
}

function id(value, field, required = false) {
  const result = text(value, field, { required });
  if (result !== null && !SAFE_ID.test(result)) throw new Error(`${field} contains unsupported characters`);
  return result;
}

function timestamp(value, fallback) {
  const result = value === undefined || value === null ? fallback : value;
  if (typeof result !== 'string' || !Number.isFinite(Date.parse(result))) throw new Error('observed_at must be a valid timestamp');
  return result;
}

function integer(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function finite(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`);
  return value;
}

function evidence(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const result = text(value, field);
  return result;
}

function concrete(value) {
  return typeof value === 'string' && value !== '' && !EVIDENCE_STATES.has(value);
}

function state(value) {
  if (value === undefined || value === null || value === '') return 'missing';
  if (value === 'unknown') return 'unknown';
  if (value === 'unsupported') return 'unsupported';
  return 'observed';
}

function first(source, secondary, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined) return source[key];
    if (secondary && secondary[key] !== undefined) return secondary[key];
  }
  return undefined;
}

function nested(source, secondary, name, field) {
  const direct = first(source, secondary, [`${name}_${field}`]);
  if (direct !== undefined) return direct;
  for (const value of [source && source[name], secondary && secondary[name]]) {
    if (object(value) && value[field] !== undefined) return value[field];
  }
  return undefined;
}

function phaseOf(source) {
  const value = first(source, null, ['phase', 'stage']);
  if (typeof value === 'string' && PHASES.has(value)) return value;
  const event = String(source && (source.event || source.kind || '')).toLowerCase();
  if (event.includes('receipt') || event.includes('application')) return 'receipt';
  if (event.includes('usage') || event.includes('attribution')) return 'usage';
  if (event.includes('quality')) return 'quality';
  if (event.includes('recover') || event.includes('repair')) return 'recovery';
  if (event.includes('outcome') || event.includes('complete')) return 'outcome';
  if (event.includes('dispatch') || event.includes('launch')) return 'launch';
  return null;
}

function safeMap(value, fields) {
  if (!object(value)) return null;
  const result = {};
  for (const field of fields) {
    if (value[field] === undefined) continue;
    const item = value[field];
    if (typeof item === 'string') result[field] = text(item, field);
    else if (typeof item === 'boolean') result[field] = item;
    else if (typeof item === 'number') result[field] = finite(item, field);
  }
  return Object.keys(result).length ? result : null;
}

function usageOf(source, secondary) {
  const values = [source && source.usage, source && source.token_usage, source && source.tokens,
    secondary && secondary.usage, secondary && secondary.token_usage, secondary && secondary.tokens];
  const result = {};
  for (const field of TOKEN_FIELDS) {
    let value = first(source, secondary, [field, `usage_${field}`, `token_${field}`]);
    if (value === undefined) {
      for (const candidate of values) {
        if (object(candidate) && candidate[field] !== undefined) {
          value = candidate[field];
          break;
        }
      }
    }
    const normalized = finite(value, field);
    if (normalized !== null) result[field] = normalized;
  }
  const status = first(source, secondary, ['usage_status', 'token_status']);
  if (status !== undefined) result.status = text(status, 'usage_status');
  return Object.keys(result).length ? result : null;
}

function factOf(source, secondary, name, fields) {
  const candidates = [source && source[name], secondary && secondary[name]];
  const result = safeMap(first(source, secondary, [`${name}_facts`]), fields) || {};
  for (const candidate of candidates) {
    const mapped = safeMap(candidate, fields);
    if (mapped) Object.assign(result, mapped);
  }
  for (const field of fields) {
    const value = first(source, secondary, [`${name}_${field}`]);
    if (value !== undefined) {
      result[field] = typeof value === 'number' ? finite(value, `${name}_${field}`)
        : typeof value === 'boolean' ? value : text(value, `${name}_${field}`);
    }
  }
  return Object.keys(result).length ? result : null;
}

function policyOf(source, secondary) {
  const nestedPolicy = first(source, secondary, ['policy_fingerprint', 'policy']);
  const result = {};
  for (const field of ['id', 'version', 'hash']) {
    const value = first(source, secondary, [`policy_${field}`]);
    if (value !== undefined) result[field] = text(value, `policy_${field}`);
    else if (object(nestedPolicy) && nestedPolicy[field] !== undefined) result[field] = text(nestedPolicy[field], `policy.${field}`);
  }
  if (typeof nestedPolicy === 'string') result.hash = nestedPolicy;
  return Object.keys(result).length ? result : null;
}

function treatmentOf(source, secondary) {
  const nestedTreatment = first(source, secondary, ['treatment']);
  const result = {};
  const treatmentId = first(source, secondary, ['treatment_id']);
  const arm = first(source, secondary, ['arm', 'cohort_arm']);
  if (treatmentId !== undefined) result.id = text(treatmentId, 'treatment_id');
  else if (typeof nestedTreatment === 'string') result.id = text(nestedTreatment, 'treatment');
  else if (object(nestedTreatment) && nestedTreatment.id !== undefined) result.id = text(nestedTreatment.id, 'treatment.id');
  if (arm !== undefined) result.arm = text(arm, 'arm');
  else if (object(nestedTreatment) && nestedTreatment.arm !== undefined) result.arm = text(nestedTreatment.arm, 'treatment.arm');
  if (result.arm !== undefined && !['baseline', 'treatment'].includes(result.arm)) throw new Error('arm must be baseline or treatment');
  return Object.keys(result).length ? result : null;
}

function normalize(input, now = new Date().toISOString()) {
  if (!object(input)) throw new Error('run telemetry record must be an object');
  const receipt = object(input.application_receipt) ? input.application_receipt
    : object(input.receipt) ? input.receipt : null;
  const handoff = object(input.session_handoff) ? input.session_handoff : object(receipt && receipt.session_handoff) ? receipt.session_handoff : null;
  const runId = id(first(input, receipt, ['run_id', 'runId']) ?? (handoff && handoff.run_id), 'run_id');
  const dispatchId = id(first(input, receipt, ['dispatch_id', 'dispatchId']), 'dispatch_id');
  const ticket = text(first(input, receipt, ['ticket', 'subject']), 'ticket');
  const role = text(first(input, receipt, ['role']), 'role');
  const runtime = text(first(input, receipt, ['runtime']), 'runtime');
  const provider = text(first(input, receipt, ['provider']), 'provider') || (runtime ? RUNTIME_PROVIDER[runtime] || null : null);
  if (runtime !== null && !Object.hasOwn(RUNTIME_PROVIDER, runtime)) throw new Error(`unsupported runtime "${runtime}"`);
  if (provider !== null && runtime !== null && RUNTIME_PROVIDER[runtime] !== provider) {
    throw new Error(`provider "${provider}" does not match runtime "${runtime}"`);
  }
  if (provider !== null && !Object.values(RUNTIME_PROVIDER).includes(provider)) throw new Error(`unsupported provider "${provider}"`);
  const accountScope = text(first(input, receipt, ['account_scope', 'provider_account_scope']), 'account_scope');
  const requestedModel = evidence(nested(input, receipt, 'requested', 'model') ?? first(input, receipt, ['requested_model', 'model']), 'requested_model');
  const appliedModel = evidence(nested(input, receipt, 'applied', 'model') ?? first(input, receipt, ['applied_model']), 'applied_model');
  const observedModel = evidence(nested(input, receipt, 'observed', 'model') ?? first(input, receipt, ['observed_model']), 'observed_model');
  const requestedEffort = evidence(nested(input, receipt, 'requested', 'effort') ?? first(input, receipt, ['requested_effort', 'effort']), 'requested_effort');
  const appliedEffort = evidence(nested(input, receipt, 'applied', 'effort') ?? first(input, receipt, ['applied_effort', 'effort_applied']), 'applied_effort');
  const observedEffort = evidence(nested(input, receipt, 'observed', 'effort') ?? first(input, receipt, ['observed_effort']), 'observed_effort');
  const policy = policyOf(input, receipt);
  const treatment = treatmentOf(input, receipt);
  const usage = usageOf(input, receipt);
  const quality = factOf(input, receipt, 'quality', ['status', 'score', 'passed', 'verified', 'evidence']);
  const recovery = factOf(input, receipt, 'recovery', ['status', 'attempts', 'fixed', 'verified', 'evidence']);
  const outcome = factOf(input, receipt, 'outcome', ['status', 'kind', 'verified', 'evidence']);
  const phase = phaseOf(input) || (receipt ? 'receipt' : null);
  const revision = integer(input.revision, 'revision') || 1;
  const observedAt = timestamp(first(input, receipt, ['observed_at', 'at', 'ts']), now);
  const completionStatus = text(first(input, receipt, ['completion_status', 'status']), 'completion_status');
  if (completionStatus && !['completed', 'failed', 'interrupted', 'unknown', 'verified', 'pending', 'unavailable', 'refused'].includes(completionStatus)) {
    throw new Error(`unsupported completion_status "${completionStatus}"`);
  }
  const launchId = text(first(input, receipt, ['launch_id', 'launchId']), 'launch_id');
  const receiptStatus = text(first(input, receipt, ['receipt_status', 'status']), 'receipt_status');
  const usageStatus = text(first(input, receipt, ['usage_status']), 'usage_status');
  const contradictions = [];
  if (concrete(appliedModel) && concrete(observedModel) && appliedModel !== observedModel) contradictions.push('model');
  if (concrete(appliedEffort) && concrete(observedEffort) && appliedEffort !== observedEffort) contradictions.push('effort');
  if (runtime && !provider) contradictions.push('provider_missing');
  const identity = {
    status: runId && dispatchId && runtime && provider ? 'complete' : 'incomplete',
    run_id: runId,
    dispatch_id: dispatchId,
    ticket,
    role,
    runtime,
    provider,
    account_scope: accountScope,
  };
  const selection = {
    requested_model: requestedModel,
    requested_effort: requestedEffort,
    applied_model: appliedModel,
    applied_effort: appliedEffort,
    observed_model: observedModel,
    observed_effort: observedEffort,
    requested_status: requestedModel || requestedEffort ? 'present' : 'missing',
    applied_status: appliedModel && appliedEffort ? (state(appliedModel) === 'observed' && state(appliedEffort) === 'observed' ? 'applied' : state(appliedModel) === 'unsupported' || state(appliedEffort) === 'unsupported' ? 'unsupported' : 'unknown') : 'missing',
    observed_status: observedModel && observedEffort ? (state(observedModel) === 'observed' && state(observedEffort) === 'observed' ? 'observed' : state(observedModel) === 'unsupported' || state(observedEffort) === 'unsupported' ? 'unsupported' : 'unknown') : 'missing',
  };
  const facts = {
    requested_model: requestedModel,
    requested_effort: requestedEffort,
    applied_model: appliedModel,
    applied_effort: appliedEffort,
    observed_model: observedModel,
    observed_effort: observedEffort,
    usage,
    quality,
    recovery,
    outcome,
    completion_status: completionStatus,
    phase,
  };
  const observationId = id(first(input, receipt, ['observation_id', 'event_id']), 'observation_id')
    || `telemetry-${digest({ run_id: runId, dispatch_id: dispatchId, phase, revision, facts }).slice(0, 32)}`;
  const result = {
    schema_version: SCHEMA,
    version: VERSION,
    event: text(input.event || input.kind || phase || 'observation', 'event', { required: true }),
    phase,
    observation_id: observationId,
    revision,
    observed_at: observedAt,
    identity,
    ...identity,
    launch_id: launchId,
    source: text(first(input, receipt, ['source', 'mechanism']), 'source'),
    selection,
    ...selection,
    policy,
    treatment,
    policy_fingerprint: policy && (policy.id || policy.version || policy.hash)
      ? digest(policy).slice(0, 32) : null,
    treatment_fingerprint: treatment && treatment.id && treatment.arm
      ? digest(treatment).slice(0, 32) : null,
    usage,
    quality,
    recovery,
    outcome,
    completion_status: completionStatus,
    receipt_status: receiptStatus,
    usage_status: usageStatus,
    contradictions,
    compliant: contradictions.length === 0 && identity.status === 'complete',
  };
  return result;
}

function phaseRecords(input) {
  if (Array.isArray(input)) return input;
  if (!object(input)) return [];
  if (Array.isArray(input.records)) return input.records;
  const result = [];
  const phaseNames = { launches: 'launch', receipts: 'receipt', usage: 'usage', quality: 'quality', recovery: 'recovery', outcomes: 'outcome' };
  for (const [source, phase] of Object.entries(phaseNames)) {
    if (Array.isArray(input[source])) result.push(...input[source].map((item) => ({ ...item, phase: item.phase || phase })));
  }
  return result;
}

function newer(a, b) {
  if (!a) return b;
  if ((b.revision || 1) !== (a.revision || 1)) return (b.revision || 1) > (a.revision || 1) ? b : a;
  return Date.parse(b.observed_at) >= Date.parse(a.observed_at) ? b : a;
}

function mergeValue(newerValue, olderValue) {
  if (newerValue === undefined || newerValue === null) return clone(olderValue);
  if (object(newerValue) && object(olderValue)) {
    const result = { ...clone(olderValue) };
    for (const [key, value] of Object.entries(newerValue)) result[key] = mergeValue(value, result[key]);
    return result;
  }
  return clone(newerValue);
}

function mergeObservation(prior, next) {
  const latest = newer(prior, next);
  const older = latest === next ? prior : next;
  return normalize(mergeValue(latest, older), latest.observed_at);
}

function sumUsage(group, record) {
  if (!record.usage) return;
  group.usage_observations.push(record.observation_id);
  for (const field of TOKEN_FIELDS) {
    if (record.usage[field] !== undefined) group.usage[field] = (group.usage[field] || 0) + record.usage[field];
  }
  if (record.usage.status) group.usage.statuses.add(record.usage.status);
}

function setIdentity(group, record) {
  for (const field of ['run_id', 'dispatch_id', 'ticket', 'role', 'runtime', 'provider', 'account_scope']) {
    const value = record[field];
    if (!value) continue;
    if (group[field] === null) group[field] = value;
    else if (group[field] !== value) group.conflicts.push(`identity:${field}`);
  }
}

function mergeSelection(group, record) {
  for (const field of ['requested_model', 'requested_effort', 'applied_model', 'applied_effort', 'observed_model', 'observed_effort']) {
    const value = record[field];
    if (!value) continue;
    if (!group[field] || EVIDENCE_STATES.has(group[field])) group[field] = value;
    else if (concrete(value) && concrete(group[field]) && group[field] !== value) group.conflicts.push(`selection:${field}`);
  }
  group.requested_status = group.requested_model || group.requested_effort ? 'present' : 'missing';
  group.applied_status = group.applied_model && group.applied_effort
    ? concrete(group.applied_model) && concrete(group.applied_effort) ? 'applied' : EVIDENCE_STATES.has(group.applied_model) || EVIDENCE_STATES.has(group.applied_effort) ? group.applied_model === 'unsupported' || group.applied_effort === 'unsupported' ? 'unsupported' : 'unknown' : 'missing'
    : 'missing';
  group.observed_status = group.observed_model && group.observed_effort
    ? concrete(group.observed_model) && concrete(group.observed_effort) ? 'observed' : group.observed_model === 'unsupported' || group.observed_effort === 'unsupported' ? 'unsupported' : 'unknown'
    : 'missing';
}

function groupFor(record) {
  const run = record.run_id || 'unknown-run';
  const dispatch = record.dispatch_id || `observation:${record.observation_id}`;
  return `${run}\u0000${dispatch}`;
}

function createGroup(key) {
  const separator = key.indexOf('\u0000');
  return {
    key,
    run_id: separator < 0 ? null : key.slice(0, separator) === 'unknown-run' ? null : key.slice(0, separator),
    dispatch_id: separator < 0 ? null : key.slice(separator + 1).startsWith('observation:') ? null : key.slice(separator + 1),
    ticket: null,
    role: null,
    runtime: null,
    provider: null,
    account_scope: null,
    launch_id: null,
    requested_model: null,
    requested_effort: null,
    applied_model: null,
    applied_effort: null,
    observed_model: null,
    observed_effort: null,
    requested_status: 'missing',
    applied_status: 'missing',
    observed_status: 'missing',
    policy_fingerprints: new Set(),
    treatment_fingerprints: new Set(),
    policy: null,
    treatment: null,
    receipt_status: null,
    usage_status: null,
    quality: null,
    recovery: null,
    outcome: null,
    completion_status: null,
    usage: {},
    usage_observations: [],
    usage_statuses: new Set(),
    phases: new Set(),
    phase_counts: {},
    observations: [],
    conflicts: [],
    duplicate_observations: 0,
  };
}

function factComplete(fact) {
  if (!fact) return false;
  if (fact.verified === true || fact.passed === true || fact.fixed === true) return true;
  return typeof fact.status === 'string' && fact.status !== '' && !EVIDENCE_STATES.has(fact.status) && fact.status !== 'pending';
}

function finalizeGroup(group) {
  const hasTokens = Object.keys(group.usage).some((field) => TOKEN_FIELDS.includes(field) && typeof group.usage[field] === 'number');
  const usageJoined = group.usage_observations.length > 0 && !group.usage_statuses.has('unknown') && !group.usage_statuses.has('unavailable');
  const receipt = group.phases.has('receipt') || group.receipt_status !== null || group.applied_status !== 'missing';
  const quality = group.quality !== null;
  const recovery = group.recovery !== null;
  const outcome = group.outcome !== null || group.completion_status !== null;
  const identity = Boolean(group.run_id && group.dispatch_id && group.runtime && group.provider);
  const attributionComplete = identity && receipt && group.applied_status === 'applied' && group.observed_status === 'observed' && usageJoined;
  const qualityComplete = factComplete(group.quality);
  const recoveryComplete = factComplete(group.recovery);
  const outcomeComplete = factComplete(group.outcome)
    || (typeof group.completion_status === 'string' && !['unknown', 'unsupported', 'pending', 'unavailable', 'refused'].includes(group.completion_status));
  const costReady = attributionComplete && Boolean(group.account_scope) && hasTokens;
  const treatmentReady = costReady && group.policy_fingerprints.size === 1 && group.treatment_fingerprints.size === 1 && qualityComplete && recoveryComplete && outcomeComplete && group.conflicts.length === 0;
  const missing = [];
  if (!identity) missing.push('identity');
  if (!receipt) missing.push('receipt');
  if (group.applied_status !== 'applied') missing.push(`applied_${group.applied_status}`);
  if (group.observed_status !== 'observed') missing.push(`observed_${group.observed_status}`);
  if (!usageJoined) missing.push('usage');
  if (!qualityComplete) missing.push('quality');
  if (!recoveryComplete) missing.push('recovery');
  if (!outcomeComplete) missing.push('outcome');
  if (!group.account_scope) missing.push('account_scope');
  if (group.conflicts.length) missing.push('contradiction');
  group.coverage = {
    identity: identity ? 'complete' : 'incomplete',
    receipt: receipt ? 'complete' : 'missing',
    usage: usageJoined ? 'complete' : group.usage_observations.length ? 'incomplete' : 'missing',
    quality: qualityComplete ? 'complete' : quality ? 'incomplete' : 'missing',
    recovery: recoveryComplete ? 'complete' : recovery ? 'incomplete' : 'missing',
    outcome: outcomeComplete ? 'complete' : outcome ? 'incomplete' : 'missing',
    attribution: attributionComplete ? 'complete' : 'incomplete',
    cost: costReady ? 'eligible' : 'ineligible',
    treatment: treatmentReady ? 'eligible' : 'ineligible',
  };
  group.attribution_complete = attributionComplete;
  group.cost_ready = costReady;
  group.treatment_ready = treatmentReady;
  group.missing = [...new Set(missing)];
  group.policy_fingerprints = [...group.policy_fingerprints].sort();
  group.treatment_fingerprints = [...group.treatment_fingerprints].sort();
  group.usage_statuses = [...group.usage_statuses].sort();
  group.phases = [...group.phases].sort();
  delete group.quality_latest;
  delete group.recovery_latest;
  delete group.outcome_latest;
  return group;
}

function joinTelemetry(input) {
  const records = phaseRecords(input).map((record) => normalize(record));
  const observations = new Map();
  let duplicateObservations = 0;
  for (const record of records) {
    const observationKey = `${record.run_id || 'unknown-run'}\u0000${record.dispatch_id || 'unknown-dispatch'}\u0000${record.observation_id}`;
    const prior = observations.get(observationKey);
    if (!prior) observations.set(observationKey, record);
    else if (stable({ ...prior, observed_at: null }) === stable({ ...record, observed_at: null })) duplicateObservations++;
    else observations.set(observationKey, mergeObservation(prior, record));
  }
  const groups = new Map();
  for (const record of observations.values()) {
    const key = groupFor(record);
    const group = groups.get(key) || createGroup(key);
    groups.set(key, group);
    setIdentity(group, record);
    mergeSelection(group, record);
    if (record.launch_id && !group.launch_id) group.launch_id = record.launch_id;
    if (record.phase) {
      group.phases.add(record.phase);
      group.phase_counts[record.phase] = (group.phase_counts[record.phase] || 0) + 1;
    }
    if (record.policy_fingerprint) {
      group.policy_fingerprints.add(record.policy_fingerprint);
      if (!group.policy || record.revision >= (group.policy.revision || 0)) group.policy = { ...(record.policy || {}), fingerprint: record.policy_fingerprint };
    }
    if (record.treatment_fingerprint) {
      group.treatment_fingerprints.add(record.treatment_fingerprint);
      if (!group.treatment || record.revision >= (group.treatment.revision || 0)) group.treatment = { ...(record.treatment || {}), fingerprint: record.treatment_fingerprint };
    }
    if (record.receipt_status) group.receipt_status = record.receipt_status;
    if (record.usage_status) group.usage_status = record.usage_status;
    if (record.quality) {
      group.quality_latest = newer(group.quality_latest, { ...record.quality, revision: record.revision, observed_at: record.observed_at });
      group.quality = group.quality_latest;
    }
    if (record.recovery) {
      group.recovery_latest = newer(group.recovery_latest, { ...record.recovery, revision: record.revision, observed_at: record.observed_at });
      group.recovery = group.recovery_latest;
    }
    if (record.outcome) {
      group.outcome_latest = newer(group.outcome_latest, { ...record.outcome, revision: record.revision, observed_at: record.observed_at });
      group.outcome = group.outcome_latest;
    }
    if (record.completion_status) group.completion_status = record.completion_status;
    sumUsage(group, record);
    group.observations.push({ observation_id: record.observation_id, event: record.event, phase: record.phase, revision: record.revision });
    group.conflicts.push(...record.contradictions);
  }
  const dispatchRuns = new Map();
  for (const group of groups.values()) {
    if (!group.dispatch_id || !group.run_id) continue;
    const runs = dispatchRuns.get(group.dispatch_id) || new Set();
    runs.add(group.run_id);
    dispatchRuns.set(group.dispatch_id, runs);
  }
  for (const group of groups.values()) {
    const runs = group.dispatch_id ? dispatchRuns.get(group.dispatch_id) : null;
    if (runs && runs.size > 1) group.conflicts.push('cross_run_dispatch_reuse');
  }
  const finalized = [...groups.values()].map(finalizeGroup).sort((a, b) => a.key.localeCompare(b.key));
  const coverage = {
    total: finalized.length,
    identity_complete: finalized.filter((group) => group.coverage.identity === 'complete').length,
    launch: finalized.filter((group) => group.phases.includes('launch')).length,
    receipt: finalized.filter((group) => group.coverage.receipt === 'complete').length,
    usage: finalized.filter((group) => group.coverage.usage === 'complete').length,
    quality: finalized.filter((group) => group.coverage.quality === 'complete').length,
    recovery: finalized.filter((group) => group.coverage.recovery === 'complete').length,
    outcome: finalized.filter((group) => group.coverage.outcome === 'complete').length,
    attribution_complete: finalized.filter((group) => group.attribution_complete).length,
    cost_ready: finalized.filter((group) => group.cost_ready).length,
    treatment_ready: finalized.filter((group) => group.treatment_ready).length,
    unknown: finalized.filter((group) => group.applied_status === 'unknown' || group.observed_status === 'unknown').length,
    unsupported: finalized.filter((group) => group.applied_status === 'unsupported' || group.observed_status === 'unsupported').length,
    contradictions: finalized.filter((group) => group.conflicts.length > 0).length,
  };
  const policyFingerprints = [...new Set(finalized.flatMap((group) => group.policy_fingerprints))].sort();
  const treatmentFingerprints = [...new Set(finalized.flatMap((group) => group.treatment_fingerprints))].sort();
  const incompleteReasons = [];
  if (coverage.total === 0) incompleteReasons.push('no_runs');
  if (coverage.attribution_complete !== coverage.total) incompleteReasons.push('incomplete_attribution');
  if (coverage.quality !== coverage.total) incompleteReasons.push('incomplete_quality');
  if (coverage.recovery !== coverage.total) incompleteReasons.push('incomplete_recovery');
  if (coverage.outcome !== coverage.total) incompleteReasons.push('incomplete_outcome');
  if (coverage.contradictions) incompleteReasons.push('contradictory_evidence');
  return {
    schema_version: SCHEMA,
    version: VERSION,
    groups: finalized,
    records: finalized,
    coverage,
    policy_fingerprints: policyFingerprints,
    treatment_fingerprints: treatmentFingerprints,
    duplicate_observations: duplicateObservations,
    savings: {
      status: incompleteReasons.length ? 'incomplete' : 'eligible',
      value: null,
      reasons: incompleteReasons,
    },
  };
}

function dispatchProjection(input) {
  const record = normalize({ ...input, event: 'launch', phase: 'launch' });
  return {
    schema_version: SCHEMA,
    event: 'launch',
    observation_id: record.observation_id,
    run_id: record.run_id,
    dispatch_id: record.dispatch_id,
    ticket: record.ticket,
    role: record.role,
    runtime: record.runtime,
    provider: record.provider,
    account_scope: record.account_scope,
    requested_model: record.requested_model,
    requested_effort: record.requested_effort,
    applied_model: record.applied_model,
    applied_effort: record.applied_effort,
    observed_model: record.observed_model,
    observed_effort: record.observed_effort,
    launch_id: record.launch_id,
    policy_fingerprint: record.policy_fingerprint,
    treatment_fingerprint: record.treatment_fingerprint,
    policy: record.policy,
    treatment: record.treatment,
    coverage: record.identity.status === 'complete' ? 'identified' : 'incomplete',
  };
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION: SCHEMA,
  VERSION,
  RUNTIME_PROVIDER,
  EVIDENCE_STATES,
  TOKEN_FIELDS,
  stable,
  digest,
  normalize,
  normalizeEnvelope: normalize,
  dispatchProjection,
  joinTelemetry,
  join: joinTelemetry,
};

if (require.main === module) {
  const raw = require('node:fs').readFileSync(0, 'utf8');
  process.stdout.write(JSON.stringify(joinTelemetry(JSON.parse(raw)), null, 2) + '\n');
}
