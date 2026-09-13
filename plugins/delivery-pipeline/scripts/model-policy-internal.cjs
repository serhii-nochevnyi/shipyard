#!/usr/bin/env node
'use strict';

// ADR-014's runtime-neutral model policy.
//
// This module intentionally does not read pipeline-config.cjs.  That module
// contains the compatibility policy used by non-routed callers; routed delivery
// needs one versioned contract whose result is explicit enough for either
// runtime adapter to apply and later prove.

const crypto = require('crypto');
const runtimeAdapters = require('./runtime-adapters.cjs');

// Capture the concrete runtime mappings once, before any caller can mutate the
// runtime-adapter module. Canonical policy resolution never consults the
// replaceable adapter functions or exported objects after this point.
const CODEX_MODEL_IDS = Object.freeze({ ...runtimeAdapters.CODEX_MODEL_IDS });
const CLAUDE_MODEL_ALIASES = Object.freeze({ ...runtimeAdapters.CLAUDE_MODEL_ALIASES });
const CANONICAL_MODEL_MAPPINGS = Object.freeze({
  codex: CODEX_MODEL_IDS,
  claude: CLAUDE_MODEL_ALIASES,
});

const POLICY_VERSION = 'adr-014.v1';
const SUPPORTED_RUNTIMES = Object.freeze(['codex', 'claude']);
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const SIGNATURE_STATES = Object.freeze([
  'first',
  'progress',
  'repeat',
  'repeat_exhausted',
  'flake',
  'plan_defect',
]);

// The threshold is deliberately part of the versioned policy. A dispatch may
// report measured input, but cannot tune the threshold outside this fingerprint.
const WINDOW_THRESHOLD_TOKENS = 250000;

const ROLES = Object.freeze([
  'research',
  'decomposition',
  'executor',
  'pr-sentinel',
  'integrator',
  'drift-check',
  'arch-review',
  'ci-fix',
  'review-fix',
]);

const ROLE_CLASSES = Object.freeze({
  dynamic: Object.freeze(['executor', 'decomposition']),
  repair: Object.freeze(['ci-fix', 'review-fix']),
  judgement: Object.freeze(['integrator', 'arch-review']),
  fixed_luna: Object.freeze(['executor', 'pr-sentinel', 'drift-check']),
});

const DYNAMIC_ROLES = new Set(ROLE_CLASSES.dynamic);
const REPAIR_ROLES = new Set(ROLE_CLASSES.repair);
const JUDGEMENT_ROLES = new Set(ROLE_CLASSES.judgement);
const FIXED_LUNA_ROLES = new Set(ROLE_CLASSES.fixed_luna);

const ROLE_RUNG_DEFINITIONS = Object.freeze({
  research: Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'terra', effort: 'high' }),
    Object.freeze({ name: 'alternatives', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'very-complex', logical_model: 'astra', effort: 'medium' }),
  ]),
  decomposition: Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'critical', logical_model: 'astra', effort: 'medium' }),
  ]),
  executor: Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'luna', effort: 'max' }),
  ]),
  'pr-sentinel': Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'luna', effort: 'medium' }),
  ]),
  integrator: Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'critical', logical_model: 'astra', effort: 'medium' }),
  ]),
  'drift-check': Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'luna', effort: 'max' }),
  ]),
  'arch-review': Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'critical', logical_model: 'astra', effort: 'medium' }),
  ]),
  'ci-fix': Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'luna', effort: 'max' }),
    Object.freeze({ name: 'repeat', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'repeat_exhausted', logical_model: 'astra', effort: 'medium' }),
  ]),
  'review-fix': Object.freeze([
    Object.freeze({ name: 'base', logical_model: 'luna', effort: 'max' }),
    Object.freeze({ name: 'repeat', logical_model: 'sol', effort: 'medium' }),
    Object.freeze({ name: 'repeat_exhausted', logical_model: 'astra', effort: 'medium' }),
  ]),
});

// Escalation semantics are data, not an un-fingerprinted collection of
// conditionals.  The evaluator below reads this table, so changing a signal,
// role classification, or repair prerequisite changes POLICY_HASH as well.
const ROLE_SIGNAL_RULES = Object.freeze({
  research: Object.freeze({
    alternatives: Object.freeze({ rung: 'alternatives', any: Object.freeze([{ type: 'alternatives' }]) }),
    'very-complex': Object.freeze({ rung: 'very-complex', any: Object.freeze([{ complexity: 'very-complex' }]) }),
  }),
  decomposition: Object.freeze({
    critical: Object.freeze({ rung: 'critical', any: Object.freeze([{ critical: true }, { checkpoint: true }]) }),
  }),
  integrator: Object.freeze({
    critical: Object.freeze({ rung: 'critical', any: Object.freeze([{ critical: true }, { checkpoint: true }, { contested: true }, { inputTokens: { gt_policy: 'window_threshold_tokens' } }]) }),
  }),
  'arch-review': Object.freeze({
    critical: Object.freeze({ rung: 'critical', any: Object.freeze([{ critical: true }, { checkpoint: true }, { contested: true }, { inputTokens: { gt_policy: 'window_threshold_tokens' } }]) }),
  }),
  'ci-fix': Object.freeze({
    repeat: Object.freeze({ rung: 'repeat', any: Object.freeze([{ signatureState: 'repeat' }]), prerequisite: 'luna/max' }),
    repeat_exhausted: Object.freeze({ rung: 'repeat_exhausted', any: Object.freeze([{ signatureState: 'repeat_exhausted' }]), prerequisite: 'sol/medium' }),
  }),
  'review-fix': Object.freeze({
    repeat: Object.freeze({ rung: 'repeat', any: Object.freeze([{ signatureState: 'repeat' }]), prerequisite: 'luna/max' }),
    repeat_exhausted: Object.freeze({ rung: 'repeat_exhausted', any: Object.freeze([{ signatureState: 'repeat_exhausted' }]), prerequisite: 'sol/medium' }),
  }),
  'pr-sentinel': Object.freeze({}),
  executor: Object.freeze({}),
  'drift-check': Object.freeze({}),
});

