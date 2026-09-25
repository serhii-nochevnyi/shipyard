#!/usr/bin/env node
'use strict';

// A launch packet is a bounded, immutable view of the work a child is allowed
// to reason about.  It is deliberately data-only: runtime selection,
// capabilities, callbacks, and receipts remain owned by the dispatch host.
// The builder reads complete required sources and the validator re-reads them
// before launch, so a JSON packet cannot smuggle stale or escaped content into
// a model turn.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inventory, sections } = require('./backlog-index.cjs');
const { recordMeasurement, ESTIMATOR_VERSION } = require('./orchestration-overhead.cjs');

const CONTEXT_PACKET_SCHEMA = 'shipyard.context-packet.v1';
const CONTEXT_PACKET_VERSION = 1;
const DEFAULT_TOKEN_CEILING = 12000;
const HASH = /^[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40}$/i;
const ROLE_REQUIRED_INPUTS = Object.freeze({
  executor: Object.freeze(['plan', 'scope', 'acceptance', 'verification', 'backlog']),
  'ci-fix': Object.freeze(['failure_evidence', 'prior_hypothesis']),
  'review-fix': Object.freeze(['failure_evidence', 'prior_hypothesis']),
  'drift-check': Object.freeze(['integration_base', 'plan']),
  'arch-review': Object.freeze(['adr_refs', 'exact_diff', 'integration_base']),
  integrator: Object.freeze(['phase_contracts', 'combined_diff']),
  research: Object.freeze(['problem_statement', 'source_refs']),
  decomposition: Object.freeze(['adr_refs', 'requirements', 'research_refs', 'context']),
  'pr-sentinel': Object.freeze(['pr_state', 'ci_review_observations']),
});

const AUTHORITY_KEYS = new Set([
  'model', 'effort', 'reasoning_effort', 'model_reasoning_effort',
  'capabilities', 'supportedModels', 'supportedEfforts', 'supportedSelections',
  'agent', 'agents', 'callback', 'callbacks', 'launch', 'launchOptions',
  'selection', 'resolution', 'receipt', 'applicationEvidence',
]);

class ContextPacketError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextPacketError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContextPacketError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function clone(value, label = 'value') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    fail('INVALID_CONTEXT_PACKET', `${label} must be JSON-serializable: ${error.message}`);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_CONTEXT_PACKET', `${label} must be non-empty text`);
  }
  return value;
}

function safeRelative(root, candidate, label, requireFile = true) {
  if (typeof candidate !== 'string' || candidate.trim() === '' || /[\u0000-\u001f\u007f]/.test(candidate)) {
    fail('INVALID_CONTEXT_SOURCE', `${label} must be a non-empty path`);
  }
  // Callers often retain the platform's logical spelling (for example
  // /var/... on macOS) while canonicalRoot uses realpath (/private/var/...).
  // Canonicalize the candidate before containment checks, but inspect the
  // caller spelling first so a directly supplied symlink is still refused.
  const lexical = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  try {
    if (fs.lstatSync(lexical).isSymbolicLink()) fail('SYMLINK_CONTEXT_SOURCE', `${label} is a symlink: ${candidate}`);
  } catch (error) {
    if (error instanceof ContextPacketError) throw error;
    if (error.code !== 'ENOENT' || requireFile) fail('MISSING_CONTEXT_SOURCE', `${label} does not exist: ${candidate}`);
  }
  let absolute;
  try { absolute = fs.realpathSync(lexical); }
  catch (error) {
    if (!requireFile && error.code === 'ENOENT') return lexical;
    fail('MISSING_CONTEXT_SOURCE', `${label} does not exist: ${candidate}`);
  }
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    fail('CONTEXT_PATH_ESCAPE', `${label} escapes the canonical project root`);
  }
  let current = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && !requireFile) break;
      fail('MISSING_CONTEXT_SOURCE', `${label} does not exist: ${candidate}`);
    }
    if (stat.isSymbolicLink()) fail('SYMLINK_CONTEXT_SOURCE', `${label} contains a symlink: ${candidate}`);
  }
  if (requireFile) {
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { fail('MISSING_CONTEXT_SOURCE', `${label} does not exist: ${candidate}`); }
    if (!stat.isFile()) fail('INVALID_CONTEXT_SOURCE', `${label} must be a regular file: ${candidate}`);
  }
  return absolute;
}

