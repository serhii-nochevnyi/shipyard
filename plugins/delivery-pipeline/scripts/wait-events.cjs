#!/usr/bin/env node
'use strict';

// Durable observations are a small local inbox for the delivery loop.  They do
// not authorize a merge or replace the ADR-014 dispatch boundary: they only tell
// the foreground owner that a complete, meaningful observation is worth serving.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));

const SCHEMA_VERSION = 1;
const STORE_NAME = 'wait-events.json';
const META_NAME = 'delivery-state-meta.json';
const STATE_NAME = 'delivery-state.json';
const FRONT_NAME = 'delivery-front.json';
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
const ACTION_PREFIX = 'wait-event-';

const TIME_KEYS = new Set([
  'at', 'created_at', 'updated_at', 'observed_at', 'generated_at', 'timestamp',
  'submitted_at', 'started_at', 'completed_at', 'next_wake_at', 'deadline',
]);

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function number(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positive(value, fallback) {
  const n = number(value, fallback);
  return n > 0 ? n : fallback;
}

function nowMs(input, io = {}) {
  const candidate = io.now !== undefined ? io.now
    : io.clock && typeof io.clock.now === 'function' ? io.clock.now()
      : input && input.now !== undefined ? input.now : Date.now();
  const value = typeof candidate === 'function' ? candidate() : candidate;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return number(value, Date.now());
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function graphDirOf(input = {}, io = {}) {
  const value = io.graphDir || io.graph || input.graphDir || input.graph
    || process.env.SHIPYARD_GRAPH_DIR || path.join(process.cwd(), '.planning', 'graph');
  return path.resolve(String(value));
}

function projectRoot(graphDir) {
  return path.resolve(graphDir, '..', '..');
}

function text(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const out = String(value).trim();
  return out || fallback;
}

function identityOf(input = {}, io = {}) {
  const repository = text(input.repository !== undefined ? input.repository : input.repo, null);
  const prValue = input.pr !== undefined ? input.pr
    : input.pull_request !== undefined ? input.pull_request : input.pullRequest;
  const prText = prValue === undefined || prValue === null || prValue === '' ? null : String(prValue);
  const pr = prText === null ? null : /^\d+$/.test(prText) ? Number(prText) : prText;
  const head = text(input.head !== undefined ? input.head
    : input.head_sha !== undefined ? input.head_sha : input.headRefOid, 'unknown');
  const out = {
    graphDir: graphDirOf(input, io),
    run_id: text(input.run_id !== undefined ? input.run_id : input.runId,
      text(process.env.SHIPYARD_RUN_ID, 'delivery')),
    ticket: text(input.ticket !== undefined ? input.ticket : input.id, null),
    repository,
    pr,
    head,
  };
  return out;
}

function windowIdOf(input = {}, io = {}) {
  return text(input.window_id !== undefined ? input.window_id : input.windowId,
    text(io.window_id !== undefined ? io.window_id : io.windowId, null));
}

function validIdentity(identity) {
  return !!identity.run_id && !!identity.ticket && !!identity.pr;
}

function recordKey(identity) {
  return digest(stable({
    run_id: identity.run_id,
    ticket: identity.ticket,
    repository: identity.repository,
    pr: identity.pr,
  }));
}

function stripTimes(value) {
  if (Array.isArray(value)) return value.map(stripTimes);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (TIME_KEYS.has(key) || /(?:^|_)(?:at|time|timestamp|date)$/i.test(key)) continue;
    out[key] = stripTimes(value[key]);
  }
  return out;
}

function checkIdentity(row, index) {
  if (!row || typeof row !== 'object') return `unknown-${index}`;
  return text(row.name !== undefined ? row.name
    : row.context !== undefined ? row.context
      : row.id !== undefined ? row.id : row.title, `unknown-${index}`);
}

function checkState(row) {
  if (!row || typeof row !== 'object') return 'unknown';
  const bucket = text(row.bucket, null);
  return (bucket || text(row.state, 'unknown')).toUpperCase();
}

function canonicalChecks(value) {
  if (value === undefined) return undefined;
  if (value === null || value === false || (value && value.unavailable === true)
      || (value && value.available === false)) {
    return { availability: 'unknown' };
  }
  let rows = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.rows)) rows = value.rows;
    else if (Number.isFinite(Number(value.total))) {
      return {
        availability: 'available',
        summary: {
          total: number(value.total, 0),
          pending: number(value.pending, 0),
          failing: number(value.failing, 0),
          none_reported: value.none_reported === true,
          unavailable: value.unavailable === true,
        },
      };
    } else {
      return { availability: 'unknown' };
    }
  }
  if (!Array.isArray(rows)) return { availability: 'unknown' };
  const normalized = rows.map((row, index) => {
    const item = row && typeof row === 'object' ? row : {};
    return {
      identity: checkIdentity(item, index),
      state: checkState(item),
    };
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
  return { availability: 'available', rows: normalized };
}

function reviewIdentity(row, index) {
  if (!row || typeof row !== 'object') return `unknown-${index}`;
  const user = row.user && typeof row.user === 'object'
    ? (row.user.login || row.user.name || row.user.id) : row.user;
  return text(row.reviewer !== undefined ? row.reviewer
    : row.author !== undefined ? row.author : user,
    text(row.id, `unknown-${index}`));
}

function canonicalReviews(value, observation) {
  const hasSummary = observation.review_decision !== undefined
    || observation.reviewDecision !== undefined
    || observation.unresolved_count !== undefined
    || observation.unresolvedCount !== undefined;
  if (value === undefined && !hasSummary) return undefined;
  if (value === null || value === false || (value && value.unavailable === true)
      || (value && value.available === false)) {
    return { availability: 'unknown' };
  }
  let rows = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.rows)) rows = value.rows;
    else if (value.current_reviews && Array.isArray(value.current_reviews)) rows = value.current_reviews;
    else rows = [];
  }
  if (rows !== undefined && !Array.isArray(rows)) return { availability: 'unknown' };
  const normalized = (rows || []).map((row, index) => {
    const item = row && typeof row === 'object' ? row : {};
    return {
      identity: reviewIdentity(item, index),
      state: text(item.state !== undefined ? item.state : item.decision, 'UNKNOWN').toUpperCase(),
      unresolved: item.unresolved === true || item.resolved === false,
    };
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
  const decision = text(
    observation.review_decision !== undefined ? observation.review_decision : observation.reviewDecision,
    null,
  );
  const unresolved = observation.unresolved_count !== undefined
    ? number(observation.unresolved_count, null)
    : observation.unresolvedCount !== undefined ? number(observation.unresolvedCount, null) : null;
  return {
    availability: 'available',
    ...(decision === null ? {} : { decision: decision.toUpperCase() }),
    ...(unresolved === null ? {} : { unresolved_count: unresolved }),
    rows: normalized,
  };
}

function canonicalEligibility(value) {
  if (value === undefined) return undefined;
  const front = value && value.actionable ? value : { actionable: value };
  const actionable = front.actionable && typeof front.actionable === 'object' ? front.actionable : {};
  const out = {};
  for (const key of ['execute', 'publish', 'fix', 'finalize', 'merge', 'ci-fix', 'review-fix', 'arch-review']) {
    if (Array.isArray(actionable[key]) && actionable[key].length) out[key] = [...actionable[key]].map(String).sort();
  }
  return {
    actionable: out,
    actionable_count: number(front.actionable_count, Object.values(out).reduce((n, list) => n + list.length, 0)),
    dispatched: Array.isArray(front.waiting && front.waiting.dispatched)
      ? [...front.waiting.dispatched].map(String).sort() : [],
  };
}

function canonicalObservation(input = {}) {
  const observation = input.observation && typeof input.observation === 'object'
    ? { ...input.observation } : { ...input };
  const checksValue = observation.checks !== undefined ? observation.checks
    : observation.ci !== undefined ? observation.ci : undefined;
  const reviewsValue = observation.reviews !== undefined ? observation.reviews
    : observation.review !== undefined ? observation.review : undefined;
  const out = {};
  const checks = canonicalChecks(checksValue);
  const reviews = canonicalReviews(reviewsValue, observation);
  if (checks !== undefined) out.checks = checks;
  if (reviews !== undefined) out.reviews = reviews;
  for (const key of ['status', 'draft', 'merge_state', 'base', 'base_ref', 'gate', 'availability', 'child_status']) {
    if (observation[key] !== undefined) out[key] = stripTimes(observation[key]);
  }
  const eligibility = canonicalEligibility(
    observation.eligibility !== undefined ? observation.eligibility : observation.front,
  );
  if (eligibility !== undefined) out.eligibility = eligibility;
  for (const [key, value] of Object.entries(observation)) {
    if (['observation', 'checks', 'ci', 'reviews', 'review', 'review_decision', 'reviewDecision',
      'unresolved_count', 'unresolvedCount', 'eligibility', 'front', 'actionable', 'now'].includes(key)) continue;
    if (TIME_KEYS.has(key) || /(?:^|_)(?:at|time|timestamp|date)$/i.test(key)) continue;
    if (out[key] === undefined && value !== undefined && typeof value !== 'function') out[key] = stripTimes(value);
  }
  if (out.reviews === undefined && (observation.review_decision !== undefined || observation.reviewDecision !== undefined)) {
    out.reviews = canonicalReviews(undefined, observation);
  }
  return out;
}

function availabilityOf(observation) {
  const sources = [];
  if (observation.checks) sources.push(observation.checks.availability);
  if (observation.reviews) sources.push(observation.reviews.availability);
  if (observation.availability === 'unknown') return 'unknown';
  if (sources.includes('unknown')) return sources.every((s) => s === 'unknown') ? 'unknown' : 'partial';
  return 'available';
}

function hasActionable(front) {
  if (!front || typeof front !== 'object') return false;
  const actionable = front.actionable && typeof front.actionable === 'object' && !Array.isArray(front.actionable)
    ? front.actionable : {};
  const listed = Object.values(actionable).reduce((total, entries) =>
    total + (Array.isArray(entries) ? entries.length : 0), 0);
  const count = typeof front.actionable_count === 'number' && Number.isFinite(front.actionable_count)
    ? front.actionable_count : listed;
  const left = typeof front.left_behind_count === 'number' && Number.isFinite(front.left_behind_count)
    ? front.left_behind_count : 0;
  const capacity = front.capacity && typeof front.capacity === 'object' ? front.capacity : null;
  const free = capacity && typeof capacity.free === 'number' && Number.isFinite(capacity.free)
    ? capacity.free : null;
  const max = capacity && typeof capacity.max === 'number' && Number.isFinite(capacity.max)
    ? capacity.max : null;
  return count > 0 && left < count && !(free !== null && max !== null && free <= 0);
}

function inputObservation(input) {
  const source = input.observation !== undefined ? input : { observation: input };
  return canonicalObservation(source);
}

function readStore(graphDir) {
  const file = path.join(graphDir, STORE_NAME);
  if (!fs.existsSync(file)) return { store: { schema_version: SCHEMA_VERSION, records: {} }, bootstrapped: true };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    return { error: refusal('STORE_MALFORMED', `${STORE_NAME} is unreadable (${error.message}); history was preserved`) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.schema_version !== SCHEMA_VERSION || !parsed.records || typeof parsed.records !== 'object'
      || Array.isArray(parsed.records)) {
    const version = parsed && parsed.schema_version;
    const code = Number.isInteger(version) && version > SCHEMA_VERSION ? 'STORE_NEWER_SCHEMA' : 'STORE_MALFORMED';
    return { error: refusal(code,
      `${STORE_NAME} has unsupported schema ${version === undefined ? 'missing' : version}; history was preserved`) };
  }
  for (const record of Object.values(parsed.records)) {
    if (!validRecord(record)) {
      return { error: refusal('STORE_MALFORMED', `${STORE_NAME} contains an invalid record; history was preserved`) };
    }
  }
  return { store: parsed, bootstrapped: false };
}

function validRecord(record) {
  const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== SCHEMA_VERSION
      || typeof record.run_id !== 'string' || !record.run_id
      || typeof record.ticket !== 'string' || !record.ticket
      || !Object.prototype.hasOwnProperty.call(record, 'repository')
      || !((typeof record.pr === 'string' && record.pr) || (typeof record.pr === 'number' && Number.isFinite(record.pr) && record.pr > 0))
      || typeof record.head !== 'string' || !record.head
      || (record.window_id !== undefined && record.window_id !== null
        && (typeof record.window_id !== 'string' || !record.window_id))
      || !Object.prototype.hasOwnProperty.call(record, 'observation_digest')
      || (record.observation_digest !== null && typeof record.observation_digest !== 'string')
      || (record.trusted_observation_digest !== null && record.trusted_observation_digest !== undefined
        && typeof record.trusted_observation_digest !== 'string')
      || !Number.isInteger(record.transition_sequence) || record.transition_sequence < 0
      || !timestamp(record.deadline) || !timestamp(record.next_wake_at)
      || !Number.isFinite(record.interval_ms) || record.interval_ms <= 0
      || !Number.isFinite(record.backoff) || record.backoff <= 0
      || !Number.isFinite(record.max_backoff_ms) || record.max_backoff_ms <= 0
      || !record.actions || typeof record.actions !== 'object' || Array.isArray(record.actions)
      || !record.acknowledgments || typeof record.acknowledgments !== 'object' || Array.isArray(record.acknowledgments)
      || !record.consumed || typeof record.consumed !== 'object' || Array.isArray(record.consumed)) return false;
  if (record.pending_action !== null
      && !validAction(record.pending_action)) return false;
  if (record.ack !== null && (!record.ack || typeof record.ack !== 'object' || Array.isArray(record.ack))) return false;
  if (!Object.values(record.actions).every(validAction)) return false;
  if (record.pending_action && !record.actions[record.pending_action.action_id]) return false;
  if (!Object.values(record.consumed).every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.action_id === 'string' && typeof entry.dispatch_id === 'string')) return false;
  return Object.values(record.acknowledgments).every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.action_id === 'string' && typeof entry.dispatch_id === 'string'
    && ['reserved', 'dispatched', 'no-action'].includes(entry.decision));
}