const REPAIR_PREREQUISITES = Object.freeze({
  'ci-fix': Object.freeze({ repeat: Object.freeze({ logical_model: 'luna', effort: 'max' }), repeat_exhausted: Object.freeze({ logical_model: 'sol', effort: 'medium' }) }),
  'review-fix': Object.freeze({ repeat: Object.freeze({ logical_model: 'luna', effort: 'max' }), repeat_exhausted: Object.freeze({ logical_model: 'sol', effort: 'medium' }) }),
});

// Static Codex roles are represented by generated files.  Dynamic roles must
// receive explicit launch arguments because no static file can carry their
// per-dispatch rung decision.
const CODEX_AGENT_ROLE_NAMES = Object.freeze({ research: 'inv-research' });
const CODEX_STATIC_ROLES = new Set(ROLES.filter((role) => !DYNAMIC_ROLES.has(role)));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function fingerprintPolicy(policy = POLICY) {
  return crypto.createHash('sha256').update(stableStringify(policy)).digest('hex');
}

const POLICY = deepFreeze({
  id: 'ADR-014',
  version: POLICY_VERSION,
  window_threshold_tokens: WINDOW_THRESHOLD_TOKENS,
  runtimes: {
    codex: { adapter: 'codex' },
    claude: { adapter: 'claude' },
  },
  roles: ROLE_RUNG_DEFINITIONS,
  role_classes: ROLE_CLASSES,
  signal_rules: ROLE_SIGNAL_RULES,
  repair_prerequisites: REPAIR_PREREQUISITES,
});

const POLICY_HASH = fingerprintPolicy(POLICY);

const APPLICATION_RECEIPT_FIELDS = Object.freeze([
  'receipt_type',
  'runtime',
  'role',
  'dispatch_id',
  'launch_id',
  'requested_model',
  'requested_effort',
  'applied_model',
  'applied_effort',
  'observed_model',
  'observed_effort',
  'policy_hash',
  'compliance',
  'compliance_proof',
]);

const SIGNAL_ORDER = Object.freeze([
  'type',
  'complexity',
  'risk',
  'critical',
  'checkpoint',
  'contested',
  'inputTokens',
  'signatureState',
  'priorApplied',
]);

const SIGNAL_KEYS = new Set(SIGNAL_ORDER);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function policyError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'DispatchPolicyError';
  error.code = code;
  error.details = details;
  return error;
}

function refuse(code, message, details = {}) {
  throw policyError(code, message, details);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse('INVALID_INPUT', `${label} must be an object`);
  }
}

function normalizeRuntime(runtime) {
  const value = nonEmptyString(runtime);
  if (!value || !SUPPORTED_RUNTIMES.includes(value)) {
    refuse(
      'UNKNOWN_RUNTIME',
      `unknown or ambiguous runtime ${JSON.stringify(runtime)}; choose exactly one of ${SUPPORTED_RUNTIMES.join(', ')}`,
      { runtime },
    );
  }
  return value;
}

function normalizeRole(role) {
  const value = nonEmptyString(role);
  if (!value || !ROLES.includes(value)) {
    refuse(
      'UNKNOWN_ROLE',
      `unknown delivery role ${JSON.stringify(role)}; roles: ${ROLES.join(', ')}`,
      { role },
    );
  }
  return value;
}

function booleanSignal(value, name) {
  if (typeof value !== 'boolean') {
    refuse('INVALID_SIGNAL', `signals.${name} must be boolean`, { signal: name, value });
  }
  return value;
}

function integerSignal(value, name) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (!Number.isInteger(value) || value < 0) {
    refuse('INVALID_SIGNAL', `signals.${name} must be a non-negative integer`, { signal: name, value });
  }
  return value;
}

