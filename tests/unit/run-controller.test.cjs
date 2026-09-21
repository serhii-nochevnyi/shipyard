'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const scope = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { createRunController } = require('../../plugins/delivery-pipeline/scripts/run-controller.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-run-controller-'));
}

function makeRun(ownerId = 'owner-a', runId = 'run-controller-test') {
  return scope.createRunScope({
    run_id: runId,
    repository_id: 'shipyard/test',
    phase: 37,
    ticket: 'T-37-02',
    worktree: '/tmp/shipyard-run-controller',
    runtime: 'claude',
    owner_id: ownerId,
    dispatch: { dispatch_id: `dispatch-${runId}`, role: 'executor', model: 'sonnet', effort: 'max' },
  });
}

function controller(root, ownerId, clock, options = {}) {
  return createRunController({ storeDir: root, ownerId, now: clock, leaseTtlMs: 1000, retryBackoffMs: 10, retryLimit: 3, ...options });
}

test('begin is idempotent and an expired owner can be fenced by a successor', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const first = controller(root, 'owner-a', () => now, { leaseTtlMs: 10 });
    const second = controller(root, 'owner-b', () => now, { leaseTtlMs: 10 });
    const run = makeRun('owner-a');
    const started = first.begin(run);
    assert.equal(started.state, 'running');
    assert.equal(started.idempotent, false);
    assert.equal(first.begin(run).idempotent, true);
    assert.throws(() => second.begin(run), (error) => error.code === 'RUN_LEASE_HELD');
    now = 1011;
    const takeover = second.begin(run);
    assert.equal(takeover.applied, true);
    assert.equal(takeover.status.owner.owner_id, 'owner-b');
    assert.throws(() => first.heartbeat(run.run_id), (error) => ['SESSION_FENCED', 'SCOPE_MISMATCH'].includes(error.code));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wait, wake, retry and complete replay idempotently', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const runController = controller(root, 'owner-a', () => now);
    const run = makeRun('owner-a', 'run-replay');
    runController.begin(run);
    const waiting = runController.wait(run.run_id, { event_id: 'wait-1', wake_id: 'wake-1', kind: 'ci', due_at: 1010, condition: 'ci pending' });
    assert.equal(waiting.state, 'waiting');
    assert.equal(runController.wait(run.run_id, { event_id: 'wait-1', wake_id: 'wake-1', kind: 'ci', due_at: 1010, condition: 'ci pending' }).idempotent, true);
    const woken = runController.wake(run.run_id, { event_id: 'wake-1', wake_id: 'wake-1' });
    assert.equal(woken.state, 'running');
    assert.equal(runController.wake(run.run_id, { event_id: 'wake-1', wake_id: 'wake-1' }).idempotent, true);
    const unavailable = runController.retry(run.run_id, { event_id: 'retry-1', target_state: 'runtime_unavailable', reason: 'Claude host unavailable', delay_ms: 10 });
    assert.equal(unavailable.state, 'runtime_unavailable');
    assert.equal(unavailable.run.runtime.runtime, 'claude');
    assert.equal(unavailable.run.runtime.provider, 'anthropic');
    assert.equal(unavailable.run.dispatch.model, 'sonnet');
    assert.equal(runController.retry(run.run_id, { event_id: 'retry-1', target_state: 'runtime_unavailable', reason: 'Claude host unavailable', delay_ms: 10 }).idempotent, true);
    assert.throws(() => runController.wake(run.run_id, { event_id: 'wake-2' }), (error) => error.code === 'RETRY_NOT_DUE');
    now = 1010;
    assert.equal(runController.wake(run.run_id, { event_id: 'wake-2' }).state, 'running');
    const completed = runController.complete(run.run_id, { event_id: 'complete-1' });
    assert.equal(completed.state, 'completed');
    assert.equal(runController.complete(run.run_id, { event_id: 'complete-1' }).idempotent, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime unavailability records a bounded machine retry without switching runtime', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const runController = controller(root, 'owner-a', () => now, { retryLimit: 2, retryBackoffMs: 5 });
    const run = makeRun('owner-a', 'run-unavailable');
    runController.begin(run);
    const parked = runController.markUnavailable(run.run_id, { event_id: 'unavailable-1', reason: 'Codex binary missing', delay_ms: 5 });
    assert.equal(parked.state, 'runtime_unavailable');
    assert.equal(parked.status.retry.next_at, 1005);
    assert.match(parked.status.retry.condition, /^retry-at:/);
    assert.equal(parked.run.runtime.runtime, 'claude');
    assert.equal(parked.run.runtime.provider, 'anthropic');
    assert.equal(parked.run.dispatch.model, 'sonnet');
    assert.equal(parked.run.dispatch.effort, 'max');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint recovery blocks unsafe resume and prevents duplicate successor dispatch', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const first = controller(root, 'owner-a', () => now);
    const second = controller(root, 'owner-b', () => now);
    const run = makeRun('owner-a', 'run-checkpoint');
    first.begin(run);
    const checkpoint = first.checkpoint(run.run_id, { checkpoint_id: 'checkpoint-1', head: 'head-1', base: 'base-1', worktree: '/tmp/shipyard-run-controller', clean: true, children: [] });
    assert.equal(checkpoint.state, 'human_checkpoint');
    const before = first.status(run.run_id);
    const acknowledged = first.acknowledge(run.run_id, { event_id: 'ack-1', successor_id: 'successor-1' });
    assert.equal(acknowledged.status.checkpoint.acknowledged, true);
    assert.equal(first.acknowledge(run.run_id, { event_id: 'ack-1', successor_id: 'successor-1' }).idempotent, true);
    assert.equal(first.status(run.run_id).successor.successor_id, 'successor-1');
    assert.equal(before.state_revision, first.status(run.run_id).state_revision);
    assert.throws(
      () => second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: false, head: 'head-1', base: 'base-1', children: [] } }),
      (error) => error.code === 'DIRTY_WORK',
    );
    assert.throws(
      () => second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: true, head: 'head-2', base: 'base-1', children: [] } }),
      (error) => error.code === 'LIVE_STATE_STALE',
    );
    assert.throws(
      () => second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: true, head: 'head-1', base: 'base-1', children: ['child-1'] } }),
      (error) => error.code === 'ACTIVE_CHILDREN',
    );
    assert.throws(
      () => second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: true, children: [] } }),
      (error) => error.code === 'LIVE_STATE_STALE',
    );
    assert.equal(first.status(run.run_id).state, 'human_checkpoint');
    assert.equal(first.status(run.run_id).checkpoint.checkpoint_id, 'checkpoint-1');
    const resumed = second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: true, head: 'head-1', base: 'base-1', worktree: '/tmp/shipyard-run-controller', children: [] } });
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.status.owner.owner_id, 'owner-b');
    assert.equal(resumed.status.successor.status, 'resumed');
    assert.equal(second.resume(run.run_id, { successor_id: 'successor-1', evidence: { clean: true, head: 'head-1', base: 'base-1', worktree: '/tmp/shipyard-run-controller', children: [] } }).idempotent, true);
    assert.equal(second.status(run.run_id).successor.successor_id, 'successor-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a checkpoint can be resumed after a crash before acknowledgement', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const first = controller(root, 'owner-a', () => now);
    const successor = controller(root, 'owner-b', () => now);
    const run = makeRun('owner-a', 'run-before-ack');
    first.begin(run);
    first.checkpoint(run.run_id, { checkpoint_id: 'checkpoint-before-ack', head: 'head-1', base: 'base-1', clean: true, children: [] });
    const resumed = successor.resume(run.run_id, { evidence: { clean: true, head: 'head-1', base: 'base-1', children: [] } });
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.status.successor.status, 'resumed');
    assert.equal(successor.resume(run.run_id, { evidence: { clean: true, head: 'head-1', base: 'base-1', children: [] } }).idempotent, true);
    assert.equal(successor.status(run.run_id).successor.successor_id, resumed.status.successor.successor_id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an exhausted retry remains technical state and cannot wake without force', () => {
  const root = tempDir();
  let now = 1000;
  try {
    const runController = controller(root, 'owner-a', () => now, { retryLimit: 1, retryBackoffMs: 0 });
    const run = makeRun('owner-a', 'run-retry-cap');
    runController.begin(run);
    const parked = runController.retry(run.run_id, { event_id: 'retry-cap', target_state: 'runtime_unavailable', reason: 'host missing', delay_ms: 0 });
    assert.equal(parked.state, 'runtime_unavailable');
    assert.equal(parked.status.retry.exhausted, true);
    assert.equal(parked.status.retry.condition, 'retry-cap-exhausted');
    assert.throws(() => runController.wake(run.run_id, { event_id: 'wake-cap' }), (error) => error.code === 'RETRY_EXHAUSTED');
    assert.equal(runController.wake(run.run_id, { event_id: 'wake-cap-force', force: true }).state, 'running');
    assert.equal(runController.status(run.run_id).scope.runtime.runtime, 'claude');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
