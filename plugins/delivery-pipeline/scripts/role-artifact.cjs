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
const {
  recordMeasurement,
  ESTIMATOR_VERSION,
} = require('./orchestration-overhead.cjs');

const ROLE_ARTIFACT_SCHEMA = 'shipyard.role-artifact.v1';
const ENVELOPE_SCHEMA = 'shipyard.executor-result.v1';
const ENVELOPE_VERSION = 1;
const SUMMARY_MAX_CHARS = 500;
const ENVELOPE_MAX_BYTES = 8192;
const EVIDENCE_RANGE_MAX_CHARS = 4096;
const MANIFEST_NAME = '.shipyard-role-artifact.json';
const PR_BODY_NAME = '.shipyard-pr-body.md';
const EVIDENCE_NAME = '.shipyard-evidence.md';
const REPAIR_EVIDENCE_NAME = '.shipyard-repair-evidence.md';
const DRIFT_EVIDENCE_NAME = '.shipyard-drift-evidence.md';
const ARTIFACT_ARCHIVE_DIR = '.shipyard-role-artifacts';
const FINDINGS_NAME = 'findings.json';
const REPAIR_ENVELOPE_SCHEMA = 'shipyard.repair-result.v1';
const DRIFT_ENVELOPE_SCHEMA = 'shipyard.drift-result.v1';
const JUDGMENT_ENVELOPE_SCHEMA = 'shipyard.judgment-result.v1';
const REPAIR_ROLES = new Set(['ci-fix', 'review-fix']);
const JUDGMENT_ROLES = new Set(['arch-review', 'pr-sentinel', 'integrator']);
const JUDGMENT_EVIDENCE_NAMES = Object.freeze({
  'arch-review': '.shipyard-arch-review-evidence.md',
  'pr-sentinel': '.shipyard-sentinel-evidence.md',
  integrator: 'INTEGRATION.md',
});
const SENTINEL_PERFORMED_STATUSES = new Set(['complete', 'handed-back']);
const SENTINEL_REFUSED_STATUSES = new Set(['refused']);

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

