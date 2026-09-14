#!/usr/bin/env node
'use strict';

// tracker-record.cjs — the durable READ cache for ADR-009 D5.
//
// This store is deliberately separate from jira-projection.json. The latter is
// a write watermark for telling Jira what Shipyard did; this one records what
// Jira said before Shipyard takes new work. They have different subjects and
// different expiry rules, so combining them would make a projection write look
// like eligibility evidence.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
const { resolveGraphDir } = require(path.join(__dirname, 'graph-dir.cjs'));
const { evaluateEligibility, normalizeStatusName, normalizeAssignee } = require(path.join(__dirname, 'tracker-eligibility.cjs'));

const STORE_NAME = 'tracker.json';
const META_NAME = 'delivery-state-meta.json';
const PENDING_NAME = '.tracker-override.pending.json';

function fail(message) {
  process.stderr.write(`tracker-record: ${message}\n`);
  process.exit(1);
}

function graphStore(graphDir) {
  return path.join(graphDir, STORE_NAME);
}

function pendingPath(graphDir) {
  return path.join(graphDir, PENDING_NAME);
}

function fileSnapshot(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { exists: true, file: false, data: null };
    return { exists: true, file: true, data: fs.readFileSync(file) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, file: false, data: null };
    throw error;
  }
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function completeJsonl(data) {
  if (!data.length || data[data.length - 1] !== 0x0a) return false;
  const lines = data.toString('utf8').split('\n').slice(0, -1);
  return lines.length > 0 && lines.every((line) => {
    if (!line) return false;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

function partialPrefixBeforeCompleteLines(suffix, eventLine) {
  const limit = Math.min(eventLine.length - 1, suffix.length);
  for (let length = 1; length <= limit; length += 1) {
    if (!eventLine.subarray(0, length).equals(suffix.subarray(0, length))) continue;
    const remainder = suffix.subarray(length);
    if (remainder[0] !== 0x7b || !completeJsonl(remainder)) continue;
    return length;
  }
  return null;
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function sameFileSnapshot(file, expected) {
  const current = fileSnapshot(file);
  if (current.exists !== expected.exists || current.file !== expected.file) return false;
  if (!current.file) return true;
  return current.data.length === expected.data.length
    && digest(current.data) === digest(expected.data);
}

function rewriteJournalIfUnchanged(journal, expected, replacement, remove) {
  // Recovery is the only journal path that rewrites or truncates bytes. Other
  // conveyor writers do not share the tracker lock, so re-check the exact
  // snapshot immediately before this destructive step. If anything landed
  // since the inspection, leave it and the pending marker intact for the next
  // writer instead of erasing a concurrent event.
  if (!sameFileSnapshot(journal, expected)) {
    throw new Error(
      `cannot recover tracker override: the journal changed during recovery — retry after concurrent writers finish`
    );
  }
  if (remove) unlinkIfPresent(journal);
  else writeAtomic(journal, replacement);
}

function restoreStoreSnapshot(graphDir, marker) {
  if (marker.store_file) {
    writeAtomic(graphStore(graphDir), Buffer.from(marker.before_store, 'base64'));
  } else if (!marker.store_exists) {
    unlinkIfPresent(graphStore(graphDir));
  } else {
    throw new Error(`cannot recover tracker override: ${graphStore(graphDir)} was not a regular file before the transaction`);
  }
}

function validPendingMarker(marker) {
  return marker && marker.version === 1
    && typeof marker.event_line === 'string' && marker.event_line.endsWith('\n')
    && typeof marker.after_store === 'string'
    && typeof marker.store_exists === 'boolean'
    && typeof marker.store_file === 'boolean'
    && (!marker.store_file || typeof marker.before_store === 'string')
    && (!marker.store_file || marker.store_exists)
    && typeof marker.journal_exists === 'boolean'
    && typeof marker.journal_file === 'boolean'
    && Number.isInteger(marker.journal_offset) && marker.journal_offset >= 0
    && typeof marker.journal_digest === 'string' && /^[0-9a-f]{64}$/.test(marker.journal_digest);
}

// An override changes two durable stores: the generation-bound cache and its
// audit line. The marker makes that pair recoverable across a killed process.
// Readers fail closed while it exists, and the next writer either finalizes a
// journal line that made it to disk or rolls back a missing/partial append.
function completedRecovery(marker) {
  let event;
  let store;
  try {
    event = JSON.parse(marker.event_line);
    store = JSON.parse(Buffer.from(marker.after_store, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`cannot recover tracker override: completed marker payload is corrupt (${error.message})`);
  }
  const record = store && store.tickets && event && store.tickets[event.ticket];
  if (!event || event.event !== 'tracker_override' || typeof event.ticket !== 'string' || !record) {
    throw new Error('cannot recover tracker override: completed marker has no matching record');
  }
  return { event, record };
}

function recoverPendingLocked(graphDir) {
  const markerFile = pendingPath(graphDir);
  if (!fs.existsSync(markerFile)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch (error) {
    throw new Error(`cannot recover tracker override: ${markerFile} is corrupt (${error.message})`);
  }
  if (!validPendingMarker(marker)) {
    throw new Error(`cannot recover tracker override: ${markerFile} is incomplete`);
  }

  const journal = path.join(graphDir, 'delivery-log.jsonl');
  const current = fileSnapshot(journal);
  if (!current.file) {
    // No append can have happened when the journal is still the same non-file
    // path that the transaction observed. This is also the recoverable form of
    // the EISDIR failure used by the CLI error path.
    if (!marker.journal_file) {
      restoreStoreSnapshot(graphDir, marker);
      unlinkIfPresent(markerFile);
      return null;
    }
    throw new Error(`cannot recover tracker override: ${journal} changed shape while the transaction was pending`);
  }

  if (current.data.length < marker.journal_offset
      || digest(current.data.subarray(0, marker.journal_offset)) !== marker.journal_digest) {
    throw new Error(`cannot recover tracker override: the journal prefix changed while the transaction was pending`);
  }
  const suffix = current.data.subarray(marker.journal_offset);
  const eventLine = Buffer.from(marker.event_line, 'utf8');
  const eventAt = suffix.indexOf(eventLine);
  if (eventAt >= 0 && (eventAt === 0 || suffix[eventAt - 1] === 0x0a)) {
    writeAtomic(graphStore(graphDir), Buffer.from(marker.after_store, 'base64'));
    unlinkIfPresent(markerFile);
    return completedRecovery(marker);
  }
  // Other journal writers do not share the tracker lock. If one appended after
  // the marker but before this transaction's append, keep that complete line
  // and inspect only the final raw byte segment for our possible partial line.
  // Buffer comparison is intentional: decoding a killed UTF-8 append can turn a
  // partial multibyte reason into U+FFFD and strand the marker forever.
  const partialPrefixLength = partialPrefixBeforeCompleteLines(suffix, eventLine);
  if (partialPrefixLength !== null) {
    const preserved = Buffer.concat([
      current.data.subarray(0, marker.journal_offset),
      suffix.subarray(partialPrefixLength),
    ]);
    rewriteJournalIfUnchanged(journal, current, preserved, preserved.length === 0 && !marker.journal_exists);
    restoreStoreSnapshot(graphDir, marker);
    unlinkIfPresent(markerFile);
    return null;
  }
  const lastNewline = suffix.lastIndexOf(0x0a);
  const tail = suffix.subarray(lastNewline + 1);
  if (tail.length === 0) {
    restoreStoreSnapshot(graphDir, marker);
    unlinkIfPresent(markerFile);
    return null;
  }
  if (tail.length > eventLine.length || !eventLine.subarray(0, tail.length).equals(tail)) {
    throw new Error(`cannot recover tracker override: the journal contains an unrelated append at the pending transaction offset`);
  }

  // The append was absent or interrupted before a complete JSONL line. Restore
  // only our partial final segment, preserving any complete intervening lines.
  const rollbackLength = current.data.length - tail.length;
  rewriteJournalIfUnchanged(
    journal,
    current,
    current.data.subarray(0, rollbackLength),
    rollbackLength === 0 && !marker.journal_exists,
  );
  restoreStoreSnapshot(graphDir, marker);
  unlinkIfPresent(markerFile);
  return null;
}

function projectRootOf(graphDir) {
  return path.resolve(graphDir, '..', '..');
}

function hasGraph(graphDir) {
  return !!graphDir && fs.existsSync(path.join(graphDir, 'tickets.json'));
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function readStore(graphDir) {
  const store = readJson(graphStore(graphDir), null);
  return store && store.tickets && typeof store.tickets === 'object' && !Array.isArray(store.tickets)
    ? store
    : { tickets: {} };
}

function ticketMap(graphDir) {
  const graph = readJson(path.join(graphDir, 'tickets.json'), null);
  if (!graph || !graph.tickets || typeof graph.tickets !== 'object' || Array.isArray(graph.tickets)) return null;
  return graph.tickets;
}

function readGeneration(file) {
  if (!fs.existsSync(file)) return { present: false, generation: null };
  const value = readJson(file, null);
  return {
    present: true,
    generation: value && Number.isInteger(value.generation) && value.generation >= 0
      ? value.generation
      : null,
  };
}

// The numeric counter is monotonic only while its metadata file survives. The
// file identity makes a recreated/reset metadata file a new publication epoch,
// even when an operator restores the same numeric generation from a backup.
function metadataIdentity(graphDir) {
  const file = path.join(graphDir, META_NAME);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(file);
    const inode = `${stat.dev}:${stat.ino}:${stat.mtimeNs || Math.round(stat.mtimeMs * 1e6)}`;
    return `${inode}:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

// state-sync records the physical identity of the metadata file that preceded
// the current publish. When the numeric counter is reset or reused, generation
// alone is not enough to decide whether that predecessor belongs to this
// publication epoch.
function metadataPreviousIdentity(graphDir) {
  const value = readJson(path.join(graphDir, META_NAME), null);
  if (!value || !Object.prototype.hasOwnProperty.call(value, 'previous_generation_identity')) {
    // No proof binds a predecessor to this metadata epoch. Treating the missing
    // field as a wildcard would let a reset/recreated metadata file re-accept
    // an old generation-1 record.
    return null;
  }
  return typeof value.previous_generation_identity === 'string'
    && value.previous_generation_identity.trim()
    ? value.previous_generation_identity
    : null;
}

/**
 * Read the generation of the last published delivery-state snapshot.
 *
 * The metadata file is authoritative. A missing or malformed metadata file
 * means there is no trustworthy active generation; the front is an advisory
 * rendering and cannot prove that a snapshot was published. Zero is the
 * pre-publication generation used by isolated/unit callers; production readers
 * never expose records from it.
 */
function currentGeneration(graphDir) {
  const meta = readGeneration(path.join(graphDir, META_NAME));
  return meta.present ? meta.generation : 0;
}

function currentGenerationStrict(graphDir) {
  const meta = readGeneration(path.join(graphDir, META_NAME));
  if (meta.present && Number.isInteger(meta.generation) && meta.generation >= 1) return meta.generation;
  throw new Error('delivery-state generation is unreadable — run state-sync.cjs before recording a tracker observation');
}

function requireGeneration(graphDir) {
  const generation = currentGenerationStrict(graphDir);
  return generation;
}

function requireMetadataIdentity(graphDir) {
  const identity = metadataIdentity(graphDir);
  if (!identity) {
    throw new Error('delivery-state metadata identity is unreadable — run state-sync.cjs before recording a tracker observation');
  }
  return identity;
}

function recordsForGeneration(store, generation, configuredStatuses, identity, options = {}) {
  if (!Number.isInteger(generation) || generation < 1) return {};
  const out = {};
  for (const [ticket, record] of Object.entries(store.tickets)) {
    if (!record || record.ticket !== ticket || record.generation !== generation) continue;
    // The predecessor bridge keeps an external observation alive across the
    // publish boundary, but a direct override is not an observation to carry
    // forward. Its contract is one current-generation exception; including it
    // here would let a named bypass survive the next snapshot.
    if (options.excludeOverrides && record.override === true) continue;
    if (!validRecord(record, configuredStatuses, identity)) continue;
    out[ticket] = { ...record };
  }
  return out;
}

function validRecord(record, configuredStatuses, identity) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.ticket !== 'string' || !record.ticket.trim()) return false;
  if (typeof record.jira_key !== 'string' || !record.jira_key.trim()) return false;
  if (!Number.isInteger(record.generation) || record.generation < 0) return false;
  if (typeof record.generation_identity !== 'string' || !record.generation_identity.trim()) return false;
  if (identity !== undefined && record.generation_identity !== identity) return false;
  if (typeof record.observed_at !== 'string' || !Number.isFinite(Date.parse(record.observed_at))) return false;
  if (typeof record.reason !== 'string' || !record.reason.trim()) return false;
  if (typeof record.assignee_observed !== 'boolean') return false;
  if (record.verdict === 'unknown') {
    return record.eligible === null
      && (record.status === null || (typeof record.status === 'string' && !!record.status.trim()))
      && (record.assignee === null || (typeof record.assignee === 'string' && !!record.assignee.trim()));
  }
  if (!['eligible', 'ineligible'].includes(record.verdict)) return false;
  if (typeof record.status !== 'string' || !record.status.trim()) return false;
  const assigneeObserved = record.assignee_observed === true;
  if (!assigneeObserved) return false;
  if (Array.isArray(configuredStatuses)) {
    const current = evaluateEligibility(record.status, record.assignee, configuredStatuses);
    if (current.verdict !== record.verdict || current.eligible !== record.eligible) return false;
  }
  return typeof record.eligible === 'boolean'
    && record.eligible === (record.verdict === 'eligible')
    && (record.assignee === null || (typeof record.assignee === 'string' && !!record.assignee.trim()));
}

function activeRecords(graphDir, configuredStatuses) {
  if (fs.existsSync(pendingPath(graphDir))) return {};
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  const statuses = Array.isArray(configuredStatuses)
    ? configuredStatuses
    : readConfigStatuses(projectRootOf(graphDir));
  return recordsForGeneration(store, generation, statuses, metadataIdentity(graphDir));
}

// Tracker observations are recorded against the snapshot that was current
// when the external read happened. The next state-sync publishes the next
// generation, so front readers need this narrow, internally-derived bridge
// across that publish boundary. Callers cannot choose an arbitrary generation.
function activePreviousTrackers(graphDir, configuredStatuses) {
  if (fs.existsSync(pendingPath(graphDir))) return {};
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  const previousIdentity = metadataPreviousIdentity(graphDir);
  const statuses = Array.isArray(configuredStatuses)
    ? configuredStatuses
    : readConfigStatuses(projectRootOf(graphDir));
  return Number.isInteger(generation) && generation > 1
    ? recordsForGeneration(store, generation - 1, statuses, previousIdentity, { excludeOverrides: true })
    : {};
}

// Front readers need the current observation and the one publish-boundary
// predecessor as one coherent cache view. The exported wrapper takes the
// tracker lock; state-sync uses the locked form because it already holds that
// lock before entering its state publish.
function activeTrackerSnapshotLocked(graphDir, configuredStatuses) {
  if (fs.existsSync(pendingPath(graphDir))) return {};
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  const statuses = Array.isArray(configuredStatuses)
    ? configuredStatuses
    : readConfigStatuses(projectRootOf(graphDir));
  const previousIdentity = metadataPreviousIdentity(graphDir);
  return {
    ...(Number.isInteger(generation) && generation > 1
      ? recordsForGeneration(store, generation - 1, statuses, previousIdentity, { excludeOverrides: true })
      : {}),
    ...recordsForGeneration(store, generation, statuses, metadataIdentity(graphDir)),
  };
}

function activeTrackerSnapshot(graphDir, configuredStatuses) {
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () =>
    activeTrackerSnapshotLocked(graphDir, configuredStatuses), { label: 'tracker-record read' });
}

// The flat view is convenient for callers that only need the current record;
// unlike the store itself it never exposes an older delivery generation.
const activeTrackers = activeRecords;

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function observedTimestamp(value) {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error('--observed-at must be a valid date/time string');
  }
  return value;
}

function normalizeCliAssignee(value) {
  const text = requireNonEmpty(value, 'assignee');
  if (text.toLowerCase() === 'none') return null;
  const normalized = normalizeAssignee(text);
  if (!normalized.known || !normalized.assigned) throw new Error('assignee must be an id or "none"');
  return normalized.value;
}

function validateTicket(graphDir, ticket, jiraKey) {
  const tickets = ticketMap(graphDir);
  if (!tickets) throw new Error('tickets.json is not a valid ticket graph');
  const id = requireNonEmpty(ticket, 'ticket');
  const key = requireNonEmpty(jiraKey, 'Jira key');
  if (!Object.prototype.hasOwnProperty.call(tickets, id)) {
    throw new Error(`ticket ${id} is not present in tickets.json`);
  }
  const configured = tickets[id] && tickets[id].jira;
  if (configured !== null && configured !== undefined && String(configured).trim()
      && key !== String(configured).trim()) {
    throw new Error(`Jira key ${key} does not match ticket ${id}'s configured key ${String(configured).trim()}`);
  }
  return { ticket: id, jiraKey: key };
}

function readConfigStatuses(projectRoot) {
  try {
    const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
    return loadConfig(projectRoot).config.jira_todo_statuses;
  } catch {
    return [];
  }
}

function writeRecord(graphDir, ticket, record) {
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  fs.mkdirSync(graphDir, { recursive: true });
  // The tracker binding and state-sync publication share this nested critical
  // section. State-sync takes tracker-record -> state before consuming the
  // cache, while the older state writer takes state alone; using the same order
  // here closes both publication races without introducing a reverse lock path.
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => withLock(
    lockDirFor(projectRootOf(graphDir)),
    'state',
    () => {
      recoverPendingLocked(graphDir);
      // Bind the observation while both publication locks are held. A read
      // that queued behind a publish must use one coherent generation/identity
      // pair and belong to the newly current generation, otherwise the next
      // state-sync or active-reader pass can drop the record.
      const boundRecord = {
        ...record,
        generation: requireGeneration(graphDir),
        generation_identity: requireMetadataIdentity(graphDir),
      };
      const store = readStore(graphDir);
      const previous = store.tickets[ticket];
      const sameEpoch = previous && previous.generation_identity === boundRecord.generation_identity;
      const previousGeneration = previous && Number.isInteger(previous.generation) ? previous.generation : -1;
      const incomingGeneration = Number.isInteger(boundRecord.generation) ? boundRecord.generation : -1;
      const previousAt = previous && typeof previous.observed_at === 'string'
        ? Date.parse(previous.observed_at)
        : NaN;
      const incomingAt = typeof boundRecord.observed_at === 'string'
        ? Date.parse(boundRecord.observed_at)
        : NaN;
      // The locks order writers, not the observations they captured before
      // queueing for them. Generation is the primary ordering key: a late
      // result from an older snapshot can never replace a newer snapshot's
      // record. Only observations in the same generation are ordered by time.
      const previousWins = previousGeneration > incomingGeneration
        || (sameEpoch && previousGeneration === incomingGeneration
          && Number.isFinite(previousAt)
          && (!Number.isFinite(incomingAt) || previousAt > incomingAt));
      const stored = previousWins
        ? previous
        : boundRecord;
      store.tickets[ticket] = stored;
      writeAtomic(graphStore(graphDir), JSON.stringify(store, null, 2) + '\n');
      return stored;
    }, { label: 'tracker-record state binding' }), { label: 'tracker-record' });
}

function sameRecoveredOperation(event, operation) {
  return event && operation
    && event.event === operation.event
    && event.ticket === operation.ticket
    && event.jira_key === operation.jira_key
    && event.override_reason === operation.override_reason;
}

function mutateRecord(graphDir, operation, fn) {
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  fs.mkdirSync(graphDir, { recursive: true });
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => {
    const recovered = recoverPendingLocked(graphDir);
    // If this invocation is the retry of a transaction whose journal append
    // and cache write both landed before the process died, return that durable
    // result instead of running the override callback a second time. A
    // different operation may still proceed after recovery has removed the
    // marker.
    if (recovered && sameRecoveredOperation(recovered.event, operation)) return recovered.record;
    const beforeStore = fileSnapshot(graphStore(graphDir));
    const store = readStore(graphDir);
    const result = fn(store);
    if (!result || !result.record) throw new Error('tracker-record mutation did not produce a record');
    store.tickets[result.record.ticket] = result.record;
    const afterStore = JSON.stringify(store, null, 2) + '\n';
    if (!result.event) {
      writeAtomic(graphStore(graphDir), afterStore);
      return result.record;
    }

    const journal = path.join(graphDir, 'delivery-log.jsonl');
    const beforeJournal = fileSnapshot(journal);
    const eventLine = JSON.stringify(result.event) + '\n';
    const marker = {
      version: 1,
      store_exists: beforeStore.exists,
      store_file: beforeStore.file,
      before_store: beforeStore.file ? beforeStore.data.toString('base64') : null,
      after_store: Buffer.from(afterStore).toString('base64'),
      journal_exists: beforeJournal.exists,
      journal_file: beforeJournal.file,
      journal_offset: beforeJournal.file ? beforeJournal.data.length : 0,
      journal_digest: digest(beforeJournal.file ? beforeJournal.data : Buffer.alloc(0)),
      event_line: eventLine,
    };
    writeAtomic(pendingPath(graphDir), JSON.stringify(marker) + '\n');
    try {
      fs.appendFileSync(journal, eventLine);
    } catch (error) {
      throw new Error(
        `the tracker journal at ${journal} could not be appended to (${error.message}).\n` +
        '  The override transaction is pending and remains recoverable; no cache record was published.\n' +
        '  Fix the journal and run tracker-record.cjs override again.'
      );
    }
    writeAtomic(graphStore(graphDir), afterStore);
    // If this unlink is interrupted, the next writer sees the complete event
    // and cache and safely finishes the transaction.
    unlinkIfPresent(pendingPath(graphDir));
    return result.record;
  }, { label: 'tracker-record' });
}

function observe(graphDir, input) {
  const { ticket, jiraKey } = validateTicket(graphDir, input.ticket, input.jiraKey);
  const status = normalizeStatusName(input.status);
  if (!status) throw new Error('status is required for a normal observation');
  if (!input.assigneeProvided) throw new Error('assignee is required for a normal observation (use "none" when unassigned)');
  const assignee = normalizeCliAssignee(input.assignee);
  const result = evaluateEligibility(status, assignee, readConfigStatuses(projectRootOf(graphDir)));
  const observedAt = observedTimestamp(input.observedAt);
  const record = {
    ticket,
    jira_key: jiraKey,
    status: result.status,
    assignee: result.assignee,
    verdict: result.verdict,
    eligible: result.eligible,
    reason: result.reason,
    assignee_observed: true,
    observed_at: observedAt,
  };
  return writeRecord(graphDir, ticket, record);
}

function unknown(graphDir, input) {
  const { ticket, jiraKey } = validateTicket(graphDir, input.ticket, input.jiraKey);
  const reason = requireNonEmpty(input.reason, 'unknown reason');
  let status = null;
  if (input.statusProvided) {
    status = normalizeStatusName(input.status);
    if (!status) throw new Error('status, when provided, must be a non-empty status NAME');
  }
  let assignee = null;
  if (input.assigneeProvided) assignee = normalizeCliAssignee(input.assignee);
  const record = {
    ticket,
    jira_key: jiraKey,
    status,
    assignee,
    verdict: 'unknown',
    eligible: null,
    reason,
    assignee_observed: !!input.assigneeProvided,
    observed_at: observedTimestamp(input.observedAt),
  };
  return writeRecord(graphDir, ticket, record);
}

function override(graphDir, input) {
  const { ticket, jiraKey } = validateTicket(graphDir, input.ticket, input.jiraKey);
  const overrideReason = requireNonEmpty(input.reason, 'override reason');
  const suppliedObservedAt = input.observedAt === undefined ? null : observedTimestamp(input.observedAt);
  const newObservationAt = suppliedObservedAt || observedTimestamp(undefined);
  return mutateRecord(graphDir, {
    event: 'tracker_override',
    ticket,
    jira_key: jiraKey,
    override_reason: overrideReason,
  }, (store) => {
    const generation = requireGeneration(graphDir);
    const generationIdentity = requireMetadataIdentity(graphDir);
    const existing = store.tickets[ticket];
    const reusable = existing && existing.generation === generation
      && existing.generation_identity === generationIdentity
      && existing.jira_key === jiraKey
      && validRecord(existing, readConfigStatuses(projectRootOf(graphDir)), generationIdentity)
      ? existing
      : null;

    if (!reusable) {
      throw new Error('tracker override requires a current-generation tracker observation');
    }
    if (reusable.verdict === 'unknown' && (input.statusProvided || input.assigneeProvided)) {
      throw new Error(
        'tracker facts may be overridden only after a complete current-generation tracker observation'
      );
    }

    let status = reusable && typeof reusable.status === 'string' ? reusable.status : null;
    let assignee = reusable && Object.prototype.hasOwnProperty.call(reusable, 'assignee')
      ? reusable.assignee
      : null;
    let verdict = reusable && typeof reusable.verdict === 'string' ? reusable.verdict : 'unknown';
    let eligible = reusable && Object.prototype.hasOwnProperty.call(reusable, 'eligible')
      ? reusable.eligible
      : null;
    let assigneeObserved = reusable.assignee_observed === true;
    let observationReason = reusable && reusable.reason
      ? reusable.reason
      : 'no current tracker observation was available';
    let observedAt = reusable && reusable.observed_at ? reusable.observed_at : newObservationAt;

    if (input.statusProvided) {
      status = normalizeStatusName(input.status);
      if (!status) throw new Error('status, when provided, must be a non-empty status NAME');
      observedAt = newObservationAt;
    }
    if (input.assigneeProvided) {
      assignee = normalizeCliAssignee(input.assignee);
      assigneeObserved = true;
      observedAt = newObservationAt;
    }
    if (input.statusProvided || input.assigneeProvided) {
      const complete = !!status && assigneeObserved;
      if (complete) {
        const result = evaluateEligibility(status, assignee, readConfigStatuses(projectRootOf(graphDir)));
        verdict = result.verdict;
        eligible = result.eligible;
        observationReason = result.reason;
      } else {
        verdict = 'unknown';
        eligible = null;
        observationReason = 'tracker observation is incomplete; eligibility is unknown';
      }
    }
    const record = {
      ticket,
      jira_key: jiraKey,
      status: status || null,
      assignee: assignee || null,
      verdict,
      eligible,
      reason: observationReason,
      assignee_observed: assigneeObserved,
      override: true,
      override_reason: overrideReason,
      observed_at: observedAt,
      generation,
      generation_identity: generationIdentity,
    };
    const at = new Date().toISOString();
    return {
      record,
      event: {
        ts: at,
        event: 'tracker_override',
        by: 'tracker-record.cjs override',
        ticket,
        jira_key: jiraKey,
        status: record.status,
        assignee: record.assignee,
        verdict: record.verdict,
        observation_reason: record.reason,
        observed_at: record.observed_at,
        override_reason: overrideReason,
        generation,
      },
    };
  });
}

function clear(graphDir, ticket) {
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  const id = requireNonEmpty(ticket, 'ticket');
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => {
    recoverPendingLocked(graphDir);
    const store = readStore(graphDir);
    const had = Object.prototype.hasOwnProperty.call(store.tickets, id);
    delete store.tickets[id];
    writeAtomic(graphStore(graphDir), JSON.stringify(store, null, 2) + '\n');
    return had;
  }, { label: 'tracker-record' });
}

function parseArgs(argv) {
  const args = [...argv];
  const graphAt = args.indexOf('--graph');
  if (graphAt !== -1) {
    const value = args[graphAt + 1];
    if (!value || value.startsWith('--')) throw new Error(`--graph needs a directory value (got ${value ? `the flag "${value}"` : 'nothing'})`);
    args.splice(graphAt, 2);
  }
  const values = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--status' || arg === '--assignee' || arg === '--reason' || arg === '--observed-at') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      const key = arg.slice(2).replace(/-/g, '_');
      values[key] = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, graph: graphAt === -1 ? null : argv[graphAt + 1] };
}

function cli() {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error.message);
  }
  const graph = parsed.graph ? path.resolve(parsed.graph) : resolveGraphDir(argv, process.cwd()).dir;
  if (!hasGraph(graph)) {
    fail(
      `no ticket graph at ${graph} — refusing to record a verdict nothing will read.\n` +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }
  const [command, ticket, jiraKey] = parsed.positional;
  const arity = { mark: 3, unknown: 3, override: 3, clear: 2, list: 1 }[command];
  const usage =
    'usage: tracker-record.cjs mark|unknown|override <ticket> <jira-key> [options] | ' +
    'clear <ticket> [--graph <dir>] | list [--graph <dir>]';
  if (!arity || parsed.positional.length !== arity) fail(usage);
  const values = parsed.values;
  try {
    if (command === 'mark') {
      const record = observe(graph, {
        ticket,
        jiraKey,
        status: values.status,
        assignee: values.assignee,
        statusProvided: Object.prototype.hasOwnProperty.call(values, 'status'),
        assigneeProvided: Object.prototype.hasOwnProperty.call(values, 'assignee'),
        observedAt: values.observed_at,
      });
      console.log(`tracker observation recorded for ${record.ticket} — ${record.verdict} at generation ${record.generation}`);
    } else if (command === 'unknown') {
      const record = unknown(graph, {
        ticket,
        jiraKey,
        status: values.status,
        assignee: values.assignee,
        statusProvided: Object.prototype.hasOwnProperty.call(values, 'status'),
        assigneeProvided: Object.prototype.hasOwnProperty.call(values, 'assignee'),
        reason: values.reason,
        observedAt: values.observed_at,
      });
      console.log(`unknown tracker observation recorded for ${record.ticket} at generation ${record.generation}`);
    } else if (command === 'override') {
      const record = override(graph, {
        ticket,
        jiraKey,
        status: values.status,
        assignee: values.assignee,
        statusProvided: Object.prototype.hasOwnProperty.call(values, 'status'),
        assigneeProvided: Object.prototype.hasOwnProperty.call(values, 'assignee'),
        reason: values.reason,
        observedAt: values.observed_at,
      });
      console.log(`tracker override recorded for ${record.ticket} at generation ${record.generation}`);
    } else if (command === 'clear') {
      console.log(clear(graph, ticket) ? `tracker record cleared for ${ticket}` : `no tracker record for ${ticket}`);
    } else if (command === 'list') {
      console.log(JSON.stringify(activeRecords(graph), null, 2));
    } else {
      fail(usage);
    }
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) cli();

module.exports = {
  STORE_NAME,
  readStore,
  metadataIdentity,
  currentGeneration,
  activeRecords,
  activePreviousTrackers,
  activeTrackerSnapshot,
  activeTrackerSnapshotLocked,
  activeTrackers,
  observe,
  unknown,
  override,
  clear,
};
