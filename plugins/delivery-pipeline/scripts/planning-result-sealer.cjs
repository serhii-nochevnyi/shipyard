'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { SUMMARY_MAX_CHARS, registerPlanningContainmentBaseline, readPlanningContainmentBaseline } = require('./role-artifact.cjs');

const RESEARCH_ARTIFACT_MAX_BYTES = 1024 * 1024;
const DECOMPOSITION_PLAN_MAX_BYTES = 1024 * 1024;
const DECOMPOSITION_MAX_PLANS = 128;
const LINE_PATTERN = /^((?:INV-[A-Za-z0-9-]+)):(system-state|alternatives|constraints|risks)$/;
const RESEARCH_LINE_IDS = Object.freeze(['system-state', 'alternatives', 'constraints', 'risks']);
const containmentBaselines = new WeakMap();

function refuse(code, message) {
  const error = new Error(`planning-result-sealer: ${message}`);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function capSummary(value, maxChars) {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars - 3).join('')}...`;
}

function git(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  } catch (error) {
    refuse('RESEARCH_GIT_FAILED', `Git command failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function sealResearch({ root, scope, lines, limits } = {}) {
  if (typeof root !== 'string' || !root.trim()) refuse('RESEARCH_ROOT_INVALID', 'sealResearch requires an archive root');
  if (!object(scope) || typeof scope.worktree !== 'string' || !scope.worktree.trim()) {
    refuse('RESEARCH_SCOPE_INVALID', 'sealResearch requires a scope with a worktree path');
  }
  if (!object(lines)) refuse('RESEARCH_LINES_INVALID', 'sealResearch requires the line artifact, result, and record');
  const { artifact, result, record } = lines;
  if (!object(artifact)) refuse('RESEARCH_ARTIFACT_INVALID', 'sealResearch requires artifact metadata');
  if (!object(record)) refuse('RESEARCH_RECORD_INVALID', 'sealResearch requires the dispatch record');
  const bounds = object(limits) ? limits : {};
  const summaryMaxChars = Number.isInteger(bounds.summaryMaxChars) ? bounds.summaryMaxChars : SUMMARY_MAX_CHARS;
  const artifactMaxBytes = Number.isInteger(bounds.artifactMaxBytes) ? bounds.artifactMaxBytes : RESEARCH_ARTIFACT_MAX_BYTES;

  const match = LINE_PATTERN.exec(artifact.subject || '');
  if (!match) refuse('RESEARCH_SUBJECT_INVALID', `research subject ${JSON.stringify(artifact.subject)} is not a recognized <INV-ID>:<line> identity`);
  if (artifact.role !== 'research') refuse('RESEARCH_ROLE_INVALID', `research artifact role must be research, not ${JSON.stringify(artifact.role)}`);
  if (artifact.ticket !== artifact.subject) refuse('RESEARCH_TICKET_MISMATCH', `research ticket ${JSON.stringify(artifact.ticket)} does not match its subject ${JSON.stringify(artifact.subject)}`);
  if (!object(result)) refuse('RESEARCH_LINE_MISSING', `research line ${match[2]} has no result`);
  if (result.id !== match[2]) refuse('RESEARCH_LINE_MISMATCH', `research result id ${JSON.stringify(result.id)} does not match line ${match[2]}`);
  if (!['completed', 'blocked'].includes(result.status)) refuse('RESEARCH_STATUS_INVALID', `research line ${match[2]} status must be completed or blocked, not ${JSON.stringify(result.status)}`);
  if (typeof result.summary !== 'string') refuse('RESEARCH_SUMMARY_TYPE_INVALID', `research line ${match[2]} summary must be a string`);
  if (!object(record.receipt)) refuse('RESEARCH_RECEIPT_MISSING', `research line ${match[2]} has no dispatch receipt`);
  if (record.receipt.compliance !== 'verified') refuse('RESEARCH_RECEIPT_UNVERIFIED', `research line ${match[2]} receipt is not verified`);
  if (typeof record.receipt.dispatch_id !== 'string') refuse('RESEARCH_DISPATCH_ID_TYPE_INVALID', `research line ${match[2]} dispatch id must be a string`);
  if (!record.receipt.dispatch_id) refuse('RESEARCH_DISPATCH_ID_MISSING', `research line ${match[2]} dispatch id is required`);

  const summaryLength = Array.from(result.summary).length;
  if (summaryLength > summaryMaxChars) {
    result.summary = capSummary(result.summary, summaryMaxChars);
    process.stderr.write(`planning-result-sealer: RESEARCH_SUMMARY_TOO_LONG: research line ${result.id} summary was ${summaryLength} characters; bounded to ${summaryMaxChars} (full finding at ${artifact.artifactPath})\n`);
  }

  const worktree = fs.realpathSync(scope.worktree);
  if (fs.realpathSync(artifact.worktreePath) !== worktree) {
    refuse('RESEARCH_WORKTREE_MISMATCH', `research line ${result.id} worktree differs from the authenticated run`);
  }
  if (artifact.sourceRevision !== git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])) {
    refuse('RESEARCH_REVISION_MISMATCH', `research line ${result.id} revision differs from the authenticated run`);
  }
  if (artifact.policyHash !== record.receipt.policy_hash) {
    refuse('RESEARCH_POLICY_MISMATCH', `research line ${result.id} policy differs from the authenticated dispatch`);
  }
  const investigation = path.join(artifact.worktreePath, '.planning', 'investigations', match[1]);
  const canonicalInvestigation = path.join(worktree, '.planning', 'investigations', match[1]);
  if (fs.realpathSync(investigation) !== canonicalInvestigation) {
    refuse('RESEARCH_INVESTIGATION_PATH_INVALID', `research line ${result.id} investigation directory is not canonical`);
  }
  const file = artifact.artifactPath;
  if (typeof file !== 'string' || !path.isAbsolute(file)
      || path.relative(investigation, file).startsWith('..' + path.sep)
      || path.relative(investigation, file) === '..'
      || path.relative(investigation, file) === '') {
    refuse('RESEARCH_ARTIFACT_PATH_ESCAPE', `research line ${result.id} artifact is outside its investigation: ${file}`);
  }
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) refuse('RESEARCH_ARTIFACT_SYMLINK', `research line ${result.id} artifact may not be a symlink: ${file}`);
  if (!stat.isFile()) refuse('RESEARCH_ARTIFACT_NOT_REGULAR', `research line ${result.id} artifact must be a regular file: ${file}`);
  if (stat.size > artifactMaxBytes) refuse('RESEARCH_ARTIFACT_TOO_LARGE', `research line ${result.id} artifact exceeds the bounded size cap: ${file}`);
  if (fs.realpathSync(file) !== path.join(worktree, path.relative(artifact.worktreePath, file))) {
    refuse('RESEARCH_ARTIFACT_PATH_ESCAPE', `research line ${result.id} artifact resolves outside its investigation: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    refuse('RESEARCH_ARTIFACT_MUTATED', `research line ${result.id} artifact changed while it was being sealed: ${file}`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const producer = Object.freeze({ path: file, bytes: bytes.length, content_bytes: bytes.length,
    sha256, digest: sha256 });
  if (!object(result.artifact) || Object.keys(producer).some((key) => result.artifact[key] !== producer[key])) {
    refuse('RESEARCH_PRODUCER_MISMATCH', `research line ${result.id} producer reference differs from the artifact bytes: ${file}`);
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifestName = crypto.createHash('sha256').update(record.receipt.dispatch_id).digest('hex');
  const archivePath = path.join(root, `${manifestName}.md`);
  fs.writeFileSync(archivePath, bytes, { flag: 'wx', mode: 0o600 });
  const index = Object.freeze({ ...producer, path: archivePath });
  const envelope = Object.freeze({ schema: 'shipyard.research-result.v1', version: 1,
    role: 'research', subject: artifact.subject, source_revision: artifact.sourceRevision,
    repository: artifact.repository, policy_hash: artifact.policyHash, status: result.status,
    summary: result.summary, artifact_index: index, evidence_index: index });
  const manifest = Buffer.from(JSON.stringify({ schema: 'shipyard.role-artifact.v1',
    dispatch_id: record.receipt.dispatch_id, envelope }) + '\n');
  const manifestPath = path.join(root, `${manifestName}.json`);
  fs.writeFileSync(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ schema: 'shipyard.role-artifact.v1', artifact_ref: manifestPath,
    artifact_digest: crypto.createHash('sha256').update(manifest).digest('hex'),
    envelope, evidence_index: index, artifact_index: index });
}

function verifySealedLine({ root, scope, line } = {}) {
  if (typeof root !== 'string' || !root.trim()) refuse('RESEARCH_VERIFY_ROOT_INVALID', 'verifySealedLine requires an archive root');
  if (!object(scope) || typeof scope.invId !== 'string' || !/^INV-[A-Za-z0-9-]+$/.test(scope.invId)
      || typeof scope.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(scope.sourceRevision)
      || typeof scope.repository !== 'string' || !scope.repository.trim()
      || typeof scope.policyHash !== 'string' || !/^[a-f0-9]{64}$/i.test(scope.policyHash)) {
    refuse('RESEARCH_VERIFY_SCOPE_INVALID', 'verifySealedLine requires the authenticated investigation id, revision, repository, and policy hash');
  }
  if (!object(line) || typeof line.id !== 'string' || !RESEARCH_LINE_IDS.includes(line.id)) {
    refuse('RESEARCH_VERIFY_LINE_INVALID', `verifySealedLine requires a recognized research line id, not ${JSON.stringify(line && line.id)}`);
  }
  if (typeof line.artifact_ref !== 'string' || !line.artifact_ref.trim()
      || typeof line.artifact_digest !== 'string' || !/^[a-f0-9]{64}$/.test(line.artifact_digest)) {
    refuse('RESEARCH_VERIFY_REFERENCE_INVALID', `sealed line ${line.id} requires a bounded manifest reference and digest`);
  }
  const archiveRoot = fs.realpathSync(root);
  let stat;
  try {
    stat = fs.lstatSync(line.artifact_ref);
  } catch {
    refuse('RESEARCH_VERIFY_MANIFEST_MISSING', `sealed line ${line.id} manifest is missing: ${line.artifact_ref}`);
  }
  if (stat.isSymbolicLink()) refuse('RESEARCH_VERIFY_MANIFEST_SYMLINK', `sealed line ${line.id} manifest may not be a symlink: ${line.artifact_ref}`);
  if (!stat.isFile()) refuse('RESEARCH_VERIFY_MANIFEST_NOT_REGULAR', `sealed line ${line.id} manifest must be a regular file: ${line.artifact_ref}`);
  if (path.dirname(fs.realpathSync(line.artifact_ref)) !== archiveRoot) {
    refuse('RESEARCH_VERIFY_MANIFEST_PATH_ESCAPE', `sealed line ${line.id} manifest is outside its archive root: ${line.artifact_ref}`);
  }
  const manifestBytes = fs.readFileSync(line.artifact_ref);
  const manifestDigest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestDigest !== line.artifact_digest) {
    refuse('RESEARCH_VERIFY_DIGEST_MISMATCH', `sealed line ${line.id} manifest digest does not match its claimed reference`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    refuse('RESEARCH_VERIFY_MANIFEST_INVALID', `sealed line ${line.id} manifest is not valid JSON`);
  }
  if (!object(manifest) || manifest.schema !== 'shipyard.role-artifact.v1'
      || typeof manifest.dispatch_id !== 'string' || !manifest.dispatch_id
      || path.basename(line.artifact_ref, '.json') !== crypto.createHash('sha256').update(manifest.dispatch_id).digest('hex')) {
    refuse('RESEARCH_VERIFY_MANIFEST_INVALID', `sealed line ${line.id} manifest does not match its own dispatch identity`);
  }
  const envelope = manifest.envelope;
  const match = LINE_PATTERN.exec((object(envelope) && envelope.subject) || '');
  if (!match || match[1] !== scope.invId || match[2] !== line.id) {
    refuse('RESEARCH_VERIFY_SUBJECT_MISMATCH', `sealed line ${line.id} manifest subject does not name this investigation and line`);
  }
  if (envelope.role !== 'research' || envelope.schema !== 'shipyard.research-result.v1' || envelope.version !== 1) {
    refuse('RESEARCH_VERIFY_ENVELOPE_INVALID', `sealed line ${line.id} manifest envelope is not a research result`);
  }
  if (envelope.source_revision !== scope.sourceRevision || envelope.repository !== scope.repository
      || envelope.policy_hash !== scope.policyHash) {
    refuse('RESEARCH_VERIFY_IDENTITY_MISMATCH', `sealed line ${line.id} manifest differs from the authenticated run`);
  }
  if (!['completed', 'blocked'].includes(envelope.status)) {
    refuse('RESEARCH_VERIFY_STATUS_INVALID', `sealed line ${line.id} manifest status must be completed or blocked`);
  }
  const index = envelope.artifact_index;
  if (!object(index) || typeof index.path !== 'string' || !index.path.trim()
      || !/^[a-f0-9]{64}$/.test(index.sha256 || '') || index.sha256 !== index.digest) {
    refuse('RESEARCH_VERIFY_ARTIFACT_INDEX_INVALID', `sealed line ${line.id} manifest has no complete artifact index`);
  }
  let archiveStat;
  try {
    archiveStat = fs.lstatSync(index.path);
  } catch {
    refuse('RESEARCH_VERIFY_ARCHIVE_MISSING', `sealed line ${line.id} archived finding is missing: ${index.path}`);
  }
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    refuse('RESEARCH_VERIFY_ARCHIVE_NOT_REGULAR', `sealed line ${line.id} archived finding must be a regular file: ${index.path}`);
  }
  if (path.dirname(fs.realpathSync(index.path)) !== archiveRoot) {
    refuse('RESEARCH_VERIFY_ARCHIVE_PATH_ESCAPE', `sealed line ${line.id} archived finding is outside its archive root: ${index.path}`);
  }
  const archiveBytes = fs.readFileSync(index.path);
  const archiveDigest = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  if (archiveDigest !== index.sha256 || archiveBytes.length !== index.bytes) {
    refuse('RESEARCH_VERIFY_ARCHIVE_MUTATED', `sealed line ${line.id} archived finding no longer matches its sealed index`);
  }
  return Object.freeze({
    id: line.id, status: envelope.status, summary: envelope.summary,
    artifact_ref: line.artifact_ref, artifact_digest: manifestDigest,
    artifact_index: index, evidence_index: index,
  });
}

// @contract: researchLineFailure requires an adapter-free cause; callers strip the boundary repair suffix.
function researchLineFailure({ scope, sealed, failed } = {}) {
  if (!object(scope)) refuse('RESEARCH_FAILURE_SCOPE_INVALID', 'researchLineFailure requires a scope object');
  if (!Array.isArray(sealed)) refuse('RESEARCH_FAILURE_SEALED_INVALID', 'researchLineFailure requires the sealed line array');
  if (!object(failed) || typeof failed.line !== 'string' || !failed.line.trim()
      || typeof failed.code !== 'string' || !failed.code.trim()
      || typeof failed.cause !== 'string' || !failed.cause.trim()) {
    refuse('RESEARCH_FAILURE_INVALID', 'researchLineFailure requires a failed line, code, and cause');
  }
  return Object.freeze({
    status: 'blocked',
    failed_line: failed.line,
    code: failed.code,
    cause: failed.cause,
    sealed_lines: Object.freeze([...sealed]),
  });
}

function decompositionIdentity(scope) {
  if (!object(scope)) refuse('DECOMPOSITION_SCOPE_INVALID', 'sealDecomposition requires a scope object');
  const { worktree, subject, sourceRevision, repository, policyHash, status, summary } = scope;
  if (typeof worktree !== 'string' || !worktree.trim()) {
    refuse('DECOMPOSITION_WORKTREE_INVALID', 'decomposition scope requires a worktree path');
  }
  if (typeof subject !== 'string' || !subject.trim()) refuse('DECOMPOSITION_SUBJECT_INVALID', 'decomposition subject is required');
  if (typeof sourceRevision !== 'string' || !/^[a-f0-9]{40}$/i.test(sourceRevision)) {
    refuse('DECOMPOSITION_REVISION_INVALID', 'decomposition source revision must be a full 40-character Git object id');
  }
  if (typeof repository !== 'string' || !repository.trim()) refuse('DECOMPOSITION_REPOSITORY_INVALID', 'decomposition repository identity is required');
  if (typeof policyHash !== 'string' || !/^[a-f0-9]{64}$/i.test(policyHash)) {
    refuse('DECOMPOSITION_POLICY_INVALID', 'decomposition policy hash must be a 64-character digest');
  }
  if (status !== 'completed' && status !== 'blocked') refuse('DECOMPOSITION_STATUS_INVALID', 'decomposition status must be completed or blocked');
  if (typeof summary !== 'string' || Array.from(summary).length > SUMMARY_MAX_CHARS) {
    refuse('DECOMPOSITION_SUMMARY_INVALID', `decomposition summary must be bounded text of at most ${SUMMARY_MAX_CHARS} characters`);
  }
  return Object.freeze({
    worktree: fs.realpathSync(worktree), subject, sourceRevision: sourceRevision.toLowerCase(),
    repository, policyHash: policyHash.toLowerCase(), status, summary,
  });
}

function planEntry(worktree, file, maxBytes) {
  if (typeof file !== 'string' || !file.trim()) refuse('DECOMPOSITION_PLAN_PATH_INVALID', 'plan path must be bounded text');
  const resolved = path.resolve(worktree, file);
  const relative = path.relative(worktree, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse('DECOMPOSITION_PLAN_PATH_ESCAPE', `plan path escapes the worktree: ${file}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    refuse('DECOMPOSITION_PLAN_MISSING', `plan file is missing: ${relative}`);
  }
  if (stat.isSymbolicLink()) refuse('DECOMPOSITION_PLAN_SYMLINK', `plan file may not be a symlink: ${relative}`);
  if (!stat.isFile()) refuse('DECOMPOSITION_PLAN_NOT_REGULAR', `plan file must be a regular file: ${relative}`);
  if (stat.size > maxBytes) refuse('DECOMPOSITION_PLAN_TOO_LARGE', `plan file exceeds the bounded size cap: ${relative}`);
  const bytes = fs.readFileSync(resolved);
  const after = fs.lstatSync(resolved);
  if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    refuse('DECOMPOSITION_PLAN_MUTATED', `plan file changed while it was being sealed: ${relative}`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({ path: resolved, bytes: bytes.length, content_bytes: bytes.length, sha256, digest: sha256 });
}

function writeManifestOnce(file, bytes) {
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') refuse('DECOMPOSITION_INDEX_WRITE_FAILED', `decomposition index could not be archived: ${error.message}`);
    const existing = fs.readFileSync(file);
    if (!existing.equals(bytes)) refuse('DECOMPOSITION_INDEX_WRITE_FAILED', 'decomposition index already exists with different bytes');
  }
}

