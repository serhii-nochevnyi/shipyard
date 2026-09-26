#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const contract = require('./run-contract.cjs');
const { createRunStore } = require('./run-store.cjs');

const SCHEMA = 'shipyard.run-controller.v1';
const VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
const MAX_REASON_LENGTH = 2048;
const SAFE_STATES = new Set(['waiting', 'runtime_unavailable', 'retryable']);
const TERMINAL_STATES = new Set(['completed', 'failed']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function controllerError(code, message, details = {}) {
  const result = new Error(`run-controller: ${message}`);
  result.name = 'RunControllerError';
  result.code = code;
  result.details = details;
  return result;
}

function refuse(code, message, details = {}) {
  throw controllerError(code, message, details);
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
  return safeString(value, field, { whitespace: false, max: 512 });
}

function integer(value, field, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || (zero ? value < 0 : value < 1)) {
    refuse('INVALID_INPUT', `${field} must be a ${zero ? 'non-negative' : 'positive'} integer`, { field, value });
  }
  return value;
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

function nowValue(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) refuse('INVALID_INPUT', 'clock must return a non-negative safe integer');
  return value;
}

function rejectAuthority(value, field = 'value', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) refuse('INVALID_INPUT', `${field} contains a cyclic value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'authority' || key === 'host_authority' || key === 'serialized_authority'
      || /(?:serialized|host)[_-]?authority/i.test(key)) {
      refuse('SERIALIZED_AUTHORITY', `${field}.${key} cannot cross the controller boundary`);
    }
    rejectAuthority(child, `${field}.${key}`, seen);
  }
  seen.delete(value);
}

function runIdFrom(value) {
  if (typeof value === 'string') return safeId(value, 'run_id');
  if (object(value)) return safeId(value.run_id || value.runId || value.run && value.run.run_id, 'run_id');
  refuse('MISSING_SCOPE', 'run_id is required');
}

function scopeView(run) {
  return {
    repository: clone(run.repository),
    phase: clone(run.phase),
    ticket: clone(run.ticket),
    worktree: clone(run.worktree),
    runtime: clone(run.runtime),
    dispatch: clone(run.dispatch),
  };
}

function sameScope(left, right) {
  return stable(scopeView(left)) === stable(scopeView(right));
}

function leaseId() {
  return contract.id('lease');
}

function operationInput(input = {}) {
  if (!object(input)) return input;
  const result = clone(input);
  for (const key of ['event_id', 'eventId', 'effect_id', 'effectId', 'idempotency_key', 'idempotencyKey']) delete result[key];
  delete result.revalidate;
  return result;
}

function operationKey(action, runId, input = {}) {
  if (object(input)) {
    const explicit = input.idempotency_key || input.idempotencyKey || input.event_id || input.eventId;
    if (explicit) return safeId(explicit, `${action}.idempotency_key`);
  }
  return safeId(`${action}:${runId}`, `${action}.idempotency_key`);
}

function operationFingerprint(action, input = {}) {
  return digest({ action, input: operationInput(input) });
}

function reasonValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return safeString(value, 'reason', { whitespace: true, max: MAX_REASON_LENGTH });
}

function statusFor(record, now) {
  const expired = record.owner.status === 'active' && record.owner.expires_at <= now;
  return {
    schema: 'shipyard.run-status.v1',
    version: VERSION,
    run_id: record.run.run_id,
    state: record.run.state,
    wait_kind: record.run.wait_kind,
    state_revision: record.run.state_revision.value,
    scope: scopeView(record.run),
    owner: {
      owner_id: record.owner.owner_id,
      lease_id: record.owner.lease_id,
      epoch: record.owner.epoch,
      status: expired ? 'expired' : record.owner.status,
      acquired_at: record.owner.acquired_at,
      heartbeat_at: record.owner.heartbeat_at,
      expires_at: record.owner.expires_at,
      expired,
    },
    retry: clone(record.retry),
    checkpoint: clone(record.checkpoint),
    successor: clone(record.successor),
    recoverable: Boolean((record.checkpoint && !record.checkpoint.resumed_at)
      || record.run.state === 'runtime_unavailable' || record.run.state === 'retryable'),
  };
}

function publicResult(record, now, action, applied, idempotent, result = null) {
  const status = statusFor(record, now);
  return Object.freeze({
    schema: 'shipyard.run-controller-result.v1',
    version: VERSION,
    action,
    run_id: record.run.run_id,
    applied: Boolean(applied),
    idempotent: Boolean(idempotent),
    state: record.run.state,
    state_revision: record.run.state_revision.value,
    run: clone(record.run),
    status,
    result: clone(result),
  });
}

function rebindLease(run, ownerId, newLeaseId, now, expiresAt) {
  return contract.normalizeRunContract({
    ...clone(run),
    lease: {
      ...clone(run.lease),
      lease_id: newLeaseId,
      owner_id: ownerId,
      acquired_at: now,
      expires_at: expiresAt,
      state_revision: run.state_revision.value,
    },
  });
}

function normalizeResumeData(input = {}) {
  if (!object(input)) refuse('INVALID_INPUT', 'checkpoint data must be an object');
  rejectAuthority(input, 'checkpoint');
  const allowed = new Set(['head', 'base', 'worktree', 'clean', 'children', 'active_child', 'children_unknown', 'pr', 'checks', 'review', 'payload']);
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (['head', 'base', 'worktree', 'pr'].includes(key) && value !== null && value !== undefined) {
      output[key] = safeString(String(value), `checkpoint.${key}`, { whitespace: true, max: 2048 });
    } else if (key === 'children') {
      if (!Array.isArray(value) || value.length > 128) refuse('INVALID_INPUT', 'checkpoint.children must be a bounded array');
      output[key] = value.map((child, index) => safeId(child, `checkpoint.children[${index}]`));
    } else if (key === 'checks' || key === 'review' || key === 'payload') {
      if (!object(value)) refuse('INVALID_INPUT', `checkpoint.${key} must be an object`);
      output[key] = clone(value);
    } else if (key === 'clean' || key === 'active_child' || key === 'children_unknown') {
      if (typeof value !== 'boolean') refuse('INVALID_INPUT', `checkpoint.${key} must be boolean`);
      output[key] = value;
    }
  }
  if (Buffer.byteLength(stable(output), 'utf8') > 16384) refuse('INVALID_INPUT', 'checkpoint data exceeds 16KiB');
  return output;
}

function resumeEvidence(checkpoint, input) {
  const source = typeof input.revalidate === 'function'
    ? input.revalidate(clone(checkpoint && checkpoint.resume_data || {}))
    : input.evidence || input.revalidation;
  if (!object(source)) refuse('REVALIDATION_REQUIRED', 'resume requires live revalidation evidence');
  rejectAuthority(source, 'revalidation');
  if (Buffer.byteLength(stable(source), 'utf8') > 16384) refuse('INVALID_INPUT', 'revalidation evidence exceeds 16KiB');
  if (source.clean !== true) refuse('DIRTY_WORK', 'resume is blocked because owned worktree cleanliness is not proven');
  if (source.children_unknown === true || source.unknown_children === true) refuse('ACTIVE_CHILD_UNKNOWN', 'resume is blocked because child enumeration is unknown');
  if (!Array.isArray(source.children) && source.active_child !== false) refuse('ACTIVE_CHILD_UNKNOWN', 'resume is blocked because child enumeration is missing');
  if (source.active_child === true || Array.isArray(source.children) && source.children.length) refuse('ACTIVE_CHILDREN', 'resume is blocked by an active child');
  if (source.changed_head === true || source.changed_base === true || source.changed_pr_head === true) refuse('LIVE_STATE_STALE', 'resume is blocked because live repository state changed');
  const data = checkpoint && checkpoint.resume_data || {};
  const liveHead = source.head === undefined || source.head === null ? source.pr_head : source.head;
  const liveBase = source.base === undefined || source.base === null ? source.base_ref : source.base;
  if (data.head !== undefined && data.head !== null && (liveHead === undefined || liveHead === null || String(data.head) !== String(liveHead))) {
    refuse('LIVE_STATE_STALE', 'resume is blocked because the PR head differs from the checkpoint');
  }
  if (data.base !== undefined && data.base !== null && (liveBase === undefined || liveBase === null || String(data.base) !== String(liveBase))) {
    refuse('LIVE_STATE_STALE', 'resume is blocked because the base differs from the checkpoint');
  }
  if (data.worktree !== undefined && data.worktree !== null && source.worktree !== undefined && source.worktree !== null
      && String(data.worktree) !== String(source.worktree)) {
    refuse('LIVE_STATE_STALE', 'resume is blocked because the worktree differs from the checkpoint');
  }
  if (data.worktree !== undefined && data.worktree !== null && (source.worktree === undefined || source.worktree === null)) {
    refuse('LIVE_STATE_STALE', 'resume is blocked because the live worktree is not proven');
  }
  return clone(source);
}

function createRunController(options = {}) {
  if (!object(options)) refuse('INVALID_INPUT', 'controller options must be an object');
  const clock = options.now || options.clock || (() => Date.now());
  const store = options.store || createRunStore({ ...options, now: clock });
  const ownerId = safeId(options.owner_id || options.ownerId || `owner-${process.pid}-${crypto.randomBytes(6).toString('hex')}`, 'owner_id');
  const leaseTtlMs = Number.isSafeInteger(options.leaseTtlMs) && options.leaseTtlMs > 0 ? options.leaseTtlMs : DEFAULT_LEASE_TTL_MS;
  const retryLimit = Number.isSafeInteger(options.retryLimit) && options.retryLimit > 0 ? options.retryLimit : DEFAULT_RETRY_LIMIT;
  const retryBackoffMs = Number.isSafeInteger(options.retryBackoffMs) && options.retryBackoffMs >= 0 ? options.retryBackoffMs : DEFAULT_RETRY_BACKOFF_MS;
  const authorities = new Map();

  function authorityFor(runId) {
    const value = authorities.get(runId);
    return value && value.authority;
  }

  function saveAuthority(runId, authority, leaseId, epoch) {
    authorities.set(runId, { authority, lease_id: leaseId, epoch });
    return authority;
  }

  function handleFor(record) {
    const value = {
      run_id: record.run.run_id,
      owner_id: record.owner.owner_id,
      lease_id: record.owner.lease_id,
      epoch: record.owner.epoch,
    };
    const authority = authorityFor(record.run.run_id);
    if (authority) Object.defineProperty(value, 'authority', { value: authority, enumerable: false });
    return Object.freeze(value);
  }

  function currentSession(record, now, { allowCheckpointed = false } = {}) {
    const session = authorities.get(record.run.run_id);
    if (!session) refuse('HOST_AUTHORITY_REQUIRED', 'the controller has no process-local host authority for this run');
    contract.assertHostAuthority(session.authority, { run_id: record.run.run_id, owner_id: record.owner.owner_id });
    if (session.lease_id !== record.owner.lease_id || session.epoch !== record.owner.epoch || record.owner.owner_id !== ownerId) {
      refuse('SESSION_FENCED', 'the run lease belongs to another owner or epoch');
    }
    if (record.owner.status === 'active' && record.owner.expires_at <= now) {
      refuse('LEASE_EXPIRED', 'the run lease has expired');
    }
    if (!allowCheckpointed && record.owner.status !== 'active') {
      refuse('SESSION_FENCED', `the run owner is ${record.owner.status}`);
    }
    return session;
  }

  function remember(record, key, action, input, result) {
    const fingerprint = operationFingerprint(action, input);
    const existing = record.idempotency[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.action !== action) {
        refuse('DUPLICATE_EVENT', `idempotency key ${key} was already used for another operation`);
      }
      return { hit: true, fingerprint, result: clone(existing.result) };
    }
    return { hit: false, fingerprint, result: clone(result) };
  }

  function recordOperation(record, key, action, fingerprint, result, now) {
    record.idempotency[key] = {
      action,
      fingerprint,
      revision: record.run.state_revision.value,
      result: clone(result),
    };
    const keys = Object.keys(record.idempotency);
    if (keys.length > 512) delete record.idempotency[keys[0]];
    record.history.push({ event: action, run_id: record.run.run_id, revision: record.run.state_revision.value, at: now, key });
    if (record.history.length > 512) record.history = record.history.slice(-512);
  }

  function finish(runId, action, applied, idempotent, result) {
    const record = store.get(runId);
    if (!record) refuse('RUN_NOT_FOUND', `run ${runId} does not exist`);
    return publicResult(record, nowValue(clock), action, applied, idempotent, result);
  }

  function ownedOperation(runIdInput, action, input, mutator, { allowCheckpointed = false } = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForOperation = object(input) ? input : {};
    const key = operationKey(action, runId, optionsForOperation);
    let applied = false;
    let idempotent = false;
    let result = null;
    store.transaction(runId, (record, now) => {
      const remembered = remember(record, key, action, optionsForOperation, null);
      if (remembered.hit) {
        idempotent = true;
        result = remembered.result;
        return;
      }
      currentSession(record, now, { allowCheckpointed });
      result = mutator(record, now, authorityFor(runId));
      recordOperation(record, key, action, remembered.fingerprint, result, now);
      applied = true;
    });
    return finish(runId, action, applied, idempotent, result);
  }

  function begin(input = {}, optionsForBegin = {}) {
    const source = input && input.run ? input.run : input;
    const beginOptions = object(optionsForBegin) ? optionsForBegin : {};
    rejectAuthority(beginOptions, 'begin');
    const initial = contract.normalizeRunContract(source);
    const runId = initial.run_id;
    if (TERMINAL_STATES.has(initial.state)) refuse('RUN_TERMINAL', `cannot begin a ${initial.state} run`);
    const key = safeId(
      beginOptions.idempotency_key || beginOptions.idempotencyKey || beginOptions.event_id || beginOptions.eventId
        || `begin:${runId}:${ownerId}`,
      'begin.idempotency_key',
    );
    const fingerprint = operationFingerprint('begin', beginOptions);
    const now = nowValue(clock);
    const nextLeaseId = leaseId();
    const authority = contract.createHostAuthority({ run_id: runId, owner_id: ownerId });
    let applied = false;
    let idempotent = false;
    let result = null;
    store.transact((state, timestamp) => {
      const existing = state.runs[runId];
      if (existing) {
        if (!sameScope(existing.run, initial)) refuse('SCOPE_MISMATCH', 'begin scope differs from the persisted run scope');
        const remembered = remember(existing, key, 'begin', optionsForBegin, null);
        if (remembered.hit && existing.owner.status === 'active' && existing.owner.expires_at > timestamp) {
          if (existing.owner.owner_id !== ownerId) refuse('RUN_LEASE_HELD', `run ${runId} is owned by ${existing.owner.owner_id}`);
          const current = authorities.get(runId);
          if (!current || current.lease_id !== existing.owner.lease_id || current.epoch !== existing.owner.epoch) {
            refuse('HOST_AUTHORITY_REQUIRED', 'the active run owner cannot be reconstructed from serialized state');
          }
          idempotent = true;
          result = remembered.result;
          return;
        }
        if (existing.owner.status === 'active' && existing.owner.expires_at > timestamp) {
          refuse('RUN_LEASE_HELD', `run ${runId} is owned by ${existing.owner.owner_id}`);
        }
        if (TERMINAL_STATES.has(existing.run.state)) refuse('RUN_TERMINAL', `cannot begin a ${existing.run.state} run`);
        if (existing.run.state === 'human_checkpoint' || existing.checkpoint && !existing.checkpoint.resumed_at) {
          refuse('CHECKPOINT_REQUIRED', 'a checkpointed run must resume through live revalidation');
        }
        const rebound = rebindLease(existing.run, ownerId, nextLeaseId, timestamp, timestamp + leaseTtlMs);
        existing.run = rebound;
        existing.owner = {
          owner_id: ownerId, lease_id: nextLeaseId, epoch: existing.owner.epoch + 1,
          acquired_at: timestamp, heartbeat_at: timestamp, expires_at: timestamp + leaseTtlMs, status: 'active',
        };
        saveAuthority(runId, authority, nextLeaseId, existing.owner.epoch);
        if (existing.run.state === 'created') {
          const started = contract.applyEvent(existing.run, {
            event_id: `begin:${runId}:${ownerId}`,
            effect_id: key,
            expected_revision: existing.run.state_revision.value,
            to: 'running',
          }, authority);
          existing.run = started.contract;
        }
        recordOperation(existing, key, 'begin', fingerprint, { lease_id: nextLeaseId, epoch: existing.owner.epoch }, timestamp);
        applied = true;
        result = { lease_id: nextLeaseId, epoch: existing.owner.epoch };
        return;
      }
      const prepared = rebindLease(initial, ownerId, nextLeaseId, timestamp, timestamp + leaseTtlMs);
      const record = {
        schema: 'shipyard.run-record.v1', version: 1, run: prepared,
        owner: {
          owner_id: ownerId, lease_id: nextLeaseId, epoch: 0,
          acquired_at: timestamp, heartbeat_at: timestamp, expires_at: timestamp + leaseTtlMs, status: 'active',
        },
        retry: { attempts: 0, max_attempts: retryLimit, backoff_ms: retryBackoffMs, next_at: null, capability_recheck_at: null, last_reason: null, state: null, condition: null, exhausted: false },
        checkpoint: null, successor: null, idempotency: {}, history: [],
      };
      saveAuthority(runId, authority, nextLeaseId, 0);
      if (record.run.state === 'created') {
        const started = contract.applyEvent(record.run, {
          event_id: `begin:${runId}:${ownerId}`,
          effect_id: key,
          expected_revision: record.run.state_revision.value,
          to: 'running',
        }, authority);
        record.run = started.contract;
      }
      recordOperation(record, key, 'begin', fingerprint, { lease_id: nextLeaseId, epoch: 0 }, timestamp);
      state.runs[runId] = record;
      applied = true;
      result = { lease_id: nextLeaseId, epoch: 0 };
    });
    if (!applied && idempotent && !authorities.has(runId)) {
      const record = store.get(runId);
      if (record && record.owner.owner_id === ownerId && record.owner.status === 'active' && record.owner.expires_at > now) {
        saveAuthority(runId, contract.createHostAuthority({ run_id: runId, owner_id: ownerId }), record.owner.lease_id, record.owner.epoch);
      }
    }
    return finish(runId, 'begin', applied, idempotent, result);
  }

  function start(runIdInput, optionsForStart = {}) {
    const runId = runIdFrom(runIdInput);
    const startOptions = object(optionsForStart) ? optionsForStart : {};
    rejectAuthority(startOptions, 'start');
    return ownedOperation(runId, 'start', startOptions, (record, now, authority) => {
      if (record.run.state === 'running') return { state: 'running', already_running: true };
      const event = contract.applyEvent(record.run, {
        event_id: startOptions.event_id || `start:${runId}`,
        effect_id: startOptions.effect_id || null,
        expected_revision: record.run.state_revision.value,
        to: 'running',
      }, authority);
      record.run = event.contract;
      return { state: record.run.state };
    });
  }

  function heartbeat(runIdInput) {
    const runId = runIdFrom(runIdInput);
    let result;
    store.transaction(runId, (record, now) => {
      currentSession(record, now);
      record.owner.heartbeat_at = now;
      record.owner.expires_at = now + leaseTtlMs;
      result = { renewed: true, run_id: runId, expires_at: record.owner.expires_at };
    });
    return finish(runId, 'heartbeat', true, false, result);
  }

  function release(runIdInput, reason = 'owner released the run') {
    const runId = runIdFrom(runIdInput);
    let result;
    store.transaction(runId, (record, now) => {
      currentSession(record, now, { allowCheckpointed: true });
      if (record.owner.status === 'released') { result = { released: true }; return; }
      record.owner.status = 'released';
      record.owner.expires_at = now;
      record.history.push({ event: 'release', run_id: runId, revision: record.run.state_revision.value, at: now, reason: reasonValue(reason, 'owner released the run') });
      result = { released: true };
    });
    authorities.delete(runId);
    return finish(runId, 'release', true, false, result);
  }

  function wait(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForWait = object(input) ? input : {};
    const waitKind = safeId(optionsForWait.wait_kind || optionsForWait.waitKind || optionsForWait.kind, 'wait_kind');
    if (!contract.WAIT_KINDS.includes(waitKind)) refuse('INVALID_INPUT', `wait_kind ${waitKind} is not supported`);
    const wakeId = optionsForWait.wake_id || optionsForWait.wakeId || contract.id('wake');
    const dueAt = optionsForWait.due_at === undefined ? nowValue(clock) : integer(optionsForWait.due_at, 'due_at', { zero: true });
    const condition = reasonValue(optionsForWait.condition || optionsForWait.reason, `${waitKind}-ready`);
    return ownedOperation(runId, 'wait', optionsForWait, (record, now, authority) => {
      const event = contract.applyEvent(record.run, {
        event_id: optionsForWait.event_id || optionsForWait.eventId || `wait:${runId}`,
        effect_id: optionsForWait.effect_id || optionsForWait.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: 'waiting', wait_kind: waitKind, wake_id: wakeId, reason: condition,
      }, authority);
      record.run = contract.normalizeRunContract({
        ...clone(event.contract),
        wake: { ...clone(event.contract.wake), due_at: dueAt, condition },
      });
      return { wake_id: wakeId, due_at: dueAt, condition };
    });
  }

  function wake(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForWake = object(input) ? input : {};
    return ownedOperation(runId, 'wake', optionsForWake, (record, now, authority) => {
      if (record.run.wake && optionsForWake.wake_id && record.run.wake.wake_id !== optionsForWake.wake_id) {
        refuse('SCOPE_MISMATCH', 'wake belongs to another run condition');
      }
      if (record.retry.exhausted && optionsForWake.force !== true) {
        refuse('RETRY_EXHAUSTED', 'the retry budget is exhausted');
      }
      if (record.retry.next_at !== null && record.retry.next_at > now && optionsForWake.force !== true) {
        refuse('RETRY_NOT_DUE', `retry is not due until ${record.retry.next_at}`, { next_at: record.retry.next_at });
      }
      const event = contract.applyEvent(record.run, {
        event_id: optionsForWake.event_id || optionsForWake.eventId || `wake:${runId}`,
        effect_id: optionsForWake.effect_id || optionsForWake.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: 'running',
        reason: optionsForWake.reason === undefined ? null : reasonValue(optionsForWake.reason, null),
      }, authority);
      record.run = event.contract;
      record.retry.next_at = null;
      record.retry.capability_recheck_at = null;
      record.retry.condition = null;
      record.retry.state = null;
      return { woken: true };
    });
  }

  function retry(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForRetry = object(input) ? input : {};
    const target = optionsForRetry.target_state || optionsForRetry.state
      || (optionsForRetry.runtime_unavailable === true || optionsForRetry.host_unavailable === true ? 'runtime_unavailable' : 'retryable');
    if (!SAFE_STATES.has(target) || target === 'waiting') refuse('INVALID_INPUT', `retry target ${target} is not supported`);
    const reason = reasonValue(optionsForRetry.reason, target === 'runtime_unavailable' ? 'runtime unavailable' : 'retryable host failure');
    const delay = optionsForRetry.delay_ms === undefined ? retryBackoffMs : integer(optionsForRetry.delay_ms, 'delay_ms', { zero: true });
    const recheckDelay = optionsForRetry.capability_recheck_ms === undefined ? delay : integer(optionsForRetry.capability_recheck_ms, 'capability_recheck_ms', { zero: true });
    return ownedOperation(runId, 'retry', optionsForRetry, (record, now, authority) => {
      if (record.run.state === target) {
        record.retry.last_reason = reason;
        record.retry.condition = `retry-at:${record.retry.next_at === null ? now : record.retry.next_at}`;
        return { scheduled: true, already_in_state: true, target_state: target, next_at: record.retry.next_at };
      }
      const attempts = record.retry.attempts + 1;
      const exhausted = attempts >= record.retry.max_attempts;
      const nextAt = exhausted ? null : now + delay;
      const event = contract.applyEvent(record.run, {
        event_id: optionsForRetry.event_id || optionsForRetry.eventId || `retry:${runId}`,
        effect_id: optionsForRetry.effect_id || optionsForRetry.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: target,
        reason,
      }, authority);
      record.run = event.contract;
      record.retry = {
        ...record.retry,
        attempts,
        next_at: nextAt,
        capability_recheck_at: exhausted ? null : now + recheckDelay,
        last_reason: reason,
        state: target,
        condition: exhausted ? 'retry-cap-exhausted' : `retry-at:${nextAt}`,
        exhausted,
      };
      return { scheduled: true, target_state: target, attempts, next_at: nextAt, exhausted };
    });
  }

  function markUnavailable(runIdInput, input = {}) {
    return retry(runIdInput, { ...(object(input) ? input : {}), target_state: 'runtime_unavailable', runtime_unavailable: true });
  }

  function checkpoint(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForCheckpoint = object(input) ? input : {};
    const data = normalizeResumeData(optionsForCheckpoint.resume_data || optionsForCheckpoint.resumeData || optionsForCheckpoint);
    const checkpointId = optionsForCheckpoint.checkpoint_id || optionsForCheckpoint.checkpointId || contract.id('checkpoint');
    const checkpointDigest = optionsForCheckpoint.digest || digest({ run_id: runId, data });
    return ownedOperation(runId, 'checkpoint', optionsForCheckpoint, (record, now, authority) => {
      const event = contract.applyEvent(record.run, {
        event_id: optionsForCheckpoint.event_id || optionsForCheckpoint.eventId || `checkpoint:${runId}`,
        effect_id: optionsForCheckpoint.effect_id || optionsForCheckpoint.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: 'human_checkpoint', checkpoint_id: checkpointId,
      }, authority);
      record.run = contract.normalizeRunContract({
        ...clone(event.contract),
        checkpoint: { ...clone(event.contract.checkpoint), digest: checkpointDigest },
      });
      record.owner.status = 'checkpointed';
      record.owner.expires_at = now;
      record.checkpoint = {
        schema: 'shipyard.run-checkpoint.v1', version: 1, checkpoint_id: checkpointId,
        run_id: runId, state_revision: record.run.state_revision.value, digest: checkpointDigest,
        resume_data: data, acknowledged: false, acknowledged_at: null, successor_id: null, resumed_at: null,
      };
      record.successor = null;
      return { checkpoint_id: checkpointId, state_revision: record.run.state_revision.value };
    });
  }

  function acknowledge(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForAck = object(input) ? input : {};
    return ownedOperation(runId, 'acknowledge', optionsForAck, (record, now) => {
      if (!record.checkpoint || record.run.state !== 'human_checkpoint') refuse('NO_CHECKPOINT', 'no human checkpoint is available');
      if (!record.checkpoint.acknowledged) {
        const successorId = optionsForAck.successor_id || optionsForAck.successorId || contract.id('successor');
        record.checkpoint.acknowledged = true;
        record.checkpoint.acknowledged_at = now;
        record.checkpoint.successor_id = successorId;
        record.successor = {
          schema: 'shipyard.run-successor.v1', version: 1, successor_id: successorId,
          run_id: optionsForAck.successor_run_id || optionsForAck.successorRunId || contract.id('run'),
          owner_id: optionsForAck.owner_id || optionsForAck.ownerId || null,
          status: 'acknowledged', created_at: now, acknowledged_at: now, resumed_at: null,
          state_revision: record.run.state_revision.value,
        };
      }
      return { checkpoint_id: record.checkpoint.checkpoint_id, successor_id: record.checkpoint.successor_id, acknowledged: true };
    }, { allowCheckpointed: true });
  }

  function prepareSuccessor(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForSuccessor = object(input) ? input : {};
    const key = operationKey('prepare-successor', runId, optionsForSuccessor);
    const fingerprint = operationFingerprint('prepare-successor', optionsForSuccessor);
    let applied = false;
    let idempotent = false;
    let result = null;
    store.transaction(runId, (record, now) => {
      const remembered = remember(record, key, 'prepare-successor', optionsForSuccessor, null);
      if (remembered.hit) { idempotent = true; result = remembered.result; return; }
      if (!record.checkpoint || record.run.state !== 'human_checkpoint') refuse('NO_CHECKPOINT', 'no human checkpoint is available');
      if (record.successor && record.successor.status !== 'cancelled') {
        if (optionsForSuccessor.successor_id && record.successor.successor_id !== optionsForSuccessor.successor_id) refuse('SUCCESSOR_EXISTS', 'another successor is already prepared');
        result = { successor_id: record.successor.successor_id, status: record.successor.status };
        recordOperation(record, key, 'prepare-successor', fingerprint, result, now);
        applied = true;
        return;
      }
      const successorId = optionsForSuccessor.successor_id || optionsForSuccessor.successorId || contract.id('successor');
      const successorRunId = optionsForSuccessor.successor_run_id || optionsForSuccessor.successorRunId || contract.id('run');
      record.successor = {
        schema: 'shipyard.run-successor.v1', version: 1, successor_id: successorId,
        run_id: successorRunId, owner_id: optionsForSuccessor.owner_id || optionsForSuccessor.ownerId || ownerId,
        status: 'prepared', created_at: now, acknowledged_at: null, resumed_at: null,
        state_revision: record.run.state_revision.value,
      };
      record.checkpoint.successor_id = successorId;
      result = { successor_id: successorId, successor_run_id: successorRunId, status: 'prepared' };
      recordOperation(record, key, 'prepare-successor', fingerprint, result, now);
      applied = true;
    });
    return finish(runId, 'prepare-successor', applied, idempotent, result);
  }

  function resume(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForResume = object(input) ? input : {};
    const key = safeId(
      optionsForResume.idempotency_key || optionsForResume.idempotencyKey || optionsForResume.event_id || optionsForResume.eventId
        || `resume:${runId}:${ownerId}`,
      'resume.idempotency_key',
    );
    const fingerprint = operationFingerprint('resume', optionsForResume);
    let applied = false;
    let idempotent = false;
    let result = null;
    let newAuthority = null;
    store.transaction(runId, (record, now) => {
      const remembered = remember(record, key, 'resume', optionsForResume, null);
      if (remembered.hit) { idempotent = true; result = remembered.result; return; }
      if (!record.checkpoint || record.run.state !== 'human_checkpoint') refuse('NO_CHECKPOINT', 'no human checkpoint is available');
      const evidence = resumeEvidence(record.checkpoint, optionsForResume);
      if (record.successor && record.successor.status === 'resumed') {
        if (record.successor.owner_id !== ownerId) refuse('RUN_LEASE_HELD', 'the checkpoint already resumed under another owner');
        result = { resumed: true, successor_id: record.successor.successor_id, evidence };
        recordOperation(record, key, 'resume', fingerprint, result, now);
        applied = true;
        return;
      }
      if (record.owner.status === 'active' && record.owner.expires_at > now) {
        const current = authorities.get(runId);
        if (record.owner.owner_id !== ownerId || !current || current.lease_id !== record.owner.lease_id || current.epoch !== record.owner.epoch) {
          refuse('RUN_LEASE_HELD', `run ${runId} is still owned by ${record.owner.owner_id}`);
        }
      }
      const successorId = optionsForResume.successor_id || optionsForResume.successorId
        || record.successor && record.successor.successor_id || contract.id('successor');
      if (record.successor && record.successor.status !== 'cancelled' && record.successor.successor_id !== successorId) {
        refuse('SUCCESSOR_EXISTS', 'another successor is already prepared');
      }
      const newLeaseId = leaseId();
      const successorRunId = record.successor && record.successor.run_id
        || optionsForResume.successor_run_id || optionsForResume.successorRunId || contract.id('run');
      newAuthority = contract.createHostAuthority({ run_id: runId, owner_id: ownerId });
      const rebound = rebindLease(record.run, ownerId, newLeaseId, now, now + leaseTtlMs);
      const resumed = contract.applyEvent(rebound, {
        event_id: optionsForResume.event_id || optionsForResume.eventId || `resume:${runId}`,
        effect_id: optionsForResume.effect_id || optionsForResume.effectId || null,
        expected_revision: rebound.state_revision.value,
        to: 'running',
      }, newAuthority);
      record.run = resumed.contract;
      record.owner = {
        owner_id: ownerId, lease_id: newLeaseId, epoch: record.owner.epoch + 1,
        acquired_at: now, heartbeat_at: now, expires_at: now + leaseTtlMs, status: 'active',
      };
      record.checkpoint.acknowledged = true;
      record.checkpoint.acknowledged_at = record.checkpoint.acknowledged_at || now;
      record.checkpoint.resumed_at = now;
      record.successor = {
        schema: 'shipyard.run-successor.v1', version: 1, successor_id: successorId,
        run_id: successorRunId, owner_id: ownerId, status: 'resumed',
        created_at: record.successor ? record.successor.created_at : now,
        acknowledged_at: record.checkpoint.acknowledged_at, resumed_at: now,
        state_revision: record.run.state_revision.value,
      };
      recordOperation(record, key, 'resume', fingerprint, { resumed: true, successor_id: successorId, evidence }, now);
      result = { resumed: true, successor_id: successorId, evidence };
      applied = true;
    });
    if (newAuthority) saveAuthority(runId, newAuthority, store.get(runId).owner.lease_id, store.get(runId).owner.epoch);
    return finish(runId, 'resume', applied, idempotent, result);
  }

  function complete(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForComplete = object(input) ? input : {};
    return ownedOperation(runId, 'complete', optionsForComplete, (record, now, authority) => {
      const event = contract.applyEvent(record.run, {
        event_id: optionsForComplete.event_id || optionsForComplete.eventId || `complete:${runId}`,
        effect_id: optionsForComplete.effect_id || optionsForComplete.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: 'completed', reason: optionsForComplete.reason === undefined ? null : reasonValue(optionsForComplete.reason, null),
      }, authority);
      record.run = event.contract;
      record.owner.status = 'completed';
      record.owner.expires_at = now;
      return { completed: true };
    });
  }

  function fail(runIdInput, input = {}) {
    const runId = runIdFrom(runIdInput);
    const optionsForFail = object(input) ? input : {};
    return ownedOperation(runId, 'fail', optionsForFail, (record, now, authority) => {
      const event = contract.applyEvent(record.run, {
        event_id: optionsForFail.event_id || optionsForFail.eventId || `fail:${runId}`,
        effect_id: optionsForFail.effect_id || optionsForFail.effectId || null,
        expected_revision: record.run.state_revision.value,
        to: 'failed', reason: reasonValue(optionsForFail.reason, 'run failed'),
      }, authority);
      record.run = event.contract;
      record.owner.status = 'failed';
      record.owner.expires_at = now;
      return { failed: true };
    });
  }

  function status(runIdInput) {
    const runId = runIdFrom(runIdInput);
    const record = store.get(runId);
    if (!record) return null;
    return Object.freeze(statusFor(record, nowValue(clock)));
  }

  function authority(runIdInput) {
    const runId = runIdFrom(runIdInput);
    return authorityFor(runId) || null;
  }

  function assertOwner(runIdInput, { allowCheckpointed = false } = {}) {
    const runId = runIdFrom(runIdInput);
    const record = store.get(runId);
    if (!record) refuse('RUN_NOT_FOUND', `run ${runId} does not exist`);
    currentSession(record, nowValue(clock), { allowCheckpointed });
    return true;
  }

  function recoverExpired() {
    return store.reapExpired(nowValue(clock));
  }

  return Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    owner_id: ownerId,
    store,
    begin,
    start,
    heartbeat,
    release,
    wait,
    wake,
    retry,
    markUnavailable,
    runtimeUnavailable: markUnavailable,
    checkpoint,
    acknowledge,
    prepareSuccessor,
    resume,
    complete,
    fail,
    status,
    authority,
    assertOwner,
    recoverExpired,
  });
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RETRY_LIMIT,
  DEFAULT_RETRY_BACKOFF_MS,
  createRunController,
  statusFor,
  resumeEvidence,
  digest,
});
