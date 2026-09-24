#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const policy = require('./model-policy.cjs');
const adapters = require('./runtime-adapters.cjs');

const SCHEMA = 'shipyard.run.v1';
const VERSION = 1;
const ID_SCHEMAS = Object.freeze({
  repository: 'shipyard.repository.v1',
  phase: 'shipyard.phase.v1',
  ticket: 'shipyard.ticket.v1',
  worktree: 'shipyard.worktree.v1',
  runtime: 'shipyard.runtime.v1',
  dispatch: 'shipyard.dispatch.v1',
  lease: 'shipyard.lease.v1',
  revision: 'shipyard.state-revision.v1',
  checkpoint: 'shipyard.checkpoint.v1',
  wake: 'shipyard.wake.v1',
  receipt: 'shipyard.receipt.v1',
  authority: 'shipyard.host-authority.v1',
});
const RUNTIMES = Object.freeze(['claude', 'codex']);
const PROVIDERS = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const STATES = Object.freeze([
  'created', 'running', 'waiting', 'runtime_unavailable', 'retryable',
  'human_checkpoint', 'completed', 'failed',
]);
const WAIT_KINDS = Object.freeze(['ci', 'review', 'quota', 'lease', 'host']);
const EFFORTS = Object.freeze([...policy.EFFORTS]);
const TERMINAL_STATES = new Set(['completed', 'failed']);
const TRANSITIONS = Object.freeze({
  created: Object.freeze(new Set(['running', 'human_checkpoint', 'failed'])),
  running: Object.freeze(new Set(['waiting', 'runtime_unavailable', 'retryable', 'human_checkpoint', 'completed', 'failed'])),
  waiting: Object.freeze(new Set(['running', 'runtime_unavailable', 'retryable', 'human_checkpoint', 'failed'])),
  runtime_unavailable: Object.freeze(new Set(['running', 'retryable', 'human_checkpoint', 'failed'])),
  retryable: Object.freeze(new Set(['running', 'waiting', 'runtime_unavailable', 'human_checkpoint', 'failed'])),
  human_checkpoint: Object.freeze(new Set(['running', 'completed', 'failed'])),
  completed: Object.freeze(new Set()),
  failed: Object.freeze(new Set()),
});
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'authority', 'host_authority', 'serialized_authority', 'owner_token', 'session_token',
  'launch_token', 'inherited_model', 'inherited_effort', 'parent_session', 'parent_session_id',
]);
const HOST_AUTHORITIES = new WeakSet();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contractError(code, message, details = {}) {
  const error = new Error(`run-contract: ${message}`);
  error.name = 'RunContractError';
  error.code = code;
  error.details = details;
  return error;
}