function validAction(action) {
  return !!action && typeof action === 'object' && !Array.isArray(action)
    && typeof action.action_id === 'string' && !!action.action_id
    && typeof action.dispatch_id === 'string' && !!action.dispatch_id;
}

function refusal(code, reason) {
  return { ok: false, refused: true, code, reason, action: null };
}

function writeStore(graphDir, store) {
  writeAtomic(path.join(graphDir, STORE_NAME), JSON.stringify(store, null, 2) + '\n');
}

function lockedStore(graphDir, fn) {
  return withLock(lockDirFor(projectRoot(graphDir)), 'wait-events', fn, { label: 'wait-events' });
}

function actionFor(identity, observationDigest, sequence, createdAt) {
  const actionId = `${ACTION_PREFIX}${digest({
    run_id: identity.run_id,
    ticket: identity.ticket,
    repository: identity.repository,
    pr: identity.pr,
    head: identity.head,
    observation_digest: observationDigest,
    transition_sequence: sequence,
  }).slice(0, 40)}`;
  return {
    action_id: actionId,
    dispatch_id: actionId,
    event_type: 'model-work',
    reason: 'semantic-observation-transition',
    run_id: identity.run_id,
    ticket: identity.ticket,
    repository: identity.repository,
    pr: identity.pr,
    head: identity.head,
    observation_digest: observationDigest,
    transition_sequence: sequence,
    created_at: createdAt,
  };
}