function normalizeSignals(raw) {
  const signals = raw === undefined ? {} : raw;
  assertPlainObject(signals, 'signals');
  for (const key of Object.keys(signals)) {
    if (!SIGNAL_KEYS.has(key)) {
      refuse(
        'UNSUPPORTED_SIGNAL',
        `unsupported signal ${JSON.stringify(key)}; the resolver would otherwise ignore a selection input`,
        { signal: key },
      );
    }
  }

  const out = {};
  if (hasOwn(signals, 'type')) {
    if (!['facts', 'alternatives'].includes(signals.type)) {
      refuse('UNSUPPORTED_SIGNAL', `signals.type ${JSON.stringify(signals.type)} is not facts or alternatives`, { signal: 'type' });
    }
    out.type = signals.type;
  }
  if (hasOwn(signals, 'complexity')) {
    if (!['normal', 'very-complex'].includes(signals.complexity)) {
      refuse(
        'UNSUPPORTED_SIGNAL',
        `signals.complexity ${JSON.stringify(signals.complexity)} is not normal or very-complex`,
        { signal: 'complexity' },
      );
    }
    out.complexity = signals.complexity;
  }
  for (const name of ['critical', 'checkpoint', 'contested']) {
    if (hasOwn(signals, name)) out[name] = booleanSignal(signals[name], name);
  }
  if (hasOwn(signals, 'risk')) {
    if (!['low', 'medium', 'high'].includes(signals.risk)) {
      refuse('UNSUPPORTED_SIGNAL', `signals.risk ${JSON.stringify(signals.risk)} is not low, medium, or high`, { signal: 'risk' });
    }
    out.risk = signals.risk;
  }
  if (hasOwn(signals, 'inputTokens')) out.inputTokens = integerSignal(signals.inputTokens, 'inputTokens');
  if (hasOwn(signals, 'signatureState')) {
    if (!SIGNATURE_STATES.includes(signals.signatureState)) {
      refuse(
        'UNSUPPORTED_SIGNAL',
        `signals.signatureState ${JSON.stringify(signals.signatureState)} is not ${SIGNATURE_STATES.join(', ')}`,
        { signal: 'signatureState' },
      );
    }
    out.signatureState = signals.signatureState;
  }
  if (hasOwn(signals, 'priorApplied')) {
    assertPlainObject(signals.priorApplied, 'signals.priorApplied');
    out.priorApplied = cloneValue(signals.priorApplied);
  }
  return out;
}

function logicalModelFor(runtime, logicalModel) {
  const model = CANONICAL_MODEL_MAPPINGS[runtime] && CANONICAL_MODEL_MAPPINGS[runtime][logicalModel];
  if (!model) refuse('UNSUPPORTED_SELECTION', `no ${runtime} model is registered for logical model ${logicalModel}`);
  return model;
}

function activeSignal(value) {
  return value !== undefined && value !== false && value !== null;
}

function ruleMatches(rule, signals, threshold) {
  if (!rule || !Array.isArray(rule.any)) return false;
  return rule.any.some((condition) => Object.entries(condition).every(([name, expected]) => {
    const actual = signals[name];
    if (expected && typeof expected === 'object' && expected.gt_policy === 'window_threshold_tokens') {
      return Number.isInteger(actual) && actual > threshold;
    }
    return actual === expected;
  }));
}

