#!/usr/bin/env node
'use strict';

// ADR-014's versioned runtime model policy.
//
// This module intentionally does not read pipeline-config.cjs. That module
// contains the compatibility policy used by non-routed callers; routed delivery
// needs one versioned contract whose result is explicit enough for each runtime
// adapter to apply and later prove. The two runtime grids are deliberately
// independent: Claude's native aliases are not derived from Codex's logical
// model names.

const crypto = require('crypto');
const runtimeAdapters = require('./runtime-adapters.cjs');

// Capture the concrete runtime palettes once, before any caller can mutate the
// runtime-adapter module. Canonical policy resolution never consults the
// replaceable adapter functions or exported objects after this point.
const CODEX_MODEL_IDS = Object.freeze({ ...runtimeAdapters.CODEX_MODEL_IDS });
const CLAUDE_MODEL_ALIASES = Object.freeze({ ...runtimeAdapters.CLAUDE_MODEL_ALIASES });
const CANONICAL_MODEL_MAPPINGS = Object.freeze({
  codex: CODEX_MODEL_IDS,
  claude: CLAUDE_MODEL_ALIASES,
});

const POLICY_VERSION = 'adr-014.v6';
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
  fixed: Object.freeze(['pr-sentinel', 'drift-check']),
});

const DYNAMIC_ROLES = new Set(ROLE_CLASSES.dynamic);
const REPAIR_ROLES = new Set(ROLE_CLASSES.repair);
const JUDGEMENT_ROLES = new Set(ROLE_CLASSES.judgement);
const FIXED_ROLES = new Set(ROLE_CLASSES.fixed);

// Codex's grid remains expressed in its own logical model vocabulary. It is
// not reused by Claude.
const CODEX_ROLE_RUNG_DEFINITIONS = Object.freeze({
  research: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'very-complex', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
  decomposition: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'critical', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
  executor: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'max' }),
    Object.freeze({ name: 'critical', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
  ]),
  'pr-sentinel': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'medium' }),
  ]),
  integrator: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'critical', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
  'drift-check': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'max' }),
  ]),
  'arch-review': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'critical', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
  'ci-fix': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'max' }),
    Object.freeze({ name: 'repeat', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'repeat_exhausted', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
  'review-fix': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'luna', logical_model: 'luna', effort: 'max' }),
    Object.freeze({ name: 'repeat', model_key: 'sol', logical_model: 'sol', effort: 'high' }),
    Object.freeze({ name: 'repeat_exhausted', model_key: 'sol', logical_model: 'sol', effort: 'xhigh' }),
  ]),
});

// Claude has its own native grid. These entries name Claude aliases directly;
// no Terra/Sol/Luna/Astra translation is involved. The existing alias palette
// is consumed only as a set of supported concrete Claude selections.
const CLAUDE_ROLE_RUNG_DEFINITIONS = Object.freeze({
  research: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'very-complex', model_key: 'opus', effort: 'high' }),
  ]),
  decomposition: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'critical', model_key: 'opus', effort: 'high' }),
  ]),
  executor: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sonnet', effort: 'max' }),
    Object.freeze({ name: 'critical', model_key: 'opus', effort: 'low' }),
  ]),
  'pr-sentinel': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'sonnet', effort: 'high' }),
  ]),
  integrator: Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'critical', model_key: 'opus', effort: 'high' }),
  ]),
  'drift-check': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'high' }),
  ]),
  'arch-review': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'critical', model_key: 'opus', effort: 'high' }),
    Object.freeze({ name: 'ceiling', model_key: 'fable', effort: 'medium' }),
  ]),
  'ci-fix': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'repeat', model_key: 'opus', effort: 'high' }),
    Object.freeze({ name: 'repeat_exhausted', model_key: 'opus', effort: 'high' }),
  ]),
  'review-fix': Object.freeze([
    Object.freeze({ name: 'base', model_key: 'opus', effort: 'medium' }),
    Object.freeze({ name: 'repeat', model_key: 'opus', effort: 'high' }),
    Object.freeze({ name: 'repeat_exhausted', model_key: 'opus', effort: 'high' }),
  ]),
});

