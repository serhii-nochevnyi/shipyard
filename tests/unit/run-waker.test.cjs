'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const scope = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');
const waker = require('../../plugins/delivery-pipeline/scripts/run-waker.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-run-waker-'));
}

function makeRun(root, runId, ticket, runtime = 'claude') {
  return scope.createRunScope({
    run_id: runId,
    repository_id: 'shipyard/test',
    phase: 37,
    ticket,
    worktree: path.join(root, ticket),
    runtime,
    owner_id: `owner-${runId}`,
    dispatch: { dispatch_id: `dispatch-${runId}`, role: 'executor', model: runtime === 'codex' ? 'sol' : 'sonnet', effort: 'high' },
  });
}

function setup(root, runId = 'run-a', ticket = 'T-37-06', runtime = 'claude') {
  let now = 1000;
  const storeDir = path.join(root, 'store');
  const controller = createRunController({ storeDir, ownerId: `owner-${runId}`, now: () => now, retryBackoffMs: 5 });
  const run = makeRun(root, runId, ticket, runtime);
  controller.begin(run);
  return { controller, run, storeDir, now: () => now, setNow: (value) => { now = value; } };
}

test('scope resolution binds the run to its worktree graph and refuses another graph', () => {
  const root = tempDir();
  try {
    const setupValue = setup(root);
    const resolved = waker.readRun({ run_id: setupValue.run.run_id, store_dir: setupValue.storeDir });
    assert.equal(resolved.scope.worktree.path, setupValue.run.worktree.path);
    assert.equal(resolved.graph_dir, path.join(setupValue.run.worktree.path, '.planning', 'graph'));
    assert.throws(
      () => waker.readRun({ run_id: setupValue.run.run_id, store_dir: setupValue.storeDir, graph_dir: path.join(root, 'other') }),
      (error) => error.code === 'SCOPE_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wake events are durable, run-scoped and idempotent', () => {
  const root = tempDir();
  try {
    const first = setup(root, 'run-a', 'T-37-06');
    const second = setup(root, 'run-b', 'T-37-07', 'codex');
    const event = waker.recordWakeEvent({ store_dir: first.storeDir, run_id: first.run.run_id, kind: 'ci', wake_id: 'wake-a', event_id: 'event-a' });
    const replay = waker.recordWakeEvent({ store_dir: first.storeDir, run_id: first.run.run_id, kind: 'ci', wake_id: 'wake-a', event_id: 'event-a' });
    assert.equal(event.recorded, true);
    assert.equal(replay.idempotent, true);
    first.controller.wait(first.run.run_id, { event_id: 'wait-a', wake_id: 'wake-a', kind: 'ci', due_at: 10000 });
    const isolated = waker.readRun({ run_id: second.run.run_id, store_dir: second.storeDir });
    assert.equal(waker.readRun({ run_id: first.run.run_id, store_dir: first.storeDir }).run.run_id, first.run.run_id);
    assert.equal(isolated.run.run_id, second.run.run_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one durable wake launches one controller step and replay does not launch twice', async () => {
  const root = tempDir();
  try {
    const value = setup(root);
    value.controller.wait(value.run.run_id, { event_id: 'wait-a', wake_id: 'wake-a', kind: 'ci', due_at: 10000 });
    waker.recordWakeEvent({ store_dir: value.storeDir, run_id: value.run.run_id, kind: 'ci', wake_id: 'wake-a', event_id: 'event-a' });
    let launches = 0;
    const launchNext = () => { launches += 1; return { step: launches }; };
    const first = await waker.wakeOnce({ run_id: value.run.run_id, store_dir: value.storeDir, controller: value.controller, launchNext, now: 1000 });
    const replay = await waker.wakeOnce({ run_id: value.run.run_id, store_dir: value.storeDir, controller: value.controller, launchNext, now: 1000 });
    assert.equal(first.status, 'launched');
    assert.equal(replay.status, 'not-waiting');
    assert.equal(launches, 1);
    assert.equal(value.controller.status(value.run.run_id).state, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed controller wake does not consume the durable launch claim', async () => {
  const root = tempDir();
  try {
    const value = setup(root);
    value.controller.wait(value.run.run_id, { event_id: 'wait-a', wake_id: 'wake-a', kind: 'ci', due_at: 10000 });
    waker.recordWakeEvent({ store_dir: value.storeDir, run_id: value.run.run_id, kind: 'ci', wake_id: 'wake-a', event_id: 'event-a' });
    const failed = await waker.wakeOnce({
      run_id: value.run.run_id,
      store_dir: value.storeDir,
      controller: { wake: () => { throw Object.assign(new Error('lease expired'), { code: 'LEASE_EXPIRED' }); } },
      now: 1000,
    });
    assert.equal(failed.status, 'retryable_pending');
    const launched = await waker.wakeOnce({ run_id: value.run.run_id, store_dir: value.storeDir, controller: value.controller, now: 1000 });
    assert.equal(launched.status, 'launched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign wake event cannot wake the selected run', async () => {
  const root = tempDir();
  try {
    const first = setup(root, 'run-a', 'T-37-06');
    const second = setup(root, 'run-b', 'T-37-07', 'codex');
    first.controller.wait(first.run.run_id, { event_id: 'wait-a', wake_id: 'wake-a', kind: 'ci', due_at: 10000 });
    second.controller.wait(second.run.run_id, { event_id: 'wait-b', wake_id: 'wake-b', kind: 'ci', due_at: 10000 });
    waker.recordWakeEvent({ store_dir: first.storeDir, run_id: first.run.run_id, kind: 'ci', wake_id: 'wake-a', event_id: 'event-a' });
    const result = await waker.wakeOnce({ run_id: second.run.run_id, store_dir: second.storeDir, controller: second.controller, now: 1000 });
    assert.equal(result.status, 'waiting');
    assert.equal(second.controller.status(second.run.run_id).state, 'waiting');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded waiting returns a due run without spinning past its deadline', async () => {
  const root = tempDir();
  try {
    const value = setup(root);
    value.controller.wait(value.run.run_id, { event_id: 'wait-a', wake_id: 'wake-a', kind: 'host', due_at: 1003 });
    let clock = 1000;
    const result = await waker.waitForWake({
      run_id: value.run.run_id,
      store_dir: value.storeDir,
      timeout_ms: 20,
      interval_ms: 2,
      clock: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.readiness.status, 'due');
    assert.equal(clock, 1004);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