function evaluateSignals(role, rawSignals = {}, options = {}) {
  const normalizedRole = normalizeRole(role);
  const signals = normalizeSignals(rawSignals);
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    refuse('INVALID_INPUT', 'evaluation options must be an object');
  }
  if (hasOwn(options, 'windowThresholdTokens')) {
    refuse(
      'UNSUPPORTED_SELECTION',
      'windowThresholdTokens is fixed by the active ADR-014 policy fingerprint and cannot be set per dispatch',
      { windowThresholdTokens: options.windowThresholdTokens },
    );
  }
  const threshold = WINDOW_THRESHOLD_TOKENS;
  const roleRules = ROLE_SIGNAL_RULES[normalizedRole] || {};
  const reasons = [];
  const selected = [];

  const add = (signal, source, value, applies, rung, reason) => {
    if (!activeSignal(value)) return;
    reasons.push({
      signal,
      source,
      value,
      applies,
      rung: rung || null,
      reason,
    });
  };
  const choose = (signal, source, value, rung, reason) => {
    if (!activeSignal(value)) return;
    selected.push({ signal, rung, reason });
    add(signal, source, value, true, rung, reason);
  };

  // Context signals are retained even when they are intentionally inert for a
  // role. This prevents a later report from confusing "not promoted" with
  // "the caller never supplied the risk/checkpoint/window fact".
  if (hasOwn(signals, 'type')) {
    const alternatives = signals.type === 'alternatives';
    if (alternatives && ruleMatches(roleRules.alternatives, signals, threshold)) {
      choose('alternatives', 'signals.type', signals.type, 'alternatives', 'signals.type=alternatives selects the research alternatives rung');
    } else {
      add(
        'type',
        'signals.type',
        signals.type,
        false,
        null,
        alternatives
          ? `signals.type=alternatives does not promote ${normalizedRole}`
          : 'facts is informational and selects the base rung',
      );
    }
  }
  const veryComplex = signals.complexity === 'very-complex';
  if (hasOwn(signals, 'complexity')) {
    if (signals.complexity === 'very-complex' && ruleMatches(roleRules['very-complex'], signals, threshold)) {
      choose('very-complex', 'signals.complexity', signals.complexity, 'very-complex', 'signals.complexity=very-complex selects the research ceiling rung');
    } else {
      add(
        signals.complexity === 'very-complex' ? 'very-complex' : 'complexity',
        'signals.complexity',
        signals.complexity,
        false,
        null,
        veryComplex
          ? `very-complex is scoped to research and does not promote ${normalizedRole}`
          : 'normal classification does not select a rung for this role',
      );
    }
  }

  if (hasOwn(signals, 'risk')) {
    add(
      'risk',
      'signals.risk',
      signals.risk,
      false,
      null,
      FIXED_LUNA_ROLES.has(normalizedRole)
        ? 'global risk is intentionally inert for a fixed Luna role'
        : 'risk is recorded context, not a role-scoped escalation signal',
    );
  }
  if (signals.critical === true) {
    const applies = ruleMatches(roleRules.critical, signals, threshold);
    const reason = applies
      ? `signals.critical=true selects the ${normalizedRole} critical rung`
      : FIXED_LUNA_ROLES.has(normalizedRole)
        ? 'global critical state cannot promote a fixed Luna role'
        : `critical state does not promote ${normalizedRole}`;
    add('critical', 'signals.critical', true, applies, applies ? 'critical' : null, reason);
    if (applies) selected.push({ signal: 'critical', rung: 'critical', reason });
  }
  if (signals.checkpoint === true) {
    const applies = ruleMatches(roleRules.critical, signals, threshold);
    const reason = applies
      ? `signals.checkpoint=true selects the ${normalizedRole} critical rung`
      : FIXED_LUNA_ROLES.has(normalizedRole)
        ? 'global checkpoint state cannot promote a fixed Luna role'
        : `checkpoint state does not promote ${normalizedRole}`;
    add('checkpoint', 'signals.checkpoint', true, applies, applies ? 'critical' : null, reason);
    if (applies) selected.push({ signal: 'checkpoint', rung: 'critical', reason });
  }
  if (signals.contested === true) {
    const applies = ruleMatches(roleRules.critical, signals, threshold);
    const reason = applies
      ? 'signals.contested=true selects the judgement critical rung'
      : `contested judgement evidence does not promote ${normalizedRole}`;
    add('contested', 'signals.contested', true, applies, applies ? 'critical' : null, reason);
    if (applies) selected.push({ signal: 'contested', rung: 'critical', reason });
  }

  const measuredWindow = signals.inputTokens !== undefined && signals.inputTokens > threshold;
  if (hasOwn(signals, 'inputTokens')) {
    const reason = measuredWindow
      ? `signals.inputTokens=${signals.inputTokens} exceeds window threshold ${threshold}`
      : `measured input is at or below window threshold ${threshold}`;
    const applies = measuredWindow && ruleMatches(roleRules.critical, signals, threshold);
    add(
      'window',
      'signals.inputTokens',
      signals.inputTokens,
      applies,
      applies ? 'critical' : null,
      applies
        ? `${reason}; selects the judgement critical rung`
        : FIXED_LUNA_ROLES.has(normalizedRole) && measuredWindow
          ? `${reason}; window pressure cannot promote a fixed Luna role`
          : reason,
    );
    if (applies) selected.push({ signal: 'window', rung: 'critical', reason: `${reason}; selects the judgement critical rung` });
  }

  if (hasOwn(signals, 'signatureState')) {
    const state = signals.signatureState;
    const applies = Boolean(roleRules[state]) && ruleMatches(roleRules[state], signals, threshold);
    const reason = applies
      ? `signals.signatureState=${state} selects the ${state} repair rung after receipt validation`
      : ['flake', 'plan_defect'].includes(state)
        ? `terminal ${state} is a gate/strategy outcome, not a model promotion`
        : `signature state ${state} does not promote ${normalizedRole}`;
    add(state, 'signals.signatureState', state, applies, applies ? state : null, reason);
    if (applies) selected.push({ signal: state, rung: state, reason });
  }
  if (hasOwn(signals, 'priorApplied')) {
    add(
      'priorApplied',
      'signals.priorApplied',
      { ...signals.priorApplied },
      false,
      null,
      'prior application evidence is validated as a receipt prerequisite, never as a model selection signal',
    );
  }

  // A signal may be supplied through two equivalent fields (`type` and the
  // explicit boolean alias). Keep every reason, but make the selection list
  // deterministic and deduplicated for the route.
  const uniqueSelected = [];
  const selectedKeys = new Set();
  for (const item of selected) {
    const key = `${item.signal}:${item.rung}`;
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    uniqueSelected.push(item);
  }
  const order = new Map(SIGNAL_ORDER.map((name, index) => [name, index]));
  reasons.sort((a, b) => {
    const ai = order.has(a.signal) ? order.get(a.signal) : 999;
    const bi = order.has(b.signal) ? order.get(b.signal) : 999;
    return ai - bi || a.signal.localeCompare(b.signal) || a.source.localeCompare(b.source);
  });
  uniqueSelected.sort((a, b) => {
    const ai = order.has(a.signal) ? order.get(a.signal) : 999;
    const bi = order.has(b.signal) ? order.get(b.signal) : 999;
    return ai - bi || a.rung.localeCompare(b.rung);
  });
  return {
    signals,
    threshold,
    reasons,
    selected: uniqueSelected,
    signals_fired: reasons.map((entry) => entry.signal),
  };
}

function opaqueId(value, label) {
  const id = nonEmptyString(value);
  if (!id || /[\s\u0000-\u001f\u007f]/.test(id)) {
    refuse('MISSING_RECEIPT', `${label} must be a non-empty, whitespace-free launch identity`, { label });
  }
  return id;
}