const RUNTIME_ROLE_RUNG_DEFINITIONS = Object.freeze({
  codex: CODEX_ROLE_RUNG_DEFINITIONS,
  claude: CLAUDE_ROLE_RUNG_DEFINITIONS,
});

const CODEX_ROLE_SIGNAL_RULES = Object.freeze({
  research: Object.freeze({
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
    repeat: Object.freeze({ rung: 'repeat', any: Object.freeze([{ signatureState: 'repeat' }]) }),
    repeat_exhausted: Object.freeze({ rung: 'repeat_exhausted', any: Object.freeze([{ signatureState: 'repeat_exhausted' }]) }),
  }),
  'review-fix': Object.freeze({
    repeat: Object.freeze({ rung: 'repeat', any: Object.freeze([{ signatureState: 'repeat' }]) }),
    repeat_exhausted: Object.freeze({ rung: 'repeat_exhausted', any: Object.freeze([{ signatureState: 'repeat_exhausted' }]) }),
  }),
  'pr-sentinel': Object.freeze({}),
  executor: Object.freeze({
    critical: Object.freeze({ rung: 'critical', any: Object.freeze([{ critical: true }, { checkpoint: true }]) }),
  }),
  'drift-check': Object.freeze({}),
});

const CLAUDE_ROLE_SIGNAL_RULES = Object.freeze({
  research: Object.freeze({
    'very-complex': Object.freeze({ rung: 'very-complex', any: Object.freeze([{ complexity: 'very-complex' }]) }),
  }),
  decomposition: CODEX_ROLE_SIGNAL_RULES.decomposition,
  executor: CODEX_ROLE_SIGNAL_RULES.executor,
  'pr-sentinel': Object.freeze({}),
  integrator: CODEX_ROLE_SIGNAL_RULES.integrator,
  'drift-check': Object.freeze({}),
  'arch-review': Object.freeze({
    critical: Object.freeze({ rung: 'critical', any: Object.freeze([{ critical: true }, { checkpoint: true }, { contested: true }]) }),
    ceiling: Object.freeze({ rung: 'ceiling', any: Object.freeze([{ inputTokens: { gt_policy: 'window_threshold_tokens' } }]) }),
  }),
  'ci-fix': CODEX_ROLE_SIGNAL_RULES['ci-fix'],
  'review-fix': CODEX_ROLE_SIGNAL_RULES['review-fix'],
});

const RUNTIME_ROLE_SIGNAL_RULES = Object.freeze({
  codex: CODEX_ROLE_SIGNAL_RULES,
  claude: CLAUDE_ROLE_SIGNAL_RULES,
});

// Backwards-compatible names retain Codex's role-neutral API shape for callers
// that only inspect the Codex grid. Resolution itself always uses the runtime
// keyed tables above.
const ROLE_RUNG_DEFINITIONS = CODEX_ROLE_RUNG_DEFINITIONS;
const ROLE_SIGNAL_RULES = CODEX_ROLE_SIGNAL_RULES;

function runtimeModelFor(runtime, modelKey) {
  const model = CANONICAL_MODEL_MAPPINGS[runtime] && CANONICAL_MODEL_MAPPINGS[runtime][modelKey];
  if (!model) refuse('UNSUPPORTED_SELECTION', `no ${runtime} model is registered for native model ${modelKey}`);
  return model;
}

function rungsFor(runtime, role) {
  const rungs = RUNTIME_ROLE_RUNG_DEFINITIONS[runtime] && RUNTIME_ROLE_RUNG_DEFINITIONS[runtime][role];
  if (!rungs) refuse('UNSUPPORTED_SELECTION', `no ${runtime} rung grid is registered for role ${role}`);
  return rungs;
}

function signalRulesFor(runtime, role) {
  return (RUNTIME_ROLE_SIGNAL_RULES[runtime] && RUNTIME_ROLE_SIGNAL_RULES[runtime][role]) || {};
}

function selectionFor(runtime, rung) {
  const model = runtimeModelFor(runtime, rung.model_key);
  return {
    model_key: rung.model_key,
    logical_model: rung.model_key,
    model,
    effort: rung.effort,
  };
}