function refuse(code, message, details = {}) {
  throw contractError(code, message, details);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!object(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = clone(child);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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

function id(prefix) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${suffix}`;
}

function safeString(value, field, { whitespace = false, max = 512 } = {}) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_INPUT', `${field} must be a non-empty safe string`, { field });
  }
  const result = value.trim();
  if (!whitespace && /\s/.test(result)) refuse('INVALID_INPUT', `${field} must not contain whitespace`, { field });
  if (result.length > max) refuse('INVALID_INPUT', `${field} exceeds ${max} characters`, { field });
  return result;
}

function safeId(value, field) {
  return safeString(value, field, { whitespace: false });
}

function positiveInteger(value, field, { zero = false } = {}) {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (zero ? number < 0 : number < 1)) {
    refuse('INVALID_INPUT', `${field} must be a ${zero ? 'non-negative' : 'positive'} integer`, { field, value });
  }
  return number;
}

function digestValue(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    refuse('INVALID_INPUT', `${field} must be a SHA-256 fingerprint`, { field });
  }
  return value;
}

function rejectSerializedAuthority(value, field = 'input') {
  if (!object(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key) || /(?:serialized|host)[_-]?authority/i.test(key)) {
      refuse('SERIALIZED_AUTHORITY', `${field}.${key} cannot carry host authority through JSON`, { field, key });
    }
  }
}

function normalizeRuntime(value) {
  if (typeof value !== 'string' || !RUNTIMES.includes(value.trim())) {
    refuse('UNKNOWN_RUNTIME', `runtime must be exactly one of ${RUNTIMES.join(', ')}`, { runtime: value });
  }
  return value.trim();
}

function providerForRuntime(runtime) {
  return PROVIDERS[normalizeRuntime(runtime)];
}

function normalizeProvider(runtime, value) {
  const expected = providerForRuntime(runtime);
  if (value === undefined || value === null) return expected;
  if (typeof value !== 'string' || value.trim() !== expected) {
    refuse('RUNTIME_PROVIDER_MISMATCH', `runtime ${runtime} requires provider ${expected}`, {
      runtime, expected, provider: value,
    });
  }
  return expected;
}

function runtimeModels(runtime) {
  return runtime === 'codex' ? adapters.CODEX_MODEL_IDS : adapters.CLAUDE_MODEL_ALIASES;
}

function normalizeModel(runtime, value, field = 'model') {
  if (value === undefined || value === null) return { model_key: null, model: null };
  const selectedRuntime = normalizeRuntime(runtime);
  const map = runtimeModels(selectedRuntime);
  const entry = Object.entries(map).find(([key, native]) => key === value || native === value);
  if (entry) return { model_key: entry[0], model: entry[1] };
  const otherRuntime = RUNTIMES.find((candidate) => candidate !== selectedRuntime
    && Object.entries(runtimeModels(candidate)).some(([key, native]) => key === value || native === value));
  if (otherRuntime) {
    refuse('RUNTIME_MODEL_MISMATCH', `${field} belongs to ${otherRuntime}, not ${selectedRuntime}`, {
      runtime: selectedRuntime, model: value, other_runtime: otherRuntime,
    });
  }
  refuse('UNSUPPORTED_MODEL', `${field} is not registered for ${selectedRuntime}`, {
    runtime: selectedRuntime, model: value,
  });
}

function normalizeRole(value) {
  const role = safeId(value, 'role');
  if (!policy.ROLES.includes(role)) refuse('UNKNOWN_ROLE', `unknown delivery role ${role}`, { role });
  return role;
}

function normalizeEffort(value, field = 'effort') {
  if (value === undefined || value === null) return null;
  const effort = safeId(value, field);
  if (!EFFORTS.includes(effort)) refuse('UNSUPPORTED_EFFORT', `${field} is not supported`, { field, effort });
  return effort;
}

function normalizeRepositoryIdentity(input) {
  if (!object(input)) refuse('MISSING_SCOPE', 'repository identity is required');
  rejectSerializedAuthority(input, 'repository');
  const repository_id = safeString(input.repository_id || input.id, 'repository_id', { whitespace: true });
  const worktree = normalizeWorktreeIdentity(input.worktree || input.path);
  return deepFreeze({ schema: ID_SCHEMAS.repository, version: VERSION, repository_id, worktree: worktree.path });
}

function normalizePhaseIdentity(input) {
  const phase = object(input) ? input.phase : input;
  return deepFreeze({ schema: ID_SCHEMAS.phase, version: VERSION, phase: positiveInteger(phase, 'phase') });
}

function normalizeTicketIdentity(input, { role, phase } = {}) {
  const ticket = object(input) ? input.ticket : input;
  const value = safeId(ticket, 'ticket');
  const ticketId = /^T-[A-Z0-9][A-Z0-9._-]*$/i.test(value);
  const subject = value.match(/^phase=(\d+)-[A-Z0-9][A-Z0-9._-]*;repository=[^;\s]+;tickets=[a-f0-9]{64}$/i);
  const phaseSubject = role === 'integrator' && subject && Number(subject[1]) === Number(phase);
  if (!ticketId && !phaseSubject) {
    refuse('INVALID_INPUT', `ticket ${value} must use the T-... identifier form`, { ticket: value });
  }
  return deepFreeze({ schema: ID_SCHEMAS.ticket, version: VERSION, ticket: value });
}

function normalizeWorktreeIdentity(input) {
  const value = object(input) ? input.path || input.worktree : input;
  const worktree = safeString(value, 'worktree', { whitespace: true, max: 2048 });
  if (!path.isAbsolute(worktree)) refuse('INVALID_INPUT', 'worktree must be an absolute path', { worktree });
  return deepFreeze({ schema: ID_SCHEMAS.worktree, version: VERSION, path: path.normalize(worktree) });
}

function normalizeRuntimeIdentity(input, provider) {
  const runtime = normalizeRuntime(object(input) ? input.runtime : input);
  const inputProvider = object(input) ? input.provider : undefined;
  return deepFreeze({ schema: ID_SCHEMAS.runtime, version: VERSION, runtime, provider: normalizeProvider(runtime, provider || inputProvider) });
}

function normalizeRevisionIdentity(input) {
  const value = positiveInteger(object(input) ? input.value : input, 'state_revision', { zero: true });
  return deepFreeze({ schema: ID_SCHEMAS.revision, version: VERSION, value });
}

function normalizeDispatchIdentity(input) {
  if (!object(input)) refuse('MISSING_SCOPE', 'dispatch identity is required');
  rejectSerializedAuthority(input, 'dispatch');
  const runtimeIdentity = normalizeRuntimeIdentity(input.runtime, input.provider);
  const dispatch_id = safeId(input.dispatch_id || input.dispatchId, 'dispatch_id');
  const role = normalizeRole(input.role);
  const selection = normalizeModel(runtimeIdentity.runtime, input.model_key || input.model, 'dispatch.model');
  if (input.model_key !== undefined && input.model_key !== null) {
    const explicit = normalizeModel(runtimeIdentity.runtime, input.model_key, 'dispatch.model_key');
    if (selection.model_key !== explicit.model_key) refuse('RUNTIME_MODEL_MISMATCH', 'model and model_key disagree');
  }
  const policy_version = safeId(input.policy_version || input.policyVersion || policy.POLICY_VERSION, 'policy_version');
  const policy_hash = digestValue(input.policy_hash || input.policyHash || policy.POLICY_HASH, 'policy_hash');
  const launchValue = input.launch_id === undefined ? input.launchId : input.launch_id;
  const launch_id = launchValue === undefined || launchValue === null ? null : safeId(launchValue, 'launch_id');
  return deepFreeze({
    schema: ID_SCHEMAS.dispatch,
    version: VERSION,
    dispatch_id,
    role,
    runtime: runtimeIdentity.runtime,
    provider: runtimeIdentity.provider,
    model_key: selection.model_key,
    model: selection.model,
    effort: normalizeEffort(input.effort),
    policy_version,
    policy_hash,
    launch_id,
  });
}

function normalizeLeaseIdentity(input, runId, revision) {
  if (!object(input)) refuse('MISSING_SCOPE', 'lease identity is required');
  rejectSerializedAuthority(input, 'lease');
  const lease_id = safeId(input.lease_id || input.leaseId, 'lease_id');
  const owner_id = safeId(input.owner_id || input.ownerId, 'owner_id');
  const run_id = safeId(input.run_id || input.runId || runId, 'lease.run_id');
  if (runId && run_id !== runId) refuse('SCOPE_MISMATCH', 'lease belongs to another run', { run_id: runId, lease_run_id: run_id });
  const leaseRevision = normalizeRevisionIdentity(input.state_revision === undefined ? revision : input.state_revision);
  if (revision !== undefined && leaseRevision.value !== revision) refuse('STALE_REVISION', 'lease revision does not match run revision');
  const output = {
    schema: ID_SCHEMAS.lease,
    version: VERSION,
    lease_id,
    owner_id,
    run_id,
    state_revision: leaseRevision.value,
    acquired_at: input.acquired_at === undefined || input.acquired_at === null ? null : positiveInteger(input.acquired_at, 'lease.acquired_at', { zero: true }),
    expires_at: input.expires_at === undefined || input.expires_at === null ? null : positiveInteger(input.expires_at, 'lease.expires_at', { zero: true }),
  };
  if (output.expires_at !== null && output.acquired_at !== null && output.expires_at <= output.acquired_at) {
    refuse('INVALID_INPUT', 'lease.expires_at must be after lease.acquired_at');
  }
  return deepFreeze(output);
}

function normalizeCheckpointIdentity(input, runId, revision) {
  if (input === null || input === undefined) return null;
  if (!object(input)) refuse('INVALID_INPUT', 'checkpoint identity must be an object');
  rejectSerializedAuthority(input, 'checkpoint');
  const checkpoint_id = safeId(input.checkpoint_id || input.checkpointId, 'checkpoint_id');
  const checkpointRun = safeId(input.run_id || input.runId || runId, 'checkpoint.run_id');
  if (runId && checkpointRun !== runId) refuse('SCOPE_MISMATCH', 'checkpoint belongs to another run');
  const checkpointRevision = normalizeRevisionIdentity(input.state_revision === undefined ? revision : input.state_revision);
  if (revision !== undefined && checkpointRevision.value > revision) refuse('STALE_REVISION', 'checkpoint revision is ahead of the run');
  return deepFreeze({
    schema: ID_SCHEMAS.checkpoint,
    version: VERSION,
    checkpoint_id,
    run_id: checkpointRun,
    state_revision: checkpointRevision.value,
    kind: safeId(input.kind || 'resume', 'checkpoint.kind'),
    digest: input.digest === undefined || input.digest === null ? null : digestValue(input.digest, 'checkpoint.digest'),
  });
}

function normalizeWakeIdentity(input, runId, revision) {
  if (input === null || input === undefined) return null;
  if (!object(input)) refuse('INVALID_INPUT', 'wake identity must be an object');
  rejectSerializedAuthority(input, 'wake');
  const wake_id = safeId(input.wake_id || input.wakeId, 'wake_id');
  const wakeRun = safeId(input.run_id || input.runId || runId, 'wake.run_id');
  if (runId && wakeRun !== runId) refuse('SCOPE_MISMATCH', 'wake belongs to another run');
  const wakeRevision = normalizeRevisionIdentity(input.state_revision === undefined ? revision : input.state_revision);
  if (revision !== undefined && wakeRevision.value > revision) refuse('STALE_REVISION', 'wake revision is ahead of the run');
  const kind = safeId(input.kind, 'wake.kind');
  if (!WAIT_KINDS.includes(kind)) refuse('INVALID_INPUT', `wake.kind must be one of ${WAIT_KINDS.join(', ')}`);
  return deepFreeze({
    schema: ID_SCHEMAS.wake,
    version: VERSION,
    wake_id,
    run_id: wakeRun,
    state_revision: wakeRevision.value,
    kind,
    due_at: positiveInteger(input.due_at === undefined ? Date.now() : input.due_at, 'wake.due_at', { zero: true }),
    condition: input.condition === undefined ? null : safeString(input.condition, 'wake.condition', { whitespace: true, max: 2048 }),
  });
}

function normalizeReceiptIdentity(input) {
  if (!object(input)) refuse('INVALID_INPUT', 'receipt identity must be an object');
  rejectSerializedAuthority(input, 'receipt');
  const runtime = normalizeRuntime(input.runtime);
  const provider = normalizeProvider(runtime, input.provider);
  const receipt_id = safeId(input.receipt_id || input.receiptId, 'receipt_id');
  const run_id = safeId(input.run_id || input.runId, 'receipt.run_id');
  const dispatch_id = safeId(input.dispatch_id || input.dispatchId, 'receipt.dispatch_id');
  const models = {};
  for (const field of ['requested_model', 'applied_model', 'observed_model']) {
    const value = input[field];
    if (value === undefined || value === null || value === 'unknown' || value === 'unsupported') models[field] = value === undefined ? null : value;
    else models[field] = normalizeModel(runtime, value, `receipt.${field}`).model;
  }
  const efforts = {};
  for (const field of ['requested_effort', 'applied_effort', 'observed_effort']) {
    const value = input[field];
    efforts[field] = value === undefined || value === null || value === 'unknown' || value === 'unsupported'
      ? (value === undefined ? null : value) : normalizeEffort(value, `receipt.${field}`);
  }
  const status = safeId(input.status || 'unknown', 'receipt.status');
  if (!['verified', 'unknown', 'unsupported', 'refused'].includes(status)) refuse('INVALID_INPUT', 'receipt.status is invalid');
  const usage_status = safeId(input.usage_status || input.usageStatus || 'unknown', 'receipt.usage_status');
  if (!['unknown', 'pending', 'joined', 'unavailable'].includes(usage_status)) refuse('INVALID_INPUT', 'receipt.usage_status is invalid');
  const receiptLaunchValue = input.launch_id === undefined ? input.launchId : input.launch_id;
  return deepFreeze({
    schema: ID_SCHEMAS.receipt,
    version: VERSION,
    receipt_id,
    run_id,
    dispatch_id,
    runtime,
    provider,
    requested_model: models.requested_model,
    applied_model: models.applied_model,
    observed_model: models.observed_model,
    requested_effort: efforts.requested_effort,
    applied_effort: efforts.applied_effort,
    observed_effort: efforts.observed_effort,
    policy_version: safeId(input.policy_version || input.policyVersion || policy.POLICY_VERSION, 'receipt.policy_version'),
    policy_hash: digestValue(input.policy_hash || input.policyHash || policy.POLICY_HASH, 'receipt.policy_hash'),
    status,
    usage_status,
    launch_id: receiptLaunchValue === undefined || receiptLaunchValue === null
      ? null : safeId(receiptLaunchValue, 'receipt.launch_id'),
  });
}

function normalizeRunContract(input, { requireRunId = true } = {}) {
  if (!object(input)) refuse('INVALID_INPUT', 'run contract must be an object');
  rejectSerializedAuthority(input, 'run');
  const run_id = input.run_id || input.runId || (requireRunId ? null : id('run'));
  if (!run_id) refuse('MISSING_SCOPE', 'run_id is required');
  const repository = normalizeRepositoryIdentity(input.repository || {
    repository_id: input.repository_id,
    worktree: input.worktree && (input.worktree.path || input.worktree),
  });
  const phase = normalizePhaseIdentity(input.phase);
  const runtime = normalizeRuntimeIdentity(input.runtime);
  const dispatch = normalizeDispatchIdentity({ ...(input.dispatch || {}), runtime: runtime.runtime, provider: runtime.provider });
  const ticket = normalizeTicketIdentity(input.ticket, { role: dispatch.role, phase: phase.phase });
  const worktree = normalizeWorktreeIdentity(input.worktree || repository.worktree);
  if (worktree.path !== repository.worktree) refuse('SCOPE_MISMATCH', 'repository and worktree identities disagree');
  const state_revision = normalizeRevisionIdentity(input.state_revision === undefined ? 0 : input.state_revision);
  const lease = normalizeLeaseIdentity(input.lease, run_id, state_revision.value);
  const state = safeId(input.state || 'created', 'state');
  if (!STATES.includes(state)) refuse('INVALID_STATE', `unknown run state ${state}`);
  const wait_kind = input.wait_kind === undefined || input.wait_kind === null ? null : safeId(input.wait_kind, 'wait_kind');
  if (state === 'waiting' && !WAIT_KINDS.includes(wait_kind)) refuse('INVALID_STATE', 'waiting runs require a valid wait_kind');
  if (state !== 'waiting' && wait_kind !== null) refuse('INVALID_STATE', 'wait_kind is only valid for waiting runs');
  const checkpoint = normalizeCheckpointIdentity(input.checkpoint, run_id, state_revision.value);
  const wake = normalizeWakeIdentity(input.wake, run_id, state_revision.value);
  const eventLog = Array.isArray(input.event_log || input.eventLog) ? (input.event_log || input.eventLog) : [];
  const eventIds = Array.isArray(input.applied_event_ids || input.appliedEventIds)
    ? (input.applied_event_ids || input.appliedEventIds) : eventLog.map((entry) => entry.event_id);
  const effectIds = Array.isArray(input.applied_effect_ids || input.appliedEffectIds)
    ? (input.applied_effect_ids || input.appliedEffectIds) : eventLog.map((entry) => entry.effect_id).filter(Boolean);
  if (new Set(eventIds).size !== eventIds.length || new Set(effectIds).size !== effectIds.length) {
    refuse('DUPLICATE_EFFECT', 'run contract contains duplicate event or effect identities');
  }
  const normalizedEvents = eventLog.map((entry) => {
    if (!object(entry)) refuse('INVALID_INPUT', 'event_log entries must be objects');
    return deepFreeze({
      event_id: safeId(entry.event_id, 'event_id'),
      effect_id: entry.effect_id === null || entry.effect_id === undefined ? null : safeId(entry.effect_id, 'effect_id'),
      from: safeId(entry.from, 'event.from'),
      to: safeId(entry.to, 'event.to'),
      wait_kind: entry.wait_kind || null,
      event_fingerprint: digestValue(entry.event_fingerprint, 'event_fingerprint'),
      effect_fingerprint: digestValue(entry.effect_fingerprint, 'effect_fingerprint'),
    });
  });
  const normalizedEventIds = normalizedEvents.map((entry) => entry.event_id);
  const normalizedEffectIds = normalizedEvents.map((entry) => entry.effect_id).filter(Boolean);
  if (stable(normalizedEventIds) !== stable(eventIds) || stable(normalizedEffectIds) !== stable(effectIds)) {
    refuse('INVALID_INPUT', 'event identity indexes do not match event_log');
  }
  const result = {
    schema: SCHEMA,
    version: VERSION,
    run_id: safeId(run_id, 'run_id'),
    repository,
    phase,
    ticket,
    worktree,
    runtime,
    dispatch,
    lease,
    state_revision,
    state,
    wait_kind,
    checkpoint,
    wake,
    event_log: normalizedEvents,
    applied_event_ids: normalizedEventIds,
    applied_effect_ids: normalizedEffectIds,
  };
  return deepFreeze(result);
}

function createHostAuthority(input = {}) {
  if (!object(input)) refuse('INVALID_INPUT', 'host authority options must be an object');
  const authority = {
    schema: ID_SCHEMAS.authority,
    version: VERSION,
    run_id: safeId(input.run_id || input.runId, 'authority.run_id'),
    owner_id: safeId(input.owner_id || input.ownerId, 'authority.owner_id'),
  };
  Object.defineProperty(authority, 'token', {
    value: id('authority'), enumerable: false, writable: false, configurable: false,
  });
  HOST_AUTHORITIES.add(authority);
  return Object.freeze(authority);
}

function assertHostAuthority(value, expected = {}) {
  if (!HOST_AUTHORITIES.has(value)) refuse('SERIALIZED_AUTHORITY', 'host authority must remain process-local');
  if (expected.run_id && value.run_id !== expected.run_id) refuse('SCOPE_MISMATCH', 'host authority belongs to another run');
  if (expected.owner_id && value.owner_id !== expected.owner_id) refuse('SESSION_FENCED', 'host authority belongs to another owner');
  return value;
}

function eventFingerprint(event) {
  return digest({
    event_id: event.event_id,
    expected_revision: event.expected_revision,
    effect_id: event.effect_id || null,
    to: event.to,
    wait_kind: event.wait_kind || null,
    checkpoint_id: event.checkpoint_id || null,
    wake_id: event.wake_id || null,
    reason: event.reason || null,
  });
}

function effectFingerprint(event) {
  return digest({
    effect_id: event.effect_id || null,
    to: event.to,
    wait_kind: event.wait_kind || null,
    checkpoint_id: event.checkpoint_id || null,
    wake_id: event.wake_id || null,
    reason: event.reason || null,
  });
}

function applyEvent(current, rawEvent, authority) {
  const contract = normalizeRunContract(current);
  assertHostAuthority(authority, { run_id: contract.run_id, owner_id: contract.lease.owner_id });
  if (!object(rawEvent)) refuse('INVALID_INPUT', 'run event must be an object');
  rejectSerializedAuthority(rawEvent, 'event');
  const event = {
    event_id: safeId(rawEvent.event_id || rawEvent.eventId, 'event_id'),
    effect_id: rawEvent.effect_id || rawEvent.effectId ? safeId(rawEvent.effect_id || rawEvent.effectId, 'effect_id') : null,
    expected_revision: positiveInteger(rawEvent.expected_revision === undefined ? rawEvent.expectedRevision : rawEvent.expected_revision, 'expected_revision', { zero: true }),
    to: safeId(rawEvent.to, 'event.to'),
    wait_kind: rawEvent.wait_kind || rawEvent.waitKind || null,
    checkpoint_id: rawEvent.checkpoint_id || rawEvent.checkpointId || null,
    wake_id: rawEvent.wake_id || rawEvent.wakeId || null,
    reason: rawEvent.reason === undefined || rawEvent.reason === null
      ? null : safeString(rawEvent.reason, 'event.reason', { whitespace: true, max: 2048 }),
  };
  if (!STATES.includes(event.to)) refuse('INVALID_STATE', `unknown target state ${event.to}`);
  if (event.to === 'waiting') {
    if (!WAIT_KINDS.includes(event.wait_kind)) refuse('INVALID_STATE', 'waiting transitions require a valid wait_kind');
  } else if (event.wait_kind !== null) {
    refuse('INVALID_STATE', 'wait_kind is only valid for waiting transitions');
  }
  const nextEventFingerprint = eventFingerprint(event);
  const nextEffectFingerprint = effectFingerprint(event);
  const existingEvent = contract.event_log.find((entry) => entry.event_id === event.event_id);
  if (existingEvent) {
    if (existingEvent.event_fingerprint !== nextEventFingerprint) {
      refuse('DUPLICATE_EVENT', `event ${event.event_id} was already applied with a different effect`);
    }
    return Object.freeze({ contract, applied: false, idempotent: true, reason: 'duplicate-event' });
  }
  const existingEffect = event.effect_id && contract.event_log.find((entry) => entry.effect_id === event.effect_id);
  if (existingEffect) {
    if (existingEffect.effect_fingerprint !== nextEffectFingerprint) {
      refuse('DUPLICATE_EFFECT', `effect ${event.effect_id} was already applied with a different transition`);
    }
    return Object.freeze({ contract, applied: false, idempotent: true, reason: 'duplicate-effect' });
  }
  if (event.expected_revision !== contract.state_revision.value) {
    refuse('STALE_REVISION', `expected revision ${event.expected_revision}, current revision ${contract.state_revision.value}`, {
      expected_revision: event.expected_revision,
      current_revision: contract.state_revision.value,
    });
  }
  if (!TRANSITIONS[contract.state].has(event.to)) {
    refuse('INVALID_TRANSITION', `${contract.state} cannot transition to ${event.to}`, {
      from: contract.state, to: event.to,
    });
  }
  const eventRecord = {
    event_id: event.event_id,
    effect_id: event.effect_id,
    from: contract.state,
    to: event.to,
    wait_kind: event.wait_kind,
    event_fingerprint: nextEventFingerprint,
    effect_fingerprint: nextEffectFingerprint,
  };
  const nextRevision = contract.state_revision.value + 1;
  const next = {
    ...clone(contract),
    state_revision: { ...contract.state_revision, value: nextRevision },
    lease: { ...contract.lease, state_revision: nextRevision },
    state: event.to,
    wait_kind: event.to === 'waiting' ? event.wait_kind : null,
    checkpoint: event.checkpoint_id ? normalizeCheckpointIdentity({
      checkpoint_id: event.checkpoint_id, run_id: contract.run_id,
      state_revision: nextRevision, kind: event.to === 'human_checkpoint' ? 'human' : 'resume',
    }, contract.run_id, nextRevision) : event.to === 'running' ? null : contract.checkpoint,
    wake: event.wake_id ? normalizeWakeIdentity({
      wake_id: event.wake_id, run_id: contract.run_id, state_revision: nextRevision,
      kind: event.wait_kind, due_at: Date.now(), condition: event.reason || 'run continuation',
    }, contract.run_id, nextRevision) : event.to === 'waiting' ? contract.wake : null,
    event_log: [...contract.event_log.map(clone), eventRecord],
    applied_event_ids: [...contract.applied_event_ids, event.event_id],
    applied_effect_ids: event.effect_id ? [...contract.applied_effect_ids, event.effect_id] : [...contract.applied_effect_ids],
  };
  return Object.freeze({ contract: normalizeRunContract(next), applied: true, idempotent: false, event: eventRecord });
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  ID_SCHEMAS,
  RUNTIMES,
  PROVIDERS,
  STATES,
  WAIT_KINDS,
  EFFORTS,
  TERMINAL_STATES: Object.freeze([...TERMINAL_STATES]),
  TRANSITIONS,
  contractError,
  normalizeRepositoryIdentity,
  normalizePhaseIdentity,
  normalizeTicketIdentity,
  normalizeWorktreeIdentity,
  normalizeRuntimeIdentity,
  normalizeRevisionIdentity,
  normalizeDispatchIdentity,
  normalizeLeaseIdentity,
  normalizeCheckpointIdentity,
  normalizeWakeIdentity,
  normalizeReceiptIdentity,
  normalizeRunContract,
  rejectSerializedAuthority,
  createHostAuthority,
  assertHostAuthority,
  applyEvent,
  digest,
  id,
});