function canonicalRoot(value) {
  const candidate = text(value, 'root');
  const absolute = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { fail('MISSING_CONTEXT_SOURCE', `root does not exist: ${candidate}`); }
  if (!stat.isDirectory()) fail('INVALID_CONTEXT_SOURCE', 'root must be a directory');
  if (stat.isSymbolicLink()) fail('SYMLINK_CONTEXT_SOURCE', 'root may not be a symlink');
  try { return fs.realpathSync(absolute); }
  catch (error) { fail('INVALID_CONTEXT_SOURCE', `root cannot be canonicalized: ${error.message}`); }
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function sourceRef(root, input, label, required = true, includeContent = true) {
  const candidate = typeof input === 'string' ? input : input && input.path;
  const absolute = safeRelative(root, candidate, label, true);
  const content = fs.readFileSync(absolute);
  const digest = hash(content);
  const ref = {
    path: relativePath(root, absolute),
    bytes: content.length,
    content_bytes: content.length,
    sha256: digest,
    digest,
    required: required !== false,
  };
  if (includeContent) ref.content = content.toString('utf8');
  return ref;
}

function policySource(root, options) {
  const candidate = options.policy || options.requiredPolicy;
  const policyPath = options.policyPath || (object(candidate) && candidate.path);
  let content = object(candidate) && typeof candidate.content === 'string' ? candidate.content : null;
  if (policyPath !== undefined) {
    const absolute = safeRelative(root, policyPath, 'policy path', true);
    content = fs.readFileSync(absolute, 'utf8');
  }
  if (content === null && typeof candidate === 'string') content = candidate;
  if (content === null && object(candidate) && policyPath === undefined) content = stableJson(candidate);
  if (typeof content !== 'string') fail('MISSING_POLICY_CONTEXT', 'required policy content is missing');
  const policyHash = options.policyHash || hash(content);
  if (!HASH.test(policyHash)) fail('INVALID_CONTEXT_PACKET', 'policyHash must be a 64-character SHA-256 digest');
  if (hash(content) !== policyHash) fail('STALE_CONTEXT_PACKET', 'required policy content does not match policyHash');
  return {
    content,
    sha256: policyHash,
    digest: policyHash,
    ...(policyPath === undefined ? {} : { path: relativePath(root, safeRelative(root, policyPath, 'policy path', true)) }),
  };
}

function rejectAuthorityKeys(value, where = 'packet', seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('INVALID_CONTEXT_PACKET', `${where} contains a circular value`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(key)) fail('CONTEXT_PACKET_AUTHORITY', `${where}.${key} is host-owned launch authority`);
    rejectAuthorityKeys(child, `${where}.${key}`, seen);
  }
  seen.delete(value);
}

function sectionContent(root, item) {
  const separator = item.source.indexOf(':');
  if (separator < 0) fail('INVALID_BACKLOG_ITEM', `backlog item has no source qualifier: ${item.id}`);
  const rel = item.source.slice(separator + 1);
  const file = safeRelative(root, rel, `backlog source ${item.id}`, true);
  const raw = fs.readFileSync(file, 'utf8');
  if (hash(raw) !== item.source_hash) fail('STALE_CONTEXT_PACKET', `backlog source changed: ${item.id}`);
  const countBySignature = new Map();
  const matches = [];
  for (const section of sections(raw, path.basename(file, '.md'))) {
    const signature = hash(section.title).slice(0, 16);
    const count = (countBySignature.get(signature) || 0) + 1;
    countBySignature.set(signature, count);
    if (item.id.endsWith(`#${signature}:${count}`)) matches.push(section);
  }
  if (matches.length !== 1) fail('MISSING_BACKLOG_ITEM', `backlog section cannot be resolved: ${item.id}`);
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    source_hash: item.source_hash,
    status: item.status,
    prior_status: item.prior_status || null,
    verification_stale: Boolean(item.verification_stale),
    content: matches[0].lines.join('\n').trim(),
    ...(item.verification_stale ? { action: 'retriage' } : {}),
  };
}