function repairPrerequisitesFromRungs(runtime) {
  const result = {};
  for (const role of REPAIR_ROLES) {
    const rungs = rungsFor(runtime, role);
    const prerequisites = {};
    for (let index = 1; index < rungs.length; index++) {
      const predecessor = rungs[index - 1];
      const current = rungs[index];
      const predecessorSelection = selectionFor(runtime, predecessor);
      prerequisites[current.name] = Object.freeze({
        model_key: predecessor.model_key,
        logical_model: predecessor.model_key,
        model: predecessorSelection.model,
        effort: predecessor.effort,
      });
    }
    result[role] = Object.freeze(prerequisites);
  }
  return Object.freeze(result);
}

// Receipt gates must track the actual ordered ladder. Keeping a second set of
// model/effort strings beside each runtime's rung grid lets the fingerprint
// change without changing enforcement when one table is edited in isolation.
const RUNTIME_REPAIR_PREREQUISITES = deepFreeze({
  codex: repairPrerequisitesFromRungs('codex'),
  claude: repairPrerequisitesFromRungs('claude'),
});
const REPAIR_PREREQUISITES = RUNTIME_REPAIR_PREREQUISITES.codex;

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
  // `roles`, `signal_rules`, and `repair_prerequisites` remain the Codex
  // compatibility view. The runtime-keyed fields are the authoritative grids.
  roles: ROLE_RUNG_DEFINITIONS,
  role_rungs: RUNTIME_ROLE_RUNG_DEFINITIONS,
  role_classes: ROLE_CLASSES,
  signal_rules: ROLE_SIGNAL_RULES,
  runtime_signal_rules: RUNTIME_ROLE_SIGNAL_RULES,
  repair_prerequisites: REPAIR_PREREQUISITES,
  runtime_repair_prerequisites: RUNTIME_REPAIR_PREREQUISITES,
});

const POLICY_HASH = fingerprintPolicy(POLICY);

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
    // Keep a boundary-verified receipt's identity through resolution so
    // validateResolution can re-check its unforgeable provenance.  All other
    // caller data remains copied before policy evaluation.
    let boundaryVerified = false;
    try {
      const boundary = require('./dispatch-boundary.cjs');
      boundaryVerified = typeof boundary.isBoundaryVerifiedReceipt === 'function'
        && boundary.isBoundaryVerifiedReceipt(signals.priorApplied);
    } catch (_) {
      // A direct resolver has no boundary provenance.
    }
    out.priorApplied = boundaryVerified ? signals.priorApplied : cloneValue(signals.priorApplied);
  }
  return out;
}

function requireRepairReceiptEvidence(runtime, role, signals) {
  const prerequisite = RUNTIME_REPAIR_PREREQUISITES[runtime]
    && RUNTIME_REPAIR_PREREQUISITES[runtime][role]
    && RUNTIME_REPAIR_PREREQUISITES[runtime][role][signals && signals.signatureState];
  if (!prerequisite) return;
  const prior = signals && signals.priorApplied;
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) {
    refuse(
      'MISSING_RECEIPT',
      `${role} ${signals.signatureState} escalation requires the immediately preceding compliant applied receipt`,
      { role, signatureState: signals.signatureState },
    );
  }
  const proof = prior.compliance_proof;
  if (prior.compliance !== 'verified'
      || !proof || typeof proof !== 'object' || Array.isArray(proof)
      || proof.status !== 'verified'
      || proof.boundary !== 'adr-014.dispatch-boundary'
      || proof.policy_hash !== prior.policy_hash
      || proof.dispatch_id !== prior.dispatch_id
      || proof.launch_id !== prior.launch_id) {
    refuse(
      'UNVERIFIED_RECEIPT',
      `${role} ${signals.signatureState} escalation requires receipt evidence issued by the routed dispatch boundary`,
      { role, signatureState: signals.signatureState },
    );
  }
  // A receipt-shaped value is application input, not authority.  The dispatch
  // boundary adds an object-identity capability only after it has read the
  // matching finalized receipt from its durable recorder.  Keep this lookup
  // lazy: dispatch-boundary imports this module during its own initialization.
  let boundaryVerified = false;
  try {
    const boundary = require('./dispatch-boundary.cjs');
    boundaryVerified = typeof boundary.isBoundaryVerifiedReceipt === 'function'
      && boundary.isBoundaryVerifiedReceipt(prior);
  } catch (_) {
    // A repair resolver loaded without its boundary cannot establish durable
    // provenance and must fail closed below.
  }
  if (!boundaryVerified) {
    refuse(
      'UNVERIFIED_RECEIPT',
      `${role} ${signals.signatureState} escalation requires receipt evidence verified by the durable dispatch boundary`,
      { role, signatureState: signals.signatureState },
    );
  }
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

