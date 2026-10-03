'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
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

// @security: only ESRCH proves the recorded process stopped.
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || error.code !== 'ESRCH'; }
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

function sharedPlanningWriterRoot(testWriterStateRoot) {
  return realpathClosest(testWriterStateRoot || path.join(os.userInfo().homedir,
    '.local', 'state', 'shipyard', 'planning-writers', 'shared'));
}

function legacyPlanningWriterRoots({ worktree, phase, repository, privateRoots = [] }) {
  const real = fs.realpathSync(worktree);
  const homes = [...new Set([os.userInfo().homedir, os.homedir(), process.env.HOME]
    .filter((item) => typeof item === 'string' && path.isAbsolute(item)))];
  const codex = homes.map((home) => path.join(home, '.local', 'state', 'shipyard', 'codex-decompose',
    crypto.createHash('sha256').update(real).digest('hex'), 'writer'));
  const gitCommon = fs.realpathSync(path.resolve(real, execFileSync('git',
    ['-C', real, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 10000 }).trim()));
  const claude = [];
  for (const home of homes) {
    const claudeBase = path.join(home, '.local', 'state', 'shipyard', 'claude-decompose');
    claude.push(...[repository, gitCommon].map((identity) => path.join(claudeBase,
      crypto.createHash('sha256').update(`${identity}\n${real}\n${phase}`).digest('hex'), 'writer')));
    try {
      const entries = fs.readdirSync(claudeBase, { withFileTypes: true });
      if (entries.length > 4096) fail('LEGACY_WRITER_STATE', 'private Claude writer root exceeds inspection bound');
      for (const entry of entries) {
        if (entry.isSymbolicLink()) fail('LEGACY_WRITER_STATE', 'private Claude writer root has a symbolic link');
        if (entry.isDirectory()) claude.push(path.join(claudeBase, entry.name, 'writer'));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.code === 'LEGACY_WRITER_STATE') throw error;
        fail('LEGACY_WRITER_STATE', 'private Claude writer root cannot be inspected');
      }
    }
  }
  return [...new Set([...codex, ...claude, ...privateRoots])];
}

function assertNoLegacyPlanningWriter({ worktree, phaseDir, roots = [] }) {
  const key = crypto.createHash('sha256').update(`${fs.realpathSync(worktree)}\n${fs.realpathSync(phaseDir)}`).digest('hex');
  for (const root of roots) {
    const file = path.join(root, key, 'lease.json');
    let raw;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('LEGACY_WRITER_STATE', `private writer state is not a regular file at ${file}`);
      }
      raw = fs.readFileSync(file, 'utf8');
    }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      fail('LEGACY_WRITER_STATE', `cannot inspect private writer state at ${file}`);
    }
    let record;
    try { record = JSON.parse(raw); }
    catch { fail('LEGACY_WRITER_STATE', `private writer state is corrupt at ${file}`); }
    if (!object(record) || record.schema !== SCHEMA || record.status !== 'released'
        || !Number.isSafeInteger(record.epoch) || record.epoch < 0
        || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)
        || typeof record.owner !== 'string' || !record.owner
        || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      fail('LEGACY_WRITER_STATE', `private writer ownership requires original recovery at ${file}`);
    }
  }
}

function sealOutputPaths(role, phaseDir) {
  const phase = Number(path.basename(phaseDir).split('-')[0]);
  if (!Number.isSafeInteger(phase) || phase <= 0) fail('INVALID_INPUT', 'invalid canonical phase directory');
  if (role === 'gsd-plan-checker') return [];
  if (role === 'gsd-phase-researcher') return [`${phase}-RESEARCH.md`];
  if (role !== 'gsd-planner') fail('INVALID_INPUT', 'invalid typed GSD role');
  const plans = fs.readdirSync(phaseDir).filter((name) => new RegExp(`^0*${phase}-[0-9]+-PLAN\\.md$`).test(name)).sort();
  if (!plans.length) fail('MISSING_ARTIFACT', 'planner has no phase PLAN.md output');
  return [...(fs.existsSync(path.join(phaseDir, 'CONTEXT.md')) ? ['CONTEXT.md'] : []), ...plans].sort();
}

