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

/**
 * Read the generation of the last published delivery-state snapshot.
 *
 * The metadata file is authoritative. The front copy is a compatibility
 * fallback only when metadata has never existed; a present but malformed
 * metadata file means there is no trustworthy active generation. Zero is the
 * pre-publication generation used by isolated/unit callers; the first real
 * state-sync publishes generation one and expires such records.
 */
function currentGeneration(graphDir) {
  const meta = readGeneration(path.join(graphDir, META_NAME));
  if (meta.present) return meta.generation;
  const front = readGeneration(path.join(graphDir, 'delivery-front.json'));
  return front.present ? front.generation : 0;
}

function currentGenerationStrict(graphDir) {
  const meta = readGeneration(path.join(graphDir, META_NAME));
  if (meta.present) return meta.generation;
  const front = readGeneration(path.join(graphDir, 'delivery-front.json'));
  if (front.present) return front.generation;
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

function activeRecordsAt(graphDir, generation) {
  if (!Number.isInteger(generation) || generation < 0) return {};
  const out = {};
  for (const [ticket, record] of Object.entries(readStore(graphDir).tickets)) {
    if (!record || record.generation !== generation) continue;
    if (typeof record.verdict !== 'string' || !record.verdict) continue;
    out[ticket] = { ...record };
  }
  return out;
}

function activeRecords(graphDir) {
  return activeRecordsAt(graphDir, currentGeneration(graphDir));
}

// Tracker observations are recorded against the snapshot that was current
// when the external read happened. The next state-sync publishes the next
// generation, so front readers need this narrow, internally-derived bridge
// across that publish boundary. Callers cannot choose an arbitrary generation.
function activePreviousTrackers(graphDir) {
  const generation = currentGeneration(graphDir);
  return Number.isInteger(generation) && generation > 0
    ? activeRecordsAt(graphDir, generation - 1)
    : {};
}

// The flat view is convenient for callers that only need the current record;
// unlike the store itself it never exposes an older delivery generation.
const activeTrackers = activeRecords;

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
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
    const previousAt = previous && typeof previous.observed_at === 'string'
      ? Date.parse(previous.observed_at)
      : NaN;
    const incomingAt = typeof record.observed_at === 'string'
      ? Date.parse(record.observed_at)
      : NaN;
    // The lock orders writers, not the observations they captured before
    // queueing for it. Preserve an already stored observation when it is newer
    // than the incoming result, otherwise a delayed timeout can overwrite a
    // fresher eligible/ineligible answer for the same generation.
    const stored = Number.isFinite(previousAt) && (!Number.isFinite(incomingAt) || previousAt > incomingAt)
      ? previous
      : record;
    store.tickets[ticket] = stored;
    writeAtomic(graphStore(graphDir), JSON.stringify(store, null, 2) + '\n');
    return stored;
  }, { label: 'tracker-record' });
}