function baseRecord(identity, now, interval, deadline, windowId = null) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: identity.run_id,
    ticket: identity.ticket,
    repository: identity.repository,
    pr: identity.pr,
    head: identity.head,
    window_id: windowId,
    observation: null,
    observation_digest: null,
    trusted_observation: null,
    trusted_observation_digest: null,
    transition_sequence: 0,
    observed_at: null,
    next_wake_at: iso(Math.min(now + interval, deadline)),
    deadline: iso(deadline),
    interval_ms: interval,
    backoff: interval,
    max_backoff_ms: DEFAULT_MAX_BACKOFF_MS,
    pending_action: null,
    ack: null,
    actions: {},
    acknowledgments: {},
    consumed: {},
    terminal: null,
  };
}

function nextUnacknowledged(record) {
  const actions = Object.values(record.actions || {})
    .filter((action) => !(record.acknowledgments || {})[action.action_id])
    .sort((a, b) => (a.transition_sequence || 0) - (b.transition_sequence || 0));
  return actions[0] || null;
}

function observe(input = {}, io = {}) {
  const identity = identityOf(input, io);
  if (!validIdentity(identity)) return refusal('INVALID_IDENTITY', 'run_id, ticket and PR are required; no event was written');
  const graphDir = identity.graphDir;
  const requestedWindowId = windowIdOf(input, io);
  const observation = inputObservation(input);
  const observationDigest = digest({ head: identity.head, observation });
  const now = nowMs(input, io);
  const interval = positive(io.interval_ms !== undefined ? io.interval_ms
    : input.interval_ms !== undefined ? input.interval_ms
      : input.interval_s !== undefined ? Number(input.interval_s) * 1000 : DEFAULT_INTERVAL_MS,
  DEFAULT_INTERVAL_MS);
  const requestedDeadline = io.deadline !== undefined ? io.deadline
    : input.deadline !== undefined ? input.deadline : null;
  const requestedDeadlineCandidate = requestedDeadline === null
    ? now + positive(io.timeout_ms !== undefined ? io.timeout_ms : input.timeout_ms, DEFAULT_DEADLINE_MS)
    : (typeof requestedDeadline === 'string' && !/^\d+(?:\.\d+)?$/.test(requestedDeadline)
      ? Date.parse(requestedDeadline) : number(requestedDeadline, NaN));
  const requestedDeadlineMs = Number.isFinite(requestedDeadlineCandidate)
    ? requestedDeadlineCandidate : now + DEFAULT_DEADLINE_MS;
  const eligibility = input.eligibility !== undefined ? input.eligibility : input.front;
  try {
    return lockedStore(graphDir, () => {
      const loaded = readStore(graphDir);
      if (loaded.error) return loaded.error;
      const store = loaded.store;
      const key = recordKey(identity);
      let record = store.records[key];
      const isNew = !record;
      const persistedDeadline = record ? Date.parse(record.deadline || '') : NaN;
      // A process killed in the middle of a window has no terminal marker, so a
      // fresh caller is allowed to resume its persisted deadline. A completed
      // timeout starts a new window with the caller's requested budget. The
      // explicit id still lets a caller that owns a restart carry its identity
      // across processes without silently extending an active window.
      const resumeActiveWindow = !isNew && requestedWindowId
        && record.window_id !== undefined && record.window_id !== null
        && record.terminal === null && Number.isFinite(persistedDeadline) && now < persistedDeadline;
      const sameWindow = !isNew && (!requestedWindowId || !record.window_id
        || record.window_id === requestedWindowId || resumeActiveWindow);
      const resetWindow = !isNew && requestedWindowId && !sameWindow;
      if (isNew) record = baseRecord(identity, now, interval, requestedDeadlineMs, requestedWindowId);
      if (resetWindow) {
        record.window_id = requestedWindowId;
        record.terminal = null;
        record.deadline = iso(requestedDeadlineMs);
        record.next_wake_at = iso(Math.min(now + interval, requestedDeadlineMs));
        record.backoff = interval;
      } else if (requestedWindowId && !record.window_id) {
        record.window_id = requestedWindowId;
      }
      record.actions = record.actions && typeof record.actions === 'object' && !Array.isArray(record.actions)
        ? record.actions : {};
      record.acknowledgments = record.acknowledgments
        && typeof record.acknowledgments === 'object' && !Array.isArray(record.acknowledgments)
        ? record.acknowledgments : {};
      record.consumed = record.consumed && typeof record.consumed === 'object' && !Array.isArray(record.consumed)
        ? record.consumed : {};
      const previousDigest = record.observation_digest;
      const previousAvailability = record.observation_availability;
      const changed = previousDigest !== null && previousDigest !== observationDigest;
      const availability = availabilityOf(observation);
      const previousTrustedDigest = record.trusted_observation_digest === undefined
        ? (previousAvailability === undefined || previousAvailability === 'available' ? previousDigest : null)
        : record.trusted_observation_digest;
      const trustedChanged = previousTrustedDigest !== null
        && previousTrustedDigest !== observationDigest;
      record.schema_version = SCHEMA_VERSION;
      record.run_id = identity.run_id;
      record.ticket = identity.ticket;
      record.repository = identity.repository;
      record.pr = identity.pr;
      record.head = identity.head;
      record.observation = observation;
      record.observation_digest = observationDigest;
      record.observation_availability = availability;
      record.observed_at = iso(now);
      record.interval_ms = interval;
      record.max_backoff_ms = positive(input.max_backoff_ms || io.max_backoff_ms, DEFAULT_MAX_BACKOFF_MS);
      const deadline = resetWindow ? requestedDeadlineMs
        : Number.isFinite(persistedDeadline) ? persistedDeadline : requestedDeadlineMs;
      record.deadline = iso(deadline);
      if (isNew || resetWindow) {
        record.backoff = interval;
      } else if (changed && availability === 'available') {
        record.backoff = interval;
      } else {
        record.backoff = Math.min(record.max_backoff_ms, Math.max(interval, number(record.backoff, interval) * 2));
      }
      record.next_wake_at = iso(Math.min(deadline, now + record.backoff));
      const interrupted = hasActionable(eligibility);
      let action = null;
      // Keep the last trusted observation when the wake is suppressed because
      // another actionable item owns the turn. Advancing the baseline here
      // would make the same CI/review transition look unchanged after that work
      // is served, losing the only durable wake for this ticket.
      if (availability === 'available' && !interrupted) {
        record.trusted_observation = observation;
        record.trusted_observation_digest = observationDigest;
      }
      const beforeDeadline = now < deadline;
      if (trustedChanged && availability === 'available' && beforeDeadline && !interrupted) {
        action = actionFor(identity, observationDigest, number(record.transition_sequence, 0) + 1, iso(now));
        record.transition_sequence += 1;
        record.actions = record.actions && typeof record.actions === 'object' ? record.actions : {};
        record.actions[action.action_id] = action;
        if (!record.pending_action || record.acknowledgments[record.pending_action.action_id]) {
          record.pending_action = action;
        }
      }
      if (now >= deadline && !record.terminal) {
        record.terminal = { event_type: 'timeout', at: iso(now), deadline: iso(deadline) };
      }
      store.records[key] = record;
      writeStore(graphDir, store);
      return {
        ok: true,
        changed,
        interrupted,
        transition_sequence: record.transition_sequence,
        observation_digest: observationDigest,
        window_id: record.window_id || null,
        next_wake_at: record.next_wake_at,
        deadline: record.deadline,
        backoff: record.backoff,
        terminal: clone(record.terminal),
        action: clone(action),
        pending_action: clone(record.pending_action),
        record: clone(record),
      };
    });
  } catch (error) {
    return refusal('STORE_WRITE_FAILED', `could not persist wait event: ${error.message}`);
  }
}