function buildBacklog(root, options) {
  const manifest = options.backlogManifest === undefined ? null : options.backlogManifest;
  const index = inventory(root, manifest, '');
  const all = new Map(index.items.map((item) => [item.id, item]));
  const requested = options.selectedBacklogIds !== undefined
    ? options.selectedBacklogIds
    : options.backlog && options.backlog.selectedIds !== undefined
      ? options.backlog.selectedIds
      : index.items
        .filter((item) => !['verified_closed', 'deferred', 'superseded'].includes(item.status))
        .map((item) => item.id);
  if (!Array.isArray(requested)) fail('INVALID_BACKLOG_SELECTION', 'selectedBacklogIds must be an array');
  const selectedIds = [...requested];
  if (new Set(selectedIds).size !== selectedIds.length) fail('INVALID_BACKLOG_SELECTION', 'selected backlog ids must be unique');
  const why = options.backlogWhySelected || options.whySelected
    || options.backlog && options.backlog.whySelected;
  const whyFor = (id) => {
    if (typeof why === 'string' && why.trim()) return why;
    if (object(why) && typeof why[id] === 'string' && why[id].trim()) return why[id];
    return 'selected by the trusted caller for this launch';
  };
  const selected = selectedIds.map((id) => {
    if (typeof id !== 'string' || !id.trim()) fail('INVALID_BACKLOG_SELECTION', 'selected backlog ids must be non-empty strings');
    const item = all.get(id);
    if (!item) fail('MISSING_BACKLOG_ITEM', `selected backlog item is not in the current inventory: ${id}`);
    return { ...sectionContent(root, item), why_selected: whyFor(id) };
  });
  const inventoryScope = options.backlogInventory;
  if (inventoryScope !== undefined && inventoryScope !== 'all' && inventoryScope !== 'selected') {
    fail('INVALID_BACKLOG_SELECTION', `backlogInventory must be all or selected: ${inventoryScope}`);
  }
  const selectedIdSet = new Set(selectedIds);
  const inventoryItems = inventoryScope === 'selected'
    ? index.items.filter((item) => selectedIdSet.has(item.id))
    : index.items;
  const compactItems = inventoryItems.map((item) => ({
    id: item.id,
    source: item.source,
    title: item.title,
    source_hash: item.source_hash,
    status: item.status,
    prior_status: item.prior_status,
    verification_stale: Boolean(item.verification_stale),
    excerpt: item.excerpt,
    excerpt_truncated: Boolean(item.excerpt_truncated),
  }));
  return {
    inventory: {
      schema_version: index.schema_version,
      total_items: index.total_items,
      matched_items: inventoryScope === 'selected' ? selectedIds.length : index.matched_items,
      items: compactItems,
      orphaned_manifest_ids: index.orphaned_manifest_ids,
      ...(inventoryScope === 'selected' ? { scope: inventoryScope } : {}),
    },
    selected_ids: selectedIds,
    selected,
    selection_metadata: { why_selected: whyFor(selectedIds[0] || 'empty') },
    empty: selected.length === 0,
  };
}

