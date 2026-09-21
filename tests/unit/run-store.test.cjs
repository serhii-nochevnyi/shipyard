'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const scope = require('../../plugins/delivery-pipeline/scripts/run-scope.cjs');
const { createRunStore } = require('../../plugins/delivery-pipeline/scripts/run-store.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-run-store-'));
}

function makeRun(ownerId = 'owner-a', runId = 'run-store-test') {
  return scope.createRunScope({
    run_id: runId,
    repository_id: 'shipyard/test',
    phase: 37,
    ticket: 'T-37-02',
    worktree: '/tmp/shipyard-run-store',
    runtime: 'codex',
    owner_id: ownerId,
    dispatch: { dispatch_id: `dispatch-${runId}`, role: 'executor', model: 'luna', effort: 'max' },
  });
}

test('run store creates, reloads and validates an immutable run record', () => {
  const root = tempDir();
  try {
    const store = createRunStore({ storeDir: root, now: () => 1000 });
    const run = makeRun();
    const record = {
      schema: 'shipyard.run-record.v1', version: 1, run,
      owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' },
      retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [],
    };
    const created = store.create(record);
    assert.equal(created.created, true);
    assert.equal(store.get(run.run_id).run.ticket.ticket, 'T-37-02');
    assert.equal(store.read().generation, 1);
    const reloaded = createRunStore({ storeDir: root, now: () => 1000 });
    assert.equal(reloaded.get(run.run_id).owner.owner_id, 'owner-a');
    assert.throws(
      () => reloaded.create({ ...record, run: { ...run, authority: { run_id: run.run_id } } }),
      (error) => error.code === 'SERIALIZED_AUTHORITY',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store transactions fence stale state revisions atomically', () => {
  const root = tempDir();
  try {
    const store = createRunStore({ storeDir: root, now: () => 1000 });
    const run = makeRun();
    store.create({
      schema: 'shipyard.run-record.v1', version: 1, run,
      owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' },
      retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [],
    });
    store.transaction(run.run_id, (record) => { record.run = { ...record.run, state_revision: { ...record.run.state_revision, value: 1 }, lease: { ...record.run.lease, state_revision: 1 } }; }, { expected_revision: 0 });
    assert.throws(
      () => store.transaction(run.run_id, () => {}, { expected_revision: 0 }),
      (error) => error.code === 'STALE_REVISION',
    );
    assert.equal(store.get(run.run_id).run.state_revision.value, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