function pending(input = {}, io = {}) {
  const identity = identityOf(input, io);
  if (!validIdentity(identity)) return refusal('INVALID_IDENTITY', 'run_id, ticket and PR are required; no event was consumed');
  try {
    return lockedStore(identity.graphDir, () => {
      const loaded = readStore(identity.graphDir);
      if (loaded.error) return loaded.error;
      const store = loaded.store;
      const record = store.records[recordKey(identity)];
      if (!record) return null;
      const action = record.pending_action || nextUnacknowledged(record);
      if (!action) return null;
      const existing = record.consumed && record.consumed[action.action_id];
      const requestedDispatch = io.dispatch_id || input.dispatch_id;
      if (requestedDispatch && requestedDispatch !== action.dispatch_id) {
        return refusal('DISPATCH_ID_MISMATCH', 'the pending action is bound to a different dispatch identity; no scheduling occurred');
      }
      const now = nowMs(input, io);
      record.consumed = record.consumed && typeof record.consumed === 'object' ? record.consumed : {};
      if (!existing) {
        record.consumed[action.action_id] = {
          action_id: action.action_id,
          dispatch_id: action.dispatch_id,
          consumed_at: iso(now),
        };
        record.pending_action = { ...action, consumed_at: iso(now) };
        store.records[recordKey(identity)] = record;
        writeStore(identity.graphDir, store);
      }
      return {
        ...clone(action),
        pending_action: clone(action),
        replay: !!existing,
        consumed: true,
        consumed_at: existing ? existing.consumed_at : record.consumed[action.action_id].consumed_at,
        record: clone(record),
      };
    });
  } catch (error) {
    return refusal('STORE_READ_FAILED', `could not consume pending wait event: ${error.message}`);
  }
}