function mutateRecord(graphDir, fn) {
  if (!hasGraph(graphDir)) throw new Error(`no ticket graph at ${graphDir}`);
  fs.mkdirSync(graphDir, { recursive: true });
  return withLock(lockDirFor(projectRootOf(graphDir)), 'tracker-record', () => {
    const store = readStore(graphDir);
    const result = fn(store);
    if (!result || !result.record) throw new Error('tracker-record mutation did not produce a record');
    let before = null;
    try { before = fs.readFileSync(graphStore(graphDir)); } catch { before = null; }
    store.tickets[result.record.ticket] = result.record;
    writeAtomic(graphStore(graphDir), JSON.stringify(store, null, 2) + '\n');
    if (result.event) {
      try {
        fs.appendFileSync(
          path.join(graphDir, 'delivery-log.jsonl'),
          JSON.stringify(result.event) + '\n'
        );
      } catch (error) {
        if (before === null) {
          try { fs.unlinkSync(graphStore(graphDir)); } catch { /* already absent */ }
        } else {
          writeAtomic(graphStore(graphDir), before);
        }
        throw new Error(
          `the tracker journal at ${path.join(graphDir, 'delivery-log.jsonl')} could not be appended to (${error.message}).\n` +
          '  The tracker record was rolled back, so nothing was recorded: the cache and its audit line\n' +
          '  are one act. Fix the journal and run tracker-record.cjs override again.'
        );
      }
    }
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
  const observedAt = input.observedAt || new Date().toISOString();
  const generation = requireGeneration(graphDir);
  const record = {
    ticket,
    jira_key: jiraKey,
    status: result.status,
    assignee: result.assignee,
    verdict: result.verdict,
    eligible: result.eligible,
    reason: result.reason,
    observed_at: observedAt,
    generation,
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
    observed_at: input.observedAt || new Date().toISOString(),
    generation: requireGeneration(graphDir),
  };
  return writeRecord(graphDir, ticket, record);
}

function override(graphDir, input) {
  const { ticket, jiraKey } = validateTicket(graphDir, input.ticket, input.jiraKey);
  const overrideReason = requireNonEmpty(input.reason, 'override reason');
  return mutateRecord(graphDir, (store) => {
    const generation = currentGenerationStrict(graphDir);
    const existing = store.tickets[ticket];
    const reusable = existing && existing.generation === generation && existing.jira_key === jiraKey
      ? existing
      : null;

    let status = reusable && typeof reusable.status === 'string' ? reusable.status : null;
    let assignee = reusable && Object.prototype.hasOwnProperty.call(reusable, 'assignee')
      ? reusable.assignee
      : null;
    let verdict = reusable && typeof reusable.verdict === 'string' ? reusable.verdict : 'unknown';
    let eligible = reusable && Object.prototype.hasOwnProperty.call(reusable, 'eligible')
      ? reusable.eligible
      : null;
    let observationReason = reusable && reusable.reason
      ? reusable.reason
      : 'no current tracker observation was available';
    let observedAt = reusable && reusable.observed_at ? reusable.observed_at : new Date().toISOString();

    if (input.statusProvided) {
      status = normalizeStatusName(input.status);
      if (!status) throw new Error('status, when provided, must be a non-empty status NAME');
      observedAt = input.observedAt || new Date().toISOString();
    }
    if (input.assigneeProvided) {
      assignee = normalizeCliAssignee(input.assignee);
      observedAt = input.observedAt || new Date().toISOString();
    }
    if (input.statusProvided || input.assigneeProvided) {
      const complete = !!status && (reusable ? Object.prototype.hasOwnProperty.call(reusable, 'assignee') : input.assigneeProvided);
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
    if (input.observationReasonProvided) {
      observationReason = requireNonEmpty(input.observationReason, 'observation reason');
    }

    const record = {
      ticket,
      jira_key: jiraKey,
      status: status || null,
      assignee: assignee || null,
      verdict,
      eligible,
      reason: observationReason,
      override: true,
      override_reason: overrideReason,
      observed_at: observedAt,
      generation,
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
    if (arg === '--status' || arg === '--assignee' || arg === '--reason' || arg === '--observed-at'
        || arg === '--observation-reason' || arg === '--observed-reason') {
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
        observationReason: values.observation_reason || values.observed_reason,
        observationReasonProvided: Object.prototype.hasOwnProperty.call(values, 'observation_reason')
          || Object.prototype.hasOwnProperty.call(values, 'observed_reason'),
        observedAt: values.observed_at,
      });
      console.log(`tracker override recorded for ${record.ticket} at generation ${record.generation}`);
    } else if (command === 'clear') {
      console.log(clear(graph, ticket) ? `tracker record cleared for ${ticket}` : `no tracker record for ${ticket}`);
    } else if (command === 'list') {
      console.log(JSON.stringify(activeRecords(graph), null, 2));
    } else {
      fail(
        'usage: tracker-record.cjs <mark|unknown|override|clear|list> <ticket> <jira-key> ' +
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
  currentGeneration,
  activeRecords,
  activePreviousTrackers,
  activeTrackers,
  observe,
  unknown,
  override,
  clear,
};
