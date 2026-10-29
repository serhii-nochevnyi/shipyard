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

test('runs recorded under a retired policy are skipped on read while current-policy siblings survive', () => {
  const root = tempDir();
  try {
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const store = createRunStore({ storeDir: root, now: () => 1000 });
    const palettes = { codex: { sol: 'gpt-6.1-sol', luna: 'gpt-6-luna', astra: 'gpt-6-astra' }, claude: { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'fable' } };
    const runs = {};
    for (const [runtime, palette] of Object.entries(palettes)) for (const [key, model] of Object.entries(palette)) {
      const run = JSON.parse(JSON.stringify(makeRun('owner-a', `fixture-${runtime}-${key}`)));
      run.runtime = { ...run.runtime, runtime, provider: runtime === 'codex' ? 'openai' : 'anthropic' };
      run.dispatch = { ...run.dispatch, runtime, provider: run.runtime.provider, model_key: key, model, policy_version: policy.POLICY_VERSION, policy_hash: policy.POLICY_HASH };
      runs[run.run_id] = { schema: 'shipyard.run-record.v1', version: 1, run, owner: { owner_id: 'owner-a', lease_id: run.lease.lease_id, epoch: 0, acquired_at: 1000, heartbeat_at: 1000, expires_at: 2000, status: 'active' }, retry: {}, checkpoint: null, successor: null, idempotency: {}, history: [] };
    }
    const current = Object.keys(runs);
    assert.equal(current.length, 6);
    for (const version of ['adr-014.v6', 'adr-014.v7']) {
      const retired = JSON.parse(JSON.stringify(runs[current[0]]));
      retired.run.run_id = `retired-${version}`;
      retired.run.dispatch.policy_version = version;
      runs[retired.run.run_id] = retired;
    }
    fs.writeFileSync(store.storeFile, JSON.stringify({ schema: 'shipyard.run-store.v1', version: 1, generation: 0, updated_at: null, runs }));
    const bytes = fs.readFileSync(store.storeFile, 'utf8');
    assert.deepEqual(Object.keys(store.read().runs).sort(), current.slice().sort());
    assert.equal(store.get('retired-adr-014.v6'), null);
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), bytes);
    for (const id of current) store.transaction(id, record => { record.history.push({ event: 'synthetic-note' }); }, { expected_revision: 0 });
    const disk = JSON.parse(fs.readFileSync(store.storeFile));
    assert.deepEqual(Object.keys(disk.runs).sort(), current.slice().sort());
    for (const id of current) assert.deepEqual(disk.runs[id].history, [{ event: 'synthetic-note' }]);

    const id = current[0];
    const valid = fs.readFileSync(store.storeFile, 'utf8');
    for (const invalid of [policy.POLICY_HASH.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), 'a'.repeat(64)]) {
      assert.throws(() => store.transaction(id, record => { record.run = { ...record.run, dispatch: { ...record.run.dispatch, policy_hash: invalid } }; }), { code: 'POLICY_IDENTITY_CONFLICT' });
      assert.equal(fs.readFileSync(store.storeFile, 'utf8'), valid);
      const corrupted = JSON.parse(valid); corrupted.runs[id].run.dispatch.policy_hash = invalid;
      fs.writeFileSync(store.storeFile, JSON.stringify(corrupted));
      assert.throws(() => store.read(), { code: 'POLICY_IDENTITY_CONFLICT' });
      fs.writeFileSync(store.storeFile, valid);
    }
    assert.throws(() => store.transaction(id, record => { record.run = { ...record.run, dispatch: { ...record.run.dispatch, model: 'gpt-6-luna' } }; }), { code: 'RUNTIME_MODEL_MISMATCH' });
    assert.equal(fs.readFileSync(store.storeFile, 'utf8'), valid);
    const unknown = JSON.parse(valid); unknown.runs[id].run.dispatch.policy_version = 'adr-014.v9';
    fs.writeFileSync(store.storeFile, JSON.stringify(unknown));
    assert.throws(() => store.read(), { code: 'UNSUPPORTED_POLICY_VERSION' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