function sealDecomposition({ root, scope, plans, extra } = {}) {
  const identity = decompositionIdentity(scope);
  if (typeof root !== 'string' || !root.trim()) refuse('DECOMPOSITION_ROOT_INVALID', 'sealDecomposition requires an archive root');
  if (!Array.isArray(plans) || !plans.length) refuse('DECOMPOSITION_PLANS_INVALID', 'sealDecomposition requires at least one plan file');
  if (plans.length > DECOMPOSITION_MAX_PLANS) {
    refuse('DECOMPOSITION_PLANS_INVALID', `sealDecomposition accepts at most ${DECOMPOSITION_MAX_PLANS} plan files`);
  }
  const entries = plans.map((file) => planEntry(identity.worktree, file, DECOMPOSITION_PLAN_MAX_BYTES));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestBytes = Buffer.from(`${JSON.stringify({ schema: 'shipyard.decomposition-index.v1', version: 1, entries })}\n`);
  const digest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(fs.realpathSync(root), `${digest}.json`);
  writeManifestOnce(manifestPath, manifestBytes);
  const index = Object.freeze({ path: manifestPath, bytes: manifestBytes.length,
    content_bytes: manifestBytes.length, sha256: digest, digest });
  return Object.freeze({
    ...(object(extra) ? extra : {}),
    schema: 'shipyard.decomposition-result.v1',
    version: 1,
    role: 'decomposition',
    subject: identity.subject,
    source_revision: identity.sourceRevision,
    repository: identity.repository,
    policy_hash: identity.policyHash,
    status: identity.status,
    summary: identity.summary,
    artifact_index: index,
    evidence_index: index,
    plan_count: entries.length,
  });
}

