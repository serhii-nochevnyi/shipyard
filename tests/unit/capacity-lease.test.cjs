'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');
const capacityLease = require('../../plugins/delivery-pipeline/scripts/capacity-lease.cjs');
const {
  createCapacityCoordinator, readCapacitySnapshot, SCHEMA_VERSION,
  createAdmissionLedger, ADMISSION_LEDGER_SCHEMA_VERSION, DEFAULT_LAUNCH_BUDGET,
} = capacityLease;

const WORKER_ENV_FLAG = 'SHIPYARD_CAPACITY_LEASE_WORKER';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-capacity-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function withTempDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-capacity-'));
  try { return await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function onceMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    }
    function onMessage(msg) {
      if (predicate(msg)) { cleanup(); resolve(msg); }
    }
    function onExit(code, signal) {
      cleanup(); reject(new Error(`worker exited (code=${code} signal=${signal}) before the expected message`));
    }
    function onError(err) { cleanup(); reject(err); }
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function runConcurrentReservers({
  root, runId, phase, launchBudget, dispatchIds, atomic,
}) {
  const children = dispatchIds.map((dispatchId) => fork(__filename, [], {
    env: {
      ...process.env,
      [WORKER_ENV_FLAG]: '1',
      SHIPYARD_WORKER_STORE_DIR: root,
      SHIPYARD_WORKER_RUN_ID: runId,
      SHIPYARD_WORKER_PHASE: String(phase),
      SHIPYARD_WORKER_LAUNCH_BUDGET: String(launchBudget),
      SHIPYARD_WORKER_DISPATCH_ID: dispatchId,
      SHIPYARD_WORKER_ATOMIC: atomic ? '1' : '0',
    },
    silent: true,
  }));

  return Promise.all(children.map((child) => onceMessage(child, (m) => m && m.ready === true)))
    .then(() => {
      const results = Promise.all(children.map((child) => onceMessage(child, (m) => m && m.result !== undefined)));
      const readDone = atomic
        ? null
        : Promise.all(children.map((child) => onceMessage(child, (m) => m && m.readDone === true)));
      for (const child of children) child.send({ go: true });
      if (atomic) return results;
      return readDone.then(() => {
        for (const child of children) child.send({ go2: true });
        return results;
      });
    })
    .finally(() => {
      for (const child of children) { try { child.kill(); } catch {} }
    });
}

function runReserveWorker() {
  const storeDir = process.env.SHIPYARD_WORKER_STORE_DIR;
  const runId = process.env.SHIPYARD_WORKER_RUN_ID;
  const phase = process.env.SHIPYARD_WORKER_PHASE;
  const launchBudget = Number(process.env.SHIPYARD_WORKER_LAUNCH_BUDGET);
  const dispatchId = process.env.SHIPYARD_WORKER_DISPATCH_ID;
  const atomic = process.env.SHIPYARD_WORKER_ATOMIC === '1';
  const finish = (result) => process.send({ result }, () => process.exit(0));

  if (atomic) {
    process.once('message', (msg) => {
      if (!msg || msg.go !== true) return;
      const ledger = createAdmissionLedger({ storeDir, launchBudget });
      finish(ledger.reserve({
        run_id: runId, phase, kind: 'launch', dispatch_id: dispatchId,
      }));
    });
    process.send({ ready: true });
    return;
  }

  const storeFile = path.join(storeDir, 'admission-ledger.json');
  process.once('message', (readMsg) => {
    if (!readMsg || readMsg.go !== true) return;
    let store = { schema_version: ADMISSION_LEDGER_SCHEMA_VERSION, entries: {} };
    if (fs.existsSync(storeFile)) {
      try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch {}
    }
    const before = Object.values(store.entries).filter((e) => e.kind === 'launch' && e.decision === 'would_admit'
      && e.run_id === runId && e.phase === phase).length;
    const decision = before < launchBudget ? 'would_admit' : 'would_refuse';
    process.once('message', (writeMsg) => {
      if (!writeMsg || writeMsg.go2 !== true) return;
      store.entries[dispatchId] = {
        dispatch_id: dispatchId, run_id: runId, phase, kind: 'launch', decision,
      };
      fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(storeFile, `${JSON.stringify(store, null, 2)}\n`);
      finish({ decision });
    });
    process.send({ readDone: true });
  });
  process.send({ ready: true });
}