function scopeValue(options) {
  const raw = options.immutableScope || options.scope || {};
  if (!object(raw)) fail('INVALID_CONTEXT_PACKET', 'scope must be an object');
  const scope = clone(raw, 'scope');
  if (options.filesModified !== undefined && scope.files_modified === undefined) scope.files_modified = clone(options.filesModified, 'filesModified');
  if (options.acceptance !== undefined && scope.acceptance === undefined) scope.acceptance = clone(options.acceptance, 'acceptance');
  if (options.verification !== undefined && scope.verification === undefined) scope.verification = clone(options.verification, 'verification');
  if (!Array.isArray(scope.files_modified)) fail('INVALID_CONTEXT_PACKET', 'scope.files_modified must be an array');
  for (const file of scope.files_modified) {
    if (typeof file !== 'string' || !file.trim() || path.isAbsolute(file)
        || file.split(/[\\/]+/).includes('..')) {
      fail('CONTEXT_PATH_ESCAPE', 'scope.files_modified must contain repository-relative paths');
    }
  }
  return scope;
}

function estimateTokens(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { fail('INVALID_CONTEXT_PACKET', `packet is not JSON-serializable: ${error.message}`); }
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
}

function packetWithoutAccounting(packet) {
  const copy = clone(packet, 'packet');
  delete copy.accounting;
  return copy;
}

function packetSourceRefs(packet) {
  const refs = [
    ...(packet.required_refs || []),
    ...(packet.optional_refs || []),
    ...((packet.backlog && packet.backlog.selected) || []),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    if (!ref) return false;
    const source = typeof ref.path === 'string' ? ref.path
      : typeof ref.source === 'string' && ref.source.includes(':') ? ref.source.slice(ref.source.indexOf(':') + 1) : null;
    if (!source || seen.has(source)) return false;
    seen.add(source);
    return true;
  }).map((ref) => {
    const source = typeof ref.path === 'string' ? ref.path : ref.source.slice(ref.source.indexOf(':') + 1);
    const bytes = ref.bytes === undefined && typeof ref.content === 'string'
      ? Buffer.byteLength(ref.content, 'utf8') : ref.bytes;
    return {
      path: source,
      sha256: ref.sha256 || ref.source_hash,
      ...(bytes === undefined ? {} : { bytes }),
    };
  });
}

function recordPacketMeasurement(packet, options) {
  const recorder = options.overheadRecorder || options.overhead && options.overhead.recorder;
  if (!recorder) return { recorded: false, skipped: 'no-recorder' };
  const runId = options.runId || options.run_id || `context:${packet.subject}`;
  const dispatchId = options.dispatchId || options.dispatch_id || null;
  const runtime = options.runtime || options.runtimeName || 'unknown';
  const treatment = options.treatment === undefined ? options.treatments : options.treatment;
  return recordMeasurement(recorder, {
    observation_id: options.measurementId || options.measurement_id
      || `context-startup:${runId}:${dispatchId || packet.subject}:${packet.source_revision}`,
    run_id: runId,
    dispatch_id: dispatchId,
    role: packet.role,
    runtime,
    backend: packet.accounting.backend,
    ...(options.policyId || options.policy_id ? { policy_id: options.policyId || options.policy_id } : {}),
    ...(options.policyVersion || options.policy_version ? { policy_version: options.policyVersion || options.policy_version } : {}),
    policy_hash: packet.policy_hash,
    treatment,
    stage: 'startup',
    source: 'context-packet',
    source_refs: packetSourceRefs(packet),
    bytes: packet.accounting.estimated_bytes,
    estimated_tokens: packet.accounting.estimated_tokens,
    estimator_version: ESTIMATOR_VERSION,
    provider_tokens: null,
    evidence: 'none',
    counts: { polls: null, model_turns: null, tool_calls: null },
  });
}