function captureSealManifest({ role, phaseDir, snapshot, declared, changed }) {
  const paths = sealOutputPaths(role, phaseDir);
  const sortedDeclared = [...declared].sort();
  const sortedChanged = [...changed].sort();
  if (new Set(sortedDeclared).size !== sortedDeclared.length || JSON.stringify(sortedDeclared) !== JSON.stringify(sortedChanged)) {
    fail('ARTIFACT_DECLARATION_INVALID', 'native declaration differs from independent phase delta');
  }
  const outputs = {};
  for (const rel of paths) {
    const full = path.join(phaseDir, rel);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch { fail('ARTIFACT_DECLARATION_INVALID', `sealed output is missing: ${rel}`); }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== path.join(fs.realpathSync(phaseDir), rel)) {
      fail('ARTIFACT_DECLARATION_INVALID', 'sealed output is not a contained regular file');
    }
    const sha256 = digestFile(full);
    const changedOutput = sortedChanged.includes(rel);
    if (!changedOutput && snapshot.digests[rel] !== sha256) {
      fail('ARTIFACT_DECLARATION_INVALID', 'unchanged sealed output has no matching baseline');
    }
    outputs[rel] = { sha256, origin: changedOutput ? 'child-change' : 'unchanged-baseline' };
  }
  if (sortedChanged.some((rel) => !Object.hasOwn(outputs, rel))) {
    fail('ARTIFACT_DECLARATION_INVALID', 'native change is outside the role seal outputs');
  }
  return outputs;
}

function assertSealManifest({ role, phaseDir, snapshot, declared, changed, outputs, lease }) {
  if (!object(outputs) || JSON.stringify(Object.keys(outputs).sort()) !== JSON.stringify(sealOutputPaths(role, phaseDir))) {
    fail('RECOVERY_EVIDENCE_INCOMPLETE', 'original full seal-output manifest is missing or incomplete');
  }
  const current = lease.changedSince(snapshot).changed;
  if (JSON.stringify(current) !== JSON.stringify([...changed].sort())
      || JSON.stringify([...declared].sort()) !== JSON.stringify([...changed].sort())) {
    fail('FOREIGN_EDIT', 'phase delta differs from original native change declaration');
  }
  let actual;
  try { actual = captureSealManifest({ role, phaseDir, snapshot, declared, changed }); }
  catch (error) {
    if (error.code === 'ARTIFACT_DECLARATION_INVALID' || error.code === 'MISSING_ARTIFACT') {
      fail('RECOVERY_ARTIFACT_ALTERED', 'current seal outputs differ from original completion');
    }
    throw error;
  }
  if (JSON.stringify(actual) !== JSON.stringify(outputs)) {
    fail('RECOVERY_ARTIFACT_ALTERED', 'sealed output bytes differ from original completion manifest');
  }
}

function createPlanningWriterLease(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'options must be an object');
  const worktree = safeString(options.worktree, 'worktree');
  if (!path.isAbsolute(worktree)) fail('INVALID_INPUT', 'worktree must be an absolute path');
  const worktreeReal = fs.realpathSync(worktree);
  const phaseDir = safeString(options.phaseDir, 'phaseDir');
  const phaseDirAbs = realpathClosest(path.isAbsolute(phaseDir) ? phaseDir : path.join(worktreeReal, phaseDir));
  const stateRootRaw = safeString(options.stateRoot, 'stateRoot');
  const stateRootResolved = realpathClosest(stateRootRaw);
  const relativeToWorktree = path.relative(worktreeReal, stateRootResolved);
  if (relativeToWorktree === '' || (!relativeToWorktree.startsWith('..') && !path.isAbsolute(relativeToWorktree))) {
    fail('INVALID_STATE_ROOT', 'stateRoot must be outside the worktree', { stateRoot: stateRootResolved, worktree: worktreeReal });
  }
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const clock = typeof options.now === 'function' ? options.now : null;

  const key = crypto.createHash('sha256').update(`${worktreeReal}\n${phaseDirAbs}`).digest('hex');
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
    schema: SCHEMA, version: 1, ttl_ms: ttlMs, key, file,
    acquire, heartbeat, assertFence, release, recover, snapshotTree, changedSince,
  });
}

module.exports = Object.freeze({ SCHEMA, DEFAULT_TTL_MS, createPlanningWriterLease,
  sharedPlanningWriterRoot, legacyPlanningWriterRoots, assertNoLegacyPlanningWriter,
  sealOutputPaths, captureSealManifest, assertSealManifest });
