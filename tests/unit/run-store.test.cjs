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

// @contract: Directly seeded synthetic v6 fixture does not prove native application.
test('persisted historical Sol survives actual read and unrelated transaction', () => {
  const root = tempDir();
  try {
    const store = createRunStore({ storeDir: root, now: () => 1000 });
    const run = makeRun();
    store.create({ run, owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' }, retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [] });
    const seeded = JSON.parse(fs.readFileSync(store.storeFile, 'utf8'));
    seeded.runs[run.run_id].run.dispatch = { ...seeded.runs[run.run_id].run.dispatch, model_key: 'sol', model: 'gpt-6-sol', policy_version: 'adr-014.v6', policy_hash: '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968' };
    fs.writeFileSync(store.storeFile, JSON.stringify(seeded));
    const bytes = fs.readFileSync(store.storeFile, 'utf8');
    const identity = seeded.runs[run.run_id].run.dispatch;
    assert.deepEqual(store.read().runs[run.run_id].run.dispatch, identity);
    assert.deepEqual(store.get(run.run_id).run.dispatch, identity);
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), bytes);
    store.transaction(run.run_id, record => { record.history.push({ event: 'synthetic-note' }); }, { expected_revision: 0 });
    assert.deepEqual(JSON.parse(fs.readFileSync(store.storeFile)).runs[run.run_id].run.dispatch, identity);
    assert.deepEqual(createRunStore({ storeDir: root }).get(run.run_id).run.dispatch, identity);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('synthetic v6/v7 store matrix preserves siblings and refuses invalid input atomically', () => {
  const root = tempDir();
  try {
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const store = createRunStore({ storeDir: root, now: () => 1000 });
    const palettes = { codex: { sol: 'gpt-6-sol', luna: 'gpt-6-luna', astra: 'gpt-6-astra' }, claude: { sonnet: 'sonnet', opus: 'claude-opus-5-5', fable: 'fable' } };
    const runs = {};
    for (const version of ['adr-014.v6', 'adr-014.v7']) for (const [runtime, palette] of Object.entries(palettes)) for (const [key, oldModel] of Object.entries(palette)) {
      const run = JSON.parse(JSON.stringify(makeRun('owner-a', `fixture-${version}-${key}`)));
      const model = version.endsWith('v7') && key === 'sol' ? 'gpt-6.1-sol' : version.endsWith('v7') && key === 'sonnet' ? 'claude-sonnet-5-5' : oldModel;
      run.runtime = { ...run.runtime, runtime, provider: runtime === 'codex' ? 'openai' : 'anthropic' };
      run.dispatch = { ...run.dispatch, runtime, provider: run.runtime.provider, model_key: key, model, policy_version: version, policy_hash: version.endsWith('v6') ? '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968' : policy.POLICY_HASH };
      runs[run.run_id] = { schema: 'shipyard.run-record.v1', version: 1, run, owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' }, retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [] };
    }
    fs.writeFileSync(store.storeFile, JSON.stringify({ schema: 'shipyard.run-store.v1', version: 1, generation: 0, updated_at: null, runs }));
    const bytes = fs.readFileSync(store.storeFile, 'utf8');
    const before = store.read();
    for (const [id, record] of Object.entries(runs)) assert.deepEqual(store.get(id).run, record.run);
    store.transact(() => {});
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), bytes);
    for (const id of Object.keys(runs)) store.transaction(id, record => { record.history.push({ event: 'synthetic-note' }); }, { expected_revision: 0 });
    const after = createRunStore({ storeDir: root }).read();
    const disk = JSON.parse(fs.readFileSync(store.storeFile));
    for (const id of Object.keys(runs)) {
      assert.deepEqual(after.runs[id].run, before.runs[id].run);
      assert.deepEqual(after.runs[id].owner, before.runs[id].owner);
      assert.deepEqual(disk.runs[id].run, runs[id].run);
      const expected = { ...before.runs[id], history: [{ event: 'synthetic-note' }] };
      assert.deepEqual(after.runs[id], expected);
    }
    const id = Object.keys(runs)[0];
    const validBytes = fs.readFileSync(store.storeFile, 'utf8');
    assert.throws(() => store.transaction(id, record => { record.run = { ...record.run, dispatch: { ...record.run.dispatch, model: 'gpt-6-luna' } }; }), { code: 'RUNTIME_MODEL_MISMATCH' });
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), validBytes);
    disk.runs[id].run.dispatch.model = 'gpt-6-luna';
    fs.writeFileSync(store.storeFile, JSON.stringify(disk));
    const invalidBytes = fs.readFileSync(store.storeFile, 'utf8');
    let called = false;
    assert.throws(() => store.transaction(id, () => { called = true; }), { code: 'RUNTIME_MODEL_MISMATCH' });
    assert.equal(called, false);
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), invalidBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
