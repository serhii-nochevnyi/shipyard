#!/usr/bin/env node
'use strict';

// Durable launch-to-transcript attribution for model efficiency reports.
//
// This file stores correlation facts, not prompts or token totals. The provider
// adapters own token accounting; this ledger answers which dispatch a supported
// transcript identity belongs to. It is deliberately append-only and revisioned
// so a session id learned after launch can be added without rewriting history.
//
//   usage-attribution.cjs record --stdin [--graph <dir>]
//   usage-attribution.cjs list [--json] [--graph <dir>]
//
// The record command accepts one object or an array. A record needs a dispatch id
// and at least one transcript identity (`session_id`, `request_id` or
// `message_id`). Values are metadata only; prompt text and credentials are
// rejected as unknown fields.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock } = require('./lock.cjs');
const pipeline = require('./pipeline-config.cjs');

const LEDGER_NAME = 'usage-attribution.jsonl';
const MAX_TEXT = 1000;
const RUNTIME_PROVIDER = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const BACKENDS = new Set(['agent', 'workflow', 'inline', 'codex-agent']);
const KINDS = new Set(['ordinary', 'advisor']);
const COMPLETION_STATES = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const EFFORT_STATES = new Set(['unknown', 'unsupported', ...(pipeline.EFFORTS || [])]);
const FIELDS = new Set([
  'schema_version', 'event', 'observation_id', 'revision', 'observed_at',
  'project_id', 'run_id', 'dispatch_id', 'ticket', 'role', 'task_level',
  'runtime', 'provider', 'backend', 'kind', 'source', 'session_id',
  'request_id', 'message_id', 'pass_id', 'model', 'effort', 'effort_applied',
  'observed_model', 'observed_effort', 'completion_status',
]);

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function textIssue(value, field, { whitespace = false } = {}) {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (!value.trim()) return `${field} must not be blank`;
  if (value.length > MAX_TEXT) return `${field} is longer than ${MAX_TEXT} characters`;
  if (/[\x00-\x1f\x7f]/.test(value)) return `${field} contains a control character`;
  if (whitespace && /\s/.test(value)) return `${field} contains whitespace`;
  return null;
}

function graphFromArgs(argv) {
  const args = [...argv];
  const at = args.indexOf('--graph');
  if (at !== -1) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`--graph needs a directory value (got ${value === undefined ? 'nothing' : `the flag "${value}"`})`);
    }
    args.splice(at, 2);
    return { args, dir: path.resolve(value), explicit: true };
  }
  if (process.env.SHIPYARD_GRAPH_DIR) {
    return { args, dir: path.resolve(process.env.SHIPYARD_GRAPH_DIR), explicit: true };
  }
  return { args, dir: path.join(process.cwd(), '.planning', 'graph'), explicit: false };
}

function graphGuard(dir, explicit) {
  if (!fs.existsSync(path.join(dir, 'tickets.json'))) {
    fail(
      `no ticket graph at ${dir} — refusing to write an attribution ledger nobody will read` +
      (explicit ? ' (the explicitly selected graph is invalid).' : '.\n') +
      (explicit ? '\n' : '') +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }
}

// Transcript paths can be supplied through a symlink (for example, a rotated
// log directory). Resolve existing paths the same way the report CLI resolves
// its explicit inputs, while retaining the absolute path for a file that does
// not exist yet. This gives the durable ledger one stable source identity.
function canonicalSource(value) {
  if (typeof value !== 'string') return value;
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); }
  catch { return resolved; }
}

function canonicalIdentity(raw) {
  return JSON.stringify([
    raw.dispatch_id,
    raw.runtime,
    raw.kind,
    raw.source || '',
    raw.session_id || '',
    raw.request_id || '',
    raw.message_id || '',
    raw.pass_id || '',
  ]);
}

function deriveObservationId(raw) {
  return `uattr-${crypto.createHash('sha256').update(canonicalIdentity(raw)).digest('hex').slice(0, 24)}`;
}