function sealExecutor(value, options) {
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

function validateExecutor(value, options) {
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
          fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
          stat = fsApi.lstatSync(directory);
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

function writeImmutableArtifactFile(fsApi, file, content, label) {
  const value = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content), 'utf8');
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fsApi.existsSync(file)) {
      const existing = readImmutableFile(fsApi, file, label);
      if (!existing.equals(value)) {
        fail('ARTIFACT_WRITE', `${label} already exists with different bytes`, { path: file });
      }
      return existing;
    }
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fsApi.writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
    try {
      // link() keeps a retry from replacing an archive that has already been
      // authenticated for this dispatch.
      fsApi.linkSync(temp, file);
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      const existing = readImmutableFile(fsApi, file, label);
      if (!existing.equals(value)) {
        fail('ARTIFACT_WRITE', `${label} was published concurrently with different bytes`, { path: file });
      }
      return existing;
    } finally {
      try { fsApi.unlinkSync(temp); } catch (_) { /* linked or raced */ }
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
      fail('INCOMPLETE_FINDING', `${role} finding ${index} has unsupported type ${JSON.stringify(rawType)}`);
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
  if (role !== 'pr-sentinel' && role !== 'integrator') return { entries: [], digest: null };
  const supplied = aliasValue(input, ['ticketSet', 'ticket_set'], `${role} input ticket set`);
  const resultValue = aliasValue(result, ['ticket_set', 'ticketSet'], `${role} result ticket set`);
  if (supplied === undefined) fail('MISSING_JUDGMENT_CONTEXT', `${role} requires the guarded/merged ticket set before dispatch`);
  if (resultValue === undefined) fail('MISSING_ARTIFACT', `${role} result must repeat the complete ticket set`);
  const expected = canonicalTicketSet(supplied, `${role} ticket set`);
  const actual = canonicalTicketSet(resultValue, `${role} result ticket set`);
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
    if (verdict === 'conform' && findings.finding_count !== 0) {
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
      ticket_set_digest: null,
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

function sealJudgment(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
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
  const sourceEvidence = readImmutableFile(fsApi, evidencePath, 'complete judgment evidence');
  if (!sourceEvidence.length) fail('MISSING_ARTIFACT', 'complete judgment evidence is empty');
  const completeResult = sanitizedRoleResult(result, trusted);
  let findingsBytes;
  try {
    findingsBytes = Buffer.from(`${JSON.stringify(completeResult)}\n`, 'utf8');
  } catch (error) {
    fail('INVALID_RESULT', `complete ${role} judgment is not JSON-serializable: ${error.message}`);
  }
  const dispatchId = trusted.dispatchId;
  ensureArchiveDirectory(fsApi, worktree, dispatchId);
  const archiveEvidence = archivePath(worktree, dispatchId, JUDGMENT_EVIDENCE_NAMES[role], 'archived judgment evidence');
  const archiveFindings = archivePath(worktree, dispatchId, FINDINGS_NAME, 'archived judgment findings');
  const evidenceBytes = writeImmutableArtifactFile(fsApi, archiveEvidence, sourceEvidence, 'archived judgment evidence');
  const findingsFileBytes = writeImmutableArtifactFile(fsApi, archiveFindings, findingsBytes, 'archived judgment findings');
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
  const manifestPath = archivePath(worktree, dispatchId, MANIFEST_NAME, 'judgment artifact manifest');
  const manifestBytes = writeImmutableArtifactFile(
    fsApi,
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
    'judgment artifact manifest',
  );
  const artifactDigest = digest(manifestBytes);
  validateJudgmentManifest({ ...input, artifactPath: manifestPath, artifactDigest });
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
}

function validateJudgmentManifest(value, options) {
  const input = normalizeCall(value, options);
  const fsApi = ioFor(input).fs;
  const worktree = safeRealpath(fsApi, input.worktreePath, 'worktree');
  const trusted = trustedRecord(input);
  const role = artifactRole(input, trusted);
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
  const manifestBytes = readImmutableFile(fsApi, manifestResolved, 'judgment artifact manifest');
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
  const evidence = expectedRoleReference(fsApi, worktree, dispatchId, JUDGMENT_EVIDENCE_NAMES[role], manifest.files.evidence, 'judgment evidence');
  const findings = expectedRoleReference(fsApi, worktree, dispatchId, FINDINGS_NAME, manifest.files.findings, 'judgment findings');
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
    findings: result,
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
  );
  if (!sourceEvidence.length) fail('MISSING_ARTIFACT', `${role} producer evidence is empty`);
  const dispatchId = trusted.dispatchId;
  ensureArchiveDirectory(fsApi, worktree, dispatchId);
  const archiveEvidence = archivePath(worktree, dispatchId, producerEvidenceName(role), 'archived producer evidence');
  const archiveFindings = archivePath(worktree, dispatchId, FINDINGS_NAME, 'archived role findings');
  const evidenceBytes = writeImmutableArtifactFile(fsApi, archiveEvidence, sourceEvidence, 'archived producer evidence');
  const findingsFileBytes = writeImmutableArtifactFile(fsApi, archiveFindings, findingsBytes, 'archived role findings');
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
}

function gitObjectIdentity(input, worktree, revision, label) {
  const commit = git(input, worktree, ['rev-parse', '--verify', `${revision}^{commit}`], `${label} commit`);
  const tree = git(input, worktree, ['rev-parse', '--verify', `${commit}^{tree}`], `${label} tree`);
  return { commit: sha(commit, `${label} commit`), tree: sha(tree, `${label} tree`) };
}

function verifyArchivedReference(fsApi, worktree, reference, label) {
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
  const content = readImmutableFile(fsApi, file, label);
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

function expectedRoleReference(fsApi, worktree, dispatchId, name, reference, label) {
  const expected = archiveRelative(dispatchId, name);
  if (!object(reference) || reference.path !== expected) {
    fail('ARTIFACT_IDENTITY_MISMATCH', `${label} does not belong to the authenticated producer dispatch`, {
      expected,
      actual: reference && reference.path,
    });
  }
  return verifyArchivedReference(fsApi, worktree, reference, label);
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
  REPAIR_EVIDENCE_NAME,
  DRIFT_EVIDENCE_NAME,
  ARTIFACT_ARCHIVE_DIR,
  FINDINGS_NAME,
  REPAIR_ENVELOPE_SCHEMA,
  DRIFT_ENVELOPE_SCHEMA,
  JUDGMENT_ENVELOPE_SCHEMA,
  JUDGMENT_EVIDENCE_NAMES,
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
});
