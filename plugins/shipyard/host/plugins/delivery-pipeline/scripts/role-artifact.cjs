#!/usr/bin/env node
'use strict';

// Executor results cross two trust boundaries: the runtime receipt is owned by
// dispatch-boundary, while the worktree files are agent-owned.  This module is
// deliberately small and dependency-free so the trusted host and the direct
// delivery consumer use exactly the same checks.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { acquire } = require('./lock.cjs');
const { execFileSync } = require('node:child_process');
const {
  boundaryError,
  isDurableRecorder,
} = require('./dispatch-boundary.cjs');
const {
  recordMeasurement,
  ESTIMATOR_VERSION,
} = require('./orchestration-overhead.cjs');
const prHygiene = require('./pr-hygiene.cjs');
const {
  MANIFEST_NAME, PR_BODY_NAME, EVIDENCE_NAME, REPAIR_EVIDENCE_NAME,
  DRIFT_EVIDENCE_NAME, ARCH_REVIEW_EVIDENCE_NAME, SENTINEL_EVIDENCE_NAME,
  ARTIFACT_ARCHIVE_DIR,
} = require('./conveyor-scratch.cjs');

const ROLE_ARTIFACT_SCHEMA = 'shipyard.role-artifact.v1';
const ENVELOPE_SCHEMA = 'shipyard.executor-result.v1';
const ENVELOPE_VERSION = 1;
const SUMMARY_MAX_CHARS = 500;
const ENVELOPE_MAX_BYTES = 8192;
const EVIDENCE_RANGE_MAX_CHARS = 4096;
const FINDINGS_NAME = 'findings.json';
const REPAIR_ENVELOPE_SCHEMA = 'shipyard.repair-result.v1';
const DRIFT_ENVELOPE_SCHEMA = 'shipyard.drift-result.v1';
const JUDGMENT_ENVELOPE_SCHEMA = 'shipyard.judgment-result.v1';
const REPAIR_ROLES = new Set(['ci-fix', 'review-fix']);
const JUDGMENT_ROLES = new Set(['arch-review', 'pr-sentinel', 'integrator']);
const JUDGMENT_EVIDENCE_NAMES = Object.freeze({
  'arch-review': ARCH_REVIEW_EVIDENCE_NAME,
  'pr-sentinel': SENTINEL_EVIDENCE_NAME,
  integrator: 'INTEGRATION.md',
});
const SENTINEL_PERFORMED_STATUSES = new Set(['complete', 'handed-back']);
const SENTINEL_REFUSED_STATUSES = new Set(['refused']);
const NORMALIZED_UNKNOWN_ARCH_FINDINGS = new WeakSet();

function fail(code, message, details = {}) {
  throw boundaryError(code, message, details);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_ARTIFACT', `${label} must be a non-empty, whitespace-free string`, { label });
  }
  return value;
}

// Paths may legitimately contain spaces. Identity fields use `nonEmpty` because
// whitespace there is ambiguous; filesystem paths only reject control bytes and
// empty values so a worktree such as `/tmp/my project` remains valid.
function pathText(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_ARTIFACT', `${label} must be a non-empty path`, { label });
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function capSummary(value) {
  const summary = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const chars = Array.from(summary);
  if (chars.length <= SUMMARY_MAX_CHARS) return summary;
  return chars.slice(0, SUMMARY_MAX_CHARS - 3).join('') + '...';
}

function ioFor(input) {
  const provided = object(input.io) ? input.io : {};
  return {
    fs: provided.fs || fs,
    execFileSync: provided.execFileSync || execFileSync,
  };
}

function safeRealpath(fsApi, value, label) {
  pathText(value, label);
  try {
    return (fsApi.realpathSync.native || fsApi.realpathSync)(value);
  } catch (error) {
    fail('ARTIFACT_PATH', `${label} could not be resolved: ${error.message}`, { path: value });
  }
}

function sameStat(before, after) {
  if (!before || !after) return false;
  const field = (stat, name) => stat[name] === undefined ? null : String(stat[name]);
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
    .every((name) => field(before, name) === field(after, name));
}

function readImmutableFile(fsApi, file, label, maximum, expectedBytes) {
  let before;
  try {
    before = fsApi.lstatSync(file);
  } catch (error) {
    fail('MISSING_ARTIFACT', `${label} is missing: ${error.message}`, { path: file });
  }
  if (before.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', `${label} may not be a symlink`, { path: file });
  if (!before.isFile()) fail('INVALID_ARTIFACT', `${label} must be a regular file`, { path: file });
  if (maximum !== undefined) {
    if (before.size > maximum) fail('INVALID_ARTIFACT', label + ' exceeds its authenticated complete-byte bound');
    if (expectedBytes !== undefined && before.size !== expectedBytes)
      fail('ARTIFACT_MUTATED', label + ' changed from its authenticated complete-byte count');
    if (fsApi.realpathSync(file) !== file) fail('ARTIFACT_PATH_ESCAPE', label + ' contains a symlink');
    const fd = fsApi.openSync(file, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW);
    try {
      if (!sameStat(before, fsApi.fstatSync(fd))) fail('ARTIFACT_MUTATED', label + ' changed before bounded reading');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const count = fsApi.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) fail('ARTIFACT_MUTATED', label + ' ended before its bounded complete bytes');
        offset += count;
      }
      if (fsApi.readSync(fd, Buffer.alloc(1), 0, 1, offset)
          || !sameStat(before, fsApi.fstatSync(fd)) || !sameStat(before, fsApi.lstatSync(file))
          || fsApi.realpathSync(file) !== file)
        fail('ARTIFACT_MUTATED', label + ' changed during bounded reading');
      return bytes;
    } finally { fsApi.closeSync(fd); }
  }
  let value;
  try {
    value = fsApi.readFileSync(file);
  } catch (error) {
    fail('MISSING_ARTIFACT', `${label} could not be read: ${error.message}`, { path: file });
  }
  let after;
  try {
    after = fsApi.lstatSync(file);
  } catch (error) {
    fail('ARTIFACT_MUTATED', `${label} disappeared while it was being verified`, { path: file, cause: error.message });
  }
  if (!sameStat(before, after)) {
    fail('ARTIFACT_MUTATED', `${label} changed while it was being verified`, { path: file });
  }
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
}

function contained(worktree, candidate, label) {
  const relative = path.relative(worktree, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('ARTIFACT_PATH_ESCAPE', `${label} is outside the worktree`, { path: candidate, worktree });
  }
  return relative;
}

function fixedPath(worktree, name, label) {
  const candidate = path.resolve(worktree, name);
  contained(worktree, candidate, label);
  return candidate;
}

function git(input, worktree, args, label) {
  const { execFileSync: run } = ioFor(input);
  try {
    const result = run('git', ['-C', worktree, ...args], { encoding: 'utf8' });
    const output = Buffer.isBuffer(result) ? result.toString('utf8') : String(result);
    if (!output.trim()) fail('GIT_IDENTITY', `${label} returned no value`);
    return output.trim();
  } catch (error) {
    if (error && error.name === 'DispatchBoundaryError') throw error;
    fail('GIT_IDENTITY', `${label} could not be determined: ${error.message}`, { args });
  }
}

function gitCommitIfPresent(input, worktree, ref) {
  const { execFileSync: run } = ioFor(input);
  try {
    const result = run('git', ['-C', worktree, 'rev-parse', '--verify', '-q', `${ref}^{commit}`], { encoding: 'utf8' });
    const output = Buffer.isBuffer(result) ? result.toString('utf8') : String(result);
    return output.trim() || null;
  } catch (_) {
    return null;
  }
}

// Delivery state stores the human-readable base branch. The live identity
// must use origin's edition whenever the worktree has it, because a bare local
// branch can lag after a parent squash-merges. Explicit remote/local refs and
// object ids retain their caller-selected meaning; legacy bare names gain the
// same origin preference as base-merge and scope-gate.
function liveBaseRef(input, worktree) {
  const requested = nonEmpty(input.base || input.baseRef, 'base revision');
  const candidates = [];
  if (requested.startsWith('refs/') || requested.startsWith('origin/')
      || /^[a-f0-9]{40}$/i.test(requested)) {
    candidates.push(requested);
  } else {
    candidates.push(`origin/${requested}`, requested);
  }
  for (const candidate of candidates) {
    if (gitCommitIfPresent(input, worktree, candidate)) return candidate;
  }
  return requested;
}

function gitIdentity(input, worktree) {
  const root = safeRealpath(ioFor(input).fs, git(input, worktree, ['rev-parse', '--show-toplevel'], 'repository root'), 'repository root');
  const commonValue = git(input, worktree, ['rev-parse', '--git-common-dir'], 'repository identity');
  const common = safeRealpath(
    ioFor(input).fs,
    path.isAbsolute(commonValue) ? commonValue : path.resolve(root, commonValue),
    'repository identity',
  );
  const head = git(input, worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], 'committed HEAD');
  const headTree = git(input, worktree, ['rev-parse', '--verify', 'HEAD^{tree}'], 'committed HEAD tree');
  const base = liveBaseRef(input, worktree);
  const baseCommit = git(input, worktree, ['rev-parse', '--verify', `${base}^{commit}`], 'base revision');
  const baseTree = git(input, worktree, ['rev-parse', '--verify', `${baseCommit}^{tree}`], 'base tree');
  const worktreeRealpath = safeRealpath(ioFor(input).fs, worktree, 'worktree');
  const identity = {
    repository: { root, identity: common },
    worktree: worktreeRealpath,
    head,
    head_tree: headTree,
    base,
    base_commit: baseCommit,
    base_tree: baseTree,
  };
  if (JUDGMENT_ROLES.has(input.role)) {
    const mergeBase = git(input, worktree, ['merge-base', base, 'HEAD'], 'reviewed merge base');
    const mergeBaseTree = git(input, worktree, ['rev-parse', '--verify', `${mergeBase}^{tree}`], 'reviewed merge-base tree');
    identity.merge_base = sha(mergeBase, 'reviewed merge base');
    identity.merge_base_tree = sha(mergeBaseTree, 'reviewed merge-base tree');
  }
  return identity;
}

function readonlyOriginalRecorder(store) {
  const root = path.resolve(store);
  const keyName = `.shipyard-dispatch-authority-${digest(root)}.key`;
  const canonical = require('./model-policy-internal.cjs').stableStringify;
  return Object.freeze({
    getVerifiedRecord(dispatchId) {
      if (!fs.existsSync(root)) return null;
      const directory = fs.lstatSync(root);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        fail('RECORD_FAILED', 'original durable dispatch store must be a physical directory');
      const physicalRoot = fs.realpathSync(root);
      const keyFile = path.join(fs.realpathSync(path.dirname(root)), keyName);
      const keyStat = fs.lstatSync(keyFile);
      if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) !== 0)
        fail('RECORD_FAILED', 'original durable dispatch authority key is invalid or too broadly accessible');
      const key = readImmutableFile(fs, keyFile, 'original durable dispatch authority key', 32, 32);
      const file = path.join(physicalRoot, `record-${digest(dispatchId)}.json`);
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(readImmutableFile(fs, file, 'original durable dispatch record', 16 * 1024 * 1024));
      const retainedKey = readImmutableFile(fs, keyFile, 'original durable dispatch authority key', 32, 32);
      if (!sameStat(keyStat, fs.lstatSync(keyFile)) || !key.equals(retainedKey)
          || !sameStat(directory, fs.lstatSync(root)) || fs.realpathSync(root) !== physicalRoot)
        fail('RECORD_FAILED', 'original durable dispatch authority changed during authentication');
      if (!object(raw) || raw.format !== 'adr-014.durable-boundary.v1'
          || !object(raw.payload) || !object(raw.integrity)
          || raw.integrity.algorithm !== 'hmac-sha256'
          || typeof raw.integrity.mac !== 'string' || !/^[a-f0-9]{64}$/.test(raw.integrity.mac)) return null;
      const expected = crypto.createHmac('sha256', key).update(canonical(raw.payload)).digest();
      return crypto.timingSafeEqual(expected, Buffer.from(raw.integrity.mac, 'hex')) ? raw.payload : null;
    },
  });
}

function recorderFor(input) {
  if (isDurableRecorder(input.recorder)) return input.recorder;
  if (typeof input.boundaryStore === 'string' && input.boundaryStore.trim()) {
    return readonlyOriginalRecorder(input.boundaryStore);
  }
  fail('RECORD_UNAVAILABLE', 'trusted artifact validation requires the durable dispatch recorder');
}

function dispatchIdFor(input) {
  return nonEmpty(input.dispatchId || input.dispatch_id, 'dispatch id');
}

function trustedRecord(input) {
  const recorder = recorderFor(input);
  const dispatchId = dispatchIdFor(input);
  let record;
  try {
    record = recorder.getVerifiedRecord(dispatchId);
  } catch (error) {
    fail('RECORD_FAILED', `durable dispatch record could not be authenticated: ${error.message}`, { dispatch_id: dispatchId });
  }
  if (!object(record) || !object(record.receipt)) {
    fail('MISSING_RECEIPT', 'dispatch has no authenticated finalized receipt', { dispatch_id: dispatchId });
  }
  if (record.dispatch_id !== dispatchId || record.receipt.dispatch_id !== dispatchId) {
    fail('NONCOMPLIANT_RECEIPT', 'authenticated receipt identity does not match the dispatch', { dispatch_id: dispatchId });
  }
  const proof = record.receipt.compliance_proof;
  const resolution = object(record.resolution) ? record.resolution : {};
  if (!object(proof)
      || proof.dispatch_id !== dispatchId
      || proof.launch_id !== record.receipt.launch_id
      || proof.policy_hash !== record.receipt.policy_hash
      || (resolution.dispatch_id !== undefined && resolution.dispatch_id !== dispatchId)
      || (resolution.role !== undefined && resolution.role !== record.receipt.role)
      || (resolution.policy_hash !== undefined && resolution.policy_hash !== record.receipt.policy_hash)) {
    fail('NONCOMPLIANT_RECEIPT', 'authenticated receipt proof and dispatch resolution are inconsistent', { dispatch_id: dispatchId });
  }
  if (record.receipt.compliance !== 'verified'
      || !object(record.receipt.compliance_proof)
      || record.receipt.compliance_proof.boundary !== 'adr-014.dispatch-boundary') {
    fail('NONCOMPLIANT_RECEIPT', 'dispatch receipt is not a finalized ADR-014 boundary receipt', { dispatch_id: dispatchId });
  }
  if (record.receipt.runtime_evidence?.review_continuation) {
    const progress = validateReviewContinuationEvidence(record.receipt.runtime_evidence);
    if (progress.identity.role !== record.receipt.role || progress.identity.policy_hash !== record.receipt.policy_hash)
      fail('NONCOMPLIANT_RECEIPT', 'continuation receipt changed its original role or policy');
  }
  nonEmpty(record.receipt.runtime, 'receipt runtime');
  nonEmpty(record.receipt.role, 'receipt role');
  nonEmpty(record.receipt.launch_id, 'receipt launch id');
  nonEmpty(record.receipt.policy_hash, 'receipt policy hash');
  return { recorder, dispatchId, record, receipt: record.receipt };
}

function assertAgentReceiptIsNotForged(result, trusted) {
  if (!object(result)) fail('INVALID_RESULT', 'executor result must be an object');
  for (const field of [
    'receipt', 'application_receipt', 'applicationReceipt',
    'applicationEvidence', 'application_evidence',
  ]) {
    if (result[field] === undefined) continue;
    if (!object(result[field]) || stable(result[field]) !== stable(trusted.receipt)) {
      fail('FORGED_RECEIPT', 'executor result supplied a receipt that differs from the authenticated boundary receipt', {
        dispatch_id: trusted.dispatchId,
        field,
      });
    }
  }
}

function trustedMetadata(input, trusted, identity) {
  const resolution = object(trusted.record.resolution) ? trusted.record.resolution : {};
  if (trusted.receipt.role && resolution.role && trusted.receipt.role !== resolution.role) {
    fail('NONCOMPLIANT_RECEIPT', 'authenticated receipt and resolution roles differ');
  }
  const trustedRole = trusted.receipt.role || resolution.role;
  const suppliedRole = input.role === undefined ? trustedRole : nonEmpty(input.role, 'role');
  if (suppliedRole !== trustedRole) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'artifact role does not match the authenticated dispatch', {
      expected_role: trustedRole,
      actual_role: suppliedRole,
    });
  }
  const trustedTicket = trusted.record.ticket || (object(trusted.record.trace) && trusted.record.trace.ticket);
  if (typeof trustedTicket !== 'string' || trustedTicket.trim() === '') {
    fail('NONCOMPLIANT_RECEIPT', 'authenticated dispatch record has no ticket identity');
  }
  if (input.ticket !== undefined && input.ticket !== trustedTicket) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'artifact ticket does not match the authenticated dispatch', {
      expected_ticket: trustedTicket,
      actual_ticket: input.ticket,
    });
  }
  const policyHash = trusted.receipt.policy_hash || resolution.policy_hash;
  if (typeof policyHash !== 'string' || policyHash.trim() === '') {
    fail('NONCOMPLIANT_RECEIPT', 'authenticated dispatch record has no policy hash');
  }
  return {
    role: suppliedRole,
    ticket: trustedTicket,
    policy_hash: policyHash,
    launch_id: trusted.receipt.launch_id,
    runtime: trusted.receipt.runtime,
    identity,
  };
}

function requireCommittedRevision(metadata) {
  if (metadata.role === 'executor' && metadata.identity.head === metadata.identity.base_commit) {
    fail('NO_COMMITTED_REVISION', 'executor artifact cannot be accepted when HEAD has no commit beyond the authenticated base', {
      head: metadata.identity.head,
      base: metadata.identity.base_commit,
    });
  }
}

function verifyResult(result, metadata) {
  assertAgentReceiptIsNotForged(result, metadata.trusted);
  const status = result.status;
  if (status !== 'committed' && status !== 'blocked') {
    fail('INVALID_RESULT', 'executor result status must be committed or blocked', { status });
  }
  if (result.id !== metadata.ticket) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'executor result id does not match the authenticated ticket', {
      expected_ticket: metadata.ticket,
      actual_id: result.id,
    });
  }
  const blockingCount = result.blocking_count === undefined
    ? status === 'blocked' ? 1 : 0
    : result.blocking_count;
  if (!Number.isInteger(blockingCount) || blockingCount < 0) {
    fail('INVALID_RESULT', 'blocking_count must be a non-negative integer');
  }
  let actionableDelta = null;
  let actionableOverflow = false;
  if (result.actionable_delta !== undefined) {
    try {
      const serialized = JSON.stringify(result.actionable_delta);
      if (bytes(serialized) > ENVELOPE_MAX_BYTES) {
        actionableOverflow = true;
      } else {
        actionableDelta = JSON.parse(serialized);
      }
    } catch (error) {
      fail('INVALID_RESULT', `actionable_delta must be JSON-serializable: ${error.message}`);
    }
  }
  return {
    outcome: status,
    summary: capSummary(result.summary),
    actionable_delta: actionableDelta,
    actionable_overflow: actionableOverflow,
    blocking_count: blockingCount,
  };
}

function fileReference(relativePath, content) {
  const sha256 = digest(content);
  return {
    path: relativePath,
    bytes: content.length,
    content_bytes: content.length,
    sha256,
    digest: sha256,
  };
}

function assertTicketMarker(content, ticket) {
  const firstLine = content.toString('utf8').split(/\r?\n/, 1)[0];
  if (firstLine !== `Ticket: ${ticket}`) {
    fail('PR_BODY_MARKER', 'PR body must begin with the authenticated ticket marker', {
      expected: `Ticket: ${ticket}`,
      actual: firstLine,
    });
  }
}

// @security: hygiene comes from the committed base (prHygiene.applies), never worktree files.
function assertPrBody(content, ticket, hygiene) {
  if (!hygiene) {
    assertTicketMarker(content, ticket);
    return;
  }
  const body = content.toString('utf8');
  if (body.trim() === '') {
    fail('PR_BODY_LEAK', 'PR body must be a non-empty neutral body in a target project', { ticket });
  }
  const violations = prHygiene.check({ body }).violations.filter((violation) => violation.field === 'body');
  if (violations.length) {
    fail('PR_BODY_LEAK', 'PR body must not contain internal identifiers in a target project', { violations });
  }
}

function envelopeFor(metadata, resultData, files) {
  const evidenceIndex = fileReference(files.evidence.relative, files.evidence.content);
  const base = {
    schema: ENVELOPE_SCHEMA,
    version: ENVELOPE_VERSION,
    role: metadata.role,
    ticket: metadata.ticket,
    subject: metadata.ticket,
    outcome: resultData.outcome,
    actionable_delta: resultData.actionable_delta,
    summary: resultData.summary,
    blocking_count: resultData.blocking_count,
    evidence_index: evidenceIndex,
    evidence_index_ref: evidenceIndex,
  };
  let envelope = base;
  if (resultData.actionable_overflow || bytes(JSON.stringify(envelope)) > ENVELOPE_MAX_BYTES) {
    envelope = {
      ...base,
      actionable_delta: {
        type: 'reference',
        path: evidenceIndex.path,
        sha256: evidenceIndex.sha256,
        note: 'complete findings remain in the validated evidence index',
      },
      overflow: { fields: ['actionable_delta'], reference: evidenceIndex },
    };
  }
  if (bytes(JSON.stringify(envelope)) > ENVELOPE_MAX_BYTES) {
    fail('ENVELOPE_TOO_LARGE', `executor result envelope exceeds ${ENVELOPE_MAX_BYTES} UTF-8 bytes`, {
      max_bytes: ENVELOPE_MAX_BYTES,
    });
  }
  return envelope;
}

function manifestFor(metadata, trusted, envelope, files) {
  return {
    schema: ROLE_ARTIFACT_SCHEMA,
    version: 1,
    producer_dispatch: trusted.dispatchId,
    producer_dispatch_id: trusted.dispatchId,
    dispatch_id: trusted.dispatchId,
    producer_launch: trusted.receipt.launch_id,
    runtime: metadata.runtime,
    role: metadata.role,
    ticket: metadata.ticket,
    repository: metadata.identity.repository,
    repository_realpath: metadata.identity.repository.root,
    repository_identity: metadata.identity.repository.identity,
    worktree: metadata.identity.worktree,
    worktree_realpath: metadata.identity.worktree,
    head: metadata.identity.head,
    head_tree: metadata.identity.head_tree,
    base: metadata.identity.base,
    base_commit: metadata.identity.base_commit,
    base_tree: metadata.identity.base_tree,
    policy_hash: metadata.policy_hash,
    files: {
      pr_body: fileReference(files.pr_body.relative, files.pr_body.content),
      evidence: fileReference(files.evidence.relative, files.evidence.content),
    },
    envelope,
  };
}

function writeManifest(fsApi, file, manifest) {
  const frame = archivePublicationFrames.at(-1);
  const serialized = `${JSON.stringify(manifest)}\n`;
  const desired = Buffer.from(serialized, 'utf8');
  try {
    if (fsApi.existsSync(file)) {
      const stat = fsApi.lstatSync(file);
      if (stat.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', 'artifact manifest may not be a symlink', { path: file });
      if (!stat.isFile()) fail('INVALID_ARTIFACT', 'artifact manifest must be a regular file', { path: file });
      const existing = readImmutableFile(fsApi, file, 'artifact manifest');
      if (!existing.equals(desired)) {
        fail('ARTIFACT_WRITE', 'artifact manifest already exists with different bytes', { path: file });
      }
      return existing;
    }
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    fsApi.writeFileSync(temp, desired, { flag: 'wx', mode: 0o600 });
    try {
      // A hard link publishes only when the destination is absent. `renameSync`
      // would silently replace an authenticated manifest during a duplicate seal.
      if (frame) assertArchiveLock(frame.worktree);
      fsApi.linkSync(temp, file);
      if (frame?.created) { const stat = fsApi.lstatSync(file); frame.created.push({ path: file, dev: stat.dev, ino: stat.ino }); }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const existing = readImmutableFile(fsApi, file, 'artifact manifest');
      if (!existing.equals(desired)) {
        fail('ARTIFACT_WRITE', 'artifact manifest was published concurrently with different bytes', { path: file });
      }
      return existing;
    } finally {
      try { fsApi.unlinkSync(temp); } catch (_) { /* renamed */ }
    }
    return desired;
  } catch (error) {
    if (error && error.name === 'DispatchBoundaryError') throw error;
    fail('ARTIFACT_WRITE', `artifact manifest could not be sealed: ${error.message}`, { path: file });
  }
}

function normalizeCall(value, options) {
  if (typeof value === 'string') return { ...(object(options) ? options : {}), artifactPath: value };
  if (!object(value)) fail('INVALID_ARTIFACT', 'role-artifact input must be an object');
  return { ...value, ...(object(options) ? options : {}) };
}

function sealExecutor(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const identity = gitIdentity(input, worktree);
  const hygiene = prHygiene.applies({ root: identity.repository.root, ref: identity.base_commit });
  const metadata = trustedMetadata(input, trusted, identity);
  metadata.trusted = trusted;
  const result = input.result;
  const resultData = verifyResult(result, metadata);
  if (resultData.outcome !== 'committed') {
    fail('BLOCKED_RESULT', 'blocked executor results cannot be sealed as publishable artifacts', { ticket: metadata.ticket });
  }
  requireCommittedRevision(metadata);
  const files = {
    pr_body: {
      relative: PR_BODY_NAME,
      content: readImmutableFile(fsApi, fixedPath(worktree, PR_BODY_NAME, 'PR body'), 'PR body'),
    },
    evidence: {
      relative: EVIDENCE_NAME,
      content: readImmutableFile(fsApi, fixedPath(worktree, EVIDENCE_NAME, 'evidence'), 'evidence'),
    },
  };
  assertPrBody(files.pr_body.content, metadata.ticket, hygiene);
  const envelope = envelopeFor(metadata, resultData, files);
  const manifest = manifestFor(metadata, trusted, envelope, files);
  const manifestPath = fixedPath(worktree, MANIFEST_NAME, 'artifact manifest');
  const manifestBytes = writeManifest(fsApi, manifestPath, manifest);
  const artifactDigest = digest(manifestBytes);
  return Object.freeze({
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_ref: manifestPath,
    artifact_path: manifestPath,
    artifactRef: manifestPath,
    artifact_digest: artifactDigest,
    artifactDigest,
    envelope,
    evidence_index: envelope.evidence_index,
    evidenceIndex: envelope.evidence_index,
    files: Object.freeze({
      pr_body: Object.freeze({ ...manifest.files.pr_body, path: fixedPath(worktree, PR_BODY_NAME, 'PR body') }),
      evidence: Object.freeze({ ...manifest.files.evidence, path: fixedPath(worktree, EVIDENCE_NAME, 'evidence') }),
    }),
  });
}

function expectedManifest(input, trusted, identity) {
  const metadata = trustedMetadata(input, trusted, identity);
  const manifest = input.manifest;
  if (!object(manifest)) fail('INVALID_ARTIFACT', 'artifact manifest must be an object');
  for (const [field, expected] of [
    ['schema', ROLE_ARTIFACT_SCHEMA],
    ['version', 1],
    ['producer_dispatch', trusted.dispatchId],
    ['producer_dispatch_id', trusted.dispatchId],
    ['dispatch_id', trusted.dispatchId],
    ['producer_launch', trusted.receipt.launch_id],
    ['runtime', trusted.receipt.runtime],
    ['role', metadata.role],
    ['ticket', metadata.ticket],
    ['repository_realpath', identity.repository.root],
    ['repository_identity', identity.repository.identity],
    ['worktree_realpath', identity.worktree],
    ['worktree', identity.worktree],
    ['head', identity.head],
    ['head_tree', identity.head_tree],
    ['base', identity.base],
    ['base_commit', identity.base_commit],
    ['base_tree', identity.base_tree],
    ['policy_hash', metadata.policy_hash],
  ]) {
    if (manifest[field] !== expected) {
      fail('STALE_ARTIFACT', `artifact ${field} does not match the live authenticated identity`, {
        field, expected, actual: manifest[field],
      });
    }
  }
  if (!object(manifest.repository)
      || manifest.repository.root !== identity.repository.root
      || manifest.repository.identity !== identity.repository.identity) {
    fail('STALE_ARTIFACT', 'artifact repository identity does not match the live repository');
  }
  if (!object(manifest.files)
      || !object(manifest.files.pr_body)
      || !object(manifest.files.evidence)) {
    fail('MISSING_ARTIFACT', 'artifact manifest is missing complete file references');
  }
  if (manifest.files.pr_body.path !== PR_BODY_NAME || manifest.files.evidence.path !== EVIDENCE_NAME) {
    fail('ARTIFACT_PATH_ESCAPE', 'artifact file references must use the fixed contained executor paths');
  }
  if (!object(manifest.envelope)) fail('MISSING_ARTIFACT', 'artifact manifest is missing its bounded envelope');
  const envelopeBytes = bytes(JSON.stringify(manifest.envelope));
  if (envelopeBytes > ENVELOPE_MAX_BYTES) {
    fail('ENVELOPE_TOO_LARGE', `artifact envelope exceeds ${ENVELOPE_MAX_BYTES} UTF-8 bytes`);
  }
  if (typeof manifest.envelope.summary !== 'string' || Array.from(manifest.envelope.summary).length > SUMMARY_MAX_CHARS) {
    fail('INVALID_ARTIFACT', 'artifact envelope summary exceeds the 500-character bound');
  }
  if (manifest.envelope.schema !== ENVELOPE_SCHEMA
      || manifest.envelope.version !== ENVELOPE_VERSION
      || manifest.envelope.role !== metadata.role
      || manifest.envelope.ticket !== metadata.ticket
      || manifest.envelope.subject !== metadata.ticket
      || manifest.envelope.outcome !== 'committed'
      || !Number.isInteger(manifest.envelope.blocking_count)
      || manifest.envelope.blocking_count < 0
      || !object(manifest.envelope.evidence_index)
      || !object(manifest.envelope.evidence_index_ref)) {
    fail('INVALID_ARTIFACT', 'artifact envelope does not describe a committed executor result');
  }
  if (manifest.envelope.evidence_index.path !== EVIDENCE_NAME) {
    fail('ARTIFACT_PATH_ESCAPE', 'evidence index must reference the fixed evidence file');
  }
  if (stable(manifest.envelope.evidence_index_ref) !== stable(manifest.envelope.evidence_index)) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'evidence index references disagree');
  }
  return metadata;
}

function verifyFileReference(fsApi, worktree, reference, name) {
  if (!object(reference) || reference.path !== name
      || !Number.isInteger(reference.bytes) || reference.bytes < 0
      || reference.content_bytes !== reference.bytes
      || typeof reference.sha256 !== 'string' || reference.sha256 !== reference.digest
      || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    fail('INVALID_ARTIFACT', `${name} file reference is malformed`);
  }
  const file = fixedPath(worktree, name, name);
  const content = readImmutableFile(fsApi, file, name);
  if (content.length !== reference.bytes || digest(content) !== reference.sha256) {
    fail('ARTIFACT_DIGEST_MISMATCH', `${name} content does not match its sealed digest`, { path: file });
  }
  return { path: file, relative: name, bytes: content.length, sha256: reference.sha256, content };
}

function validateExecutor(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const identity = gitIdentity(input, worktree);
  const hygiene = prHygiene.applies({ root: identity.repository.root, ref: identity.base_commit });
  const manifestPath = input.artifactPath || input.artifact_path || input.artifact_ref
    || fixedPath(worktree, MANIFEST_NAME, 'artifact manifest');
  const manifestResolved = path.resolve(worktree, manifestPath);
  contained(worktree, manifestResolved, 'artifact manifest');
  const manifestBytes = readImmutableFile(fsApi, manifestResolved, 'artifact manifest');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT', `artifact manifest is not valid JSON: ${error.message}`);
  }
  const metadata = expectedManifest({ ...input, manifest }, trusted, identity);
  requireCommittedRevision(metadata);
  if (input.artifactDigest !== undefined && input.artifact_digest !== undefined
      && input.artifactDigest !== input.artifact_digest) {
    fail('INVALID_ARTIFACT', 'conflicting artifact digest arguments');
  }
  const expectedDigest = input.artifactDigest || input.artifact_digest;
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    fail('INVALID_ARTIFACT', 'artifact digest is required to accept a validated manifest');
  }
  const actualDigest = digest(manifestBytes);
  if (expectedDigest !== actualDigest) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'artifact manifest digest does not match the validated bytes', {
      expected: expectedDigest,
      actual: actualDigest,
    });
  }
  const prBody = verifyFileReference(fsApi, worktree, manifest.files.pr_body, PR_BODY_NAME);
  const evidence = verifyFileReference(fsApi, worktree, manifest.files.evidence, EVIDENCE_NAME);
  assertPrBody(prBody.content, metadata.ticket, hygiene);
  if (manifest.envelope.evidence_index.sha256 !== evidence.sha256
      || manifest.envelope.evidence_index.bytes !== evidence.bytes) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'evidence index reference does not match the complete evidence bytes');
  }
  return Object.freeze({
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_ref: manifestResolved,
    artifact_path: manifestResolved,
    artifactRef: manifestResolved,
    artifact_digest: actualDigest,
    artifactDigest: actualDigest,
    envelope: manifest.envelope,
    manifest,
    evidence_index: manifest.envelope.evidence_index,
    evidenceIndex: manifest.envelope.evidence_index,
    files: Object.freeze({
      pr_body: Object.freeze({ ...prBody, content: prBody.content.toString('utf8') }),
      evidence: Object.freeze({ ...evidence, content: evidence.content.toString('utf8') }),
    }),
    pr_body: prBody.content.toString('utf8'),
    evidence: evidence.content.toString('utf8'),
    prBodyPath: prBody.path,
    evidencePath: evidence.path,
    role: metadata.role,
    ticket: metadata.ticket,
    head: identity.head,
    base: identity.base,
  });
}

function artifactReadRecorder(input) {
  return input.overheadRecorder || (object(input.overhead) ? input.overhead.recorder : null);
}