function previousReceiptFor(input, signals) {
  const value = signals.priorApplied !== undefined
    ? signals.priorApplied
    : input.priorApplied !== undefined
      ? input.priorApplied
      : input.priorReceipt;
  return value;
}

function receiptCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.application_receipt && typeof raw.application_receipt === 'object' && !Array.isArray(raw.application_receipt)) {
    return raw.application_receipt;
  }
  if (raw.receipt && typeof raw.receipt === 'object' && !Array.isArray(raw.receipt)) {
    return raw.receipt;
  }
  return raw;
}

function validateApplicationReceiptShape(raw, { requireRole = true } = {}) {
  const receipt = receiptCandidate(raw);
  if (!receipt) refuse('MISSING_RECEIPT', 'application receipt must be an object');
  for (const field of APPLICATION_RECEIPT_FIELDS) {
    if (!hasOwn(receipt, field)) refuse('MISSING_RECEIPT', `application receipt is missing ${field}`, { field });
  }
  if (receipt.receipt_type !== 'adr-014.application') {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt has an unknown receipt_type');
  }
  opaqueId(receipt.runtime, 'runtime');
  if (requireRole) normalizeRole(receipt.role);
  opaqueId(receipt.dispatch_id, 'dispatch_id');
  opaqueId(receipt.launch_id, 'launch_id');
  opaqueId(receipt.policy_hash, 'policy_hash');
  if (receipt.policy_hash !== POLICY_HASH) {
    refuse('STALE_POLICY_RECEIPT', 'application receipt has a stale policy fingerprint', { expected: POLICY_HASH, actual: receipt.policy_hash });
  }
  if (receipt.compliance !== 'verified' || !receipt.compliance_proof || typeof receipt.compliance_proof !== 'object' || Array.isArray(receipt.compliance_proof)) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt lacks the boundary compliance proof');
  }
  const proof = receipt.compliance_proof;
  if (proof.status !== 'verified' || proof.boundary !== 'adr-014.dispatch-boundary' || proof.policy_hash !== receipt.policy_hash || proof.dispatch_id !== receipt.dispatch_id || proof.launch_id !== receipt.launch_id) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt compliance proof is incomplete or contradictory');
  }
  for (const field of ['requested_model', 'requested_effort', 'applied_model', 'applied_effort', 'observed_model', 'observed_effort']) {
    if (receipt[field] !== 'unknown' && !nonEmptyString(receipt[field])) {
      refuse('INVALID_RECEIPT', `application receipt ${field} must be concrete or unknown`, { field });
    }
  }
  return receipt;
}

function validatePriorReceipt({ input, signals, runtime, role, requiredLogicalModel, requiredEffort, receiptVerifier }) {
  const raw = previousReceiptFor(input, signals);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    refuse(
      'MISSING_RECEIPT',
      `${role} ${signals.signatureState} escalation requires the immediately preceding compliant applied receipt`,
      { role, signatureState: signals.signatureState },
    );
  }
  const receipt = validateApplicationReceiptShape(raw);
  const previousDispatchId = input.previous_dispatch_id;
  if (!nonEmptyString(previousDispatchId) || previousDispatchId !== receipt.dispatch_id) {
    refuse('MISSING_RECEIPT', `${role} ${signals.signatureState} escalation must identify its immediately preceding dispatch_id`, { expected: receipt.dispatch_id, actual: previousDispatchId });
  }
  const expectedModel = logicalModelFor(runtime, requiredLogicalModel);
  if (typeof receiptVerifier !== 'function') {
    refuse('UNVERIFIED_RECEIPT', `${role} ${signals.signatureState} escalation requires a receipt verified by the dispatch boundary`, { dispatch_id: receipt.dispatch_id });
  }
  const trusted = receiptVerifier(receipt, {
    runtime,
    role,
    previousDispatchId,
    expectedModel,
    expectedEffort: requiredEffort,
  });
  if (!trusted || typeof trusted !== 'object' || Array.isArray(trusted) || stableStringify(trusted) !== stableStringify(receipt)) {
    refuse('UNVERIFIED_RECEIPT', `${role} ${signals.signatureState} escalation requires a receipt verified by the dispatch boundary`, { dispatch_id: receipt.dispatch_id });
  }
  const appliedModel = receipt.applied_model;
  const appliedEffort = receipt.applied_effort;
  if (appliedModel !== expectedModel || appliedEffort !== requiredEffort) {
    refuse(
      'NONCOMPLIANT_RECEIPT',
      `${role} ${signals.signatureState} requires a preceding ${requiredLogicalModel}/${requiredEffort} receipt on ${runtime}; got ${appliedModel}/${appliedEffort}`,
      { role, signatureState: signals.signatureState, expected: { model: expectedModel, effort: requiredEffort }, actual: { model: appliedModel, effort: appliedEffort } },
    );
  }
  if (receipt.runtime !== runtime) {
    refuse('NONCOMPLIANT_RECEIPT', `prior receipt runtime ${JSON.stringify(receipt.runtime)} does not match ${runtime}`, { runtime, prior: receipt.runtime });
  }
  if (receipt.role !== role) {
    refuse('NONCOMPLIANT_RECEIPT', `prior receipt role ${JSON.stringify(receipt.role)} does not match ${role}`, { role, prior: receipt.role });
  }
  if (receipt.requested_model !== expectedModel) {
    refuse('NONCOMPLIANT_RECEIPT', 'prior receipt requested model does not match its applied model', { expected: expectedModel, actual: receipt.requested_model });
  }
  if (receipt.requested_effort !== requiredEffort) {
    refuse('NONCOMPLIANT_RECEIPT', 'prior receipt requested effort does not match its applied effort', { expected: requiredEffort, actual: receipt.requested_effort });
  }
  return {
    dispatch_id: nonEmptyString(receipt.dispatch_id),
    model: nonEmptyString(appliedModel),
    effort: nonEmptyString(appliedEffort),
  };
}

