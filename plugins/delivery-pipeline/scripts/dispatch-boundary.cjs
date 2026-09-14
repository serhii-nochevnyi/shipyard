#!/usr/bin/env node
'use strict';

// The only launch boundary for routed delivery.  Runtime adapters are injected
// rather than imported here: this keeps the policy testable without a Claude or
// Codex host and makes a missing adapter a refusal instead of an implicit
// session/CLI fallback.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultPolicy = require('./model-policy.cjs');
const canonicalPolicy = require('./model-policy-internal.cjs');
const canonicalResolveDispatch = canonicalPolicy.resolveDispatch;
const canonicalValidateResolution = canonicalPolicy.validateResolution;
const canonicalStableStringify = canonicalPolicy.stableStringify;

const OBSERVATION_UNKNOWN = 'unknown';
const CLAIM_TTL_MS = 60 * 60 * 1000;
const CLAIM_HEARTBEAT_MS = Math.max(1000, Math.floor(CLAIM_TTL_MS / 3));
const CLAIM_LOCK_TTL_MS = Math.max(1000, Math.floor(CLAIM_TTL_MS / 3));
const RECORDER_AUTHORITY = Symbol('adr-014-dispatch-boundary-recorder-authority');
const DURABLE_RECORDERS = new WeakSet();
// Policy resolution must distinguish an actual durable receipt from a caller's
// JSON lookalike.  Only this module can add a value to the set; the exported
// predicate deliberately exposes verification but no way to mint membership.
const BOUNDARY_VERIFIED_RECEIPTS = new WeakSet();

function markBoundaryVerifiedReceipt(receipt) {
  if (isObject(receipt)) BOUNDARY_VERIFIED_RECEIPTS.add(receipt);
  return receipt;
}

function isBoundaryVerifiedReceipt(receipt) {
  return isObject(receipt) && BOUNDARY_VERIFIED_RECEIPTS.has(receipt);
}

// A recorder is the durable owner of dispatch identity.  Function recorders
// remain supported for small in-process callers, so this table supplies the
// same instance/process uniqueness and receipt lookup guarantees for them.
// Production callers that cross a process boundary must use a recorder object
// with reserve/record/read methods (createDurableRecorder below is the bundled
// implementation).
const SHARED_RECORDER_STATES = new WeakMap();

function sharedRecorderState(recorder) {
  if (!recorder || (typeof recorder !== 'function' && typeof recorder !== 'object')) return null;
  let state = SHARED_RECORDER_STATES.get(recorder);
  if (!state) {
    state = {
      reserved: new Set(),
      records: new Map(),
      latest: new Map(),
      claims: new Map(),
      consumed: new Set(),
    };
    SHARED_RECORDER_STATES.set(recorder, state);
  }
  return state;
}

function recorderMethod(recorder, names) {
  for (const name of names) {
    if (recorder && typeof recorder[name] === 'function') return { fn: recorder[name], receiver: recorder, name };
  }
  return null;
}

function affirmative(value, field) {
  return value === true || Boolean(value && typeof value === 'object' && value[field] === true);
}

function keyDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    refuse('RECORD_FAILED', `durable dispatch store could not be read: ${error.message}`, { file });
  }
}

function atomicCreateJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  let fd;
  let dirFd;
  let tempCreated = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    tempCreated = true;
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Unlike rename, link never replaces an existing destination. Publish only
    // the complete, synced inode while retaining exclusive reservation semantics.
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error && error.code === 'EEXIST') return false;
      throw error;
    }
    dirFd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dirFd);
    return true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* best effort */ }
    }
    if (dirFd !== undefined) {
      try { fs.closeSync(dirFd); } catch (_) { /* best effort */ }
    }
    // A crash may leave an orphan temp, but never a partially written final.
    if (tempCreated) {
      try { fs.unlinkSync(temp); } catch (_) { /* best effort */ }
    }
  }
}