function acknowledge(input = {}, ack = {}, io = {}) {
  const identity = identityOf(input, io);
  if (!validIdentity(identity)) return refusal('INVALID_IDENTITY', 'run_id, ticket and PR are required; no event was acknowledged');
  const actionId = text(ack.action_id !== undefined ? ack.action_id : ack.actionId, null);
  const dispatchId = text(ack.dispatch_id !== undefined ? ack.dispatch_id : ack.dispatchId, null);
  const decision = text(ack.decision, null);
  if (!actionId || !dispatchId) return refusal('ACK_INCOMPLETE', 'action_id and dispatch_id are required before acknowledgment');
  if (!['reserved', 'dispatched', 'no-action', 'no_action'].includes(decision)) {
    return refusal('ACK_DECISION_REQUIRED', 'acknowledgment requires a durable reserved, dispatched or no-action decision');
  }
  try {
    return lockedStore(identity.graphDir, () => {
      const loaded = readStore(identity.graphDir);
      if (loaded.error) return loaded.error;
      const store = loaded.store;
      const record = store.records[recordKey(identity)];
      if (!record || !record.actions || !record.actions[actionId]) {
        return refusal('ACTION_NOT_FOUND', 'the action is not present in durable wait history; no acknowledgment was written');
      }
      const action = record.actions[actionId];
      if (action.dispatch_id !== dispatchId) {
        return refusal('DISPATCH_ID_MISMATCH', 'acknowledgment does not match the action dispatch identity; no acknowledgment was written');
      }
      if (!record.consumed || !record.consumed[actionId]) {
        return refusal('ACK_NOT_CONSUMED', 'the action was not durably consumed/reserved before acknowledgment; no acknowledgment was written');
      }
      record.acknowledgments = record.acknowledgments && typeof record.acknowledgments === 'object'
        ? record.acknowledgments : {};
      const previous = record.acknowledgments[actionId];
      if (previous) {
        if (previous.dispatch_id !== dispatchId) return refusal('DISPATCH_ID_MISMATCH', 'a different dispatch already owns this action');
        return { ok: true, acknowledged: true, duplicate: true, action_id: actionId, dispatch_id: dispatchId, ack: clone(previous) };
      }
      const at = nowMs(ack, io);
      const acknowledgment = {
        action_id: actionId,
        dispatch_id: dispatchId,
        decision: decision === 'no_action' ? 'no-action' : decision,
        acknowledged_at: iso(at),
      };
      record.acknowledgments[actionId] = acknowledgment;
      record.ack = acknowledgment;
      record.actions[actionId] = { ...action, ack: acknowledgment };
      record.pending_action = nextUnacknowledged(record);
      store.records[recordKey(identity)] = record;
      writeStore(identity.graphDir, store);
      return {
        ok: true,
        acknowledged: true,
        duplicate: false,
        action_id: actionId,
        dispatch_id: dispatchId,
        ack: clone(acknowledgment),
        pending_action: clone(record.pending_action),
      };
    });
  } catch (error) {
    return refusal('STORE_WRITE_FAILED', `could not acknowledge wait event: ${error.message}`);
  }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { value: JSON.parse(raw), raw };
  }
  catch (error) { return { error }; }
}