function entriesFromStatus(raw) {
  const fields = raw.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const entry = fields[i];
    if (entry.length < 4 || entry[2] !== ' ') refuse('CONTAINMENT_STATUS_UNRECOGNIZED', 'unrecognized Git status entry');
    const status = entry.slice(0, 2);
    if (status.includes('U') || status === 'AA' || status === 'DD') {
      refuse('CONTAINMENT_UNMERGED_PATHS', 'unmerged paths are present in the worktree');
    }
    entries.push({ path: entry.slice(3), status });
    if (/[RC]/.test(status)) {
      i++;
      if (i >= fields.length - 1) refuse('CONTAINMENT_STATUS_UNRECOGNIZED', 'incomplete Git rename status');
      entries.push({ path: fields[i], status });
    }
  }
  return entries;
}

function containmentGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    refuse('CONTAINMENT_STATUS_FAILED', `Git containment metadata could not be read: ${String(error.stderr || error.message).trim()}`);
  }
}

function containmentSource(root, relative) {
  const file = path.resolve(root, relative);
  const canonical = path.relative(root, file);
  if (!canonical || canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical))
    refuse('CONTAINMENT_STATUS_FAILED', 'containment source escapes its rooted directory');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const parents = [];
  let parent = root;
  for (const part of canonical.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      refuse('CONTAINMENT_STATUS_FAILED', 'containment source parent is not physical');
    parents.push([parent, stat]);
  }
  let entries = 0;
  let bytes = 0;
  const inspected = [];
  const inspect = (target, depth, nested) => {
    if (depth > 32 || ++entries > 10000)
      refuse('CONTAINMENT_STATUS_FAILED', 'containment directory exceeds depth or entry bound');
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) {
      if (!nested && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
      refuse('CONTAINMENT_STATUS_FAILED', 'containment source could not be inspected');
    }
    inspected.push([target, stat]);
    if (!stat.isSymbolicLink() && fs.realpathSync(target) !== target)
      refuse('CONTAINMENT_VIOLATION', 'source moved outside its physical directory');
    let identity;
    if (stat.isSymbolicLink()) {
      if (nested) refuse('CONTAINMENT_STATUS_FAILED', 'containment directory contains a symlink');
      identity = `${stat.mode}:symlink:${fs.readlinkSync(target)}`;
    } else if (stat.isDirectory()) {
      const listing = () => {
        const names = [];
        const directory = fs.opendirSync(target);
        try {
          let entry;
          while ((entry = directory.readSync()) !== null) {
            if (names.length >= 10000)
              refuse('CONTAINMENT_STATUS_FAILED', 'containment directory exceeds entry bound');
            names.push(entry.name);
          }
        } finally { directory.closeSync(); }
        return names.sort();
      };
      const names = listing();
      if (names.length > 10000 - entries)
        refuse('CONTAINMENT_STATUS_FAILED', 'containment directory exceeds entry bound');
      const hash = crypto.createHash('sha256');
      for (const name of names) {
        const child = inspect(path.join(target, name), depth + 1, true);
        hash.update(JSON.stringify([name, child]) + '\n');
      }
      if (JSON.stringify(listing()) !== JSON.stringify(names))
        refuse('CONTAINMENT_VIOLATION', 'directory membership changed during containment inspection');
      identity = `${stat.mode}:directory-sha256:${hash.digest('hex')}`;
    } else if (stat.isFile()) {
      if (nested && (bytes += stat.size) > 64 * 1024 * 1024)
        refuse('CONTAINMENT_STATUS_FAILED', 'containment directory exceeds byte bound');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!same(stat, fs.fstatSync(fd)))
          refuse('CONTAINMENT_VIOLATION', 'source moved during containment inspection');
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(65536);
        let read;
        let total = 0;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          total += read;
          if (total > stat.size) refuse('CONTAINMENT_VIOLATION', 'source grew during containment inspection');
          hash.update(buffer.subarray(0, read));
        }
        if (total !== stat.size || !same(stat, fs.fstatSync(fd)))
          refuse('CONTAINMENT_VIOLATION', 'source changed during containment inspection');
        identity = `${stat.mode}:${hash.digest('hex')}`;
      } finally { fs.closeSync(fd); }
    } else refuse('CONTAINMENT_STATUS_FAILED', 'containment source has an unsupported entry type');
    if (!same(stat, fs.lstatSync(target)))
      refuse('CONTAINMENT_VIOLATION', 'source changed during containment inspection');
    return identity;
  };
  const identity = inspect(file, 0, false);
  for (const [target, stat] of [...parents, ...inspected]) {
    if (!same(stat, fs.lstatSync(target)))
      refuse('CONTAINMENT_VIOLATION', 'source parent moved during containment inspection');
  }
  return identity;
}

