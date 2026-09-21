#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRunStore } = require('./run-store.cjs');
const { statusFor } = require('./run-controller.cjs');
const { withLock, writeAtomic } = require('./lock.cjs');

const SCHEMA = 'shipyard.run-waker.v1';
const VERSION = 1;
const EVENTS_FILE = 'wake-events.jsonl';
const CLAIMS_FILE = 'wake-claims.json';
const WAIT_KINDS = new Set(['ci', 'review', 'quota', 'lease', 'host']);
const TERMINAL = new Set(['completed', 'failed', 'human_checkpoint']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(code, message, details = {}) {
  const result = new Error(`run-waker: ${message}`);
  result.code = code;
  result.details = details;
  return result;
}

function safe(value, field, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw error('INVALID_INPUT', `${field} must be a non-empty safe string`, { field });
  }
  const result = value.trim();
  if (result.length > max) throw error('INVALID_INPUT', `${field} exceeds ${max} characters`, { field });
  return result;
}

function id(value, field) {
  return safe(value, field, 512);
}

function storeDirOf(input = {}) {
  const value = input.store_dir || input.storeDir || process.env.SHIPYARD_RUN_STORE_DIR;
  if (value) return path.resolve(safe(String(value), 'store_dir'));
  const graph = input.graph_dir || input.graphDir || process.env.SHIPYARD_GRAPH_DIR;
  if (graph) return path.join(path.resolve(safe(String(graph), 'graph_dir')), 'runs');
  return path.join(process.cwd(), '.planning', 'graph', 'runs');
}

function graphDirOf(worktree) {
  return path.join(worktree, '.planning', 'graph');
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function readRun(input = {}) {
  const runId = id(input.run_id || input.runId, 'run_id');
  const storeDir = storeDirOf(input);
  let record;
  try { record = createRunStore({ storeDir }).get(runId); } catch (cause) {
    throw error('RUN_STORE_UNAVAILABLE', cause.message, { store_dir: storeDir });
  }
  if (!record) throw error('RUN_NOT_FOUND', `run ${runId} does not exist`, { run_id: runId, store_dir: storeDir });
  const now = Number.isSafeInteger(input.now) ? input.now : Date.now();
  const status = statusFor(record, now);
  const worktree = record.run.worktree.path;
  const graphDir = graphDirOf(worktree);
  const requestedGraph = input.graph_dir || input.graphDir;
  if (requestedGraph && !samePath(graphDir, requestedGraph)) {
    throw error('SCOPE_MISMATCH', `graph ${path.resolve(String(requestedGraph))} does not belong to run ${runId}`, {
      run_id: runId, expected_graph: graphDir, graph: path.resolve(String(requestedGraph)),
    });
  }
  if (input.worktree && !samePath(worktree, input.worktree)) {
    throw error('SCOPE_MISMATCH', `worktree ${path.resolve(String(input.worktree))} does not belong to run ${runId}`, {
      run_id: runId, expected_worktree: worktree, worktree: path.resolve(String(input.worktree)),
    });
  }
  return Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    run_id: runId,
    store_dir: storeDir,
    graph_dir: graphDir,
    worktree,
    record,
    run: record.run,
    status,
    scope: status.scope,
  });
}

function eventValue(input = {}, now = Date.now()) {
  const runId = id(input.run_id || input.runId, 'event.run_id');
  const kind = id(input.kind || input.wait_kind || input.waitKind, 'event.kind');
  if (!WAIT_KINDS.has(kind)) throw error('INVALID_INPUT', `event.kind ${kind} is not supported`);
  const eventId = id(input.event_id || input.eventId || `wake-event-${crypto.randomUUID()}`, 'event.event_id', 512);
  const wakeId = input.wake_id || input.wakeId || null;
  if (wakeId !== null) id(wakeId, 'event.wake_id');
  const revision = input.state_revision === undefined || input.state_revision === null ? null : Number(input.state_revision);
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw error('INVALID_INPUT', 'event.state_revision must be a non-negative integer');
  }
  return Object.freeze({
    schema: 'shipyard.wake-event.v1',
    version: VERSION,
    event_id: eventId,
    run_id: runId,
    wake_id: wakeId,
    kind,
    state_revision: revision,
    at: Number.isSafeInteger(input.at) ? input.at : now,
    reason: input.reason === undefined || input.reason === null ? null : safe(String(input.reason), 'event.reason'),
  });
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw error('EVENT_STORE_UNAVAILABLE', `${file} is unreadable: ${cause.message}`, { file });
  }
}

