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

function coverageRoot() {
  return path.resolve(process.env.SHIPYARD_COVERAGE_ROOT
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'coverage'));
}

function repoSlug(worktree, declared) {
  if (typeof declared === 'string' && declared.trim()) return declared;
  const common = execFileSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' }).trim();
  return 'git-common:' + hash(fs.realpathSync(path.resolve(worktree, common)));
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
  if (typeof repo !== 'string' || !repo || repo === '.' || repo === '..'
      || repo.includes('\\') || repo.includes('\0') || repo.startsWith('/')) throw new Error('invalid repository slug');
  if (!OID.test(commit || '')) throw new Error('invalid commit');
  return path.join(root, 'coverage', encodeURIComponent(repo), commit + '.json');
}

function gitMetadata(worktree, commit) {
  if (!OID.test(commit || '')) throw new Error('invalid commit');
  const text = execFileSync('git', ['-C', worktree, 'show', '-s', '--format=%P%n%T', commit],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 }).trimEnd().split('\n');
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
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
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

function markerFile(root) { return path.join(root, 'rollout-marker.json'); }

function rolloutMarker({ keyPath, root = coverageRoot() } = {}) {
  if (!fs.existsSync(markerFile(root))) return null;
  const marker = read(markerFile(root), readKey(keyFile(root, keyPath)));
  if (!marker || typeof marker.recorded_at !== 'string' || !Number.isFinite(Date.parse(marker.recorded_at))) {
    throw new Error('rollout marker failed authentication');
  }
  return marker;
}

function ensureRolloutMarker({ recorded_at, repo, keyPath, root = coverageRoot() }) {
  const key = readKey(keyFile(root, keyPath));
  const marker = { recorded_at, repo };
  const file = markerFile(root);
  if (!createOnce(file, JSON.stringify(envelope(marker, key)) + '\n')) {
    const existing = read(file, key);
    if (!existing) throw new Error('rollout marker failed authentication');
    return existing;
  }
  return marker;
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
    const { parents, tree } = gitMetadata(input.worktree || process.cwd(), input.commit);
    if (stableStringify(input.parents) !== stableStringify(parents) || input.tree !== tree) {
      throw new Error('coverage commit metadata mismatch');
    }
    if (['executor', 'fixer'].includes(input.kind)
        && (typeof input.dispatch_id !== 'string' || !input.dispatch_id
          || !DIGEST.test(input.receipt_digest || '')
          || !path.isAbsolute(input.receipt_store || '')
          || !DIGEST.test(input.verification_digest || ''))) {
      throw new Error('finalization coverage requires dispatch, receipt, verification and store evidence');
    }
    if (input.kind === 'base-merge'
        && (!input.base_merge || typeof input.base_merge.base !== 'string'
          || typeof input.base_merge.requested_base !== 'string'
          || !Array.isArray(input.base_merge.taken_from_base))) {
      throw new Error('base-merge coverage requires merge evidence');
    }
    const { worktree: _worktree, ...fields } = input;
    const payload = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const target = fileFor(root, payload.repo, payload.commit);
    if (!createOnce(target, JSON.stringify(envelope(payload, key)) + '\n')) {
      const prior = read(target, key);
      if (!prior || stableStringify(prior) !== stableStringify(payload)) throw new Error('conflicting coverage record');
    }
    if (['executor', 'fixer'].includes(payload.kind)) {
      ensureRolloutMarker({ recorded_at: new Date().toISOString(), repo: payload.repo, keyPath: file, root });
    }
    return payload;
  } });
}

function verify({ commit, repo, worktree = process.cwd(), keyPath, root = coverageRoot() }) {
  try {
    const key = readKey(keyFile(root, keyPath));
    const record = read(fileFor(root, repo, commit), key);
    if (!record || record.commit !== commit || record.repo !== repo || !KINDS.has(record.kind)) throw new Error('coverage record missing or unauthenticated');
    const { parents, tree } = gitMetadata(worktree, commit);
    if (stableStringify(record.parents) !== stableStringify(parents) || record.tree !== tree) throw new Error('commit metadata mismatch');
    if (['executor', 'fixer'].includes(record.kind)) {
      if (!DIGEST.test(record.verification_digest || '')) throw new Error('verification digest missing');
      const message = execFileSync('git', ['-C', worktree, 'show', '-s', '--format=%B', commit],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const trailers = message.split(/\r?\n/).filter((line) => line.startsWith('Shipyard-Verification-Evidence:'));
      if (trailers.length !== 1 || trailers[0] !== `Shipyard-Verification-Evidence: ${record.verification_digest}`) {
        throw new Error('signed verification evidence mismatch');
      }
      const stored = readVerifiedDispatchRecord(record.receipt_store, record.dispatch_id);
      const receipt = stored.receipt;
      if (!receipt || stored.dispatch_id !== record.dispatch_id || receipt.dispatch_id !== record.dispatch_id
          || receipt.compliance !== 'verified' || stored.ticket !== record.ticket
          || (stored.repository !== undefined && stored.repository !== repo)
          || (receipt.repository !== undefined && receipt.repository !== repo)
          || hash(stableStringify(receipt)) !== record.receipt_digest) throw new Error('receipt mismatch');
    }
    return { covered: true, record };
  } catch (error) { return { covered: false, reason: error.message }; }
}

module.exports = Object.freeze({ coverageRoot, repoSlug, createCoverageWriter, verify, rolloutMarker, ensureRolloutMarker });

if (require.main === module) {
  const [command, commit, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json') || process.argv.includes('--json');
  if (command === 'verify' && OID.test(commit || '') && rest.includes('--repo')) {
    const result = verify({ commit, repo: rest[rest.indexOf('--repo') + 1] });
    process.stdout.write(json ? JSON.stringify(result) + '\n' : `${result.covered ? 'covered' : 'uncovered: ' + result.reason}\n`);
    process.exitCode = result.covered ? 0 : 1;
  } else if (command === 'marker' && (!commit || commit === '--json')) {
    const result = rolloutMarker();
    process.stdout.write(json ? JSON.stringify(result) + '\n' : `${result ? result.recorded_at : 'missing'}\n`);
    process.exitCode = result ? 0 : 1;
  } else {
    process.stderr.write('usage: conveyor-coverage.cjs verify <commit> --repo <slug> [--json] | marker [--json]\n');
    process.exitCode = 2;
  }
}