function artifactReadReference(file) {
  if (!object(file) || typeof file.sha256 !== 'string') return null;
  const relative = file.relative || file.path;
  if (typeof relative !== 'string' || !relative) return null;
  return {
    path: relative,
    sha256: file.sha256,
    ...(Number.isSafeInteger(file.bytes) ? { bytes: file.bytes } : {}),
  };
}

function recordArtifactRead(input, validated, files, selection = 'full') {
  const recorder = artifactReadRecorder(input);
  if (!recorder) return { recorded: false, skipped: 'no-recorder' };
  const refs = files.map(artifactReadReference).filter(Boolean);
  const bytesRead = files.reduce((total, file) => {
    if (typeof file.content !== 'string') return total;
    return total + Buffer.byteLength(file.content, 'utf8');
  }, 0);
  const range = input.evidenceRange || input.evidence_range;
  const rangeId = Array.isArray(range) ? `${range[0]}-${range[1]}` : 'full';
  const dispatchId = validated.manifest && (validated.manifest.dispatch_id || validated.manifest.producer_dispatch_id)
    || input.dispatchId || input.dispatch_id || null;
  const ticket = validated.ticket || input.ticket || 'unknown';
  const runId = input.run_id || input.runId || `artifact-read:${ticket}`;
  const policyHash = validated.manifest && validated.manifest.policy_hash
    || input.policy_hash || input.policyHash || null;
  return recordMeasurement(recorder, {
    observation_id: input.measurementId || input.measurement_id
      || `artifact-read:${dispatchId || ticket}:${selection}:${rangeId}:${validated.artifact_digest}`,
    run_id: runId,
    dispatch_id: dispatchId,
    role: validated.role || input.role || 'unknown',
    runtime: (validated.manifest && validated.manifest.runtime) || input.runtime || 'unknown',
    backend: input.backend || (validated.manifest && validated.manifest.backend) || 'unknown',
    ...((validated.manifest && validated.manifest.policy_id) || input.policy_id || input.policyId
      ? { policy_id: (validated.manifest && validated.manifest.policy_id) || input.policy_id || input.policyId } : {}),
    ...((validated.manifest && validated.manifest.policy_version) || input.policy_version || input.policyVersion
      ? { policy_version: (validated.manifest && validated.manifest.policy_version) || input.policy_version || input.policyVersion } : {}),
    policy_hash: policyHash,
    treatment: input.treatment === undefined ? input.treatments : input.treatment,
    stage: 'parent_reingestion',
    source: 'role-artifact',
    source_refs: refs,
    bytes: bytesRead,
    estimated_tokens: Math.ceil(bytesRead / 4),
    estimator_version: ESTIMATOR_VERSION,
    provider_tokens: null,
    evidence: 'none',
    counts: { polls: null, model_turns: null, tool_calls: null },
  });
}

function range(value) {
  if (!Array.isArray(value) || value.length !== 2
      || !Number.isInteger(value[0]) || !Number.isInteger(value[1])
      || value[0] < 0 || value[1] < value[0]
      || value[1] - value[0] > EVIDENCE_RANGE_MAX_CHARS) return null;
  return value;
}

function readExecutor(value, options) {
  const input = normalizeCall(value, options);
  const validated = validateExecutor(input);
  const hasRange = input.evidenceRange !== undefined || input.evidence_range !== undefined;
  const requested = range(input.evidenceRange || input.evidence_range);
  if (hasRange && !requested) {
    fail('INVALID_INPUT', `evidence range must contain two non-negative integer offsets no more than ${EVIDENCE_RANGE_MAX_CHARS} characters apart`);
  }
  if (!requested) {
    recordArtifactRead(input, validated, [validated.files.pr_body, validated.files.evidence]);
    return validated;
  }
  const referenceOnlyFiles = Object.freeze({
    pr_body: Object.freeze({
      path: validated.files.pr_body.path,
      bytes: validated.files.pr_body.bytes,
      sha256: validated.files.pr_body.sha256,
    }),
    evidence: Object.freeze({
      path: validated.files.evidence.path,
      bytes: validated.files.evidence.bytes,
      sha256: validated.files.evidence.sha256,
    }),
  });
  const targeted = Object.freeze({
    schema: validated.schema,
    artifact_ref: validated.artifact_ref,
    artifact_path: validated.artifact_path,
    artifact_digest: validated.artifact_digest,
    envelope: validated.envelope,
    manifest: validated.manifest,
    evidence_index: validated.evidence_index,
    evidenceIndex: validated.evidenceIndex,
    files: referenceOnlyFiles,
    prBodyPath: validated.prBodyPath,
    evidencePath: validated.evidencePath,
    role: validated.role,
    ticket: validated.ticket,
    head: validated.head,
    base: validated.base,
    evidence_range: Object.freeze({
      start: requested[0],
      end: requested[1],
      content: Array.from(validated.evidence).slice(requested[0], requested[1]).join(''),
    }),
  });
  recordArtifactRead(input, validated, [{
    ...validated.files.evidence,
    content: targeted.evidence_range.content,
  }], 'selected');
  return targeted;
}

// Repair and drift results use the same trusted manifest as executors, but their
// producer contract is different: a fixer or judge returns a decision while its
// complete notes/findings stay in a contained, dispatch-keyed archive. Keeping
// the archive separate from the executor's two fixed files also means a later
// repair cannot overwrite the evidence that an earlier attempt is meant to
// explain.
function roleText(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('INVALID_RESULT', `${label} must be a non-empty text value`);
  }
  return value;
}

function roleNumber(value, label) {
  if (!Number.isInteger(value) || value < 1) fail('INVALID_RESULT', `${label} must be a positive integer`);
  return value;
}

function artifactRole(input, trusted) {
  const role = input.role === undefined ? trusted.receipt.role : input.role;
  if (!REPAIR_ROLES.has(role) && role !== 'drift-check' && !JUDGMENT_ROLES.has(role)) return null;
  return role;
}

function producerEvidenceName(role) {
  if (REPAIR_ROLES.has(role)) return REPAIR_EVIDENCE_NAME;
  if (role === 'drift-check') return DRIFT_EVIDENCE_NAME;
  fail('INVALID_ARTIFACT', `no producer evidence path is registered for ${role}`);
}

// Clear the fixed role-owned scratch file before a new dispatch. Without this
// rotation, a producer that dies before writing could seal an earlier attempt's
// evidence under the new authenticated receipt.
const HISTORICAL_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;

function readPinnedArchiveFile(worktree, pin, label) {
  if (!object(pin) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0
      || pin.bytes > HISTORICAL_ARCHIVE_MAX_BYTES || !/^[a-f0-9]{64}$/.test(pin.sha256 || ''))
    fail('ARCHIVE_AUTHORITY_INVALID', 'historical archive pin exceeds its complete-byte bound');
  const absolute = fixedPath(worktree, pin.path, label), stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes || fs.realpathSync(absolute) !== absolute)
    fail('ARCHIVE_AUTHORITY_INVALID', label + ' size or physical path differs from authenticated pin');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const same = current => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(field => current[field] === stat[field]);
  try {
    if (!same(fs.fstatSync(fd))) fail('ARCHIVE_AUTHORITY_INVALID', label + ' changed before bounded reading');
    const content = Buffer.alloc(pin.bytes);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (!count) fail('ARCHIVE_AUTHORITY_INVALID', label + ' ended before its complete authenticated bytes');
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0
        || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(absolute))
        || fs.realpathSync(absolute) !== absolute || digest(content) !== pin.sha256)
      fail('ARCHIVE_AUTHORITY_INVALID', label + ' changed during bounded reading');
    return content;
  } finally { fs.closeSync(fd); }
}

function assertArchivePin(worktree, pin) {
  readPinnedArchiveFile(worktree, pin, 'authenticated archive');
  return true;
}

function archiveAuthorityNamespace(create = false) {
  const root = fs.realpathSync(require('node:os').homedir());
  const directory = path.join(root, '.local/state/shipyard/role-artifact-authority');
  let current = root;
  for (const part of ['.local', 'state', 'shipyard', 'role-artifact-authority']) {
    current = path.join(current, part);
    let ancestor;
    try { ancestor = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return directory;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      break;
    }
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || fs.realpathSync(current) !== current)
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority namespace contains symlinks or invalid ancestors');
  }
  const stat = fs.lstatSync(directory);
  if (fs.realpathSync(directory) !== directory || stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority namespace is not private or contains symlinks');
  return directory;
}

function archiveAuthorityDirectory(worktree, create = false) {
  return path.join(archiveAuthorityNamespace(create), digest(fs.realpathSync(worktree)));
}

function authorityFile(file, maximum = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || (stat.mode & 0o077))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority must be a private bounded regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== stat.size || !sameStat(before, stat))
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority changed before bounded reading');
    const content = Buffer.alloc(stat.size); let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (!count) fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority ended before complete bounded bytes');
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset))
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority grew beyond its bounded bytes');
    const after = fs.fstatSync(fd);
    const physical = fs.lstatSync(file);
    if ([before, after, physical].some(current => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
      .some(field => current[field] !== stat[field])) || content.length !== stat.size)
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority changed while reading');
    return content;
  } finally { fs.closeSync(fd); }
}

function authorityState(worktree, create = false, requireCatalogue = true, readCatalogue = true) {
  const directory = archiveAuthorityDirectory(worktree, create);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()
      || (fs.lstatSync(directory).mode & 0o077))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority directory is not private or contains symlinks');
  const keyFile = path.join(directory, 'hmac.key');
  if (create) {
    if (!fs.existsSync(keyFile) && fs.readdirSync(directory).some(name => name === 'catalogue.json' || name.startsWith('architecture-sources-') || name.startsWith('phase-archive-roster-') || name.startsWith('planning-containment-') || name.startsWith('review-')))
      fail('ARCHIVE_AUTHORITY_INVALID', 'existing protected records require their original authority key');
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = authorityFile(keyFile, 32);
  if (key.length !== 32) fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority key is malformed');
  const file = path.join(directory, 'catalogue.json');
  let payload = { schema: 'shipyard.role-archive-catalogue.v1', worktree, records: {} };
  if (readCatalogue && fs.existsSync(file)) {
    const envelope = JSON.parse(authorityFile(file));
    const mac = crypto.createHmac('sha256', key).update(stable(envelope.payload)).digest('hex');
    if (!object(envelope.payload) || !/^[a-f0-9]{64}$/.test(envelope.mac || '')
        || !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(envelope.mac, 'hex')))
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue authentication failed');
    payload = envelope.payload;
  } else if (!create && requireCatalogue && readCatalogue) fail('ARCHIVE_AUTHORITY_REQUIRED', 'archive catalogue is missing; explicit trusted legacy admission is required');
  if (payload.schema !== 'shipyard.role-archive-catalogue.v1' || payload.worktree !== worktree || !object(payload.records))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue identity is invalid');
  return { directory, file, key, payload };
}

const authenticatedReviewProgress = new WeakSet();
const REVIEW_PROGRESS_LIMIT = 4 * 1024 * 1024;

function isAuthenticatedReviewProgress(value) { return authenticatedReviewProgress.has(value); }

function reviewEnvelope(state, name) {
  if (!/^review-(?:progress|tip)-[a-f0-9]{64}\.json$/.test(name || ''))
    fail('REVIEW_PROGRESS_INVALID', 'invalid protected review reference');
  const envelope = JSON.parse(authorityFile(path.join(state.directory, name), REVIEW_PROGRESS_LIMIT));
  if (!object(envelope) || !object(envelope.payload) || !/^[a-f0-9]{64}$/.test(envelope.mac || ''))
    fail('REVIEW_PROGRESS_INVALID', 'malformed protected review envelope');
  const mac = crypto.createHmac('sha256', state.key).update(stable(envelope.payload)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(envelope.mac, 'hex')))
    fail('REVIEW_PROGRESS_INVALID', 'original review authority authentication failed');
  return envelope.payload;
}

function writeReviewEnvelope(state, name, payload, immutable = false) {
  const serialized = Buffer.from(stable({ payload,
    mac: crypto.createHmac('sha256', state.key).update(stable(payload)).digest('hex') }) + '\n');
  if (serialized.length > REVIEW_PROGRESS_LIMIT) fail('REVIEW_PROGRESS_INVALID', 'protected review exceeds its bound');
  const file = path.join(state.directory, name);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assertArchiveLock(state.payload.worktree);
    if (immutable) {
      try { fs.linkSync(temporary, file); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!authorityFile(file).equals(serialized)) fail('REVIEW_PROGRESS_INVALID', 'protected range is immutable');
      }
    } else fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(state.directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function reviewTipName(stream) { return 'review-tip-' + stream + '.json'; }

function readReviewProgress({ worktree, reference } = {}) {
  const root = fs.realpathSync(worktree);
  if (!object(reference) || Object.keys(reference).length !== 2
      || !Object.keys(reference).every(key => ['reference', 'sha256'].includes(key)) || !/^review-progress-[a-f0-9]{64}\.json$/.test(reference.reference || '')
      || !/^[a-f0-9]{64}$/.test(reference.sha256 || ''))
    fail('REVIEW_PROGRESS_REQUIRED', 'original protected progress reference is required');
  const state = authorityState(root, false, false, false);
  const relative = path.relative(root, state.directory);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    fail('REVIEW_PROGRESS_INVALID', 'protected review authority is inside the writer tree');
  const chain = [];
  let cursor = reference;
  for (let count = 0; cursor && count < 2064; count++) {
    const payload = reviewEnvelope(state, cursor.reference);
    if (payload.schema !== 'shipyard.review-progress.v1' || payload.identity?.worktree !== root
        || payload.original_authority !== digest(state.key) || digest(stable(payload)) !== cursor.sha256
        || cursor.reference !== 'review-progress-' + cursor.sha256 + '.json'
        || !Number.isSafeInteger(payload.completed_ranges) || payload.completed_ranges < 1
        || payload.completed_ranges > 2064 || payload.range?.ordinal !== payload.completed_ranges - 1
        || !Number.isSafeInteger(payload.range.bytes) || payload.range.bytes < 1 || payload.range.bytes > 256 * 1024
        || !Number.isSafeInteger(payload.range.native_bytes) || payload.range.native_bytes < 1
        || payload.range.native_bytes > 128 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(payload.range.sha256 || '') || !/^[a-f0-9]{64}$/.test(payload.range.native_sha256 || '')
        || payload.semantic_context !== 'exact-native-session'
        || !/^[a-f0-9]{64}$/.test(payload.stream || ''))
      fail('REVIEW_PROGRESS_INVALID', 'protected progress identity, range or authority changed');
    chain.push(payload);
    cursor = payload.predecessor;
  }
  if (cursor || !chain.length) fail('REVIEW_PROGRESS_INVALID', 'progress chain exceeds its bound');
  chain.reverse();
  const original = chain[0];
  if (original.completed_ranges !== 1 || original.predecessor !== null)
    fail('REVIEW_PROGRESS_INVALID', 'progress lacks its original range');
  for (const [index, payload] of chain.entries()) {
    if (payload.completed_ranges !== index + 1 || payload.stream !== original.stream
        || stable(payload.identity) !== stable(original.identity)
        || stable(payload.input) !== stable(original.input)
        || stable(payload.original_launch) !== stable(original.original_launch)
        || payload.session_id !== original.session_id || payload.parent_session_id !== original.parent_session_id
        || payload.turn_id !== original.turn_id || payload.native_file !== original.native_file
        || (index && (payload.range.native_bytes <= chain[index - 1].range.native_bytes
          || payload.predecessor.sha256 !== digest(stable(chain[index - 1])))))
      fail('REVIEW_PROGRESS_INVALID', 'progress predecessor, session or ordered range changed');
  }
  const tip = reviewEnvelope(state, reviewTipName(original.stream));
  if (tip.schema !== 'shipyard.review-progress-tip.v1' || tip.original_authority !== digest(state.key)
      || stable(tip.reference) !== stable(reference))
    fail('REVIEW_PROGRESS_INVALID', 'progress is not the current protected cursor');
  const originalTranscript = tip.original_exit?.transcript;
  if (originalTranscript) {
    if (!Number.isSafeInteger(originalTranscript.bytes) || originalTranscript.bytes < 1
        || originalTranscript.bytes > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(originalTranscript.sha256 || ''))
      fail('REVIEW_PROGRESS_INVALID', 'original interrupted CLI reference is malformed');
    const bytes = authorityFile(originalTranscript.path, 128 * 1024 * 1024);
    if (bytes.length !== originalTranscript.bytes || digest(bytes) !== originalTranscript.sha256)
      fail('REVIEW_PROGRESS_INVALID', 'original interrupted CLI history changed');
  }
  const payload = chain.at(-1);
  const result = require('./codex-runtime-host.cjs').freezeReviewProgress({ ...payload, chain, state: tip });
  authenticatedReviewProgress.add(result);
  return result;
}

function persistReviewProgress(observation) {
  const observed = require('./codex-runtime-host.cjs').reviewObservationData(observation);
  const root = observed.identity.worktree;
  return withArchiveAuthorityLock(root, () => {
    const state = authorityState(root, true, false, false);
    const relative = path.relative(root, state.directory);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
      fail('REVIEW_PROGRESS_INVALID', 'protected review authority is inside the writer tree');
    const keyFd = fs.openSync(path.join(state.directory, 'hmac.key'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(keyFd); } finally { fs.closeSync(keyFd); }
    const name = reviewTipName(observed.stream);
    let tip = fs.existsSync(path.join(state.directory, name)) ? reviewEnvelope(state, name) : null;
    if (tip?.resume) fail('REVIEW_PROGRESS_INVALID', 'original review was already claimed for continuation');
    let previous = tip ? readReviewProgress({ worktree: root, reference: tip.reference }) : null;
    if (previous && (stable(previous.identity) !== stable(observed.identity)
        || stable(previous.original_launch) !== stable(observed.launch) || stable(previous.input) !== stable(observed.input)
        || previous.session_id !== observed.session_id || previous.turn_id !== observed.turn_id
        || previous.native_file !== observed.native_file || previous.parent_session_id !== observed.parent_session_id))
      fail('REVIEW_PROGRESS_INVALID', 'observed prefix differs from its original launch or subject');
    require('./codex-runtime-host.cjs').reviewObservationData(observation);
    for (const range of observed.ranges) {
      if (range.ordinal < (previous?.completed_ranges || 0)) {
        const old = previous.chain[range.ordinal];
        if (stable(old.range) !== stable(range)) fail('REVIEW_PROGRESS_INVALID', 'observed range conflicts with durable credit');
        continue;
      }
      if (range.ordinal !== (previous?.completed_ranges || 0))
        fail('REVIEW_PROGRESS_INVALID', 'range is overlapping, missing or out of order');
      const payload = { schema: 'shipyard.review-progress.v1', original_authority: digest(state.key),
        stream: observed.stream, identity: observed.identity, input: observed.input,
        original_launch: observed.launch, session_id: observed.session_id, parent_session_id: observed.parent_session_id,
        turn_id: observed.turn_id, native_file: observed.native_file, semantic_context: 'exact-native-session',
        completed_ranges: range.ordinal + 1, range, predecessor: tip?.reference || null };
      const hash = digest(stable(payload));
      const reference = { reference: 'review-progress-' + hash + '.json', sha256: hash };
      writeReviewEnvelope(state, reference.reference, payload, true);
      tip = { schema: 'shipyard.review-progress-tip.v1', original_authority: digest(state.key), reference, resume: null, original_exit: tip?.original_exit || null };
      writeReviewEnvelope(state, name, tip);
      previous = { completed_ranges: payload.completed_ranges, chain: [...(previous?.chain || []), payload] };
    }
    return tip ? Object.freeze({ ...tip.reference }) : null;
  });
}

function finishOriginalReviewObservation(observation) {
  const ended = require('./codex-runtime-host.cjs').reviewObservationData(observation);
  return withArchiveAuthorityLock(ended.worktree, () => {
    const progress = readReviewProgress({ worktree: ended.worktree, reference: ended.reference });
    if (progress.state.resume || progress.original_launch.process_id !== ended.process_id)
      fail('REVIEW_PROGRESS_INVALID', 'original process exit differs from its protected launch');
    const state = authorityState(ended.worktree, false, false, false);
    require('./codex-runtime-host.cjs').reviewObservationData(observation);
    const tip = { ...progress.state, original_exit: ended.exit };
    writeReviewEnvelope(state, reviewTipName(progress.stream), tip);
  });
}

function claimReviewContinuation(observation) {
  const claim = require('./codex-runtime-host.cjs').reviewObservationData(observation);
  return withArchiveAuthorityLock(claim.worktree, () => {
    const progress = readReviewProgress({ worktree: claim.worktree, reference: claim.reference });
    if (progress.state.resume) fail('REVIEW_PROGRESS_INVALID', 'protected continuation was already dispatched');
    const state = authorityState(claim.worktree, false, false, false);
    require('./codex-runtime-host.cjs').reviewObservationData(observation);
    const tip = { ...progress.state, resume: { status: 'claimed', dispatch_id: claim.dispatch_id,
      native_bytes: claim.native_bytes, native_sha256: claim.native_sha256 } };
    writeReviewEnvelope(state, reviewTipName(progress.stream), tip);
    return readReviewProgress({ worktree: claim.worktree, reference: claim.reference });
  });
}

function completeReviewContinuation(observation) {
  const completed = require('./codex-runtime-host.cjs').reviewObservationData(observation);
  return withArchiveAuthorityLock(completed.worktree, () => {
    const progress = readReviewProgress({ worktree: completed.worktree, reference: completed.reference });
    const resume = progress.state.resume;
    if (resume?.status !== 'claimed' || resume.dispatch_id !== completed.evidence.dispatch_id)
      fail('REVIEW_PROGRESS_INVALID', 'fresh completed turn lacks its claimed dispatch');
    const state = authorityState(completed.worktree, false, false, false);
    require('./codex-runtime-host.cjs').reviewObservationData(observation);
    const tip = { ...progress.state, resume: { ...resume, status: 'completed',
      evidence_sha256: digest(stable(completed.evidence)), turn_id: completed.turn_id } };
    writeReviewEnvelope(state, reviewTipName(progress.stream), tip);
  });
}

function validateReviewContinuationEvidence(evidence) {
  const continuation = evidence?.review_continuation;
  if (!object(continuation) || continuation.schema !== 'shipyard.review-continuation.v1')
    fail('REVIEW_PROGRESS_INVALID', 'unsupported review continuation evidence');
  const progress = readReviewProgress({ worktree: evidence.worktree, reference: continuation.progress });
  if (progress.state.resume?.status !== 'completed'
      || progress.state.resume.dispatch_id !== evidence.dispatch_id
      || progress.state.resume.evidence_sha256 !== digest(stable(evidence))
      || continuation.original_dispatch_id !== progress.identity.dispatch_id
      || evidence.session_id !== progress.session_id || continuation.semantic_context !== progress.semantic_context)
    fail('REVIEW_PROGRESS_INVALID', 'fresh final differs from protected completed continuation');
  return progress;
}

function planningContainmentIdentity(worktree, binding) {
  const root = fs.realpathSync(worktree);
  if (!object(binding) || !object(binding.launch) || !object(binding.launch.scope)
      || (typeof binding.launch.scope.worktree !== 'string' || fs.realpathSync(binding.launch.scope.worktree) !== root)
      || typeof binding.launch.dispatch_id !== 'string' || !binding.launch.dispatch_id.trim()
      || typeof binding.launch.gsd_role !== 'string' || !binding.launch.gsd_role.trim()
      || typeof binding.launch.scope.run_id !== 'string' || !binding.launch.scope.run_id.trim()
      || typeof binding.launch.scope.ticket !== 'string' || !binding.launch.scope.ticket.trim()
      || !Number.isSafeInteger(binding.launch.scope.phase) || binding.launch.scope.phase < 1
      || !/^[a-f0-9]{40,64}$/.test(binding.source_revision || '')
      || !/^[a-f0-9]{64}$/.test(binding.launch.request_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(binding.launch.policy_hash || '')
      || !object(binding.launch.agent) || !/^[a-f0-9]{64}$/.test(binding.launch.agent.sha256 || '')
      || typeof binding.writer_lease_file !== 'string' || !path.isAbsolute(binding.writer_lease_file)
      || !Number.isSafeInteger(binding.lease_epoch) || binding.lease_epoch < 0
      || !/^[a-f0-9]{64}$/.test(binding.lease_identity_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(binding.tree_snapshot_sha256 || ''))
    fail('CONTAINMENT_AUTHORITY_INVALID', 'complete original launch, scope, source, policy and lease binding is required');
  const launch = binding.launch;
  if (launch.scope.runtime !== 'codex' || launch.scope.provider !== 'openai'
      || !['gsd-planner', 'gsd-plan-checker', 'gsd-phase-researcher'].includes(launch.gsd_role)
      || launch.role !== (launch.gsd_role === 'gsd-phase-researcher' ? 'research' : 'decomposition')
      || [launch.model, launch.effort, launch.policy_version, launch.rung, launch.agent.file]
        .some(value => typeof value !== 'string' || !value.trim() || value.length > 8192)
      || !/^[a-f0-9]{64}$/.test(launch.agent.instructions_sha256 || '')
      || (launch.generated_agent !== undefined && (!object(launch.generated_agent)
        || typeof launch.generated_agent.file !== 'string' || !launch.generated_agent.file.trim()
        || !/^[a-f0-9]{64}$/.test(launch.generated_agent.sha256 || '')))
      || typeof binding.launched_at !== 'string' || !Number.isFinite(Date.parse(binding.launched_at))
      || !object(binding.reservation) || binding.reservation.dispatch_id !== launch.dispatch_id
      || typeof binding.reservation.reserved_at !== 'string' || !binding.reservation.reserved_at.trim()
      || Buffer.byteLength(stable(binding)) > 1024 * 1024)
    fail('CONTAINMENT_AUTHORITY_INVALID', 'original selection, launch and reservation binding is incomplete');
  const common = git({}, root, ['rev-parse', '--git-common-dir'], 'containment common directory');
  return { worktree: root,
    repository: fs.realpathSync(git({}, root, ['rev-parse', '--show-toplevel'], 'containment repository')),
    common_directory: fs.realpathSync(path.resolve(root, common)), binding };
}

function validatePlanningContainmentSnapshot(snapshot, identity) {
  if (!object(snapshot) || snapshot.schema !== 'shipyard.planning-containment-snapshot.v1'
      || snapshot.root !== identity.worktree || snapshot.head !== identity.binding.source_revision
      || !/^[a-f0-9]{40,64}$/.test(snapshot.head || '') || !/^[a-f0-9]{64}$/.test(snapshot.index || '')
      || Buffer.byteLength(stable(snapshot)) > 4 * 1024 * 1024)
    fail('CONTAINMENT_AUTHORITY_INVALID', 'complete original containment snapshot is required');
  for (const kind of ['sources', 'status']) {
    const entries = snapshot[kind];
    if (!Array.isArray(entries) || entries.length > 100000)
      fail('CONTAINMENT_AUTHORITY_INVALID', 'containment map exceeds its bound');
    let previous = null;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
          || !entry[0] || entry[0].length > 8192 || /[\\\0]/.test(entry[0])
          || path.isAbsolute(entry[0]) || entry[0].replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')
          || (previous !== null && previous >= entry[0]))
        fail('CONTAINMENT_AUTHORITY_INVALID', 'containment paths must be unique sorted bounded relative entries');
      const value = entry[1];
      if (kind === 'status' ? typeof value !== 'string' || !/^[ MADRC?!T]{2}$/.test(value)
        : value !== null && (typeof value !== 'string' || value.length > 16384
          || !/^\d+:(?:[a-f0-9]{64}|directory-sha256:[a-f0-9]{64}|symlink:[\s\S]*)$/.test(value)))
        fail('CONTAINMENT_AUTHORITY_INVALID', 'containment source identity or status is malformed');
      previous = entry[0];
    }
  }
  const sources = new Set(snapshot.sources.map(entry => entry[0]));
  if (snapshot.status.some(entry => !sources.has(entry[0])))
    fail('CONTAINMENT_AUTHORITY_INVALID', 'containment status lacks its original source entry');
  return snapshot;
}

function registerPlanningContainmentBaseline({ worktree, binding, snapshot } = {}) {
  const identity = planningContainmentIdentity(worktree, binding);
  validatePlanningContainmentSnapshot(snapshot, identity);
  const reference = 'planning-containment-' + digest(stable(identity)) + '.json';
  const payload = { schema: 'shipyard.planning-containment.v1', identity, snapshot };
  const state = authorityState(identity.worktree, true, false, false);
  const keyFd = fs.openSync(path.join(state.directory, 'hmac.key'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(keyFd); } finally { fs.closeSync(keyFd); }
  const serialized = Buffer.from(stable({ payload,
    mac: crypto.createHmac('sha256', state.key).update(stable(payload)).digest('hex') }) + '\n');
  if (serialized.length > 4 * 1024 * 1024)
    fail('CONTAINMENT_AUTHORITY_INVALID', 'protected containment envelope exceeds its byte bound');
  const file = path.join(state.directory, reference);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!authorityFile(file).equals(serialized))
        fail('CONTAINMENT_AUTHORITY_INVALID', 'original containment baseline is immutable');
    }
    const directoryFd = fs.openSync(state.directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return Object.freeze({ reference, sha256: digest(stable(payload)) });
}

function readPlanningContainmentBaseline({ worktree, binding, reference } = {}) {
  if (!object(reference) || !/^planning-containment-[a-f0-9]{64}\.json$/.test(reference.reference || '')
      || !/^[a-f0-9]{64}$/.test(reference.sha256 || ''))
    fail('CONTAINMENT_AUTHORITY_REQUIRED', 'authenticated original prelaunch containment reference is required');
  const identity = planningContainmentIdentity(worktree, binding);
  if (reference.reference !== 'planning-containment-' + digest(stable(identity)) + '.json')
    fail('CONTAINMENT_AUTHORITY_INVALID', 'containment reference does not identify the original launch binding');
  const state = authorityState(identity.worktree, false, false, false);
  const file = path.join(state.directory, reference.reference);
  if (!fs.existsSync(file)) fail('CONTAINMENT_AUTHORITY_REQUIRED', 'original protected containment baseline is missing');
  const bytes = authorityFile(file);
  let envelope;
  try { envelope = JSON.parse(bytes); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail('CONTAINMENT_AUTHORITY_INVALID', 'original containment envelope is malformed JSON');
  }
  if (!object(envelope) || !object(envelope.payload)
      || typeof envelope.mac !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.mac)
      || envelope.payload.schema !== 'shipyard.planning-containment.v1'
      || !object(envelope.payload.identity) || !object(envelope.payload.snapshot))
    fail('CONTAINMENT_AUTHORITY_INVALID', 'original containment envelope is malformed');
  const mac = crypto.createHmac('sha256', state.key).update(stable(envelope.payload)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(envelope.mac, 'hex'))
      || stable(envelope.payload.identity) !== stable(identity)
      || digest(stable(envelope.payload)) !== reference.sha256)
    fail('CONTAINMENT_AUTHORITY_INVALID', 'original containment envelope authentication failed');
  return validatePlanningContainmentSnapshot(envelope.payload.snapshot, identity);
}

function architectureSourceIdentity(project) {
  const root = fs.realpathSync(project);
  if (path.resolve(project) !== root) fail('SOURCE_AUTHORITY_INVALID', 'canonical source root contains a symlink');
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (top !== root) fail('SOURCE_AUTHORITY_INVALID', 'canonical source must be its repository root');
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
  return { root, common_dir: fs.realpathSync(path.resolve(root, common)), head };
}

