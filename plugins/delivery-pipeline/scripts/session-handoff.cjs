'use strict';

// A manual context handoff is a fencing protocol, not a second dispatch log.
// The store lives below the repository's canonical Git common directory so two
// worktrees cannot each believe that they own the same delivery scope. The
// capability returned by this module is deliberately process-local: a JSON
// checkpoint can describe the next action, but it cannot grant launch authority.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCHEMA = 'shipyard.session-handoff.v1';
const ENVELOPE = 'shipyard.session-handoff-envelope.v1';
const LOCK_GRACE_MS = 2000;
const CAPABILITIES = new WeakSet();
const CONTROLLERS = new WeakSet();
const CAPABILITY_DATA = new WeakMap();
const CONTROLLER_DATA = new WeakMap();
const HANDOFF_CONTEXT = new AsyncLocalStorage();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function handoffError(code, message, details = {}) {
  const error = new Error(`session-handoff: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function refuse(code, message, details) {
  throw handoffError(code, message, details);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomId(prefix) {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${suffix}`;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  const millis = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(millis)) refuse('INVALID_CLOCK', 'clock must return a finite timestamp');
  return new Date(millis).toISOString();
}

function safeName(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_INPUT', `${field} must be a non-empty safe string`);
  }
  return value.trim();
}

function safeId(value, field) {
  const result = safeName(value, field);
  if (/\s/.test(result)) refuse('INVALID_INPUT', `${field} must not contain whitespace`);
  return result;
}

function safeDigest(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
    refuse('INVALID_CHECKPOINT', `${field} must be a hexadecimal Git or SHA-256 digest`);
  }
  return value;
}

function gitCommonDir(cwd) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    refuse('UNRESOLVED_REPOSITORY', `cannot resolve the Git common directory: ${error.message}`);
  }
  if (!raw) refuse('UNRESOLVED_REPOSITORY', 'Git returned an empty common directory');
  const candidate = path.resolve(cwd, raw);
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    refuse('UNRESOLVED_REPOSITORY', `Git common directory is not a readable real path: ${error.message}`);
  }
}

function resolveRepositoryIdentity(cwd = process.cwd()) {
  const root = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : process.cwd();
  let worktree;
  try { worktree = fs.realpathSync(root); }
  catch (error) { refuse('UNRESOLVED_REPOSITORY', `worktree cannot be resolved: ${error.message}`); }
  const commonDir = gitCommonDir(worktree);
  return Object.freeze({ repository_id: commonDir, common_dir: commonDir, worktree });
}

function ownershipStorePath(identity) {
  if (typeof identity === 'string') return path.join(identity, 'shipyard', 'ownership');
  if (!object(identity) || typeof identity.common_dir !== 'string' || !identity.common_dir) {
    refuse('UNRESOLVED_REPOSITORY', 'ownership store needs a resolved Git common directory');
  }
  return path.join(identity.common_dir, 'shipyard', 'ownership');
}

function stateFile(store) { return path.join(store, 'state.json'); }
function lockFile(store) { return path.join(store, 'state.lock'); }

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function lockAge(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; }
  catch (_) { return Infinity; }
}

function acquireLock(store) {
  const file = lockFile(store);
  const owner = { pid: process.pid, token: randomId('lock'), at: new Date().toISOString() };
  try {
    fs.mkdirSync(file, { recursive: false, mode: 0o700 });
    fs.writeFileSync(path.join(file, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return () => fs.rmSync(file, { recursive: true, force: true });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') refuse('OWNERSHIP_LOCKED', `cannot create the ownership lock: ${error.message}`);
    let holder;
    try { holder = JSON.parse(fs.readFileSync(path.join(file, 'owner.json'), 'utf8')); }
    catch (readError) {
      if (lockAge(file) < LOCK_GRACE_MS) refuse('OWNERSHIP_LOCKED', 'ownership lock is being created by another process');
      refuse('CORRUPT_LOCK', `ownership lock is unreadable: ${readError.message}`);
    }
    if (!object(holder) || !Number.isInteger(holder.pid) || typeof holder.token !== 'string') {
      refuse('CORRUPT_LOCK', 'ownership lock has invalid holder evidence');
    }
    if (processAlive(holder.pid) || lockAge(file) < LOCK_GRACE_MS) {
      refuse('OWNERSHIP_LOCKED', `ownership store is locked by pid ${holder.pid}`);
    }
    try { fs.rmSync(file, { recursive: true, force: true }); }
    catch (removeError) { refuse('OWNERSHIP_LOCKED', `stale ownership lock could not be recovered: ${removeError.message}`); }
    return acquireLock(store);
  }
}

function withLock(store, fn) {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const release = acquireLock(store);
  try { return fn(); }
  finally { try { release(); } catch (_) { /* preserve the operation result */ } }
}

function emptyState(identity) {
  return {
    schema: SCHEMA, version: 1, repository_id: identity.repository_id,
    common_dir: identity.common_dir, next_epoch: 1, scopes: {},
  };
}

function readEnvelope(store, identity) {
  const file = stateFile(store);
  if (!fs.existsSync(file)) return emptyState(identity);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { refuse('CORRUPT_STATE', `ownership state is not valid JSON: ${error.message}`); }
  if (!object(raw) || raw.format !== ENVELOPE || !object(raw.payload)
      || !object(raw.integrity) || raw.integrity.algorithm !== 'sha256'
      || typeof raw.integrity.digest !== 'string') refuse('CORRUPT_STATE', 'ownership state has an invalid envelope');
  if (raw.integrity.digest !== digest(stable(raw.payload))) refuse('CORRUPT_STATE', 'ownership state integrity evidence does not match its payload');
  const state = raw.payload;
  if (state.schema !== SCHEMA || state.version !== 1 || state.repository_id !== identity.repository_id
      || state.common_dir !== identity.common_dir || !Number.isInteger(state.next_epoch) || state.next_epoch < 1
      || !object(state.scopes)) refuse('CORRUPT_STATE', 'ownership state identity or epoch is invalid');
  for (const [scopeId, scope] of Object.entries(state.scopes)) validateStoredScope(scopeId, scope);
  return state;
}

function writeEnvelope(store, state) {
  const file = stateFile(store);
  const payload = clone(state);
  const raw = { format: ENVELOPE, payload, integrity: { algorithm: 'sha256', digest: digest(stable(payload)) } };
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(raw)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* best effort */ } }
    try { fs.unlinkSync(temp); } catch (_) { /* renamed or absent */ }
  }
}

