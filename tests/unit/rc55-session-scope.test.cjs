'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./rc55-fixture.cjs');
const { createRunScope } = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const waker = require('../../plugins/delivery-pipeline/scripts/run-waker.cjs');
const arm = require('../../plugins/delivery-pipeline/scripts/stop-gate-arm.cjs');
const frontScript = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/front.cjs');

test('two authenticated runs share a board without inheriting each other’s work', t => {
  const f = fixture(t);
  const graph = path.join(f.root, 'project/.planning/graph');
  fs.mkdirSync(graph, { recursive: true });
  const store = path.join(graph, 'runs');
  for (const [runId, ticket] of [['session-a', 'T-11-37'], ['session-b', 'T-11-38']]) {
    const controller = createRunController({ storeDir: store, ownerId: runId });
    controller.begin(createRunScope({ run_id: runId, repository: { repository_id: 'acme/app', worktree: f.root, graph_dir: graph },
      phase: 11, ticket, worktree: f.root, runtime: 'codex', owner_id: runId,
      dispatch: { dispatch_id: runId, role: 'executor', model: 'sol', effort: 'low' } }));
  }
  const tickets = { tickets: { 'T-11-37': { files: ['app.js'] }, 'T-11-38': { files: ['other.js'] } } };
  const state = { 'T-11-37': { status: 'merged' }, 'T-11-38': { status: 'pending', ready: true } };
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify(tickets));
  const statePath = path.join(graph, 'delivery-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const before = fs.readFileSync(statePath);
  const foreignLedger = Buffer.from(JSON.stringify({ session_id: 'session-b', blocks: 1 }));
  fs.writeFileSync(path.join(graph, 'stop-gate-ledger.json'), foreignLedger);
  const info = waker.readRun({ run_id: 'session-a', store_dir: store, graph_dir: graph, worktree: f.root });
  assert.equal(info.graph_dir, graph);
  const a = arm.arm(f.root, 'session-a', { runId: 'session-a', storeDir: store, graphDir: graph });
  assert.equal(arm.readMarker(f.root, 'session-a').run_id, 'session-a');
  assert.equal(a.board, graph);
  assert.throws(() => arm.arm(f.root, 'session-a', { runId: 'session-b', storeDir: store, graphDir: graph }), /another run|different run/);
  const result = spawnSync(process.execPath, [frontScript, '--run-id', 'session-a', '--store-dir', store, '--graph', graph, '--json'],
    { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.run_id, 'session-a');
  assert.equal(view.fixpoint, true);
  assert.equal(view.actionable_count, 0);
  const stopScript = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/stop-gate.cjs');
  const stop = (active = false) => spawnSync(process.execPath, [stopScript], { cwd: f.root, env: f.env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'session-a', stop_hook_active: active }) });
  fs.writeFileSync(path.join(graph, 'delivery-front.json'), JSON.stringify({ generated_at: new Date(Date.now() - 10000).toISOString() }));
  fs.writeFileSync(path.join(graph, 'delivery-log.jsonl'), JSON.stringify({ event: 'merge', ticket: 'T-11-38', ts: new Date(Date.now() - 5000).toISOString() }) + '\n');
  assert.equal(stop().stdout.trim(), '');
  state['T-11-37'] = { status: 'pending', ready: true };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const active = stop();
  assert.match(active.stdout, /"decision"\s*:\s*"block"/);
  assert.deepEqual(fs.readFileSync(path.join(graph, 'stop-gate-ledger.json')), foreignLedger, 'another session ledger is preserved');
  assert.equal(stop(true).stdout.trim(), '', 'an unchanged active stop does not wake again');
  fs.writeFileSync(statePath, before);
  for (const missing of ['state', 'graph']) {
    fs.writeFileSync(statePath, JSON.stringify(missing === 'state' ? { 'T-11-38': state['T-11-38'] } : state));
    fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify(missing === 'graph' ? { tickets: {} } : tickets));
    const absent = spawnSync(process.execPath, [frontScript, '--run-id', 'session-a', '--store-dir', store, '--graph', graph, '--json'],
      { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.notEqual(absent.status, 0, missing);
    assert.match(absent.stderr, /owned ticket.*missing|scope.*missing/);
    assert.match(stop().stdout, /"decision"\s*:\s*"block"/);
  }
  fs.writeFileSync(statePath, before);
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify(tickets));

  assert.deepEqual(fs.readFileSync(statePath), before);
  assert.equal(arm.disarm(f.root, 'session-a').removed, true);
  assert.equal(waker.readRun({ run_id: 'session-b', store_dir: store }).run.ticket.ticket, 'T-11-38');
});