function architectureSourcePins(pins) {
  if (!Array.isArray(pins) || !pins.length || pins.length > 1000)
    fail('SOURCE_AUTHORITY_INVALID', 'complete source inventory is required');
  const seen = new Set();
  let bytes = 0;
  for (const pin of pins) {
    if (!object(pin) || typeof pin.path !== 'string'
        || !/^(?:\.planning\/architecture\/.+\.md|\.planning\/investigations\/.+\/DECISIONS\.md)$/.test(pin.path)
        || path.posix.normalize(pin.path) !== pin.path || pin.path.includes('\\')
        || seen.has(pin.path) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0
        || pin.bytes > HISTORICAL_ARCHIVE_MAX_BYTES || !/^[a-f0-9]{64}$/.test(pin.sha256 || ''))
      fail('SOURCE_AUTHORITY_INVALID', 'invalid complete source pin');
    seen.add(pin.path); bytes += pin.bytes;
  }
  if (bytes > HISTORICAL_ARCHIVE_MAX_BYTES) fail('SOURCE_AUTHORITY_INVALID', 'complete source corpus exceeds its byte bound');
  return pins.map(pin => ({ path: pin.path, bytes: pin.bytes, sha256: pin.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
}

function architectureAuthorityPath(project, source, pins) {
  return path.join(archiveAuthorityDirectory(project), 'architecture-sources-' + digest(stable({ source, pins: architectureSourcePins(pins) })) + '.json');
}

function registerArchitectureAuthority(input) {
  if (!object(input) || !/^[a-f0-9]{64}$/.test(input.expectedApprovalDigest || ''))
    fail('SOURCE_AUTHORITY_REQUIRED', 'independently retained approval digest is required');
  const source = architectureSourceIdentity(input.projectPath);
  const approvedBytes = authorityFile(path.resolve(input.approvalTablePath));
  if (digest(approvedBytes) !== input.expectedApprovalDigest)
    fail('SOURCE_AUTHORITY_INVALID', 'original approval table differs from independently retained digest');
  const approved = JSON.parse(approvedBytes);
  if (approved.schema !== 'shipyard.architecture-source-approval.v1' || typeof approved.approval_id !== 'string' || !approved.approval_id.trim()
      || stable(approved.source) !== stable(source))
    fail('SOURCE_AUTHORITY_INVALID', 'approved source root, common directory or head differs');
  const pins = architectureSourcePins(approved.pins);
  if (!Array.isArray(approved.exceptional_paths) || new Set(approved.exceptional_paths).size !== approved.exceptional_paths.length
      || approved.exceptional_paths.some(relative => !pins.some(pin => pin.path === relative)))
    fail('SOURCE_AUTHORITY_INVALID', 'explicit independently approved exceptional source membership is required');
  const exceptional = [...approved.exceptional_paths].sort();
  assertCommittedArchitectureSources(source, pins, exceptional);
  for (const pin of pins) readPinnedArchiveFile(source.root, pin, 'approved source');
  assertArchitectureSourceStable(source, pins);
  const state = authorityState(source.root, true);
  const payload = { schema: approved.schema, approval_id: approved.approval_id, source, pins, exceptional_paths: exceptional, approval_digest: input.expectedApprovalDigest };
  const file = architectureAuthorityPath(source.root, source, pins);
  const serialized = JSON.stringify({ payload, mac: crypto.createHmac('sha256', state.key).update(stable(payload)).digest('hex') }) + '\n';
  if (Buffer.byteLength(serialized) > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('SOURCE_AUTHORITY_INVALID', 'complete serialized source approval exceeds its authority byte bound');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!authorityFile(file).equals(Buffer.from(serialized)))
        fail('SOURCE_AUTHORITY_INVALID', 'same source inventory cannot replace its original independently approved payload');
    }
  }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  assertArchitectureSourceStable(source, pins);
  return { approvalDigest: input.expectedApprovalDigest, source, pins, recordPath: file };
}

function assertArchitectureSourceStable(source, pins) {
  if (stable(architectureSourceIdentity(source.root)) !== stable(source))
    fail('SOURCE_AUTHORITY_INVALID', 'canonical source identity changed during assembly');
  const names = []; let count = 0;
  function visit(relative) {
    if (++count > 2000) fail('SOURCE_AUTHORITY_INVALID', 'canonical source inventory exceeds its bound');
    const absolute = path.join(source.root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
      fail('SOURCE_AUTHORITY_INVALID', 'canonical source inventory contains a symlink');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) {
        if (names.length > 1000) fail('SOURCE_AUTHORITY_INVALID', 'canonical source inventory exceeds its bound');
        visit(relative + '/' + name);
      }
    } else if (stat.isFile() && relative.endsWith('.md')) names.push(relative);
  }
  visit('.planning/architecture');
  const expected = pins.filter(pin => pin.path.startsWith('.planning/architecture/')).map(pin => pin.path).sort();
  if (stable(names.sort()) !== stable(expected))
    fail('SOURCE_AUTHORITY_INVALID', 'complete canonical architecture membership changed');
}

function authenticateArchitectureSources(worktree, project, refs) {
  const source = architectureSourceIdentity(project), pins = architectureSourcePins(refs);
  const file = architectureAuthorityPath(source.root, source, pins);
  if (fs.existsSync(file)) {
    const state = authorityState(source.root, false, false), envelope = JSON.parse(authorityFile(file));
    const mac = crypto.createHmac('sha256', state.key).update(stable(envelope.payload)).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(envelope.mac || '')
        || !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(envelope.mac, 'hex'))
        || envelope.payload.schema !== 'shipyard.architecture-source-approval.v1'
        || typeof envelope.payload.approval_id !== 'string' || !envelope.payload.approval_id.trim()
        || stable(envelope.payload.source) !== stable(source)
        || stable(envelope.payload.pins) !== stable(pins))
      fail('SOURCE_AUTHORITY_INVALID', 'protected source approval identity or complete corpus differs');
    if (!Array.isArray(envelope.payload.exceptional_paths)
        || envelope.payload.exceptional_paths.some(relative => !pins.some(pin => pin.path === relative)))
      fail('SOURCE_AUTHORITY_INVALID', 'protected exceptional source membership is invalid');
    assertCommittedArchitectureSources(source, pins, envelope.payload.exceptional_paths);
    for (const pin of pins) readPinnedArchiveFile(source.root, pin, 'authenticated source');
    assertArchitectureSourceStable(source, pins);
    return { source, pins, exceptional_paths: envelope.payload.exceptional_paths, approval_id: envelope.payload.approval_id, approval_digest: envelope.payload.approval_digest };
  }
  assertCommittedArchitectureSources(source, pins, []);
  assertArchitectureSourceStable(source, pins);
  return { source, pins, exceptional_paths: [], approval_id: null, approval_digest: null };
}

