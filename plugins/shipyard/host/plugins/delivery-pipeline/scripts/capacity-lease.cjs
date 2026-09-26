'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, writeAtomic } = require('./lock.cjs');

const SCHEMA_VERSION = 'shipyard.capacity-leases.v1';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 10 * 60 * 1000;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clean(value) {
  return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : null;
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function readJson(file) {
  if (!fs.existsSync(file)) return { schema_version: SCHEMA_VERSION, leases: {} };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(value) || value.schema_version !== SCHEMA_VERSION || !object(value.leases)) {
    throw new Error('capacity lease store has an unknown schema');
  }
  return value;
}

function leaseId() {
  return `lease-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function createCapacityCoordinator(options = {}) {
  const storeDir = typeof options.storeDir === 'string' && options.storeDir.trim()
    ? path.resolve(options.storeDir) : null;
  const storeFile = storeDir && path.join(storeDir, 'capacity-leases.json');
  const lockDir = storeDir && path.join(storeDir, '.locks');
  const provider = clean(options.provider);
  const accountScope = clean(options.accountScope || options.account_scope);
  const projectId = clean(options.projectId || options.project_id) || process.cwd();
  const ownerId = clean(options.ownerId || options.owner_id) || `pid-${process.pid}`;
  const max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : 4;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
    ? options.heartbeatMs : Math.min(DEFAULT_HEARTBEAT_MS, Math.max(1000, Math.floor(ttlMs / 3)));
  const now = options.now;
  const localActive = typeof options.localActive === 'function' ? options.localActive : () => Number(options.localActive) || 0;
  const memory = new Map();
  const customStore = object(options.store) ? options.store : null;

  const knownScope = Boolean(provider && accountScope && storeDir);
  const localCount = () => {
    const base = Math.max(0, Number(localActive()) || 0);
    const distinct = new Set([...memory.values()].map((entry) => entry.agent_id));
    return base + distinct.size;
  };
  const localResult = (reason, agent, role) => {
    const inFlight = localCount();
    if (inFlight >= max) return { admitted: false, reason: 'capacity-full', coverage: 'local-fallback', degraded: true, max, in_flight: inFlight, free: 0 };
    const id = leaseId();
    const entry = { lease_id: id, owner_id: ownerId, project_id: projectId, provider: provider || null, account_scope: accountScope || null, agent_id: agent, role, parent_lease_id: null, acquired_at: nowValue(now), heartbeat_at: nowValue(now), expires_at: nowValue(now) + ttlMs };
    memory.set(id, entry);
    return { admitted: true, lease_id: id, lease: entry, reason, coverage: 'local-fallback', degraded: true, max, in_flight: inFlight + 1, free: Math.max(0, max - inFlight - 1) };
  };

  function read() {
    if (customStore && typeof customStore.read === 'function') return customStore.read();
    return readJson(storeFile);
  }

  function write(value) {
    if (customStore && typeof customStore.write === 'function') return customStore.write(value);
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    writeAtomic(storeFile, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  }

  function activeLeases(store, at) {
    let changed = false;
    for (const [id, lease] of Object.entries(store.leases)) {
      if (!object(lease) || Number(lease.expires_at) <= at) {
        delete store.leases[id];
        changed = true;
      }
    }
    return { leases: Object.values(store.leases), changed };
  }

  function agentKeys(leases) {
    return new Set(leases.map((lease) => {
      const agent = clean(lease && lease.agent_id);
      return agent ? `agent:${agent}` : `lease:${lease && lease.lease_id}`;
    }));
  }

  function snapshot() {
    if (!knownScope) {
      const inFlight = localCount();
      return { schema_version: SCHEMA_VERSION, max, in_flight: inFlight, free: Math.max(0, max - inFlight), coverage: 'unknown-scope', degraded: true, provider: provider || null, account_scope: accountScope || null };
    }
    try {
      const output = withLock(lockDir, 'capacity', () => {
        const store = read();
        const at = nowValue(now);
        const current = activeLeases(store, at);
        if (current.changed) write(store);
        const scoped = current.leases.filter((lease) => lease.provider === provider && lease.account_scope === accountScope);
        const agents = agentKeys(scoped);
        const inFlight = agents.size;
        return { schema_version: SCHEMA_VERSION, max, in_flight: inFlight, free: Math.max(0, max - inFlight), coverage: 'shared', degraded: false, provider, account_scope: accountScope, leases: scoped.map((lease) => ({ ...lease })) };
      }, { label: 'capacity-lease', waitMs: 5000 });
      return output;
    } catch (error) {
      const inFlight = localCount();
      return { schema_version: SCHEMA_VERSION, max, in_flight: inFlight, free: Math.max(0, max - inFlight), coverage: 'store-failure', degraded: true, provider, account_scope: accountScope, reason: error.message };
    }
  }

  function acquire(input = {}) {
    const agent = clean(input.agent_id || input.agentId);
    const role = clean(input.role) || 'unknown';
    if (!agent) return { admitted: false, reason: 'missing-agent-id', coverage: knownScope ? 'shared' : 'unknown-scope', degraded: true, max, in_flight: localCount(), free: Math.max(0, max - localCount()) };
    if (!knownScope) return localResult('account-scope-unknown', agent, role);
    try {
      return withLock(lockDir, 'capacity', () => {
        const store = read();
        const at = nowValue(now);
        const current = activeLeases(store, at);
        const existing = current.leases.find((lease) => lease.provider === provider && lease.account_scope === accountScope
          && lease.owner_id === ownerId && lease.project_id === projectId && lease.agent_id === agent && lease.role === role);
        if (existing) {
          const agents = agentKeys(current.leases.filter((l) => l.provider === provider && l.account_scope === accountScope));
          return { admitted: true, idempotent: true, lease_id: existing.lease_id, lease: { ...existing }, coverage: 'shared', degraded: false, max, in_flight: agents.size, free: Math.max(0, max - agents.size) };
        }
        const parent = input.parent_lease_id || input.parentLeaseId;
        if (parent && !current.leases.some((lease) => lease.lease_id === parent && lease.provider === provider && lease.account_scope === accountScope)) {
          const agents = agentKeys(current.leases.filter((lease) => lease.provider === provider && lease.account_scope === accountScope));
          return { admitted: false, reason: 'parent-lease-unknown', coverage: 'shared', degraded: false, max, in_flight: agents.size, free: Math.max(0, max - agents.size) };
        }
        const scoped = current.leases.filter((lease) => lease.provider === provider && lease.account_scope === accountScope);
        const agents = agentKeys(scoped);
        if (!agents.has(`agent:${agent}`) && agents.size >= max) {
          return { admitted: false, reason: 'capacity-full', coverage: 'shared', degraded: false, max, in_flight: agents.size, free: 0 };
        }
        const entry = { lease_id: leaseId(), owner_id: ownerId, project_id: projectId, provider, account_scope: accountScope, agent_id: agent, role, parent_lease_id: parent || null, acquired_at: at, heartbeat_at: at, expires_at: at + ttlMs };
        store.leases[entry.lease_id] = entry;
        write(store);
        const inFlight = agents.has(`agent:${agent}`) ? agents.size : agents.size + 1;
        return { admitted: true, lease_id: entry.lease_id, lease: { ...entry }, coverage: 'shared', degraded: false, max, in_flight: inFlight, free: Math.max(0, max - inFlight) };
      }, { label: 'capacity-lease', waitMs: 5000 });
    } catch (error) {
      return localResult('store-failure', agent, role);
    }
  }

  function heartbeat(id) {
    if (!memory.has(id) && !knownScope) return { renewed: false, reason: 'unknown-lease', coverage: 'unknown-scope' };
    if (memory.has(id)) {
      const entry = memory.get(id);
      const at = nowValue(now);
      memory.set(id, { ...entry, heartbeat_at: at, expires_at: at + ttlMs });
      return { renewed: true, lease_id: id, coverage: 'local-fallback' };
    }
    try {
      return withLock(lockDir, 'capacity', () => {
        const store = read();
        const entry = store.leases[id];
        if (!entry || entry.owner_id !== ownerId) return { renewed: false, reason: 'unknown-or-not-owner', coverage: 'shared' };
        const at = nowValue(now);
        entry.heartbeat_at = at;
        entry.expires_at = at + ttlMs;
        write(store);
        return { renewed: true, lease_id: id, coverage: 'shared' };
      }, { label: 'capacity-lease', waitMs: 5000 });
    } catch (error) {
      return { renewed: false, reason: 'store-failure', coverage: 'store-failure', degraded: true };
    }
  }

  function release(id) {
    if (memory.delete(id)) return { released: true, lease_id: id, coverage: 'local-fallback' };
    if (!knownScope) return { released: false, reason: 'unknown-lease', coverage: 'unknown-scope' };
    try {
      return withLock(lockDir, 'capacity', () => {
        const store = read();
        const entry = store.leases[id];
        if (!entry) return { released: false, reason: 'unknown-lease', coverage: 'shared' };
        if (entry.owner_id !== ownerId) return { released: false, reason: 'not-owner', coverage: 'shared' };
        delete store.leases[id];
        write(store);
        return { released: true, lease_id: id, coverage: 'shared' };
      }, { label: 'capacity-lease', waitMs: 5000 });
    } catch (error) {
      return { released: false, reason: 'store-failure', coverage: 'store-failure', degraded: true };
    }
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    provider,
    account_scope: accountScope,
    max,
    ttl_ms: ttlMs,
    heartbeat_interval_ms: heartbeatMs,
    acquire,
    heartbeat,
    release,
    snapshot,
  });
}

function readCapacitySnapshot(storeDir, options = {}) {
  return createCapacityCoordinator({ ...options, storeDir }).snapshot();
}

module.exports = Object.freeze({ SCHEMA_VERSION, DEFAULT_TTL_MS, createCapacityCoordinator, readCapacitySnapshot });