function validPublishedFront(front) {
  return !!front && typeof front === 'object' && !Array.isArray(front)
    && front.actionable && typeof front.actionable === 'object' && !Array.isArray(front.actionable)
    && front.waiting && typeof front.waiting === 'object' && !Array.isArray(front.waiting);
}

function readPublishedUnlocked(graphDir) {
  const metaFile = path.join(graphDir, META_NAME);
  const stateFile = path.join(graphDir, STATE_NAME);
  const frontFile = path.join(graphDir, FRONT_NAME);
  const meta = readJson(metaFile);
  const state = readJson(stateFile);
  const front = readJson(frontFile);
  if (meta.error || state.error || front.error) {
    return refusal('RESYNC_REQUIRED', 'published state, metadata or front is missing/unreadable; no wait event was issued');
  }
  if (!state.value || typeof state.value !== 'object' || Array.isArray(state.value)
      || !validPublishedFront(front.value)) {
    return refusal('RESYNC_REQUIRED', 'published state or scheduling front is incomplete; run state-sync before waking work');
  }
  const metadata = meta.value;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.schema_version !== SCHEMA_VERSION) {
    return refusal('RESYNC_REQUIRED', 'last-published metadata has an unsupported schema; run state-sync before waking work');
  }
  const binding = metadata.binding;
  if (!binding || binding.schema_version !== SCHEMA_VERSION
      || !Number.isInteger(metadata.generation)
      || !Number.isInteger(binding.observation_generation)
      || binding.observation_generation !== metadata.generation
      || typeof binding.state_digest !== 'string' || !binding.state_digest
      || typeof binding.front_digest !== 'string' || !binding.front_digest
      || typeof binding.observation_digest !== 'string' || !binding.observation_digest) {
    return refusal('RESYNC_REQUIRED', 'last-published metadata has no complete versioned state binding; run state-sync before waking work');
  }
  if (digest(state.raw) !== binding.state_digest) {
    return refusal('RESYNC_REQUIRED', 'delivery-state.json does not match last-published metadata; publication may have been interrupted');
  }
  const projection = meta.value.observation_projection;
  if (!projection || typeof projection !== 'object'
      || !projection.tickets || typeof projection.tickets !== 'object' || Array.isArray(projection.tickets)
      || digest(projection) !== binding.observation_digest
      || Number(metadata.observation_generation) !== metadata.generation) {
    return refusal('RESYNC_REQUIRED', 'published observation binding is incomplete or inconsistent; no work was scheduled');
  }
  const frontDigest = digest(front.raw);
  return {
    ok: true,
    metadata: meta.value,
    state: state.value,
    front: front.value,
    observation: projection,
    overlay_changed: !!binding.front_digest && binding.front_digest !== frontDigest,
  };
}