function variantSuffix(role, rung) {
  if (rung === 'base') return '';
  if (role === 'research' && rung === 'alternatives') return '-alternatives';
  if (rung === 'very-complex' || rung === 'critical') return '-critical';
  if (rung === 'repeat') return '-repeat';
  if (rung === 'repeat_exhausted') return '-deep';
  return `-${rung}`;
}

function codexAgentFile(role, rung) {
  const generatedRole = CODEX_AGENT_ROLE_NAMES[role] || role;
  return `shipyard-${generatedRole}${variantSuffix(role, rung)}.toml`;
}

function launchMetadata(runtime, role, rung, model, effort) {
  if (runtime === 'claude') {
    return {
      backend: 'workflow',
      mechanism: 'workflow-explicit-selection',
      launch_arguments: { model, effort },
    };
  }
  if (CODEX_STATIC_ROLES.has(role)) {
    return {
      backend: 'codex-agent',
      mechanism: 'generated-agent-file',
      agent_file: codexAgentFile(role, rung),
    };
  }
  return {
    backend: 'agent',
    mechanism: 'explicit-launch-arguments',
    launch_arguments: { model, reasoning_effort: effort },
  };
}

function overrideSources(input, role) {
  const sources = [];
  const add = (name, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') sources.push([name, { model: value }]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) sources.push([name, value]);
    else refuse('CONFLICTING_OVERRIDE', `${name} must be an object or model string`, { source: name });
  };

  for (const [name, key] of [
    ['override', 'override'],
    ['overrides', 'overrides'],
    ['selection', 'selection'],
    ['launch_arguments', 'launch_arguments'],
    ['gsd_override', 'gsdOverride'],
    ['per_role_override', 'perRoleOverride'],
    ['config_override', 'configOverride'],
  ]) add(name, input[key]);
  if (hasOwn(input, 'model') || hasOwn(input, 'requested_model')) {
    add('input.model', { model: hasOwn(input, 'model') ? input.model : input.requested_model });
  }
  if (hasOwn(input, 'effort') || hasOwn(input, 'requested_effort')) {
    add('input.effort', { effort: hasOwn(input, 'effort') ? input.effort : input.requested_effort });
  }
  if (hasOwn(input, 'backend')) add('input.backend', { backend: input.backend });
  if (hasOwn(input, 'mechanism')) add('input.mechanism', { mechanism: input.mechanism });
  if (hasOwn(input, 'agent_file')) add('input.agent_file', { agent_file: input.agent_file });

  const config = input.config;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    if (hasOwn(config, 'runtime')) add('config.runtime', { runtime: config.runtime });
    if (config.models && typeof config.models === 'object' && hasOwn(config.models, role)) {
      add(`config.models.${role}`, { model: config.models[role] });
    }
    if (config.effort && typeof config.effort === 'object' && hasOwn(config.effort, role)) {
      add(`config.effort.${role}`, { effort: config.effort[role] });
    }
    if (config.model_policy && typeof config.model_policy === 'object') {
      const policy = config.model_policy;
      if (policy.runtime !== undefined) add('config.model_policy.runtime', { runtime: policy.runtime });
      if (policy.models && typeof policy.models === 'object' && hasOwn(policy.models, role)) {
        add(`config.model_policy.models.${role}`, { model: policy.models[role] });
      }
    }
  }
  return sources;
}

