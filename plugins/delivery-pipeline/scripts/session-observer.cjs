#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const usageReport = require('./usage-report.cjs');
const { withLock, writeAtomic } = require('./lock.cjs');

const FILE = 'session-observations.jsonl';
const OBSERVATION_SCHEMA = 'shipyard.session-observation.v1';

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function iso(value, fallback) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function timestampByIdentity(rows) {
  const result = new Map();
  for (const row of rows) {
    const messageId = row?.message?.id || row?.message_id || null;
    const requestId = row?.requestId || row?.request_id || null;
    const at = iso(row?.timestamp, null);
    if (!at) continue;
    if (messageId) result.set('message:' + messageId, at);
    if (requestId) result.set('request:' + requestId, at);
  }
  return result;
}

function recordFor(observation, source, timestamps, sourceMtime) {
  const at = iso(observation.observed_at, null)
    || timestamps.get('message:' + observation.message_id)
    || timestamps.get('request:' + observation.request_id)
    || sourceMtime;
  const identity = [
    source,
    observation.runtime,
    observation.kind,
    observation.unit,
    observation.session_id,
    observation.request_id,
    observation.message_id,
  ];
  const observationId = digest(identity);
  return {
    schema_version: OBSERVATION_SCHEMA,
    observation_id: observationId,
    revision: 1,
    observed_at: at,
    updated_at: new Date().toISOString(),
    source,
    binding_status: 'unbound',
    attribution_status: 'unbound',
    runtime: observation.runtime,
    provider: observation.provider,
    provider_family: observation.provider_family,
    kind: observation.kind,
    unit: observation.unit,
    session_id: observation.session_id,
    request_id: observation.request_id,
    message_id: observation.message_id,
    model: observation.model,
    observed_model: observation.observed_model,
    observed_effort: observation.observed_effort,
    effort_source: observation.effort_source,
    model_source: observation.model_source,
    completion_status: observation.completion_status,
    finalized: observation.finalized === true,
    working_directory: observation.working_directory,
    turn_status: observation.turn_status,
    duration_ms: observation.duration_ms,
    usage_basis: observation.usage_basis,
    cumulative_total_tokens: observation.cumulative_total_tokens,
    total_tokens: observation.total_tokens,
    input_tokens: observation.input_tokens,
    uncached_input_tokens: observation.uncached_input_tokens,
    cache_read_input_tokens: observation.cache_read_input_tokens,
    cache_creation_input_tokens: observation.cache_creation_input_tokens,
    output_tokens: observation.output_tokens,
    reasoning_output_tokens: observation.reasoning_output_tokens,
  };
}

const CODEX_LOG_TARGETS = new Set([
  'codex_core::session::turn',
  'codex_core::stream_events_utils',
]);

function sqliteRows(file, query) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(query).all(); } finally { db.close(); }
  } catch (nodeSqliteError) {
    let output;
    try {
      output = execFileSync('sqlite3', ['-readonly', '-json', file, query], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (sqliteError) {
      throw new Error(`cannot read Codex SQLite source: ${sqliteError.message || nodeSqliteError.message}`);
    }
    try { return output.trim() ? JSON.parse(output) : []; }
    catch (error) { throw new Error(`Codex SQLite output is not JSON: ${error.message}`); }
  }
}

function matchOne(text, expression) {
  const match = expression.exec(text);
  return match ? match[1] : null;
}

function effortValue(body) {
  const raw = matchOne(body, /codex\.turn\.reasoning_effort=([^\s}]+)/)
    || matchOne(body, /codex\.request\.reasoning_effort=([^\s}]+)/)
    || matchOne(body, /\beffort=Some\(([^)]+)\)/);
  return raw ? raw.replace(/^Some\((.*)\)$/, '$1').toLowerCase() : null;
}

function completionStatus(status, finalized) {
  if (status === 'completed' || finalized) return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return 'interrupted';
  return 'unknown';
}