function normalizeScope(input = {}) {
  const source = object(input.scope) ? input.scope : input;
  const phase = source.phase === undefined || source.phase === null ? null : safeId(String(source.phase), 'phase');
  const rawTickets = source.tickets === undefined ? [] : Array.isArray(source.tickets) ? source.tickets : [source.tickets];
  const tickets = [...new Set(rawTickets.map((ticket) => safeId(String(ticket), 'ticket')))];
  if (!phase && !tickets.length && source.scopeId === undefined && source.scope_id === undefined) refuse('INVALID_SCOPE', 'handoff scope needs a phase or at least one ticket');
  const explicit = source.scopeId || source.scope_id;
  const scopeId = explicit === undefined ? `phase=${phase || '*'};tickets=${tickets.slice().sort().join(',') || '*'}` : safeId(String(explicit), 'scope_id');
  return { scope_id: scopeId, phase, tickets: tickets.slice().sort() };
}

function overlaps(left, right) {
  if (left.phase && right.phase && left.phase !== right.phase) return false;
  if (left.phase && !left.tickets.length && (!right.phase || right.phase === left.phase)) return true;
  if (right.phase && !right.tickets.length && (!left.phase || left.phase === right.phase)) return true;
  if (left.tickets.length && right.tickets.length) return left.tickets.some((ticket) => right.tickets.includes(ticket));
  if (left.scope_id === right.scope_id) return true;
  return Boolean(left.phase && right.phase && left.phase === right.phase);
}

function validateStoredScope(scopeId, scope) {
  if (!object(scope) || !object(scope.scope) || scope.scope.scope_id !== scopeId
      || !['active', 'checkpointed', 'acknowledged', 'cancelled'].includes(scope.status)
      || !Number.isInteger(scope.epoch) || scope.epoch < 1 || !Array.isArray(scope.candidates)
      || !Array.isArray(scope.history)) refuse('CORRUPT_STATE', `ownership scope ${scopeId} is malformed`);
  if (scope.owner !== null && !object(scope.owner)) refuse('CORRUPT_STATE', `ownership scope ${scopeId} has an invalid owner`);
  if (scope.pending_launch !== null && !object(scope.pending_launch)) refuse('CORRUPT_STATE', `ownership scope ${scopeId} has an invalid launch reservation`);
  for (const candidate of scope.candidates) {
    if (!object(candidate) || typeof candidate.candidate_id !== 'string' || typeof candidate.run_id !== 'string' || typeof candidate.token_hash !== 'string') refuse('CORRUPT_STATE', `ownership scope ${scopeId} has an invalid successor candidate`);
  }
}

function publicScope(scope) { return { scope_id: scope.scope_id, phase: scope.phase, tickets: [...scope.tickets] }; }

function publicOwner(owner) {
  if (!owner) return null;
  return { run_id: owner.run_id, session_id: owner.session_id, epoch: owner.epoch, runtime: owner.runtime || null, status: owner.status, started_at: owner.started_at, acknowledged_at: owner.acknowledged_at || null, worktree: owner.worktree || null };
}

function publicCheckpoint(checkpoint) { return checkpoint ? clone(checkpoint) : null; }

function publicLaunch(launch) {
  if (!launch) return null;
  return { reservation_id: launch.reservation_id, dispatch_id: launch.dispatch_id, run_id: launch.run_id, epoch: launch.epoch, state: launch.state, started_at: launch.started_at || null, reason: launch.reason || null };
}

function publicScopeState(scope) {
  return { scope: publicScope(scope.scope), status: scope.status, epoch: scope.epoch, owner: publicOwner(scope.owner), candidates: scope.candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, run_id: candidate.run_id, session_id: candidate.session_id, epoch: candidate.epoch, status: candidate.status, created_at: candidate.created_at })), checkpoint: publicCheckpoint(scope.checkpoint), pending_launch: publicLaunch(scope.pending_launch), history: scope.history.map((entry) => clone(entry)) };
}

function publicCapability(data, capability) {
  const result = { kind: data.kind, repository_id: data.repository_id, scope_id: data.scope_id, run_id: data.run_id, session_id: data.session_id, epoch: data.epoch, status: data.status, phase: data.phase, tickets: [...data.tickets] };
  if (data.candidate_id !== undefined) result.candidate_id = data.candidate_id;
  Object.defineProperty(result, 'token', { value: data.token, enumerable: false, writable: false });
  Object.defineProperty(result, 'controller', { value: data.controller, enumerable: false, writable: false });
  Object.defineProperty(result, 'capability', { value: capability, enumerable: false, writable: false });
  return Object.freeze(result);
}

