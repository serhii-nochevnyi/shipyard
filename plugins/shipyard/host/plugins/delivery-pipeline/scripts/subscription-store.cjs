'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');
const { validateEnvelope, normalizeLabel, RESET_TOLERANCE_SECONDS } = require('./subscription-observation.cjs');

const RUNTIMES = new Set(['claude', 'codex']);
const SAMPLE_FILE_MODE = 0o600;
const LABEL_FILE_MODE = 0o600;
const LABELS_FILE = 'labels.json';
const DEFAULT_RETENTION_DAYS = 35;
const DEFAULT_MAX_FILE_BYTES = 1048576;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(code, message) {
  throw storeError(code, message);
}

// @security: checked with lstat before any realpath resolution, so a planted symlink is refused, never followed.
function assertNotSymlink(target) {
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) fail('UNSAFE_STATE_ROOT', `refusing a symlinked state path: ${target}`);
}

// @contract: resolves the deepest existing ancestor via realpath and appends the rest, following aliases above it.
function canonicalize(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    let real;
    try { real = fs.realpathSync(current); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) fail('UNSAFE_STATE_ROOT', `cannot resolve any existing ancestor of ${target}`);
      missing.unshift(path.basename(current));
      current = parent;
      continue;
    }
    return missing.length ? path.join(real, ...missing) : real;
  }
}

function assertSafeRootChecks(canonicalPath) {
  if (canonicalPath.split(path.sep).includes('.planning')) {
    fail('UNSAFE_STATE_ROOT', `refusing a state root with a .planning path segment: ${canonicalPath}`);
  }
  let dir = canonicalPath;
  for (;;) {
    let gitStat;
    try { gitStat = fs.lstatSync(path.join(dir, '.git')); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      gitStat = null;
    }
    if (gitStat) fail('UNSAFE_STATE_ROOT', `refusing a state root inside a git working tree: ${canonicalPath}`);
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function candidatePaths(runtime, stateRoot) {
  if (!RUNTIMES.has(runtime)) fail('INVALID_RUNTIME', `runtime must be one of ${[...RUNTIMES].join(', ')}`);
  if (stateRoot !== undefined && (typeof stateRoot !== 'string' || !stateRoot.trim())) {
    fail('INVALID_INPUT', 'stateRoot must be a non-empty string when provided');
  }
  const base = stateRoot ? path.resolve(stateRoot) : path.join(os.homedir(), '.local', 'state', 'shipyard', runtime);
  const final = path.join(base, 'subscription');
  return { base, final };
}

function resolveRoot(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'resolveRoot options must be an object');
  const { runtime, stateRoot } = options;
  const { base, final } = candidatePaths(runtime, stateRoot);
  assertNotSymlink(base);
  assertNotSymlink(final);
  const canonicalFinal = canonicalize(final);
  assertSafeRootChecks(canonicalFinal);
  fs.mkdirSync(canonicalFinal, { recursive: true, mode: 0o700 });
  fs.chmodSync(canonicalFinal, 0o700);
  fs.chmodSync(path.dirname(canonicalFinal), 0o700);
  return canonicalFinal;
}

function ensureLockDir(root) {
  const dir = path.join(root, '.locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (value === undefined || value === null) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail('INVALID_INPUT', `now must be a valid date/time: ${value}`);
  return parsed;
}

function sampleFileFor(root, when) {
  return path.join(root, `samples-${monthKeyOf(when)}.jsonl`);
}

function readJsonRecords(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (_) {}
  }
  return records;
}

// @invariant: dedupe is keyed on the same five dimensions subscription-observation.cjs uses for a series.
function seriesKeyOf(envelope) {
  return JSON.stringify([
    envelope.provider, envelope.runtime, envelope.account_label, envelope.bucket_id, envelope.window_minutes,
  ]);
}

function resetsMatch(a, b) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= RESET_TOLERANCE_SECONDS;
}

function append(envelope, options = {}) {
  validateEnvelope(envelope);
  const { runtime, stateRoot, now } = object(options) ? options : {};
  if (envelope.runtime !== runtime) {
    fail('RUNTIME_MISMATCH', `envelope.runtime (${envelope.runtime}) does not match the requested runtime (${runtime})`);
  }
  const root = resolveRoot({ runtime, stateRoot });
  const when = toDate(now);
  const lockDir = ensureLockDir(root);
  return withLock(lockDir, 'samples', () => {
    const file = sampleFileFor(root, when);
    const existing = readJsonRecords(file);
    const key = seriesKeyOf(envelope);
    let lastOfSeries = null;
    for (let i = existing.length - 1; i >= 0; i--) {
      if (seriesKeyOf(existing[i]) === key) { lastOfSeries = existing[i]; break; }
    }
    if (lastOfSeries
        && lastOfSeries.used_percent === envelope.used_percent
        && resetsMatch(lastOfSeries.resets_at, envelope.resets_at)) {
      return Object.freeze({ appended: false, duplicate: true });
    }
    fs.appendFileSync(file, `${JSON.stringify(envelope)}\n`, { mode: SAMPLE_FILE_MODE });
    fs.chmodSync(file, SAMPLE_FILE_MODE);
    return Object.freeze({ appended: true, duplicate: false });
  }, { waitMs: 300, label: 'subscription-store:append' });
}

