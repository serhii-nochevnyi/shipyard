#!/usr/bin/env node
'use strict';

// Executor results cross two trust boundaries: the runtime receipt is owned by
// dispatch-boundary, while the worktree files are agent-owned.  This module is
// deliberately small and dependency-free so the trusted host and the direct
// delivery consumer use exactly the same checks.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  boundaryError,
  createDurableRecorder,
  isDurableRecorder,
} = require('./dispatch-boundary.cjs');

const ROLE_ARTIFACT_SCHEMA = 'shipyard.role-artifact.v1';
const ENVELOPE_SCHEMA = 'shipyard.executor-result.v1';
const ENVELOPE_VERSION = 1;
const SUMMARY_MAX_CHARS = 500;
const ENVELOPE_MAX_BYTES = 8192;
const EVIDENCE_RANGE_MAX_CHARS = 4096;
const MANIFEST_NAME = '.shipyard-role-artifact.json';
const PR_BODY_NAME = '.shipyard-pr-body.md';
const EVIDENCE_NAME = '.shipyard-evidence.md';

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

function readImmutableFile(fsApi, file, label) {
  let before;
  try {
    before = fsApi.lstatSync(file);
  } catch (error) {
    fail('MISSING_ARTIFACT', `${label} is missing: ${error.message}`, { path: file });
  }
  if (before.isSymbolicLink()) fail('ARTIFACT_PATH_ESCAPE', `${label} may not be a symlink`, { path: file });
  if (!before.isFile()) fail('INVALID_ARTIFACT', `${label} must be a regular file`, { path: file });
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
  const base = nonEmpty(input.base || input.baseRef, 'base revision');
  const baseCommit = git(input, worktree, ['rev-parse', '--verify', `${base}^{commit}`], 'base revision');
  const baseTree = git(input, worktree, ['rev-parse', '--verify', `${baseCommit}^{tree}`], 'base tree');
  const worktreeRealpath = safeRealpath(ioFor(input).fs, worktree, 'worktree');
  return {
    repository: { root, identity: common },
    worktree: worktreeRealpath,
    head,
    head_tree: headTree,
    base,
    base_commit: baseCommit,
    base_tree: baseTree,
  };
}

function recorderFor(input) {
  if (isDurableRecorder(input.recorder)) return input.recorder;
  if (typeof input.boundaryStore === 'string' && input.boundaryStore.trim()) {
    return createDurableRecorder(input.boundaryStore);
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
  if (proof.dispatch_id !== dispatchId
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
  nonEmpty(record.receipt.runtime, 'receipt runtime');
  nonEmpty(record.receipt.role, 'receipt role');
  nonEmpty(record.receipt.launch_id, 'receipt launch id');
  nonEmpty(record.receipt.policy_hash, 'receipt policy hash');
  return { recorder, dispatchId, record, receipt: record.receipt };
}

function assertAgentReceiptIsNotForged(result, trusted) {
  if (!object(result)) fail('INVALID_RESULT', 'executor result must be an object');
  for (const field of ['receipt', 'application_receipt', 'applicationEvidence']) {
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
      fsApi.linkSync(temp, file);
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

function seal(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const identity = gitIdentity(input, worktree);
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
  assertTicketMarker(files.pr_body.content, metadata.ticket);
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

function validate(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const identity = gitIdentity(input, worktree);
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
  assertTicketMarker(prBody.content, metadata.ticket);
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

function range(value) {
  if (!Array.isArray(value) || value.length !== 2
      || !Number.isInteger(value[0]) || !Number.isInteger(value[1])
      || value[0] < 0 || value[1] < value[0]
      || value[1] - value[0] > EVIDENCE_RANGE_MAX_CHARS) return null;
  return value;
}

function read(value, options) {
  const input = normalizeCall(value, options);
  const validated = validate(input);
  const hasRange = input.evidenceRange !== undefined || input.evidence_range !== undefined;
  const requested = range(input.evidenceRange || input.evidence_range);
  if (hasRange && !requested) {
    fail('INVALID_INPUT', `evidence range must contain two non-negative integer offsets no more than ${EVIDENCE_RANGE_MAX_CHARS} characters apart`);
  }
  if (!requested) return validated;
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
  return Object.freeze({
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
}

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const values = {};
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('INVALID_INPUT', `unknown argument ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === 'help') { values.help = true; continue; }
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
    process.stdout.write('usage: role-artifact.cjs <seal|validate|read> --worktree PATH --base REF --boundary-store PATH --dispatch-id ID [options]\n');
    return 0;
  }
  const common = {
    worktreePath: required(values, 'worktree'),
    base: required(values, 'base'),
    boundaryStore: required(values, 'boundaryStore'),
    dispatchId: required(values, 'dispatchId'),
    ...(values.role ? { role: values.role } : {}),
    ...(values.ticket ? { ticket: values.ticket } : {}),
  };
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
  } else {
    fail('INVALID_INPUT', `unknown role-artifact command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(cliValue(value))}\n`);
  return 0;
}

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

module.exports = Object.freeze({
  ROLE_ARTIFACT_SCHEMA,
  ENVELOPE_SCHEMA,
  ENVELOPE_MAX_BYTES,
  SUMMARY_MAX_CHARS,
  MANIFEST_NAME,
  PR_BODY_NAME,
  EVIDENCE_NAME,
  seal,
  validate,
  read,
  sealRoleArtifact: seal,
  validateRoleArtifact: validate,
  readRoleArtifact: read,
});
