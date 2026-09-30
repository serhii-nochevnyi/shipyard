'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, writeAtomic } = require('./lock.cjs');

const SCHEMA = 'shipyard.planning-writer-lease.v1';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const TOKEN_BYTES = 32;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, details = {}) {
  const error = new Error(`planning-writer-lease: ${message}`);
  error.code = code;
  error.details = details;
  throw error;
}

function safeString(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_INPUT', `${field} must be a non-empty safe string`, { field });
  }
  return value.trim();
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_INPUT', `${field} must be a non-negative safe integer`, { field });
  }
  return value;
}

function nowValue(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  if (!Number.isFinite(value) || value < 0) fail('INVALID_INPUT', 'now() must return a non-negative finite number');
  return value;
}

// @security: EPERM means the pid belongs to another user, so it still counts as live.
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function realpathClosest(target) {
  let root = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(root)) {
    missing.unshift(path.basename(root));
    const parent = path.dirname(root);
    if (parent === root) fail('INVALID_INPUT', 'stateRoot cannot be resolved');
    root = parent;
  }
  return path.join(fs.realpathSync(root), ...missing);
}

function posixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function walkFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function digestFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createPlanningWriterLease(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'options must be an object');
  const worktree = safeString(options.worktree, 'worktree');
  if (!path.isAbsolute(worktree)) fail('INVALID_INPUT', 'worktree must be an absolute path');
  const worktreeReal = fs.realpathSync(worktree);
  const phaseDir = safeString(options.phaseDir, 'phaseDir');
  const phaseDirAbs = path.isAbsolute(phaseDir) ? phaseDir : path.join(worktreeReal, phaseDir);
  const stateRootRaw = safeString(options.stateRoot, 'stateRoot');
  const stateRootResolved = realpathClosest(stateRootRaw);
  const relativeToWorktree = path.relative(worktreeReal, stateRootResolved);
  if (relativeToWorktree === '' || (!relativeToWorktree.startsWith('..') && !path.isAbsolute(relativeToWorktree))) {
    fail('INVALID_STATE_ROOT', 'stateRoot must be outside the worktree', { stateRoot: stateRootResolved, worktree: worktreeReal });
  }
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const clock = typeof options.now === 'function' ? options.now : null;

  const key = crypto.createHash('sha256').update(`${worktreeReal}\n${phaseDir}`).digest('hex');
  const dir = path.join(stateRootResolved, key);
  const file = path.join(dir, 'lease.json');
  const lockDir = path.join(dir, '.locks');

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
  }

  function readRecord() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { fail('CORRUPT_STATE', `lease state is not valid JSON: ${error.message}`); }
    if (!object(parsed) || parsed.schema !== SCHEMA) fail('CORRUPT_STATE', 'lease state has an unrecognized schema');
    return parsed;
  }

  // @security: writeAtomic's temp file inherits default permissions, so 0600 is applied after the rename.
  function writeRecord(record) {
    writeAtomic(file, JSON.stringify(record));
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  function liveActiveOwner(record, now) {
    return Boolean(record) && record.status === 'active' && record.expires_at > now;
  }

  function assertMatch(record, token, epoch) {
    if (!record || record.status !== 'active' || record.token !== token || record.epoch !== epoch) {
      fail('WRITER_FENCED', 'the lease token or epoch has been superseded', { epoch });
    }
  }

  function acquire(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'acquire input must be an object');
    const owner = safeString(input.owner, 'owner');
    const baseRevision = safeString(input.base_revision, 'base_revision');
    ensureDir();
    let result;
    withLock(lockDir, 'writer', () => {
      const now = nowValue(clock);
      const record = readRecord();
      if (liveActiveOwner(record, now) && record.owner !== owner) {
        fail('WRITER_LEASED', `the planning writer lease is held by ${record.owner} until ${new Date(record.expires_at).toISOString()}`,
          { owner: record.owner, expires_at: record.expires_at });
      }
      const epoch = record ? record.epoch + 1 : 0;
      const next = {
        schema: SCHEMA, version: 1, owner, pid: process.pid,
        token: crypto.randomBytes(TOKEN_BYTES).toString('hex'), epoch,
        base_revision: baseRevision, acquired_at: now, heartbeat_at: now,
        expires_at: now + ttlMs, status: 'active',
      };
      writeRecord(next);
      result = { token: next.token, epoch: next.epoch, expires_at: next.expires_at };
    }, { label: 'planning-writer-lease' });
    return result;
  }

  function heartbeat(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'heartbeat input must be an object');
    const token = safeString(input.token, 'token');
    const epoch = nonNegativeInteger(input.epoch, 'epoch');
    ensureDir();
    let result;
    withLock(lockDir, 'writer', () => {
      const now = nowValue(clock);
      const record = readRecord();
      assertMatch(record, token, epoch);
      record.heartbeat_at = now;
      record.expires_at = now + ttlMs;
      writeRecord(record);
      result = { renewed: true, epoch: record.epoch, expires_at: record.expires_at };
    }, { label: 'planning-writer-lease' });
    return result;
  }

  function assertFence(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'assertFence input must be an object');
    const token = safeString(input.token, 'token');
    const epoch = nonNegativeInteger(input.epoch, 'epoch');
    const baseRevision = safeString(input.base_revision, 'base_revision');
    const now = nowValue(clock);
    const record = readRecord();
    assertMatch(record, token, epoch);
    if (record.expires_at <= now) {
      fail('LEASE_EXPIRED', `the planning writer lease expired at ${new Date(record.expires_at).toISOString()}`, { expires_at: record.expires_at });
    }
    if (record.base_revision !== baseRevision) {
      fail('BASE_MOVED', `the base revision moved from ${record.base_revision} to ${baseRevision}`,
        { from: record.base_revision, to: baseRevision });
    }
    return { ok: true, owner: record.owner, epoch: record.epoch, expires_at: record.expires_at };
  }

  function release(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'release input must be an object');
    const token = safeString(input.token, 'token');
    const epoch = nonNegativeInteger(input.epoch, 'epoch');
    ensureDir();
    let result;
    withLock(lockDir, 'writer', () => {
      const now = nowValue(clock);
      const record = readRecord();
      assertMatch(record, token, epoch);
      record.status = 'released';
      record.released_at = now;
      writeRecord(record);
      result = { released: true };
    }, { label: 'planning-writer-lease' });
    return result;
  }

  function recover(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'recover input must be an object');
    const owner = safeString(input.owner, 'owner');
    const reason = safeString(input.reason, 'reason');
    ensureDir();
    let result;
    withLock(lockDir, 'writer', () => {
      const now = nowValue(clock);
      const record = readRecord();
      if (liveActiveOwner(record, now) && pidAlive(record.pid)) {
        fail('WRITER_LEASED', `cannot recover — ${record.owner} is live (pid ${record.pid}) until ${new Date(record.expires_at).toISOString()}`,
          { owner: record.owner, pid: record.pid, expires_at: record.expires_at });
      }
      const epoch = record ? record.epoch + 1 : 0;
      const next = {
        schema: SCHEMA, version: 1, owner, pid: process.pid,
        token: crypto.randomBytes(TOKEN_BYTES).toString('hex'), epoch,
        base_revision: record ? record.base_revision : null, acquired_at: now, heartbeat_at: now,
        expires_at: now + ttlMs, status: 'active',
        recovered_reason: reason, recovered_from_epoch: record ? record.epoch : null,
      };
      writeRecord(next);
      result = { token: next.token, epoch: next.epoch, expires_at: next.expires_at, recovered: true };
    }, { label: 'planning-writer-lease' });
    return result;
  }

  function snapshotTree() {
    const digests = {};
    for (const full of walkFiles(phaseDirAbs)) digests[posixRelative(phaseDirAbs, full)] = digestFile(full);
    return { schema: 'shipyard.planning-writer-lease.snapshot.v1', version: 1, taken_at: nowValue(clock), digests };
  }

  function changedSince(snapshot) {
    if (!object(snapshot) || !object(snapshot.digests)) fail('INVALID_INPUT', 'snapshot must be a snapshotTree() result');
    const after = snapshotTree();
    const paths = new Set([...Object.keys(snapshot.digests), ...Object.keys(after.digests)]);
    const changed = [...paths].filter((relPath) => snapshot.digests[relPath] !== after.digests[relPath]).sort();
    return { changed, lease: readRecord() };
  }

  return Object.freeze({
    schema: SCHEMA, version: 1, ttl_ms: ttlMs, key,
    acquire, heartbeat, assertFence, release, recover, snapshotTree, changedSince,
  });
}

module.exports = Object.freeze({ SCHEMA, DEFAULT_TTL_MS, createPlanningWriterLease });