function list(options = {}) {
  const { runtime, stateRoot } = object(options) ? options : {};
  const { final } = candidatePaths(runtime, stateRoot);
  const preExisting = fs.existsSync(final);
  const root = resolveRoot({ runtime, stateRoot });
  const envelopes = [];
  let entries = [];
  try { entries = fs.readdirSync(root); }
  catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  const files = entries.filter((name) => /^samples-\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  for (const name of files) {
    for (const record of readJsonRecords(path.join(root, name))) {
      try { validateEnvelope(record); envelopes.push(record); }
      catch (_) {}
    }
  }
  return Object.freeze({
    envelopes: Object.freeze(envelopes),
    status: Object.freeze({
      implemented: true, installed: preExisting, behaviorally_verified: false, efficiency_measured: false,
    }),
  });
}

function monthKeyToUtcMs(key) {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) fail('INVALID_INPUT', `malformed month key: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
}

// @contract: age is judged per month-file; size is capped by dropping the oldest lines first from a surviving file.
function prune(options = {}) {
  const {
    runtime, stateRoot, now, retentionDays = DEFAULT_RETENTION_DAYS, maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  } = object(options) ? options : {};
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    fail('INVALID_INPUT', 'retentionDays must be a positive number');
  }
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
    fail('INVALID_INPUT', 'maxFileBytes must be a positive number');
  }
  const root = resolveRoot({ runtime, stateRoot });
  const nowMs = toDate(now).getTime();
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const lockDir = ensureLockDir(root);
  return withLock(lockDir, 'prune', () => {
    let entries = [];
    try { entries = fs.readdirSync(root); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    let removedFiles = 0;
    let trimmedFiles = 0;
    let survivingFiles = 0;
    for (const name of entries) {
      const match = /^samples-(\d{4}-\d{2})\.jsonl$/.exec(name);
      if (!match) continue;
      const file = path.join(root, name);
      if (monthKeyToUtcMs(match[1]) <= cutoffMs) {
        fs.unlinkSync(file);
        removedFiles += 1;
        continue;
      }
      survivingFiles += 1;
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { continue; }
      if (size <= maxFileBytes) continue;
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const lines = raw.split('\n').filter((line) => line.trim());
      while (lines.length > 1 && Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8') > maxFileBytes) {
        lines.shift();
      }
      const content = lines.length ? `${lines.join('\n')}\n` : '';
      fs.writeFileSync(file, content, { mode: SAMPLE_FILE_MODE });
      fs.chmodSync(file, SAMPLE_FILE_MODE);
      trimmedFiles += 1;
    }
    return Object.freeze({ removed_files: removedFiles, trimmed_files: trimmedFiles, surviving_files: survivingFiles });
  }, { waitMs: 300, label: 'subscription-store:prune' });
}

function homeKey(home) {
  if (typeof home !== 'string' || !home.trim()) fail('INVALID_INPUT', 'home is required');
  const real = fs.realpathSync(path.resolve(home));
  return crypto.createHash('sha256').update(real).digest('hex');
}

function readLabelsMap(root) {
  const file = path.join(root, LABELS_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return object(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeLabelsMap(root, map) {
  const file = path.join(root, LABELS_FILE);
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, { mode: LABEL_FILE_MODE });
  fs.chmodSync(file, LABEL_FILE_MODE);
}

function declareLabel(options = {}) {
  const { runtime, home, label, stateRoot } = object(options) ? options : {};
  if (label === undefined || label === null) fail('INVALID_INPUT', 'label is required to declare it');
  const normalized = normalizeLabel(label);
  const root = resolveRoot({ runtime, stateRoot });
  const key = homeKey(home);
  const lockDir = ensureLockDir(root);
  return withLock(lockDir, 'labels', () => {
    const map = readLabelsMap(root);
    map[key] = normalized;
    writeLabelsMap(root, map);
    return Object.freeze({ runtime, label: normalized });
  }, { waitMs: 300, label: 'subscription-store:label' });
}

function readLabel(options = {}) {
  const { runtime, home, stateRoot } = object(options) ? options : {};
  const root = resolveRoot({ runtime, stateRoot });
  const key = homeKey(home);
  const map = readLabelsMap(root);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function clearLabel(options = {}) {
  const { runtime, home, stateRoot } = object(options) ? options : {};
  const root = resolveRoot({ runtime, stateRoot });
  const key = homeKey(home);
  const lockDir = ensureLockDir(root);
  return withLock(lockDir, 'labels', () => {
    const map = readLabelsMap(root);
    const existed = Object.prototype.hasOwnProperty.call(map, key);
    delete map[key];
    writeLabelsMap(root, map);
    return Object.freeze({ runtime, cleared: existed });
  }, { waitMs: 300, label: 'subscription-store:label' });
}

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[name] = true;
      } else {
        args[name] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function runCli(argv) {
  const [command, ...rest] = argv;
  const args = parseCliArgs(rest);
  const stateRoot = typeof args['state-root'] === 'string' ? args['state-root'] : undefined;
  const runtime = args.runtime;
  if (command === 'label') {
    const home = args.home;
    const modes = ['set', 'clear', 'show'].filter((name) => Object.prototype.hasOwnProperty.call(args, name));
    if (modes.length !== 1) fail('INVALID_INPUT', 'label requires exactly one of --set, --clear or --show');
    if (modes[0] === 'set') return declareLabel({ runtime, home, label: args.set, stateRoot });
    if (modes[0] === 'clear') return clearLabel({ runtime, home, stateRoot });
    return { runtime, label: readLabel({ runtime, home, stateRoot }) };
  }
  if (command === 'list') return list({ runtime, stateRoot });
  if (command === 'prune') return prune({ runtime, stateRoot });
  fail('INVALID_INPUT', `unknown command: ${JSON.stringify(command)}`);
  return undefined;
}

if (require.main === module) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`subscription-store: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({
  resolveRoot,
  append,
  list,
  prune,
  declareLabel,
  readLabel,
  clearLabel,
});
