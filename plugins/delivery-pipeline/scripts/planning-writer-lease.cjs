'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
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

const PHASE_DIRECTORY_NAME = /^((?:[A-Za-z][A-Za-z0-9_.-]*?-)?(\d+))-/;

function parsePhaseDirectoryName(name) {
  const match = PHASE_DIRECTORY_NAME.exec(typeof name === 'string' ? name : '');
  return match ? { token: match[1], number: Number(match[2]) } : null;
}

function phaseDirectory(worktree, phase, refuse) {
  const phasesRoot = path.join(worktree, '.planning', 'phases');
  const padded = String(Number(phase)).padStart(2, '0');
  const remedy = `expected .planning/phases/${padded}-<slug>/ (or <project_code>-${padded}-<slug>/) under ${phasesRoot}; `
    + `make sure phase ${Number(phase)} is in ROADMAP.md, then run the decompose GSD chain `
    + `(/gsd-plan-phase ${Number(phase)} --ingest ...) so GSD creates the phase directory and CONTEXT before the researcher launch`;
  let names;
  try {
    names = fs.readdirSync(phasesRoot);
  } catch (error) {
    refuse('PHASE_DIRECTORY_MISSING', `phase directory root is unavailable (${error.message}); ${remedy}`);
  }
  if (fs.realpathSync(phasesRoot) !== phasesRoot) {
    refuse('PHASE_DIRECTORY_MISSING', 'phase directory root is not canonical');
  }
  const matches = names.filter((name) => parsePhaseDirectoryName(name)?.number === Number(phase)
    && fs.lstatSync(path.join(phasesRoot, name)).isDirectory());
  if (matches.length !== 1) {
    refuse('PHASE_DIRECTORY_MISSING', `expected exactly one phase directory for phase ${phase}, found ${matches.length}; ${remedy}`);
  }
  const directory = path.join(phasesRoot, matches[0]);
  if (fs.realpathSync(directory) !== directory) {
    refuse('PHASE_DIRECTORY_MISSING', 'phase directory is not canonical');
  }
  return directory;
}

function phaseArtifactNames(phaseDir, kind) {
  const parsed = parsePhaseDirectoryName(path.basename(phaseDir));
  if (!parsed || !/^[A-Z]+$/.test(kind)) fail('INVALID_INPUT', 'invalid canonical phase directory');
  const stems = new Set([String(parsed.number), String(parsed.number).padStart(2, '0'), parsed.token]);
  return [...(kind === 'CONTEXT' ? [`${kind}.md`] : []), ...[...stems].map((stem) => `${stem}-${kind}.md`)];
}

