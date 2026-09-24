'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const observer = require('../../plugins/delivery-pipeline/scripts/session-observer.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-session-observer-'));
const transcript = path.join(root, 'session.jsonl');
const graph = path.join(root, 'graph');
const row = (output) => ({
  type: 'assistant',
  sessionId: 'session-1',
  requestId: 'request-1',
  timestamp: '2026-09-22T10:00:00.000Z',
  effort: 'high',
  message: {
    id: 'message-1',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
      output_tokens: output,
    },
  },
});
const file = () => path.join(graph, 'session-observations.jsonl');
const rows = () => fs.readFileSync(file(), 'utf8').trim().split('\n').map(JSON.parse);

suite('session observer — manual runtime usage is durable and deduplicated');

test('records an unbound Claude observation with model, effort and counters', () => {
  fs.writeFileSync(transcript, JSON.stringify(row(4)) + '\n');
  const result = observer.observe(transcript, graph);
  assert.strictEqual(result.observed, 1);
  assert.strictEqual(result.appended, 1);
  const [record] = rows();
  assert.strictEqual(record.binding_status, 'unbound');
  assert.strictEqual(record.provider, 'anthropic');
  assert.strictEqual(record.observed_model, 'claude-opus-5');
  assert.strictEqual(record.observed_effort, 'high');
  assert.strictEqual(record.output_tokens, 4);
});

test('re-reading an unchanged transcript does not add another observation', () => {
  const result = observer.observe(transcript, graph);
  assert.strictEqual(result.appended, 0);
  assert.strictEqual(rows().length, 1);
});

test('a changed cumulative observation gets a revision', () => {
  fs.writeFileSync(transcript, JSON.stringify(row(7)) + '\n');
  const result = observer.observe(transcript, graph);
  assert.strictEqual(result.appended, 1);
  const current = rows().filter((record) => record.revision === 2);
  assert.strictEqual(current.length, 1);
  assert.strictEqual(current[0].output_tokens, 7);
});

test('hook mode derives the graph from the payload cwd', () => {
  const otherGraph = path.join(root, 'hook-graph');
  const hookGraph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(hookGraph, { recursive: true });
  fs.writeFileSync(path.join(hookGraph, 'tickets.json'), '{"tickets":{}}\n');
  const status = observer.main(['hook'], JSON.stringify({ cwd: root, transcript_path: transcript }));
  assert.strictEqual(status, 0);
  assert.ok(fs.existsSync(path.join(otherGraph, 'session-observations.jsonl')) === false);
  assert.ok(fs.existsSync(path.join(hookGraph, 'session-observations.jsonl')));
});

test('Codex log facts retain model, effort and turn token deltas', () => {
  const logs = [
    { id: 1, ts: 100, thread_id: 'codex-session', target: 'codex_core::stream_events_utils',
      feedback_log_body: 'turn{thread.id=codex-session turn.id=turn-1 model=gpt-5.6-luna codex.turn.reasoning_effort=max}:run cwd=/project' },
    { id: 2, ts: 101, thread_id: 'codex-session', target: 'codex_core::session::turn',
      feedback_log_body: 'turn.id=turn-1: post sampling token usage total_usage_tokens=120' },
    { id: 3, ts: 200, thread_id: 'codex-session', target: 'codex_core::stream_events_utils',
      feedback_log_body: 'turn{thread.id=codex-session turn.id=turn-2 model=gpt-5.6-sol codex.turn.reasoning_effort=high}:run cwd=/project' },
    { id: 4, ts: 201, thread_id: 'codex-session', target: 'codex_core::session::turn',
      feedback_log_body: 'turn.id=turn-2: post sampling token usage total_usage_tokens=175' },
  ];
  const turns = observer.collectCodexTurns(logs, [
    { thread_id: 'codex-session', turn_id: 'turn-1', status: 'completed', started_at: 100, completed_at: 101, duration_ms: 10 },
    { thread_id: 'codex-session', turn_id: 'turn-2', status: 'completed', started_at: 200, completed_at: 201, duration_ms: 20 },
  ]);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].model, 'gpt-5.6-luna');
  assert.strictEqual(turns[0].effort, 'max');
  assert.strictEqual(turns[0].total_tokens, 120);
  assert.strictEqual(turns[1].model, 'gpt-5.6-sol');
  assert.strictEqual(turns[1].effort, 'high');
  assert.strictEqual(turns[1].total_tokens, 55);
  assert.strictEqual(turns[1].usage_basis, 'turn_delta');
});

done();