function readPublished(input = {}, io = {}) {
  const graphDir = graphDirOf(input, io);
  try {
    return withLock(lockDirFor(projectRoot(graphDir)), 'state', () => readPublishedUnlocked(graphDir), { label: 'wait-events published read' });
  } catch (error) {
    return refusal('STATE_LOCK_FAILED', `could not validate the published state: ${error.message}`);
  }
}

function projectionForTicket(projection, ticket) {
  if (!projection || typeof projection !== 'object') return null;
  const tickets = projection.tickets && typeof projection.tickets === 'object' ? projection.tickets : projection;
  return tickets[ticket] || null;
}

function observePublished(input = {}, io = {}) {
  const graphDir = graphDirOf(input, io);
  try {
    return withLock(lockDirFor(projectRoot(graphDir)), 'state', () => {
      const published = readPublishedUnlocked(graphDir);
      if (!published.ok) return published;
      const ticket = text(input.ticket !== undefined ? input.ticket : input.id, null);
      const stateEntry = ticket && published.state && published.state[ticket] ? published.state[ticket] : {};
      const projected = projectionForTicket(published.observation, ticket);
      if (!projected) return refusal('RESYNC_REQUIRED', `published observation has no entry for ${ticket || 'the requested ticket'}`);
      const merged = {
        ...input,
        graphDir,
        repository: input.repository !== undefined ? input.repository : stateEntry.repo,
        pr: input.pr !== undefined ? input.pr : stateEntry.pr,
        head: input.head !== undefined ? input.head : stateEntry.head_sha,
        observation: projected,
        eligibility: published.front,
      };
      return observe(merged, io);
    });
  } catch (error) {
    return refusal('STATE_LOCK_FAILED', `could not observe the published state: ${error.message}`);
  }
}