function atomicReplaceJson(file, value) {
  const temp = `${file}.${process.pid}.${keyDigest(`${Date.now()}-${Math.random()}`)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* best effort */ }
    }
    try { fs.unlinkSync(temp); } catch (_) { /* absent after rename */ }
  }
}

// A small file-backed recorder for callers that need uniqueness and receipt
// provenance across boundary instances or Node processes.  Reservation files
// use exclusive hard-link installation, so two processes cannot both win an id.
// Records and latest-by-role pointers are written atomically and contain the
// finalized boundary receipt, never pre-proof application evidence. Trusted
// record writes require a module-private boundary capability. Receipt claims
// are leases with bounded stale-owner recovery, so a crashed repair cannot burn
// a predecessor forever while two live contenders still cannot take it twice.
function createDurableRecorder(storeDir) {
  if (typeof storeDir !== 'string' || storeDir.trim() === '') {
    throw boundaryError('INVALID_INPUT', 'durable recorder storeDir must be a non-empty path');
  }
  const root = path.resolve(storeDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = (prefix, value) => path.join(root, `${prefix}-${keyDigest(value)}.json`);
  const reservationFile = (dispatchId) => file('reservation', dispatchId);
  const recordFile = (dispatchId) => file('record', dispatchId);
  const latestFile = (runtime, role) => file('latest', `${runtime}:${role}`);
  const consumedFile = (dispatchId) => file('consumed', dispatchId);
  const repairCommitFile = (dispatchId) => file('repair-commit', dispatchId);
  const claimFile = (dispatchId) => file('claim', dispatchId);
  const claimLockFile = (dispatchId) => file('claim-recovery', dispatchId);
  const newFenceToken = () => typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const claimPayload = (dispatchId, consumerId, generation, token = newFenceToken()) => {
    const now = Date.now();
    return {
      dispatch_id: dispatchId,
      consumer_id: consumerId,
      generation,
      claim_token: token,
      owner_pid: process.pid,
      claimed_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + CLAIM_TTL_MS).toISOString(),
    };
  };
  const claimLockPayload = (dispatchId, purpose) => {
    const now = Date.now();
    return {
      dispatch_id: dispatchId,
      purpose,
      lock_token: newFenceToken(),
      owner_pid: process.pid,
      acquired_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + CLAIM_LOCK_TTL_MS).toISOString(),
    };
  };
  const claimIsStale = (claim) => {
    const leaseExpiresAt = claim && typeof claim.lease_expires_at === 'string'
      ? Date.parse(claim.lease_expires_at)
      : claim && typeof claim.claimed_at === 'string'
        ? Date.parse(claim.claimed_at) + CLAIM_TTL_MS
        : NaN;
    return !Number.isFinite(leaseExpiresAt) || Date.now() >= leaseExpiresAt;
  };
  const releaseClaimFile = (filePath) => {
    try { fs.unlinkSync(filePath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  };
  const lockIsStale = (lock) => {
    const leaseExpiresAt = lock && typeof lock.lease_expires_at === 'string'
      ? Date.parse(lock.lease_expires_at)
      : lock && typeof lock.acquired_at === 'string'
        ? Date.parse(lock.acquired_at) + CLAIM_LOCK_TTL_MS
        : NaN;
    return !Number.isFinite(leaseExpiresAt) || Date.now() >= leaseExpiresAt;
  };
  const acquireClaimLock = (dispatchId, purpose) => {
    const lock = claimLockFile(dispatchId);
    const candidate = claimLockPayload(dispatchId, purpose);
    if (atomicCreateJson(lock, candidate)) return candidate;
    const current = readJsonFile(lock);
    if (!lockIsStale(current)) return null;
    // Retiring a stale lock is an atomic rename, never an unlink after a
    // time-of-check. A competing recovery can therefore only make this rename
    // lose with ENOENT; it cannot have its fresh lock removed by us.
    const retired = `${lock}.${process.pid}.${keyDigest(`${Date.now()}-${Math.random()}`)}.stale`;
    try {
      fs.renameSync(lock, retired);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return atomicCreateJson(lock, candidate) ? candidate : null;
    } finally {
      releaseClaimFile(retired);
    }
  };
  const releaseClaimLock = (dispatchId, lockOwner) => {
    if (!lockOwner) return;
    const lock = claimLockFile(dispatchId);
    const current = readJsonFile(lock);
    if (!current || current.lock_token !== lockOwner.lock_token) return;
    releaseClaimFile(lock);
  };
  const claimFence = (claim) => claim && ({
    dispatch_id: claim.dispatch_id,
    consumer_id: claim.consumer_id,
    generation: claim.generation,
    claim_token: claim.claim_token,
  });
  const sameClaimFence = (claim, fence) => (
    isObject(claim)
    && isObject(fence)
    && claim.dispatch_id === fence.dispatch_id
    && claim.consumer_id === fence.consumer_id
    && claim.generation === fence.generation
    && claim.claim_token === fence.claim_token
  );
  const sameRecord = (left, right) => canonicalStableStringify(left) === canonicalStableStringify(right);
  const validRepairCommit = (commit, predecessorDispatchId) => (
    isObject(commit)
    && commit.predecessor_dispatch_id === predecessorDispatchId
    && typeof commit.successor_dispatch_id === 'string'
    && typeof commit.consumer_id === 'string'
    && isObject(commit.record_input)
    && commit.record_input.dispatch_id === commit.successor_dispatch_id
    && commit.record_input.predecessor_dispatch_id === predecessorDispatchId
    && commit.record_input.predecessor_consumer_id === commit.consumer_id
    && (commit.claim_generation === undefined || Number.isInteger(commit.claim_generation))
    && (commit.claim_token === undefined || typeof commit.claim_token === 'string')
  );
  const recoverRepairCommit = (predecessorDispatchId) => {
    const commit = readJsonFile(repairCommitFile(predecessorDispatchId));
    if (!commit) return null;
    if (!validRepairCommit(commit, predecessorDispatchId)) {
      throw boundaryError('RECORD_FAILED', 'durable repair commit is malformed', { dispatch_id: predecessorDispatchId });
    }
    const successorRecord = recordFile(commit.successor_dispatch_id);
    const existing = readJsonFile(successorRecord);
    if (!existing) {
      if (!atomicCreateJson(successorRecord, commit.record_input)) {
        const raced = readJsonFile(successorRecord);
        if (!raced || !sameRecord(raced, commit.record_input)) {
          throw boundaryError('RECORD_FAILED', 'durable repair commit could not recover its successor record', { dispatch_id: commit.successor_dispatch_id });
        }
      }
    } else if (!sameRecord(existing, commit.record_input)) {
      const sameDispatch = existing.dispatch_id === commit.record_input.dispatch_id
        && canonicalStableStringify(existing.receipt) === canonicalStableStringify(commit.record_input.receipt);
      const existingTrace = Array.isArray(existing.trace) ? existing.trace : [];
      const committedTrace = Array.isArray(commit.record_input.trace) ? commit.record_input.trace : [];
      if (!sameDispatch || committedTrace.length < existingTrace.length) {
        throw boundaryError('RECORD_FAILED', 'durable repair commit conflicts with its successor record', { dispatch_id: commit.successor_dispatch_id });
      }
      atomicReplaceJson(successorRecord, commit.record_input);
    }
    const receipt = commit.record_input.receipt;
    if (isObject(receipt) && typeof receipt.runtime === 'string' && typeof receipt.role === 'string') {
      atomicReplaceJson(latestFile(receipt.runtime, receipt.role), commit.record_input);
    }
    return commit;
  };

  const recorder = Object.freeze({
    storeDir: root,
    reserve(dispatchId) {
      try {
        return atomicCreateJson(reservationFile(dispatchId), {
          dispatch_id: dispatchId,
          reserved_at: new Date().toISOString(),
        })
          ? { reserved: true }
          : { reserved: false };
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable dispatch reservation failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
    record(recordInput, authority, claimAuthority) {
      if (authority !== RECORDER_AUTHORITY) return { recorded: false };
      const receipt = recordInput && recordInput.receipt;
      const dispatchId = recordInput && recordInput.dispatch_id;
      if (!isObject(receipt) || typeof dispatchId !== 'string' || receipt.dispatch_id !== dispatchId || receipt.compliance !== 'verified') {
        return { recorded: false };
      }
      if (!fs.existsSync(reservationFile(dispatchId))) return { recorded: false };
      const predecessorDispatchId = recordInput.predecessor_dispatch_id;
      const predecessorConsumerId = recordInput.predecessor_consumer_id;
      try {
        if (predecessorDispatchId !== undefined || predecessorConsumerId !== undefined) {
          if (typeof predecessorDispatchId !== 'string' || typeof predecessorConsumerId !== 'string') return { recorded: false };
          const lockOwner = acquireClaimLock(predecessorDispatchId, 'commit');
          if (!lockOwner) return { recorded: false };
          try {
            const claim = readJsonFile(claimFile(predecessorDispatchId));
            if (!sameClaimFence(claim, claimAuthority) || claimIsStale(claim)) return { recorded: false };
            const repairCommit = {
              predecessor_dispatch_id: predecessorDispatchId,
              successor_dispatch_id: dispatchId,
              consumer_id: predecessorConsumerId,
              claim_generation: claim.generation,
              claim_token: claim.claim_token,
              record_input: recordInput,
            };
            const commitCreated = atomicCreateJson(repairCommitFile(predecessorDispatchId), repairCommit);
            if (!commitCreated) {
              const existingCommit = readJsonFile(repairCommitFile(predecessorDispatchId));
              if (!existingCommit || !sameRecord(existingCommit, repairCommit)) return { recorded: false };
            }
          } finally {
            releaseClaimLock(predecessorDispatchId, lockOwner);
          }
        }
        const created = atomicCreateJson(recordFile(dispatchId), recordInput);
        if (!created) {
          const existing = readJsonFile(recordFile(dispatchId));
          if (!existing || !sameRecord(existing, recordInput)) return { recorded: false };
        }
        atomicReplaceJson(latestFile(receipt.runtime, receipt.role), recordInput);
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable dispatch record failed: ${error.message}`, { dispatch_id: dispatchId });
      }
      return { recorded: true };
    },
    finalize(recordInput, authority) {
      if (authority !== RECORDER_AUTHORITY) return { finalized: false };
      const dispatchId = recordInput && recordInput.dispatch_id;
      const receipt = recordInput && recordInput.receipt;
      if (typeof dispatchId !== 'string' || !isObject(receipt) || receipt.dispatch_id !== dispatchId) {
        return { finalized: false };
      }
      try {
        const existing = readJsonFile(recordFile(dispatchId));
        if (!existing || existing.dispatch_id !== dispatchId
            || canonicalStableStringify(existing.receipt) !== canonicalStableStringify(receipt)) {
          return { finalized: false };
        }
        const predecessorDispatchId = recordInput.predecessor_dispatch_id;
        if (predecessorDispatchId !== undefined) {
          const repairCommit = readJsonFile(repairCommitFile(predecessorDispatchId));
          if (!validRepairCommit(repairCommit, predecessorDispatchId)
              || repairCommit.successor_dispatch_id !== dispatchId) return { finalized: false };
          atomicReplaceJson(repairCommitFile(predecessorDispatchId), {
            ...repairCommit,
            record_input: recordInput,
          });
        }
        atomicReplaceJson(recordFile(dispatchId), recordInput);
        atomicReplaceJson(latestFile(receipt.runtime, receipt.role), recordInput);
        return { finalized: true };
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable dispatch finalization failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
    getReceipt(dispatchId) {
      return readJsonFile(recordFile(dispatchId));
    },
    getLatestReceipt(runtime, role) {
      return readJsonFile(latestFile(runtime, role));
    },
    claim(dispatchId, consumerId) {
      try {
        if (fs.existsSync(consumedFile(dispatchId))) return { claimed: false };
        // A successor is committed before its record is written.  If a process
        // died between those writes, recover that record now and treat the
        // predecessor as consumed: no later repair may replay it.
        if (recoverRepairCommit(dispatchId)) return { claimed: false };
        let candidate = claimPayload(dispatchId, consumerId, 1);
        if (atomicCreateJson(claimFile(dispatchId), candidate)) return { claimed: true, ...claimFence(candidate) };
        let current = readJsonFile(claimFile(dispatchId));
        if (current && current.consumer_id === consumerId && !claimIsStale(current)) {
          return { claimed: true, ...claimFence(current) };
        }
        if (!claimIsStale(current)) return { claimed: false };

        // A stale claim is recoverable, but takeover itself is serialized by a
        // second O_EXCL marker. Every contender either owns that marker or
        // backs off; no process may unlink a fresh owner's claim blindly.
        const lockOwner = acquireClaimLock(dispatchId, 'recovery');
        if (!lockOwner) return { claimed: false };
        try {
          if (fs.existsSync(consumedFile(dispatchId))) return { claimed: false };
          current = readJsonFile(claimFile(dispatchId));
          if (current && current.consumer_id === consumerId && !claimIsStale(current)) {
            return { claimed: true, ...claimFence(current) };
          }
          if (!claimIsStale(current)) return { claimed: false };
          const generation = current && Number.isInteger(current.generation) ? current.generation + 1 : 1;
          candidate = claimPayload(dispatchId, consumerId, generation);
          if (current) releaseClaimFile(claimFile(dispatchId));
          return atomicCreateJson(claimFile(dispatchId), candidate)
            ? { claimed: true, ...claimFence(candidate) }
            : { claimed: false };
        } finally {
          releaseClaimLock(dispatchId, lockOwner);
        }
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable receipt claim failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
    release(dispatchId, consumerId, claimAuthority) {
      const repairCommit = recoverRepairCommit(dispatchId);
      if (repairCommit
          && isObject(claimAuthority)
          && repairCommit.consumer_id === consumerId
          && repairCommit.claim_token === claimAuthority.claim_token
          && repairCommit.claim_generation === claimAuthority.generation) return { released: true };
      try {
        const lockOwner = acquireClaimLock(dispatchId, 'release');
        if (!lockOwner) return { released: false };
        try {
          const claim = readJsonFile(claimFile(dispatchId));
          if (!sameClaimFence(claim, claimAuthority)) return { released: false };
          releaseClaimFile(claimFile(dispatchId));
          return { released: true };
        } finally {
          releaseClaimLock(dispatchId, lockOwner);
        }
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable receipt claim release failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
    renewClaim(dispatchId, consumerId, claimAuthority) {
      try {
        if (fs.existsSync(consumedFile(dispatchId))) return { renewed: false };
        // Renewal and stale-owner recovery share this lock. Without the same
        // lock, a takeover could unlink a stale claim between the heartbeat's
        // read and replace, and the old owner could then write itself back as
        // the new owner.
        const lockOwner = acquireClaimLock(dispatchId, 'renewal');
        if (!lockOwner) return { renewed: false };
        try {
          const current = readJsonFile(claimFile(dispatchId));
          if (!sameClaimFence(current, claimAuthority) || claimIsStale(current)) return { renewed: false };
          atomicReplaceJson(claimFile(dispatchId), claimPayload(
            dispatchId,
            consumerId,
            current.generation,
            current.claim_token,
          ));
          return { renewed: true };
        } finally {
          releaseClaimLock(dispatchId, lockOwner);
        }
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable receipt claim renewal failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
    consume(dispatchId, consumerId, claimAuthority) {
      try {
        const repairCommit = recoverRepairCommit(dispatchId);
        const committedFenceMatches = repairCommit
          && isObject(claimAuthority)
          && repairCommit.consumer_id === consumerId
          && repairCommit.claim_token === claimAuthority.claim_token
          && repairCommit.claim_generation === claimAuthority.generation;
        if (repairCommit && !committedFenceMatches) return { consumed: false };
        const lockOwner = acquireClaimLock(dispatchId, 'consume');
        if (!lockOwner) return { consumed: false };
        try {
          const claim = readJsonFile(claimFile(dispatchId));
          if (!sameClaimFence(claim, claimAuthority) && !committedFenceMatches) return { consumed: false };
          const consumed = atomicCreateJson(consumedFile(dispatchId), {
            dispatch_id: dispatchId,
            consumer_id: consumerId,
            claim_generation: claimAuthority.generation,
            claim_token: claimAuthority.claim_token,
            consumed_at: new Date().toISOString(),
          });
          if (!consumed) return fs.existsSync(consumedFile(dispatchId)) && committedFenceMatches
            ? { consumed: true }
            : { consumed: false };
          if (sameClaimFence(claim, claimAuthority)) releaseClaimFile(claimFile(dispatchId));
          return { consumed: true };
        } finally {
          releaseClaimLock(dispatchId, lockOwner);
        }
      } catch (error) {
        throw boundaryError('RECORD_FAILED', `durable receipt consumption failed: ${error.message}`, { dispatch_id: dispatchId });
      }
    },
  });
  DURABLE_RECORDERS.add(recorder);
  return recorder;
}

function boundaryError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'DispatchBoundaryError';
  error.code = code;
  error.details = details;
  return error;
}

function refuse(code, message, details = {}) {
  throw boundaryError(code, message, details);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function snapshot(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) refuse('INVALID_VALUE', 'dispatch data cannot contain circular references');
  seen.set(value, true);
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) result[key] = snapshot(child, seen);
  seen.delete(value);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_RECEIPT', `${label} must be a non-empty, whitespace-free string`, { label });
  }
  return value;
}

function newDispatchId() {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `dispatch-${Date.now().toString(36)}-${suffix}`;
}

function adapterFor(adapters, runtime) {
  const value = adapters && adapters[runtime];
  if (typeof value === 'function') return { launch: value };
  if (isObject(value)) return value;
  refuse(
    'MISSING_ADAPTER',
    `no ${runtime} dispatch adapter was injected; refusing to fall back to an inherited session or CLI default`,
    { runtime },
  );
}

function invokeSync(fn, receiver, args, label) {
  const result = fn.apply(receiver, args);
  if (result && typeof result.then === 'function') {
    refuse('ASYNC_ADAPTER', `${label} returned a Promise; the synchronous boundary cannot prove its receipt`, { label });
  }
  return result;
}

function invokeLaunch(fn, receiver, args) {
  return fn.apply(receiver, args);
}

function adapterObservationCapabilities(adapter) {
  const capabilities = { model: false, effort: false };
  if (!adapter) return capabilities;
  const unavailable = adapter.observationUnavailable === true
    || adapter.observes === false
    || adapter.observation === 'unavailable';
  if (unavailable) return { model: true, effort: true };
  const declared = adapter.capabilities;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return capabilities;
  if (declared.observation === 'unavailable') return { model: true, effort: true };
  capabilities.model = declared.observedModel === false;
  capabilities.effort = declared.observedEffort === false;
  return capabilities;
}

function adapterSupports(adapter, resolution) {
  if (Array.isArray(adapter.supportedModels) && !adapter.supportedModels.includes(resolution.model)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved model ${resolution.model}`, { model: resolution.model });
  }
  if (adapter.supportedModels instanceof Set && !adapter.supportedModels.has(resolution.model)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved model ${resolution.model}`, { model: resolution.model });
  }
  if (Array.isArray(adapter.supportedEfforts) && !adapter.supportedEfforts.includes(resolution.effort)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved effort ${resolution.effort}`, { effort: resolution.effort });
  }
  if (adapter.supportedEfforts instanceof Set && !adapter.supportedEfforts.has(resolution.effort)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved effort ${resolution.effort}`, { effort: resolution.effort });
  }
  const supports = typeof adapter.supports === 'function'
    ? invokeSync(adapter.supports, adapter, [resolution], 'adapter.supports')
    : true;
  if (supports === false || supports && supports.valid === false) {
    const reason = supports && typeof supports.reason === 'string' ? `: ${supports.reason}` : '';
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter cannot apply the resolved selection${reason}`, { resolution });
  }
}

function quotedTomlField(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text).match(new RegExp(`^${escaped}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function generatedPolicyComment(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text).match(new RegExp(`^# shipyard-policy-${escaped}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function generatedAgentRoot(adapter) {
  if (!adapter || typeof adapter !== 'object') return null;
  const root = adapter.agentsDir || adapter.agentFileRoot || adapter.agents_root || adapter.codexAgentDir;
  return typeof root === 'string' && root.trim() !== '' ? path.resolve(root) : null;
}

function generatedAgentManifestPath(adapter, root) {
  const configured = adapter && typeof adapter === 'object'
    ? adapter.agentManifest || adapter.agentManifestFile || adapter.manifestFile
    : null;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || configured.trim() === '') {
      refuse('STALE_GENERATED_AGENT', 'the configured generated-agent manifest path must be non-empty');
    }
    return path.resolve(configured);
  }
  return path.join(root, '.shipyard-manifest.json');
}

function trustedGeneratedAgentDigest(resolution, adapter, root, actualDigest) {
  const manifestPath = generatedAgentManifestPath(adapter, root);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const reason = error && error.code === 'ENOENT'
      ? `generated-agent manifest ${manifestPath} does not exist`
      : `generated-agent manifest ${manifestPath} could not be read: ${error.message}`;
    refuse('STALE_GENERATED_AGENT', reason, { manifest: manifestPath, agent_file: resolution.agent_file });
  }
  if (!isObject(manifest) || !isObject(manifest.agent_digests)) {
    refuse('STALE_GENERATED_AGENT', `generated-agent manifest ${manifestPath} has no trusted agent_digests map`, { manifest: manifestPath, agent_file: resolution.agent_file });
  }
  if (manifest.policy_id !== undefined && manifest.policy_id !== canonicalPolicy.POLICY.id) {
    refuse('STALE_GENERATED_AGENT', `generated-agent manifest ${manifestPath} is for ${manifest.policy_id}, not ${canonicalPolicy.POLICY.id}`, { manifest: manifestPath });
  }
  if (manifest.policy_version !== undefined && manifest.policy_version !== resolution.policy_version) {
    refuse('STALE_GENERATED_AGENT', `generated-agent manifest ${manifestPath} has stale policy version`, { manifest: manifestPath, expected: resolution.policy_version, actual: manifest.policy_version });
  }
  if (manifest.policy_hash !== undefined && manifest.policy_hash !== resolution.policy_hash) {
    refuse('STALE_GENERATED_AGENT', `generated-agent manifest ${manifestPath} has stale policy hash`, { manifest: manifestPath, expected: resolution.policy_hash, actual: manifest.policy_hash });
  }
  const expectedDigest = manifest.agent_digests[resolution.agent_file];
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    refuse('STALE_GENERATED_AGENT', `generated-agent manifest ${manifestPath} has no trusted digest for ${resolution.agent_file}`, { manifest: manifestPath, agent_file: resolution.agent_file });
  }
  if (actualDigest !== expectedDigest) {
    refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} content does not match its trusted manifest digest`, { manifest: manifestPath, agent_file: resolution.agent_file, expected: expectedDigest, actual: actualDigest });
  }
  return { manifest: manifestPath, digest: expectedDigest };
}

function generatedAgentEvidence(resolution, adapter) {
  const root = generatedAgentRoot(adapter);
  if (!root || !resolution.agent_file) return null;
  const file = path.resolve(root, resolution.agent_file);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    refuse('STALE_GENERATED_AGENT', `generated agent path escapes its configured Codex agents directory: ${resolution.agent_file}`, { agent_file: resolution.agent_file });
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} does not exist in ${root}`, { agent_file: resolution.agent_file });
    }
    refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} could not be read: ${error.message}`, { agent_file: resolution.agent_file });
  }
  const expected = {
    name: resolution.agent_file.replace(/\.toml$/, ''),
    model: resolution.model,
    effort: resolution.effort,
    policy_id: canonicalPolicy.POLICY.id,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    policy_runtime: 'codex',
    policy_role: resolution.role,
    policy_rung: resolution.rung,
  };
  const actual = {
    name: quotedTomlField(text, 'name'),
    model: quotedTomlField(text, 'model'),
    effort: quotedTomlField(text, 'model_reasoning_effort'),
    policy_id: generatedPolicyComment(text, 'id'),
    policy_version: generatedPolicyComment(text, 'version'),
    policy_hash: generatedPolicyComment(text, 'hash'),
    policy_runtime: generatedPolicyComment(text, 'runtime'),
    policy_role: generatedPolicyComment(text, 'role'),
    policy_rung: generatedPolicyComment(text, 'rung'),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (actual[field] !== value) {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} is not bound to ADR-014: ${field}=${JSON.stringify(actual[field])}, expected ${JSON.stringify(value)}`, { agent_file: resolution.agent_file, field, expected: value, actual: actual[field] });
    }
  }
  const agentFileDigest = crypto.createHash('sha256').update(text).digest('hex');
  trustedGeneratedAgentDigest(resolution, adapter, root, agentFileDigest);
  return {
    valid: true,
    exists: true,
    content_verified: true,
    policy_hash: resolution.policy_hash,
    agent_file: resolution.agent_file,
    agent_file_digest: agentFileDigest,
  };
}

function validateWithAdapter(resolution, adapter) {
  canonicalValidateResolution(resolution, { requireDispatchId: true });
  adapterSupports(adapter, resolution);
  let validatedResolution = resolution;
  if (resolution.agent_file) {
    const evidence = generatedAgentEvidence(resolution, adapter)
      || (typeof adapter.validateGeneratedAgent === 'function'
        ? invokeSync(adapter.validateGeneratedAgent, adapter, [resolution], 'adapter.validateGeneratedAgent')
        : null);
    if (!evidence) {
      refuse('STALE_GENERATED_AGENT', `Codex static dispatch requires ${resolution.agent_file} existence/content/fingerprint validation before launch`, { agent_file: resolution.agent_file });
    }
    if (!isObject(evidence) || evidence.valid !== true || evidence.exists !== true || evidence.content_verified !== true || evidence.policy_hash !== resolution.policy_hash || evidence.agent_file !== resolution.agent_file) {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} is missing, stale, or not bound to the active policy fingerprint`, { expected: { agent_file: resolution.agent_file, policy_hash: resolution.policy_hash }, actual: evidence });
    }
    if (typeof evidence.agent_file_digest !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.agent_file_digest)) {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} did not return a content digest`, { agent_file: resolution.agent_file });
    }
    validatedResolution = deepFreeze(snapshot({ ...resolution, agent_file_digest: evidence.agent_file_digest }));
  }
  if (typeof adapter.validate === 'function') {
    const result = invokeSync(adapter.validate, adapter, [validatedResolution], 'adapter.validate');
    if (result === false || result && result.valid === false) {
      const reason = result && typeof result.reason === 'string' ? `: ${result.reason}` : '';
      refuse('UNSUPPORTED_SELECTION', `adapter validation refused the resolved selection${reason}`, { resolution: validatedResolution });
    }
  }
  return validatedResolution;
}

function unwrapReceipt(value) {
  if (isObject(value) && isObject(value.application_receipt)) return value.application_receipt;
  if (isObject(value) && isObject(value.receipt)) return value.receipt;
  return value;
}

function observedValue(receipt, field, applied, allowUnknown) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
    if (allowUnknown) return OBSERVATION_UNKNOWN;
    refuse('MISSING_RECEIPT', `application receipt is missing ${field}`, { field });
  }
  const value = receipt[field];
  if (value === OBSERVATION_UNKNOWN) {
    if (!allowUnknown) refuse('NONCOMPLIANT_RECEIPT', `${field}=unknown is not permitted when the adapter claims observation support`, { field });
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_RECEIPT', `${field} must be a concrete whitespace-free value or unknown`, { field });
  }
  if (value !== applied) {
    refuse('NONCOMPLIANT_RECEIPT', `${field} ${JSON.stringify(value)} contradicts applied value ${JSON.stringify(applied)}`, { field, applied, observed: value });
  }
  return value;
}

function verifyApplicationReceiptInternal(resolution, rawReceipt, options = {}) {
  const receipt = unwrapReceipt(rawReceipt);
  if (!isObject(receipt)) {
    refuse('MISSING_RECEIPT', 'launch did not return an application receipt; a successful process exit is not evidence of application');
  }
  const requiredFields = [
    'receipt_type',
    'runtime',
    'role',
    'dispatch_id',
    'launch_id',
    'requested_model',
    'requested_effort',
    'applied_model',
    'applied_effort',
    'policy_hash',
  ];
  if (options.requireComplianceProof !== false) {
    requiredFields.push('compliance', 'compliance_proof');
  }
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
      refuse('MISSING_RECEIPT', `application receipt is missing ${field}`, { field });
    }
  }
  nonEmpty(receipt.runtime, 'runtime');
  nonEmpty(receipt.role, 'role');
  nonEmpty(receipt.dispatch_id, 'dispatch_id');
  nonEmpty(receipt.policy_hash, 'policy_hash');
  if (receipt.runtime !== resolution.runtime) {
    refuse('NONCOMPLIANT_RECEIPT', `application receipt runtime ${JSON.stringify(receipt.runtime)} does not match ${resolution.runtime}`, { expected: resolution.runtime, actual: receipt.runtime });
  }
  if (receipt.receipt_type !== 'adr-014.application' || receipt.role !== resolution.role) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt type or role does not match the immutable resolution', { expected: { receipt_type: 'adr-014.application', role: resolution.role }, actual: { receipt_type: receipt.receipt_type, role: receipt.role } });
  }
  if (receipt.policy_hash !== resolution.policy_hash) {
    refuse('STALE_POLICY', 'application receipt policy fingerprint does not match the resolved policy', { expected: resolution.policy_hash, actual: receipt.policy_hash });
  }
  if (receipt.dispatch_id !== resolution.dispatch_id) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt dispatch_id does not match the boundary dispatch', { expected: resolution.dispatch_id, actual: receipt.dispatch_id });
  }
  nonEmpty(receipt.launch_id, 'launch_id');
  if (receipt.requested_model !== resolution.requested_model || receipt.requested_effort !== resolution.requested_effort) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt requested values do not match the immutable resolution', {
      expected: { model: resolution.requested_model, effort: resolution.requested_effort },
      actual: { model: receipt.requested_model, effort: receipt.requested_effort },
    });
  }
  if (receipt.applied_model !== resolution.model || receipt.applied_effort !== resolution.effort) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt applied values do not match the resolved selection', {
      expected: { model: resolution.model, effort: resolution.effort },
      actual: { model: receipt.applied_model, effort: receipt.applied_effort },
    });
  }
  if (resolution.agent_file) {
    if (receipt.agent_file !== resolution.agent_file) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt agent_file does not match the resolved generated file', { expected: resolution.agent_file, actual: receipt.agent_file });
    }
  } else if (receipt.agent_file !== undefined && receipt.agent_file !== null) {
    refuse('NONCOMPLIANT_RECEIPT', 'a dynamic/Workflow launch must not claim a static agent file', { actual: receipt.agent_file });
  }
  if (receipt.backend !== undefined && receipt.backend !== resolution.backend) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt backend does not match the resolved backend', { expected: resolution.backend, actual: receipt.backend });
  }
  if (receipt.mechanism !== undefined && receipt.mechanism !== resolution.mechanism) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt mechanism does not match the resolved mechanism', { expected: resolution.mechanism, actual: receipt.mechanism });
  }
  if (options.requireComplianceProof !== false) {
    if (receipt.compliance !== 'verified' || !isObject(receipt.compliance_proof)) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt must carry boundary compliance proof');
    }
    if (receipt.compliance_proof.status !== 'verified'
        || receipt.compliance_proof.boundary !== 'adr-014.dispatch-boundary'
        || receipt.compliance_proof.policy_hash !== receipt.policy_hash
        || receipt.compliance_proof.dispatch_id !== receipt.dispatch_id
        || receipt.compliance_proof.launch_id !== receipt.launch_id) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt compliance proof is incomplete or contradictory');
    }
  }
  if (resolution.agent_file) {
    if (typeof resolution.agent_file_digest !== 'string' || receipt.agent_file_digest !== resolution.agent_file_digest) {
      refuse('NONCOMPLIANT_RECEIPT', 'static Codex receipt must carry the validated generated-agent digest', { expected: resolution.agent_file_digest, actual: receipt.agent_file_digest });
    }
  }

  const adapter = options.adapter || null;
  const observationCapabilities = isObject(options.observationCapabilities)
    ? {
      model: options.observationCapabilities.model === true,
      effort: options.observationCapabilities.effort === true,
    }
    : typeof options.allowUnknown === 'boolean'
      ? { model: options.allowUnknown, effort: options.allowUnknown }
      : adapterObservationCapabilities(adapter);
  const observedModel = observedValue(receipt, 'observed_model', receipt.applied_model, observationCapabilities.model);
  const observedEffort = observedValue(receipt, 'observed_effort', receipt.applied_effort, observationCapabilities.effort);
  const normalized = {
    ...snapshot(receipt),
    observed_model: observedModel,
    observed_effort: observedEffort,
  };
  return deepFreeze(normalized);
}

function withoutBoundaryClaims(evidence) {
  const {
    compliance: ignoredCompliance,
    compliance_proof: ignoredProof,
    observation_unavailable: ignoredObservationCapability,
    ...applicationEvidence
  } = evidence;
  return applicationEvidence;
}

function finalizeApplicationReceipt(resolution, evidence, adapter, observationCapabilities) {
  const finalized = {
    ...withoutBoundaryClaims(evidence),
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: evidence.launch_id,
    },
  };
  return verifyApplicationReceiptInternal(resolution, finalized, { adapter, observationCapabilities });
}

function recorderFor(options, adapter) {
  if (typeof options.recorder === 'function') return options.recorder;
  if (options.recorder && typeof options.recorder.record === 'function') return options.recorder;
  if (adapter && typeof adapter.record === 'function') return adapter;
  return null;
}

function recorderRecord(recorder, recordInput, claimAuthority) {
  const target = typeof recorder === 'function'
    ? { fn: recorder, receiver: null, name: 'dispatch recorder' }
    : recorderMethod(recorder, ['record']);
  if (!target) refuse('RECORD_UNAVAILABLE', 'durable dispatch recorder has no record method');
  const args = DURABLE_RECORDERS.has(recorder)
    ? [recordInput, RECORDER_AUTHORITY, claimAuthority]
    : [recordInput];
  return invokeSync(target.fn, target.receiver, args, target.name);
}

function recorderFinalize(recorder, recordInput) {
  const target = recorderMethod(recorder, ['finalize', 'finalizeRecord']);
  if (!target) return;
  const args = DURABLE_RECORDERS.has(recorder)
    ? [recordInput, RECORDER_AUTHORITY]
    : [recordInput];
  const result = invokeSync(target.fn, target.receiver, args, 'dispatch record finalization');
  if (!affirmative(result, 'finalized')) {
    refuse('RECORD_FAILED', 'durable dispatch record could not be finalized after acknowledgement', { dispatch_id: recordInput.dispatch_id });
  }
}

function recorderReserve(recorder, dispatchId, reservation) {
  const target = recorderMethod(recorder, ['reserve', 'reserveDispatch']);
  if (target) {
    let result;
    try {
      result = invokeSync(target.fn, target.receiver, [dispatchId, reservation], 'dispatch reservation');
    } catch (error) {
      if (error && (error.code === 'DUPLICATE_DISPATCH_ID' || error.code === 'EEXIST')) {
        refuse('DUPLICATE_DISPATCH_ID', 'dispatch id was already durably reserved; replay cannot launch', { dispatch_id: dispatchId });
      }
      throw error;
    }
    if (!affirmative(result, 'reserved')) {
      refuse('DUPLICATE_DISPATCH_ID', 'durable recorder refused the dispatch id; replay cannot launch', { dispatch_id: dispatchId });
    }
    return;
  }
  const state = sharedRecorderState(recorder);
  if (!state) refuse('RECORD_UNAVAILABLE', 'dispatch recorder cannot provide durable identity reservation');
  if (state.reserved.has(dispatchId) || state.records.has(dispatchId)) {
    refuse('DUPLICATE_DISPATCH_ID', 'dispatch id was already reserved or recorded; replay cannot launch', { dispatch_id: dispatchId });
  }
  state.reserved.add(dispatchId);
}

function recorderRecordRemember(recorder, recordInput) {
  const state = sharedRecorderState(recorder);
  if (!state || !recordInput || typeof recordInput.dispatch_id !== 'string') return;
  state.records.set(recordInput.dispatch_id, recordInput);
  const receipt = recordInput.receipt;
  if (isObject(receipt) && typeof receipt.runtime === 'string' && typeof receipt.role === 'string') {
    state.latest.set(`${receipt.runtime}:${receipt.role}`, recordInput);
  }
}

function recorderClaim(recorder, dispatchId, consumerId) {
  const target = recorderMethod(recorder, ['claim', 'claimReceipt', 'reserveReceipt']);
  if (target) {
    let result;
    try {
      result = invokeSync(target.fn, target.receiver, [dispatchId, consumerId], 'receipt claim');
    } catch (error) {
      if (error && (error.code === 'DUPLICATE_DISPATCH_ID' || error.code === 'EEXIST')) {
        refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already claimed by another repair dispatch', { dispatch_id: dispatchId });
      }
      throw error;
    }
    if (!affirmative(result, 'claimed')) {
      refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already claimed by another repair dispatch', { dispatch_id: dispatchId });
    }
    return isObject(result) ? result : { claimed: true, dispatch_id: dispatchId, consumer_id: consumerId };
  }
  const state = sharedRecorderState(recorder);
  if (!state) return false;
  const current = state.claims.get(dispatchId);
  if (current && current !== consumerId) {
    refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already claimed by another repair dispatch', { dispatch_id: dispatchId });
  }
  if (current === consumerId) return { claimed: true, dispatch_id: dispatchId, consumer_id: consumerId };
  state.claims.set(dispatchId, consumerId);
  return { claimed: true, dispatch_id: dispatchId, consumer_id: consumerId };
}

function recorderRenew(recorder, dispatchId, consumerId, claimAuthority) {
  const target = recorderMethod(recorder, ['renewClaim', 'renew', 'heartbeat']);
  if (target) {
    const result = invokeSync(target.fn, target.receiver, [dispatchId, consumerId, claimAuthority], 'receipt claim renewal');
    return result === undefined || affirmative(result, 'renewed');
  }
  const state = sharedRecorderState(recorder);
  if (!state) return true;
  return state.claims.get(dispatchId) === consumerId;
}

function startClaimLease(recorder, dispatchId, consumerId, claimAuthority) {
  let failure = null;
  const timer = setInterval(() => {
    try {
      if (!recorderRenew(recorder, dispatchId, consumerId, claimAuthority)) {
        failure = boundaryError('RECORD_FAILED', 'durable receipt claim lease was lost before launch finalization', { dispatch_id: dispatchId });
      }
    } catch (error) {
      failure = error;
    }
  }, CLAIM_HEARTBEAT_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    assertHealthy() {
      if (failure) throw failure;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

function recorderRelease(recorder, dispatchId, consumerId, claimAuthority) {
  const target = recorderMethod(recorder, ['release', 'releaseReceipt', 'releaseClaim']);
  if (target) {
    const result = invokeSync(target.fn, target.receiver, [dispatchId, consumerId, claimAuthority], 'receipt claim release');
    if (result !== undefined && !affirmative(result, 'released')) {
      refuse('RECORD_FAILED', 'durable receipt claim could not be released', { dispatch_id: dispatchId });
    }
    return;
  }
  const state = sharedRecorderState(recorder);
  if (state && state.claims.get(dispatchId) === consumerId) state.claims.delete(dispatchId);
}

function recorderStoredRecord(recorder, dispatchId) {
  const state = sharedRecorderState(recorder);
  if (state && state.records.has(dispatchId)) return state.records.get(dispatchId);
  const target = recorderMethod(recorder, ['getReceipt', 'readReceipt', 'getRecord', 'read']);
  if (!target) return null;
  const result = invokeSync(target.fn, target.receiver, [dispatchId], target.name);
  return result || null;
}

function recorderConsume(recorder, dispatchId, consumerId, claimAuthority) {
  const target = recorderMethod(recorder, ['consume', 'consumeReceipt']);
  if (target) {
    let result;
    try {
      result = invokeSync(target.fn, target.receiver, consumerId === undefined
        ? [dispatchId]
        : [dispatchId, consumerId, claimAuthority], 'receipt consumption');
    } catch (error) {
      if (error && (error.code === 'DUPLICATE_DISPATCH_ID' || error.code === 'EEXIST')) {
        refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already consumed by another repair dispatch', { dispatch_id: dispatchId });
      }
      throw error;
    }
    if (!affirmative(result, 'consumed')) {
      refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already consumed by another repair dispatch', { dispatch_id: dispatchId });
    }
    return;
  }
  const state = sharedRecorderState(recorder);
  if (!state) refuse('UNVERIFIED_RECEIPT', 'receipt consumption is not durable for this recorder', { dispatch_id: dispatchId });
  if (state.consumed.has(dispatchId)) {
    refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already consumed by another repair dispatch', { dispatch_id: dispatchId });
  }
  if (consumerId !== undefined) {
    const current = state.claims.get(dispatchId);
    if (current !== undefined && current !== consumerId) {
      refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already claimed by another repair dispatch', { dispatch_id: dispatchId });
    }
    state.claims.delete(dispatchId);
  }
  state.consumed.add(dispatchId);
}

function receiptFromStoredRecord(value) {
  if (isObject(value) && isObject(value.receipt)) return value.receipt;
  if (isObject(value) && isObject(value.application_receipt)) return value.application_receipt;
  return null;
}

function createDispatchBoundary(options = {}) {
  if (!isObject(options)) refuse('INVALID_INPUT', 'boundary options must be an object');
  const policy = options.policy || defaultPolicy;
  if (policy !== defaultPolicy) {
    refuse('NONCANONICAL_POLICY', 'dispatch is bound to the canonical ADR-014 policy; custom policy injection is not permitted');
  }
  if (!policy || typeof policy.resolveDispatch !== 'function' || typeof policy.validateResolution !== 'function') {
    refuse('INVALID_INPUT', 'boundary policy must expose resolveDispatch and validateResolution');
  }
  const adapters = options.adapters || {};
  const trustedReceipts = new Map();
  const trustedResolutions = new Map();
  const consumedReceiptIds = new Set();
  const reservedDispatchIds = new Set();

  function stableReceipt(receipt) {
    return canonicalStableStringify(receipt);
  }

  function priorReceiptFor(input) {
    const signals = input && input.signals;
    if (signals && Object.prototype.hasOwnProperty.call(signals, 'priorApplied')) return signals.priorApplied;
    if (input && Object.prototype.hasOwnProperty.call(input, 'priorApplied')) return input.priorApplied;
    if (input && Object.prototype.hasOwnProperty.call(input, 'priorReceipt')) return input.priorReceipt;
    return undefined;
  }

  function repairPrerequisiteFor(input) {
    const role = input && typeof input.role === 'string' ? input.role.trim() : input && input.role;
    const signals = input && input.signals;
    const state = signals && signals.signatureState;
    return canonicalPolicy.REPAIR_PREREQUISITES[role]
      && canonicalPolicy.REPAIR_PREREQUISITES[role][state]
      ? { role, signatureState: state, ...canonicalPolicy.REPAIR_PREREQUISITES[role][state] }
      : null;
  }

  function modelFor(runtime, logicalModel) {
    if (!canonicalPolicy.SUPPORTED_RUNTIMES.includes(runtime)) {
      refuse('UNKNOWN_RUNTIME', `unknown or ambiguous runtime ${JSON.stringify(runtime)}`);
    }
    const map = runtime === 'codex' ? canonicalPolicy.CODEX_MODEL_IDS : canonicalPolicy.CLAUDE_MODEL_ALIASES;
    const model = map && map[logicalModel];
    if (!model) refuse('UNSUPPORTED_SELECTION', `no ${runtime} model is registered for logical model ${logicalModel}`);
    return model;
  }

  function recordReceipt(value) {
    return receiptFromStoredRecord(value);
  }

  function trustedRecordFor(recorder, dispatchId) {
    // Arbitrary recorder objects are telemetry sinks, not trust roots. Only a
    // recorder branded by this module can authenticate durable boundary state
    // across calls or process restarts.
    if (!DURABLE_RECORDERS.has(recorder)) return null;
    const memoryReceipt = trustedReceipts.get(dispatchId);
    const memoryResolution = trustedResolutions.get(dispatchId);
    if (memoryReceipt
        && memoryReceipt.dispatch_id === dispatchId
        && memoryResolution
        && memoryResolution.dispatch_id === dispatchId) {
      return {
        record: { dispatch_id: dispatchId, receipt: memoryReceipt, resolution: trustedResolutions.get(dispatchId) },
        receipt: memoryReceipt,
        resolution: memoryResolution,
      };
    }
    const stored = recorderStoredRecord(recorder, dispatchId);
    const receipt = recordReceipt(stored);
    const resolution = stored && isObject(stored.resolution)
      ? stored.resolution
      : trustedResolutions.get(dispatchId);
    if (!stored
        || stored.dispatch_id !== dispatchId
        || !receipt
        || receipt.dispatch_id !== dispatchId
        || !resolution
        || resolution.dispatch_id !== dispatchId) return null;
    try {
      // This resolution was accepted only through the durable recorder.  Its
      // embedded predecessor is therefore a stored copy of already-verified
      // evidence, not a caller-provided object.
      if (isObject(resolution.signals) && isObject(resolution.signals.priorApplied)) {
        markBoundaryVerifiedReceipt(resolution.signals.priorApplied);
      }
      canonicalValidateResolution(resolution, { requireDispatchId: true });
      const verified = verifyApplicationReceiptInternal(resolution, receipt, {
        requireComplianceProof: true,
        // These flags mean "unknown allowed", and come only from the original
        // boundary-owned record, never from the caller's receipt or context.
        observationCapabilities: isObject(stored.observation_unavailable)
          ? stored.observation_unavailable
          : { model: false, effort: false },
      });
      if (stableReceipt(verified) !== stableReceipt(receipt)) return null;
      return { record: stored, receipt: verified, resolution };
    } catch (_) {
      return null;
    }
  }

  function verifyPriorReceipt(input, recorder) {
    const prerequisite = repairPrerequisiteFor(input);
    if (!prerequisite) return null;
    const raw = priorReceiptFor(input);
    if (!isObject(raw)) {
      refuse(
        'MISSING_RECEIPT',
        `${prerequisite.role} ${prerequisite.signatureState} escalation requires the immediately preceding compliant applied receipt`,
        prerequisite,
      );
    }
    const previousDispatchId = input.previous_dispatch_id;
    if (typeof previousDispatchId !== 'string' || previousDispatchId.trim() === '') {
      refuse('MISSING_RECEIPT', `${prerequisite.role} ${prerequisite.signatureState} escalation must identify its immediately preceding dispatch_id`, prerequisite);
    }
    const trusted = trustedRecordFor(recorder, previousDispatchId);
    const receipt = receiptFromStoredRecord(raw) || raw;
    if (!trusted || !isObject(receipt) || stableReceipt(receipt) !== stableReceipt(trusted.receipt)) {
      refuse('UNVERIFIED_RECEIPT', `${prerequisite.role} ${prerequisite.signatureState} escalation requires the receipt returned by the durable dispatch boundary`, { dispatch_id: previousDispatchId });
    }
    const runtime = String(input.runtime || '').trim();
    const expectedModel = modelFor(runtime, prerequisite.logical_model);
    if (trusted.receipt.runtime !== runtime || trusted.receipt.role !== prerequisite.role) {
      refuse('NONCOMPLIANT_RECEIPT', 'the preceding receipt runtime or role does not match the repair dispatch', { expected: { runtime, role: prerequisite.role }, actual: { runtime: trusted.receipt.runtime, role: trusted.receipt.role } });
    }
    if (trusted.receipt.applied_model !== expectedModel || trusted.receipt.applied_effort !== prerequisite.effort
        || trusted.receipt.requested_model !== expectedModel || trusted.receipt.requested_effort !== prerequisite.effort) {
      refuse(
        'NONCOMPLIANT_RECEIPT',
        `${prerequisite.role} ${prerequisite.signatureState} requires a preceding ${prerequisite.logical_model}/${prerequisite.effort} receipt on ${runtime}`,
        { expected: { model: expectedModel, effort: prerequisite.effort }, actual: { model: trusted.receipt.applied_model, effort: trusted.receipt.applied_effort } },
      );
    }
    if (consumedReceiptIds.has(previousDispatchId)) {
      refuse('UNVERIFIED_RECEIPT', 'the preceding receipt was already consumed by another repair dispatch', { dispatch_id: previousDispatchId });
    }
    return {
      dispatch_id: previousDispatchId,
      model: trusted.receipt.applied_model,
      effort: trusted.receipt.applied_effort,
      receipt: trusted.receipt,
      resolution: trusted.resolution,
    };
  }

  function registerReceipt(receipt, resolution, recorder, recordInput) {
    const stored = deepFreeze(snapshot(receipt));
    const prior = trustedReceipts.get(stored.dispatch_id);
    if (prior) {
      refuse('DUPLICATE_DISPATCH_ID', 'dispatch id was already registered; replay cannot be recorded twice', { dispatch_id: stored.dispatch_id });
    }
    trustedReceipts.set(stored.dispatch_id, stored);
    trustedResolutions.set(stored.dispatch_id, deepFreeze(snapshot(resolution)));
    recorderRecordRemember(recorder, recordInput);
    return stored;
  }

  function reserveDispatchId(dispatchId, recorder, resolution) {
    if (reservedDispatchIds.has(dispatchId) || trustedReceipts.has(dispatchId)) {
      refuse('DUPLICATE_DISPATCH_ID', 'dispatch id was already reserved or recorded; replay cannot launch', { dispatch_id: dispatchId });
    }
    recorderReserve(recorder, dispatchId, {
      dispatch_id: dispatchId,
      runtime: resolution.runtime,
      role: resolution.role,
      policy_hash: resolution.policy_hash,
    });
    reservedDispatchIds.add(dispatchId);
  }

  function consumePriorReceipt(prior, recorder, consumerId, claimAuthority) {
    if (!prior) return;
    recorderConsume(recorder, prior.dispatch_id, consumerId, claimAuthority);
    consumedReceiptIds.add(prior.dispatch_id);
  }

  function inputWithoutReceipt(input) {
    const safe = { ...input };
    if (safe.signals && typeof safe.signals === 'object' && !Array.isArray(safe.signals)) {
      safe.signals = { ...safe.signals };
      delete safe.signals.priorApplied;
    }
    delete safe.priorApplied;
    delete safe.priorReceipt;
    return safe;
  }

  function resolve(input, recorder) {
    if (!isObject(input)) refuse('INVALID_INPUT', 'dispatch input must be an object');
    const withId = Object.prototype.hasOwnProperty.call(input, 'dispatch_id')
      || Object.prototype.hasOwnProperty.call(input, 'dispatchId')
      ? input
      : { ...input, dispatch_id: newDispatchId() };
    const prior = verifyPriorReceipt(withId, recorder);
    const canonicalInput = inputWithoutReceipt(withId);
    if (prior) {
      markBoundaryVerifiedReceipt(prior.receipt);
      canonicalInput.signals = {
        ...(canonicalInput.signals || {}),
        priorApplied: prior.receipt,
      };
    }
    const resolved = canonicalResolveDispatch(canonicalInput);
    const output = snapshot(prior ? { ...resolved, prior_applied: {
      dispatch_id: prior.dispatch_id,
      model: prior.model,
      effort: prior.effort,
    } } : resolved);
    // snapshot() deliberately severs every other caller reference. Rebrand
    // this one cloned predecessor only because `prior` was re-read from the
    // durable recorder immediately above.
    if (prior && isObject(output.signals) && isObject(output.signals.priorApplied)) {
      markBoundaryVerifiedReceipt(output.signals.priorApplied);
    }
    return deepFreeze(output);
  }

  function validate(resolution, validateOptions = {}) {
    const adapter = validateOptions.adapter || adapterFor(validateOptions.adapters || adapters, resolution && resolution.runtime);
    validateWithAdapter(resolution, adapter);
    return true;
  }

  function receipt(resolution, rawReceipt, receiptOptions) {
    if (receiptOptions !== undefined) {
      refuse('UNSUPPORTED_SELECTION', 'receipt verification options are boundary-owned; pass only the resolution and application receipt');
    }
    const adapter = adapterFor(adapters, resolution && resolution.runtime);
    const validatedResolution = validateWithAdapter(resolution, adapter);
    const observationCapabilities = adapterObservationCapabilities(adapter);
    const evidence = verifyApplicationReceiptInternal(validatedResolution, rawReceipt, {
      adapter,
      observationCapabilities,
      requireComplianceProof: false,
    });
    // This helper is deliberately an evidence parser, not a trust mint.  Only
    // dispatch() can add the boundary proof and put the receipt in durable
    // storage; callers cannot turn a self-asserted proof into repair authority.
    return deepFreeze(snapshot(withoutBoundaryClaims(evidence)));
  }

  function dispatch(input, context = {}) {
    if (!isObject(input)) refuse('INVALID_INPUT', 'dispatch input must be an object');
    const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : input.runtime;
    const adapter = adapterFor(adapters, runtime);
    const record = recorderFor(options, adapter);
    const resolution = resolve(input, record);
    if (!record) {
      refuse('RECORD_UNAVAILABLE', 'durable dispatch recording is mandatory; refusing to launch without a recorder');
    }
    const stages = [
      { stage: 'resolve', status: 'passed', policy_version: resolution.policy_version, policy_hash: resolution.policy_hash },
    ];
    const validatedResolution = validateWithAdapter(resolution, adapter);
    stages.push({ stage: 'validate', status: 'passed' });
    const fn = typeof adapter.launch === 'function'
      ? adapter.launch
      : typeof adapter.apply === 'function'
        ? adapter.apply
        : null;
    if (!fn) refuse('MISSING_ADAPTER', `${resolution.runtime} dispatch adapter has no launch method`, { runtime: resolution.runtime });
    reserveDispatchId(validatedResolution.dispatch_id, record, validatedResolution);
    const prior = validatedResolution.prior_applied;
    const claimConsumerId = validatedResolution.dispatch_id;
    let priorClaim = null;
    let priorLease = null;
    if (prior) {
      priorClaim = recorderClaim(record, prior.dispatch_id, claimConsumerId);
      if (priorClaim) priorLease = startClaimLease(record, prior.dispatch_id, claimConsumerId, priorClaim);
    }
    const observationCapabilities = adapterObservationCapabilities(adapter);
    const finish = (launchResult) => {
      if (priorLease) priorLease.assertHealthy();
      const rawReceipt = unwrapReceipt(launchResult);
      const applicationEvidence = verifyApplicationReceiptInternal(validatedResolution, rawReceipt, {
        adapter,
        observationCapabilities,
        requireComplianceProof: false,
      });
      const strippedEvidence = withoutBoundaryClaims(applicationEvidence);
      stages.push({ stage: 'launch', status: 'passed', launch_id: strippedEvidence.launch_id });
      // The durable recorder receives this exact finalized receipt.  It is the
      // only value that may later authorize a repair escalation.
      const applicationReceipt = finalizeApplicationReceipt(validatedResolution, applicationEvidence, adapter, observationCapabilities);
      const baseTrace = {
        dispatch_id: validatedResolution.dispatch_id,
        policy_version: validatedResolution.policy_version,
        policy_hash: validatedResolution.policy_hash,
        runtime: validatedResolution.runtime,
        role: validatedResolution.role,
        logical_rung: validatedResolution.logical_rung,
        rung: validatedResolution.rung,
        route: validatedResolution.route,
        backend: validatedResolution.backend,
        mechanism: validatedResolution.mechanism,
        resolution: validatedResolution,
        requested: { model: validatedResolution.requested_model, effort: validatedResolution.requested_effort },
        applied: { model: applicationReceipt.applied_model, effort: applicationReceipt.applied_effort },
        observed: { model: applicationReceipt.observed_model, effort: applicationReceipt.observed_effort },
        observation_unavailable: observationCapabilities,
        requested_model: validatedResolution.requested_model,
        requested_effort: validatedResolution.requested_effort,
        applied_model: applicationReceipt.applied_model,
        applied_effort: applicationReceipt.applied_effort,
        observed_model: applicationReceipt.observed_model,
        observed_effort: applicationReceipt.observed_effort,
        application_evidence: strippedEvidence,
        receipt: applicationReceipt,
        ...(prior ? {
          predecessor_dispatch_id: prior.dispatch_id,
          predecessor_consumer_id: claimConsumerId,
        } : {}),
      };
      const recordInput = deepFreeze(snapshot({
        ...baseTrace,
        // The record itself is not yet known to have succeeded. Persist only
        // completed stages; the returned trace gains record/receipt after the
        // recorder's affirmative acknowledgement below.
        trace: [...stages],
      }));
      const recordResult = recorderRecord(record, recordInput, priorClaim);
      if (!affirmative(recordResult, 'recorded')) {
        refuse('RECORD_FAILED', 'durable dispatch recording did not return affirmative acknowledgement; the launch is not compliant', { dispatch_id: resolution.dispatch_id });
      }
      if (priorLease) priorLease.assertHealthy();
      stages.push({ stage: 'record', status: 'passed' });
      stages.push({ stage: 'receipt', status: 'passed', launch_id: applicationReceipt.launch_id });
      const finalizedRecord = deepFreeze(snapshot({
        ...baseTrace,
        trace: stages,
      }));
      recorderFinalize(record, finalizedRecord);
      consumePriorReceipt(prior, record, claimConsumerId, priorClaim);
      registerReceipt(applicationReceipt, validatedResolution, record, finalizedRecord);
      if (priorLease) priorLease.stop();
      return finalizedRecord;
    };
    try {
      const launchResult = invokeLaunch(fn, adapter, [validatedResolution, context]);
      if (launchResult && typeof launchResult.then === 'function') {
        return launchResult.then(finish).catch((error) => {
          if (priorLease) priorLease.stop();
          if (priorClaim) recorderRelease(record, prior.dispatch_id, claimConsumerId, priorClaim);
          throw error;
        });
      }
      return finish(launchResult);
    } catch (error) {
      if (priorLease) priorLease.stop();
      if (priorClaim) recorderRelease(record, prior.dispatch_id, claimConsumerId, priorClaim);
      throw error;
    }
  }

  return Object.freeze({ resolve, validate, receipt, dispatch });
}

function resolveDispatch(input) {
  return defaultPolicy.resolveDispatch(input);
}

function validateDispatch(resolution, options = {}) {
  return createDispatchBoundary(options).validate(resolution, options);
}

function dispatch(input, options = {}) {
  return createDispatchBoundary(options).dispatch(input, options.context || {});
}

module.exports = Object.freeze({
  OBSERVATION_UNKNOWN,
  newDispatchId,
  createDurableRecorder,
  createDispatchBoundary,
  generatedAgentEvidence,
  isBoundaryVerifiedReceipt,
  resolveDispatch,
  validateDispatch,
  dispatch,
  dispatchThroughBoundary: dispatch,
  boundaryError,
});
