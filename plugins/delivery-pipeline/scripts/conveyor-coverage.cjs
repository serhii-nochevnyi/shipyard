#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { stableStringify } = require('./model-policy-internal.cjs');

const FORMAT = 'shipyard.conveyor-coverage.v1';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const KINDS = new Set(['executor', 'fixer', 'base-merge', 'remedy']);
const DISPATCH_FORMAT = 'adr-014.durable-boundary.v1';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}

function coverageRoot() {
  return path.resolve(process.env.SHIPYARD_COVERAGE_ROOT
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'coverage'));
}

function repositoryIdentity(worktree) {
  const root = fs.realpathSync(worktree);
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', env: gitEnv() }).trim();
  return 'git-common:' + hash(fs.realpathSync(path.resolve(root, common)));
}

function repoSlug(worktree, declared) {
  if (typeof declared === 'string' && declared.trim()) return declared;
  return repositoryIdentity(worktree);
}

function keyFile(root, keyPath) {
  if (keyPath !== undefined && !path.isAbsolute(keyPath)) throw new Error('coverage key path must be absolute');
  return keyPath || path.join(root, 'coverage.key');
}

function readKey(file) {
  const stat = fs.lstatSync(file);
  const key = fs.readFileSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || key.length !== 32 || (stat.mode & 0o077)) {
    throw new Error('invalid coverage key');
  }
  return key;
}

function createOnce(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temp, file); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
  } finally { fs.rmSync(temp, { force: true }); }
}

function envelope(payload, key) {
  return { format: FORMAT, payload, integrity: { algorithm: 'hmac-sha256',
    mac: crypto.createHmac('sha256', key).update(stableStringify(payload)).digest('hex') } };
}

function authenticate(raw, key) {
  if (!raw || raw.format !== FORMAT || !raw.payload || !raw.integrity
      || raw.integrity.algorithm !== 'hmac-sha256' || !DIGEST.test(raw.integrity.mac || '')) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', key)
    .update(stableStringify(raw.payload)).digest('hex'), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(raw.integrity.mac, 'hex')) ? raw.payload : null;
}

function read(file, key) {
  return authenticate(JSON.parse(fs.readFileSync(file, 'utf8')), key);
}

function fileFor(root, repo, commit) {
  if (!validRepoSlug(repo)) throw new Error('invalid repository slug');
  if (!OID.test(commit || '')) throw new Error('invalid commit');
  return path.join(root, 'coverage', encodeURIComponent(repo), commit + '.json');
}

function validRepoSlug(repo) {
  return typeof repo === 'string' && Boolean(repo.trim()) && repo !== '.' && repo !== '..'
    && !repo.includes('\\') && !repo.includes('\0') && !repo.startsWith('/');
}

function gitMetadata(worktree, commit) {
  if (!OID.test(commit || '')) throw new Error('invalid commit');
  const text = execFileSync('git', ['-C', worktree, 'show', '-s', '--format=%P%n%T', commit],
    { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 }).trimEnd().split('\n');
  const parents = text[0] ? text[0].split(' ') : [];
  if (!OID.test(text[1] || '') || parents.some((parent) => !OID.test(parent))) throw new Error('invalid commit metadata');
  return { parents, tree: text[1] };
}

function readPrivateFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} is invalid or too broadly accessible`);
  }
  return fs.readFileSync(file);
}

// @security: receipt verification reads existing state; it never calls the creating writer.
function readVerifiedDispatchRecord(storeDir, dispatchId) {
  if (typeof storeDir !== 'string' || !path.isAbsolute(storeDir) || !dispatchId) {
    throw new Error('invalid durable receipt locator');
  }
  const root = path.resolve(storeDir);
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    throw new Error('durable dispatch store is not a directory');
  }
  const keyPath = path.join(path.dirname(root), `.shipyard-dispatch-authority-${hash(root)}.key`);
  const key = readPrivateFile(keyPath, 'durable dispatch authority key');
  if (key.length !== 32) throw new Error('durable dispatch authority key has invalid length');
  const recordPath = path.join(root, `record-${hash(dispatchId)}.json`);
  const rawBytes = readPrivateFile(recordPath, 'durable dispatch receipt');
  const raw = JSON.parse(rawBytes.toString('utf8'));
  if (!raw || raw.format !== DISPATCH_FORMAT || !raw.payload || !raw.integrity
      || raw.integrity.algorithm !== 'hmac-sha256' || !DIGEST.test(raw.integrity.mac || '')) {
    throw new Error('durable dispatch receipt envelope is invalid');
  }
  const expected = crypto.createHmac('sha256', key).update(stableStringify(raw.payload)).digest();
  const actual = Buffer.from(raw.integrity.mac, 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) throw new Error('durable dispatch receipt authentication failed');
  return raw.payload;
}

function markerFile(root, repo) {
  if (!validRepoSlug(repo)) throw new Error('rollout marker requires a valid project slug');
  return path.join(root, 'rollout-markers', encodeURIComponent(repo) + '.json');
}

function rolloutMarker({ repo, repository_id, worktree, keyPath, root = coverageRoot() } = {}) {
  if (repo === undefined) return null;
  const file = markerFile(root, repo);
  if (!fs.existsSync(file)) return null;
  const marker = read(file, readKey(keyFile(root, keyPath)));
  if (!marker || marker.repo !== repo || typeof marker.recorded_at !== 'string'
      || !Number.isFinite(Date.parse(marker.recorded_at))
      || typeof marker.repository_id !== 'string' || !marker.repository_id) {
    throw new Error('rollout marker failed authentication');
  }
  if ((repository_id !== undefined && marker.repository_id !== repository_id)
      || (worktree !== undefined && marker.repository_id !== repositoryIdentity(worktree))) {
    throw new Error('rollout marker repository identity mismatch');
  }
  return marker;
}

function ensureRolloutMarker({ recorded_at, repo, repository_id, keyPath, root = coverageRoot() }) {
  if (!Number.isFinite(Date.parse(recorded_at || '')) || !validRepoSlug(repo)
      || typeof repository_id !== 'string' || !repository_id) {
    throw new Error('invalid project rollout marker');
  }
  const key = readKey(keyFile(root, keyPath));
  const marker = { recorded_at, repo, repository_id };
  const file = markerFile(root, repo);
  if (!createOnce(file, JSON.stringify(envelope(marker, key)) + '\n')) {
    const existing = read(file, key);
    if (!existing || existing.repo !== repo || existing.repository_id !== repository_id
        || !Number.isFinite(Date.parse(existing.recorded_at || ''))) {
      throw new Error('rollout marker failed authentication');
    }
    return existing;
  }
  return marker;
}

function expectedRole(kind) {
  if (kind === 'executor') return (role) => role === 'executor';
  if (kind === 'fixer') return (role) => role === 'ci-fix' || role === 'review-fix';
  return null;
}

function validateFinalizationEvidence(input) {
  if (!input || !['executor', 'fixer'].includes(input.kind)
      || typeof input.ticket !== 'string' || !input.ticket
      || !validRepoSlug(input.repo) || typeof input.repository_id !== 'string' || !input.repository_id
      || typeof input.dispatch_id !== 'string' || !input.dispatch_id
      || !DIGEST.test(input.receipt_digest || '')
      || !DIGEST.test(input.verification_digest || '')
      || !path.isAbsolute(input.receipt_store || '')) {
    throw new Error('finalization coverage requires executor/fixer dispatch, receipt, verification and store evidence');
  }
  const stored = readVerifiedDispatchRecord(input.receipt_store, input.dispatch_id);
  const receipt = stored.receipt;
  const acceptsRole = expectedRole(input.kind);
  if (!receipt || stored.dispatch_id !== input.dispatch_id || receipt.dispatch_id !== input.dispatch_id
      || receipt.compliance !== 'verified' || !acceptsRole(stored.role)
      || stored.role !== receipt.role || stored.runtime !== receipt.runtime
      || stored.ticket !== input.ticket
      || (stored.repository !== undefined && stored.repository !== input.repo)
      || (receipt.repository !== undefined && receipt.repository !== input.repo)
      || (stored.repository_id !== undefined && stored.repository_id !== input.repository_id)
      || (receipt.repository_id !== undefined && receipt.repository_id !== input.repository_id)
      || hash(stableStringify(receipt)) !== input.receipt_digest) {
    throw new Error('durable dispatch receipt does not match finalization coverage');
  }
  return stored;
}

// @contract: a remedy link is usable only with the declared workflow and its dispatch identity.
function validateRemedy(input) {
  const remedy = input && input.remedy;
  if (!remedy || typeof remedy !== 'object' || Array.isArray(remedy)
      || typeof remedy.workflow !== 'string' || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(remedy.workflow)
      || typeof remedy.run_id !== 'string' || !/^[1-9]\d*$/.test(remedy.run_id)
      || !OID.test(remedy.dispatch_head || '')) {
    throw new Error('remedy coverage requires workflow, run_id and dispatch_head');
  }
}

function signedVerificationDigest(worktree, commit) {
  const message = execFileSync('git', ['-C', worktree, 'show', '-s', '--format=%B', commit],
    { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const trailers = message.split(/\r?\n/).filter((line) => line.startsWith('Shipyard-Verification-Evidence:'));
  if (trailers.length !== 1) throw new Error('signed verification evidence is missing or ambiguous');
  const match = /^Shipyard-Verification-Evidence: ([0-9a-f]{64})$/.exec(trailers[0]);
  if (!match) throw new Error('signed verification evidence digest is invalid');
  return match[1];
}

// @security: only trusted host callers receive this writer; the CLI exposes reads only.
function createCoverageWriter({ keyPath, root = coverageRoot() } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) {
    throw new Error('coverage root must be a private directory');
  }
  const file = keyFile(root, keyPath);
  createOnce(file, crypto.randomBytes(32));
  const key = readKey(file);
  return Object.freeze({ record(input) {
    if (!input || !KINDS.has(input.kind) || !OID.test(input.commit || '')
        || typeof input.ticket !== 'string' || !input.ticket
        || typeof input.repo !== 'string' || !input.repo) throw new Error('invalid coverage record');
    const worktree = fs.realpathSync(input.worktree || process.cwd());
    const repository_id = repositoryIdentity(worktree);
    const { parents, tree } = gitMetadata(worktree, input.commit);
    if (stableStringify(input.parents) !== stableStringify(parents) || input.tree !== tree) {
      throw new Error('coverage commit metadata mismatch');
    }
    if (['executor', 'fixer'].includes(input.kind)) {
      validateFinalizationEvidence({ ...input, repository_id });
      if (signedVerificationDigest(worktree, input.commit) !== input.verification_digest) {
        throw new Error('signed verification evidence digest does not match coverage');
      }
    }
    if (input.kind === 'base-merge'
        && (!input.base_merge || typeof input.base_merge.base !== 'string'
          || typeof input.base_merge.requested_base !== 'string'
          || !Array.isArray(input.base_merge.taken_from_base))) {
      throw new Error('base-merge coverage requires merge evidence');
    }
    if (input.kind === 'remedy') validateRemedy(input);
    const { worktree: _worktree, ...fields } = input;
    const payload = Object.fromEntries(Object.entries({ ...fields, repository_id }).filter(([, value]) => value !== undefined));
    const target = fileFor(root, payload.repo, payload.commit);
    if (!createOnce(target, JSON.stringify(envelope(payload, key)) + '\n')) {
      const prior = read(target, key);
      if (!prior || stableStringify(prior) !== stableStringify(payload)) throw new Error('conflicting coverage record');
    }
    if (['executor', 'fixer'].includes(payload.kind)) {
      ensureRolloutMarker({ recorded_at: new Date().toISOString(), repo: payload.repo,
        repository_id, keyPath: file, root });
    }
    return payload;
  } });
}

function verify({ commit, repo, worktree = process.cwd(), keyPath, root = coverageRoot() }) {
  try {
    const key = readKey(keyFile(root, keyPath));
    const record = read(fileFor(root, repo, commit), key);
    if (!record || record.commit !== commit || record.repo !== repo || !KINDS.has(record.kind)) throw new Error('coverage record missing or unauthenticated');
    if (record.repository_id !== repositoryIdentity(worktree)) throw new Error('coverage repository identity mismatch');
    const { parents, tree } = gitMetadata(worktree, commit);
    if (stableStringify(record.parents) !== stableStringify(parents) || record.tree !== tree) throw new Error('commit metadata mismatch');
    if (['executor', 'fixer'].includes(record.kind)) {
      if (!DIGEST.test(record.verification_digest || '')) throw new Error('verification digest missing');
      if (signedVerificationDigest(worktree, commit) !== record.verification_digest) {
        throw new Error('signed verification evidence mismatch');
      }
      validateFinalizationEvidence({ ...record, repository_id: record.repository_id });
    }
    if (record.kind === 'remedy') validateRemedy(record);
    return { covered: true, record };
  } catch (error) { return { covered: false, reason: error.message }; }
}

module.exports = Object.freeze({ coverageRoot, repositoryIdentity, repoSlug, createCoverageWriter,
  validateFinalizationEvidence, verify, rolloutMarker, ensureRolloutMarker });

if (require.main === module) {
  const [command, commit, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json') || process.argv.includes('--json');
  if (command === 'verify' && OID.test(commit || '') && rest.includes('--repo')) {
    const result = verify({ commit, repo: rest[rest.indexOf('--repo') + 1] });
    process.stdout.write(json ? JSON.stringify(result) + '\n' : `${result.covered ? 'covered' : 'uncovered: ' + result.reason}\n`);
    process.exitCode = result.covered ? 0 : 1;
  } else if (command === 'marker' && process.argv.slice(2).includes('--repo')) {
    const args = process.argv.slice(2);
    const result = rolloutMarker({ repo: args[args.indexOf('--repo') + 1] });
    process.stdout.write(json ? JSON.stringify(result) + '\n' : `${result ? result.recorded_at : 'missing'}\n`);
    process.exitCode = result ? 0 : 1;
  } else {
    process.stderr.write('usage: conveyor-coverage.cjs verify <commit> --repo <slug> [--json] | marker --repo <slug> [--json]\n');
    process.exitCode = 2;
  }
}