function assertCommittedArchitectureSources(source, pins, exceptional) {
  for (const pin of pins) {
    if (exceptional.includes(pin.path)) continue;
    let committed;
    try { committed = execFileSync('git', ['-C', source.root, 'show', source.head + ':' + pin.path],
      { maxBuffer: HISTORICAL_ARCHIVE_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { fail('SOURCE_AUTHORITY_REQUIRED', 'uncommitted architecture source requires independent protected approval: ' + pin.path); }
    if (committed.length !== pin.bytes || digest(committed) !== pin.sha256)
      fail('SOURCE_AUTHORITY_REQUIRED', 'dirty architecture source requires independent protected approval: ' + pin.path);
    readPinnedArchiveFile(source.root, pin, 'committed source');
  }
}

function archiveInventory(worktree) {
  const root = path.join(worktree, ARTIFACT_ARCHIVE_DIR), paths = [];
  if (!fs.existsSync(root)) return paths;
  function visit(absolute) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive inventory contains a symlink');
    if (stat.isDirectory()) {
      const children = fs.readdirSync(absolute).sort();
      if (absolute !== root && (path.dirname(absolute) !== root || !children.length))
        fail('ARCHIVE_AUTHORITY_INVALID', 'archive inventory contains unknown directory membership');
      for (const name of children) visit(path.join(absolute, name));
    } else if (stat.isFile()) paths.push(path.relative(worktree, absolute));
    else fail('ARCHIVE_AUTHORITY_INVALID', 'archive inventory contains a nonregular entry');
    if (paths.length > 3000) fail('ARCHIVE_AUTHORITY_INVALID', 'archive inventory exceeds its bound');
  }
  visit(root);
  return paths.sort();
}

function authenticatedArchivePins(worktreePath) {
  const worktree = fs.realpathSync(worktreePath), inventory = archiveInventory(worktree);
  if (!inventory.length && !fs.existsSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json'))) return [];
  let state;
  try { state = authorityState(worktree); }
  catch (error) { fail('ARCHIVE_AUTHORITY_REQUIRED', 'historical archives lack valid host authority: ' + error.message); }
  const pins = [];
  for (const [dispatchId, record] of Object.entries(state.payload.records)) {
    if (!object(record) || record.dispatch_id !== dispatchId || record.receipt?.dispatch_id !== dispatchId
        || !['codex', 'claude'].includes(record.receipt.runtime) || record.receipt.compliance !== 'verified'
        || record.receipt.compliance_proof?.boundary !== 'adr-014.dispatch-boundary'
        || !Array.isArray(record.pins) || record.pins.length !== 3)
      fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue has a malformed verified record');
    for (const pin of record.pins) {
      if (!object(pin) || !/^[a-f0-9]{64}$/.test(pin.sha256 || '')
          || typeof pin.path !== 'string' || !pin.path.startsWith(archiveRelative(dispatchId, ''))
          || pins.some(earlier => earlier.path === pin.path))
        fail('ARCHIVE_AUTHORITY_INVALID', 'archive catalogue has an invalid complete file pin');
      const content = readPinnedArchiveFile(worktree, pin, 'historical archive');
      if (digest(content) !== pin.sha256 || content.length !== pin.bytes)
        fail('ARCHIVE_AUTHORITY_INVALID', 'authenticated historical archive changed');
      pins.push(pin);
    }
  }
  if (stable(inventory) !== stable(pins.map(pin => pin.path).sort()))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive membership differs from authenticated complete inventory');
  if (stable(archiveInventory(worktree)) !== stable(inventory))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive membership changed while authenticating');
  return pins.sort((a, b) => a.path.localeCompare(b.path));
}

function phaseArchiveScope(worktreePath, binding, graphDir) {
  const root = fs.realpathSync(worktreePath);
  const directory = path.resolve(graphDir || path.join(root, '.planning/graph'));
  if (path.basename(directory) !== 'graph' || path.basename(path.dirname(directory)) !== '.planning'
      || fs.realpathSync(directory) !== directory)
    fail('ARCHIVE_AUTHORITY_INVALID', 'canonical phase graph directory is required');
  const project = fs.realpathSync(path.resolve(directory, '../..'));
  const repository = value => fs.realpathSync(execFileSync('git', ['-C', value, 'rev-parse',
    '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const common = repository(root);
  if (repository(project) !== common) fail('ARCHIVE_AUTHORITY_INVALID', 'phase graph belongs to another repository');
  const graph = JSON.parse(readImmutableFile(fs, path.join(directory, 'tickets.json'), 'phase graph'));
  const rows = require('./architecture-target.cjs').phaseRows(graph, Number(binding.phase.split('-')[0]), binding.repo ?? null);
  if (!rows.length || stable(rows.map(([id, row]) => ({ id, row }))) !== stable(binding.rows))
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected phase graph membership differs');
  const subject = require('./architecture-target.cjs').PHASE_SUBJECT.exec(binding.subject);
  if (!subject || subject[1] !== binding.phase || subject[2] !== common || subject[3] !== binding.membership)
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected phase repository identity differs');
  const raw = JSON.parse(readImmutableFile(fs, path.join(directory, 'delivery-state.json'), 'phase state'));
  const actual = require('./architecture-target.cjs').phaseBinding({ graph, state: raw.tickets || raw,
    phase: Number(binding.phase.split('-')[0]), repository: common, repo: binding.repo ?? null, branch: rows[0][1].epic,
    pr: Number(subject[4]), head: subject[5], base: subject[6] });
  if (actual.subject !== binding.subject) fail('ARCHIVE_AUTHORITY_INVALID', 'actual current phase ticket-set digest differs');
  return { root, project, identity: { repository: common, graph_dir: directory,
    phase: binding.phase, ticket_set_digest: binding.membership,
    tickets: rows.map(([id]) => id) } };
}

function phaseRosterPath(scope) {
  return path.join(archiveAuthorityDirectory(scope.project), 'phase-archive-roster-' + digest(stable(scope.identity)) + '.json');
}

function reconciledRecordTicket(trusted) {
  const identities = [trusted.record.ticket, trusted.record.trace?.ticket,
    ...(Array.isArray(trusted.record.trace) ? trusted.record.trace.map(stage => stage?.ticket) : []),
    trusted.receipt.ticket, trusted.receipt.runtime_evidence?.ticket].filter(value => value !== undefined);
  if (!identities.length || identities.some(value => typeof value !== 'string' || !value.trim() || value !== identities[0]))
    fail('ARCHIVE_AUTHORITY_INVALID', 'original record and receipt ticket identities conflict');
  return identities[0];
}

function phaseRecordPins(dispatchId, pins) {
  if (!Array.isArray(pins) || pins.length !== 3 || new Set(pins.map(pin => pin.path)).size !== 3
      || pins.some(pin => !object(pin) || typeof pin.path !== 'string'
        || path.posix.dirname(pin.path) !== archiveRelative(dispatchId, '').replace(/\/$/, '')
        || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || pin.bytes > HISTORICAL_ARCHIVE_MAX_BYTES
        || !/^[a-f0-9]{64}$/.test(pin.sha256 || ''))
      || !pins.some(pin => pin.path === archiveRelative(dispatchId, MANIFEST_NAME)))
    fail('ARCHIVE_AUTHORITY_INVALID', 'current family requires exactly three original pins');
  return pins.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
}

function registeredPhaseWorktrees(root) {
  return execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split('\n').filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice(9)));
}

function verifyPhaseRosterRecord(scope, row) {
  if (!object(row) || !scope.identity.tickets.includes(row.ticket)
      || !registeredPhaseWorktrees(scope.root).includes(row.worktree)
      || fs.realpathSync(row.worktree) !== row.worktree)
    fail('ARCHIVE_AUTHORITY_INVALID', 'retained current dispatch worktree or ticket differs');
  const trusted = trustedRecord({ dispatchId: row.dispatch_id, boundaryStore: row.receipt_store });
  if (reconciledRecordTicket(trusted) !== row.ticket || stable(trusted.receipt) !== stable(row.receipt))
    fail('ARCHIVE_AUTHORITY_INVALID', 'retained original current receipt differs');
  const repository = fs.realpathSync(execFileSync('git', ['-C', row.worktree, 'rev-parse',
    '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  if (repository !== scope.identity.repository || (trusted.receipt.runtime_evidence?.worktree !== undefined
      && trusted.receipt.runtime_evidence.worktree !== row.worktree))
    fail('ARCHIVE_AUTHORITY_INVALID', 'retained current dispatch repository or worktree differs');
  return trusted;
}

function registerPhaseArchiveRoster(input) {
  if (!object(input) || !/^[a-f0-9]{64}$/.test(input.expectedInventoryDigest || ''))
    fail('ARCHIVE_AUTHORITY_REQUIRED', 'independently retained current inventory digest is required');
  const scope = phaseArchiveScope(input.worktreePath, input.binding, input.graphDir);
  const bytes = authorityFile(path.resolve(input.inventoryPath));
  if (digest(bytes) !== input.expectedInventoryDigest)
    fail('ARCHIVE_AUTHORITY_INVALID', 'independently retained current inventory differs');
  const inventory = JSON.parse(bytes);
  if (!Array.isArray(inventory.rows) || inventory.rows.length > 1000)
    fail('ARCHIVE_AUTHORITY_INVALID', 'complete retained current inventory rows are required');
  const records = inventory.rows.map(row => {
    verifyPhaseRosterRecord(scope, row);
    return { worktree: row.worktree, ticket: row.ticket, dispatch_id: row.dispatch_id,
      receipt_store: nonEmpty(row.receipt_store, 'original receipt store'), receipt: row.receipt,
      pins: phaseRecordPins(row.dispatch_id, row.pins) };
  }).sort((a, b) => a.dispatch_id.localeCompare(b.dispatch_id));
  if (new Set(records.map(row => row.dispatch_id)).size !== records.length)
    fail('ARCHIVE_AUTHORITY_INVALID', 'duplicate retained current dispatch');
  const payload = { schema: 'shipyard.phase-archive-roster.v1', identity: scope.identity,
    inventory_digest: input.expectedInventoryDigest, records };
  const state = authorityState(scope.project, true, false, false);
  const file = phaseRosterPath(scope);
  const serialized = JSON.stringify({ payload, mac: crypto.createHmac('sha256', state.key).update(stable(payload)).digest('hex') }) + '\n';
  if (Buffer.byteLength(serialized) > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARCHIVE_AUTHORITY_INVALID', 'complete phase roster exceeds its byte bound');
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!authorityFile(file).equals(Buffer.from(serialized)))
        fail('ARCHIVE_AUTHORITY_INVALID', 'phase roster cannot replace original independently retained membership');
    }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { ...payload, roster_digest: digest(stable(payload)), record_path: file };
}

function readPhaseArchiveRoster(input) {
  const scope = phaseArchiveScope(input.worktreePath, input.binding, input.graphDir);
  const file = phaseRosterPath(scope);
  if (!fs.existsSync(file)) fail('ARCHIVE_AUTHORITY_REQUIRED', 'independently retained current phase roster is missing');
  const state = authorityState(scope.project, false, false, false);
  const envelope = JSON.parse(authorityFile(file));
  const mac = crypto.createHmac('sha256', state.key).update(stable(envelope.payload)).digest('hex');
  if (!object(envelope.payload) || !/^[a-f0-9]{64}$/.test(envelope.mac || '')
      || !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(envelope.mac, 'hex'))
      || envelope.payload.schema !== 'shipyard.phase-archive-roster.v1'
      || stable(envelope.payload.identity) !== stable(scope.identity)
      || !Array.isArray(envelope.payload.records) || envelope.payload.records.length > 1000
      || !/^[a-f0-9]{64}$/.test(envelope.payload.inventory_digest || ''))
    fail('ARCHIVE_AUTHORITY_INVALID', 'current phase roster authentication or membership differs');
  const records = envelope.payload.records;
  if (new Set(records.map(row => row.dispatch_id)).size !== records.length)
    fail('ARCHIVE_AUTHORITY_INVALID', 'duplicate protected current dispatch');
  for (const row of records) { verifyPhaseRosterRecord(scope, row); phaseRecordPins(row.dispatch_id, row.pins); }
  return { ...envelope.payload, roster_digest: digest(stable(envelope.payload)), record_path: file };
}

function phaseSelectionVerification() {
  const authorities = new Map(), objects = new Map();
  const snapshot = state => [state.directory, path.join(state.directory, 'hmac.key'), state.file]
    .map(file => ({ file, real: fs.realpathSync(file), stat: fs.lstatSync(file, { bigint: true }) }));
  const unchanged = retained => {
    for (const entry of retained) {
      const stat = fs.lstatSync(entry.file, { bigint: true });
      if (fs.realpathSync(entry.file) !== entry.real
          || ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(field => stat[field] !== entry.stat[field]))
        fail('ARCHIVE_AUTHORITY_INVALID', 'archive authority changed during phase selection');
    }
  };
  return {
    authority(worktree) {
      const existing = authorities.get(worktree);
      if (existing) { unchanged(existing.snapshot); return existing.state; }
      const directory = archiveAuthorityDirectory(worktree);
      const before = snapshot({ directory, file: path.join(directory, 'catalogue.json') });
      const state = authorityState(worktree);
      unchanged(before);
      authorities.set(worktree, { state, snapshot: before });
      return state;
    },
    identity(worktree, commit, label) {
      const key = worktree + ':' + commit;
      if (!objects.has(key)) objects.set(key, gitObjectIdentity({}, worktree, commit, label));
      return objects.get(key);
    },
    finish() { for (const retained of authorities.values()) unchanged(retained.snapshot); },
  };
}

function selectedArchiveRecord(scope, row, trusted) {
  const state = scope.verification.authority(row.worktree);
  const record = state.payload.records[row.dispatch_id];
  const pins = phaseRecordPins(row.dispatch_id, row.pins);
  if (!record || record.dispatch_id !== row.dispatch_id || stable(record.receipt) !== stable(row.receipt)
      || stable(phaseRecordPins(row.dispatch_id, record.pins)) !== stable(pins))
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected original catalogue record or pins differ');
  const family = fixedPath(row.worktree, archiveRelative(row.dispatch_id, ''), 'selected current family');
  const membership = () => {
    const stat = fs.lstatSync(family);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(family) !== family)
      fail('ARCHIVE_AUTHORITY_INVALID', 'selected current family is not a physical directory');
    return fs.readdirSync(family).map(name => path.relative(row.worktree, path.join(family, name)))
      .sort((a, b) => a.localeCompare(b));
  };
  if (stable(membership()) !== stable(pins.map(pin => pin.path)))
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected complete family membership differs');
  const files = pins.map(pin => {
    const file = fixedPath(row.worktree, pin.path, 'selected current archive');
    if ((fs.lstatSync(file).mode & 0o777) !== 0o600)
      fail('ARCHIVE_AUTHORITY_INVALID', 'selected current archive mode differs');
    return { ...pin, content: readPinnedArchiveFile(row.worktree, pin, 'selected current archive').toString('utf8') };
  });
  const manifest = JSON.parse(files.find(pin => pin.path.endsWith('/' + MANIFEST_NAME)).content);
  if (manifest.schema !== ROLE_ARTIFACT_SCHEMA || manifest.version !== ENVELOPE_VERSION
      || manifest.repository_identity !== scope.identity.repository)
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected manifest repository or schema differs');
  for (const [field, expected] of [['producer_dispatch', row.dispatch_id], ['producer_dispatch_id', row.dispatch_id],
    ['dispatch_id', row.dispatch_id], ['producer_launch', row.receipt.launch_id], ['runtime', row.receipt.runtime],
    ['role', row.receipt.role], ['worktree', row.worktree], ['worktree_realpath', row.worktree], ['policy_hash', row.receipt.policy_hash]])
    manifestValue(manifest, field, expected);
  manifestValue(manifest, manifest.artifact_kind === 'judgment' ? 'boundary_subject' : 'ticket', row.ticket);
  if (trusted) verifyDispatchContext(manifest, trusted);
  const evidenceName = JUDGMENT_ROLES.has(row.receipt.role) ? JUDGMENT_EVIDENCE_NAMES[row.receipt.role] : producerEvidenceName(row.receipt.role);
  for (const [name, declared] of [[evidenceName, manifest.files?.evidence], [FINDINGS_NAME, manifest.files?.findings]]) {
    const pin = pins.find(pin => pin.path === archiveRelative(row.dispatch_id, name));
    if (!pin || !object(declared) || stable(pin) !== stable({ path: declared.path, bytes: declared.bytes, sha256: declared.sha256 }))
      fail('ARCHIVE_AUTHORITY_INVALID', 'selected manifest complete original pins differ');
  }
  for (const [commit, tree, label] of [[manifest.head, manifest.head_tree, 'selected original head'],
    [manifest.base_commit, manifest.base_tree, 'selected original base']])
    if (scope.verification.identity(row.worktree, sha(commit, label), label).tree !== tree)
      fail('ARCHIVE_AUTHORITY_INVALID', 'selected original revision differs');
  if (stable(membership()) !== stable(pins.map(pin => pin.path)))
    fail('ARCHIVE_AUTHORITY_INVALID', 'selected membership changed while authenticating');
  return { worktree: row.worktree, dispatch_id: row.dispatch_id, receipt: row.receipt, files };
}

function authenticatedRecordSubject(record) {
  const identities = [record.ticket, record.receipt?.ticket, record.receipt?.runtime_evidence?.ticket]
    .filter(value => value !== undefined);
  if (identities.some(value => typeof value !== 'string' || !value || value !== identities[0]))
    fail('ARCHIVE_AUTHORITY_INVALID', 'aggregate candidate original receipt identity differs');
  return identities[0];
}

function selectedPhaseJudgments(scope, binding, roster) {
  const candidates = [];
  const worktrees = [...new Set([scope.root, scope.project, ...roster.records.map(row => row.worktree)])];
  for (const worktree of worktrees) {
    const catalogue = path.join(archiveAuthorityDirectory(worktree), 'catalogue.json');
    if (!fs.existsSync(catalogue)) continue;
    const state = scope.verification ? scope.verification.authority(worktree) : authorityState(worktree);
    for (const record of Object.values(state.payload.records)) {
      if (record.receipt?.role !== 'arch-review') continue;
      if (authenticatedRecordSubject(record) !== binding.subject) continue;
      if (candidates.length >= 1000)
        fail('ARCHIVE_AUTHORITY_INVALID', 'selected phase judgments exceed their total bound');
      candidates.push({ worktree, record });
    }
  }
  return candidates;
}

function phaseArchiveHints(scope, binding, roster, currentDispatchId) {
  return selectedPhaseJudgments(scope, binding, roster)
    .filter(({ record }) => record.dispatch_id !== currentDispatchId)
    .map(({ worktree, record }) => selectedArchiveRecord(scope, {
      worktree, dispatch_id: record.dispatch_id, ticket: binding.subject,
      receipt: record.receipt, pins: record.pins,
    }));
}

function selectPhaseArchives(worktreePath, binding, options = {}) {
  const scope = phaseArchiveScope(worktreePath, binding, options.graphDir);
  scope.verification = phaseSelectionVerification();
  const roster = readPhaseArchiveRoster({ worktreePath, binding, graphDir: options.graphDir });
  const selection = { identity: roster.identity, roster_digest: roster.roster_digest,
    inventory_digest: roster.inventory_digest, records: roster.records };
  if (options.phaseArchiveSelection && stable(options.phaseArchiveSelection) !== stable(selection))
    fail('ARCHIVE_AUTHORITY_INVALID', 'frozen current phase archive selection differs');
  const evidence = roster.records.map(row => selectedArchiveRecord(scope, row, verifyPhaseRosterRecord(scope, row)));
  const candidates = phaseArchiveHints(scope, binding, roster, options.currentDispatchId);
  scope.verification.finish();
  return { selection, evidence: evidence.sort((a, b) => a.dispatch_id.localeCompare(b.dispatch_id)), candidates,
    pins: roster.records.filter(row => row.worktree === scope.root).flatMap(row => row.pins).sort((a, b) => a.path.localeCompare(b.path)) };
}

function phaseArchitectureEvidence(worktreePath, binding, options = {}) {
  return selectPhaseArchives(worktreePath, binding, options).evidence;
}

function phaseArchitectureEvidenceDigest(evidence) { return digest(stable(evidence)); }

const authenticatedReviewBaselines = new WeakSet();

function isAuthenticatedReviewBaseline(value) { return authenticatedReviewBaselines.has(value); }

function originalReviewRetention(worktree, trusted) {
  const store = trusted.recorder.storeDir;
  const runtime = trusted.receipt.runtime_evidence;
  if (!['arch-review', 'integrator'].includes(trusted.receipt.role) || trusted.receipt.runtime !== 'codex'
      || typeof store !== 'string' || runtime?.input_transport !== 'host-files'
      || runtime.review_continuation || runtime.native_child_evidence) return null;
  const native = runtime.native_session_evidence;
  if (!object(native) || !/^[a-f0-9]{64}$/.test(native.sha256 || '') || native.session_id !== runtime.session_id) return null;
  const codexHome = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
  try {
    const candidates = require('./codex-runtime-host.cjs').nativeSessionCandidates(path.join(codexHome, 'sessions'), native.session_id);
    if (candidates.length !== 1) return null;
    const file = candidates[0];
    const content = readImmutableFile(fs, file, 'original native review', 128 * 1024 * 1024);
    if (digest(content) !== native.sha256 || content.length !== native.bytes || fs.realpathSync(file) !== file) return null;
    return { schema: 'shipyard.review-baseline-authority.v1', receipt_store: fs.realpathSync(store),
      finalized_at: new Date().toISOString(), native: { path: file, bytes: content.length, sha256: digest(content) } };
  } catch { return null; }
}

const admissionReviewInputs = new WeakMap();

function selectReviewBaseline({ currentInput, excludeDispatchId } = {}) {
  const context = require('./codex-arch-review-context.cjs');
  const admission = admissionReviewInputs.get(currentInput);
  if (!admission && !context.isPreparedFileInput(currentInput)) fail('REVIEW_BASELINE_REQUIRED', 'current input needs private host preparation');
  const current = admission?.identity || context.reviewProgressIdentity(currentInput);
  const checked = admission?.checked || context.verifyFileInput(currentInput);
  const fallback = (reason, rejected = []) => Object.freeze({ schema: 'shipyard.review-baseline-selection.v1',
    mode: 'full', role: current.role, current, baseline: null, reason, rejected });
  if (!checked.manifest.binding?.agent_sha256) return fallback('current-instructions-unpinned');
  const graphPin = checked.manifest.snapshot.graph.find(pin => path.basename(pin.path) === 'tickets.json');
  if (!graphPin) return fallback('complete-current-graph-unavailable');
  const graphBytes = readImmutableFile(fs, graphPin.path, 'current complete phase graph', 8 * 1024 * 1024);
  if (digest(graphBytes) !== graphPin.sha256) return fallback('current-phase-graph-changed');
  let currentPacket;
  try {
    if (checked.material.length !== 1) return fallback('unsupported-current-semantic-packet');
    currentPacket = require('./context-packet.cjs').decodeUniqueContent(JSON.parse(checked.material[0]));
  } catch { return fallback('unsupported-current-semantic-packet'); }
  const graphRoot = path.resolve(path.dirname(graphPin.path), '../..');
  const graphCommon = fs.realpathSync(execFileSync('git', ['-C', graphRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  if (graphCommon !== current.repository || path.basename(path.dirname(graphPin.path)) !== 'graph'
      || path.basename(path.dirname(path.dirname(graphPin.path))) !== '.planning') return fallback('foreign-current-phase-graph');
  const repo = currentPacket.graph?.binding?.repo ?? currentPacket.role_context?.phase_repo ?? null;
  const rows = require('./architecture-target.cjs').phaseRows(JSON.parse(graphBytes), Number(current.phase), repo);
  if (stable(rows.map(([id]) => id)) !== stable([...current.ticket_set].sort()))
    return fallback('incomplete-current-phase-membership');
  const worktrees = registeredPhaseWorktrees(current.worktree);
  if (worktrees.length > 1000) return fallback('baseline-discovery-over-bound');
  const verification = phaseSelectionVerification();
  const eligible = [], rejected = [], unresolved = [];
  let count = 0, catalogueBytes = 0;
  try {
    for (const candidate of worktrees) {
      const worktree = fs.realpathSync(candidate);
      const catalogue = path.join(archiveAuthorityDirectory(worktree), 'catalogue.json');
      if (!fs.existsSync(catalogue)) continue;
      catalogueBytes += fs.lstatSync(catalogue).size;
      if (catalogueBytes > 16 * 1024 * 1024) return fallback('baseline-discovery-over-bound', rejected);
      const state = verification.authority(worktree);
      for (const record of Object.values(state.payload.records)) {
        if (record.receipt?.role !== current.role || record.dispatch_id === excludeDispatchId) continue;
        if (++count > 1000) return fallback('baseline-discovery-over-bound', rejected);
        const hint = /^phase=([^;]+);repository=([^;]+);/.exec(authenticatedRecordSubject(record) || '');
        if (!hint || hint[2] !== current.repository || Number(hint[1].split('-')[0]) !== Number(current.phase)) continue;
        try {
          const retained = record.review_baseline;
          if (retained?.schema !== 'shipyard.review-baseline-authority.v1'
              || typeof retained.finalized_at !== 'string' || new Date(retained.finalized_at).toISOString() !== retained.finalized_at)
            fail('REVIEW_BASELINE_UNSUPPORTED', 'protected original finalization ordering is unavailable');
          const trusted = trustedRecord({ dispatchId: record.dispatch_id, boundaryStore: retained.receipt_store });
          if (stable(trusted.receipt) !== stable(record.receipt)) fail('REVIEW_BASELINE_INVALID', 'original receipt differs');
          const subject = reconciledRecordTicket(trusted);
          const archive = selectedArchiveRecord({ identity: { repository: current.repository }, verification }, {
            worktree, dispatch_id: record.dispatch_id, ticket: subject, receipt: record.receipt, pins: record.pins,
          }, trusted);
          const manifestFile = archive.files.find(pin => pin.path.endsWith('/' + MANIFEST_NAME));
          const manifest = JSON.parse(manifestFile.content);
          const findings = JSON.parse(archive.files.find(pin => pin.path === manifest.files.findings.path).content);
          const evidence = Buffer.from(archive.files.find(pin => pin.path === manifest.files.evidence.path).content);
          if (manifest.current_review !== undefined) fail('REVIEW_BASELINE_UNSUPPORTED', 'extended current lineage is not a supported original full baseline');
          if (manifest.artifact_kind !== 'judgment') fail('REVIEW_BASELINE_INVALID', 'baseline is not a judgment');
          const phaseSubject = /^phase=([^;]+);repository=([^;]+);tickets=([a-f0-9]{64})(?:;|$)/.exec(subject);
          if (!phaseSubject || phaseSubject[2] !== current.repository
              || Number(phaseSubject[1].split('-')[0]) !== Number(current.phase))
            fail('REVIEW_BASELINE_INVALID', 'baseline is not the same complete phase/repository');
          const identity = { worktree, repository: { root: manifest.repository_realpath, identity: current.repository },
            head: manifest.head, head_tree: manifest.head_tree, base: manifest.base, base_commit: manifest.base_commit,
            base_tree: manifest.base_tree, merge_base: manifest.merge_base, merge_base_tree: manifest.merge_base_tree };
          if (gitObjectIdentity({}, worktree, sha(manifest.merge_base, 'original merge base'), 'original merge base').tree !== manifest.merge_base_tree
              || git({}, worktree, ['merge-base', manifest.base_commit, manifest.head], 'original ancestry') !== manifest.merge_base)
            fail('REVIEW_BASELINE_INVALID', 'original base ancestry differs');
          const data = judgmentResultData(findings, { ...trustedMetadata({ role: current.role }, trusted, identity), trusted }, {
            phase: manifest.phase || phaseSubject[1], ticketSet: findings.ticket_set, ticketSetDigest: manifest.ticket_set_digest,
            pr: manifest.pr, base: manifest.base,
          }, identity);
          if (manifest.subject !== data.subject || stable(manifest.reviewed) !== stable(data.reviewed)
              || manifest.ticket_set_digest !== data.ticket_set_digest || phaseSubject[3] !== data.ticket_set_digest
              || stable(manifest.envelope) !== stable(judgmentEnvelope(data, {
                evidence: { relative: manifest.files.evidence.path, content: evidence },
                findings: { relative: manifest.files.findings.path, content: Buffer.from(archive.files.find(pin => pin.path === manifest.files.findings.path).content) },
              }))) fail('REVIEW_BASELINE_INVALID', 'original outcome, unresolved findings or envelope differs');
          if (findings.limitations !== undefined && (!Array.isArray(findings.limitations) || findings.limitations.length)
              || findings.assumptions !== undefined && (!Array.isArray(findings.assumptions) || findings.assumptions.length))
            fail('REVIEW_BASELINE_UNSUPPORTED', 'original semantic assumptions or limitations require full review');
          const original = context.validateOriginalReviewContext({ receipt: trusted.receipt, dispatchId: record.dispatch_id,
            result: findings, evidence, nativePin: retained.native });
          if (data.finding_count !== 0 || data.blocking_count !== 0
              || data.outcome !== (current.role === 'arch-review' ? 'conform' : 'passed')) {
            unresolved.push({ dispatch_id: record.dispatch_id, finalized_at: retained.finalized_at });
            fail('REVIEW_BASELINE_UNRESOLVED', 'original role judgment retains unresolved findings');
          }
          const prior = original.manifest;
          const priorIds = canonicalTicketSet(findings.ticket_set, 'original full ticket set').map(entry => entry.id);
          if (stable(prior.binding.ticket_set) !== stable(priorIds) || stable(priorIds) !== stable(current.ticket_set)
              || prior.binding.ticket_set_digest !== manifest.ticket_set_digest
              || prior.snapshot.repository !== current.repository || prior.snapshot.head !== manifest.head
              || prior.binding.base !== manifest.base_commit || prior.binding.merge_base !== manifest.merge_base
              || prior.role !== current.role || prior.phase !== Number(current.phase)
              || prior.ticket !== subject || prior.snapshot.worktree !== worktree)
            fail('REVIEW_BASELINE_INVALID', 'complete original membership or subject differs');
          if (manifest.ticket_set_digest !== current.ticket_set_digest)
            fail('REVIEW_BASELINE_STALE', 'complete phase membership or evidence changed');
          if (manifest.base_commit !== current.base || manifest.merge_base !== current.merge_base
              || prior.binding.base_ref !== current.base_ref) fail('REVIEW_BASELINE_STALE', 'integration base changed');
          if (manifest.policy_hash !== current.policy_hash || prior.snapshot.policy_hash !== current.policy_hash
              || prior.schema !== current.contract
              || prior.binding.agent_sha256 !== checked.manifest.binding.agent_sha256
              || stable(prior.snapshot.sources) !== stable(checked.manifest.snapshot.sources)
              || stable(prior.binding.installed_files || []) !== stable(checked.manifest.binding.installed_files || []))
            fail('REVIEW_BASELINE_STALE', 'policy, contract or instructions changed');
          execFileSync('git', ['-C', current.worktree, 'merge-base', '--is-ancestor', manifest.head, current.head],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
          eligible.push({ schema: 'shipyard.review-baseline.v1', role: current.role, repository: current.repository,
            worktree, phase: current.phase, head: manifest.head, base: manifest.base_commit, merge_base: manifest.merge_base,
            ticket_set: priorIds, ticket_set_digest: manifest.ticket_set_digest,
            dispatch_id: record.dispatch_id, finalized_at: retained.finalized_at,
            artifact: { path: manifestFile.path, bytes: manifestFile.bytes, sha256: manifestFile.sha256 },
            receipt_digest: digest(stable(trusted.receipt)), consumption: trusted.receipt.runtime_evidence.input_consumption,
            contract: prior.schema, policy_hash: manifest.policy_hash, instruction_digest: prior.binding.agent_sha256,
            packet_digest: prior.binding.packet_digest, obligations: original.obligations,
            logical_obligations: original.logical_obligations,
            conclusion: { outcome: data.outcome, summary: data.summary, findings: [],
              evidence: { ...manifest.files.evidence, content: evidence.toString('utf8') } },
            assumptions: { base: current.base, merge_base: current.merge_base, policy_hash: current.policy_hash,
              contract: current.contract, instruction_digest: checked.manifest.binding.agent_sha256,
              semantic: findings.assumptions || [], confirmation: 'fresh-native-review-required' },
          });
        } catch (error) {
          rejected.push({ dispatch_id: record.dispatch_id, code: error.code || 'REVIEW_BASELINE_INVALID' });
        }
      }
    }
    verification.finish();
  } catch (error) { return fallback(error.code || 'baseline-authority-unavailable', rejected); }
  eligible.sort((a, b) => b.finalized_at.localeCompare(a.finalized_at) || b.dispatch_id.localeCompare(a.dispatch_id));
  if (!eligible.length) return fallback('no-eligible-original-role-success', rejected);
  const baseline = eligible[0];
  if (unresolved.some(item => item.finalized_at > baseline.finalized_at
      || item.finalized_at === baseline.finalized_at && item.dispatch_id > baseline.dispatch_id))
    return fallback('unresolved-later-role-findings', rejected);
  if (eligible.slice(1).some(item => item.dispatch_id === baseline.dispatch_id
      && (item.artifact.sha256 !== baseline.artifact.sha256 || item.worktree !== baseline.worktree)))
    return fallback('ambiguous-original-role-success', rejected);
  const frozen = context.freezeReviewBaseline(baseline);
  authenticatedReviewBaselines.add(frozen);
  return Object.freeze({ schema: 'shipyard.review-baseline-selection.v1', mode: 'incremental', role: current.role,
    current, baseline: frozen, reason: null, rejected });
}

function reviewGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).trimEnd();
}

function matchesGitSource(entry, ref) {
  return entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode)
    && typeof ref.content === 'string' && Buffer.byteLength(ref.content) === ref.bytes
    && crypto.createHash('sha1').update('blob ' + ref.bytes + '\0').update(ref.content).digest('hex') === entry.object;
}

function endpointInventory(root, revision) {
  const entries = reviewGit(root, [ 'ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean);
  if (entries.length > 20000) fail('CONTEXT_OVER_BOUND', 'complete endpoint inventory exceeds its bound');
  return entries.map(entry => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) fail('REVIEW_IMPACT_UNCERTAIN', 'unsupported endpoint inventory');
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
}

function endpointChanges(root, baseline, head) {
  const raw = reviewGit(root, [ 'diff', '--no-ext-diff', '--no-textconv', '--name-status',
    '--find-renames', '-z', baseline, head]).split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < raw.length;) {
    const status = raw[index++];
    if (!/^(?:[ACDMRTUXB]|[RC]\d+)$/.test(status) || index >= raw.length) fail('REVIEW_IMPACT_UNCERTAIN', 'unsupported endpoint delta');
    const before = raw[index++];
    const after = /^[RC]/.test(status) ? raw[index++] : before;
    if (!after) fail('REVIEW_IMPACT_UNCERTAIN', 'incomplete endpoint rename');
    entries.push({ status, path: after, ...(after !== before ? { previous_path: before } : {}),
      development_context: require('./development-artifacts.cjs').isDevelopmentArtifact(after) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function rebuildReviewImpactPacket(currentInput, selection, excludeDispatchId) {
  const context = require('./codex-arch-review-context.cjs');
  const SCHEMA = context.SCHEMA;
  const isPreparedFileInput = value => admissionReviewInputs.has(value);
  const verifyFileInput = value => admissionReviewInputs.get(value).checked;
  const reviewProgressIdentity = value => admissionReviewInputs.get(value).identity;
  const deepFreeze = context.freezeReviewBaseline;
  const canonical = value => JSON.parse(stable(value));
  const roleArtifact = module.exports;
  if (!isPreparedFileInput(currentInput)) fail('REVIEW_BASELINE_REQUIRED', 'impact packet requires private current input');
  const current = reviewProgressIdentity(currentInput);
  if (selection.schema !== 'shipyard.review-baseline-selection.v1' || selection.role !== current.role
      || !['full', 'incremental'].includes(selection.mode) || (selection.mode === 'incremental') !== Boolean(selection.baseline)
      || JSON.stringify(canonical(selection.current)) !== JSON.stringify(canonical(current)))
    fail('REVIEW_BASELINE_INVALID', 'baseline selection has a different current subject');
  const baseline = selection.baseline;
  if (baseline && !roleArtifact.isAuthenticatedReviewBaseline(baseline))
    fail('REVIEW_BASELINE_INVALID', 'baseline is not independently authenticated');
  if (baseline && (baseline.role !== current.role || baseline.repository !== current.repository
      || baseline.phase !== current.phase || baseline.base !== current.base || baseline.merge_base !== current.merge_base
      || baseline.policy_hash !== current.policy_hash || baseline.contract !== current.contract
      || JSON.stringify(canonical(baseline.ticket_set)) !== JSON.stringify(canonical(current.ticket_set))
      || baseline.ticket_set_digest !== current.ticket_set_digest))
    fail('REVIEW_BASELINE_INVALID', 'baseline role or subject differs from the current review');
  const checked = verifyFileInput(currentInput), root = current.worktree;
  const endpoint = baseline?.head || current.merge_base;
  const previousInventory = endpointInventory(root, endpoint), inventory = endpointInventory(root, current.head);
  const delta = endpointChanges(root, endpoint, current.head);
  const changed = new Set(delta.flatMap(entry => [entry.path, entry.previous_path].filter(Boolean)));
  const previous = new Map(previousInventory.map(entry => [entry.path, entry])), now = new Map(inventory.map(entry => [entry.path, entry]));
  const graph = new Map(), boundaries = [], uncertainty = [], bodies = new Map();
  let total = 0;
  const read = entry => {
    if (bodies.has(entry.object)) return bodies.get(entry.object);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      uncertainty.push({ path: entry.path, reason: 'non-regular-source-boundary' }); return null;
    }
    const size = Number(reviewGit(root, ['cat-file', '-s', entry.object]));
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || total + size > 16 * 1024 * 1024)
      fail('CONTEXT_OVER_BOUND', 'complete impact sources exceed their bound');
    const raw = execFileSync('git', ['-C', root, 'cat-file', 'blob', entry.object], { maxBuffer: 16 * 1024 * 1024 });
    total += raw.length;
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
      uncertainty.push({ path: entry.path, reason: 'binary-source-boundary' }); return null;
    }
    if (raw.includes(0)) { uncertainty.push({ path: entry.path, reason: 'binary-source-boundary' }); return null; }
    bodies.set(entry.object, content); return content;
  };
  const resolve = (source, specifier, sources) => {
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
    const candidates = [name, ...['.cjs', '.mjs', '.js', '.ts', '.tsx', '.jsx', '.json'].map(extension => name + extension),
      ...['index.cjs', 'index.mjs', 'index.js', 'index.ts'].map(file => name + '/' + file)].filter(file => sources.has(file));
    return candidates.length === 1 ? candidates[0] : null;
  };
  for (const sources of [previous, now]) for (const entry of sources.values()) {
    if (!/\.(?:cjs|mjs|js|ts|tsx|jsx)$/.test(entry.path)) continue;
    const content = read(entry);
    if (content === null) continue;
    if (!graph.has(entry.path)) graph.set(entry.path, new Set());
    const imports = [...content.matchAll(/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|\bimport\s*)(['"])([^'"\n]+)\1/g)];
    const literalCalls = [...content.matchAll(/\b(?:require|import)\s*\(\s*['"][^'"\n]+['"]\s*\)/g)].length;
    if ([...content.matchAll(/\b(?:require|import)\s*\(/g)].length !== literalCalls
        || /\b(?:eval|new\s+Function|createRequire)\s*\(|\brequire\.(?:resolve|context)\s*\(|=\s*require\b(?!\s*\()|\bmodule\s*\[|\b(?:readFile|readFileSync|readdir|readdirSync|spawn|execFile|execFileSync)\s*\(/.test(content))
      uncertainty.push({ path: entry.path, reason: 'dynamic-dependency-boundary' });
    for (const match of imports) {
      const specifier = match[2];
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) { boundaries.push({ path: entry.path, dependency: specifier, reason: 'external-package-boundary' }); continue; }
      const dependency = resolve(entry.path, specifier, sources);
      if (!dependency) { uncertainty.push({ path: entry.path, dependency: specifier, reason: 'unresolved-import-boundary' }); continue; }
      graph.get(entry.path).add(dependency);
      if (!graph.has(dependency)) graph.set(dependency, new Set());
      graph.get(dependency).add(entry.path);
      boundaries.push({ path: entry.path, dependency, reason: 'static-import-boundary' });
    }
  }
  const affected = new Set(changed), queue = [...changed];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 20000) fail('CONTEXT_OVER_BOUND', 'dependency closure exceeds its bound');
    for (const dependency of graph.get(queue[index]) || []) if (!affected.has(dependency)) { affected.add(dependency); queue.push(dependency); }
  }
  const governing = name => /^(?:AGENTS\.md|CLAUDE\.md|\.planning\/architecture\/|\.planning\/investigations\/.+\/DECISIONS\.md)/.test(name)
    || /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*lock[^/]*|tsconfig[^/]*\.json|[^/]*config[^/]*|[^/]*contract[^/]*)$/i.test(name)
    || /(?:^|\/)(?:generated|schemas|contracts)(?:\/|$)/.test(name);
  const limitations = [];
  let mode = selection.mode;
  if (mode === 'full') limitations.push({ reason: selection.reason });
  const governingChanges = [...changed].filter(governing);
  if (governingChanges.length) { mode = 'full'; limitations.push({ reason: 'governing-or-contract-change', paths: governingChanges }); }
  const unsupported = [...changed].filter(name => !require('./development-artifacts.cjs').isDevelopmentArtifact(name)
    && !/\.(?:cjs|mjs|js|ts|tsx|jsx|json|md|txt)$/.test(name));
  for (const name of unsupported) uncertainty.push({ path: name, reason: 'unsupported-interaction-boundary' });
  if ([...changed].some(name => !require('./development-artifacts.cjs').isDevelopmentArtifact(name))) {
    for (const entry of inventory) if (/\.(?:go|py|rs|rb|php|java|sh|html|css|vue|svelte)$/.test(entry.path))
      uncertainty.push({ path: entry.path, reason: 'cross-language-interaction-boundary' });
  }
  for (const boundary of boundaries) if (boundary.reason === 'external-package-boundary' && affected.has(boundary.path))
    uncertainty.push(boundary);
  if (uncertainty.length) { mode = 'full'; limitations.push({ reason: 'uncertain-dependency-closure', boundaries: uncertainty }); }
  const encoded = checked.material.length === 1 ? JSON.parse(checked.material[0]) : null;
  if (encoded?.schema !== 'shipyard.semantic-content.v1') fail('REVIEW_BASELINE_UNSUPPORTED', 'complete current semantic packet is required');
  const originalPacket = require('./context-packet.cjs').decodeUniqueContent(encoded);
  const members = originalPacket.ticket_set || originalPacket.role_context?.ticket_set;
  if (!Array.isArray(members) || JSON.stringify(members.map(item => typeof item === 'string' ? item : item.id).sort()) !== JSON.stringify([...current.ticket_set].sort())
      || (originalPacket.ticket_set_digest || originalPacket.role_context?.ticket_set_digest) !== current.ticket_set_digest)
    fail('REVIEW_BASELINE_INVALID', 'complete current membership differs from its input binding');
  const refs = originalPacket.schema === SCHEMA ? originalPacket.refs : originalPacket.required_refs;
  if (!Array.isArray(refs)) fail('REVIEW_BASELINE_REQUIRED', 'complete current obligation inventory is required');
  const changedProductRefs = refs.filter(ref => !require('./development-artifacts.cjs').isDevelopmentArtifact(ref.path)
    && !matchesGitSource(now.get(ref.path), ref)).map(ref => ref.path);
  if (changedProductRefs.length) {
    mode = 'full';
    limitations.push({ reason: 'current-product-source-differs-from-head', paths: changedProductRefs });
  }
  const priorObligations = baseline?.obligations || [], inheritedPrior = new Set();
  const inherited = [], newly = [];
  for (const ref of refs) {
    const index = priorObligations.findIndex((prior, index) => !inheritedPrior.has(index) && prior.path === ref.path
      && prior.sha256 === ref.sha256 && prior.bytes === ref.bytes && prior.purpose === (ref.purpose || 'required-source'));
    if (mode === 'incremental' && index >= 0 && !affected.has(ref.path)) {
      inheritedPrior.add(index);
      inherited.push({ ...priorObligations[index], conclusion: baseline.conclusion, assumptions: baseline.assumptions });
    } else newly.push({ ...ref, obligation: 'current-required-source' });
  }
  for (const name of [...affected].sort()) {
    const entry = now.get(name);
    if (!entry) {
      const old = previous.get(name);
      if (old) newly.push({ path: name, revision: endpoint, content: read(old), deleted: true, obligation: 'removed-endpoint-source' });
      continue;
    }
    const content = read(entry);
    if (content === null) { mode = 'full'; continue; }
    newly.push({ path: name, revision: current.head, bytes: Buffer.byteLength(content), sha256: digest(content), content,
      development_context: require('./development-artifacts.cjs').isDevelopmentArtifact(name), obligation: 'affected-endpoint-source' });
  }
  if (mode === 'full' && inherited.length) {
    inherited.length = 0;
    for (const ref of refs) if (!newly.some(item => item.obligation === 'current-required-source' && item.path === ref.path))
      newly.push({ ...ref, obligation: 'current-required-source' });
  }
  if (mode === 'full') limitations.push({ reason: 'complete-current-packet-required', semantic_reading: 'all-current-material' });
  const usedLogical = new Set();
  const logical = encoded.obligations.map(obligation => {
    const index = (baseline?.logical_obligations || []).findIndex((prior, index) => !usedLogical.has(index)
      && prior.source_path === obligation.source_path && prior.content_sha256 === obligation.content_sha256
      && prior.mandatory === obligation.mandatory && prior.purpose.replace(/\/\d+(?=\/|$)/g, '/*') === obligation.purpose.replace(/\/\d+(?=\/|$)/g, '/*'));
    if (mode === 'incremental' && index >= 0 && inherited.some(ref => ref.path === obligation.source_path && ref.sha256 === obligation.content_sha256)) {
      usedLogical.add(index);
      return { ...obligation, coverage: 'inherited', semantic_credit: false,
        baseline_obligation: baseline.logical_obligations[index], baseline_dispatch_id: baseline.dispatch_id };
    }
    return { ...obligation, coverage: 'newly-reviewed-current-packet', semantic_credit: false };
  });
  const lineage = { schema: 'shipyard.review-coverage-lineage.v1', role: current.role, mode, current,
    baseline: baseline ? { role: baseline.role, repository: baseline.repository, worktree: baseline.worktree,
      phase: baseline.phase, head: baseline.head, base: baseline.base, merge_base: baseline.merge_base,
      contract: baseline.contract, policy_hash: baseline.policy_hash, instruction_digest: baseline.instruction_digest,
      dispatch_id: baseline.dispatch_id,
      artifact: baseline.artifact, receipt_digest: baseline.receipt_digest, packet_digest: baseline.packet_digest,
      finalized_at: baseline.finalized_at, consumption: baseline.consumption, ticket_set_digest: baseline.ticket_set_digest } : null,
    endpoint: { from: endpoint, to: current.head, comparison: 'complete-git-endpoints' },
    endpoint_delta: delta, source_inventories: { baseline: previousInventory, current: inventory }, inherited, newly_reviewed: newly,
    impact: { paths: [...affected].sort(), boundaries, governing_changes: governingChanges }, limitations,
    current_membership: { ticket_set: members, ticket_set_digest: current.ticket_set_digest,
      mechanical_preflight: 'complete-current-phase-required' }, current_logical_obligations: logical,
    original_packet: encoded, semantic_credit: false };
  const raw = JSON.stringify(canonical(lineage));
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) fail('CONTEXT_OVER_BOUND', 'complete impact packet exceeds its bound');
  verifyFileInput(currentInput);
  if (baseline) {
    const rechecked = roleArtifact.selectReviewBaseline({ currentInput, excludeDispatchId });
    if (!rechecked.baseline || JSON.stringify(canonical(rechecked.baseline)) !== JSON.stringify(canonical(baseline)))
      fail('REVIEW_BASELINE_INVALID', 'original baseline changed during impact collection');
  }
  if (baseline && digest(readImmutableFile(fs, path.join(baseline.worktree, baseline.artifact.path), 'original baseline', 16 * 1024 * 1024)) !== baseline.artifact.sha256)
    fail('REVIEW_BASELINE_INVALID', 'baseline changed during impact collection');
  return deepFreeze({ ...lineage, digest: digest(raw) });
}

function reviewIdentityFromChecked(bundle, checked) {
  const manifest = checked.manifest, binding = manifest.binding;
  if (!object(binding) || !Array.isArray(binding.ticket_set) || !binding.ticket_set.length
      || binding.ticket_set.length > 2000 || new Set(binding.ticket_set).size !== binding.ticket_set.length
      || binding.ticket_set.some(id => !/^T-\d{2,}-\d{2,}$/.test(id)))
    fail('REVIEW_COVERAGE_INVALID', 'complete canonical current membership is required');
  const semantic = checked.material.map(bytes => {
    const value = JSON.parse(bytes);
    return { dictionary: value.dictionary_sha256, obligations: value.obligations_sha256 };
  });
  return { manifest_digest: digest(stable(manifest)), manifest_sha256: bundle.manifest_sha256,
    dictionary_digest: digest(JSON.stringify(semantic.map(pin => pin.dictionary))),
    obligation_digest: digest(JSON.stringify(semantic.map(pin => pin.obligations))),
    repository: manifest.snapshot.repository, worktree: manifest.snapshot.worktree, role: manifest.role,
    policy_hash: manifest.snapshot.policy_hash, contract: manifest.schema,
    head: manifest.snapshot.head, head_tree: manifest.snapshot.head_tree, base: binding.base,
    base_ref: binding.base_ref || null, merge_base: binding.merge_base,
    ticket_set: binding.ticket_set, ticket_set_digest: binding.ticket_set_digest,
    dispatch_id: manifest.dispatch_id, run_id: manifest.run_id, ticket: manifest.ticket, phase: manifest.phase };
}

function prepareCurrentReviewInput({ currentInput, storageRoot } = {}) {
  const context = require('./codex-arch-review-context.cjs');
  if (!context.isPreparedFileInput(currentInput) || currentInput.manifest.role !== 'arch-review')
    fail('REVIEW_COVERAGE_REQUIRED', 'architecture delta requires private complete current input');
  const checked = context.verifyFileInput(currentInput);
  const encoded = JSON.parse(checked.material[0]);
  const packet = require('./context-packet.cjs').decodeUniqueContent(encoded);
  if (checked.material.length !== 1 || packet.schema !== context.SCHEMA || packet.review_coverage)
    fail('REVIEW_COVERAGE_INVALID', 'one complete original architecture packet is required');
  const selection = selectReviewBaseline({ currentInput });
  const lineage = context.buildReviewImpactPacket(currentInput, selection);
  const { original_packet: _original, ...coverage } = lineage;
  const manifest = checked.manifest, binding = manifest.binding;
  const reviewed = { repository: manifest.snapshot.repository, worktree: manifest.snapshot.worktree,
    head: manifest.snapshot.head, head_tree: manifest.snapshot.head_tree, base: binding.base, base_ref: binding.base_ref,
    base_tree: reviewGit(manifest.snapshot.worktree, ['rev-parse', binding.base + '^{tree}']),
    merge_base: binding.merge_base, merge_base_tree: reviewGit(manifest.snapshot.worktree, ['rev-parse', binding.merge_base + '^{tree}']),
    phase: packet.phase, ticket_set: lineage.current_membership.ticket_set, ticket_set_digest: binding.ticket_set_digest,
    policy_hash: manifest.snapshot.policy_hash, contract: 'shipyard.architecture-review.v2' };
  const expanded = { ...packet, review_coverage: { ...coverage, reviewed_identity: reviewed,
    original_input: { manifest_sha256: currentInput.input_bundle.manifest_sha256, packet_digest: binding.packet_digest } } };
  delete expanded.digest;
  expanded.digest = digest(stable(expanded));
  return context.prepareFileInput({ worktree: manifest.snapshot.worktree, phase: manifest.phase,
    ticket: manifest.ticket, run_id: manifest.run_id }, JSON.stringify(require('./context-packet.cjs').encodeUniqueContent(expanded)), {
    role: 'arch-review', dispatchId: manifest.dispatch_id, storageRoot,
    graphDir: path.dirname(manifest.snapshot.graph[0].path), generatedInstructionBytes: manifest.accounting.generated_instruction_bytes,
    relayPrefix: 'Issue a fresh architecture verdict. Read every logical obligation and all new material and affected boundaries. '
      + 'Echo review_coverage.reviewed_identity and shipyard.architecture-coverage-result.v1 with exact inherited/new/impact/limitations coverage.',
    binding: { ...binding, review_contract: 'shipyard.architecture-review.v2', packet_digest: expanded.digest,
      coverage_digest: lineage.digest, original_input_bundle: currentInput.input_bundle, reviewed_identity: reviewed } });
}

function originalCurrentResponse(trusted, result, evidence, retained) {
  const receipt = trusted.receipt, runtime = receipt.runtime_evidence;
  const pin = runtime?.transcript;
  if (!object(pin) || !path.isAbsolute(pin.path || '') || !Number.isSafeInteger(pin.bytes)
      || pin.bytes < 1 || pin.bytes > 128 * 1024 * 1024)
    fail('REVIEW_NATIVE_REQUIRED', 'complete original current native stream is required');
  const raw = readImmutableFile(fs, pin.path, 'current native stream', 128 * 1024 * 1024);
  if (raw.length !== pin.bytes || digest(raw) !== pin.sha256)
    fail('REVIEW_NATIVE_INVALID', 'original current native stream changed');
  let original, text;
  if (receipt.runtime === 'codex') {
    const parsed = require('./codex-runtime-host.cjs').parseCodexStream(raw.toString('utf8'));
    const finals = parsed.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
    if (parsed.session_id !== runtime.session_id || finals.length !== 1
        || parsed.records.indexOf(finals[0]) > parsed.records.findLastIndex(row => row.type === 'turn.completed'))
      fail('REVIEW_NATIVE_INVALID', 'one original completed current result is required');
    text = finals[0].item.text;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 128 * 1024)
      fail('REVIEW_NATIVE_INVALID', 'current result exceeds its bounded envelope');
    original = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const nativePin = retained?.native;
    if (!object(nativePin) || nativePin.sha256 !== runtime.native_session_evidence?.sha256
        || runtime.input_consumption?.native_session_sha256 !== nativePin.sha256
        || runtime.native_session_evidence?.session_id !== runtime.session_id)
      fail('REVIEW_NATIVE_REQUIRED', 'original current semantic consumption authority is required');
    const native = readImmutableFile(fs, nativePin.path, 'current native transcript', 128 * 1024 * 1024);
    if (native.length !== nativePin.bytes || digest(native) !== nativePin.sha256)
      fail('REVIEW_NATIVE_INVALID', 'original current native transcript changed');
    const parsedNative = require('./codex-runtime-host.cjs').parseNativeCodexTranscript(native.toString('utf8'), runtime.session_id);
    if (parsedNative.selections.some(value => value.model !== receipt.observed_model || value.effort !== receipt.observed_effort))
      fail('REVIEW_NATIVE_INVALID', 'current native role policy differs');
    const rows = native.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    const finalsNative = rows.filter(row => row.type === 'response_item' && row.payload?.phase === 'final_answer');
    if (!finalsNative.length || finalsNative.at(-1).payload.content.map(block => block.text || '').join('') !== text)
      fail('REVIEW_NATIVE_INVALID', 'current native final differs from original stream');
    if (!runtime.review_continuation) {
      const starts = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started');
      const complete = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
      if (starts.length !== 1 || complete.length !== 1 || finalsNative.length !== 1
          || complete[0].payload.turn_id !== starts[0].payload.turn_id || complete[0].payload.last_agent_message !== text
          || rows.indexOf(starts[0]) >= rows.indexOf(finalsNative[0]) || rows.indexOf(finalsNative[0]) >= rows.indexOf(complete[0]))
        fail('REVIEW_NATIVE_INVALID', 'current native completion is outside its unique original turn');
    } else validateReviewContinuationEvidence(runtime);
  } else if (receipt.runtime === 'claude') {
    const parsed = require('./claude-runtime-host.cjs').parseClaudeStream(raw.toString('utf8'));
    if (parsed.session_id !== runtime.session_id || parsed.result?.is_error === true)
      fail('REVIEW_NATIVE_INVALID', 'original second-runtime completion differs');
    original = parsed.result?.structured_output;
    if (!object(original) && typeof parsed.result?.result === 'string') {
      try { original = JSON.parse(parsed.result.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
    }
    if (!object(original)) fail('REVIEW_NATIVE_INVALID', 'original second-runtime complete JSON is required');
    const nativePin = runtime.selection_evidence?.transcript;
    if (!object(nativePin) || !path.isAbsolute(nativePin.path || ''))
      fail('REVIEW_NATIVE_REQUIRED', 'original second-runtime semantic transcript is required');
    const native = readImmutableFile(fs, nativePin.path, 'original second-runtime semantic transcript', 128 * 1024 * 1024);
    if (native.length !== nativePin.bytes || digest(native) !== nativePin.sha256)
      fail('REVIEW_NATIVE_INVALID', 'original second-runtime semantic transcript changed');
  } else fail('REVIEW_NATIVE_INVALID', 'unsupported current native runtime');
  const { host_context: _nativeContext, evidence_markdown: markdown, ...nativeResult } = original;
  const { host_context: _sealedContext, ...sealedResult } = result;
  if (stable(nativeResult) !== stable(sealedResult)
      || (markdown !== undefined && (typeof markdown !== 'string' || markdown.trim() !== evidence.toString('utf8').trim())))
    fail('REVIEW_NATIVE_INVALID', 'sealed current result differs from original completed native bytes');
  return original;
}

function authenticateCurrentCoverage({ trusted, result, evidence, identity, retained }) {
  const runtime = trusted.receipt.runtime_evidence;
  const context = require('./codex-arch-review-context.cjs');
  if (trusted.receipt.runtime !== 'codex' || runtime?.input_transport !== 'host-files') {
    if (result.coverage !== undefined || result.reviewed_identity !== undefined)
      return authenticateInlineCoverage({ trusted, result, evidence, identity });
    return null;
  }
  const checked = context.verifyFileInput(runtime.input_bundle, { sealed: true, historical: true,
    association: { role: trusted.receipt.role, dispatch_id: runtime.review_continuation?.original_dispatch_id || trusted.dispatchId } });
  if (checked.material.length !== 1) {
    if (result.coverage !== undefined) fail('REVIEW_COVERAGE_INVALID', 'unsupported coverage material inventory');
    return null;
  }
  const packet = require('./context-packet.cjs').decodeUniqueContent(JSON.parse(checked.material[0]));
  const coverage = packet.review_coverage || packet.role_context?.review_coverage;
  const contract = checked.manifest.binding?.review_contract;
  const expectedContract = trusted.receipt.role === 'arch-review' ? 'shipyard.architecture-review.v2' : 'shipyard.integration-review.v2';
  if (!coverage) {
    const legacyContract = trusted.receipt.role === 'arch-review' ? 'shipyard.architecture-review.v1' : 'shipyard.integration-review.v1';
    if (result.coverage !== undefined || result.reviewed_identity !== undefined || contract !== undefined && contract !== legacyContract)
      fail('REVIEW_COVERAGE_INVALID', 'declared current contract lacks complete coverage');
    return null;
  }
  if (contract !== expectedContract || coverage.schema !== 'shipyard.review-coverage-lineage.v1'
      || (packet.review_coverage !== undefined && packet.role_context?.review_coverage !== undefined))
    fail('REVIEW_COVERAGE_INVALID', 'unsupported declared current coverage contract');
  context.verifyFileInput(runtime.input_bundle, { sealed: true });
  retained ||= currentReviewRetention(identity.worktree, trusted);
  const original = originalCurrentResponse(trusted, result, evidence, retained);
  if (runtime.input_consumption?.manifest_sha256 !== runtime.input_bundle.manifest_sha256
      || runtime.input_consumption?.chunk_reads !== checked.chunk_reads
      || original.input_manifest_sha256 !== runtime.input_bundle.manifest_sha256
      || original.input_chunk_reads !== checked.chunk_reads || original.input_material_bytes !== runtime.input_bundle.total_bytes
      || original.input_asset_count !== runtime.input_bundle.asset_count
      || original.context_digest !== checked.manifest.binding.packet_digest)
    fail('REVIEW_COVERAGE_INVALID', 'fresh complete native consumption differs from declared current packet');
  const sourceBundle = checked.manifest.binding.original_input_bundle;
  const source = context.verifyFileInput(sourceBundle, { sealed: true,
    association: { role: trusted.receipt.role, dispatch_id: checked.manifest.dispatch_id } });
  const originalPacket = require('./context-packet.cjs').decodeUniqueContent(JSON.parse(source.material[0]));
  const input = { input_bundle: sourceBundle };
  const subject = reviewIdentityFromChecked(sourceBundle, source);
  if (stable(subject) !== stable(coverage.current) || subject.repository !== identity.repository.identity
      || subject.worktree !== identity.worktree || subject.head !== identity.head || subject.head_tree !== identity.head_tree
      || subject.base !== identity.base_commit || subject.merge_base !== identity.merge_base
      || subject.role !== trusted.receipt.role || subject.policy_hash !== trusted.receipt.policy_hash
      || source.manifest.binding.agent_sha256 !== trusted.receipt.agent_file_digest
      || stable(source.manifest.snapshot.sources) !== stable(checked.manifest.snapshot.sources)
      || stable(source.manifest.binding.installed_files) !== stable(checked.manifest.binding.installed_files)
      || source.material.length !== 1 || coverage.original_input?.manifest_sha256 !== sourceBundle.manifest_sha256
      || coverage.original_input?.packet_digest !== source.manifest.binding.packet_digest
      || (originalPacket.schema === context.SCHEMA ? originalPacket.pr?.head : originalPacket.source_revision) !== subject.head
      || (originalPacket.schema === context.SCHEMA ? 'arch-review' : originalPacket.role) !== subject.role
      || stable(originalPacket.ticket_set || originalPacket.role_context?.ticket_set) !== stable(result.ticket_set)
      || originalPacket.review_coverage || originalPacket.role_context?.review_coverage
      || stable(packet.refs || packet.required_refs) !== stable(originalPacket.refs || originalPacket.required_refs))
    fail('REVIEW_COVERAGE_INVALID', 'original complete input, policy or current subject differs');
  if (subject.role === 'arch-review') {
    const directory = path.dirname(source.manifest.snapshot.graph.find(pin => path.basename(pin.path) === 'tickets.json').path);
    const graph = JSON.parse(readImmutableFile(fs, path.join(directory, 'tickets.json'), 'complete current architecture graph', 8 * 1024 * 1024));
    const state = JSON.parse(readImmutableFile(fs, path.join(directory, 'delivery-state.json'), 'complete current architecture state', 8 * 1024 * 1024));
    const binding = require('./architecture-target.cjs').phaseBinding({ graph, state: state.tickets || state,
      phase: subject.phase, repository: subject.repository, repo: originalPacket.graph.binding?.repo ?? null,
      branch: originalPacket.pr.branch, pr: originalPacket.pr.number, head: subject.head, base: subject.base });
    const archives = selectPhaseArchives(subject.worktree, binding, { graphDir: directory,
      phaseArchiveSelection: originalPacket.phase_archive_selection, currentDispatchId: trusted.dispatchId });
    if (binding.subject !== subject.ticket || stable(binding.ticketSet) !== stable(result.ticket_set)
        || phaseArchitectureEvidenceDigest(archives.evidence) !== phaseArchitectureEvidenceDigest(originalPacket.retained_evidence))
      fail('REVIEW_COVERAGE_INVALID', 'whole current phase authority or retained evidence differs');
    authenticateArchitectureSources(subject.worktree, path.resolve(directory, '../..'), originalPacket.refs.filter(ref =>
      /^(?:\.planning\/architecture\/.+\.md|\.planning\/investigations\/.+\/DECISIONS\.md)$/.test(ref.path)));
  }
  admissionReviewInputs.set(input, { checked: source, identity: subject });
  let expected;
  try {
    const selection = selectReviewBaseline({ currentInput: input, excludeDispatchId: trusted.dispatchId });
    expected = rebuildReviewImpactPacket(input, selection, trusted.dispatchId);
  } finally { admissionReviewInputs.delete(input); }
  const { digest: lineageDigest, original_packet: _originalPacket, ...lineage } = expected;
  const { digest: recordedDigest, reviewed_identity: reviewed, original_input: _originalInput,
    complete_preflight: _preflight, ...declared } = coverage;
  if (stable(declared) !== stable(lineage) || recordedDigest !== lineageDigest
      || checked.manifest.binding.coverage_digest !== lineageDigest
      || stable(coverage.current_membership.ticket_set) !== stable(result.ticket_set)
      || stable(result.reviewed_identity) !== stable(reviewed)
      || reviewed.repository !== subject.repository || reviewed.worktree !== subject.worktree
      || reviewed.head !== subject.head || reviewed.head_tree !== subject.head_tree || reviewed.base !== subject.base
      || reviewed.base_tree !== identity.base_tree || reviewed.merge_base !== subject.merge_base
      || reviewed.merge_base_tree !== identity.merge_base_tree || reviewed.policy_hash !== subject.policy_hash
      || reviewed.contract !== contract || reviewed.ticket_set_digest !== subject.ticket_set_digest
      || stable(reviewed.ticket_set) !== stable(result.ticket_set)
      || stable(checked.manifest.binding.reviewed_identity) !== stable(reviewed))
    fail('REVIEW_COVERAGE_INVALID', 'complete original baseline-to-current lineage differs');
  validateCoverageResult(result.coverage, coverage, trusted.receipt.role);
  context.verifyFileInput(sourceBundle, { sealed: true });
  context.verifyFileInput(runtime.input_bundle, { sealed: true });
  return Object.freeze({ schema: 'shipyard.current-review-contract.v2', role: trusted.receipt.role,
    contract, lineage_digest: lineageDigest, mode: coverage.mode,
    original_manifest_sha256: sourceBundle.manifest_sha256, current_manifest_sha256: runtime.input_bundle.manifest_sha256 });
}

function validateCoverageResult(result, coverage, role) {
  const expected = { schema: role === 'arch-review' ? 'shipyard.architecture-coverage-result.v1' : 'shipyard.integration-coverage-result.v1',
    mode: coverage.mode, lineage_digest: coverage.digest,
    inherited_obligations: coverage.current_logical_obligations.filter(item => item.coverage === 'inherited').map(item => item.identity),
    newly_reviewed_obligations: coverage.current_logical_obligations.filter(item => item.coverage !== 'inherited').map(item => item.identity),
    impact_paths: coverage.impact.paths, limitations: coverage.limitations };
  if (stable(result) !== stable(expected)) fail('REVIEW_COVERAGE_INVALID', 'fresh native coverage result is incomplete or unsupported');
}

function authenticateInlineCoverage({ trusted, result, evidence, identity }) {
  if (trusted.receipt.runtime !== 'claude' || trusted.receipt.role !== 'integrator')
    fail('REVIEW_COVERAGE_INVALID', 'unsupported inline current review contract');
  originalCurrentResponse(trusted, result, evidence);
  const runtime = trusted.receipt.runtime_evidence;
  const pin = runtime?.selection_evidence?.transcript;
  if (!object(pin) || !path.isAbsolute(pin.path || '')) fail('REVIEW_NATIVE_REQUIRED', 'original inline semantic input is required');
  const raw = readImmutableFile(fs, pin.path, 'original inline semantic transcript', 128 * 1024 * 1024);
  if (raw.length !== pin.bytes || digest(raw) !== pin.sha256) fail('REVIEW_NATIVE_INVALID', 'original inline transcript changed');
  const packets = [];
  for (const row of raw.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)) {
    if (row.type !== 'user' || row.sessionId !== runtime.session_id) continue;
    const content = row.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block.text || '').join('') : '';
    for (const match of text.matchAll(/<AUTHENTICATED_CONTEXT_PACKET>\s*([\s\S]*?)\s*<\/AUTHENTICATED_CONTEXT_PACKET>/g))
      packets.push(require('./context-packet.cjs').decodeUniqueContent(JSON.parse(match[1])));
  }
  if (packets.length !== 1) fail('REVIEW_COVERAGE_INVALID', 'one complete original inline current packet is required');
  const packet = packets[0], coverage = packet.role_context?.review_coverage, reviewed = coverage?.reviewed_identity;
  if (coverage?.schema !== 'shipyard.review-coverage-lineage.v1' || coverage.mode !== 'full' || coverage.baseline !== null
      || coverage.inherited.length !== 0 || coverage.current_logical_obligations.some(item => item.coverage === 'inherited')
      || packet.role !== trusted.receipt.role || packet.source_revision !== identity.head
      || reviewed?.head !== identity.head || reviewed.head_tree !== identity.head_tree || reviewed.base !== identity.base_commit
      || reviewed.merge_base !== identity.merge_base || reviewed.policy_hash !== trusted.receipt.policy_hash
      || reviewed.contract !== 'shipyard.integration-review.v2' || reviewed.repository !== identity.repository.identity
      || reviewed.worktree !== identity.worktree || stable(reviewed) !== stable(result.reviewed_identity)
      || stable(packet.role_context.ticket_set) !== stable(result.ticket_set)
      || result.ticket_set_digest !== coverage.current.ticket_set_digest)
    fail('REVIEW_COVERAGE_INVALID', 'inline full current contract cannot inherit another runtime or role authority');
  require('./context-packet.cjs').validateContextPacket(packet, { root: identity.worktree, role: 'integrator',
    sourceRevision: identity.head, policyHash: trusted.receipt.policy_hash, subject: packet.subject });
  if (stable(coverage.source_inventories.current) !== stable(endpointInventory(identity.worktree, identity.head))
      || stable(coverage.source_inventories.baseline) !== stable(endpointInventory(identity.worktree, identity.merge_base))
      || stable(coverage.endpoint_delta) !== stable(endpointChanges(identity.worktree, identity.merge_base, identity.head))
      || coverage.current.head !== identity.head || coverage.current.base !== identity.base_commit
      || coverage.current.role !== 'integrator' || coverage.current.repository !== identity.repository.identity
      || stable(coverage.current_membership.ticket_set) !== stable(result.ticket_set))
    fail('REVIEW_COVERAGE_INVALID', 'complete inline current endpoint coverage differs');
  const required = packet.required_refs;
  if (!Array.isArray(required) || required.some(ref => !coverage.newly_reviewed.some(item => item.path === ref.path
      && item.sha256 === ref.sha256 && item.bytes === ref.bytes && item.content === ref.content)))
    fail('REVIEW_COVERAGE_INVALID', 'complete inline full material is missing from newly reviewed coverage');
  validateCoverageResult(result.coverage, coverage, 'integrator');
  return Object.freeze({ schema: 'shipyard.current-review-contract.v2', role: 'integrator',
    contract: reviewed.contract, lineage_digest: coverage.digest, mode: 'full', inline_native_sha256: pin.sha256 });
}

function currentReviewRetention(worktree, trusted) {
  const original = originalReviewRetention(worktree, trusted);
  if (original) return original;
  if (trusted.receipt.runtime_evidence?.review_continuation) {
    const progress = validateReviewContinuationEvidence(trusted.receipt.runtime_evidence);
    const native = trusted.receipt.runtime_evidence.native_session_evidence;
    return { schema: 'shipyard.current-review-authority.v2', receipt_store: trusted.recorder.storeDir,
      native: { path: progress.native_file, bytes: native.bytes, sha256: native.sha256 } };
  }
  const runtime = trusted.receipt.runtime_evidence;
  if (trusted.receipt.runtime === 'codex' && runtime?.input_transport === 'host-files' && runtime.native_child_evidence) {
    const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
    const files = require('./codex-runtime-host.cjs').nativeSessionCandidates(path.join(home, 'sessions'), runtime.native_session_evidence.session_id);
    if (files.length !== 1) return null;
    const content = readImmutableFile(fs, files[0], 'original typed current reviewer', 128 * 1024 * 1024);
    if (digest(content) !== runtime.native_session_evidence.sha256 || content.length !== runtime.native_session_evidence.bytes) return null;
    return { schema: 'shipyard.current-review-authority.v2', receipt_store: trusted.recorder.storeDir,
      native: { path: files[0], bytes: content.length, sha256: digest(content) } };
  }
  return null;
}

function authenticatedCurrentArchive(worktree, record, manifest, findings, identity) {
  const retention = record.review_current || record.review_baseline;
  const trusted = retention?.receipt_store
    ? trustedRecord({ dispatchId: record.dispatch_id, boundaryStore: retention.receipt_store })
    : { dispatchId: record.dispatch_id, receipt: record.receipt, record: { ...record, ticket: manifest.boundary_subject } };
  if (stable(trusted.receipt) !== stable(record.receipt) || record.receipt.role !== manifest.role
      || record.receipt.policy_hash !== require('./model-policy.cjs').POLICY_HASH)
    fail('REVIEW_COVERAGE_INVALID', 'original current catalogue role or policy differs');
  const verification = phaseSelectionVerification();
  selectedArchiveRecord({ identity: { repository: identity.repository.identity }, verification }, {
    worktree, dispatch_id: record.dispatch_id, ticket: manifest.boundary_subject,
    receipt: record.receipt, pins: record.pins,
  }, retention?.receipt_store ? trusted : undefined);
  verification.finish();
  const metadata = { ...trustedMetadata({ role: manifest.role }, trusted, identity), trusted };
  const data = judgmentResultData(findings, metadata, { phase: manifest.phase || findings.phase,
    ticketSet: manifest.current_review && manifest.role === 'integrator'
      ? canonicalTicketSet(findings.ticket_set, 'original current integration records') : findings.ticket_set,
    ticketSetDigest: manifest.ticket_set_digest, pr: manifest.pr, base: manifest.base }, identity);
  const evidence = readPinnedArchiveFile(worktree, manifest.files.evidence, 'complete original current evidence');
  const findingBytes = readPinnedArchiveFile(worktree, manifest.files.findings, 'complete original current findings');
  if (manifest.subject !== data.subject || manifest.boundary_subject !== metadata.ticket
      || stable(manifest.reviewed) !== stable(data.reviewed)
      || stable(manifest.envelope) !== stable(judgmentEnvelope(data, {
        evidence: { relative: manifest.files.evidence.path, content: evidence },
        findings: { relative: manifest.files.findings.path, content: findingBytes } })))
    fail('REVIEW_COVERAGE_INVALID', 'original complete current judgment envelope differs');
  const contract = authenticateCurrentCoverage({ trusted, result: findings, evidence, identity, retained: retention });
  if (stable(contract) !== stable(manifest.current_review || null))
    fail('REVIEW_COVERAGE_INVALID', 'declared original current contract differs');
  if (!contract && manifest.role === 'integrator' && record.receipt.runtime === 'codex') {
    if (record.receipt.runtime_evidence?.input_transport === 'host-files' && retention?.native)
      require('./codex-arch-review-context.cjs').validateOriginalReviewContext({ receipt: record.receipt,
        dispatchId: record.dispatch_id, result: findings, evidence, nativePin: retention.native });
    else {
      const pin = record.receipt.runtime_evidence?.transcript;
      if (!pin) fail('REVIEW_NATIVE_REQUIRED', 'original full integration evidence is missing');
      const bytes = readImmutableFile(fs, pin.path, 'original full integration result', 128 * 1024 * 1024);
      if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) fail('REVIEW_NATIVE_INVALID', 'original integration stream changed');
      const parsed = require('./codex-runtime-host.cjs').parseCodexStream(bytes.toString('utf8'));
      const messages = parsed.records.filter(row => row.type === 'item.completed' && row.item?.type === 'agent_message');
      if (messages.length !== 1 || parsed.session_id !== record.receipt.runtime_evidence.session_id)
        fail('REVIEW_NATIVE_INVALID', 'original full integration completion differs');
      const { evidence_markdown: markdown, host_context: _context, ...original } = JSON.parse(messages[0].item.text);
      const { host_context: _sealed, ...sealed } = findings;
      if (stable(original) !== stable(sealed) || markdown?.trim() !== evidence.toString('utf8').trim())
        fail('REVIEW_NATIVE_INVALID', 'original full integration contract differs');
    }
  }
  if (!contract && record.receipt.runtime === 'claude') originalCurrentResponse(trusted, findings, evidence);
  return contract;
}

function exactCurrentGitSubject(root, branch, head, baseName, baseCommit) {
  if (typeof branch !== 'string' || typeof baseName !== 'string'
      || !/^[A-Za-z0-9._/-]+$/.test(branch) || !/^[A-Za-z0-9._/-]+$/.test(baseName)
      || branch.includes('..') || baseName.includes('..') || branch.startsWith('-') || baseName.startsWith('-')) return false;
  try {
    const local = gitCommitIfPresent({}, root, 'refs/heads/' + branch);
    const remote = gitCommitIfPresent({}, root, 'refs/remotes/origin/' + branch);
    return (local || remote) === head && (!local || local === head) && (!remote || remote === head)
      && gitCommitIfPresent({}, root, 'refs/remotes/origin/' + baseName) === baseCommit;
  } catch { return false; }
}

function currentIntegrationVerdict({ worktreePath, head, baseName, baseCommit, graphDir, headBranch, repo = null }) {
  const root = fs.realpathSync(worktreePath);
  const common = fs.realpathSync(reviewGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const directory = graphDir || path.join(root, '.planning/graph');
  if (path.basename(directory) !== 'graph' || path.basename(path.dirname(directory)) !== '.planning'
      || fs.realpathSync(directory) !== path.resolve(directory)
      || fs.realpathSync(reviewGit(path.resolve(directory, '../..'), ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== common)
    fail('REVIEW_COVERAGE_INVALID', 'current integration graph belongs to another repository');
  const graph = JSON.parse(readImmutableFile(fs, path.join(directory, 'tickets.json'), 'current complete graph', 8 * 1024 * 1024));
  const phases = new Set(Object.values(graph.tickets || {}).filter(row => row.epic === headBranch && (row.repo ?? null) === repo)
    .map(row => Number(String(row.phase).split('-')[0])));
  if (phases.size !== 1) return null;
  if (!exactCurrentGitSubject(root, headBranch, head, baseName, baseCommit)) return null;
  const phase = [...phases][0], rows = require('./architecture-target.cjs').phaseRows(graph, phase, repo);
  const ids = rows.map(([id]) => id);
  let current = null, count = 0, catalogueBytes = 0;
  const candidates = registeredPhaseWorktrees(root);
  if (candidates.length > 1000) fail('REVIEW_COVERAGE_INVALID', 'current integration worktrees exceed their bound');
  for (const candidate of candidates) {
    const worktree = fs.realpathSync(candidate);
    if (!fs.existsSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json'))) continue;
    catalogueBytes += fs.lstatSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json')).size;
    if (catalogueBytes > 16 * 1024 * 1024) fail('REVIEW_COVERAGE_INVALID', 'current integration catalogues exceed their bound');
    const state = authorityState(worktree);
    for (const record of Object.values(state.payload.records)) {
      if (record.receipt?.role !== 'integrator') continue;
      if (++count > 1000) fail('REVIEW_COVERAGE_INVALID', 'current integration discovery exceeds its bound');
      const pin = record.pins.find(pin => pin.path.endsWith('/' + MANIFEST_NAME));
      const manifest = JSON.parse(readPinnedArchiveFile(worktree, pin, 'current integration manifest'));
      if (manifest.role !== 'integrator' || manifest.head !== head || manifest.base_commit !== baseCommit
          || manifest.repository_identity !== common || manifest.envelope?.outcome !== 'passed'
          || manifest.base.replace(/^(?:refs\/remotes\/origin\/|origin\/)/, '') !== baseName) continue;
      try {
        const findings = JSON.parse(readPinnedArchiveFile(worktree, manifest.files.findings, 'current integration findings'));
        if (stable(canonicalTicketSet(findings.ticket_set, 'complete integration membership').map(member => member.id)) !== stable(ids)) continue;
        const identity = { worktree, repository: { root: manifest.repository_realpath, identity: common },
          head, head_tree: reviewGit(root, ['rev-parse', head + '^{tree}']), base: manifest.base, base_commit: baseCommit,
          base_tree: reviewGit(root, ['rev-parse', baseCommit + '^{tree}']),
          merge_base: reviewGit(root, ['merge-base', baseCommit, head]), merge_base_tree: manifest.merge_base_tree };
        if (reviewGit(root, ['rev-parse', identity.merge_base + '^{tree}']) !== identity.merge_base_tree) continue;
        const contract = authenticatedCurrentArchive(worktree, record, manifest, findings, identity);
        const runtime = record.receipt.runtime_evidence;
        if (runtime?.input_bundle) {
          const checked = require('./codex-arch-review-context.cjs').verifyFileInput(runtime.input_bundle, { sealed: true, historical: true });
          for (const graphPin of checked.manifest.snapshot.graph) {
            const live = path.join(directory, path.basename(graphPin.path));
            if (digest(readImmutableFile(fs, live, 'current whole-phase membership', 8 * 1024 * 1024)) !== graphPin.sha256)
              fail('REVIEW_COVERAGE_INVALID', 'complete current membership differs from original review');
          }
          const packet = require('./context-packet.cjs').decodeUniqueContent(JSON.parse(checked.material[0]));
          const proof = packet.role_context?.review_coverage?.complete_preflight || checked.manifest.binding?.preflight;
          if (proof) {
            if (require('./phase-integrator-preflight.cjs').proofDigest(proof) !== proof.proof_digest
                || proof.epic.commit !== head || proof.epic.branch !== headBranch
                || proof.graph.digest !== digest(readImmutableFile(fs, path.join(directory, 'tickets.json'), 'current graph', 8 * 1024 * 1024))
                || stable(proof.merges.map(member => member.id).sort()) !== stable(ids))
              fail('REVIEW_COVERAGE_INVALID', 'complete original merge ancestry differs');
            for (const member of proof.merges) reviewGit(root, ['merge-base', '--is-ancestor', member.merge_commit, head]);
          } else for (const member of findings.ticket_set) reviewGit(root, ['merge-base', '--is-ancestor', member.head, head]);
        } else for (const member of findings.ticket_set) reviewGit(root, ['merge-base', '--is-ancestor', member.head, head]);
        if (reviewGit(root, ['rev-parse', 'refs/remotes/origin/' + baseName + '^{commit}']) !== baseCommit) continue;
        current = Object.freeze({ authenticated: true, role: 'integrator', outcome: 'passed', head, base: baseName,
          base_commit: baseCommit, subject: manifest.subject, ticket_set_digest: manifest.ticket_set_digest,
          dispatch_id: record.dispatch_id, contract: contract?.contract || 'shipyard.integration-review.v1' });
      } catch { continue; }
    }
  }
  return exactCurrentGitSubject(root, headBranch, head, baseName, baseCommit) ? current : null;
}

function currentArchitectureVerdict({ worktreePath, pr, head, baseName, baseCommit, graphDir, headBranch, repo: requestedRepo }) {
  const root = fs.realpathSync(worktreePath);
  const common = fs.realpathSync(execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
  const directory = graphDir || path.join(root, '.planning/graph');
  let targetGraph;
  try { targetGraph = JSON.parse(fs.readFileSync(path.join(directory, 'tickets.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const targetBranch = headBranch || execFileSync('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!exactCurrentGitSubject(root, targetBranch, head, baseName, baseCommit)) return null;
  const aggregateRequired = Object.values(targetGraph?.tickets || {}).some(row => row.epic === targetBranch);
  let selected = null;
  if (aggregateRequired) {
    selected = [];
    if (path.basename(directory) !== 'graph' || path.basename(path.dirname(directory)) !== '.planning'
        || fs.realpathSync(directory) !== path.resolve(directory))
      fail('ARCHIVE_AUTHORITY_INVALID', 'canonical phase graph directory is required');
    const project = fs.realpathSync(path.resolve(directory, '../..'));
    if (fs.realpathSync(execFileSync('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()) !== common)
      fail('ARCHIVE_AUTHORITY_INVALID', 'phase graph belongs to another repository');
    const currentEpics = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
      .split('\n\n').map(block => Object.fromEntries(block.split('\n').map(line => {
        const separator = line.indexOf(' ');
        return separator < 0 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
      }))).filter(row => row.branch === 'refs/heads/' + targetBranch && row.HEAD === head && !row.prunable);
    if (currentEpics.length > 1000) fail('ARCHIVE_AUTHORITY_INVALID', 'selected current epic checkouts exceed their total bound');
    const candidates = new Set([root, project]);
    for (const row of currentEpics) {
      const checkout = fs.realpathSync(row.worktree);
      if (checkout !== path.resolve(row.worktree)) fail('ARCHIVE_AUTHORITY_INVALID', 'current epic checkout is not canonical');
      const actualCommon = fs.realpathSync(execFileSync('git', ['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
      const actualHead = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const actualBranch = execFileSync('git', ['-C', checkout, 'symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).trim();
      if (actualCommon !== common || actualHead !== head || actualBranch !== 'refs/heads/' + targetBranch)
        fail('ARCHIVE_AUTHORITY_INVALID', 'current epic checkout identity changed');
      candidates.add(checkout);
    }
    for (const worktree of candidates) {
      if (!fs.existsSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json'))) continue;
      for (const record of Object.values(authorityState(worktree).payload.records)) {
        if (record.receipt?.role !== 'arch-review') continue;
        const subject = require('./architecture-target.cjs').PHASE_SUBJECT.exec(authenticatedRecordSubject(record));
        if (!subject || subject[2] !== common || Number(subject[4]) !== pr || subject[5] !== head || subject[6] !== baseCommit) continue;
        if (selected.length >= 1000) fail('ARCHIVE_AUTHORITY_INVALID', 'selected phase judgments exceed their total bound');
        selected.push({ worktree, record });
      }
    }
  }
  let current = null;
  const worktrees = selected ? [...new Set(selected.map(row => row.worktree))] : registeredPhaseWorktrees(root);
  for (const worktree of worktrees) {
    let records;
    if (aggregateRequired) {
      records = selected.filter(row => row.worktree === worktree).map(row => row.record);
    }
    else {
      const pins = authenticatedArchivePins(worktree);
      if (!pins.length) continue;
      records = Object.values(authorityState(worktree).payload.records);
    }
    for (const record of records) {
      if (record.receipt.role !== 'arch-review') continue;
      const pin = record.pins.find(pin => pin.path.endsWith('/' + MANIFEST_NAME));
      const manifest = JSON.parse(readPinnedArchiveFile(worktree, pin, 'architecture manifest'));
      if (aggregateRequired && manifest.boundary_subject !== authenticatedRecordSubject(record))
        fail('ARCHIVE_AUTHORITY_INVALID', 'aggregate candidate manifest subject differs');
      if (manifest.role !== 'arch-review' || manifest.artifact_kind !== 'judgment'
          || manifest.producer_dispatch !== record.dispatch_id || manifest.repository_identity !== common
          || manifest.pr !== pr || manifest.head !== head || manifest.base_commit !== baseCommit
          || manifest.base.replace(/^(?:refs\/remotes\/origin\/|origin\/)/, '') !== baseName
          || manifest.envelope?.verdict !== 'conform') continue;
      const findings = JSON.parse(readPinnedArchiveFile(worktree, manifest.files.findings, 'architecture findings'));
      if (findings.id !== manifest.boundary_subject || findings.pr !== pr || findings.head !== head
          || findings.base_tree !== manifest.merge_base_tree || findings.verdict !== 'conform') continue;
      if (manifest.boundary_subject.startsWith('phase=')) {
        if (!manifest.current_review && !object(findings.host_context?.phase_archive_selection))
          fail('ARCHIVE_AUTHORITY_INVALID', 'aggregate verdict lacks its frozen current phase selection');
        const directory = graphDir || findings.host_context?.graph_dir || path.join(root, '.planning/graph');
        const graph = JSON.parse(fs.readFileSync(path.join(directory, 'tickets.json'), 'utf8'));
        const raw = JSON.parse(fs.readFileSync(path.join(directory, 'delivery-state.json'), 'utf8'));
        const aggregate = require('./architecture-target.cjs').PHASE_SUBJECT.exec(manifest.boundary_subject);
        if (!aggregate) continue;
        const branch = headBranch || execFileSync('git', ['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        const repo = requestedRepo ?? findings.host_context?.phase_repo ?? null;
        if (requestedRepo !== undefined && requestedRepo !== repo) continue;
        const phases = new Set(Object.values(graph.tickets || {}).filter(row =>
          (row.repo ?? null) === repo && row.epic === branch).map(row => Number(String(row.phase).match(/^0*(\d+)/)?.[1])));
        if (phases.size !== 1 || !phases.has(Number(aggregate[1].split('-')[0])))
          fail('ARCHIVE_AUTHORITY_INVALID', 'aggregate verdict requires one current phase');
        const binding = require('./architecture-target.cjs').phaseBinding({ graph, state: raw.tickets || raw,
          phase: [...phases][0], repository: common, repo, branch, pr, head, base: baseCommit });
        if (binding.subject !== manifest.boundary_subject
            || (!manifest.current_review && findings.host_context?.phase_evidence_digest !== phaseArchitectureEvidenceDigest(phaseArchitectureEvidence(root, binding, { graphDir: directory,
              phaseArchiveSelection: findings.host_context?.phase_archive_selection })))) continue;
      }
      try {
        if (findings.host_context?.selected_refs) {
          const project = findings.host_context.source_root || path.resolve(findings.host_context.graph_dir || graphDir || path.join(root, '.planning/graph'), '../..');
          const architectureRefs = [];
          for (const source of findings.host_context.selected_refs) {
            if (source.path === '.planning/graph/delivery-state.json') continue;
            const content = readPinnedArchiveFile(project, source, 'current architecture context source').toString('utf8');
            if (/^(?:\.planning\/architecture\/.+\.md|\.planning\/investigations\/.+\/DECISIONS\.md)$/.test(source.path)) architectureRefs.push({ ...source, content });
          }
          if (architectureRefs.length) authenticateArchitectureSources(worktree, project, architectureRefs);
        }
        const identity = { worktree, repository: { root: manifest.repository_realpath, identity: common },
          head, head_tree: reviewGit(root, ['rev-parse', head + '^{tree}']), base: manifest.base, base_commit: baseCommit,
          base_tree: reviewGit(root, ['rev-parse', baseCommit + '^{tree}']), merge_base: reviewGit(root, ['merge-base', baseCommit, head]),
          merge_base_tree: manifest.merge_base_tree };
        if (reviewGit(root, ['rev-parse', identity.merge_base + '^{tree}']) !== identity.merge_base_tree) continue;
        authenticatedCurrentArchive(worktree, record, manifest, findings, identity);
        if (record.receipt.runtime === 'codex' && !manifest.current_review) require('./codex-arch-review-context.cjs').validateHistoricalContext({
          result: findings, receipt: record.receipt, dispatchId: record.dispatch_id,
          evidence: readPinnedArchiveFile(worktree, manifest.files.evidence, 'architecture evidence') });
      } catch { continue; }
      if (current && current.subject !== manifest.boundary_subject)
        fail('ARCHIVE_AUTHORITY_INVALID', 'aggregate verdict has ambiguous current repository selection');
      current = Object.freeze({ authenticated: true, verdict: 'conform', pr, head, base: baseName,
        base_commit: baseCommit, subject: manifest.boundary_subject, dispatch_id: record.dispatch_id });
      if (!aggregateRequired) return exactCurrentGitSubject(root, targetBranch, head, baseName, baseCommit) ? current : null;
    }
  }
  return exactCurrentGitSubject(root, targetBranch, head, baseName, baseCommit) ? current : null;
}

function assertArchiveInventory(worktreePath, pins) {
  const worktree = fs.realpathSync(worktreePath);
  if (!Array.isArray(pins) || new Set(pins.map(pin => pin.path)).size !== pins.length)
    fail('ARCHIVE_AUTHORITY_INVALID', 'complete archive inventory pins are malformed');
  const expected = pins.map(pin => pin.path).sort();
  if (stable(archiveInventory(worktree)) !== stable(expected))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive membership differs from authenticated complete inventory');
  for (const pin of pins) readPinnedArchiveFile(worktree, pin, 'authenticated complete archive');
  if (stable(archiveInventory(worktree)) !== stable(expected))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive membership changed while authenticating');
}

function historicalBookkeepingPins(worktreePath) {
  const worktree = fs.realpathSync(worktreePath);
  if (!fs.existsSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json'))) return [];
  const { payload } = authorityState(worktree), pins = [];
  if (Array.isArray(payload.bookkeeping_state)) return payload.bookkeeping_state.map(pin => ({ ...pin }));
  for (const record of Object.values(payload.records)) {
    for (const pin of record.bookkeeping || []) {
      if (pin.path === '.planning/graph/provenance/' + record.dispatch_id + '.json') pins.push(pin);
      else if (pin.path !== '.planning/graph/dispatches.json')
        fail('ARCHIVE_AUTHORITY_INVALID', 'historical bookkeeping path is invalid');
    }
  }
  const store = (payload.latest_bookkeeping || []).find(pin => pin.path === '.planning/graph/dispatches.json');
  if (store) pins.push({ ...store, sha256: store.cleared_sha256 });
  return pins;
}

function writeArchiveCatalogue(state) {
  const envelope = { payload: state.payload,
    mac: crypto.createHmac('sha256', state.key).update(stable(state.payload)).digest('hex') };
  const serialized = JSON.stringify(envelope) + '\n';
  if (Buffer.byteLength(serialized) > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARCHIVE_AUTHORITY_INVALID', 'complete archive catalogue exceeds its bound');
  const temporary = state.file + '.' + crypto.randomUUID() + '.tmp';
  try {
    assertArchiveLock(state.payload.worktree);
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    assertArchiveLock(state.payload.worktree);
    fs.renameSync(temporary, state.file);
  } finally { try { assertArchiveLock(state.payload.worktree); fs.unlinkSync(temporary); } catch {} }
}
function trustedBookkeepingMutation(worktreePath, fn, writtenPaths = ['.planning/graph/dispatches.json']) {
  const worktree = fs.realpathSync(worktreePath);
  const allowed = relative => relative === '.planning/graph/dispatches.json'
    || /^\.planning\/graph\/provenance\/[A-Za-z0-9_.-]+\.json$/.test(relative);
  if (!Array.isArray(writtenPaths) || writtenPaths.some(relative => !allowed(relative)))
    fail('ARCHIVE_AUTHORITY_INVALID', 'trusted writer paths are malformed');
  return withArchiveAuthorityLock(worktree, () => {
    const state = authorityState(worktree, true);
    const previous = historicalBookkeepingPins(worktree);
    const validatedPrevious = [];
    const provenance = fixedPath(worktree, '.planning/graph/provenance', 'host bookkeeping directory');
    const inventory = () => {
      if (!fs.existsSync(provenance)) return [];
      const stat = fs.lstatSync(provenance);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ARCHIVE_AUTHORITY_INVALID', 'host bookkeeping directory is not physical');
      return fs.readdirSync(provenance).map(name => '.planning/graph/provenance/' + name).sort();
    };
    const authenticatedPaths = previous.map(pin => pin.path);
    if (inventory().some(relative => !authenticatedPaths.includes(relative)))
      fail('ARCHIVE_AUTHORITY_INVALID', 'unknown host provenance member before trusted mutation');
    for (const pin of previous) {
      const legacy = !state.payload.bookkeeping_state && (state.payload.latest_bookkeeping || []).find(item => item.path === pin.path);
      let actual = pin;
      if (!Number.isSafeInteger(pin.bytes)) {
        const file = fixedPath(worktree, pin.path, 'authenticated bookkeeping');
        actual = { ...pin, bytes: fs.lstatSync(file).size };
      }
      if (legacy) {
        const file = fixedPath(worktree, pin.path, 'authenticated bookkeeping');
        const stat = fs.lstatSync(file);
        const content = readImmutableFile(fs, file, 'authenticated bookkeeping', HISTORICAL_ARCHIVE_MAX_BYTES, stat.size);
        const current = digest(content);
        if (current !== legacy.sha256 && current !== legacy.cleared_sha256)
          fail('ARCHIVE_AUTHORITY_INVALID', 'authenticated legacy bookkeeping changed before trusted mutation');
        actual = { ...pin, sha256: current, bytes: content.length };
      }
      readPinnedArchiveFile(worktree, actual, 'authenticated historical bookkeeping');
      validatedPrevious.push(actual);
    }
    assertArchiveLock(worktree);
    const result = fn();
    assertArchiveLock(worktree);
    for (const pin of validatedPrevious) {
      if (!writtenPaths.includes(pin.path))
        readPinnedArchiveFile(worktree, pin, 'undeclared authenticated bookkeeping');
    }
    const paths = [...new Set([...authenticatedPaths, ...writtenPaths])].sort();
    if (inventory().some(relative => !paths.includes(relative)))
      fail('ARCHIVE_AUTHORITY_INVALID', 'trusted mutation published an undeclared provenance member');
    state.payload.bookkeeping_state = paths.filter(relative =>
      validatedPrevious.some(pin => pin.path === relative && !writtenPaths.includes(relative))
      || fs.existsSync(fixedPath(worktree, relative, 'host bookkeeping')))
      .map(relative => {
        const retained = validatedPrevious.find(pin => pin.path === relative);
        if (retained && !writtenPaths.includes(relative)) return { ...retained };
        const file = fixedPath(worktree, relative, 'host bookkeeping');
        const stat = fs.lstatSync(file);
        const content = readImmutableFile(fs, file, 'host bookkeeping', HISTORICAL_ARCHIVE_MAX_BYTES, stat.size);
        return { path: relative, bytes: content.length, sha256: digest(content) };
      });
    writeArchiveCatalogue(state);
    return result;
  });
}

const archivePublicationFrames = [];
function withArchiveAuthorityLock(worktree, fn) {
  const active = archivePublicationFrames.at(-1);
  if (active?.worktree === worktree) { assertArchiveLock(worktree); return fn(); }
  const state = authorityState(worktree, true);
  const lockPath = path.join(state.directory, 'catalogue.lock');
  if (fs.existsSync(lockPath)) {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock is not a physical directory');
    let owner;
    try { owner = JSON.parse(readImmutableFile(fs, path.join(lockPath, 'owner.json'), 'archive catalogue lock owner', 4096)); } catch {}
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      let live = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
      if (live) fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock has a live owner');
    }
  }
  let lock;
  try { lock = acquire(state.directory, 'catalogue', { waitMs: 1000, label: 'role-archive-authority' }); }
  catch (error) { fail('ARCHIVE_AUTHORITY_BUSY', error.message); }
  if (!lock) fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock acquisition timed out');
  const frame = { worktree, lockOnly: true, lock };
  archivePublicationFrames.push(frame);
  try { assertArchiveLock(worktree); return fn(); } finally { archivePublicationFrames.pop(); lock.release(); }
}
function assertArchiveLock(worktree) {
  const frame = [...archivePublicationFrames].reverse().find(item => item.worktree === worktree && item.lock);
  let owner;
  try {
    const stat = fs.lstatSync(frame.lock.path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('lock is not physical');
    owner = JSON.parse(readImmutableFile(fs, path.join(frame.lock.path, 'owner.json'), 'archive catalogue lock owner', 4096));
  } catch { fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock ownership was lost'); }
  if (!frame?.lock.owner.token || owner?.token !== frame.lock.owner.token)
    fail('ARCHIVE_AUTHORITY_BUSY', 'archive catalogue lock ownership was lost');
}

function withArchivePublication(worktree, fn) {
  return withArchiveAuthorityLock(worktree, () => {
    const inherited = [...archivePublicationFrames].reverse().find(item => item.worktree === worktree && item.lock);
    const frame = { worktree, lock: inherited.lock, created: [], directories: [] };
    archivePublicationFrames.push(frame);
    try { return fn(); }
    catch (error) {
      for (const member of frame.created.reverse()) {
        try { const stat = fs.lstatSync(member.path);
          if (stat.dev === member.dev && stat.ino === member.ino) { assertArchiveLock(worktree); fs.unlinkSync(member.path); }
        } catch {}
      }
      for (const directory of frame.directories.reverse()) {
        try { const stat = fs.lstatSync(directory.path);
          if (stat.dev === directory.dev && stat.ino === directory.ino) { assertArchiveLock(worktree); fs.rmdirSync(directory.path); }
        } catch {}
      }
      throw error;
    } finally { archivePublicationFrames.pop(); }
  });
}

function preflightArchiveCatalogue(worktree, trusted, manifestPath, manifest, manifestBytes, findingsBytes) {
  if (manifestBytes.length > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARTIFACT_WRITE', 'complete archive manifest exceeds its complete-byte bound');
  const pins = [{ path: path.relative(worktree, manifestPath), sha256: digest(manifestBytes), bytes: manifestBytes.length },
    ...[manifest.files.evidence, manifest.files.findings].map(pin => ({ path: pin.path, sha256: pin.sha256, bytes: pin.bytes }))];
  if (pins.some(pin => pin.bytes > HISTORICAL_ARCHIVE_MAX_BYTES))
    fail('ARTIFACT_WRITE', 'complete archive member exceeds its complete-byte bound');
  const state = authorityState(worktree, true);
  const record = { dispatch_id: trusted.dispatchId, receipt: trusted.receipt, pins,
    bookkeeping: trusted.receipt.role === 'arch-review' ? JSON.parse(findingsBytes).host_context?.bookkeeping || [] : [] };
  const candidate = { ...state.payload, records: { ...state.payload.records, [trusted.dispatchId]: record },
    ...(record.bookkeeping.length ? { latest_bookkeeping: record.bookkeeping } : {}) };
  const envelope = { payload: candidate, mac: crypto.createHmac('sha256', state.key).update(stable(candidate)).digest('hex') };
  if (Buffer.byteLength(JSON.stringify(envelope) + '\n') > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARCHIVE_AUTHORITY_INVALID', 'complete archive catalogue exceeds its bound before publication');
}

function retainArchiveAuthority(worktree, trusted, manifestPath, manifestDigest) {
  const manifestBytes = readPinnedArchiveFile(worktree, { path: path.relative(worktree, manifestPath),
    sha256: manifestDigest, bytes: fs.lstatSync(manifestPath).size }, 'validated archive manifest');
  if (digest(manifestBytes) !== manifestDigest) fail('ARCHIVE_AUTHORITY_INVALID', 'validated archive changed before retention');
  const manifest = JSON.parse(manifestBytes);
  const pins = [{ path: path.relative(worktree, manifestPath), sha256: manifestDigest, bytes: manifestBytes.length }];
  for (const reference of [manifest.files.evidence, manifest.files.findings]) {
    const content = readPinnedArchiveFile(worktree, reference, 'validated archive');
    if (digest(content) !== reference.sha256 || content.length !== reference.bytes)
      fail('ARCHIVE_AUTHORITY_INVALID', 'validated complete archive changed before retention');
    pins.push({ path: reference.path, sha256: reference.sha256, bytes: reference.bytes });
  }
  return withArchiveAuthorityLock(worktree, () => {
  const state = authorityState(worktree, true);
  const findings = JSON.parse(readPinnedArchiveFile(worktree, manifest.files.findings, 'validated findings'));
  const bookkeeping = trusted.receipt.role === 'arch-review' ? findings.host_context?.bookkeeping || [] : [];
  const record = { dispatch_id: trusted.dispatchId, receipt: trusted.receipt, pins, bookkeeping,
    ...(require('./architecture-target.cjs').PHASE_SUBJECT.test(manifest.boundary_subject || '')
      ? { ticket: reconciledRecordTicket(trusted) } : {}) };
  const previous = state.payload.records[trusted.dispatchId];
  if (manifest.current_review) {
    const retention = previous?.review_current || currentReviewRetention(worktree, trusted);
    if (trusted.receipt.runtime === 'codex' && !retention)
      fail('REVIEW_NATIVE_REQUIRED', 'current native retention is unavailable');
    record.review_current = retention || { schema: 'shipyard.current-review-authority.v2', receipt_store: trusted.recorder.storeDir };
  }
  if (previous?.review_baseline) record.review_baseline = previous.review_baseline;
  else if (!previous) {
    const retention = originalReviewRetention(worktree, trusted);
    if (retention) {
      const last = Math.max(0, ...Object.values(state.payload.records).map(item => Date.parse(item.review_baseline?.finalized_at) || 0));
      retention.finalized_at = new Date(Math.max(Date.parse(retention.finalized_at), last + 1)).toISOString();
      record.review_baseline = retention;
    }
  }
  if (bookkeeping.length) state.payload.latest_bookkeeping = bookkeeping;
  if (state.payload.records[trusted.dispatchId]
      && stable(state.payload.records[trusted.dispatchId]) !== stable(record))
    fail('ARCHIVE_AUTHORITY_INVALID', 'archive retention cannot replace authenticated historical bytes');
  state.payload.records[trusted.dispatchId] = record;
  writeArchiveCatalogue(state);
  });
}

function validateHistoricalArchive(input, defer = false) {
  if (!object(input) || !/^[a-f0-9]{64}$/.test(input.expectedManifestDigest || '')
      || !/^[a-f0-9]{64}$/.test(input.expectedReceiptDigest || '')
      || !Array.isArray(input.expectedArchivePins) || input.expectedArchivePins.length !== 3)
    fail('ARCHIVE_ADMISSION_REQUIRED', 'trusted legacy admission requires retained manifest, receipt and all three archive identities');
  const worktree = fs.realpathSync(input.worktreePath), trusted = trustedRecord(input);
  if (!['codex', 'claude'].includes(trusted.receipt.runtime) || digest(Buffer.from(stable(trusted.receipt))) !== input.expectedReceiptDigest)
    fail('ARCHIVE_AUTHORITY_INVALID', 'retained original runtime receipt identity differs from authenticated record');
  const manifestPath = archivePath(worktree, trusted.dispatchId, MANIFEST_NAME, 'historical manifest');
  const manifestPin = input.expectedArchivePins.find(pin => pin.path === path.relative(worktree, manifestPath));
  if (!manifestPin || manifestPin.sha256 !== input.expectedManifestDigest)
    fail('ARCHIVE_ADMISSION_REQUIRED', 'independently retained complete manifest pin is required');
  const manifestBytes = readPinnedArchiveFile(worktree, manifestPin, 'historical manifest');
  if (digest(manifestBytes) !== input.expectedManifestDigest)
    fail('ARCHIVE_AUTHORITY_INVALID', 'historical manifest differs from independently retained digest');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== ROLE_ARTIFACT_SCHEMA || manifest.version !== ENVELOPE_VERSION)
    fail('ARCHIVE_AUTHORITY_INVALID', 'historical manifest schema is invalid');
  for (const [field, expected] of [
    ['producer_dispatch', trusted.dispatchId], ['producer_dispatch_id', trusted.dispatchId],
    ['dispatch_id', trusted.dispatchId], ['producer_launch', trusted.receipt.launch_id],
    ['runtime', trusted.receipt.runtime], ['role', trusted.receipt.role],
    ['worktree', worktree], ['worktree_realpath', worktree], ['policy_hash', trusted.receipt.policy_hash],
  ]) manifestValue(manifest, field, expected);
  verifyDispatchContext(manifest, trusted);
  const ticket = trusted.record.ticket || trusted.record.trace?.ticket;
  manifestValue(manifest, manifest.artifact_kind === 'judgment' ? 'boundary_subject' : 'ticket', ticket);
  const role = trusted.receipt.role;
  const evidenceName = JUDGMENT_ROLES.has(role) ? JUDGMENT_EVIDENCE_NAMES[role] : producerEvidenceName(role);
  const reference = (name, declared, label) => {
    const expected = archiveRelative(trusted.dispatchId, name);
    const pin = input.expectedArchivePins.find(candidate => candidate.path === expected);
    if (!pin || !object(declared) || declared.path !== expected || declared.sha256 !== pin.sha256 || declared.bytes !== pin.bytes)
      fail('ARCHIVE_ADMISSION_REQUIRED', 'independently retained complete ' + label + ' pin is required');
    const content = readPinnedArchiveFile(worktree, pin, label);
    return { ...pin, content };
  };
  const evidence = reference(evidenceName, manifest.files?.evidence, 'historical evidence');
  const findings = reference(FINDINGS_NAME, manifest.files?.findings, 'historical findings');
  for (const [commit, tree, label] of [
    [manifest.head, manifest.head_tree, 'historical head'],
    [manifest.base_commit, manifest.base_tree, 'historical base'],
  ]) if (gitObjectIdentity(input, worktree, sha(commit, label), label).tree !== tree)
    fail('ARCHIVE_AUTHORITY_INVALID', 'historical git object differs from retained manifest');
  const pins = [
    { path: path.relative(worktree, manifestPath), sha256: input.expectedManifestDigest, bytes: manifestBytes.length },
    { path: manifest.files.evidence.path, sha256: evidence.sha256, bytes: evidence.bytes },
    { path: manifest.files.findings.path, sha256: findings.sha256, bytes: findings.bytes },
  ];
  const ordered = values => values.map(pin => ({ path: pin.path, sha256: pin.sha256, bytes: pin.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (stable(ordered(pins)) !== stable(ordered(input.expectedArchivePins)))
    fail('ARCHIVE_AUTHORITY_INVALID', 'historical complete bytes differ from independently retained pins');
  let previous = [];
  if (fs.existsSync(path.join(archiveAuthorityDirectory(worktree), 'catalogue.json'))) {
    const { payload } = authorityState(worktree);
    previous = Object.values(payload.records).flatMap(record => record.pins);
    for (const pin of previous) readPinnedArchiveFile(worktree, pin, 'existing authenticated historical archive');
  }
  const expectedInventory = [...new Set([...previous, ...pins].map(pin => pin.path))].sort();
  if (!defer && stable(archiveInventory(worktree)) !== stable(expectedInventory))
    fail('ARCHIVE_AUTHORITY_INVALID', 'trusted historical admission refuses unknown archive membership');
  if (trusted.receipt.role === 'arch-review' && trusted.receipt.runtime === 'codex')
    require('./codex-arch-review-context.cjs').validateHistoricalContext({ result: JSON.parse(findings.content),
      receipt: trusted.receipt, dispatchId: trusted.dispatchId, evidence: evidence.content });
  if (defer) return { worktree, trusted, manifestPath, pins, digest: input.expectedManifestDigest };
  retainArchiveAuthority(worktree, trusted, manifestPath, input.expectedManifestDigest);
  authenticatedArchivePins(worktree);
  return Object.freeze({ worktree, dispatch_id: trusted.dispatchId,
    manifest_digest: input.expectedManifestDigest, admitted_paths: pins.map(pin => pin.path) });
}

function admitHistoricalArchive(input) {
  const worktree = fs.realpathSync(input.worktreePath);
  return withArchiveAuthorityLock(worktree, () => {
    if (!Array.isArray(input.archives)) return validateHistoricalArchive(input);
    if (!input.archives.length || input.archives.length > 1000)
      fail('ARCHIVE_ADMISSION_REQUIRED', 'bounded complete historical archive inventory is required');
    const admissions = input.archives.map(archive => validateHistoricalArchive({ ...input, ...archive, worktreePath: worktree }, true));
    if (new Set(admissions.map(item => item.trusted.dispatchId)).size !== admissions.length)
      fail('ARCHIVE_AUTHORITY_INVALID', 'historical batch has duplicate dispatch identities');
    const state = authorityState(worktree, true);
    const prior = Object.values(state.payload.records).flatMap(record => record.pins);
    const expected = [...new Set([...prior, ...admissions.flatMap(item => item.pins)].map(pin => pin.path))].sort();
    if (stable(archiveInventory(worktree)) !== stable(expected))
      fail('ARCHIVE_AUTHORITY_INVALID', 'trusted historical admission refuses unknown archive membership');
    for (const item of admissions) {
      const findings = JSON.parse(readPinnedArchiveFile(worktree, item.pins.find(pin => pin.path.endsWith('/' + FINDINGS_NAME)), 'historical batch findings'));
      const bookkeeping = item.trusted.receipt.role === 'arch-review' ? findings.host_context?.bookkeeping || [] : [];
      const record = { dispatch_id: item.trusted.dispatchId, receipt: item.trusted.receipt, pins: item.pins, bookkeeping };
      if (state.payload.records[item.trusted.dispatchId] && stable(state.payload.records[item.trusted.dispatchId]) !== stable(record))
        fail('ARCHIVE_AUTHORITY_INVALID', 'historical batch cannot replace authenticated original bytes');
      state.payload.records[item.trusted.dispatchId] = record;
      if (bookkeeping.length) state.payload.latest_bookkeeping = bookkeeping;
    }
    writeArchiveCatalogue(state);
    authenticatedArchivePins(worktree);
    return Object.freeze({ worktree, admitted_paths: expected });
  });
}

function prepareRoleArtifact(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const role = input.role;
  if (!REPAIR_ROLES.has(role) && role !== 'drift-check' && !JUDGMENT_ROLES.has(role)) {
    fail('INVALID_ARTIFACT', `role artifact preparation does not support ${role}`);
  }
  const defaultName = JUDGMENT_ROLES.has(role)
    ? judgmentEvidenceName(role, input.phase)
    : producerEvidenceName(role);
  const requested = input.evidencePath || input.evidence_path || defaultName;
  const file = JUDGMENT_ROLES.has(role)
    ? judgmentEvidencePath(fsApi, worktree, role, requested, 'complete judgment evidence', input.phase)
    : fixedPath(worktree, producerEvidenceName(role), 'producer evidence');
  assertContainedRegularPath(
    fsApi,
    worktree,
    file,
    JUDGMENT_ROLES.has(role) ? 'complete judgment evidence' : 'producer evidence',
  );
  let stat;
  try {
    stat = fsApi.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return Object.freeze({ path: file, relative: path.relative(worktree, file), cleared: false });
    }
    fail('ARTIFACT_PATH_ESCAPE', `producer evidence could not be inspected: ${error.message}`, { path: file });
  }
  if (stat.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', 'producer evidence may not be a symlink', { path: file });
  if (!stat.isFile()) fail('INVALID_ARTIFACT', 'producer evidence must be a regular file', { path: file });
  try {
    fsApi.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      fail('ARTIFACT_WRITE', `producer evidence could not be rotated: ${error.message}`, { path: file });
    }
  }
  return Object.freeze({ path: file, relative: path.relative(worktree, file), cleared: true });
}

function sha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    fail('INVALID_ARTIFACT', `${label} must be a full 40-character Git object id`);
  }
  return value.toLowerCase();
}

function archiveRelative(dispatchId, name) {
  return path.join(ARTIFACT_ARCHIVE_DIR, digest(dispatchId), name);
}

function archivePath(worktree, dispatchId, name, label) {
  return fixedPath(worktree, archiveRelative(dispatchId, name), label);
}

function ensureArchiveDirectory(fsApi, worktree, dispatchId) {
  const archiveRoot = fixedPath(worktree, ARTIFACT_ARCHIVE_DIR, 'artifact archive');
  const dispatchRoot = fixedPath(worktree, archiveRelative(dispatchId, ''), 'dispatch artifact archive');
  for (const directory of [archiveRoot, dispatchRoot]) {
    let stat;
    try {
      stat = fsApi.lstatSync(directory);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        try {
          assertArchiveLock(worktree);
          fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
          stat = fsApi.lstatSync(directory);
          const frame = archivePublicationFrames.at(-1);
          if (frame?.directories) frame.directories.push({ path: directory, dev: stat.dev, ino: stat.ino });
        } catch (mkdirError) {
          fail('ARTIFACT_WRITE', `artifact archive directory could not be created: ${mkdirError.message}`, {
            path: directory,
          });
        }
      } else {
        fail('ARTIFACT_PATH_ESCAPE', `artifact archive directory could not be inspected: ${error.message}`, {
          path: directory,
        });
      }
    }
    if (stat.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', 'artifact archive directory may not be a symlink', { path: directory });
    if (!stat.isDirectory()) fail('INVALID_ARTIFACT', 'artifact archive path must be a directory', { path: directory });
  }
  return dispatchRoot;
}

function writeImmutableArtifactFile(fsApi, file, content, label, maximum) {
  const value = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8');
  maximum ??= HISTORICAL_ARCHIVE_MAX_BYTES;
  if (value.length > maximum) fail('ARTIFACT_WRITE', label + ' exceeds its complete-byte bound');
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fsApi.existsSync(file)) {
      const existing = readImmutableFile(fsApi, file, label, maximum, maximum === undefined ? undefined : value.length);
      if (!existing.equals(value)) {
        fail('ARTIFACT_WRITE', `${label} already exists with different bytes`, { path: file });
      }
      return existing;
    }
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const frame = archivePublicationFrames.at(-1);
    if (frame) assertArchiveLock(frame.worktree);
    fsApi.writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
    try {
      // link() keeps a retry from replacing an archive that has already been
      // authenticated for this dispatch.
      if (frame) assertArchiveLock(frame.worktree);
      fsApi.linkSync(temp, file);
      if (frame?.created) { const stat = fsApi.lstatSync(file); frame.created.push({ path: file, dev: stat.dev, ino: stat.ino }); }
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      const existing = readImmutableFile(fsApi, file, label, maximum, maximum === undefined ? undefined : value.length);
      if (!existing.equals(value)) {
        fail('ARTIFACT_WRITE', `${label} was published concurrently with different bytes`, { path: file });
      }
      return existing;
    } finally {
      try { if (frame) assertArchiveLock(frame.worktree); fsApi.unlinkSync(temp); } catch (_) { /* linked or raced */ }
    }
    return value;
  } catch (error) {
    if (error && error.name === 'DispatchBoundaryError') throw error;
    fail('ARTIFACT_WRITE', `${label} could not be archived: ${error.message}`, { path: file });
  }
}

function dispatchContextFor(trusted) {
  const resolution = object(trusted.record.resolution) ? trusted.record.resolution : {};
  const signals = object(resolution.signals) ? resolution.signals : {};
  return {
    signals,
    signature_state: signals.signatureState,
    predecessor_dispatch_id: trusted.record.predecessor_dispatch_id,
    predecessor_consumer_id: trusted.record.predecessor_consumer_id,
  };
}

function verifyDispatchContext(manifest, trusted) {
  const expected = dispatchContextFor(trusted);
  if (!object(manifest.dispatch_context)
      || stable(manifest.dispatch_context.signals) !== stable(expected.signals)
      || manifest.dispatch_context.signature_state !== expected.signature_state
      || manifest.dispatch_context.predecessor_dispatch_id !== expected.predecessor_dispatch_id
      || manifest.dispatch_context.predecessor_consumer_id !== expected.predecessor_consumer_id) {
    fail('STALE_ARTIFACT', 'artifact dispatch context does not match the authenticated receipt chain', {
      dispatch_id: trusted.dispatchId,
    });
  }
}

function repairResultData(result, metadata, input) {
  assertAgentReceiptIsNotForged(result, metadata.trusted);
  if (!object(result)) fail('INVALID_RESULT', 'repair result must be an object');
  if (result.id !== metadata.ticket) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'repair result id does not match the authenticated ticket', {
      expected_ticket: metadata.ticket,
      actual_id: result.id,
    });
  }
  const expectedPr = input.pr === undefined ? input.prNumber : input.pr;
  roleNumber(expectedPr, 'repair PR');
  if (result.pr !== expectedPr) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'repair result PR does not match the authenticated repair target', {
      expected_pr: expectedPr,
      actual_pr: result.pr,
    });
  }
  if (!['fixed', 'no-op', 'escalate'].includes(result.status)) {
    fail('INVALID_RESULT', 'repair result status must be fixed, no-op, or escalate', { status: result.status });
  }
  if (typeof result.pushed !== 'boolean') fail('INVALID_RESULT', 'repair result pushed must be boolean');
  const notes = roleText(result.notes, 'repair notes');
  const hypothesis = roleText(result.hypothesis, 'repair hypothesis');
  return {
    status: result.status,
    pushed: result.pushed,
    pr: expectedPr,
    notes,
    hypothesis,
  };
}

function arrayOfText(value, label) {
  if (!Array.isArray(value)) fail('INVALID_RESULT', `${label} must be an array`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim() === '' || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) {
      fail('INVALID_RESULT', `${label}[${index}] must be non-empty text`);
    }
  }
  return value;
}

function driftFindingIds(moved) {
  const ids = [];
  const seen = new Set();
  for (const [index, finding] of moved.entries()) {
    let id;
    if (object(finding)) {
      id = finding.id || finding.drift_id || finding.finding_id;
      if (typeof id !== 'string' || id.trim() === '') {
        fail('MISSING_DRIFT_ID', `drift finding ${index} has no id`);
      }
      if (/\s/.test(id) || /[\u0000-\u001f\u007f]/.test(id)) {
        fail('INVALID_RESULT', `drift finding ${index} id is not a compact identity`);
      }
    } else {
      fail('MISSING_DRIFT_ID', `drift finding ${index} must be an object with an id`);
    }
    if (seen.has(id)) fail('DUPLICATE_DRIFT_ID', `drift finding id ${id} appears more than once`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function driftResultData(result, metadata) {
  assertAgentReceiptIsNotForged(result, metadata.trusted);
  if (!object(result)) fail('INVALID_RESULT', 'drift result must be an object');
  if (result.id !== metadata.ticket) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'drift result id does not match the authenticated ticket', {
      expected_ticket: metadata.ticket,
      actual_id: result.id,
    });
  }
  if (!['fresh', 'drifted'].includes(result.verdict)) {
    fail('INVALID_RESULT', 'drift verdict must be fresh or drifted', { verdict: result.verdict });
  }
  if (!Array.isArray(result.moved)) fail('INVALID_RESULT', 'drift moved findings must be an array');
  const findingIds = driftFindingIds(result.moved);
  if (result.verdict === 'fresh' && result.moved.length) {
    fail('INVALID_RESULT', 'fresh drift verdict cannot contain moved findings');
  }
  const candidates = arrayOfText(result.reuse_candidates, 'reuse_candidates');
  const evidence = arrayOfText(result.evidence, 'evidence');
  return {
    verdict: result.verdict,
    moved_count: result.moved.length,
    finding_ids: findingIds,
    reuse_candidates_count: candidates.length,
    evidence_count: evidence.length,
    summary: roleText(
      result.summary === undefined
        ? `${result.verdict}: ${result.moved.length} moved finding(s), ${candidates.length} reuse candidate(s)`
        : result.summary,
      'drift summary',
    ),
  };
}

function sanitizedRoleResult(result, trusted) {
  assertAgentReceiptIsNotForged(result, trusted);
  const safe = { ...result };
  for (const field of [
    'receipt', 'application_receipt', 'applicationReceipt',
    'applicationEvidence', 'application_evidence',
  ]) delete safe[field];
  delete safe.recorded;
  return safe;
}

function judgmentEvidenceName(role, phase) {
  const name = JUDGMENT_EVIDENCE_NAMES[role];
  if (!name) fail('INVALID_ARTIFACT', `no complete evidence path is registered for ${role}`);
  if (role === 'integrator') {
    if (typeof phase !== 'string' || phase.trim() === '') {
      fail('MISSING_JUDGMENT_CONTEXT', 'integrator evidence path requires the phase name');
    }
    const phaseName = compactIdentity(phase, 'integration phase');
    if (phaseName === '.' || phaseName === '..'
        || phaseName !== path.basename(phaseName) || phaseName.includes('\\')) {
      fail('INVALID_ARTIFACT', 'integration phase must be one directory name', { phase: phaseName });
    }
    return path.join('.planning', 'phases', phaseName, name);
  }
  return name;
}

function judgmentEvidencePath(fsApi, worktree, role, requested, label, phase) {
  const expected = fixedPath(worktree, judgmentEvidenceName(role, phase), label);
  const candidate = requestedPathInWorktree(fsApi, worktree, requested, label);
  if (candidate !== expected) {
    fail('ARTIFACT_IDENTITY_MISMATCH', `${label} must use the prepared role-owned evidence path`, {
      expected,
      actual: candidate,
    });
  }
  return expected;
}

function requestedPathInWorktree(fsApi, worktree, requested, label) {
  if (!path.isAbsolute(requested)) return path.resolve(worktree, requested);
  // macOS commonly exposes temporary directories through a symlink such as
  // /var -> /private/var. Canonicalize the existing parent so an absolute
  // caller path cannot be rejected merely for spelling the same worktree
  // through that alias. The file itself may be absent; its parent must exist.
  const parent = safeRealpath(fsApi, path.dirname(requested), `${label} directory`);
  return path.join(parent, path.basename(requested));
}

function assertContainedRegularPath(fsApi, worktree, file, label) {
  contained(worktree, file, label);
  let stat;
  try {
    stat = fsApi.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    fail('ARTIFACT_PATH', `${label} could not be inspected: ${error.message}`, { path: file });
  }
  if (stat.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', `${label} may not be a symlink`, { path: file });
  const real = safeRealpath(fsApi, file, label);
  if (real !== file) fail('ARTIFACT_PATH_ESCAPE', `${label} resolves outside the worktree`, { path: file });
}

function compactIdentity(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_RESULT', `${label} must be a compact identity`);
  }
  return value;
}

function findingTicketProblem(value) {
  if (typeof value === 'string' && value.trim() !== '' && !/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  if (Array.isArray(value)) return 'an array';
  if (object(value)) return 'an object';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return 'an empty or multi-word string';
}

function findingText(finding, keys, label) {
  let selected;
  for (const key of keys) {
    if (finding[key] === undefined) continue;
    const value = roleText(finding[key], `${label} (${key})`);
    if (selected !== undefined && selected !== value) {
      fail('JUDGMENT_IDENTITY_MISMATCH', `${label} has conflicting aliases`);
    }
    selected = value;
  }
  if (selected !== undefined) return selected;
  fail('INCOMPLETE_FINDING', `${label} is required in complete judgment evidence`);
}

function compactAlias(source, keys, label) {
  let selected;
  for (const key of keys) {
    if (source[key] === undefined) continue;
    const value = compactIdentity(source[key], `${label} (${key})`);
    if (selected !== undefined && selected !== value) {
      fail('JUDGMENT_IDENTITY_MISMATCH', `${label} has conflicting aliases`);
    }
    selected = value;
  }
  if (selected !== undefined) return selected;
  fail('INVALID_RESULT', `${label} is required`);
}

function findingLine(finding, label) {
  if (finding.line !== undefined) {
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      fail('INCOMPLETE_FINDING', `${label}.line must be a positive integer`);
    }
    return finding.line;
  }
  return findingText(finding, ['hunk', 'location'], `${label}.line or hunk`);
}

function completeFinding(finding, index, role) {
  if (!object(finding)) fail('INCOMPLETE_FINDING', `${role} finding ${index} must be an object`);
  const id = compactAlias(finding, ['id', 'finding_id', 'decision_id'], `${role} finding ${index} id`);
  const rawType = compactAlias(finding, ['type', 'kind'], `${role} finding ${index} type`);
  const type = rawType.toLowerCase().replace(/_/g, '-');
  const blocking = finding.blocking === undefined ? true : finding.blocking;
  if (typeof blocking !== 'boolean') fail('INCOMPLETE_FINDING', `${role} finding ${index}.blocking must be boolean`);

  if (finding.ticket !== undefined && finding.ticket !== null) {
    const problem = findingTicketProblem(finding.ticket);
    if (problem) {
      fail('INVALID_RESULT', `${role} finding ${index}.ticket is ${problem}; remedy: set ticket to the affected `
        + 'ticket id string, or null for a phase-level finding, and put a proposed fix ticket in fix_ticket '
        + '{title, scope, files, depends_on}');
    }
  }
  if (finding.fix_ticket !== undefined && type !== 'fix-ticket' && type !== 'fix') {
    fail('INVALID_RESULT', `${role} finding ${index}.fix_ticket is only valid on a fix-ticket finding; `
      + 'remedy: set type to fix-ticket or drop fix_ticket');
  }

  if (role === 'arch-review') {
    if (type === 'violation') {
      findingText(finding, ['adr', 'adr_id'], `${role} finding ${index}.adr`);
      findingText(finding, ['section', 'adr_section'], `${role} finding ${index}.section`);
      const file = findingText(finding, ['file', 'path'], `${role} finding ${index}.file`);
      findingLine(finding, `${role} finding ${index}`);
      findingText(finding, ['hunk', 'location'], `${role} finding ${index}.hunk`);
      findingText(finding, ['remediation', 'minimal_remediation'], `${role} finding ${index}.remediation`);
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
      if (!file) fail('INCOMPLETE_FINDING', `${role} finding ${index}.file is required`);
    } else if (type === 'adr-outdated') {
      findingText(finding, ['adr', 'adr_id'], `${role} finding ${index}.adr`);
      findingText(finding, ['decision', 'section', 'adr_section'], `${role} finding ${index}.decision`);
      findingText(finding, ['reality', 'contradiction'], `${role} finding ${index}.reality`);
      findingText(finding, ['human_decision', 'question', 'remediation'], `${role} finding ${index}.human_decision`);
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
    } else if (type === 'note' || type === 'informational') {
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
    } else {
      if (finding.blocking === true) {
        fail('INCOMPLETE_FINDING', `${role} finding ${index} has blocking unsupported type ${JSON.stringify(rawType)}`);
      }
      const summary = findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
      const normalized = {
        ...finding,
        id,
        type: 'informational',
        original_type: rawType,
        summary,
        blocking: false,
      };
      NORMALIZED_UNKNOWN_ARCH_FINDINGS.add(normalized);
      return normalized;
    }
  } else if (role === 'integrator') {
    if (type === 'fix-ticket' || type === 'fix') {
      if (!object(finding.fix_ticket)) {
        fail('INCOMPLETE_FINDING', `${role} finding ${index}.fix_ticket is required; remedy: put the proposed `
          + 'ticket {title, scope, files, depends_on} in fix_ticket');
      }
      const fixTicket = finding.fix_ticket;
      roleText(fixTicket.title, `${role} finding ${index}.fix_ticket.title`);
      roleText(fixTicket.scope, `${role} finding ${index}.fix_ticket.scope`);
      if (!Array.isArray(fixTicket.files) || fixTicket.files.length === 0) {
        fail('INCOMPLETE_FINDING', `${role} finding ${index}.fix_ticket.files must be a non-empty array`);
      }
      for (const [fileIndex, file] of fixTicket.files.entries()) {
        roleText(file, `${role} finding ${index}.fix_ticket.files[${fileIndex}]`);
      }
      if (fixTicket.depends_on !== undefined) {
        if (!Array.isArray(fixTicket.depends_on)) {
          fail('INCOMPLETE_FINDING', `${role} finding ${index}.fix_ticket.depends_on must be an array`);
        }
        for (const [dependIndex, depend] of fixTicket.depends_on.entries()) {
          compactIdentity(depend, `${role} finding ${index}.fix_ticket.depends_on[${dependIndex}]`);
        }
      }
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
    } else if (type === 'human-question' || type === 'human-review') {
      findingText(finding, ['question', 'human_decision'], `${role} finding ${index}.question`);
      findingText(finding, ['evidence', 'location', 'file'], `${role} finding ${index}.evidence`);
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
    } else if (type === 'violation' || type === 'adr-outdated' || type === 'note' || type === 'informational') {
      findingText(finding, ['summary', 'reason'], `${role} finding ${index}.summary`);
      findingText(finding, ['evidence', 'location', 'file'], `${role} finding ${index}.evidence`);
    } else {
      fail('INCOMPLETE_FINDING', `${role} finding ${index} has unsupported type ${JSON.stringify(rawType)}`);
    }
  }
  return { ...finding, id, type, blocking };
}

function completeFindingIndex(result, role) {
  if (!Array.isArray(result.findings)) {
    fail('MISSING_ARTIFACT', `${role} judgment must return a complete findings array`);
  }
  const seen = new Set();
  const findings = result.findings.map((finding, index) => {
    const normalized = completeFinding(finding, index, role);
    if (seen.has(normalized.id)) fail('DUPLICATE_FINDING_ID', `${role} finding id ${normalized.id} appears more than once`);
    seen.add(normalized.id);
    return normalized;
  });
  const blockingCount = findings.filter((finding) => finding.blocking).length;
  if (result.finding_count !== undefined
      && (!Number.isInteger(result.finding_count) || result.finding_count !== findings.length)) {
    fail('JUDGMENT_COUNT_MISMATCH', `${role} finding_count does not match the complete finding index`, {
      declared: result.finding_count,
      actual: findings.length,
    });
  }
  if (!Number.isInteger(result.blocking_count) || result.blocking_count < 0) {
    fail('INVALID_RESULT', `${role} judgment blocking_count must be a non-negative integer`);
  }
  if (result.blocking_count !== blockingCount) {
    fail('JUDGMENT_COUNT_MISMATCH', `${role} blocking_count does not match the complete finding index`, {
      declared: result.blocking_count,
      actual: blockingCount,
    });
  }
  return { findings, finding_count: findings.length, blocking_count: blockingCount };
}

function aliasValue(source, keys, label) {
  let selected;
  let present = false;
  for (const key of keys) {
    if (source[key] === undefined) continue;
    if (present && stable(selected) !== stable(source[key])) {
      fail('JUDGMENT_IDENTITY_MISMATCH', `${label} has conflicting aliases`);
    }
    selected = source[key];
    present = true;
  }
  return present ? selected : undefined;
}

function canonicalTicketSet(value, label) {
  if (!Array.isArray(value)) fail('MISSING_JUDGMENT_CONTEXT', `${label} must be an array`);
  const seen = new Set();
  const entries = value.map((item, index) => {
    const source = typeof item === 'string' ? { id: item } : item;
    if (!object(source)) fail('MISSING_JUDGMENT_CONTEXT', `${label}[${index}] must be an object or ticket id`);
    const id = compactAlias(source, ['id', 'ticket'], `${label}[${index}].id`);
    if (seen.has(id)) fail('DUPLICATE_TICKET_ID', `${label} contains ${id} more than once`);
    seen.add(id);
    const out = { id };
    const aliases = [
      ['pr', 'pr'],
      ['head', 'head'],
      ['head_sha', 'head'],
      ['head_tree', 'head_tree'],
      ['base', 'base'],
      ['base_ref', 'base'],
      ['base_tree', 'base_tree'],
      ['branch', 'branch'],
    ];
    for (const [from, to] of aliases) {
      if (source[from] === undefined) continue;
      const value = to === 'pr'
        ? roleNumber(source[from], `${label}[${index}].pr`)
        : to === 'head' || to === 'head_tree' || to === 'base_tree'
          ? sha(source[from], `${label}[${index}].${to}`)
          : compactIdentity(source[from], `${label}[${index}].${to}`);
      if (out[to] !== undefined && out[to] !== value) {
        fail('JUDGMENT_IDENTITY_MISMATCH', `${label}[${index}] supplies conflicting ${to} identities`);
      }
      out[to] = value;
    }
    return out;
  });
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function ticketSetFor(input, result, role, metadata) {
  if (role !== 'pr-sentinel' && role !== 'integrator'
      && !(role === 'arch-review' && metadata.ticket.startsWith('phase='))) return { entries: [], digest: null };
  const supplied = aliasValue(input, ['ticketSet', 'ticket_set'], `${role} input ticket set`);
  const resultValue = aliasValue(result, ['ticket_set', 'ticketSet'], `${role} result ticket set`);
  if (supplied === undefined) fail('MISSING_JUDGMENT_CONTEXT', `${role} requires the guarded/merged ticket set before dispatch`);
  if (resultValue === undefined) fail('MISSING_ARTIFACT', `${role} result must repeat the complete ticket set`);
  const expected = canonicalTicketSet(supplied, `${role} ticket set`);
  const actual = canonicalTicketSet(resultValue, `${role} result ticket set`);
  if (role === 'arch-review' && stable(supplied) !== stable(resultValue))
    fail('JUDGMENT_IDENTITY_MISMATCH', 'aggregate result must repeat complete membership and evidence');
  if (stable(expected) !== stable(actual)) {
    fail('JUDGMENT_IDENTITY_MISMATCH', `${role} result ticket set does not match the authenticated input ticket set`);
  }
  // The producer may use strings or structured ticket entries. Digest the
  // authenticated ticket-set representation after validating its contents so
  // the envelope can preserve the exact round subject the caller dispatched.
  let expectedDigest;
  try {
    expectedDigest = digest(JSON.stringify(supplied));
  } catch (error) {
    fail('MISSING_JUDGMENT_CONTEXT', `${role} ticket set is not JSON-serializable: ${error.message}`);
  }
  const resultDigest = aliasValue(result, ['ticket_set_digest', 'ticketSetDigest'], `${role} result ticket-set digest`);
  const inputDigest = aliasValue(input, ['ticketSetDigest', 'ticket_set_digest'], `${role} input ticket-set digest`);
  if (resultDigest !== undefined && inputDigest !== undefined && resultDigest !== inputDigest) {
    fail('JUDGMENT_DIGEST_MISMATCH', `${role} result and input ticket-set digests disagree`);
  }
  const suppliedDigest = resultDigest === undefined ? inputDigest : resultDigest;
  if (suppliedDigest !== undefined && suppliedDigest !== expectedDigest) {
    fail('JUDGMENT_DIGEST_MISMATCH', `${role} ticket-set digest does not match the complete ticket set`, {
      expected: expectedDigest,
      actual: suppliedDigest,
    });
  }
  if (role === 'pr-sentinel') {
    const expectedSubject = `round:${expectedDigest}`;
    if (!metadata || metadata.ticket !== expectedSubject) {
      fail('JUDGMENT_IDENTITY_MISMATCH', 'sentinel ticket set does not match the authenticated round subject', {
        expected: expectedSubject,
        actual: metadata && metadata.ticket,
      });
    }
  }
  return { entries: expected, digest: expectedDigest };
}

function reviewedIdentity(result, role, identity, input) {
  const requireSha = (value, label, expected) => {
    if (value === undefined) fail('MISSING_REVIEWED_REVISION', `${role} result must report ${label}`);
    const actual = sha(value, label);
    if (expected !== undefined && actual !== expected) {
      fail('JUDGMENT_IDENTITY_MISMATCH', `${role} result ${label} does not match the live reviewed identity`, {
        expected,
        actual,
      });
    }
    return actual;
  };
  const shaAlias = (source, keys, label) => {
    let selected;
    let present = false;
    for (const key of keys) {
      if (source[key] === undefined) continue;
      const value = sha(source[key], `${label} (${key})`);
      if (present && selected !== value) {
        fail('JUDGMENT_IDENTITY_MISMATCH', `${label} has conflicting aliases`);
      }
      selected = value;
      present = true;
    }
    return present ? selected : undefined;
  };
  const reportedSha = (keys, label, expected) => requireSha(shaAlias(result, keys, label), label, expected);
  const head = reportedSha(['head', 'head_sha'], 'reviewed head', identity.head);
  if (role === 'pr-sentinel') {
    const headTree = result.head_tree === undefined
      ? identity.head_tree
      : requireSha(shaAlias(result, ['head_tree'], 'reviewed head tree'), 'reviewed head tree', identity.head_tree);
    return {
      head,
      head_tree: headTree,
      base: identity.base,
      base_commit: identity.base_commit,
      base_tree: identity.base_tree,
      merge_base: identity.merge_base,
      merge_base_tree: identity.merge_base_tree,
    };
  }
  const headTree = result.head_tree === undefined
    ? identity.head_tree
    : requireSha(shaAlias(result, ['head_tree'], 'reviewed head tree'), 'reviewed head tree', identity.head_tree);
  if (role === 'arch-review') {
    const baseTree = requireSha(
      shaAlias(result, ['base_tree', 'merge_base_tree'], 'reviewed merge-base tree'),
      'reviewed merge-base tree',
      identity.merge_base_tree,
    );
    return {
      head,
      head_tree: headTree,
      base: identity.base,
      base_commit: identity.base_commit,
      // Architecture review judges the merge-base tree. The manifest's
      // top-level base_tree remains the live integration-ref tree.
      base_tree: baseTree,
      base_ref_tree: identity.base_tree,
      merge_base: identity.merge_base,
      merge_base_tree: baseTree,
    };
  }
  const rawBaseValue = aliasValue(result, ['base', 'base_ref'], 'reviewed integration base');
  const rawBase = rawBaseValue === undefined ? undefined : compactIdentity(rawBaseValue, 'reviewed integration base');
  const resolvedBaseRef = rawBase === undefined
    ? null
    : liveBaseRef({ ...(input || {}), base: rawBase, baseRef: undefined }, identity.worktree);
  const resolvedBaseCommit = resolvedBaseRef === null
    ? null
    : gitCommitIfPresent(input || {}, identity.worktree, resolvedBaseRef);
  const base = resolvedBaseCommit === identity.base_commit.toLowerCase()
    ? identity.base
    : rawBase;
  if (base !== identity.base) {
    fail('JUDGMENT_IDENTITY_MISMATCH', `${role} result base does not match the live integration base`, {
      expected: identity.base,
      actual: base,
    });
  }
  const baseTree = requireSha(result.base_tree, 'reviewed base tree', identity.base_tree);
  return {
    head,
    head_tree: headTree,
    base: identity.base,
    base_commit: identity.base_commit,
    base_tree: baseTree,
    merge_base: identity.merge_base,
    merge_base_tree: identity.merge_base_tree,
  };
}

function dutyEntries(value, label, ticketIds, kind) {
  if (!Array.isArray(value)) fail('MISSING_ARTIFACT', `${label} must be an array`);
  return value.map((entry, index) => {
    if (!object(entry)) fail('INCOMPLETE_DUTY', `${label}[${index}] must be an object`);
    const ticket = compactAlias(entry, ['ticket', 'id'], `${label}[${index}].ticket`);
    if (!ticketIds.has(ticket)) {
      fail('JUDGMENT_IDENTITY_MISMATCH', `${label}[${index}] names a ticket outside the guarded set`, { ticket });
    }
    const duty = compactAlias(entry, ['duty', 'action'], `${label}[${index}].duty`);
    const statusValue = aliasValue(entry, ['status', 'outcome'], `${label}[${index}].status`);
    if (statusValue === undefined) fail('INCOMPLETE_DUTY', `${label}[${index}].status is required`);
    const status = roleText(statusValue, `${label}[${index}].status`);
    const allowed = kind === 'performed' ? SENTINEL_PERFORMED_STATUSES : SENTINEL_REFUSED_STATUSES;
    if (!allowed.has(status)) {
      fail('INCOMPLETE_DUTY', `${label}[${index}].status must be ${[...allowed].join(' or ')}`, {
        status,
      });
    }
    if (kind === 'refused') roleText(entry.reason, `${label}[${index}].reason`);
    const occurrence = entry.duty_id === undefined && entry.occurrence === undefined
      ? undefined
      : compactAlias(entry, ['duty_id', 'occurrence'], `${label}[${index}].duty_id`);
    return { ...entry, ticket, duty, status, ...(occurrence === undefined ? {} : { duty_id: occurrence }) };
  });
}

function judgmentSubject(role, metadata, identity, input, ticketSet, pr) {
  if (role === 'pr-sentinel') return `round:${ticketSet.digest}`;
  if (role === 'integrator') {
    const phase = compactIdentity(input.phase, 'integration phase');
    return `phase=${phase};repository=${identity.repository.identity};tickets=${ticketSet.digest}`;
  }
  if (role === 'arch-review' && metadata.ticket.startsWith('phase=')) {
    const aggregate = require('./architecture-target.cjs').PHASE_SUBJECT.exec(metadata.ticket);
    if (!aggregate || aggregate[2] !== identity.repository.identity || aggregate[3] !== ticketSet.digest
        || Number(aggregate[4]) !== pr || aggregate[5] !== identity.head || aggregate[6] !== identity.base_commit)
      fail('JUDGMENT_IDENTITY_MISMATCH', 'aggregate architecture identity differs from the authenticated PR and membership');
    return metadata.ticket;
  }
  return `ticket=${metadata.ticket};pr=${pr}`;
}

function judgmentResultData(result, metadata, input, identity) {
  assertAgentReceiptIsNotForged(result, metadata.trusted);
  if (!object(result)) fail('INVALID_RESULT', 'judgment result must be an object');
  const role = metadata.role;
  const ticketSet = ticketSetFor(input, result, role, metadata);
  if (role === 'arch-review') {
    if (result.id !== metadata.ticket) {
      fail('ARTIFACT_IDENTITY_MISMATCH', 'architecture judgment id does not match the authenticated ticket', {
        expected_ticket: metadata.ticket,
        actual_id: result.id,
      });
    }
    const suppliedPr = aliasValue(input, ['pr', 'prNumber'], 'architecture review PR');
    if (suppliedPr === undefined) {
      fail('MISSING_JUDGMENT_CONTEXT', 'architecture review requires the reviewed PR before dispatch');
    }
    const pr = roleNumber(suppliedPr, 'architecture review PR');
    if (result.pr !== pr) fail('ARTIFACT_IDENTITY_MISMATCH', 'architecture judgment PR does not match the reviewed PR');
    const verdict = result.verdict;
    if (!['conform', 'violation', 'adr-outdated'].includes(verdict)) {
      fail('INVALID_RESULT', 'architecture judgment verdict must be conform, violation, or adr-outdated', { verdict });
    }
    const findings = completeFindingIndex(result, role);
    const conformRetainsOnlyUnknownNotes = findings.findings.every((finding) => (
      NORMALIZED_UNKNOWN_ARCH_FINDINGS.has(finding)
      && finding.type === 'informational'
      && finding.blocking === false
    ));
    if (verdict === 'conform' && findings.finding_count !== 0 && !conformRetainsOnlyUnknownNotes) {
      fail('JUDGMENT_OUTCOME_MISMATCH', 'conform architecture judgment must retain an empty finding index');
    }
    if (verdict !== 'conform' && findings.blocking_count === 0) {
      fail('JUDGMENT_OUTCOME_MISMATCH', `${verdict} architecture judgment must retain its blocking findings`);
    }
    const reviewed = reviewedIdentity(result, role, identity, input);
    return {
      role,
      subject: judgmentSubject(role, metadata, identity, input, ticketSet, pr),
      verdict,
      outcome: verdict,
      summary: roleText(result.summary || verdict, 'architecture judgment summary'),
      blocking_count: findings.blocking_count,
      finding_count: findings.finding_count,
      reviewed,
      ticket_set_digest: ticketSet.digest,
      pr,
      findings: findings.findings,
    };
  }

  if (role === 'integrator') {
    const phase = compactIdentity(input.phase, 'integration phase');
    if (result.phase !== undefined && result.phase !== phase) {
      fail('JUDGMENT_IDENTITY_MISMATCH', 'integrator result phase does not match the authenticated phase', {
        expected: phase,
        actual: result.phase,
      });
    }
    const outcome = result.outcome;
    if (!['passed', 'needs-fix', 'human-review-required'].includes(outcome)) {
      fail('INVALID_RESULT', 'integrator outcome must be passed, needs-fix, or human-review-required', { outcome });
    }
    const findings = completeFindingIndex(result, role);
    if (outcome === 'passed' && findings.blocking_count !== 0) {
      fail('JUDGMENT_OUTCOME_MISMATCH', 'passed integration judgment cannot contain blocking findings');
    }
    if (outcome !== 'passed' && findings.blocking_count === 0) {
      fail('JUDGMENT_OUTCOME_MISMATCH', `${outcome} integration judgment must retain its complete findings`);
    }
    const subject = judgmentSubject(role, metadata, identity, input, ticketSet);
    if (metadata.ticket !== subject) {
      fail('JUDGMENT_IDENTITY_MISMATCH', 'integrator result does not match the authenticated phase subject', {
        expected: subject,
        actual: metadata.ticket,
      });
    }
    const reviewed = reviewedIdentity(result, role, identity, input);
    return {
      role,
      subject,
      phase,
      outcome,
      summary: roleText(result.summary || outcome, 'integration judgment summary'),
      blocking_count: findings.blocking_count,
      finding_count: findings.finding_count,
      reviewed,
      ticket_set_digest: ticketSet.digest,
      findings: findings.findings,
    };
  }

  const outcome = result.outcome || result.status;
  if (!['clear', 'blocked', 'awaiting-human'].includes(outcome)) {
    fail('INVALID_RESULT', 'sentinel outcome must be clear, blocked, or awaiting-human', { outcome });
  }
  const ticketIds = new Set(ticketSet.entries.map((entry) => entry.id));
  const performed = dutyEntries(result.performed, 'sentinel performed duties', ticketIds, 'performed');
  const refused = dutyEntries(result.refused, 'sentinel refused duties', ticketIds, 'refused');
  const allDuties = [...performed, ...refused];
  const dutyKeys = new Set();
  const covered = new Set();
  for (const entry of allDuties) {
    const dutyKey = `${entry.ticket}\u0000${entry.duty}\u0000${entry.duty_id || ''}`;
    if (dutyKeys.has(dutyKey)) {
      fail('DUPLICATE_DUTY', `sentinel result reports the same duty occurrence more than once for ${entry.ticket}`, {
        ticket: entry.ticket,
        duty: entry.duty,
      });
    }
    dutyKeys.add(dutyKey);
    covered.add(entry.ticket);
  }
  if (covered.size !== ticketIds.size || [...ticketIds].some((id) => !covered.has(id))) {
    fail('INCOMPLETE_DUTY_SET', 'sentinel result does not report a duty for every guarded ticket');
  }
  if (!Number.isInteger(result.blocking_count) || result.blocking_count < 0) {
    fail('INVALID_RESULT', 'sentinel blocking_count must be a non-negative integer');
  }
  if (result.blocking_count !== refused.length) {
    fail('JUDGMENT_COUNT_MISMATCH', 'sentinel blocking_count does not match refused duties', {
      declared: result.blocking_count,
      actual: refused.length,
    });
  }
  const dutyCount = performed.length + refused.length;
  if (result.finding_count !== undefined
      && (!Number.isInteger(result.finding_count) || result.finding_count !== dutyCount)) {
    fail('JUDGMENT_COUNT_MISMATCH', 'sentinel finding_count does not match performed and refused duties', {
      declared: result.finding_count,
      actual: dutyCount,
    });
  }
  if ((outcome === 'clear' && refused.length > 0) || (outcome !== 'clear' && refused.length === 0)) {
    fail('JUDGMENT_OUTCOME_MISMATCH', 'sentinel outcome does not match its refused live duties');
  }
  return {
    role,
    subject: judgmentSubject(role, metadata, identity, input, ticketSet),
    outcome,
    summary: roleText(result.summary || outcome, 'sentinel summary'),
    blocking_count: refused.length,
    finding_count: dutyCount,
    performed,
    refused,
    reviewed: reviewedIdentity({
      head: result.head === undefined && result.head_sha === undefined
        ? identity.head
        : result.head || result.head_sha,
      ...(result.head_tree === undefined ? {} : { head_tree: result.head_tree }),
    }, role, identity, input),
    ticket_set_digest: ticketSet.digest,
    findings: [],
  };
}

function judgmentEnvelope(data, files) {
  const evidenceIndex = fileReference(files.evidence.relative, files.evidence.content);
  const findingsIndex = fileReference(files.findings.relative, files.findings.content);
  const envelope = {
    schema: JUDGMENT_ENVELOPE_SCHEMA,
    version: ENVELOPE_VERSION,
    role: data.role,
    subject: data.subject,
    outcome: data.outcome,
    ...(data.verdict === undefined ? {} : { verdict: data.verdict }),
    summary: capSummary(data.summary),
    blocking_count: data.blocking_count,
    finding_count: data.finding_count,
    reviewed_head: data.reviewed.head,
    reviewed_head_tree: data.reviewed.head_tree,
    reviewed_base: data.reviewed.base,
    reviewed_base_commit: data.reviewed.base_commit,
    reviewed_base_tree: data.reviewed.base_tree,
    reviewed_merge_base: data.reviewed.merge_base,
    reviewed_base_tree_at_merge: data.reviewed.merge_base_tree,
    ...(data.phase === undefined ? {} : { phase: data.phase }),
    ...(data.pr === undefined ? {} : { pr: data.pr }),
    ...(data.ticket_set_digest === null ? {} : { ticket_set_digest: data.ticket_set_digest }),
    evidence_index: evidenceIndex,
    evidence_index_ref: evidenceIndex,
    findings_index: findingsIndex,
    findings_index_ref: findingsIndex,
    ...(data.role === 'pr-sentinel' ? {
      performed_count: data.performed.length,
      refused_count: data.refused.length,
      duties_index: findingsIndex,
    } : {}),
  };
  if (bytes(JSON.stringify(envelope)) > ENVELOPE_MAX_BYTES) {
    fail('ENVELOPE_TOO_LARGE', `judgment result envelope exceeds ${ENVELOPE_MAX_BYTES} UTF-8 bytes`);
  }
  return envelope;
}

function judgmentManifest(data, metadata, files, envelope, dispatchId) {
  const manifest = {
    schema: ROLE_ARTIFACT_SCHEMA,
    version: ENVELOPE_VERSION,
    artifact_kind: 'judgment',
    producer_dispatch: dispatchId,
    producer_dispatch_id: dispatchId,
    dispatch_id: dispatchId,
    producer_launch: metadata.trusted.receipt.launch_id,
    runtime: metadata.runtime,
    role: data.role,
    subject: data.subject,
    boundary_subject: metadata.ticket,
    ticket: data.role === 'pr-sentinel' ? undefined : metadata.ticket,
    ...(data.phase === undefined ? {} : { phase: data.phase }),
    ...(data.pr === undefined ? {} : { pr: data.pr }),
    repository: metadata.identity.repository,
    repository_realpath: metadata.identity.repository.root,
    repository_identity: metadata.identity.repository.identity,
    worktree: metadata.identity.worktree,
    worktree_realpath: metadata.identity.worktree,
    head: metadata.identity.head,
    head_tree: metadata.identity.head_tree,
    base: metadata.identity.base,
    base_commit: metadata.identity.base_commit,
    base_tree: metadata.identity.base_tree,
    merge_base: metadata.identity.merge_base,
    merge_base_tree: metadata.identity.merge_base_tree,
    reviewed: data.reviewed,
    ticket_set_digest: data.ticket_set_digest,
    policy_hash: metadata.policy_hash,
    dispatch_context: dispatchContextFor(metadata.trusted),
    source_evidence_path: files.evidence.source_relative,
    files: {
      evidence: fileReference(files.evidence.relative, files.evidence.content),
      findings: fileReference(files.findings.relative, files.findings.content),
    },
    envelope,
  };
  delete manifest.ticket;
  return manifest;
}

function judgmentEvidenceMaximum(role, runtime) {
  return role === 'integrator' || (role === 'arch-review' && runtime === 'codex')
    ? 96 * 1024 : HISTORICAL_ARCHIVE_MAX_BYTES;
}

function sealJudgment(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
  const maximum = HISTORICAL_ARCHIVE_MAX_BYTES;
  if (!JUDGMENT_ROLES.has(role)) fail('INVALID_ARTIFACT', `judgment artifacts do not support ${role}`);
  const identity = gitIdentity({ ...input, role }, worktree);
  const metadata = trustedMetadata({ ...input, role }, trusted, identity);
  metadata.trusted = trusted;
  const result = input.result;
  const data = judgmentResultData(result, metadata, input, identity);
  const sourceEvidenceName = judgmentEvidenceName(role, input.phase);
  const requestedEvidence = input.evidencePath || input.evidence_path || sourceEvidenceName;
  const evidencePath = judgmentEvidencePath(
    fsApi,
    worktree,
    role,
    requestedEvidence,
    'complete judgment evidence',
    input.phase,
  );
  assertContainedRegularPath(fsApi, worktree, evidencePath, 'complete judgment evidence');
  const sourceEvidence = readImmutableFile(fsApi, evidencePath, 'complete judgment evidence',
    judgmentEvidenceMaximum(role, trusted.receipt.runtime));
  if (!sourceEvidence.length) fail('MISSING_ARTIFACT', 'complete judgment evidence is empty');
  if (role === 'arch-review' && trusted.receipt.runtime === 'codex' && result.coverage === undefined
      && digest(sourceEvidence) !== result?.host_context?.evidence_sha256)
    fail('ARTIFACT_DIGEST_MISMATCH', 'complete judgment evidence differs from host-captured digest');
  const currentReview = ['arch-review', 'integrator'].includes(role)
    ? authenticateCurrentCoverage({ trusted, result, evidence: sourceEvidence, identity }) : null;
  const completeResult = sanitizedRoleResult(result, trusted);
  let findingsBytes;
  try {
    findingsBytes = Buffer.from(`${JSON.stringify(completeResult)}\n`, 'utf8');
  } catch (error) {
    fail('INVALID_RESULT', `complete ${role} judgment is not JSON-serializable: ${error.message}`);
  }
  if (findingsBytes.length > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARTIFACT_WRITE', 'complete findings exceeds its complete-byte bound');
  const dispatchId = trusted.dispatchId;
  return withArchivePublication(worktree, () => {
  const archiveEvidence = archivePath(worktree, dispatchId, JUDGMENT_EVIDENCE_NAMES[role], 'archived judgment evidence');
  const archiveFindings = archivePath(worktree, dispatchId, FINDINGS_NAME, 'archived judgment findings');
  const evidenceBytes = sourceEvidence;
  const findingsFileBytes = findingsBytes;
  const files = {
    evidence: {
      relative: path.relative(worktree, archiveEvidence),
      source_relative: path.relative(worktree, evidencePath),
      content: evidenceBytes,
    },
    findings: { relative: path.relative(worktree, archiveFindings), content: findingsFileBytes },
  };
  const envelope = judgmentEnvelope(data, files);
  const manifest = judgmentManifest(data, metadata, files, envelope, dispatchId);
  if (currentReview) manifest.current_review = currentReview;
  const manifestPath = archivePath(worktree, dispatchId, MANIFEST_NAME, 'judgment artifact manifest');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  preflightArchiveCatalogue(worktree, trusted, manifestPath, manifest, manifestBytes, findingsFileBytes);
  ensureArchiveDirectory(fsApi, worktree, dispatchId);
  writeImmutableArtifactFile(fsApi, archiveEvidence, evidenceBytes, 'archived judgment evidence', maximum);
  writeImmutableArtifactFile(fsApi, archiveFindings, findingsFileBytes, 'archived judgment findings', maximum);
  writeImmutableArtifactFile(fsApi, manifestPath, manifestBytes, 'judgment artifact manifest', maximum);
  const artifactDigest = digest(manifestBytes);
  validateJudgmentManifest({ ...input, artifactPath: manifestPath, artifactDigest });
  retainArchiveAuthority(worktree, trusted, manifestPath, artifactDigest);
  return Object.freeze({
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_kind: 'judgment',
    artifact_ref: manifestPath,
    artifact_path: manifestPath,
    artifactRef: manifestPath,
    artifact_digest: artifactDigest,
    artifactDigest,
    envelope,
    evidence_index: envelope.evidence_index,
    evidenceIndex: envelope.evidence_index,
    findings_index: envelope.findings_index,
    findingsIndex: envelope.findings_index,
    role,
    subject: data.subject,
    ...(data.phase === undefined ? {} : { phase: data.phase }),
    ...(data.pr === undefined ? {} : { pr: data.pr }),
  });
  });
}

function validateJudgmentManifest(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
  const maximum = HISTORICAL_ARCHIVE_MAX_BYTES;
  if (!JUDGMENT_ROLES.has(role)) fail('INVALID_ARTIFACT', `judgment artifacts do not support ${role}`);
  const identity = gitIdentity({ ...input, role }, worktree);
  const metadata = trustedMetadata({ ...input, role }, trusted, identity);
  metadata.trusted = trusted;
  const dispatchId = trusted.dispatchId;
  const expectedManifestPath = archivePath(worktree, dispatchId, MANIFEST_NAME, 'judgment artifact manifest');
  const requestedPath = input.artifactPath || input.artifact_path || input.artifact_ref || expectedManifestPath;
  const manifestResolved = path.resolve(worktree, requestedPath);
  contained(worktree, manifestResolved, 'judgment artifact manifest');
  if (manifestResolved !== expectedManifestPath) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'judgment artifact reference is not the archive for the authenticated dispatch', {
      expected: expectedManifestPath,
      actual: manifestResolved,
    });
  }
  const manifestBytes = readImmutableFile(fsApi, manifestResolved, 'judgment artifact manifest', maximum);
  const manifestRealpath = safeRealpath(fsApi, manifestResolved, 'judgment artifact manifest');
  if (manifestRealpath !== manifestResolved) fail('ARTIFACT_PATH_ESCAPE', 'judgment artifact manifest may not resolve through a symlink');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT', `judgment artifact manifest is not valid JSON: ${error.message}`);
  }
  if (manifest.schema !== ROLE_ARTIFACT_SCHEMA || manifest.version !== ENVELOPE_VERSION || manifest.artifact_kind !== 'judgment') {
    fail('INVALID_ARTIFACT', 'judgment artifact manifest schema/version/kind is invalid');
  }
  for (const [field, expected] of [
    ['producer_dispatch', dispatchId],
    ['producer_dispatch_id', dispatchId],
    ['dispatch_id', dispatchId],
    ['producer_launch', trusted.receipt.launch_id],
    ['runtime', trusted.receipt.runtime],
    ['role', role],
    ['repository_realpath', identity.repository.root],
    ['repository_identity', identity.repository.identity],
    ['worktree_realpath', identity.worktree],
    ['worktree', identity.worktree],
    ['head', identity.head],
    ['head_tree', identity.head_tree],
    ['base', identity.base],
    ['base_commit', identity.base_commit],
    ['base_tree', identity.base_tree],
    ['merge_base', identity.merge_base],
    ['merge_base_tree', identity.merge_base_tree],
    ['policy_hash', metadata.policy_hash],
  ]) manifestValue(manifest, field, expected);
  verifyDispatchContext(manifest, trusted);
  if (!object(manifest.files) || !object(manifest.files.evidence) || !object(manifest.files.findings)) {
    fail('MISSING_ARTIFACT', 'judgment artifact manifest is missing complete evidence and findings references');
  }
  const sourceEvidenceName = judgmentEvidenceName(role, input.phase);
  const evidence = expectedRoleReference(fsApi, worktree, dispatchId, JUDGMENT_EVIDENCE_NAMES[role], manifest.files.evidence, 'judgment evidence',
    judgmentEvidenceMaximum(role, trusted.receipt.runtime));
  const findings = expectedRoleReference(fsApi, worktree, dispatchId, FINDINGS_NAME, manifest.files.findings, 'judgment findings', maximum);
  if (!evidence.content.length) fail('MISSING_ARTIFACT', 'judgment evidence archive is empty');
  if (manifest.source_evidence_path !== sourceEvidenceName) {
    fail('MISSING_ARTIFACT', 'judgment artifact manifest is missing the complete evidence source path');
  }
  const sourceEvidencePath = path.resolve(worktree, manifest.source_evidence_path);
  assertContainedRegularPath(fsApi, worktree, sourceEvidencePath, 'complete judgment evidence');
  const currentEvidence = readImmutableFile(
    fsApi,
    sourceEvidencePath,
    'complete judgment evidence',
    judgmentEvidenceMaximum(role, trusted.receipt.runtime),
  );
  if (!currentEvidence.length) fail('MISSING_ARTIFACT', 'complete judgment evidence is empty');
  if (!currentEvidence.equals(evidence.content)) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'complete judgment evidence changed after the judgment was sealed');
  }
  let result;
  try {
    result = JSON.parse(findings.content.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT', `archived judgment findings are not valid JSON: ${error.message}`);
  }
  const data = judgmentResultData(result, metadata, input, identity);
  if (manifest.subject !== data.subject
      || manifest.boundary_subject !== metadata.ticket
      || (data.phase !== undefined && manifest.phase !== data.phase)
      || (data.pr !== undefined && manifest.pr !== data.pr)
      || manifest.ticket_set_digest !== data.ticket_set_digest
      || stable(manifest.reviewed) !== stable(data.reviewed)) {
    fail('JUDGMENT_IDENTITY_MISMATCH', 'judgment artifact manifest does not match the authenticated reviewed subject');
  }
  if (!object(manifest.envelope)) fail('MISSING_ARTIFACT', 'judgment artifact is missing its bounded envelope');
  const expectedEnvelope = judgmentEnvelope(data, {
    evidence: { relative: manifest.files.evidence.path, content: evidence.content },
    findings: { relative: manifest.files.findings.path, content: findings.content },
  });
  if (stable(manifest.envelope) !== stable(expectedEnvelope)) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'judgment envelope does not match its complete archived findings');
  }
  if (input.artifactDigest !== undefined && input.artifact_digest !== undefined && input.artifactDigest !== input.artifact_digest) {
    fail('INVALID_ARTIFACT', 'conflicting judgment artifact digest arguments');
  }
  const expectedDigest = input.artifactDigest || input.artifact_digest;
  const actualDigest = digest(manifestBytes);
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    fail('INVALID_ARTIFACT', 'judgment artifact validation requires the expected 64-character manifest digest');
  }
  if (expectedDigest !== actualDigest) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'judgment artifact manifest digest does not match the validated bytes', {
      expected: expectedDigest,
      actual: actualDigest,
    });
  }
  const currentReview = ['arch-review', 'integrator'].includes(role)
    ? authenticateCurrentCoverage({ trusted, result, evidence: evidence.content, identity }) : null;
  if (stable(manifest.current_review || null) !== stable(currentReview))
    fail('REVIEW_COVERAGE_INVALID', 'sealed current contract differs from original native authority');
  if (role === 'arch-review' && trusted.receipt.runtime === 'codex' && !currentReview) {
    require('./codex-arch-review-context.cjs').validateSealedContext({
      result, receipt: trusted.receipt, dispatchId, worktree, ticket: metadata.ticket, pr: data.pr,
      evidence: evidence.content,
      archivePins: [
        { path: path.relative(worktree, manifestResolved), sha256: actualDigest, bytes: manifestBytes.length },
        { path: manifest.files.evidence.path, sha256: evidence.sha256, bytes: evidence.bytes },
        { path: manifest.files.findings.path, sha256: findings.sha256, bytes: findings.bytes },
      ],
    }, { execFileSync: ioFor(input).execFileSync });
  }
  return Object.freeze({
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_kind: 'judgment',
    artifact_ref: manifestResolved,
    artifact_path: manifestResolved,
    artifactRef: manifestResolved,
    artifact_digest: actualDigest,
    artifactDigest: actualDigest,
    envelope: manifest.envelope,
    manifest,
    evidence_index: manifest.envelope.evidence_index,
    evidenceIndex: manifest.envelope.evidence_index,
    findings_index: manifest.envelope.findings_index,
    findingsIndex: manifest.envelope.findings_index,
    files: Object.freeze({
      evidence: Object.freeze({
        path: evidence.path,
        relative: evidence.relative,
        bytes: evidence.bytes,
        sha256: evidence.sha256,
        content: evidence.content.toString('utf8'),
      }),
      findings: Object.freeze({
        path: findings.path,
        relative: findings.relative,
        bytes: findings.bytes,
        sha256: findings.sha256,
        content: findings.content.toString('utf8'),
      }),
    }),
    evidence: evidence.content.toString('utf8'),
    findings: role === 'arch-review' ? { ...result, findings: data.findings } : result,
    evidencePath: evidence.path,
    findingsPath: findings.path,
    role,
    subject: data.subject,
    ticket: metadata.ticket,
    ...(data.phase === undefined ? {} : { phase: data.phase }),
    ...(data.pr === undefined ? {} : { pr: data.pr }),
    head: manifest.head,
    producer_head: manifest.head,
    base: manifest.base,
    integration_base: {
      ref: manifest.base,
      commit: manifest.base_commit,
      tree: manifest.base_tree,
    },
    historical: false,
  });
}

function genericEnvelope(role, metadata, data, files) {
  const evidenceIndex = fileReference(files.evidence.relative, files.evidence.content);
  const findingsIndex = fileReference(files.findings.relative, files.findings.content);
  if (role === 'ci-fix' || role === 'review-fix') {
    return {
      schema: REPAIR_ENVELOPE_SCHEMA,
      version: ENVELOPE_VERSION,
      role,
      ticket: metadata.ticket,
      subject: metadata.ticket,
      pr: data.pr,
      status: data.status,
      pushed: data.pushed,
      summary: capSummary(data.notes),
      notes: capSummary(data.notes),
      hypothesis: capSummary(data.hypothesis),
      evidence_index: evidenceIndex,
      evidence_index_ref: evidenceIndex,
      findings_index: findingsIndex,
      findings_index_ref: findingsIndex,
    };
  }
  return {
    schema: DRIFT_ENVELOPE_SCHEMA,
    version: ENVELOPE_VERSION,
    role,
    ticket: metadata.ticket,
    subject: metadata.ticket,
    verdict: data.verdict,
    moved_count: data.moved_count,
    reuse_candidates_count: data.reuse_candidates_count,
    evidence_count: data.evidence_count,
    summary: capSummary(data.summary),
    integration_base: {
      ref: metadata.identity.base,
      commit: metadata.identity.base_commit,
      tree: metadata.identity.base_tree,
    },
    evidence_index: evidenceIndex,
    evidence_index_ref: evidenceIndex,
    findings_index: findingsIndex,
    findings_index_ref: findingsIndex,
  };
}

function sealRole(value, options) {
  const input = normalizeCall(value, options);
  if (JUDGMENT_ROLES.has(input.role)) return sealJudgment(input);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
  const identity = gitIdentity(input, worktree);
  const metadata = trustedMetadata({ ...input, role }, trusted, identity);
  metadata.trusted = trusted;
  if (input.base === undefined && input.baseRef === undefined) {
    fail('INVALID_ARTIFACT', 'repair/drift artifacts require the integration base ref');
  }
  const result = input.result;
  const data = role === 'drift-check'
    ? driftResultData(result, metadata)
    : repairResultData(result, metadata, input);
  const completeResult = sanitizedRoleResult(result, trusted);
  let findingsBytes;
  try {
    findingsBytes = Buffer.from(`${JSON.stringify(completeResult)}\n`, 'utf8');
  } catch (error) {
    fail('INVALID_RESULT', `complete ${role} result is not JSON-serializable: ${error.message}`);
  }
  const sourceEvidence = readImmutableFile(
    fsApi,
    fixedPath(worktree, producerEvidenceName(role), 'producer evidence'),
    'producer evidence',
    HISTORICAL_ARCHIVE_MAX_BYTES,
  );
  if (!sourceEvidence.length) fail('MISSING_ARTIFACT', `${role} producer evidence is empty`);
  if (findingsBytes.length > HISTORICAL_ARCHIVE_MAX_BYTES)
    fail('ARTIFACT_WRITE', 'complete findings exceeds its complete-byte bound');
  const dispatchId = trusted.dispatchId;
  return withArchivePublication(worktree, () => {
  const archiveEvidence = archivePath(worktree, dispatchId, producerEvidenceName(role), 'archived producer evidence');
  const archiveFindings = archivePath(worktree, dispatchId, FINDINGS_NAME, 'archived role findings');
  const evidenceBytes = sourceEvidence;
  const findingsFileBytes = findingsBytes;
  const files = {
    evidence: {
      relative: path.relative(worktree, archiveEvidence),
      content: evidenceBytes,
    },
    findings: {
      relative: path.relative(worktree, archiveFindings),
      content: findingsFileBytes,
    },
  };
  const envelope = genericEnvelope(role, metadata, data, files);
  if (bytes(JSON.stringify(envelope)) > ENVELOPE_MAX_BYTES) {
    fail('ENVELOPE_TOO_LARGE', `role result envelope exceeds ${ENVELOPE_MAX_BYTES} UTF-8 bytes`);
  }
  const resolution = trusted.record.resolution || {};
  const manifest = {
    schema: ROLE_ARTIFACT_SCHEMA,
    version: ENVELOPE_VERSION,
    artifact_kind: role === 'drift-check' ? 'drift' : 'repair',
    producer_dispatch: dispatchId,
    producer_dispatch_id: dispatchId,
    dispatch_id: dispatchId,
    producer_launch: trusted.receipt.launch_id,
    runtime: metadata.runtime,
    role,
    ticket: metadata.ticket,
    ...(data.pr === undefined ? {} : { pr: data.pr }),
    ...(input.branch !== undefined ? { branch: roleText(input.branch, 'repair branch') } : {}),
    ...(input.planPath !== undefined ? { plan_path: roleText(input.planPath, 'plan path') } : {}),
    repository: metadata.identity.repository,
    repository_realpath: metadata.identity.repository.root,
    repository_identity: metadata.identity.repository.identity,
    worktree: metadata.identity.worktree,
    worktree_realpath: metadata.identity.worktree,
    head: metadata.identity.head,
    head_tree: metadata.identity.head_tree,
    base: metadata.identity.base,
    base_commit: metadata.identity.base_commit,
    base_tree: metadata.identity.base_tree,
    integration_base: {
      ref: metadata.identity.base,
      commit: metadata.identity.base_commit,
      tree: metadata.identity.base_tree,
    },
    policy_hash: metadata.policy_hash,
    dispatch_context: dispatchContextFor(trusted),
    ...(input.attempt !== undefined ? { attempt: roleNumber(input.attempt, 'attempt number') } : {}),
    files: {
      evidence: fileReference(files.evidence.relative, files.evidence.content),
      findings: fileReference(files.findings.relative, files.findings.content),
    },
    envelope,
  };
  const manifestPath = archivePath(worktree, dispatchId, MANIFEST_NAME, 'artifact manifest');
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  preflightArchiveCatalogue(worktree, trusted, manifestPath, manifest, manifestBytes, findingsFileBytes);
  ensureArchiveDirectory(fsApi, worktree, dispatchId);
  writeImmutableArtifactFile(fsApi, archiveEvidence, evidenceBytes, 'archived producer evidence');
  writeImmutableArtifactFile(fsApi, archiveFindings, findingsFileBytes, 'archived role findings');
  const writtenManifest = writeImmutableArtifactFile(fsApi, manifestPath, manifestBytes, 'artifact manifest');
  const artifactDigest = digest(writtenManifest);
  // The host-owned consumer must return only after the exact bytes it is about
  // to hand to the Workflow adapter pass the same receipt/base/path checks used
  // by later direct consumers.  The validated value is intentionally not
  // returned here: readRole would expose complete findings, while the adapter
  // must receive only the bounded envelope and references below.
  validateRoleManifest({
    ...input,
    artifactPath: manifestPath,
    artifactDigest,
  });
  retainArchiveAuthority(worktree, trusted, manifestPath, artifactDigest);
  return Object.freeze({
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_kind: manifest.artifact_kind,
    artifact_ref: manifestPath,
    artifact_path: manifestPath,
    artifactRef: manifestPath,
    artifact_digest: artifactDigest,
    artifactDigest,
    envelope,
    evidence_index: envelope.evidence_index,
    evidenceIndex: envelope.evidence_index,
    findings_index: envelope.findings_index,
    findingsIndex: envelope.findings_index,
    role,
    ticket: metadata.ticket,
    ...(data.pr === undefined ? {} : { pr: data.pr }),
  });
  });
}

function gitObjectIdentity(input, worktree, revision, label) {
  const commit = git(input, worktree, ['rev-parse', '--verify', `${revision}^{commit}`], `${label} commit`);
  const tree = git(input, worktree, ['rev-parse', '--verify', `${commit}^{tree}`], `${label} tree`);
  return { commit: sha(commit, `${label} commit`), tree: sha(tree, `${label} tree`) };
}

function verifyArchivedReference(fsApi, worktree, reference, label, maximum) {
  if (!object(reference)
      || typeof reference.path !== 'string'
      || !reference.path.startsWith(`${ARTIFACT_ARCHIVE_DIR}${path.sep}`)
      || !Number.isInteger(reference.bytes) || reference.bytes < 0
      || reference.content_bytes !== reference.bytes
      || typeof reference.sha256 !== 'string' || reference.sha256 !== reference.digest
      || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
    fail('INVALID_ARTIFACT', `${label} file reference is malformed`);
  }
  const file = path.resolve(worktree, reference.path);
  contained(worktree, file, label);
  const real = safeRealpath(fsApi, file, label);
  if (real !== file) fail('ARTIFACT_PATH_ESCAPE', `${label} may not resolve through a symlink`, { path: file });
  if (maximum !== undefined && reference.bytes > maximum) fail('INVALID_ARTIFACT', label + ' reference exceeds its complete-byte bound');
  const content = readImmutableFile(fsApi, file, label, maximum, maximum === undefined ? undefined : reference.bytes);
  if (content.length !== reference.bytes || digest(content) !== reference.sha256) {
    fail('ARTIFACT_DIGEST_MISMATCH', `${label} content does not match its sealed digest`, { path: file });
  }
  return {
    path: file,
    relative: reference.path,
    bytes: content.length,
    sha256: reference.sha256,
    content,
  };
}

function expectedRoleReference(fsApi, worktree, dispatchId, name, reference, label, maximum) {
  const expected = archiveRelative(dispatchId, name);
  if (!object(reference) || reference.path !== expected) {
    fail('ARTIFACT_IDENTITY_MISMATCH', `${label} does not belong to the authenticated producer dispatch`, {
      expected,
      actual: reference && reference.path,
    });
  }
  return verifyArchivedReference(fsApi, worktree, reference, label, maximum);
}

function manifestValue(manifest, field, expected, code = 'STALE_ARTIFACT') {
  if (manifest[field] !== expected) {
    fail(code, `artifact ${field} does not match the authenticated producer identity`, {
      field, expected, actual: manifest[field],
    });
  }
}

function validateRoleResult(result, role, metadata, input) {
  const data = role === 'drift-check'
    ? driftResultData(result, metadata)
    : repairResultData(result, metadata, input);
  return data;
}

function validateRoleManifest(value, options) {
  const input = normalizeCall(value, options);
  if (JUDGMENT_ROLES.has(input.role)) return validateJudgmentManifest(input);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
  const identity = gitIdentity(input, worktree);
  const historical = input.historical === true || input.allowHistorical === true;
  const dispatchId = trusted.dispatchId;
  const expectedManifestPath = archivePath(worktree, dispatchId, MANIFEST_NAME, 'artifact manifest');
  const requestedPath = input.artifactPath || input.artifact_path || input.artifact_ref || expectedManifestPath;
  const manifestResolved = path.resolve(worktree, requestedPath);
  contained(worktree, manifestResolved, 'artifact manifest');
  if (manifestResolved !== expectedManifestPath) {
    fail('ARTIFACT_IDENTITY_MISMATCH', 'artifact reference is not the archive for the authenticated dispatch', {
      expected: expectedManifestPath,
      actual: manifestResolved,
    });
  }
  const manifestBytes = readImmutableFile(fsApi, manifestResolved, 'artifact manifest');
  const manifestRealpath = safeRealpath(fsApi, manifestResolved, 'artifact manifest');
  if (manifestRealpath !== manifestResolved) {
    fail('ARTIFACT_PATH_ESCAPE', 'artifact manifest may not resolve through a symlink', {
      path: manifestResolved,
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT', `artifact manifest is not valid JSON: ${error.message}`);
  }
  const metadata = trustedMetadata({ ...input, role }, trusted, identity);
  metadata.trusted = trusted;
  if (manifest.schema !== ROLE_ARTIFACT_SCHEMA || manifest.version !== ENVELOPE_VERSION) {
    fail('INVALID_ARTIFACT', 'role artifact manifest schema/version is invalid');
  }
  manifestValue(manifest, 'artifact_kind', role === 'drift-check' ? 'drift' : 'repair', 'INVALID_ARTIFACT');
  for (const [field, expected] of [
    ['producer_dispatch', dispatchId],
    ['producer_dispatch_id', dispatchId],
    ['dispatch_id', dispatchId],
    ['producer_launch', trusted.receipt.launch_id],
    ['runtime', trusted.receipt.runtime],
    ['role', role],
    ['ticket', metadata.ticket],
    ['repository_realpath', identity.repository.root],
    ['repository_identity', identity.repository.identity],
    ['worktree_realpath', identity.worktree],
    ['worktree', identity.worktree],
    ['base', identity.base],
    ['policy_hash', metadata.policy_hash],
  ]) manifestValue(manifest, field, expected);
  const recordedHead = sha(manifest.head, 'artifact producer head');
  const recordedHeadTree = sha(manifest.head_tree, 'artifact producer head tree');
  if (historical) {
    const recorded = gitObjectIdentity(input, worktree, recordedHead, 'recorded producer head');
    if (recorded.tree !== recordedHeadTree) {
      fail('STALE_ARTIFACT', 'historical artifact producer head tree no longer matches the recorded revision');
    }
  } else {
    manifestValue(manifest, 'head', identity.head);
    manifestValue(manifest, 'head_tree', identity.head_tree);
  }
  const recordedBase = {
    commit: sha(manifest.base_commit, 'artifact base commit'),
    tree: sha(manifest.base_tree, 'artifact base tree'),
  };
  const liveBase = { commit: identity.base_commit, tree: identity.base_tree };
  if (historical) {
    const base = gitObjectIdentity(input, worktree, recordedBase.commit, 'recorded integration base');
    if (base.tree !== recordedBase.tree) {
      fail('STALE_ARTIFACT', 'historical artifact integration-base tree no longer matches the recorded revision');
    }
  } else if (recordedBase.commit !== liveBase.commit || recordedBase.tree !== liveBase.tree) {
    fail('STALE_ARTIFACT', 'artifact integration-base identity is stale', {
      expected: liveBase,
      actual: recordedBase,
    });
  }
  if (!object(manifest.repository)
      || manifest.repository.root !== identity.repository.root
      || manifest.repository.identity !== identity.repository.identity) {
    fail('STALE_ARTIFACT', 'artifact repository identity does not match the live repository');
  }
  verifyDispatchContext(manifest, trusted);
  if (role === 'ci-fix' || role === 'review-fix') {
    const expectedPr = input.pr === undefined ? input.prNumber : input.pr;
    roleNumber(expectedPr, 'repair PR');
    manifestValue(manifest, 'pr', expectedPr, 'ARTIFACT_IDENTITY_MISMATCH');
  }
  if (input.branch !== undefined) manifestValue(manifest, 'branch', roleText(input.branch, 'repair branch'), 'ARTIFACT_IDENTITY_MISMATCH');
  if (input.planPath !== undefined) manifestValue(manifest, 'plan_path', roleText(input.planPath, 'plan path'), 'ARTIFACT_IDENTITY_MISMATCH');
  if (!object(manifest.files) || !object(manifest.files.evidence) || !object(manifest.files.findings)) {
    fail('MISSING_ARTIFACT', 'role artifact manifest is missing complete evidence and findings references');
  }
  if (!object(manifest.envelope)) fail('MISSING_ARTIFACT', 'role artifact manifest is missing its bounded envelope');
  if (bytes(JSON.stringify(manifest.envelope)) > ENVELOPE_MAX_BYTES) {
    fail('ENVELOPE_TOO_LARGE', `role artifact envelope exceeds ${ENVELOPE_MAX_BYTES} UTF-8 bytes`);
  }
  if (typeof manifest.envelope.summary !== 'string'
      || Array.from(manifest.envelope.summary).length > SUMMARY_MAX_CHARS) {
    fail('INVALID_ARTIFACT', 'role artifact envelope summary exceeds the 500-character bound');
  }
  const expectedSchema = role === 'drift-check' ? DRIFT_ENVELOPE_SCHEMA : REPAIR_ENVELOPE_SCHEMA;
  if (manifest.envelope.schema !== expectedSchema
      || manifest.envelope.version !== ENVELOPE_VERSION
      || manifest.envelope.role !== role
      || manifest.envelope.ticket !== metadata.ticket
      || manifest.envelope.subject !== metadata.ticket) {
    fail('INVALID_ARTIFACT', 'role artifact envelope does not describe the authenticated role result');
  }
  if (!object(manifest.envelope.evidence_index)
      || !object(manifest.envelope.evidence_index_ref)
      || !object(manifest.envelope.findings_index)
      || !object(manifest.envelope.findings_index_ref)
      || stable(manifest.envelope.evidence_index) !== stable(manifest.envelope.evidence_index_ref)
      || stable(manifest.envelope.findings_index) !== stable(manifest.envelope.findings_index_ref)) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'role artifact index references disagree');
  }
  const evidence = expectedRoleReference(
    fsApi,
    worktree,
    dispatchId,
    producerEvidenceName(role),
    manifest.files.evidence,
    'producer evidence',
    HISTORICAL_ARCHIVE_MAX_BYTES,
  );
  const findings = expectedRoleReference(
    fsApi,
    worktree,
    dispatchId,
    FINDINGS_NAME,
    manifest.files.findings,
    'role findings',
  );
  if (manifest.envelope.evidence_index.sha256 !== evidence.sha256
      || manifest.envelope.evidence_index.bytes !== evidence.bytes
      || manifest.envelope.findings_index.sha256 !== findings.sha256
      || manifest.envelope.findings_index.bytes !== findings.bytes) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'role artifact index does not match complete archived bytes');
  }
  let result;
  try {
    result = JSON.parse(findings.content.toString('utf8'));
  } catch (error) {
    fail('INVALID_ARTIFACT', `archived role findings are not valid JSON: ${error.message}`);
  }
  const data = validateRoleResult(result, role, metadata, input);
  if (role === 'ci-fix' || role === 'review-fix') {
    if (manifest.envelope.status !== data.status
        || manifest.envelope.pushed !== data.pushed
        || manifest.envelope.pr !== data.pr
        || manifest.envelope.notes !== capSummary(data.notes)
        || manifest.envelope.hypothesis !== capSummary(data.hypothesis)) {
      fail('ARTIFACT_DIGEST_MISMATCH', 'repair envelope does not match its complete result');
    }
  } else if (manifest.envelope.verdict !== data.verdict
      || manifest.envelope.moved_count !== data.moved_count
      || manifest.envelope.reuse_candidates_count !== data.reuse_candidates_count
      || manifest.envelope.evidence_count !== data.evidence_count
      || !object(manifest.envelope.integration_base)
      || manifest.envelope.integration_base.ref !== identity.base
      || manifest.envelope.integration_base.commit !== recordedBase.commit
      || manifest.envelope.integration_base.tree !== recordedBase.tree) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'drift envelope does not match its complete findings or base');
  }
  if (input.artifactDigest !== undefined && input.artifact_digest !== undefined
      && input.artifactDigest !== input.artifact_digest) {
    fail('INVALID_ARTIFACT', 'conflicting artifact digest arguments');
  }
  const expectedDigest = input.artifactDigest || input.artifact_digest;
  const actualDigest = digest(manifestBytes);
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    fail('INVALID_ARTIFACT', 'role artifact validation requires the expected 64-character manifest digest');
  }
  if (expectedDigest !== actualDigest) {
    fail('ARTIFACT_DIGEST_MISMATCH', 'role artifact manifest digest does not match the validated bytes', {
      expected: expectedDigest,
      actual: actualDigest,
    });
  }
  const base = {
    schema: ROLE_ARTIFACT_SCHEMA,
    artifact_kind: manifest.artifact_kind,
    artifact_ref: manifestResolved,
    artifact_path: manifestResolved,
    artifactRef: manifestResolved,
    artifact_digest: actualDigest,
    artifactDigest: actualDigest,
    envelope: manifest.envelope,
    manifest,
    evidence_index: manifest.envelope.evidence_index,
    evidenceIndex: manifest.envelope.evidence_index,
    findings_index: manifest.envelope.findings_index,
    findingsIndex: manifest.envelope.findings_index,
    files: Object.freeze({
      evidence: Object.freeze({ ...evidence, content: evidence.content.toString('utf8') }),
      findings: Object.freeze({ ...findings, content: findings.content.toString('utf8') }),
    }),
    evidence: evidence.content.toString('utf8'),
    findings: result,
    evidencePath: evidence.path,
    findingsPath: findings.path,
    role,
    ticket: metadata.ticket,
    ...(manifest.pr === undefined ? {} : { pr: manifest.pr }),
    head: manifest.head,
    producer_head: manifest.head,
    base: manifest.base,
    integration_base: manifest.integration_base,
    historical,
  };
  return Object.freeze(base);
}

function validateRole(value, options) {
  const input = normalizeCall(value, options);
  // The executor's original fixed-path contract stays byte-for-byte compatible.
  // Role artifacts are selected explicitly by their authenticated repair/drift
  // role, so a caller cannot turn an executor manifest into a repair result by
  // supplying a result-shaped object later.
  const role = input.role;
  if (JUDGMENT_ROLES.has(role)) return validateJudgmentManifest(input);
  if (!REPAIR_ROLES.has(role) && role !== 'drift-check') return validateExecutor(input);
  return validateRoleManifest(input);
}

function seal(value, options) {
  const input = normalizeCall(value, options);
  const role = input.role;
  if (JUDGMENT_ROLES.has(role)) return sealJudgment(input);
  if (!REPAIR_ROLES.has(role) && role !== 'drift-check') return sealExecutor(input);
  return sealRole(input);
}

function readRole(value, options) {
  const input = normalizeCall(value, options);
  const validated = validateRole(input);
  if (!REPAIR_ROLES.has(validated.role) && validated.role !== 'drift-check' && !JUDGMENT_ROLES.has(validated.role)) {
    return readExecutor(input);
  }
  const hasRange = input.evidenceRange !== undefined || input.evidence_range !== undefined;
  const requested = range(input.evidenceRange || input.evidence_range);
  if (hasRange && !requested) fail('INVALID_INPUT', 'evidence range must contain two non-negative integer offsets');
  if (!requested) {
    recordArtifactRead(input, validated, [validated.files.evidence, validated.files.findings]);
    return validated;
  }
  const targeted = Object.freeze({
    schema: validated.schema,
    artifact_kind: validated.artifact_kind,
    artifact_ref: validated.artifact_ref,
    artifact_path: validated.artifact_path,
    artifact_digest: validated.artifact_digest,
    envelope: validated.envelope,
    manifest: validated.manifest,
    evidence_index: validated.evidence_index,
    evidenceIndex: validated.evidenceIndex,
    findings_index: validated.findings_index,
    findingsIndex: validated.findingsIndex,
    files: Object.freeze({
      evidence: Object.freeze({
        path: validated.files.evidence.path,
        bytes: validated.files.evidence.bytes,
        sha256: validated.files.evidence.sha256,
      }),
      findings: Object.freeze({
        path: validated.files.findings.path,
        bytes: validated.files.findings.bytes,
        sha256: validated.files.findings.sha256,
      }),
    }),
    role: validated.role,
    ticket: validated.ticket,
    ...(validated.subject === undefined ? {} : { subject: validated.subject }),
    ...(validated.phase === undefined ? {} : { phase: validated.phase }),
    ...(validated.pr === undefined ? {} : { pr: validated.pr }),
    head: validated.head,
    producer_head: validated.producer_head,
    base: validated.base,
    integration_base: validated.integration_base,
    historical: validated.historical,
    evidence_range: Object.freeze({
      start: requested[0],
      end: requested[1],
      content: Array.from(validated.evidence).slice(requested[0], requested[1]).join(''),
    }),
  });
  recordArtifactRead(input, validated, [{
    ...validated.files.evidence,
    content: targeted.evidence_range.content,
  }], 'selected');
  return targeted;
}

function read(value, options) {
  const input = normalizeCall(value, options);
  if (REPAIR_ROLES.has(input.role) || input.role === 'drift-check' || JUDGMENT_ROLES.has(input.role)) return readRole(input);
  return readExecutor(input);
}

// Keep the original public names stable while routing explicit repair, drift,
// and judgment roles through their manifest-backed validators.
const validate = validateRole;

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const values = {};
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('INVALID_INPUT', `unknown argument ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === 'help') { values.help = true; continue; }
    if (key === 'historical' || key === 'allowHistorical') {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('INVALID_INPUT', `missing value for --${key}`);
    values[key] = value;
    index++;
  }
  return { command, values };
}

function required(values, name) {
  if (typeof values[name] !== 'string' || values[name].trim() === '') fail('INVALID_INPUT', `--${name} is required`);
  return values[name];
}

// CLI stdout is an orchestration channel. Keep it to references and bounded
// metadata; complete documents are returned only to an explicit --*-out file,
// while an evidence range is an explicitly bounded exception.
function cliValue(value) {
  if (!object(value)) return value;
  const output = { ...value };
  if (object(value.files)) {
    output.files = Object.fromEntries(Object.entries(value.files).map(([name, file]) => {
      if (!object(file)) return [name, file];
      const { content: ignoredContent, ...reference } = file;
      return [name, reference];
    }));
  }
  delete output.pr_body;
  delete output.evidence;
  delete output.findings;
  return output;
}

function cli(argv) {
  const { command, values } = parseArgs(argv);
  if (command === 'help' || values.help) {
    process.stdout.write('usage: role-artifact.cjs <prepare|seal|validate|read> --worktree PATH [--role ROLE] [--base REF --boundary-store PATH --dispatch-id ID] [--phase PHASE --ticket-set-file PATH --evidence-path PATH] [options]\n');
    return 0;
  }
  if (command === 'prepare') {
    const prepared = prepareRoleArtifact({
      worktreePath: required(values, 'worktree'),
      role: required(values, 'role'),
      ...(values.phase ? { phase: values.phase } : {}),
      ...(values.evidencePath ? { evidencePath: values.evidencePath } : {}),
    });
    process.stdout.write(`${JSON.stringify(cliValue(prepared))}\n`);
    return 0;
  }
  const common = {
    worktreePath: required(values, 'worktree'),
    base: required(values, 'base'),
    boundaryStore: required(values, 'boundaryStore'),
    dispatchId: required(values, 'dispatchId'),
    ...(values.role ? { role: values.role } : {}),
    ...(values.ticket ? { ticket: values.ticket } : {}),
    ...(values.pr ? { pr: Number(values.pr) } : {}),
    ...(values.branch ? { branch: values.branch } : {}),
    ...(values.planPath ? { planPath: values.planPath } : {}),
    ...(values.phase ? { phase: values.phase } : {}),
    ...(values.evidencePath ? { evidencePath: values.evidencePath } : {}),
    ...(values.attempt ? { attempt: Number(values.attempt) } : {}),
    ...(values.historical ? { historical: true } : {}),
  };
  if (values.ticketSetFile) {
    try {
      common.ticketSet = JSON.parse(fs.readFileSync(values.ticketSetFile, 'utf8'));
    } catch (error) {
      fail('INVALID_INPUT', `--ticket-set-file could not be read: ${error.message}`);
    }
  }
  let value;
  if (command === 'seal') {
    const resultFile = required(values, 'resultFile');
    let result;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (error) {
      fail('INVALID_INPUT', `--result-file could not be read: ${error.message}`);
    }
    value = seal({ ...common, result });
  } else if (command === 'validate') {
    value = validate({
      ...common,
      ...(values.artifact ? { artifactPath: values.artifact } : {}),
      ...(values.artifactDigest ? { artifactDigest: values.artifactDigest } : {}),
    });
  } else if (command === 'read') {
    if ((values.evidenceStart === undefined) !== (values.evidenceEnd === undefined)) {
      fail('INVALID_INPUT', '--evidence-start and --evidence-end must be provided together');
    }
    value = read({
      ...common,
      ...(values.artifact ? { artifactPath: values.artifact } : {}),
      ...(values.artifactDigest ? { artifactDigest: values.artifactDigest } : {}),
      ...(values.evidenceStart !== undefined || values.evidenceEnd !== undefined
        ? { evidenceRange: [Number(values.evidenceStart), Number(values.evidenceEnd)] } : {}),
    });
    if (values.prBodyOut) {
      if (value.pr_body === undefined) fail('INVALID_INPUT', '--pr-body-out cannot be combined with an evidence range');
      fs.writeFileSync(values.prBodyOut, value.pr_body, 'utf8');
    }
    if (values.evidenceOut) {
      const evidence = value.evidence === undefined
        ? value.evidence_range && value.evidence_range.content
        : value.evidence;
      if (evidence === undefined) fail('INVALID_INPUT', '--evidence-out could not find a validated evidence snapshot');
      fs.writeFileSync(values.evidenceOut, evidence, 'utf8');
    }
    if (values.findingsOut) {
      if (value.findings === undefined) fail('INVALID_INPUT', '--findings-out requires a full read without an evidence range');
      fs.writeFileSync(values.findingsOut, `${JSON.stringify(value.findings, null, 2)}\n`, 'utf8');
    }
  } else {
    fail('INVALID_INPUT', `unknown role-artifact command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(cliValue(value))}\n`);
  return 0;
}

module.exports = Object.freeze(Object.assign(Object.create(null), {
  ROLE_ARTIFACT_SCHEMA,
  ENVELOPE_SCHEMA,
  ENVELOPE_MAX_BYTES,
  SUMMARY_MAX_CHARS,
  MANIFEST_NAME,
  PR_BODY_NAME,
  EVIDENCE_NAME,
  REPAIR_EVIDENCE_NAME,
  DRIFT_EVIDENCE_NAME,
  ARTIFACT_ARCHIVE_DIR,
  FINDINGS_NAME,
  REPAIR_ENVELOPE_SCHEMA,
  DRIFT_ENVELOPE_SCHEMA,
  JUDGMENT_ENVELOPE_SCHEMA,
  JUDGMENT_EVIDENCE_NAMES,
  isAuthenticatedReviewProgress,
  readReviewProgress,
  persistReviewProgress,
  finishOriginalReviewObservation,
  claimReviewContinuation,
  completeReviewContinuation,
  validateReviewContinuationEvidence,
  registerPlanningContainmentBaseline,
  readPlanningContainmentBaseline,
  architectureAuthorityPath,
  registerArchitectureAuthority,
  authenticateArchitectureSources,
  architectureSourceIdentity,
  assertArchivePin,
  archiveAuthorityNamespace,
  archiveAuthorityDirectory,
  authenticatedArchivePins,
  registerPhaseArchiveRoster,
  readPhaseArchiveRoster,
  selectPhaseArchives,
  selectReviewBaseline,
  isAuthenticatedReviewBaseline,
  currentArchitectureVerdict,
  currentIntegrationVerdict,
  prepareCurrentReviewInput,
  phaseArchitectureEvidence,
  phaseArchitectureEvidenceDigest,
  assertArchiveInventory,
  historicalBookkeepingPins,
  trustedBookkeepingMutation,
  admitHistoricalArchive,
  prepareRoleArtifact,
  sealRole,
  sealJudgment,
  validateJudgmentManifest,
  validateRole,
  readRole: readRole,
  seal,
  validate,
  read,
  sealRoleArtifact: seal,
  validateRoleArtifact: validate,
  readRoleArtifact: read,
}));

if (require.main === module) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: {
      name: error.name,
      code: error.code || 'ARTIFACT_FAILURE',
      message: error.message,
    } })}\n`);
    process.exitCode = 1;
  }
}