function normalizeRecord(raw, now = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('attribution record must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key));
  if (unknown.length) {
    fail(`attribution record has unsupported field(s): ${unknown.join(', ')} — prompt text and credentials are not telemetry`);
  }

  const runtime = raw.runtime;
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_PROVIDER, runtime)) {
    fail(`runtime must be one of ${Object.keys(RUNTIME_PROVIDER).join(', ')}`);
  }
  const provider = raw.provider === undefined ? RUNTIME_PROVIDER[runtime] : raw.provider;
  if (provider !== RUNTIME_PROVIDER[runtime]) {
    fail(`provider "${provider}" does not match runtime "${runtime}" — Claude stays Anthropic and Codex stays OpenAI`);
  }

  const record = {
    schema_version: 1,
    event: 'model_attribution',
    observed_at: raw.observed_at === undefined ? now : raw.observed_at,
    runtime,
    provider,
    kind: raw.kind === undefined ? 'ordinary' : raw.kind,
  };
  for (const key of [
    'project_id', 'run_id', 'dispatch_id', 'ticket', 'role', 'task_level',
    'backend', 'source', 'session_id', 'request_id', 'message_id', 'pass_id',
    'model', 'effort', 'effort_applied', 'observed_model', 'observed_effort',
    'completion_status',
  ]) {
    if (raw[key] !== undefined) record[key] = raw[key];
  }

  const date = typeof record.observed_at === 'string' ? Date.parse(record.observed_at) : NaN;
  if (!Number.isFinite(date)) {
    fail('observed_at must be a valid UTC timestamp');
  }
  if (record.kind !== 'ordinary' && record.kind !== 'advisor') {
    fail(`kind must be ordinary or advisor (got "${record.kind}")`);
  }
  for (const key of ['dispatch_id', 'project_id', 'run_id', 'ticket', 'role', 'source',
    'session_id', 'request_id', 'message_id', 'pass_id', 'model', 'observed_model']) {
    if (record[key] === undefined) continue;
    const issue = textIssue(record[key], key, { whitespace: key === 'dispatch_id' });
    if (issue) fail(issue);
  }
  if (record.dispatch_id === undefined) fail('dispatch_id is required — usage must be tied to one launch');
  if (!record.session_id && !record.request_id && !record.message_id) {
    fail('one transcript identity is required: session_id, request_id or message_id');
  }
  if (record.backend !== undefined && !BACKENDS.has(record.backend)) {
    fail(`backend must be one of ${[...BACKENDS].join(', ')}`);
  }
  if (record.role !== undefined && Array.isArray(pipeline.ROLES) && !pipeline.ROLES.includes(record.role)) {
    fail(`role "${record.role}" is not a Shipyard role — omit it only when no role was assigned`);
  }
  if (record.task_level !== undefined && Array.isArray(pipeline.TASK_LEVELS)
      && !pipeline.TASK_LEVELS.includes(record.task_level)) {
    fail(`task_level "${record.task_level}" is not a Shipyard task level`);
  }
  if (record.model !== undefined && Array.isArray(pipeline.TIERS) && !pipeline.TIERS.includes(record.model)) {
    fail(`model "${record.model}" is not a requested tier alias — concrete ids belong in observed_model`);
  }
  if (record.model !== undefined && typeof pipeline.tierAllowedForRuntime === 'function'
      && !pipeline.tierAllowedForRuntime(runtime, record.model)) {
    fail(`model "${record.model}" is not available on runtime "${runtime}"`);
  }
  for (const key of ['effort', 'effort_applied', 'observed_effort']) {
    if (record[key] === undefined) continue;
    if (!EFFORT_STATES.has(record[key])) {
      fail(`${key} "${record[key]}" is not a supported effort or evidence state`);
    }
  }
  if (record.completion_status !== undefined && !COMPLETION_STATES.has(record.completion_status)) {
    fail(`completion_status must be one of ${[...COMPLETION_STATES].join(', ')}`);
  }
  // The ledger can outlive the checkout that recorded it. Store transcript
  // sources as absolute paths at write time so a later report process in a
  // different cwd can still join the durable fact to its transcript.
  if (record.source !== undefined) record.source = canonicalSource(record.source);

  record.observation_id = raw.observation_id === undefined
    ? deriveObservationId(record)
    : raw.observation_id;
  const idIssue = textIssue(record.observation_id, 'observation_id', { whitespace: true });
  if (idIssue) fail(idIssue);
  if (raw.revision !== undefined) {
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) fail('revision must be a positive safe integer');
    record.revision = raw.revision;
  }
  return record;
}

function parseLedger(raw, file = LEDGER_NAME) {
  const records = [];
  const warnings = [];
  for (const [index, line] of String(raw || '').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record is not an object');
      records.push(value);
    } catch (error) {
      warnings.push(`${path.basename(file)}:${index + 1}: malformed JSON (${error.message})`);
    }
  }
  return { records, warnings };
}