function assertNoConflictingOverrides(input, expected) {
  for (const [source, override] of overrideSources(input, expected.role)) {
    const runtime = override.runtime;
    if (runtime !== undefined && runtime !== expected.runtime) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects runtime ${JSON.stringify(runtime)}, but routed dispatch runtime is ${expected.runtime}`, { source, runtime });
    }
    const model = override.model !== undefined
      ? override.model
      : override.requested_model !== undefined
        ? override.requested_model
        : override.applied_model;
    if (model !== undefined && model !== expected.model) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects model ${JSON.stringify(model)}, but ADR-014 resolved ${expected.model}`, { source, expected: expected.model, actual: model });
    }
    const effort = override.effort !== undefined
      ? override.effort
      : override.reasoning_effort !== undefined
        ? override.reasoning_effort
        : override.requested_effort;
    if (effort !== undefined && effort !== expected.effort) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects effort ${JSON.stringify(effort)}, but ADR-014 resolved ${expected.effort}`, { source, expected: expected.effort, actual: effort });
    }
    for (const field of ['logical_model', 'logical_rung', 'rung']) {
      if (override[field] !== undefined) {
        const want = field === 'logical_model' ? expected.logical_model : expected.rung;
        if (override[field] !== want) {
          refuse('CONFLICTING_OVERRIDE', `${source} selects ${field} ${JSON.stringify(override[field])}, but ADR-014 resolved ${want}`, { source, field, expected: want, actual: override[field] });
        }
      }
    }
    if (override.backend !== undefined && override.backend !== expected.backend) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects backend ${JSON.stringify(override.backend)}, but routed dispatch requires ${expected.backend}`, { source });
    }
    if (override.mechanism !== undefined && override.mechanism !== expected.mechanism) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects mechanism ${JSON.stringify(override.mechanism)}, but routed dispatch requires ${expected.mechanism}`, { source });
    }
    if (override.agent_file !== undefined && override.agent_file !== expected.agent_file) {
      refuse('CONFLICTING_OVERRIDE', `${source} selects agent file ${JSON.stringify(override.agent_file)}, but ADR-014 resolved ${expected.agent_file || 'explicit launch arguments'}`, { source });
    }
    if (override.inline === true || override.inherit === true || override.session_inherited === true) {
      refuse('UNSUPPORTED_SELECTION', `${source} requests inline or inherited model application; routed delivery requires explicit selection`, { source });
    }
  }
}

function validateResolution(resolution, options = {}) {
  assertPlainObject(resolution, 'resolution');
  if (resolution.policy_version !== POLICY_VERSION || resolution.policy_hash !== POLICY_HASH) {
    refuse('STALE_POLICY', 'resolution policy version or fingerprint is not the active ADR-014 policy', { expected: { version: POLICY_VERSION, hash: POLICY_HASH }, actual: { version: resolution.policy_version, hash: resolution.policy_hash } });
  }
  const runtime = normalizeRuntime(resolution.runtime);
  const role = normalizeRole(resolution.role);
  const rungs = ROLE_RUNG_DEFINITIONS[role];
  const rung = rungs.find((entry) => entry.name === resolution.rung);
  if (!rung || resolution.logical_rung !== resolution.rung) refuse('INVALID_RESOLUTION', `resolution rung ${JSON.stringify(resolution.rung)} is not valid for ${role}`);
  const expectedModel = logicalModelFor(runtime, rung.logical_model);
  if (resolution.logical_model !== rung.logical_model || resolution.model !== expectedModel || resolution.requested_model !== expectedModel) {
    refuse('INVALID_RESOLUTION', `resolution model does not match ${runtime} ${role} ${rung.name}`, { expected: expectedModel, actual: resolution.model });
  }
  if (!EFFORTS.includes(resolution.effort) || resolution.effort !== rung.effort || resolution.requested_effort !== rung.effort) {
    refuse('INVALID_RESOLUTION', `resolution effort does not match ${runtime} ${role} ${rung.name}`, { expected: rung.effort, actual: resolution.effort });
  }
  if (typeof resolution.route !== 'string' || resolution.route.trim() === '') refuse('INVALID_RESOLUTION', 'resolution route is required');
  if (typeof resolution.backend !== 'string' || resolution.backend.trim() === '') refuse('INVALID_RESOLUTION', 'resolution backend is required');
  if (typeof resolution.mechanism !== 'string' || resolution.mechanism.trim() === '') refuse('INVALID_RESOLUTION', 'resolution mechanism is required');
  const metadata = launchMetadata(runtime, role, rung.name, expectedModel, rung.effort);
  if (resolution.backend !== metadata.backend || resolution.mechanism !== metadata.mechanism) {
    refuse('INVALID_RESOLUTION', `resolution launch mechanism does not match ${runtime}/${role}`, { expected: metadata, actual: { backend: resolution.backend, mechanism: resolution.mechanism } });
  }
  if (metadata.agent_file) {
    if (resolution.agent_file !== metadata.agent_file || resolution.launch_arguments !== undefined) {
      refuse('INVALID_RESOLUTION', `static Codex role ${role} must name only its generated agent file`, { expected: metadata.agent_file });
    }
  } else {
    if (resolution.agent_file !== undefined && resolution.agent_file !== null) refuse('INVALID_RESOLUTION', `${runtime}/${role} must use explicit launch arguments, not an agent file`);
    const args = resolution.launch_arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) refuse('INVALID_RESOLUTION', `${runtime}/${role} requires explicit launch arguments`);
    if (args.model !== expectedModel) refuse('INVALID_RESOLUTION', 'launch arguments must carry the resolved concrete model');
    const effort = runtime === 'codex' ? args.reasoning_effort : args.effort;
    if (effort !== rung.effort) refuse('INVALID_RESOLUTION', 'launch arguments must carry the resolved effort');
  }
  if (options.requireDispatchId && !nonEmptyString(resolution.dispatch_id)) refuse('INVALID_RESOLUTION', 'dispatch id is required at the dispatch boundary');
  return true;
}

function resolveDispatch(input, receiptVerifier) {
  assertPlainObject(input, 'dispatch input');
  if (receiptVerifier !== undefined && typeof receiptVerifier !== 'function') {
    refuse('UNVERIFIED_RECEIPT', 'receipt verification options are private to the canonical dispatch boundary');
  }
  const runtime = normalizeRuntime(input.runtime);
  const role = normalizeRole(input.role);
  const signals = normalizeSignals(input.signals);
  const evaluation = evaluateSignals(role, signals);
  const rungs = ROLE_RUNG_DEFINITIONS[role];
  let rung = rungs[0];
  let priorReceipt = null;

  const selectedNames = new Set(evaluation.selected.map((entry) => entry.rung));
  // Highest rung wins when several signals fire; the policy retains all of them
  // in `signal_reasons` and `signals_fired` rather than short-circuiting at the
  // first match.
  for (const candidate of rungs) {
    if (selectedNames.has(candidate.name)) rung = candidate;
  }

  const repairPrerequisite = REPAIR_PREREQUISITES[role] && REPAIR_PREREQUISITES[role][signals.signatureState];
  if (repairPrerequisite) {
    priorReceipt = validatePriorReceipt({
      input,
      signals,
      runtime,
      role,
      requiredLogicalModel: repairPrerequisite.logical_model,
      requiredEffort: repairPrerequisite.effort,
      receiptVerifier,
    });
  }

  const model = logicalModelFor(runtime, rung.logical_model);
  const metadata = launchMetadata(runtime, role, rung.name, model, rung.effort);
  const firedNames = [];
  for (const reason of evaluation.reasons) {
    if (!firedNames.includes(reason.signal)) firedNames.push(reason.signal);
  }
  const selectedReasons = evaluation.selected.map((entry) => ({ ...entry }));
  const selectedRoute = selectedReasons.length
    ? selectedReasons.map((entry) => `${entry.signal}->${entry.rung}`).join('+')
    : 'base';
  const resolution = {
    policy_version: POLICY_VERSION,
    policy_hash: POLICY_HASH,
    runtime,
    role,
    logical_model: rung.logical_model,
    logical_rung: rung.name,
    rung: rung.name,
    rung_index: rungs.indexOf(rung),
    model,
    effort: rung.effort,
    requested_model: model,
    requested_effort: rung.effort,
    route: `role=${role} rung=${rung.name} model=${rung.logical_model} signals=${selectedRoute}`,
    backend: metadata.backend,
    mechanism: metadata.mechanism,
    signals_fired: firedNames,
    signal_reasons: evaluation.reasons,
    selected_signals: selectedReasons,
    signals: evaluation.signals,
    ...(metadata.agent_file ? { agent_file: metadata.agent_file } : { agent_file: null }),
    ...(metadata.launch_arguments ? { launch_arguments: metadata.launch_arguments } : {}),
    ...(input.dispatch_id !== undefined || input.dispatchId !== undefined
      ? { dispatch_id: opaqueId(input.dispatch_id !== undefined ? input.dispatch_id : input.dispatchId, 'dispatch_id') }
      : {}),
    ...(priorReceipt ? { prior_applied: priorReceipt } : {}),
  };
  assertNoConflictingOverrides(input, resolution);
  validateResolution(resolution);
  return deepFreeze(resolution);
}

module.exports = Object.freeze({
  POLICY,
  POLICY_VERSION,
  POLICY_HASH,
  VERSION: POLICY_VERSION,
  HASH: POLICY_HASH,
  ROLES,
  EFFORTS,
  SIGNATURE_STATES,
  SUPPORTED_RUNTIMES,
  WINDOW_THRESHOLD_TOKENS,
  CODEX_MODEL_IDS,
  CLAUDE_MODEL_ALIASES,
  RUNTIME_ADAPTERS: runtimeAdapters.RUNTIME_ADAPTERS,
  ROLE_CLASSES,
  ROLE_SIGNAL_RULES,
  REPAIR_PREREQUISITES,
  ROLE_RUNG_DEFINITIONS,
  DYNAMIC_ROLES: Object.freeze([...DYNAMIC_ROLES]),
  REPAIR_ROLES: Object.freeze([...REPAIR_ROLES]),
  JUDGEMENT_ROLES: Object.freeze([...JUDGEMENT_ROLES]),
  FIXED_LUNA_ROLES: Object.freeze([...FIXED_LUNA_ROLES]),
  CODEX_STATIC_ROLES: Object.freeze([...CODEX_STATIC_ROLES]),
  stableStringify,
  fingerprintPolicy,
  normalizeSignals,
  evaluateSignals,
  validateApplicationReceiptShape,
  validateResolution,
  resolveDispatch,
  codexAgentFile,
  variantSuffix,
  policyError,
});

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === 'fingerprint') {
      process.stdout.write(`${JSON.stringify({ policy_version: POLICY_VERSION, policy_hash: POLICY_HASH })}\n`);
    } else if (command === 'resolve') {
      const raw = process.argv[3];
      const input = raw ? JSON.parse(raw) : JSON.parse(require('fs').readFileSync(0, 'utf8'));
      process.stdout.write(`${JSON.stringify(resolveDispatch(input))}\n`);
    } else {
      throw policyError('USAGE', 'usage: model-policy.cjs fingerprint | resolve <json>');
    }
  } catch (error) {
    process.stderr.write(`model-policy: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
