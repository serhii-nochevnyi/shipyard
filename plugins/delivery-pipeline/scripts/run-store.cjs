#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, writeAtomic } = require('./lock.cjs');
const contract = require('./run-contract.cjs');

const SCHEMA = 'shipyard.run-store.v1';
const RECORD_SCHEMA = 'shipyard.run-record.v1';
const VERSION = 1;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
const MAX_HISTORY = 512;
const MAX_IDEMPOTENCY = 512;
const FORBIDDEN_KEYS = new Set([
  'authority', 'host_authority', 'serialized_authority', 'owner_token', 'session_token',
  'launch_token', 'token', 'inherited_model', 'inherited_effort', 'parent_session',
  'parent_session_id',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(code, message, details = {}) {
  const result = new Error(`run-store: ${message}`);
  result.name = 'RunStoreError';
  result.code = code;
  result.details = details;
  return result;
}

function refuse(code, message, details = {}) {
  throw error(code, message, details);
}

function safeString(value, field, { whitespace = false, max = 2048 } = {}) {
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

function timestamp(value, field) {
  if (value === null || value === undefined) return null;
  return integer(value, field, { zero: true });
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
  if (!value || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') refuse('SERIALIZED_AUTHORITY', `${field} cannot contain executable values`);
    return;
  }
  if (seen.has(value)) refuse('INVALID_INPUT', `${field} contains a cyclic value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || /(?:serialized|host)[_-]?authority/i.test(key)) {
      refuse('SERIALIZED_AUTHORITY', `${field}.${key} cannot be persisted`, { field, key });
    }
    rejectAuthority(child, `${field}.${key}`, seen);
  }
  seen.delete(value);
}

function emptyStore() {
  return { schema: SCHEMA, version: VERSION, generation: 0, updated_at: null, runs: {} };
}

function normalizeRetry(input = {}) {
  if (!object(input)) refuse('INVALID_INPUT', 'retry metadata must be an object');
  rejectAuthority(input, 'retry');
  const attempts = integer(input.attempts === undefined ? 0 : input.attempts, 'retry.attempts', { zero: true });
  const max_attempts = integer(input.max_attempts === undefined ? DEFAULT_RETRY_LIMIT : input.max_attempts);
  const backoff_ms = integer(input.backoff_ms === undefined ? DEFAULT_RETRY_BACKOFF_MS : input.backoff_ms, 'retry.backoff_ms', { zero: true });
  const next_at = timestamp(input.next_at, 'retry.next_at');
  const capability_recheck_at = timestamp(input.capability_recheck_at, 'retry.capability_recheck_at');
  const last_reason = input.last_reason === null || input.last_reason === undefined
    ? null : safeString(input.last_reason, 'retry.last_reason', { whitespace: true });
  const state = input.state === null || input.state === undefined ? null : safeId(input.state, 'retry.state');
  const condition = input.condition === null || input.condition === undefined
    ? null : safeString(input.condition, 'retry.condition', { whitespace: true });
  return {
    attempts,
    max_attempts,
    backoff_ms,
    next_at,
    capability_recheck_at,
    last_reason,
    state,
    condition,
    exhausted: input.exhausted === true,
  };
}

function normalizeOwner(input, run) {
  if (!object(input)) refuse('INVALID_INPUT', 'run owner metadata is required');
  rejectAuthority(input, 'owner');
  const owner_id = safeId(input.owner_id || input.ownerId, 'owner.owner_id');
  const lease_id = safeId(input.lease_id || input.leaseId, 'owner.lease_id');
  const epoch = integer(input.epoch === undefined ? 0 : input.epoch, 'owner.epoch', { zero: true });
  const acquired_at = integer(input.acquired_at, 'owner.acquired_at', { zero: true });
  const heartbeat_at = integer(input.heartbeat_at, 'owner.heartbeat_at', { zero: true });
  const expires_at = integer(input.expires_at, 'owner.expires_at', { zero: true });
  const status = safeId(input.status || 'active', 'owner.status');
  if (!['active', 'checkpointed', 'expired', 'released', 'completed', 'failed'].includes(status)) {
    refuse('INVALID_INPUT', `owner.status ${status} is invalid`);
  }
  if (run.lease.owner_id !== owner_id || run.lease.lease_id !== lease_id) {
    refuse('SCOPE_MISMATCH', 'owner metadata does not match the run lease');
  }
  if (run.lease.state_revision !== run.state_revision.value) {
    refuse('STALE_REVISION', 'run lease revision does not match the run revision');
  }
  return { owner_id, lease_id, epoch, acquired_at, heartbeat_at, expires_at, status };
}

function normalizeCheckpoint(input, run) {
  if (input === null || input === undefined) return null;
  if (!object(input)) refuse('INVALID_INPUT', 'run checkpoint metadata must be an object');
  rejectAuthority(input, 'checkpoint');
  const checkpoint_id = safeId(input.checkpoint_id || input.checkpointId, 'checkpoint.checkpoint_id');
  const run_id = safeId(input.run_id || input.runId, 'checkpoint.run_id');
  if (run_id !== run.run_id) refuse('SCOPE_MISMATCH', 'checkpoint belongs to another run');
  const state_revision = integer(input.state_revision, 'checkpoint.state_revision', { zero: true });
  if (state_revision > run.state_revision.value) refuse('STALE_REVISION', 'checkpoint is ahead of the run');
  const resume_data = input.resume_data === undefined ? {} : input.resume_data;
  rejectAuthority(resume_data, 'checkpoint.resume_data');
  if (!object(resume_data)) refuse('INVALID_INPUT', 'checkpoint.resume_data must be an object');
  if (Buffer.byteLength(stable(resume_data), 'utf8') > 16384) refuse('INVALID_INPUT', 'checkpoint.resume_data exceeds 16KiB');
  const successor_id = input.successor_id === null || input.successor_id === undefined
    ? null : safeId(input.successor_id, 'checkpoint.successor_id');
  return {
    schema: 'shipyard.run-checkpoint.v1',
    version: VERSION,
    checkpoint_id,
    run_id,
    state_revision,
    digest: input.digest === null || input.digest === undefined ? null : safeString(input.digest, 'checkpoint.digest'),
    resume_data: clone(resume_data),
    acknowledged: input.acknowledged === true,
    acknowledged_at: timestamp(input.acknowledged_at, 'checkpoint.acknowledged_at'),
    successor_id,
    resumed_at: timestamp(input.resumed_at, 'checkpoint.resumed_at'),
  };
}

function normalizeSuccessor(input, run) {
  if (input === null || input === undefined) return null;
  if (!object(input)) refuse('INVALID_INPUT', 'successor metadata must be an object');
  rejectAuthority(input, 'successor');
  const successor_id = safeId(input.successor_id || input.successorId, 'successor.successor_id');
  const run_id = safeId(input.run_id || input.runId, 'successor.run_id');
  const owner_id = input.owner_id === null || input.owner_id === undefined ? null : safeId(input.owner_id, 'successor.owner_id');
  const status = safeId(input.status || 'prepared', 'successor.status');
  if (!['prepared', 'acknowledged', 'resumed', 'cancelled'].includes(status)) refuse('INVALID_INPUT', 'successor.status is invalid');
  return {
    schema: 'shipyard.run-successor.v1',
    version: VERSION,
    successor_id,
    run_id,
    owner_id,
    status,
    created_at: integer(input.created_at, 'successor.created_at', { zero: true }),
    acknowledged_at: timestamp(input.acknowledged_at, 'successor.acknowledged_at'),
    resumed_at: timestamp(input.resumed_at, 'successor.resumed_at'),
    state_revision: integer(input.state_revision === undefined ? run.state_revision.value : input.state_revision, 'successor.state_revision', { zero: true }),
  };
}

function normalizeIdempotency(input = {}) {
  if (!object(input)) refuse('INVALID_INPUT', 'idempotency metadata must be an object');
  rejectAuthority(input, 'idempotency');
  const entries = Object.entries(input);
  if (entries.length > MAX_IDEMPOTENCY) refuse('INVALID_INPUT', 'idempotency metadata exceeds its bound');
  return Object.fromEntries(entries.map(([key, value]) => {
    const id = safeId(key, 'idempotency.key');
    if (!object(value)) refuse('INVALID_INPUT', 'idempotency entries must be objects');
    return [id, {
      action: safeId(value.action, 'idempotency.action'),
      fingerprint: safeString(value.fingerprint, 'idempotency.fingerprint'),
      revision: integer(value.revision, 'idempotency.revision', { zero: true }),
      result: clone(value.result === undefined ? null : value.result),
    }];
  }));
}

function normalizeHistory(input = []) {
  if (!Array.isArray(input)) refuse('INVALID_INPUT', 'run history must be an array');
  if (input.length > MAX_HISTORY) refuse('INVALID_INPUT', 'run history exceeds its bound');
  return input.map((entry) => {
    if (!object(entry)) refuse('INVALID_INPUT', 'run history entries must be objects');
    rejectAuthority(entry, 'history');
    return clone(entry);
  });
}

function normalizeRecord(input) {
  if (!object(input)) refuse('INVALID_INPUT', 'run record must be an object');
  rejectAuthority(input, 'record');
  const run = contract.normalizeRunContract(input.run || input.contract);
  if (!run) refuse('MISSING_SCOPE', 'run record requires a run contract');
  const owner = normalizeOwner(input.owner, run);
  const retry = normalizeRetry(input.retry);
  const checkpoint = normalizeCheckpoint(input.checkpoint, run);
  const successor = normalizeSuccessor(input.successor, run);
  if (checkpoint && checkpoint.successor_id && (!successor || successor.successor_id !== checkpoint.successor_id)) {
    refuse('SCOPE_MISMATCH', 'checkpoint successor does not match the successor record');
  }
  return {
    schema: RECORD_SCHEMA,
    version: VERSION,
    run,
    owner,
    retry,
    checkpoint,
    successor,
    idempotency: normalizeIdempotency(input.idempotency),
    history: normalizeHistory(input.history),
  };
}

function normalizeStore(input) {
  if (!object(input) || input.schema !== SCHEMA || input.version !== VERSION || !object(input.runs)) {
    refuse('INVALID_STORE', 'run store has an unknown schema');
  }
  const generation = integer(input.generation === undefined ? 0 : input.generation, 'store.generation', { zero: true });
  const runs = Object.fromEntries(Object.entries(input.runs).map(([runId, value]) => {
    const record = normalizeRecord(value);
    if (record.run.run_id !== runId) refuse('SCOPE_MISMATCH', 'run store key does not match run_id');
    return [runId, record];
  }));
  return {
    schema: SCHEMA,
    version: VERSION,
    generation,
    updated_at: input.updated_at === null || input.updated_at === undefined ? null : safeString(input.updated_at, 'store.updated_at', { whitespace: true }),
    runs,
  };
}

function createRunStore(options = {}) {
  if (!object(options)) refuse('INVALID_INPUT', 'run store options must be an object');
  const storeDir = path.resolve(options.storeDir || (options.storeFile ? path.dirname(options.storeFile) : path.join(process.cwd(), '.planning', 'graph', 'runs')));
  const storeFile = path.resolve(options.storeFile || path.join(storeDir, 'runs.json'));
  const lockDir = path.resolve(options.lockDir || path.join(storeDir, '.locks'));
  const clock = options.now || options.clock || (() => Date.now());
  const waitMs = Number.isSafeInteger(options.lockWaitMs) && options.lockWaitMs > 0 ? options.lockWaitMs : 5000;

  function readState() {
    if (!fs.existsSync(storeFile)) return emptyStore();
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8')); }
    catch (cause) { refuse('INVALID_STORE', `run store is not readable JSON: ${cause.message}`); }
    return normalizeStore(parsed);
  }

  function writeState(state) {
    const normalized = normalizeStore(state);
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    writeAtomic(storeFile, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  function transact(fn) {
    if (typeof fn !== 'function') refuse('INVALID_INPUT', 'store transaction needs a callback');
    return withLock(lockDir, 'runs', () => {
      const state = readState();
      const before = stable(state);
      const value = fn(state, nowValue(clock));
      const normalized = normalizeStore(state);
      if (stable(normalized) !== before) {
        normalized.generation += 1;
        normalized.updated_at = new Date(nowValue(clock)).toISOString();
        writeState(normalized);
      }
      return value;
    }, { label: 'run-store', waitMs });
  }

  function transaction(runId, fn, optionsForTransaction = {}) {
    const id = safeId(runId, 'run_id');
    if (typeof fn !== 'function') refuse('INVALID_INPUT', 'run transaction needs a callback');
    return transact((state, now) => {
      const record = state.runs[id];
      if (!record) refuse('RUN_NOT_FOUND', `run ${id} does not exist`);
      const expected = optionsForTransaction.expected_revision;
      if (expected !== undefined && record.run.state_revision.value !== expected) {
        refuse('STALE_REVISION', `expected revision ${expected}, current revision ${record.run.state_revision.value}`, {
          expected_revision: expected, current_revision: record.run.state_revision.value,
        });
      }
      return fn(record, now, state);
    });
  }

  function create(record) {
    const normalized = normalizeRecord(record);
    return transact((state) => {
      const existing = state.runs[normalized.run.run_id];
      if (existing) return { created: false, record: clone(existing) };
      state.runs[normalized.run.run_id] = normalized;
      return { created: true, record: clone(normalized) };
    });
  }

  function get(runId) {
    const id = safeId(runId, 'run_id');
    const state = readState();
    return state.runs[id] ? clone(state.runs[id]) : null;
  }

  function list() {
    return Object.values(readState().runs).map(clone);
  }

  function read() {
    return clone(readState());
  }

  function reapExpired(now = nowValue(clock)) {
    return transact((state) => {
      const expired = [];
      for (const record of Object.values(state.runs)) {
        if (record.owner.status === 'active' && record.owner.expires_at <= now) {
          record.owner.status = 'expired';
          record.history.push({ event: 'lease-expired', run_id: record.run.run_id, epoch: record.owner.epoch, at: now });
          if (record.history.length > MAX_HISTORY) record.history = record.history.slice(-MAX_HISTORY);
          expired.push(record.run.run_id);
        }
      }
      return expired;
    });
  }

  return Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    storeDir,
    storeFile,
    lockDir,
    now: () => nowValue(clock),
    read,
    get,
    list,
    create,
    transact,
    transaction,
    reapExpired,
  });
}

module.exports = Object.freeze({
  SCHEMA,
  RECORD_SCHEMA,
  VERSION,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RETRY_LIMIT,
  DEFAULT_RETRY_BACKOFF_MS,
  MAX_HISTORY,
  MAX_IDEMPOTENCY,
  createRunStore,
  normalizeRecord,
  normalizeStore,
  digest,
});