function isoFromSeconds(seconds) {
  return Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function projectContains(projectRoot, cwd) {
  if (!cwd) return false;
  const relative = path.relative(projectRoot, path.resolve(cwd));
  return relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function collectCodexTurns(logRows, historyRows = [], filter = {}) {
  const turns = new Map();
  const history = new Map((Array.isArray(historyRows) ? historyRows : []).map((row) => [
    `${row.thread_id || ''}\u0000${row.turn_id || ''}`,
    row,
  ]));
  const rows = (Array.isArray(logRows) ? logRows : [])
    .filter((row) => CODEX_LOG_TARGETS.has(row.target))
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  for (const row of rows) {
    const body = String(row.feedback_log_body || '');
    const turnId = (matchOne(body, /(?:turn\.id|turn_id)=([^\s}]+)/) || '').replace(/[,:]+$/, '');
    const threadId = row.thread_id || matchOne(body, /thread\.id=([^\s}]+)/);
    if (!threadId || !turnId) continue;
    const key = `${threadId}\u0000${turnId}`;
    const item = turns.get(key) || {
      thread_id: threadId,
      turn_id: turnId,
      first_at: Number.isSafeInteger(row.ts) ? row.ts : null,
      observed_at: null,
      model: null,
      effort: null,
      cwd: null,
      cumulative_total_tokens: null,
      finalized: false,
      log_id: Number(row.id || 0),
    };
    item.first_at ??= Number.isSafeInteger(row.ts) ? row.ts : null;
    item.model ||= matchOne(body, /\bmodel=([^\s}]+)/);
    item.effort ||= effortValue(body);
    item.cwd ||= matchOne(body, /\bcwd=([^\s}]+)/);
    const token = matchOne(body, /total_usage_tokens=(\d+)/);
    if (token !== null) {
      const value = Number(token);
      if (Number.isSafeInteger(value)) {
        item.cumulative_total_tokens = Math.max(item.cumulative_total_tokens ?? 0, value);
        item.observed_at = Number.isSafeInteger(row.ts) ? row.ts : item.observed_at;
      }
    }
    if (row.target === 'codex_core::session::turn' && body.includes('post sampling token usage')) {
      item.finalized = true;
      item.observed_at = Number.isSafeInteger(row.ts) ? row.ts : item.observed_at;
    }
    turns.set(key, item);
  }

  const ordered = [...turns.values()].map((item) => {
    const prior = history.get(`${item.thread_id}\u0000${item.turn_id}`) || {};
    return {
      ...item,
      ...prior,
      model: item.model || null,
      effort: item.effort || null,
      cwd: item.cwd || null,
      finalized: prior.status
        ? ['completed', 'failed', 'error', 'interrupted', 'cancelled', 'canceled'].includes(prior.status)
        : item.finalized,
      observed_at: isoFromSeconds(prior.completed_at) || isoFromSeconds(item.observed_at) || isoFromSeconds(item.first_at),
    };
  }).sort((a, b) => {
    const at = Number(a.started_at ?? a.first_at ?? 0);
    const bt = Number(b.started_at ?? b.first_at ?? 0);
    return at - bt || Number(a.log_id || 0) - Number(b.log_id || 0);
  });

  const previous = new Map();
  for (const item of ordered) {
    if (item.cumulative_total_tokens !== null) {
      const before = previous.get(item.thread_id);
      item.total_tokens = before === undefined || item.cumulative_total_tokens >= before
        ? item.cumulative_total_tokens - (before || 0)
        : null;
      previous.set(item.thread_id, item.cumulative_total_tokens);
      item.usage_basis = before === undefined ? 'cumulative_baseline' : 'turn_delta';
    } else {
      item.total_tokens = null;
      item.usage_basis = 'missing';
    }
  }
  return ordered.filter((item) => {
    if (filter.threadId && item.thread_id !== filter.threadId) return false;
    if (filter.turnId && item.turn_id !== filter.turnId) return false;
    return true;
  });
}