function buildContextPacket(options = {}) {
  if (!object(options)) fail('INVALID_CONTEXT_PACKET', 'builder options must be an object');
  const root = canonicalRoot(options.root || options.projectRoot || options.worktreePath);
  const role = text(options.role, 'role');
  const subject = text(options.subject || options.ticket || options.invId, 'subject');
  const sourceRevision = text(options.sourceRevision || options.source_revision, 'sourceRevision');
  if (!REVISION.test(sourceRevision)) fail('INVALID_CONTEXT_PACKET', 'sourceRevision must be a full 40-character Git object id');
  const policy = policySource(root, options);
  const scope = scopeValue(options);
  const acceptance = options.acceptance !== undefined ? clone(options.acceptance, 'acceptance') : scope.acceptance || [];
  const verification = options.verification !== undefined ? clone(options.verification, 'verification') : scope.verification || [];
  if (!Array.isArray(acceptance) || !Array.isArray(verification)) fail('INVALID_CONTEXT_PACKET', 'acceptance and verification must be arrays');
  const requiredRefs = [];
  const planPath = options.planPath || options.plan_path;
  if (planPath !== undefined) requiredRefs.push(sourceRef(root, planPath, 'planPath', true, true));
  for (const ref of options.requiredRefs || options.required_refs || []) {
    requiredRefs.push(sourceRef(root, ref, 'required reference', true, true));
  }
  const seenRefs = new Set();
  for (const ref of requiredRefs) {
    if (seenRefs.has(ref.path)) continue;
    seenRefs.add(ref.path);
  }
  // The plan is commonly supplied both as the named planPath and in a
  // caller's requiredRefs list. Keep one authenticated copy in the packet.
  const uniqueRequiredRefs = requiredRefs.filter((ref, index) => requiredRefs.findIndex((candidate) => candidate.path === ref.path) === index);
  const optionalRefs = [];
  for (const ref of options.optionalRefs || options.optional_refs || []) {
    const built = sourceRef(root, ref, 'optional reference', false, true);
    if (seenRefs.has(built.path)) fail('INVALID_CONTEXT_PACKET', `reference appears in both required and optional refs: ${built.path}`);
    seenRefs.add(built.path);
    optionalRefs.push(built);
  }
  const backlog = buildBacklog(root, options);
  const roleRequirements = ROLE_REQUIRED_INPUTS[role] || [];
  const suppliedRoleContext = options.roleContext === undefined ? options.role_context : options.roleContext;
  let roleContext = {};
  let roleContextComplete = false;
  if (suppliedRoleContext !== undefined) {
    if (!object(suppliedRoleContext)) fail('INVALID_CONTEXT_PACKET', 'roleContext must be an object');
    roleContext = clone(suppliedRoleContext, 'roleContext');
    const missing = roleRequirements.filter((key) => roleContext[key] === undefined || roleContext[key] === null);
    if (missing.length) fail('MISSING_ROLE_CONTEXT', `roleContext is missing required ${role} inputs: ${missing.join(', ')}`);
    roleContextComplete = true;
  }
  const packet = {
    schema: CONTEXT_PACKET_SCHEMA,
    version: CONTEXT_PACKET_VERSION,
    role,
    subject,
    canonical_root: root,
    source_revision: sourceRevision,
    policy_hash: policy.sha256,
    policy,
    immutable_scope: scope,
    acceptance,
    verification,
    required_refs: uniqueRequiredRefs,
    optional_refs: optionalRefs,
    role_requirements: roleRequirements,
    role_context: roleContext,
    role_context_complete: roleContextComplete,
    backlog,
  };
  rejectAuthorityKeys(packet);
  const requestedCeiling = options.tokenCeiling === undefined
    ? options.token_ceiling === undefined ? DEFAULT_TOKEN_CEILING : options.token_ceiling
    : options.tokenCeiling;
  if (!Number.isSafeInteger(requestedCeiling) || requestedCeiling < 1) fail('INVALID_CONTEXT_PACKET', 'tokenCeiling must be a positive integer');
  let estimate = estimateTokens(packetWithoutAccounting(packet));
  if (estimate > requestedCeiling && optionalRefs.length) {
    const completeOptional = optionalRefs.map((ref) => ({ ref, content: ref.content }));
    for (const ref of optionalRefs) {
      delete ref.content;
      ref.content_omitted = true;
      ref.content_ref = { path: ref.path, sha256: ref.sha256, bytes: ref.bytes };
    }
    const reducedEstimate = estimateTokens(packetWithoutAccounting(packet));
    if (reducedEstimate <= requestedCeiling) {
      // Do not claim an overflow when the indexed optional detail actually
      // brings the packet under the ceiling. Keep the complete source and
      // make the packet self-validating without a hidden omission.
      for (const { ref, content } of completeOptional) {
        ref.content = content;
        delete ref.content_omitted;
        delete ref.content_ref;
      }
      estimate = estimateTokens(packetWithoutAccounting(packet));
    } else {
      estimate = reducedEstimate;
    }
  }
  const backend = options.backend === undefined ? 'unspecified' : text(options.backend, 'backend');
  packet.accounting = {
    backend,
    estimated_tokens: estimate,
    estimated_bytes: Buffer.byteLength(JSON.stringify(packetWithoutAccounting(packet)), 'utf8'),
    soft_ceiling: requestedCeiling,
    overflow: estimate > requestedCeiling,
  };
  if (estimate > requestedCeiling) {
    packet.overflow = {
      reason: 'required context exceeds the backend soft ceiling; no required constraint was dropped',
      required_preserved: true,
      estimated_tokens: estimate,
      soft_ceiling: requestedCeiling,
      optional_references: optionalRefs.map((ref) => ({ path: ref.path, sha256: ref.sha256, bytes: ref.bytes })),
    };
    // The overflow record is itself part of the packet measured by the
    // validator. Recompute after adding it so the accounting cannot become a
    // stale self-hash-like claim.
    for (let attempt = 0; attempt < 4; attempt++) {
      const measured = estimateTokens(packetWithoutAccounting(packet));
      packet.overflow.estimated_tokens = measured;
      estimate = measured;
    }
    packet.accounting.estimated_tokens = estimate;
    packet.accounting.estimated_bytes = Buffer.byteLength(JSON.stringify(packetWithoutAccounting(packet)), 'utf8');
  }
  recordPacketMeasurement(packet, options);
  return packet;
}

