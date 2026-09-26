'use strict';

const crypto = require('node:crypto');
const policy = require('./model-policy-internal.cjs');

const SCHEMA_VERSION = 'shipyard.model-capability.v1';
const MODEL_AXIS_STATES = new Set(['repeat', 'repeat_exhausted']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pairSupported(snapshot, model, effort) {
  if (!Array.isArray(snapshot.supported_models) || !snapshot.supported_models.includes(model)) return false;
  if (!Array.isArray(snapshot.supported_efforts) || !snapshot.supported_efforts.includes(effort)) return false;
  if (snapshot.supported_selections !== undefined) {
    if (!Array.isArray(snapshot.supported_selections)) return false;
    return snapshot.supported_selections.some((entry) => object(entry)
      && entry.model === model && entry.effort === effort);
  }
  return true;
}

function normalizeSnapshot(raw) {
  if (!object(raw)) return null;
  const snapshot = clone(raw);
  if (snapshot.schema_version === undefined && snapshot.schema === SCHEMA_VERSION) snapshot.schema_version = snapshot.schema;
  if (snapshot.supported_models === undefined && snapshot.supportedModels !== undefined) snapshot.supported_models = snapshot.supportedModels;
  if (snapshot.supported_efforts === undefined && snapshot.supportedEfforts !== undefined) snapshot.supported_efforts = snapshot.supportedEfforts;
  if (snapshot.supported_selections === undefined && snapshot.supportedSelections !== undefined) snapshot.supported_selections = snapshot.supportedSelections;
  return snapshot;
}

function isModelAxisEscalation(resolution) {
  if (!object(resolution)) return false;
  const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[resolution.runtime]
    && policy.RUNTIME_ROLE_RUNG_DEFINITIONS[resolution.runtime][resolution.role];
  if (!Array.isArray(rungs) || !Number.isInteger(resolution.rung_index) || resolution.rung_index <= 0) return false;
  const previous = rungs[resolution.rung_index - 1];
  const current = rungs[resolution.rung_index];
  const previousModel = policy[resolution.runtime === 'codex' ? 'CODEX_MODEL_IDS' : 'CLAUDE_MODEL_ALIASES'][previous.model_key];
  const currentModel = policy[resolution.runtime === 'codex' ? 'CODEX_MODEL_IDS' : 'CLAUDE_MODEL_ALIASES'][current.model_key];
  return previousModel !== currentModel;
}

function requiresCompletedAttempt(resolution) {
  return Boolean(resolution && resolution.signals && MODEL_AXIS_STATES.has(resolution.signals.signatureState));
}

function evaluate(rawSnapshot, resolution) {
  if (!isModelAxisEscalation(resolution)) return { state: 'not_required', reason: 'effort-only-or-base-selection' };
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (!snapshot || snapshot.schema_version !== SCHEMA_VERSION) {
    return { state: 'unknown', reason: 'missing-or-unsupported-capability-schema' };
  }
  if (snapshot.runtime !== resolution.runtime || typeof snapshot.launch_id !== 'string' || !snapshot.launch_id.trim()) {
    return { state: 'unknown', reason: 'capability-snapshot-is-not-bound-to-runtime-and-launch' };
  }
  if (requiresCompletedAttempt(resolution)
      && (snapshot.completed_attempt !== true || typeof snapshot.completed_attempt_id !== 'string' || !snapshot.completed_attempt_id.trim())) {
    return { state: 'unknown', reason: 'completed-predecessor-attempt-is-not-proven' };
  }
  if (!pairSupported(snapshot, resolution.model, resolution.effort)) {
    return { state: 'unsupported', reason: 'host-does-not-advertise-the-model-effort-pair' };
  }
  return {
    state: 'supported',
    reason: 'host-advertises-the-selected-model-effort-pair',
    snapshot: {
      schema_version: snapshot.schema_version,
      runtime: snapshot.runtime,
      backend: snapshot.backend || null,
      launch_id: snapshot.launch_id,
      completed_attempt: snapshot.completed_attempt === true,
      completed_attempt_id: snapshot.completed_attempt_id || null,
      evidence_digest: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    },
  };
}

function previousRung(resolution) {
  const rungs = policy.RUNTIME_ROLE_RUNG_DEFINITIONS[resolution.runtime]
    && policy.RUNTIME_ROLE_RUNG_DEFINITIONS[resolution.runtime][resolution.role];
  if (!Array.isArray(rungs) || !Number.isInteger(resolution.rung_index) || resolution.rung_index <= 0) return null;
  return rungs[resolution.rung_index - 1];
}

function signalsForRung(rung) {
  if (!rung || rung.name === 'base') return {};
  if (rung.name === 'alternatives') return { type: 'alternatives' };
  if (rung.name === 'very-complex') return { complexity: 'very-complex' };
  if (rung.name === 'critical') return { critical: true };
  if (rung.name === 'repeat' || rung.name === 'repeat_exhausted') return { signatureState: rung.name };
  return {};
}

function fallbackInput(input, resolution) {
  const prior = resolution.signals && resolution.signals.priorApplied;
  const rung = previousRung(resolution);
  const signals = signalsForRung(rung);
  if (prior && (rung.name === 'repeat' || rung.name === 'repeat_exhausted')) signals.priorApplied = clone(prior);
  return {
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    ...(prior && (rung.name === 'repeat' || rung.name === 'repeat_exhausted') && prior.dispatch_id
      ? { previous_dispatch_id: prior.dispatch_id } : {}),
    signals,
    ...(input && input.gsd_role !== undefined ? { gsd_role: input.gsd_role } : {}),
  };
}

function snapshotFor(capabilities, resolution, context = {}) {
  const source = object(capabilities) ? capabilities : {};
  const predecessor = resolution && resolution.signals && resolution.signals.priorApplied;
  return {
    schema_version: SCHEMA_VERSION,
    runtime: resolution.runtime,
    backend: source.backend || resolution.backend || null,
    captured_at: new Date().toISOString(),
    supported_models: Array.isArray(source.supportedModels) ? [...source.supportedModels] : null,
    supported_efforts: Array.isArray(source.supportedEfforts) ? [...source.supportedEfforts] : null,
    ...(source.supportedSelections !== undefined ? { supported_selections: clone(source.supportedSelections) } : {}),
    launch_id: source.launch_id || resolution.dispatch_id,
    completed_attempt: Boolean(source.completed_attempt === true || (predecessor && predecessor.compliance === 'verified')),
    completed_attempt_id: source.completed_attempt_id || (predecessor && predecessor.launch_id) || null,
    dispatch_id: resolution.dispatch_id || null,
    source: source.source || 'runtime-host',
    ...(context && context.capability_evidence_id ? { evidence_id: context.capability_evidence_id } : {}),
  };
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  MODEL_AXIS_STATES,
  isModelAxisEscalation,
  requiresCompletedAttempt,
  normalizeSnapshot,
  evaluate,
  previousRung,
  signalsForRung,
  fallbackInput,
  snapshotFor,
});