function readLedger(graphDir) {
  const file = path.join(graphDir, LEDGER_NAME);
  try {
    return { ...parseLedger(fs.readFileSync(file, 'utf8'), file), file };
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], warnings: [], file };
    throw error;
  }
}

function latestRecords(records) {
  const latest = new Map();
  for (const record of records) {
    if (!record || typeof record.observation_id !== 'string') continue;
    const previous = latest.get(record.observation_id);
    const revision = Number.isSafeInteger(record.revision) ? record.revision : 1;
    const previousRevision = previous && Number.isSafeInteger(previous.revision) ? previous.revision : 1;
    if (!previous || revision >= previousRevision) latest.set(record.observation_id, record);
  }
  return [...latest.values()];
}

function sameRecord(a, b) {
  const clean = (value) => {
    const copy = { ...value };
    delete copy.revision;
    // `observed_at` is filled by the writer when a caller omits it. A retry of
    // the same launch fact must therefore stay idempotent even though the retry
    // happens a few milliseconds later.
    delete copy.observed_at;
    return copy;
  };
  const left = clean(a);
  const right = clean(b);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => Object.is(left[key], right[key]));
}

function recordBatch(graphDir, raw) {
  const input = Array.isArray(raw) ? raw : [raw];
  if (!input.length) return { recorded: [], skipped: 0 };
  const dir = path.resolve(graphDir);
  graphGuard(dir, true);
  // Validate all items before taking the lock or changing the file.
  const now = new Date().toISOString();
  const normalized = input.map((item) => normalizeRecord(item, now));
  const ids = new Set();
  for (const item of normalized) {
    if (ids.has(item.observation_id)) fail(`duplicate observation_id "${item.observation_id}" in one batch`);
    ids.add(item.observation_id);
  }

  // The ledger can be explicitly selected outside the usual project layout.
  // Lock beside that ledger, otherwise `/tmp/graph` would contend on
  // `/.planning/graph/.locks` while two writers to the selected file race.
  return withLock(path.join(dir, '.locks'), 'usage-attribution', () => {
    const current = readLedger(dir).records;
    const latest = new Map(latestRecords(current).map((item) => [item.observation_id, item]));
    const toAppend = [];
    for (const item of normalized) {
      const prior = latest.get(item.observation_id);
      if (prior && sameRecord(prior, item)) continue;
      const priorRevision = prior && Number.isSafeInteger(prior.revision) ? prior.revision : 0;
      toAppend.push({ ...item, revision: Math.max(priorRevision + 1, item.revision || 1) });
    }
    if (toAppend.length) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, LEDGER_NAME),
        toAppend.map((item) => JSON.stringify(item)).join('\n') + '\n'
      );
    }
    return { recorded: toAppend, skipped: normalized.length - toAppend.length };
  }, { label: 'usage-attribution' });
}

function main(argv) {
  const parsed = graphFromArgs(argv);
  const [command, ...rest] = parsed.args;
  const cwdGraph = parsed.dir;
  if (!command || command === '--help') {
    console.log('usage: usage-attribution.cjs record --stdin [--graph <dir>]');
    console.log('       usage-attribution.cjs list [--json] [--graph <dir>]');
    return;
  }
  graphGuard(cwdGraph, parsed.explicit);
  if (command === 'record') {
    if (rest.length !== 1 || rest[0] !== '--stdin') fail('record requires --stdin');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch (error) { fail(`stdin is not valid JSON (${error.message})`, 2); }
    const result = recordBatch(cwdGraph, raw);
    console.log(`usage attribution: recorded ${result.recorded.length}, skipped ${result.skipped} identical record(s)`);
    return;
  }
  if (command === 'list') {
    if (rest.length && !(rest.length === 1 && rest[0] === '--json')) fail('usage: usage-attribution.cjs list [--json] [--graph <dir>]');
    const result = latestRecords(readLedger(cwdGraph).records);
    if (rest[0] === '--json') console.log(JSON.stringify(result, null, 2));
    else result.forEach((item) => console.log(`${item.observation_id}: ${item.runtime}/${item.kind} ${item.dispatch_id}`));
    return;
  }
  fail(`unknown command "${command}"`);
}

module.exports = {
  LEDGER_NAME,
  RUNTIME_PROVIDER,
  BACKENDS,
  KINDS,
  COMPLETION_STATES,
  EFFORT_STATES,
  graphGuard,
  normalizeRecord,
  parseLedger,
  readLedger,
  latestRecords,
  recordBatch,
  canonicalSource,
  textIssue,
};

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`usage-attribution: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}