function readCodexDatabase(dbPath, historyPath = null) {
  const source = fs.realpathSync(dbPath);
  const logRows = sqliteRows(source, [
    'SELECT id, ts, thread_id, target, feedback_log_body FROM logs',
    `WHERE target IN (${[...CODEX_LOG_TARGETS].map((value) => `'${value}'`).join(', ')})`,
    'ORDER BY id',
  ].join(' '));
  const history = historyPath || path.join(path.dirname(source), 'thread_history_1.sqlite');
  const historyRows = fs.existsSync(history)
    ? sqliteRows(fs.realpathSync(history), 'SELECT * FROM thread_turns ORDER BY started_at, rollout_ordinal')
    : [];
  return { source, logRows, historyRows };
}

function observeCodexDatabase(dbPath, graphDir, options = {}) {
  const graph = path.resolve(graphDir);
  if (!isShipyardGraph(graph)) {
    return { file: path.join(graph, FILE), observed: 0, appended: 0, selected: 0, skipped: 'not-shipyard-graph' };
  }
  const database = readCodexDatabase(dbPath, options.historyPath);
  const turns = collectCodexTurns(database.logRows, database.historyRows, options);
  const projectRoot = path.resolve(graph, '..', '..');
  const selected = turns.filter((turn) => projectContains(projectRoot, turn.cwd));
  const sourceMtime = new Date(fs.statSync(database.source).mtimeMs).toISOString();
  const records = selected.map((turn) => recordFor({
    runtime: 'codex',
    provider: 'openai',
    provider_family: 'openai',
    kind: 'ordinary',
    unit: 'turn',
    session_id: turn.thread_id,
    request_id: turn.turn_id,
    message_id: turn.final_agent_item_id || null,
    model: turn.model,
    observed_model: turn.model,
    observed_effort: turn.effort,
    effort_source: turn.effort ? 'codex_log' : 'unknown',
    model_source: turn.model ? 'codex_log' : 'unknown',
    completion_status: completionStatus(turn.status, turn.finalized),
    finalized: turn.finalized,
    observed_at: turn.observed_at,
    working_directory: turn.cwd,
    turn_status: turn.status || null,
    duration_ms: Number.isSafeInteger(turn.duration_ms) ? turn.duration_ms : null,
    usage_basis: turn.usage_basis,
    cumulative_total_tokens: turn.cumulative_total_tokens,
    total_tokens: turn.total_tokens,
    input_tokens: null,
    uncached_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
  }, database.source, new Map(), sourceMtime));
  return { ...persist(graph, records), source: database.source, runtime: 'codex', selected: selected.length };
}

function observeCodexNotify(payload, graphDir, options = {}) {
  const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
  const db = options.dbPath || process.env.SHIPYARD_CODEX_LOG_DB || path.join(home, 'logs_2.sqlite');
  return observeCodexDatabase(db, graphDir, {
    ...options,
    threadId: payload?.thread_id || payload?.threadId,
    turnId: payload?.turn_id || payload?.turnId,
  });
}

function comparable(record) {
  const copy = { ...record };
  delete copy.revision;
  delete copy.updated_at;
  return copy;
}

function persist(graphDir, records) {
  const file = path.join(graphDir, FILE);
  fs.mkdirSync(graphDir, { recursive: true });
  return withLock(path.join(graphDir, '.locks'), 'session-observations', () => {
    const existing = fs.existsSync(file) ? readJsonl(file) : [];
    const latest = new Map();
    for (const row of existing) {
      if (!row || typeof row.observation_id !== 'string') continue;
      const previous = latest.get(row.observation_id);
      if (!previous || Number(row.revision) >= Number(previous.revision)) latest.set(row.observation_id, row);
    }
    const append = [];
    for (const record of records) {
      const previous = latest.get(record.observation_id);
      if (previous && JSON.stringify(comparable(previous)) === JSON.stringify(comparable(record))) continue;
      const next = {
        ...record,
        revision: previous ? Number(previous.revision || 1) + 1 : 1,
      };
      append.push(next);
      latest.set(next.observation_id, next);
    }
    if (append.length) {
      const text = existing.concat(append).map((row) => JSON.stringify(row)).join('\n') + '\n';
      writeAtomic(file, text);
    }
    return { file, observed: records.length, appended: append.length };
  });
}

