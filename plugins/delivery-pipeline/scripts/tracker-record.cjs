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

function fail(message) {
  process.stderr.write(`tracker-record: ${message}\n`);
  process.exit(1);
}

function graphStore(graphDir) {
  return path.join(graphDir, STORE_NAME);
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
    return undefined;
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
  if (meta.present) return meta.generation;
  // Keep the writer usable for a freshly created graph. A real state-sync will
  // move to generation 1 on its first publish, so generation 0 cannot survive
  // across the first cold start.
  return 0;
}

function requireGeneration(graphDir) {
  const generation = currentGenerationStrict(graphDir);
  if (!Number.isInteger(generation)) {
    throw new Error('delivery-state generation is unreadable — run state-sync.cjs before recording a tracker observation');
  }
  return generation;
}

function requireMetadataIdentity(graphDir) {
  const identity = metadataIdentity(graphDir);
  if (!identity) {
    throw new Error('delivery-state metadata identity is unreadable — run state-sync.cjs before recording a tracker observation');
  }
  return identity;
}

function recordsForGeneration(store, generation, configuredStatuses, identity) {
  if (!Number.isInteger(generation) || generation < 1) return {};
  const out = {};
  for (const [ticket, record] of Object.entries(store.tickets)) {
    if (!record || record.ticket !== ticket || record.generation !== generation) continue;
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

function activeRecords(graphDir) {
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  return recordsForGeneration(store, generation, readConfigStatuses(projectRootOf(graphDir)), metadataIdentity(graphDir));
}

// Tracker observations are recorded against the snapshot that was current
// when the external read happened. The next state-sync publishes the next
// generation, so front readers need this narrow, internally-derived bridge
// across that publish boundary. Callers cannot choose an arbitrary generation.
function activePreviousTrackers(graphDir) {
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  const previousIdentity = metadataPreviousIdentity(graphDir);
  return Number.isInteger(generation) && generation > 1
    ? recordsForGeneration(store, generation - 1, readConfigStatuses(projectRootOf(graphDir)), previousIdentity)
    : {};
}

// Front readers need the current observation and the one publish-boundary
// predecessor as one coherent cache view. The exported wrapper takes the
// tracker lock; state-sync uses the locked form because it already holds that
// lock before entering its state publish.
function activeTrackerSnapshotLocked(graphDir) {
  const store = readStore(graphDir);
  const generation = currentGeneration(graphDir);
  const statuses = readConfigStatuses(projectRootOf(graphDir));
  const previousIdentity = metadataPreviousIdentity(graphDir);
  return {
    ...(Number.isInteger(generation) && generation > 1
      ? recordsForGeneration(store, generation - 1, statuses, previousIdentity)
      : {}),
    ...recordsForGeneration(store, generation, statuses, metadataIdentity(graphDir)),
  };
}

function activeTrackerSnapshot(graphDir) {
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () =>
    activeTrackerSnapshotLocked(graphDir), { label: 'tracker-record read' });
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
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => {
    const store = readStore(graphDir);
    const previous = store.tickets[ticket];
    const sameEpoch = previous && previous.generation_identity === record.generation_identity;
    const previousGeneration = previous && Number.isInteger(previous.generation) ? previous.generation : -1;
    const incomingGeneration = Number.isInteger(record.generation) ? record.generation : -1;
    const previousAt = previous && typeof previous.observed_at === 'string'
      ? Date.parse(previous.observed_at)
      : NaN;
    const incomingAt = typeof record.observed_at === 'string'
      ? Date.parse(record.observed_at)
      : NaN;
    // The lock orders writers, not the observations they captured before
    // queueing for it. Generation is the primary ordering key: a late result
    // from an older snapshot can never replace a newer snapshot's record. Only
    // observations in the same generation are ordered by observed_at.
    const previousWins = sameEpoch && (previousGeneration > incomingGeneration
      || (previousGeneration === incomingGeneration
        && Number.isFinite(previousAt)
        && (!Number.isFinite(incomingAt) || previousAt > incomingAt)));
    const stored = previousWins
      ? previous
      : record;
    store.tickets[ticket] = stored;
    writeAtomic(graphStore(graphDir), JSON.stringify(store, null, 2) + '\n');
    return stored;
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
  const generation = requireGeneration(graphDir);
  const generationIdentity = requireMetadataIdentity(graphDir);
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
    generation,
    generation_identity: generationIdentity,
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
    generation: requireGeneration(graphDir),
    generation_identity: requireMetadataIdentity(graphDir),
  };
  return writeRecord(graphDir, ticket, record);
}

function clear(graphDir, ticket) {
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  const id = requireNonEmpty(ticket, 'ticket');
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => {
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
      values[arg.slice(2).replace('-', '_')] = value;
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
    } else if (command === 'clear') {
      console.log(clear(graph, ticket) ? `tracker record cleared for ${ticket}` : `no tracker record for ${ticket}`);
    } else if (command === 'list') {
      console.log(JSON.stringify(activeRecords(graph), null, 2));
    } else {
      fail(
        'usage: tracker-record.cjs <mark|unknown|clear|list> <ticket> <jira-key> ' +
        '[--status <name>] [--assignee <id|none>] [--reason <text>] [--graph <dir>]'
      );
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
  clear,
};