function cliValue(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'pending';
  const graphDir = cliValue(argv, '--graph', process.env.SHIPYARD_GRAPH_DIR);
  const resolvedGraphDir = path.resolve(graphDir || path.join(process.cwd(), '.planning', 'graph'));
  const input = {
    graphDir: resolvedGraphDir,
    run_id: cliValue(argv, '--run-id', process.env.SHIPYARD_RUN_ID || `ci-wait:${resolvedGraphDir}`),
    ticket: cliValue(argv, '--ticket'),
    repository: cliValue(argv, '--repository', cliValue(argv, '--repo')),
    pr: cliValue(argv, '--pr'),
    head: cliValue(argv, '--head'),
  };
  const now = cliValue(argv, '--now', undefined);
  let result;
  if (command === 'observe' || command === 'observe-published') {
    let observation = null;
    const file = cliValue(argv, '--observation-file');
    if (file) {
      try { observation = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
      catch (error) { result = refusal('OBSERVATION_UNREADABLE', `could not read observation: ${error.message}`); }
    }
    if (!result) {
      result = command === 'observe-published'
        ? observePublished(input, { now })
        : observe({ ...input, observation }, {
          now,
          interval_ms: cliValue(argv, '--interval-ms', undefined),
          timeout_ms: cliValue(argv, '--timeout-ms', undefined),
        });
    }
  } else if (command === 'acknowledge') {
    result = acknowledge(input, {
      action_id: cliValue(argv, '--action-id'),
      dispatch_id: cliValue(argv, '--dispatch-id'),
      decision: cliValue(argv, '--decision'),
      now,
    });
  } else if (command === 'pending') {
    result = pending(input, { now, dispatch_id: cliValue(argv, '--dispatch-id') });
  } else {
    result = refusal('USAGE', 'usage: wait-events.cjs <observe|observe-published|pending|acknowledge> [options]');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result && result.refused ? 4 : 0;
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  STORE_NAME,
  canonicalObservation,
  digest,
  observe,
  pending,
  acknowledge,
  readPublished,
  observePublished,
  stableStringify: stable,
});

if (require.main === module) cli();