function assertDigestRef(root, ref, label, allowOmitted = false) {
  if (!object(ref) || typeof ref.path !== 'string' || !HASH.test(ref.sha256 || '')
      || ref.sha256 !== ref.digest || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
      || ref.content_bytes !== ref.bytes) {
    fail('INVALID_CONTEXT_PACKET', `${label} is not an immutable source reference`);
  }
  const file = safeRelative(root, ref.path, label, true);
  const content = fs.readFileSync(file);
  const actual = hash(content);
  if (actual !== ref.sha256 || content.length !== ref.bytes) fail('STALE_CONTEXT_PACKET', `${label} changed after packet construction`);
  if (ref.content_omitted) {
    if (!allowOmitted || !object(ref.content_ref) || ref.content_ref.path !== ref.path || ref.content_ref.sha256 !== ref.sha256) {
      fail('INVALID_CONTEXT_PACKET', `${label} omits content without an explicit overflow reference`);
    }
  } else if (typeof ref.content !== 'string' || Buffer.byteLength(ref.content, 'utf8') !== ref.content_bytes || hash(Buffer.from(ref.content, 'utf8')) !== ref.sha256) {
    fail('STALE_CONTEXT_PACKET', `${label} does not carry its complete source content`);
  }
}

function validateContextPacket(packet, expected = {}) {
  if (!object(packet)) fail('INVALID_CONTEXT_PACKET', 'context packet must be an object');
  rejectAuthorityKeys(packet);
  if (packet.schema !== CONTEXT_PACKET_SCHEMA || packet.version !== CONTEXT_PACKET_VERSION) {
    fail('INVALID_CONTEXT_PACKET', 'unsupported context packet schema or version');
  }
  const root = canonicalRoot(packet.canonical_root);
  if (expected.root !== undefined && canonicalRoot(expected.root) !== root) fail('CONTEXT_PACKET_IDENTITY', 'packet root does not match the host worktree');
  if (expected.role !== undefined && packet.role !== expected.role) fail('CONTEXT_PACKET_IDENTITY', 'packet role does not match the resolved role');
  if (expected.subject !== undefined && packet.subject !== expected.subject) fail('CONTEXT_PACKET_IDENTITY', 'packet subject does not match the launch subject');
  if (expected.sourceRevision !== undefined && packet.source_revision !== expected.sourceRevision) fail('CONTEXT_PACKET_IDENTITY', 'packet source revision does not match the launch source');
  if (expected.policyHash !== undefined && packet.policy_hash !== expected.policyHash) fail('CONTEXT_PACKET_IDENTITY', 'packet policy hash does not match the resolved policy');
  if (!REVISION.test(packet.source_revision || '') || !HASH.test(packet.policy_hash || '')) fail('INVALID_CONTEXT_PACKET', 'packet source revision or policy hash is malformed');
  if (!object(packet.policy) || typeof packet.policy.content !== 'string' || packet.policy.sha256 !== packet.policy_hash || packet.policy.digest !== packet.policy_hash || hash(packet.policy.content) !== packet.policy_hash) {
    fail('STALE_CONTEXT_PACKET', 'packet required policy is missing or altered');
  }
  if (packet.policy.path !== undefined) {
    const policyPath = safeRelative(root, packet.policy.path, 'packet policy', true);
    const policyContent = fs.readFileSync(policyPath, 'utf8');
    if (hash(policyContent) !== packet.policy_hash || policyContent !== packet.policy.content) fail('STALE_CONTEXT_PACKET', 'packet policy source changed');
  }
  if (!object(packet.immutable_scope) || !Array.isArray(packet.immutable_scope.files_modified)) fail('INVALID_CONTEXT_PACKET', 'packet immutable scope is missing');
  if (!Array.isArray(packet.acceptance) || !Array.isArray(packet.verification)) fail('INVALID_CONTEXT_PACKET', 'packet acceptance or verification is missing');
  if (!Array.isArray(packet.required_refs) || !Array.isArray(packet.optional_refs)) fail('INVALID_CONTEXT_PACKET', 'packet references are missing');
  if (!Array.isArray(packet.role_requirements) || !object(packet.role_context) || typeof packet.role_context_complete !== 'boolean') {
    fail('INVALID_CONTEXT_PACKET', 'packet role context is missing');
  }
  const requiredInputs = ROLE_REQUIRED_INPUTS[packet.role] || packet.role_requirements;
  if (ROLE_REQUIRED_INPUTS[packet.role]
      && JSON.stringify(packet.role_requirements) !== JSON.stringify(requiredInputs)) {
    fail('INVALID_CONTEXT_PACKET', 'packet role requirements do not match the canonical role matrix');
  }
  if (packet.role_context_complete) {
    const missing = requiredInputs.filter((key) => packet.role_context[key] === undefined || packet.role_context[key] === null);
    if (missing.length) fail('MISSING_ROLE_CONTEXT', `packet role context is missing required inputs: ${missing.join(', ')}`);
  }
  const refs = new Set();
  for (const ref of packet.required_refs) {
    if (refs.has(ref && ref.path)) fail('INVALID_CONTEXT_PACKET', 'packet references must be unique');
    refs.add(ref && ref.path);
    assertDigestRef(root, ref, 'required reference', false);
  }
  const overflow = packet.accounting && packet.accounting.overflow === true;
  for (const ref of packet.optional_refs) {
    if (refs.has(ref && ref.path)) fail('INVALID_CONTEXT_PACKET', 'packet references must be unique');
    refs.add(ref && ref.path);
    assertDigestRef(root, ref, 'optional reference', overflow);
  }
  if (!object(packet.backlog) || !object(packet.backlog.inventory) || !Array.isArray(packet.backlog.inventory.items)
      || !Array.isArray(packet.backlog.selected_ids) || !Array.isArray(packet.backlog.selected)) {
    fail('INVALID_CONTEXT_PACKET', 'packet backlog selection is missing');
  }
  if (packet.backlog.selected_ids.length !== packet.backlog.selected.length
      || new Set(packet.backlog.selected_ids).size !== packet.backlog.selected_ids.length) {
    fail('INVALID_CONTEXT_PACKET', 'packet backlog ids and selected entries do not match');
  }
  const selectedIds = new Set(packet.backlog.selected_ids);
  if (packet.backlog.empty !== (packet.backlog.selected.length === 0)) fail('INVALID_CONTEXT_PACKET', 'packet backlog empty marker is incorrect');
  if (packet.backlog.inventory.scope === 'selected') {
    const inventoryIds = packet.backlog.inventory.items.map((item) => item && item.id);
    if (inventoryIds.length !== selectedIds.size || inventoryIds.some((id) => !selectedIds.has(id))) {
      fail('INVALID_CONTEXT_PACKET', 'packet backlog inventory scope does not match its selection');
    }
  }
  for (const item of packet.backlog.selected) {
    if (!object(item) || typeof item.id !== 'string' || typeof item.source !== 'string' || !HASH.test(item.source_hash || '') || typeof item.content !== 'string' || typeof item.why_selected !== 'string' || !item.why_selected.trim()) {
      fail('INVALID_CONTEXT_PACKET', 'selected backlog item is incomplete');
    }
    if (!selectedIds.has(item.id)) fail('INVALID_CONTEXT_PACKET', `selected backlog id is missing its item: ${item.id}`);
    const indexed = packet.backlog.inventory.items.find((candidate) => candidate && candidate.id === item.id);
    if (!indexed || indexed.source !== item.source || indexed.source_hash !== item.source_hash
        || indexed.status !== item.status
        || Boolean(indexed.verification_stale) !== Boolean(item.verification_stale)) {
      fail('STALE_CONTEXT_PACKET', `selected backlog status or identity is inconsistent: ${item.id}`);
    }
    const current = sectionContent(root, { ...item, verification_stale: Boolean(item.verification_stale) });
    if (current.source_hash !== item.source_hash || current.content !== item.content) fail('STALE_CONTEXT_PACKET', `selected backlog item changed: ${item.id}`);
  }
  if (!object(packet.accounting) || typeof packet.accounting.backend !== 'string'
      || !Number.isSafeInteger(packet.accounting.estimated_tokens)
      || !Number.isSafeInteger(packet.accounting.soft_ceiling)
      || packet.accounting.soft_ceiling < 1
      || typeof packet.accounting.overflow !== 'boolean') {
    fail('INVALID_CONTEXT_PACKET', 'packet accounting is incomplete');
  }
  const measured = estimateTokens(packetWithoutAccounting(packet));
  if (packet.accounting.estimated_tokens !== measured) fail('INVALID_CONTEXT_PACKET', 'packet token estimate is stale');
  const measuredBytes = Buffer.byteLength(JSON.stringify(packetWithoutAccounting(packet)), 'utf8');
  if (packet.accounting.estimated_bytes !== measuredBytes) fail('INVALID_CONTEXT_PACKET', 'packet byte estimate is stale');
  if (packet.accounting.overflow !== (measured > packet.accounting.soft_ceiling)) fail('INVALID_CONTEXT_PACKET', 'packet overflow marker is stale');
  if (packet.accounting.overflow && (!object(packet.overflow) || packet.overflow.required_preserved !== true)) {
    fail('INVALID_CONTEXT_PACKET', 'packet overflow must identify preserved required context');
  }
  return deepFreeze(packet);
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('context-packet.cjs is a library; call buildContextPacket(options) and validateContextPacket(packet, expected)\n');
    return;
  }
  throw new Error('context-packet.cjs has no direct mutation CLI; use the host-owned builder');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`context-packet: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = Object.freeze({
  CONTEXT_PACKET_SCHEMA,
  CONTEXT_PACKET_VERSION,
  DEFAULT_TOKEN_CEILING,
  ROLE_REQUIRED_INPUTS,
  ContextPacketError,
  estimateTokens,
  buildContextPacket,
  recordPacketMeasurement,
  validateContextPacket,
});
