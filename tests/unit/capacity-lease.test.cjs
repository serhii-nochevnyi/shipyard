'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCapacityCoordinator } = require('../../plugins/delivery-pipeline/scripts/capacity-lease.cjs');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-capacity-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

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