function ruleMatchesSignal(rule, signals, signal, threshold) {
  if (!rule || !Array.isArray(rule.any)) return false;
  return rule.any.some((condition) => hasOwn(condition, signal)
    && ruleMatches({ any: [condition] }, signals, threshold));
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
  const runtime = options.runtime === undefined ? 'codex' : normalizeRuntime(options.runtime);
  const threshold = WINDOW_THRESHOLD_TOKENS;
  const roleRules = signalRulesFor(runtime, normalizedRole);
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
      FIXED_ROLES.has(normalizedRole)
        ? 'global risk is intentionally inert for a fixed role'
        : 'risk is recorded context, not a role-scoped escalation signal',
    );
  }
  if (signals.critical === true) {
    const applies = ruleMatchesSignal(roleRules.critical, signals, 'critical', threshold);
    const reason = applies
      ? `signals.critical=true selects the ${normalizedRole} critical rung`
      : FIXED_ROLES.has(normalizedRole)
        ? 'global critical state cannot promote a fixed role'
        : `critical state does not promote ${normalizedRole}`;
    add('critical', 'signals.critical', true, applies, applies ? 'critical' : null, reason);
    if (applies) selected.push({ signal: 'critical', rung: 'critical', reason });
  }
  if (signals.checkpoint === true) {
    const applies = ruleMatchesSignal(roleRules.critical, signals, 'checkpoint', threshold);
    const reason = applies
      ? `signals.checkpoint=true selects the ${normalizedRole} critical rung`
      : FIXED_ROLES.has(normalizedRole)
        ? 'global checkpoint state cannot promote a fixed role'
        : `checkpoint state does not promote ${normalizedRole}`;
    add('checkpoint', 'signals.checkpoint', true, applies, applies ? 'critical' : null, reason);
    if (applies) selected.push({ signal: 'checkpoint', rung: 'critical', reason });
  }
  if (signals.contested === true) {
    const applies = ruleMatchesSignal(roleRules.critical, signals, 'contested', threshold);
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
    const windowRule = roleRules.ceiling || roleRules.critical;
    const windowRung = windowRule && windowRule.rung ? windowRule.rung : 'critical';
    const applies = measuredWindow && ruleMatchesSignal(windowRule, signals, 'inputTokens', threshold);
    add(
      'window',
      'signals.inputTokens',
      signals.inputTokens,
      applies,
      applies ? windowRung : null,
      applies
        ? `${reason}; selects the ${normalizedRole} ${windowRung} rung`
        : FIXED_ROLES.has(normalizedRole) && measuredWindow
          ? `${reason}; window pressure cannot promote a fixed role`
          : reason,
    );
    if (applies) selected.push({ signal: 'window', rung: windowRung, reason: `${reason}; selects the ${normalizedRole} ${windowRung} rung` });
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

function dispatchIdFromInput(input) {
  if (hasOwn(input, 'dispatchId')) {
    refuse(
      'UNSUPPORTED_SELECTION',
      'dispatchId is not part of the ADR-014 resolver interface; use dispatch_id',
    );
  }
  return hasOwn(input, 'dispatch_id')
    ? opaqueId(input.dispatch_id, 'dispatch_id')
    : undefined;
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
  for (const field of ['model', 'requested_model', 'applied_model']) {
    if (hasOwn(input, field)) add(`input.${field}`, { model: input[field] });
  }
  for (const field of ['effort', 'requested_effort', 'applied_effort', 'reasoning_effort']) {
    if (hasOwn(input, field)) add(`input.${field}`, { effort: input[field] });
  }
  if (hasOwn(input, 'backend')) add('input.backend', { backend: input.backend });
  if (hasOwn(input, 'mechanism')) add('input.mechanism', { mechanism: input.mechanism });
  if (hasOwn(input, 'agent_file')) add('input.agent_file', { agent_file: input.agent_file });
  for (const field of ['logical_model', 'logical_rung', 'rung', 'rung_index']) {
    if (hasOwn(input, field)) add(`input.${field}`, { [field]: input[field] });
  }

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
    for (const field of ['logical_model', 'logical_rung', 'rung', 'rung_index']) {
      if (override[field] !== undefined) {
        const want = field === 'logical_model'
          ? expected.logical_model
          : field === 'rung_index'
            ? expected.rung_index
            : expected.rung;
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
  const rungs = rungsFor(runtime, role);
  const evaluation = evaluateSignals(role, resolution.signals, { runtime });
  requireRepairReceiptEvidence(runtime, role, evaluation.signals);
  let expectedRung = rungs[0];
  const selectedNames = new Set(evaluation.selected.map((entry) => entry.rung));
  for (const candidate of rungs) {
    if (selectedNames.has(candidate.name)) expectedRung = candidate;
  }
  if (resolution.rung !== expectedRung.name
      || resolution.logical_rung !== expectedRung.name
      || resolution.rung_index !== rungs.indexOf(expectedRung)) {
    refuse('INVALID_RESOLUTION', `resolution rung ${JSON.stringify(resolution.rung)} is not authorized by its canonical signals for ${role}`, {
      expected: expectedRung.name,
      actual: resolution.rung,
    });
  }
  const firedNames = [];
  for (const reason of evaluation.reasons) {
    if (!firedNames.includes(reason.signal)) firedNames.push(reason.signal);
  }
  const selectedReasons = evaluation.selected.map((entry) => ({ ...entry }));
  const selectedRoute = selectedReasons.length
    ? selectedReasons.map((entry) => `${entry.signal}->${entry.rung}`).join('+')
    : 'base';
  const expectedRoute = `role=${role} rung=${expectedRung.name} model=${expectedRung.model_key} signals=${selectedRoute}`;
  if (resolution.route !== expectedRoute
      || stableStringify(resolution.signals_fired) !== stableStringify(firedNames)
      || stableStringify(resolution.signal_reasons) !== stableStringify(evaluation.reasons)
      || stableStringify(resolution.selected_signals) !== stableStringify(selectedReasons)) {
    refuse('INVALID_RESOLUTION', 'resolution signal provenance does not match the canonical policy evaluation', {
      expected: { route: expectedRoute, signals_fired: firedNames, signal_reasons: evaluation.reasons, selected_signals: selectedReasons },
      actual: { route: resolution.route, signals_fired: resolution.signals_fired, signal_reasons: resolution.signal_reasons, selected_signals: resolution.selected_signals },
    });
  }
  const rung = rungs.find((entry) => entry.name === resolution.rung);
  if (!rung || resolution.logical_rung !== resolution.rung) refuse('INVALID_RESOLUTION', `resolution rung ${JSON.stringify(resolution.rung)} is not valid for ${role}`);
  const selection = selectionFor(runtime, rung);
  const expectedModel = selection.model;
  if (resolution.model_key !== selection.model_key
      || resolution.logical_model !== selection.logical_model
      || resolution.model !== expectedModel
      || resolution.requested_model !== expectedModel) {
    refuse('INVALID_RESOLUTION', `resolution model does not match ${runtime} ${role} ${rung.name}`, { expected: expectedModel, actual: resolution.model });
  }
  if (!EFFORTS.includes(resolution.effort) || resolution.effort !== selection.effort || resolution.requested_effort !== selection.effort) {
    refuse('INVALID_RESOLUTION', `resolution effort does not match ${runtime} ${role} ${rung.name}`, { expected: selection.effort, actual: resolution.effort });
  }
  if (typeof resolution.route !== 'string' || resolution.route.trim() === '') refuse('INVALID_RESOLUTION', 'resolution route is required');
  if (typeof resolution.backend !== 'string' || resolution.backend.trim() === '') refuse('INVALID_RESOLUTION', 'resolution backend is required');
  if (typeof resolution.mechanism !== 'string' || resolution.mechanism.trim() === '') refuse('INVALID_RESOLUTION', 'resolution mechanism is required');
  const metadata = launchMetadata(runtime, role, rung.name, expectedModel, selection.effort);
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
    if (effort !== selection.effort) refuse('INVALID_RESOLUTION', 'launch arguments must carry the resolved effort');
  }
  if (options.requireDispatchId && !nonEmptyString(resolution.dispatch_id)) refuse('INVALID_RESOLUTION', 'dispatch id is required at the dispatch boundary');
  return true;
}

function resolveDispatch(input) {
  assertPlainObject(input, 'dispatch input');
  if (arguments.length > 1) {
    refuse('UNVERIFIED_RECEIPT', 'receipt verification authority is private to the dispatch boundary');
  }
  const runtime = normalizeRuntime(input.runtime);
  const role = normalizeRole(input.role);
  const signals = normalizeSignals(input.signals);
  requireRepairReceiptEvidence(runtime, role, signals);
  const evaluation = evaluateSignals(role, signals, { runtime });
  const rungs = rungsFor(runtime, role);
  let rung = rungs[0];

  const selectedNames = new Set(evaluation.selected.map((entry) => entry.rung));
  // Highest rung wins when several signals fire; the policy retains all of them
  // in `signal_reasons` and `signals_fired` rather than short-circuiting at the
  // first match.
  for (const candidate of rungs) {
    if (selectedNames.has(candidate.name)) rung = candidate;
  }

  const selection = selectionFor(runtime, rung);
  const metadata = launchMetadata(runtime, role, rung.name, selection.model, selection.effort);
  const dispatchId = dispatchIdFromInput(input);
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
    model_key: selection.model_key,
    logical_model: selection.logical_model,
    logical_rung: rung.name,
    rung: rung.name,
    rung_index: rungs.indexOf(rung),
    model: selection.model,
    effort: selection.effort,
    requested_model: selection.model,
    requested_effort: selection.effort,
    route: `role=${role} rung=${rung.name} model=${selection.model_key} signals=${selectedRoute}`,
    backend: metadata.backend,
    mechanism: metadata.mechanism,
    signals_fired: firedNames,
    signal_reasons: evaluation.reasons,
    selected_signals: selectedReasons,
    signals: evaluation.signals,
    ...(metadata.agent_file ? { agent_file: metadata.agent_file } : { agent_file: null }),
    ...(metadata.launch_arguments ? { launch_arguments: metadata.launch_arguments } : {}),
    ...(dispatchId !== undefined
      ? { dispatch_id: dispatchId }
      : {}),
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
  CODEX_ROLE_RUNG_DEFINITIONS,
  CLAUDE_ROLE_RUNG_DEFINITIONS,
  RUNTIME_ROLE_RUNG_DEFINITIONS,
  RUNTIME_ROLE_SIGNAL_RULES,
  RUNTIME_REPAIR_PREREQUISITES,
  DYNAMIC_ROLES: Object.freeze([...DYNAMIC_ROLES]),
  REPAIR_ROLES: Object.freeze([...REPAIR_ROLES]),
  JUDGEMENT_ROLES: Object.freeze([...JUDGEMENT_ROLES]),
  FIXED_ROLES: Object.freeze([...FIXED_ROLES]),
  // Compatibility export for callers that still use the old class name. The
  // class is no longer tied to a Luna model; each runtime owns its fixed tuple.
  FIXED_LUNA_ROLES: Object.freeze([...FIXED_ROLES]),
  CODEX_STATIC_ROLES: Object.freeze([...CODEX_STATIC_ROLES]),
  stableStringify,
  fingerprintPolicy,
  normalizeSignals,
  evaluateSignals,
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
    } else {
      throw policyError('USAGE', 'usage: model-policy-internal.cjs fingerprint');
    }
  } catch (error) {
    process.stderr.write(`model-policy: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