function observe(transcript, graphDir) {
  const source = fs.realpathSync(transcript);
  const rows = readJsonl(source);
  const report = usageReport.report([{ source, rows }]);
  const stat = fs.statSync(source);
  const sourceMtime = new Date(stat.mtimeMs).toISOString();
  const timestamps = timestampByIdentity(rows);
  const records = report.observations
    .filter((observation) => observation.runtime === 'claude')
    .map((observation) => recordFor(observation, source, timestamps, sourceMtime));
  return persist(path.resolve(graphDir), records);
}

function graphFromPayload(payload) {
  if (process.env.SHIPYARD_GRAPH_DIR) return path.resolve(process.env.SHIPYARD_GRAPH_DIR);
  const cwd = payload && (payload.cwd || payload.project_dir);
  return path.resolve(cwd || process.cwd(), '.planning', 'graph');
}

function isShipyardGraph(graphDir) {
  return fs.existsSync(graphDir) && fs.existsSync(path.join(graphDir, 'tickets.json'));
}

function parseArgs(argv) {
  const command = argv[0];
  const transcriptIndex = argv.indexOf('--transcript');
  const dbIndex = argv.indexOf('--db');
  const graphIndex = argv.indexOf('--graph');
  if (command === 'observe' && transcriptIndex !== -1 && graphIndex !== -1) {
    const transcript = argv[transcriptIndex + 1];
    const graph = argv[graphIndex + 1];
    if (!transcript || !graph) throw new Error('observe requires --transcript and --graph values');
    return { command, transcript, graph, json: argv.includes('--json') };
  }
  if (command === 'observe-codex' && dbIndex !== -1 && graphIndex !== -1) {
    const db = argv[dbIndex + 1];
    const graph = argv[graphIndex + 1];
    if (!db || !graph) throw new Error('observe-codex requires --db and --graph values');
    return {
      command,
      db,
      graph,
      history: argv.includes('--history') ? argv[argv.indexOf('--history') + 1] : null,
      threadId: argv.includes('--thread-id') ? argv[argv.indexOf('--thread-id') + 1] : null,
      turnId: argv.includes('--turn-id') ? argv[argv.indexOf('--turn-id') + 1] : null,
      json: argv.includes('--json'),
    };
  }
  if (command === 'hook') return { command, json: argv.includes('--json') };
  throw new Error('usage: session-observer.cjs observe --transcript <file> --graph <dir> [--json] | observe-codex --db <file> --graph <dir> [--history <file>] [--json] | hook');
}

function main(argv = process.argv.slice(2), input = null) {
  const args = parseArgs(argv);
  if (args.command === 'hook') {
    let payload = {};
    try { payload = JSON.parse(input || ''); } catch { return 0; }
    const transcript = payload.transcript_path || payload.transcriptPath;
    if (!transcript || !fs.existsSync(transcript)) return 0;
    const graph = graphFromPayload(payload);
    if (!isShipyardGraph(graph)) return 0;
    let result;
    try { result = observe(transcript, graph); } catch { return 0; }
    if (args.json) console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (args.command === 'observe-codex') {
    const result = observeCodexDatabase(args.db, args.graph, {
      historyPath: args.history || null,
      threadId: args.threadId || null,
      turnId: args.turnId || null,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const result = observe(args.transcript, args.graph);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

module.exports = {
  OBSERVATION_SCHEMA,
  collectCodexTurns,
  observe,
  observeCodexDatabase,
  observeCodexNotify,
  persist,
  recordFor,
  main,
};

if (require.main === module) {
  let input = null;
  if (process.argv[2] === 'hook') input = fs.readFileSync(0, 'utf8');
  try { process.exitCode = main(process.argv.slice(2), input); }
  catch (error) {
    console.error('session-observer: ' + error.message);
    process.exitCode = 2;
  }
}