// @contract: a phase artifact has one padded, unpadded, directory-token or bare name; more than one is refused.
function resolvePhaseArtifact(phaseDir, kind) {
  const accepted = phaseArtifactNames(phaseDir, kind);
  const present = accepted.filter((name) => {
    try { return !fs.lstatSync(path.join(phaseDir, name)).isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (present.length > 1) {
    fail('AMBIGUOUS_ARTIFACT', `phase ${kind} is ambiguous: ${present.join(', ')} all exist in ${phaseDir}; keep exactly one`,
      { kind, present });
  }
  return present.length ? present[0] : null;
}

function liveLaunchChild(launchDir, epoch, pidOf) {
  let names;
  try { names = fs.readdirSync(launchDir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names.filter((entry) => entry.endsWith('.launch.json')).sort()) {
    let launch;
    try { launch = JSON.parse(fs.readFileSync(path.join(launchDir, name), 'utf8')); }
    catch { continue; }
    if (!object(launch) || launch.lease_epoch !== epoch) continue;
    const pid = pidOf(launch);
    if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
  }
  return null;
}

function writeDurableFile(file, raw) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, raw, { mode: 0o600 });
    const handle = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
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

function sealOutputPaths(role, phaseDir) {
  const parsed = parsePhaseDirectoryName(path.basename(phaseDir));
  const phase = parsed ? parsed.number : NaN;
  if (!Number.isSafeInteger(phase) || phase <= 0) fail('INVALID_INPUT', 'invalid canonical phase directory');
  if (role === 'gsd-plan-checker') return [];
  if (role === 'gsd-phase-researcher') {
    const research = resolvePhaseArtifact(phaseDir, 'RESEARCH');
    if (!research) {
      fail('MISSING_ARTIFACT', `sealed output is missing: the researcher produced none of ${phaseArtifactNames(phaseDir, 'RESEARCH').join(', ')}`);
    }
    return [research];
  }
  if (role !== 'gsd-planner') fail('INVALID_INPUT', 'invalid typed GSD role');
  const plans = fs.readdirSync(phaseDir).filter((name) => new RegExp(`^0*${phase}-[0-9]+-PLAN\\.md$`).test(name)).sort();
  if (!plans.length) fail('MISSING_ARTIFACT', 'planner has no phase PLAN.md output');
  const context = resolvePhaseArtifact(phaseDir, 'CONTEXT');
  return [...(context ? [context] : []), ...plans].sort();
}

function captureSealManifest({ role, phaseDir, snapshot, changed }) {
  const paths = sealOutputPaths(role, phaseDir);
  const sortedChanged = [...changed].sort();
  // @invariant: the planner may not change an existing CONTEXT file (locked decisions); creating one is allowed.
  const context = role === 'gsd-planner' ? paths.find((rel) => /(^|-)CONTEXT\.md$/.test(rel)) : undefined;
  if (context && Object.hasOwn(snapshot.digests, context) && sortedChanged.includes(context)) {
    fail('FOREIGN_EDIT', `phase delta modifies the frozen planner ${context} input`);
  }
  const outputs = {};
  for (const rel of paths) {
    const full = path.join(phaseDir, rel);
    let stat;
    try { stat = fs.lstatSync(full); }
    catch { fail('MISSING_ARTIFACT', `sealed output is missing: ${rel}`); }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(full) !== path.join(fs.realpathSync(phaseDir), rel)) {
      fail('FOREIGN_EDIT', 'sealed output is not a contained regular file');
    }
    const sha256 = digestFile(full);
    const changedOutput = sortedChanged.includes(rel);
    if (!changedOutput && snapshot.digests[rel] !== sha256) {
      fail('FOREIGN_EDIT', 'unchanged sealed output has no matching baseline');
    }
    outputs[rel] = { sha256, origin: changedOutput ? 'child-change' : 'unchanged-baseline' };
  }
  const outside = sortedChanged.filter((rel) => !Object.hasOwn(outputs, rel));
  if (outside.length) {
    fail('FOREIGN_EDIT', role === 'gsd-plan-checker'
      ? `the plan checker is read-only but changed phase file(s): ${outside.join(', ')}; PLAN revisions go through a planner re-dispatch followed by a fresh checker`
      : `phase change is outside the role seal outputs: ${outside.join(', ')}`, { outside });
  }
  return outputs;
}

function assertSealManifest({ role, phaseDir, snapshot, changed, outputs, lease }) {
  let expected;
  try { expected = sealOutputPaths(role, phaseDir); }
  catch (error) {
    if (error.code === 'MISSING_ARTIFACT' || error.code === 'AMBIGUOUS_ARTIFACT') {
      fail('RECOVERY_ARTIFACT_ALTERED', 'current seal outputs differ from original completion');
    }
    throw error;
  }
  if (!object(outputs) || JSON.stringify(Object.keys(outputs).sort()) !== JSON.stringify(expected)) {
    fail('RECOVERY_EVIDENCE_INCOMPLETE', 'original full seal-output manifest is missing or incomplete');
  }
  const current = lease.changedSince(snapshot).changed;
  if (JSON.stringify(current) !== JSON.stringify([...changed].sort())) {
    fail('FOREIGN_EDIT', 'phase delta differs from the original completion');
  }
  let actual;
  try { actual = captureSealManifest({ role, phaseDir, snapshot, changed }); }
  catch (error) {
    if (error.code === 'FOREIGN_EDIT' || error.code === 'MISSING_ARTIFACT') {
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

  // @invariant: a dead holder is fenced only when the caller proves none of its launched children is still alive.
  function acquire(input = {}) {
    if (!object(input)) fail('INVALID_INPUT', 'acquire input must be an object');
    const owner = safeString(input.owner, 'owner');
    const baseRevision = safeString(input.base_revision, 'base_revision');
    const holderChild = typeof input.holder_child === 'function' ? input.holder_child : null;
    ensureDir();
    let result;
    withLock(lockDir, 'writer', () => {
      const now = nowValue(clock);
      const record = readRecord();
      let takeover = null;
      if (liveActiveOwner(record, now) && record.owner !== owner) {
        if (!holderChild || pidAlive(record.pid)) {
          fail('WRITER_LEASED', `the planning writer lease is held by ${record.owner} until ${new Date(record.expires_at).toISOString()}`,
            { owner: record.owner, expires_at: record.expires_at });
        }
        const childPid = holderChild(record);
        if (childPid) {
          fail('WRITER_LEASED', `the planning writer lease holder (pid ${record.pid}) is dead but its launched child pid ${childPid} is still alive; `
            + 'wait for that process to exit or stop it, then retry',
          { owner: record.owner, pid: record.pid, child_pid: childPid, expires_at: record.expires_at });
        }
        takeover = { recovered_reason: `holder pid ${record.pid} is dead`, recovered_from_epoch: record.epoch };
      }
      const epoch = record ? record.epoch + 1 : 0;
      const next = {
        schema: SCHEMA, version: 1, owner, pid: process.pid,
        token: crypto.randomBytes(TOKEN_BYTES).toString('hex'), epoch,
        base_revision: baseRevision, acquired_at: now, heartbeat_at: now,
        expires_at: now + ttlMs, status: 'active', ...(takeover || {}),
      };
      writeRecord(next);
      result = { token: next.token, epoch: next.epoch, expires_at: next.expires_at, ...(takeover ? { recovered: true } : {}) };
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

module.exports = Object.freeze({ SCHEMA, DEFAULT_TTL_MS, createPlanningWriterLease, pidAlive, phaseDirectory,
  parsePhaseDirectoryName, resolvePhaseArtifact, liveLaunchChild,
  writeDurableFile,
  sharedPlanningWriterRoot,
  sealOutputPaths, captureSealManifest, assertSealManifest });