function recordWakeEvent(input = {}) {
  const storeDir = storeDirOf(input);
  const event = eventValue(input);
  const file = path.join(storeDir, EVENTS_FILE);
  const lockDir = path.join(storeDir, '.locks');
  return withLock(lockDir, 'run-waker-events', () => {
    const rows = readLines(file);
    const existing = rows.find((row) => row && row.event_id === event.event_id);
    if (existing) {
      const comparable = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'at'));
      if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(event))) throw error('DUPLICATE_EVENT', `event ${event.event_id} contradicts its durable record`);
      return { recorded: false, idempotent: true, event: existing };
    }
    writeAtomic(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}${JSON.stringify(event)}\n`);
    return { recorded: true, idempotent: false, event };
  }, { label: 'run-waker-events' });
}

function wakeEvents(info, wakeId = null) {
  return readLines(path.join(info.store_dir, EVENTS_FILE))
    .filter((event) => event && event.run_id === info.run_id && (!wakeId || !event.wake_id || event.wake_id === wakeId))
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function readiness(info, now = Date.now()) {
  const state = info.status.state;
  if (TERMINAL.has(state)) return { ready: false, status: 'terminal', reason: state };
  if (!['waiting', 'runtime_unavailable', 'retryable'].includes(state)) {
    return { ready: false, status: 'not-waiting', reason: state };
  }
  const wake = info.run.wake;
  const wakeId = wake && wake.wake_id ? wake.wake_id : null;
  const events = wakeEvents(info, wakeId);
  const event = events.find((row) => row.state_revision === null || row.state_revision === undefined
    || row.state_revision <= info.status.state_revision) || null;
  const dueAt = wake && Number.isSafeInteger(wake.due_at) ? wake.due_at : null;
  const retryAt = info.status.retry && Number.isSafeInteger(info.status.retry.next_at)
    ? info.status.retry.next_at : null;
  const ownerExpired = info.status.owner && info.status.owner.expired === true;
  const due = (dueAt !== null && dueAt <= now) || (retryAt !== null && retryAt <= now) || ownerExpired;
  return {
    ready: Boolean(event || due),
    status: event ? 'event' : due ? 'due' : 'waiting',
    event,
    wake_id: wakeId,
    due_at: dueAt,
    retry_at: retryAt,
    owner_expired: ownerExpired,
  };
}

function claim(info, wakeId, now = Date.now()) {
  const file = path.join(info.store_dir, CLAIMS_FILE);
  const lockDir = path.join(info.store_dir, '.locks');
  return withLock(lockDir, 'run-waker-claims', () => {
    let store = { schema: 'shipyard.wake-claims.v1', version: VERSION, claims: {} };
    try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (cause) { if (cause.code !== 'ENOENT') throw error('CLAIM_STORE_UNAVAILABLE', cause.message, { file }); }
    if (!store || typeof store !== 'object' || !store.claims || typeof store.claims !== 'object') {
      throw error('CLAIM_STORE_UNAVAILABLE', `${file} has an invalid schema`, { file });
    }
    const key = `${info.run_id}:${wakeId || `revision-${info.status.state_revision}`}`;
    const prior = store.claims[key];
    if (prior) return { claimed: false, idempotent: true, claim: prior };
    const value = { schema: 'shipyard.wake-claim.v1', version: VERSION, key, run_id: info.run_id, wake_id: wakeId, state_revision: info.status.state_revision, claimed_at: now, status: 'claimed' };
    store.claims[key] = value;
    writeAtomic(file, `${JSON.stringify(store, null, 2)}\n`);
    return { claimed: true, idempotent: false, claim: value };
  }, { label: 'run-waker-claims' });
}

async function wakeOnce(options = {}) {
  const info = readRun(options);
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const ready = readiness(info, now);
  if (!ready.ready) return { schema: SCHEMA, version: VERSION, status: ready.status, run_id: info.run_id, scope: info.scope, readiness: ready };
  const controller = options.controller;
  if (!controller || typeof controller.wake !== 'function') {
    return { schema: SCHEMA, version: VERSION, status: 'ready', run_id: info.run_id, scope: info.scope, readiness: ready, launched: false };
  }
  const wakeId = ready.wake_id || `revision-${info.status.state_revision}`;
  let wakeResult;
  try {
    wakeResult = controller.wake(info.run_id, {
      event_id: `run-waker:${info.run_id}:${wakeId}`,
      wake_id: ready.wake_id || undefined,
      force: ready.status === 'event' || ready.owner_expired,
      reason: ready.event && ready.event.reason ? ready.event.reason : 'durable run wake',
    });
  } catch (cause) {
    return {
      schema: SCHEMA,
      version: VERSION,
      status: 'retryable_pending',
      run_id: info.run_id,
      scope: info.scope,
      readiness: ready,
      error: { code: cause.code || 'WAKE_FAILED', message: cause.message },
    };
  }
  const reserved = claim(info, wakeId, now);
  if (!reserved.claimed) return { schema: SCHEMA, version: VERSION, status: 'already-launched', run_id: info.run_id, scope: info.scope, readiness: ready, claim: reserved.claim };
  let launchResult = null;
  if (typeof options.launchNext === 'function') launchResult = await options.launchNext({ run_id: info.run_id, scope: info.scope, readiness: ready, wake: wakeResult });
  return { schema: SCHEMA, version: VERSION, status: 'launched', run_id: info.run_id, scope: info.scope, readiness: ready, claim: reserved.claim, wake: wakeResult, launch: launchResult };
}

async function waitForWake(options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeout_ms) && options.timeout_ms > 0 ? options.timeout_ms : 15 * 60 * 1000;
  const intervalMs = Number.isSafeInteger(options.interval_ms) && options.interval_ms > 0 ? options.interval_ms : 1000;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = clock() + timeoutMs;
  for (;;) {
    const result = await wakeOnce({ ...options, now: clock() });
    if (result.status !== 'waiting') return { ...result, waited: true };
    const remaining = deadline - clock();
    if (remaining <= 0) return { schema: SCHEMA, version: VERSION, status: 'timeout', run_id: result.run_id, scope: result.scope, readiness: result.readiness, waited: true };
    await sleep(Math.min(intervalMs, remaining));
  }
}

function argvValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] || null;
}

async function cli(argv = process.argv.slice(2)) {
  const command = argv[0] || 'wait';
  const runId = argvValue(argv, '--run-id');
  const storeDir = argvValue(argv, '--store-dir');
  const graphDir = argvValue(argv, '--graph');
  const base = { run_id: runId, store_dir: storeDir || undefined, graph_dir: graphDir || undefined };
  let result;
  if (command === 'record') {
    result = recordWakeEvent({ ...base, kind: argvValue(argv, '--kind'), wake_id: argvValue(argv, '--wake-id'), event_id: argvValue(argv, '--event-id'), reason: argvValue(argv, '--reason') });
  } else if (command === 'wait') {
    result = await waitForWake({ ...base, timeout_ms: Number(argvValue(argv, '--timeout-ms')) || undefined, interval_ms: Number(argvValue(argv, '--interval-ms')) || undefined });
  } else {
    throw error('INVALID_INPUT', `unknown command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  EVENTS_FILE,
  CLAIMS_FILE,
  readRun,
  recordWakeEvent,
  readiness,
  wakeOnce,
  waitForWake,
});

if (require.main === module) {
  cli().catch((cause) => {
    process.stdout.write(`${JSON.stringify({ schema: SCHEMA, version: VERSION, status: 'retryable_pending', reason: cause.code || 'RUN_WAKER_FAILED', message: cause.message }, null, 2)}\n`);
    process.exitCode = 10;
  });
}