function publicState(state, scopeId) {
  return { schema: state.schema, version: state.version, repository_id: state.repository_id, common_dir: state.common_dir, next_epoch: state.next_epoch, scopes: Object.values(state.scopes).filter((scope) => scopeId === undefined || scope.scope.scope_id === scopeId).map(publicScopeState) };
}

function containsForbiddenKey(key) {
  return /(?:password|secret|credential|api[_-]?key|authorization|cookie|prompt|transcript|messages?|body|raw_content|access_token|refresh_token)/i.test(key);
}

function validateMetadata(value, pathName = 'checkpoint') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) refuse('INVALID_CHECKPOINT', `${pathName} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => validateMetadata(item, `${pathName}[${index}]`)); return; }
  if (!object(value)) refuse('INVALID_CHECKPOINT', `${pathName} must be JSON metadata`);
  for (const [key, child] of Object.entries(value)) {
    if (containsForbiddenKey(key)) refuse('INVALID_CHECKPOINT', `${pathName}.${key} cannot be stored in a checkpoint`);
    validateMetadata(child, `${pathName}.${key}`);
  }
}

function makeCheckpoint(identity, owner, scope, payload, timestamp) {
  const body = object(payload) ? clone(payload) : {};
  validateMetadata(body);
  if (body.plan_digests === undefined && body.plan_digest !== undefined) body.plan_digests = { plan: body.plan_digest };
  if (body.adr_digests === undefined && body.adr_digest !== undefined) body.adr_digests = { adr: body.adr_digest };
  if (body.policy_digests === undefined && body.policy_digest !== undefined) body.policy_digests = { policy: body.policy_digest };
  if (body.predecessor === undefined) body.predecessor = { run_id: owner.run_id, epoch: owner.epoch };
  if (body.pending_wait_ids === undefined) body.pending_wait_ids = [];
  if (body.pending_action_ids === undefined) body.pending_action_ids = [];
  if (body.dispatch_reservations === undefined) body.dispatch_reservations = [];
  if (body.dispatch_receipts === undefined) body.dispatch_receipts = [];
  const required = ['plan_digests', 'adr_digests', 'policy_digests', 'head', 'base', 'worktrees',
    'current_snapshot', 'pending_wait_ids', 'pending_action_ids', 'dispatch_reservations',
    'dispatch_receipts', 'artifact_refs', 'treatment', 'budgets', 'next_action'];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) refuse('INVALID_CHECKPOINT', `checkpoint must include ${field}`);
  }
  for (const field of ['plan_digests', 'adr_digests', 'policy_digests', 'current_snapshot', 'treatment', 'budgets']) {
    if (!object(body[field])) refuse('INVALID_CHECKPOINT', `${field} must be an object of bounded metadata`);
  }
  for (const field of ['plan_digests', 'adr_digests', 'policy_digests']) {
    for (const [name, value] of Object.entries(body[field])) safeDigest(value, `${field}.${name}`);
  }
  for (const field of ['pending_wait_ids', 'pending_action_ids', 'dispatch_reservations', 'dispatch_receipts', 'artifact_refs', 'worktrees']) {
    if (!Array.isArray(body[field])) refuse('INVALID_CHECKPOINT', `${field} must be an array`);
  }
  const checkpoint = { schema: 'shipyard.session-checkpoint.v1', version: 1, repository_id: identity.repository_id, run_id: owner.run_id, session_id: owner.session_id, expected_epoch: owner.epoch, scope: publicScope(scope), created_at: timestamp, ...body };
  if (checkpoint.schema !== 'shipyard.session-checkpoint.v1' || checkpoint.version !== 1
      || checkpoint.repository_id !== identity.repository_id || checkpoint.run_id !== owner.run_id
      || checkpoint.session_id !== owner.session_id || checkpoint.expected_epoch !== owner.epoch
      || !object(checkpoint.scope) || stable(checkpoint.scope) !== stable(publicScope(scope))) {
    refuse('INVALID_CHECKPOINT', 'checkpoint identity does not match the acknowledged owner');
  }
  for (const field of ['head', 'base', 'source_revision', 'snapshot_digest', 'plan_digest', 'policy_digest']) if (checkpoint[field] !== undefined && checkpoint[field] !== null) safeDigest(checkpoint[field], field);
  if (checkpoint.worktrees !== undefined && !Array.isArray(checkpoint.worktrees)) refuse('INVALID_CHECKPOINT', 'worktrees must be an array of references');
  if (checkpoint.dispatch_reservations !== undefined && !Array.isArray(checkpoint.dispatch_reservations)) refuse('INVALID_CHECKPOINT', 'dispatch_reservations must be an array');
  if (checkpoint.artifact_refs !== undefined && !Array.isArray(checkpoint.artifact_refs)) refuse('INVALID_CHECKPOINT', 'artifact_refs must be an array');
  if (typeof checkpoint.next_action !== 'string' || !checkpoint.next_action.trim()) refuse('INVALID_CHECKPOINT', 'checkpoint must name its exact next_action');
  return checkpoint;
}

function validatePinnedReferences(checkpoint) {
  const roots = checkpoint.worktrees
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => {
      try { return fs.realpathSync(entry); }
      catch (error) { refuse('MISSING_REFERENCE', `checkpoint worktree is unavailable: ${error.message}`); }
    });
  for (const reference of checkpoint.artifact_refs) {
    if (!object(reference) || typeof reference.path !== 'string' || !reference.path.trim()) {
      refuse('INVALID_CHECKPOINT', 'artifact references need a path');
    }
    const raw = path.resolve(reference.root || roots[0] || process.cwd(), reference.path);
    let real;
    try { real = fs.realpathSync(raw); }
    catch (error) { refuse('MISSING_REFERENCE', `checkpoint artifact reference is unavailable: ${error.message}`); }
    if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
      refuse('PATH_ESCAPE', 'checkpoint artifact reference escapes its owned worktree');
    }
    if (reference.digest !== undefined) {
      safeDigest(reference.digest, `artifact_refs.${reference.path}.digest`);
      let actual;
      try { actual = crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'); }
      catch (error) { refuse('MISSING_REFERENCE', `checkpoint artifact reference cannot be read: ${error.message}`); }
      if (actual !== reference.digest) refuse('STALE_REFERENCE', `checkpoint artifact reference changed: ${reference.path}`);
    }
  }
  return true;
}

function assertRevalidation(result, checkpoint) {
  if (!object(result) || result.valid !== true) refuse('REVALIDATION_REQUIRED', 'successor revalidation must return explicit valid evidence');
  if (object(result)) {
    if (result.clean === false) refuse('DIRTY_WORK', 'successor revalidation found dirty owned work');
    if (result.children_unknown === true || result.unknown_children === true) refuse('ACTIVE_CHILD_UNKNOWN', 'successor child enumeration is unknown');
    if (Array.isArray(result.children) && result.children.length) refuse('ACTIVE_CHILDREN', 'successor revalidation found active children');
    if (result.active_child === true) refuse('ACTIVE_CHILDREN', 'successor revalidation found an active child');
    if (result.changed_head === true || result.changed_base === true || result.changed_pr_head === true) refuse('LIVE_STATE_STALE', 'successor live state changed after checkpoint');
    const liveHead = result.head === undefined || result.head === null ? result.pr_head : result.head;
    const liveBase = result.base === undefined || result.base === null ? result.base_ref : result.base;
    if (checkpoint && liveHead !== undefined && liveHead !== null
        && checkpoint.head !== undefined && checkpoint.head !== null && liveHead !== checkpoint.head) {
      refuse('LIVE_STATE_STALE', 'successor head differs from the checkpoint');
    }
    if (checkpoint && liveBase !== undefined && liveBase !== null
        && checkpoint.base !== undefined && checkpoint.base !== null && liveBase !== checkpoint.base) {
      refuse('LIVE_STATE_STALE', 'successor base differs from the checkpoint');
    }
  }
  return clone(result);
}

function makeCapability(controller, data) {
  const capability = {};
  const stored = Object.freeze({ ...data, controller });
  const view = publicCapability({ ...data, controller }, capability);
  CAPABILITIES.add(capability);
  CAPABILITIES.add(view);
  CAPABILITY_DATA.set(capability, stored);
  CAPABILITY_DATA.set(view, stored);
  return view;
}

function capabilityData(controller, value) {
  if (!CAPABILITIES.has(value)) refuse('INVALID_HANDOFF', 'dispatch needs the host-held session capability, not serialized JSON');
  const data = CAPABILITY_DATA.get(value);
  if (!data || data.controller !== controller) refuse('INVALID_HANDOFF', 'session capability belongs to another handoff controller');
  return data;
}

function tokenData(controller, input, kind) {
  if (CAPABILITIES.has(input)) return capabilityData(controller, input);
  if (!object(input)) refuse('INVALID_HANDOFF', 'a host-held capability is required');
  const token = input.token;
  if (typeof token !== 'string' || !token) refuse('INVALID_HANDOFF', 'serialized handoff data cannot authorize a launch');
  const state = readEnvelope(controller.store, controller.identity);
  const scopeId = input.scope_id || input.scopeId;
  const scope = state.scopes[scopeId];
  if (!scope) refuse('HANDOFF_LOST', 'handoff scope no longer exists');
  const target = kind === 'candidate' ? scope.candidates.find((candidate) => candidate.candidate_id === (input.candidate_id || input.candidateId)) : scope.owner;
  if (!target) refuse('HANDOFF_LOST', 'handoff candidate or owner no longer exists');
  if (target.token_hash !== digest(token)) refuse('INVALID_HANDOFF', 'handoff token does not match the durable owner record');
  return { kind, token, controller, repository_id: controller.identity.repository_id, scope_id: scope.scope.scope_id, run_id: target.run_id, session_id: target.session_id, epoch: target.epoch, phase: scope.scope.phase, tickets: [...scope.scope.tickets], candidate_id: target.candidate_id, status: target.status };
}

function createSessionHandoff(options = {}) {
  if (!object(options)) refuse('INVALID_INPUT', 'handoff options must be an object');
  const identity = options.identity || resolveRepositoryIdentity(options.cwd || process.cwd());
  const store = path.resolve(options.storeDir || ownershipStorePath(identity));
  const clock = options.clock || (() => Date.now());
  const controller = {};
  const data = { identity, store, clock, controller };
  CONTROLLERS.add(controller); CONTROLLER_DATA.set(controller, data);

  function read(scopeId) {
    const state = readEnvelope(store, identity);
    return scopeId === undefined ? state : state.scopes[scopeId] || null;
  }
  function mutate(fn) {
    return withLock(store, () => { const state = readEnvelope(store, identity); const result = fn(state); writeEnvelope(store, state); return result; });
  }
  function findScope(state, requested) {
    const scope = normalizeScope(requested);
    const exact = state.scopes[scope.scope_id];
    if (exact) return { requested: scope, record: exact };
    const overlapping = Object.values(state.scopes).find((candidate) => candidate.status !== 'cancelled' && overlaps(candidate.scope, scope));
    return { requested: scope, record: overlapping || null };
  }
  function currentOwner(capability, allowCheckpointed = false) {
    const capabilityValue = capability && capability.capability ? capability.capability : capability;
    const owner = capabilityData(controller, capabilityValue);
    if (owner.kind !== 'owner') refuse('INVALID_HANDOFF', 'an acknowledged owner capability is required');
    const state = readEnvelope(store, identity);
    const scope = state.scopes[owner.scope_id];
    if (!scope || !scope.owner || scope.owner.token_hash !== digest(owner.token) || scope.owner.run_id !== owner.run_id || scope.owner.epoch !== owner.epoch) refuse('SESSION_FENCED', 'session no longer owns this delivery scope');
    if (scope.pending_launch && scope.pending_launch.state === 'ambiguous') refuse('AMBIGUOUS_LAUNCH', 'an external launch has no complete durable receipt and must be reconciled');
    if (!allowCheckpointed && (scope.status === 'checkpointed' || scope.owner.status === 'checkpointed')) refuse('SESSION_CHECKPOINTED', 'predecessor is checkpointed and cannot dispatch');
    if (!['active', 'acknowledged'].includes(scope.status) || !['active', 'acknowledged'].includes(scope.owner.status)) refuse('SESSION_FENCED', 'session owner is not active');
    return { state, scope, owner };
  }
  function requireCandidate(value) {
    const candidateValue = value && value.capability ? value.capability : value;
    const candidate = capabilityData(controller, candidateValue);
    if (candidate.kind !== 'candidate') refuse('INVALID_HANDOFF', 'a preparing successor capability is required');
    const state = readEnvelope(store, identity);
    const scope = state.scopes[candidate.scope_id];
    const stored = scope && scope.candidates.find((entry) => entry.candidate_id === candidate.candidate_id);
    if (!stored || stored.token_hash !== digest(candidate.token) || stored.run_id !== candidate.run_id) refuse('HANDOFF_LOST', 'successor candidate is no longer pending acknowledgement');
    return { state, scope, candidate, stored };
  }

  controller.identity = Object.freeze({ ...identity });
  controller.store = store;
  controller.status = function status(scope) {
    const scopeId = typeof scope === 'string' ? scope : scope && (scope.scope_id || scope.scopeId);
    const state = read(scopeId);
    return scopeId && !state ? null : publicState(state, scopeId);
  };
  controller.inspect = controller.status;

  controller.begin = function begin(input = {}) {
    const scope = normalizeScope(input);
    const runId = safeId(input.runId || input.run_id || randomId('run'), 'run_id');
    const sessionId = safeId(input.sessionId || input.session_id || randomId('session'), 'session_id');
    const runtime = input.runtime === undefined ? null : safeId(String(input.runtime), 'runtime');
    const timestamp = nowIso(clock);
    let capability;
    return mutate((state) => {
      for (const existing of Object.values(state.scopes)) {
        if (existing.status === 'cancelled' || !overlaps(existing.scope, scope)) continue;
        refuse('ACTIVE_SCOPE', `delivery scope overlaps active owner ${existing.owner && existing.owner.run_id || 'unknown'}`);
      }
      const epoch = state.next_epoch++;
      const token = randomId('owner');
      const scopeRecord = { scope: { ...scope }, status: 'acknowledged', epoch, owner: { run_id: runId, session_id: sessionId, epoch, token_hash: digest(token), runtime, status: 'acknowledged', started_at: timestamp, acknowledged_at: timestamp, worktree: input.worktree || identity.worktree }, candidates: [], checkpoint: null, pending_launch: null, history: [{ event: 'begin', run_id: runId, session_id: sessionId, epoch, at: timestamp }] };
      state.scopes[scope.scope_id] = scopeRecord;
      capability = makeCapability(controller, { kind: 'owner', repository_id: identity.repository_id, scope_id: scope.scope_id, run_id: runId, session_id: sessionId, epoch, status: 'acknowledged', phase: scope.phase, tickets: scope.tickets, token });
      return capability;
    });
  };
  controller.attach = function attach(input = {}, kind = 'owner') { return makeCapability(controller, tokenData(controller, input, kind)); };
  controller.assertOwner = function assertOwner(capability) { currentOwner(capability); return true; };
  controller.guardUnbound = function guardUnbound(input = {}) {
    const state = read();
    const active = Object.values(state.scopes).filter((scope) => scope.status !== 'cancelled');
    if (!active.length) return true;
    const hasScope = object(input) && (input.phase !== undefined || input.tickets !== undefined
      || input.scope_id !== undefined || input.scopeId !== undefined);
    if (!hasScope) refuse('SESSION_FENCED', 'an existing delivery owner requires a host-held session capability');
    const requested = normalizeScope(input);
    const conflict = active.find((scope) => overlaps(scope.scope, requested));
    if (conflict) refuse('SESSION_FENCED', `delivery scope is owned by ${conflict.owner && conflict.owner.run_id || 'another session'}`);
    return true;
  };
  controller.assertUnbound = controller.guardUnbound;

  controller.checkpoint = function checkpoint(capability, payload = {}) {
    const current = currentOwner(capability);
    const timestamp = nowIso(clock);
    const value = makeCheckpoint(identity, current.owner, current.scope.scope, payload, timestamp);
    if (current.scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'cannot checkpoint while a launch reservation is unresolved');
    return mutate((state) => {
      const scope = state.scopes[current.owner.scope_id];
      if (!scope || scope.owner.token_hash !== digest(current.owner.token)) refuse('SESSION_FENCED', 'owner changed before checkpoint');
      scope.status = 'checkpointed'; scope.owner.status = 'checkpointed'; scope.checkpoint = value;
      scope.history.push({ event: 'checkpoint', run_id: current.owner.run_id, epoch: current.owner.epoch, at: timestamp });
      return publicScopeState(scope);
    });
  };

  controller.resume = function resume(input = {}) {
    const found = findScope(read(), input);
    if (!found.record || found.record.status !== 'checkpointed' || !found.record.checkpoint) refuse('NO_CHECKPOINT', 'no checkpoint is available for this delivery scope');
    if (found.record.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'unresolved launch must be reconciled before takeover');
    validatePinnedReferences(found.record.checkpoint);
    const runId = safeId(input.runId || input.run_id || randomId('run'), 'run_id');
    const sessionId = safeId(input.sessionId || input.session_id || randomId('session'), 'session_id');
    const runtime = input.runtime === undefined ? found.record.owner && found.record.owner.runtime : safeId(String(input.runtime), 'runtime');
    const timestamp = nowIso(clock);
    let capability;
    return mutate((state) => {
      const scope = state.scopes[found.record.scope.scope_id];
      if (!scope || scope.status !== 'checkpointed' || scope.pending_launch) refuse(scope && scope.pending_launch ? 'AMBIGUOUS_LAUNCH' : 'HANDOFF_LOST', 'checkpoint changed before successor registration');
      const candidateId = randomId('candidate'); const token = randomId('successor');
      const stored = { candidate_id: candidateId, run_id: runId, session_id: sessionId, epoch: scope.epoch, token_hash: digest(token), runtime, status: 'preparing', created_at: timestamp };
      scope.candidates.push(stored); scope.history.push({ event: 'resume', candidate_id: candidateId, run_id: runId, epoch: scope.epoch, at: timestamp });
      capability = makeCapability(controller, { kind: 'candidate', repository_id: identity.repository_id, scope_id: scope.scope.scope_id, run_id: runId, session_id: sessionId, epoch: scope.epoch, status: 'preparing', phase: scope.scope.phase, tickets: scope.scope.tickets, candidate_id: candidateId, token });
      return capability;
    });
  };

  controller.acknowledge = function acknowledge(candidateValue, optionsForAck = {}) {
    const candidate = requireCandidate(candidateValue);
    if (candidate.scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'unresolved launch must be reconciled before acknowledgement');
    if (typeof optionsForAck.revalidate !== 'function') refuse('REVALIDATION_REQUIRED', 'successor must revalidate live head, worktree, reviews, checks and children before acknowledgement');
    validatePinnedReferences(candidate.scope.checkpoint);
    let evidence;
    try { evidence = assertRevalidation(optionsForAck.revalidate(publicScopeState(candidate.scope)), candidate.scope.checkpoint); }
    catch (error) { if (error && error.code) throw error; refuse('LIVE_STATE_STALE', `successor revalidation failed: ${error.message}`); }
    const timestamp = nowIso(clock);
    let capability;
    return mutate((state) => {
      const scope = state.scopes[candidate.scope.scope.scope_id];
      const stored = scope && scope.candidates.find((entry) => entry.candidate_id === candidate.candidate.candidate_id);
      if (!scope || !stored || stored.token_hash !== digest(candidate.candidate.token) || scope.status !== 'checkpointed' || scope.pending_launch) {
        if (scope && scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'unresolved launch appeared before acknowledgement');
        refuse('HANDOFF_LOST', 'successor lost the compare-and-swap acknowledgement');
      }
      const prior = scope.owner; const epoch = state.next_epoch++; const token = candidate.candidate.token;
      scope.owner = { run_id: candidate.candidate.run_id, session_id: candidate.candidate.session_id, epoch, token_hash: digest(token), runtime: candidate.candidate.runtime, status: 'acknowledged', started_at: candidate.candidate.created_at, acknowledged_at: timestamp, worktree: identity.worktree };
      scope.epoch = epoch; scope.status = 'acknowledged'; scope.candidates = [];
      scope.checkpoint = { ...scope.checkpoint, successor_revalidation: evidence, acknowledged_at: timestamp, expected_epoch: epoch };
      scope.history.push({ event: 'acknowledge', predecessor_run_id: prior && prior.run_id, run_id: candidate.candidate.run_id, epoch, at: timestamp });
      capability = makeCapability(controller, { kind: 'owner', repository_id: identity.repository_id, scope_id: scope.scope.scope_id, run_id: candidate.candidate.run_id, session_id: candidate.candidate.session_id, epoch, status: 'acknowledged', phase: scope.scope.phase, tickets: scope.scope.tickets, token });
      return capability;
    });
  };
  controller.cancelBeforeAck = function cancelBeforeAck(candidateValue) {
    const candidate = requireCandidate(candidateValue); const timestamp = nowIso(clock);
    return mutate((state) => {
      const scope = state.scopes[candidate.scope.scope.scope_id];
      if (!scope || scope.status !== 'checkpointed') refuse('HANDOFF_LOST', 'successor cannot be cancelled after ownership changed');
      if (scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'unresolved launch cannot be cancelled as a clean handoff');
      const before = scope.candidates.length; scope.candidates = scope.candidates.filter((entry) => entry.candidate_id !== candidate.candidate.candidate_id);
      if (before === scope.candidates.length) refuse('HANDOFF_LOST', 'successor candidate is no longer pending');
      scope.history.push({ event: 'cancel-before-ack', candidate_id: candidate.candidate.candidate_id, at: timestamp }); return publicScopeState(scope);
    });
  };
  controller.cancel_before_ack = controller.cancelBeforeAck;

  function reservationData(value) {
    if (!object(value) || !value.reservation_id || typeof value.token !== 'string') refuse('INVALID_HANDOFF', 'launch reservation is host-held and cannot be forged');
    const state = readEnvelope(store, identity); const scope = state.scopes[value.scope_id]; const launch = scope && scope.pending_launch;
    if (!launch || launch.reservation_id !== value.reservation_id || launch.token_hash !== digest(value.token)) refuse('SESSION_FENCED', 'launch reservation is no longer current');
    return { state, scope, launch };
  }
  controller.reserveLaunch = function reserveLaunch(capability, meta = {}) {
    const current = currentOwner(capability);
    if (!object(meta) || typeof meta.dispatch_id !== 'string' || !meta.dispatch_id.trim()) refuse('INVALID_INPUT', 'launch reservation needs a dispatch_id');
    if (current.scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'another launch is already reserved for this scope');
    const reservationId = randomId('reservation'); const token = randomId('launch'); const timestamp = nowIso(clock); let output;
    mutate((state) => {
      const scope = state.scopes[current.owner.scope_id];
      if (!scope || !scope.owner || scope.owner.token_hash !== digest(current.owner.token) || scope.owner.epoch !== current.owner.epoch || scope.status !== 'acknowledged') refuse('SESSION_FENCED', 'owner changed before launch reservation');
      if (scope.pending_launch) refuse('AMBIGUOUS_LAUNCH', 'another launch is already reserved for this scope');
      scope.pending_launch = { reservation_id: reservationId, token_hash: digest(token), dispatch_id: meta.dispatch_id, run_id: current.owner.run_id, epoch: current.owner.epoch, state: 'reserved', reserved_at: timestamp, role: meta.role || null, runtime: meta.runtime || current.owner.runtime || null };
      scope.history.push({ event: 'reserve-launch', reservation_id: reservationId, dispatch_id: meta.dispatch_id, epoch: current.owner.epoch, at: timestamp });
      output = { reservation_id: reservationId, scope_id: scope.scope.scope_id, dispatch_id: meta.dispatch_id, run_id: current.owner.run_id, epoch: current.owner.epoch, token };
    });
    Object.defineProperty(output, 'token', { value: token, enumerable: false, writable: false }); return Object.freeze(output);
  };
  controller.markLaunchStarted = function markLaunchStarted(reservation) {
    const current = reservationData(reservation); if (current.launch.state !== 'reserved') refuse('AMBIGUOUS_LAUNCH', 'launch reservation is already started or unresolved'); const timestamp = nowIso(clock);
    mutate((state) => { const scope = state.scopes[reservation.scope_id]; if (!scope || !scope.pending_launch || scope.pending_launch.reservation_id !== reservation.reservation_id) refuse('SESSION_FENCED', 'launch reservation changed before start'); scope.pending_launch.state = 'started'; scope.pending_launch.started_at = timestamp; }); return true;
  };
  controller.completeLaunch = function completeLaunch(reservation, outcome = {}) {
    const current = reservationData(reservation); const timestamp = nowIso(clock); const recorded = outcome === true || (object(outcome) && outcome.recorded === true);
    if (recorded && current.launch.state !== 'started' && current.launch.state !== 'reserved') refuse('AMBIGUOUS_LAUNCH', 'launch cannot be completed from its current state');
    mutate((state) => { const scope = state.scopes[reservation.scope_id]; if (!scope || !scope.pending_launch || scope.pending_launch.reservation_id !== reservation.reservation_id) refuse('SESSION_FENCED', 'launch reservation changed before completion'); if (recorded) { scope.history.push({ event: 'complete-launch', reservation_id: reservation.reservation_id, dispatch_id: scope.pending_launch.dispatch_id, at: timestamp }); scope.pending_launch = null; } else { scope.pending_launch.state = 'ambiguous'; scope.pending_launch.reason = object(outcome) && outcome.reason ? String(outcome.reason) : 'launch outcome is unknown'; scope.pending_launch.ambiguous_at = timestamp; scope.history.push({ event: 'ambiguous-launch', reservation_id: reservation.reservation_id, dispatch_id: scope.pending_launch.dispatch_id, at: timestamp }); } }); return recorded;
  };
  controller.abortLaunch = function abortLaunch(reservation, reason = 'launch did not start') {
    const current = reservationData(reservation); if (current.launch.state !== 'reserved') return controller.completeLaunch(reservation, { recorded: false, reason }); return controller.completeLaunch(reservation, { recorded: true, aborted: true });
  };
  controller.markAmbiguousLaunch = function markAmbiguousLaunch(capability, meta = {}) {
    const current = capabilityData(controller, capability && capability.capability ? capability.capability : capability); const state = readEnvelope(store, identity); const scope = state.scopes[current.scope_id]; if (!scope) refuse('HANDOFF_LOST', 'handoff scope no longer exists'); if (current.kind === 'owner') currentOwner(capability, true);
    if (!scope.pending_launch) {
      const reservationId = randomId('reservation'); const token = randomId('launch'); const timestamp = nowIso(clock);
      mutate((next) => { const target = next.scopes[current.scope_id]; target.pending_launch = { reservation_id: reservationId, token_hash: digest(token), dispatch_id: meta.dispatchId || meta.dispatch_id || randomId('dispatch'), run_id: current.run_id, epoch: current.epoch, state: 'ambiguous', reserved_at: timestamp, ambiguous_at: timestamp, reason: meta.reason || 'external launch outcome is unknown' }; });
      return publicLaunch({ reservation_id: reservationId, dispatch_id: meta.dispatchId || meta.dispatch_id, run_id: current.run_id, epoch: current.epoch, state: 'ambiguous', reason: meta.reason });
    }
    mutate((next) => { const target = next.scopes[current.scope_id]; target.pending_launch.state = 'ambiguous'; target.pending_launch.reason = meta.reason || target.pending_launch.reason || 'external launch outcome is unknown'; target.pending_launch.ambiguous_at = nowIso(clock); }); return true;
  };
  controller.reconcileLaunch = function reconcileLaunch(capability, evidence = {}) {
    currentOwner(capability, true); if (!object(evidence) || evidence.confirmed !== true) refuse('RECONCILIATION_REQUIRED', 'ambiguous launch needs explicit external reconciliation evidence'); const state = readEnvelope(store, identity); const scope = state.scopes[capability.scope_id]; if (!scope || !scope.pending_launch || scope.pending_launch.state !== 'ambiguous') refuse('NO_AMBIGUOUS_LAUNCH', 'no ambiguous launch is awaiting reconciliation'); const timestamp = nowIso(clock);
    mutate((next) => { const target = next.scopes[capability.scope_id]; target.history.push({ event: 'reconcile-launch', dispatch_id: target.pending_launch.dispatch_id, evidence: { reference: evidence.reference || null }, at: timestamp }); target.pending_launch = null; }); return true;
  };
  controller.capability = function capability() { return null; };
  return Object.freeze(controller);
}

const createSessionHandoffController = createSessionHandoff;
const createHandoffController = createSessionHandoff;

function isOwnerCapability(value) { return CAPABILITIES.has(value) && CAPABILITY_DATA.get(value).kind === 'owner'; }
function isSessionCapability(value) { return CAPABILITIES.has(value); }
function isSessionHandoff(value) { return CONTROLLERS.has(value); }
function capabilityForBoundary(value) {
  if (isOwnerCapability(value)) return value;
  if (object(value) && isOwnerCapability(value.capability)) return value.capability;
  refuse('INVALID_HANDOFF', 'dispatch boundary requires an acknowledged host-held owner capability');
}

function withSessionHandoff(value, fn) {
  if (typeof fn !== 'function') refuse('INVALID_INPUT', 'session handoff context needs a callback');
  const capability = capabilityForBoundary(value);
  capability.controller.assertOwner(capability);
  return HANDOFF_CONTEXT.run(capability, fn);
}

function currentSessionHandoff() {
  return HANDOFF_CONTEXT.getStore();
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]; if (!arg.startsWith('--')) { result._.push(arg); continue; }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) result[key] = true; else { result[key] = next; index++; }
  }
  return result;
}
function readJson(file, label) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { refuse('INVALID_INPUT', `${label} is not readable JSON: ${error.message}`); } }
function cliOutput(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); const command = args._[0];
  if (!['status', 'inspect', 'begin', 'checkpoint', 'resume', 'acknowledge', 'cancel-before-ack'].includes(command)) refuse('INVALID_INPUT', 'usage: session-handoff.cjs <status|inspect|begin|checkpoint|resume|acknowledge|cancel-before-ack> [options]');
  const handoff = createSessionHandoff({ cwd: args.cwd || process.cwd(), storeDir: args.storeDir });
  if (command === 'status' || command === 'inspect') return cliOutput(handoff.status(args.scopeId));
  const scope = { phase: args.phase, tickets: args.tickets ? String(args.tickets).split(',').filter(Boolean) : [], scopeId: args.scopeId };
  if (command === 'begin') { const value = handoff.begin({ ...scope, runId: args.runId, sessionId: args.sessionId, runtime: args.runtime, worktree: args.worktree }); return cliOutput({ ...value, token: value.token }); }
  if (command === 'resume') { const value = handoff.resume({ ...scope, runId: args.runId, sessionId: args.sessionId, runtime: args.runtime }); return cliOutput({ ...value, token: value.token }); }
  const attached = handoff.attach({ token: args.token, scope_id: args.scopeId, run_id: args.runId, candidate_id: args.candidateId }, command === 'acknowledge' || command === 'cancel-before-ack' ? 'candidate' : 'owner');
  if (command === 'checkpoint') return cliOutput(handoff.checkpoint(attached, args.checkpointFile ? readJson(args.checkpointFile, 'checkpoint file') : { next_action: args.nextAction || 'manual resume' }));
  if (command === 'acknowledge') { const validation = args.validationFile ? readJson(args.validationFile, 'validation file') : null; return cliOutput(handoff.acknowledge(attached, { revalidate: () => validation || { valid: true, clean: true, children: [] } })); }
  return cliOutput(handoff.cancelBeforeAck(attached));
}

module.exports = Object.freeze({ SCHEMA, resolveRepositoryIdentity, ownershipStorePath, createSessionHandoff, createSessionHandoffController, createHandoffController, isOwnerCapability, isSessionCapability, isSessionHandoff, capabilityForBoundary, withSessionHandoff, currentSessionHandoff, handoffError });

if (require.main === module) {
  try { runCli(); } catch (error) { process.stderr.write(`${error && error.message ? error.message : error}\n`); process.exitCode = 1; }
}