function containmentSnapshot(root) {
  const head = containmentGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const index = crypto.createHash('sha256')
    .update(containmentGit(root, ['ls-files', '--stage', '-v', '-z'])).digest('hex');
  const entries = entriesFromStatus(containmentGit(root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const paths = new Set(containmentGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean));
  for (const entry of entries) paths.add(entry.path);
  const sources = new Map([...paths].map((relative) => [relative, containmentSource(root, relative)]));
  return { root, head, index, sources, status: new Map(entries.map((entry) => [entry.path, entry.status])) };
}

function captureContainmentBaseline({ worktree } = {}) {
  if (typeof worktree !== 'string' || !worktree.trim()) {
    refuse('CONTAINMENT_INPUT_INVALID', 'captureContainmentBaseline requires a worktree path');
  }
  const token = Object.freeze({});
  containmentBaselines.set(token, containmentSnapshot(fs.realpathSync(worktree)));
  return token;
}

function containmentBindingKey(value) {
  if (Array.isArray(value)) return '[' + value.map(containmentBindingKey).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + containmentBindingKey(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function persistContainmentBaseline({ worktree, baseline, binding } = {}) {
  const original = object(baseline) && containmentBaselines.get(baseline);
  if (!original || original.root !== fs.realpathSync(worktree))
    refuse('CONTAINMENT_BASELINE_INVALID', 'persistence requires the original private host token');
  const bindingKey = containmentBindingKey(binding);
  if (original.bindingKey !== undefined && original.bindingKey !== bindingKey)
    refuse('CONTAINMENT_BASELINE_INVALID', 'an original containment token cannot authorize another launch binding');
  const sorted = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const reference = registerPlanningContainmentBaseline({ worktree, binding, snapshot: {
    schema: 'shipyard.planning-containment-snapshot.v1', root: original.root,
    head: original.head, index: original.index,
    sources: sorted(original.sources), status: sorted(original.status),
  } });
  original.bindingKey = bindingKey;
  return reference;
}

function restoreContainmentBaseline({ worktree, binding, reference, recoveredEpoch } = {}) {
  if (!object(binding) || !Number.isSafeInteger(recoveredEpoch) || recoveredEpoch !== binding.lease_epoch + 1)
    refuse('CONTAINMENT_BASELINE_INVALID', 'restoration requires the original lease epoch successor');
  const original = readPlanningContainmentBaseline({ worktree, binding, reference });
  const token = Object.freeze({});
  containmentBaselines.set(token, { root: original.root, head: original.head, index: original.index,
    sources: new Map(original.sources), status: new Map(original.status), bindingKey: containmentBindingKey(binding) });
  return token;
}

function assertContained({ worktree, allowed, baseline } = {}) {
  if (typeof worktree !== 'string' || !worktree.trim()) refuse('CONTAINMENT_INPUT_INVALID', 'assertContained requires a worktree path');
  const root = fs.realpathSync(worktree);
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.length && baseline === undefined) refuse('CONTAINMENT_INPUT_INVALID', 'assertContained requires at least one allowed path');
  const relativeAllowed = list.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) refuse('CONTAINMENT_INPUT_INVALID', 'allowed path must be bounded text');
    const resolved = path.resolve(root, entry);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      refuse('CONTAINMENT_INPUT_INVALID', `allowed path escapes the worktree: ${entry}`);
    }
    return relative;
  });
  const isAllowed = (candidate) => relativeAllowed.some((entry) => entry === ''
    || candidate === entry || candidate.startsWith(`${entry}${path.sep}`));
  if (baseline !== undefined) {
    const original = object(baseline) && containmentBaselines.get(baseline);
    if (!original || original.root !== root) {
      refuse('CONTAINMENT_BASELINE_INVALID', 'containment requires the original host-owned token for this worktree');
    }
    const current = containmentSnapshot(root);
    if (original.head !== current.head) refuse('CONTAINMENT_VIOLATION', 'worktree HEAD changed since the host baseline');
    if (original.index !== current.index) refuse('CONTAINMENT_VIOLATION', 'worktree index changed since the host baseline');
    const paths = new Set([...original.sources.keys(), ...current.sources.keys(),
      ...original.status.keys(), ...current.status.keys()]);
    const outside = [...paths].filter((relative) => !isAllowed(relative)
      && (original.sources.get(relative) !== current.sources.get(relative)
        || original.status.get(relative) !== current.status.get(relative))).sort();
    if (outside.length) {
      refuse('CONTAINMENT_VIOLATION', `worktree changed outside the allowed path(s): ${outside.join(', ')}`);
    }
    return;
  }
  let raw;
  try {
    raw = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
  } catch (error) {
    refuse('CONTAINMENT_STATUS_FAILED', `Git status could not be read: ${String(error.stderr || error.message).trim()}`);
  }
  const entries = entriesFromStatus(raw);
  const outside = [...new Set(entries.map((entry) => entry.path).filter((candidate) => !isAllowed(candidate)))].sort();
  if (outside.length) {
    refuse('CONTAINMENT_VIOLATION', `worktree changed outside the allowed path(s): ${outside.join(', ')}`);
  }
}

module.exports = Object.freeze({
  sealResearch,
  sealDecomposition,
  researchLineFailure,
  verifySealedLine,
  assertContained,
  captureContainmentBaseline,
  persistContainmentBaseline,
  restoreContainmentBaseline,
});