if (process.env[WORKER_ENV_FLAG]) {
  runReserveWorker();
} else {
  test('shared capacity is scoped, idempotent, and counts distinct agents', () => fixture((root) => {
    const first = createCapacityCoordinator({
      storeDir: root, provider: 'anthropic', accountScope: 'pro:max', projectId: 'project-a', ownerId: 'owner-a', max: 2,
    });
    const second = createCapacityCoordinator({
      storeDir: root, provider: 'anthropic', accountScope: 'pro:max', projectId: 'project-b', ownerId: 'owner-b', max: 2,
    });
    const a = first.acquire({ agent_id: 'agent-a', role: 'executor' });
    assert.equal(a.admitted, true);
    assert.equal(first.acquire({ agent_id: 'agent-a', role: 'executor' }).idempotent, true);
    const b = second.acquire({ agent_id: 'agent-b', role: 'workflow' });
    assert.equal(b.admitted, true);
    assert.equal(second.snapshot().in_flight, 2);
    assert.equal(second.acquire({ agent_id: 'agent-c', role: 'executor' }).reason, 'capacity-full');

    const otherAccount = createCapacityCoordinator({
      storeDir: root, provider: 'anthropic', accountScope: 'team:other', projectId: 'project-c', ownerId: 'owner-c', max: 1,
    });
    assert.equal(otherAccount.acquire({ agent_id: 'agent-c', role: 'executor' }).admitted, true);
  }));

  test('nested work requires a live parent and consumes its own agent slot', () => fixture((root) => {
    const coordinator = createCapacityCoordinator({
      storeDir: root, provider: 'openai', accountScope: 'chatgpt:team', projectId: 'project', ownerId: 'owner', max: 3,
    });
    const parent = coordinator.acquire({ agent_id: 'parent', role: 'executor' });
    const child = coordinator.acquire({ agent_id: 'child', role: 'workflow', parent_lease_id: parent.lease_id });
    assert.equal(child.admitted, true);
    assert.equal(coordinator.snapshot().in_flight, 2);
    const missing = coordinator.acquire({ agent_id: 'orphan', role: 'workflow', parent_lease_id: 'missing' });
    assert.equal(missing.admitted, false);
    assert.equal(missing.reason, 'parent-lease-unknown');
    assert.equal(coordinator.snapshot().in_flight, 2);
  }));

  test('heartbeat extends a lease and expiry recovers it', () => fixture((root) => {
    let clock = 1_000;
    const coordinator = createCapacityCoordinator({
      storeDir: root, provider: 'openai', accountScope: 'chatgpt:team', projectId: 'project', ownerId: 'owner',
      max: 1, ttlMs: 100, heartbeatMs: 20, now: () => clock,
    });
    const lease = coordinator.acquire({ agent_id: 'agent', role: 'executor' });
    clock = 1_080;
    assert.equal(coordinator.heartbeat(lease.lease_id).renewed, true);
    clock = 1_179;
    assert.equal(coordinator.snapshot().in_flight, 1);
    clock = 1_180;
    assert.equal(coordinator.snapshot().in_flight, 0);
  }));

  test('store failure falls back to a conservative local cap and remains observable', () => fixture((root) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'capacity-leases.json'), '{broken');
    const coordinator = createCapacityCoordinator({
      storeDir: root, provider: 'openai', accountScope: 'chatgpt:team', projectId: 'project', ownerId: 'owner',
      max: 2, localActive: 1,
    });
    const first = coordinator.acquire({ agent_id: 'agent', role: 'executor' });
    assert.equal(first.admitted, true);
    assert.equal(first.coverage, 'local-fallback');
    assert.equal(first.degraded, true);
    assert.equal(coordinator.acquire({ agent_id: 'other', role: 'executor' }).admitted, false);
    assert.equal(coordinator.snapshot().coverage, 'store-failure');
  }));

  test('missing account scope never becomes unlimited capacity', () => {
    const coordinator = createCapacityCoordinator({ provider: 'openai', max: 1 });
    const result = coordinator.acquire({ agent_id: 'agent', role: 'executor' });
    assert.equal(result.admitted, true);
    assert.equal(result.coverage, 'local-fallback');
    assert.equal(result.degraded, true);
    assert.equal(coordinator.snapshot().coverage, 'unknown-scope');
  });

  test('readCapacitySnapshot output and SCHEMA_VERSION stay byte-compatible with the pre-ledger shape', () => {
    assert.equal(SCHEMA_VERSION, 'shipyard.capacity-leases.v1');
    const unknownScope = readCapacitySnapshot(null, { provider: 'openai', max: 1 });
    assert.deepEqual(
      Object.keys(unknownScope).sort(),
      ['account_scope', 'coverage', 'degraded', 'free', 'in_flight', 'max', 'provider', 'schema_version'].sort(),
    );
    fixture((root) => {
      const coordinator = createCapacityCoordinator({
        storeDir: root, provider: 'openai', accountScope: 'team', projectId: 'p', ownerId: 'o', max: 2,
      });
      coordinator.acquire({ agent_id: 'a', role: 'executor' });
      const shared = coordinator.snapshot();
      assert.deepEqual(
        Object.keys(shared).sort(),
        ['account_scope', 'coverage', 'degraded', 'free', 'in_flight', 'leases', 'max', 'provider', 'schema_version'].sort(),
      );
    });
  });

  test('reserve admits launches up to the budget and refuses beyond it', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 2 });
    const a = ledger.reserve({
      run_id: 'run-1', phase: 45, kind: 'launch', dispatch_id: 'd1',
    });
    assert.equal(a.decision, 'would_admit');
    assert.equal(a.mode, 'shadow');
    assert.equal(a.launches_reserved, 1);
    assert.equal(a.launch_budget, 2);
    const b = ledger.reserve({
      run_id: 'run-1', phase: 45, kind: 'launch', dispatch_id: 'd2',
    });
    assert.equal(b.decision, 'would_admit');
    assert.equal(b.launches_reserved, 2);
    const c = ledger.reserve({
      run_id: 'run-1', phase: 45, kind: 'launch', dispatch_id: 'd3',
    });
    assert.equal(c.decision, 'would_refuse');
    assert.equal(c.launches_reserved, 2);
  }));

  test('the default launch budget is 12, recorded on the ledger record as budget_source "default"', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root });
    assert.equal(DEFAULT_LAUNCH_BUDGET, 12);
    assert.equal(ledger.launch_budget, 12);
    ledger.reserve({
      run_id: 'run-1', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
    assert.equal(raw.schema_version, ADMISSION_LEDGER_SCHEMA_VERSION);
    assert.equal(raw.entries.d1.budget_source, 'default');
    assert.equal(fs.statSync(path.join(root, 'admission-ledger.json')).mode & 0o777, 0o600);
  }));

  test('an explicit launch budget is recorded as budget_source "constructor"', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 3 });
    assert.equal(ledger.launch_budget, 3);
    ledger.reserve({
      run_id: 'run-1', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
    assert.equal(raw.entries.d1.budget_source, 'constructor');
  }));

  test('verification and checkpoint reservations always admit and never count toward the launch budget', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 1 });
    assert.equal(ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'l1',
    }).decision, 'would_admit');
    assert.equal(ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'l2',
    }).decision, 'would_refuse');
    const v = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'verification', dispatch_id: 'v1',
    });
    assert.equal(v.decision, 'would_admit');
    assert.equal(v.mode, 'shadow');
    assert.equal(v.launches_reserved, 1);
    const cp = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'checkpoint', dispatch_id: 'c1',
    });
    assert.equal(cp.decision, 'would_admit');
    assert.equal(cp.launches_reserved, 1);
    const rep = ledger.report({ run_id: 'r', phase: 1 });
    assert.equal(rep.launches_reserved, 1);
    assert.equal(rep.launches_refused, 1);
    assert.equal(rep.verifications_reserved, 1);
    assert.equal(rep.checkpoints_reserved, 1);
  }));

  test('a duplicate dispatch_id is idempotent', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 1 });
    const first = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    const second = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    assert.equal(first.decision, second.decision);
    assert.equal(second.idempotent, true);
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
    assert.equal(Object.keys(raw.entries).length, 1);
    const third = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd2',
    });
    assert.equal(third.decision, 'would_refuse');
  }));

  test('reconcile stores observed usage verbatim or "unknown" when absent, and report reflects it', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 5 });
    ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    let rep = ledger.report({ run_id: 'r', phase: 1 });
    assert.equal(rep.quota, 'unknown');
    assert.equal(rep.launches_reserved, 1);
    const rec = ledger.reconcile({ dispatch_id: 'd1', observed: 3 });
    assert.equal(rec.reconciled, true);
    assert.equal(rec.observed, 3);
    rep = ledger.report({ run_id: 'r', phase: 1 });
    assert.equal(rep.quota, 'observed');
    assert.equal(rep.launches_reserved, 1);

    ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd2',
    });
    const recAbsent = ledger.reconcile({ dispatch_id: 'd2' });
    assert.equal(recAbsent.observed, 'unknown');
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
    assert.equal(raw.entries.d1.observed, 3);
    assert.equal(raw.entries.d2.observed, 'unknown');
  }));

  test('reconcile on an unknown dispatch_id reports it and creates no record', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root });
    const rec = ledger.reconcile({ dispatch_id: 'ghost', observed: 5 });
    assert.equal(rec.reconciled, false);
    assert.equal(rec.reason, 'unknown-dispatch');
    assert.equal(fs.existsSync(path.join(root, 'admission-ledger.json')), false);
  }));

  test('report returns conservative zero counts and quota "unknown" for a bucket with no reservations, never a percentage', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 7 });
    const rep = ledger.report({ run_id: 'never-reserved', phase: 99 });
    assert.equal(rep.quota, 'unknown');
    assert.equal(rep.launches_reserved, 0);
    assert.equal(rep.launches_refused, 0);
    assert.equal(rep.verifications_reserved, 0);
    assert.equal(rep.checkpoints_reserved, 0);
    assert.equal(rep.launch_budget, 7);
    assert.equal(rep.mode, 'shadow');
    for (const key of Object.keys(rep)) assert.ok(!/percent/i.test(key));
  }));

  test('every reserve response stays in shadow mode and never exposes a caller-actionable refusal', () => fixture((root) => {
    const ledger = createAdmissionLedger({ storeDir: root, launchBudget: 1 });
    const admitted = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd1',
    });
    const refused = ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd2',
    });
    assert.equal(admitted.mode, 'shadow');
    assert.equal(refused.mode, 'shadow');
    assert.equal(typeof refused.decision, 'string');
    assert.ok(!('admitted' in refused));
    assert.ok(!('refused' in refused));
    assert.doesNotThrow(() => ledger.reserve({
      run_id: 'r', phase: 1, kind: 'launch', dispatch_id: 'd3',
    }));
  }));

  test('8 concurrent reservers against a budget of 4 admit exactly 4 and refuse exactly 4, with no lost or duplicated entry', { timeout: 20000 }, async () => {
    await withTempDir(async (root) => {
      const dispatchIds = Array.from({ length: 8 }, (_, i) => `cp-${i}`);
      await runConcurrentReservers({
        root, runId: 'run-cp', phase: 'p1', launchBudget: 4, dispatchIds, atomic: true,
      });
      const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
      assert.equal(Object.keys(raw.entries).length, 8);
      for (const id of dispatchIds) assert.ok(raw.entries[id], `missing entry for ${id}`);
      const admits = Object.values(raw.entries).filter((e) => e.decision === 'would_admit').length;
      const refusals = Object.values(raw.entries).filter((e) => e.decision === 'would_refuse').length;
      assert.equal(admits, 4);
      assert.equal(refusals, 4);
    });
  });

  test('a non-atomic read-modify-write over the same store loses updates (the lock is load-bearing)', { timeout: 20000 }, async () => {
    await withTempDir(async (root) => {
      const dispatchIds = Array.from({ length: 8 }, (_, i) => `na-${i}`);
      await runConcurrentReservers({
        root, runId: 'run-na', phase: 'p1', launchBudget: 4, dispatchIds, atomic: false,
      });
      const raw = JSON.parse(fs.readFileSync(path.join(root, 'admission-ledger.json'), 'utf8'));
      assert.notEqual(Object.keys(raw.entries).length, 8);
    });
  });
}
