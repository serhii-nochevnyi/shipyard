#!/usr/bin/env node
'use strict';

// The only launch boundary for routed delivery.  Runtime adapters are injected
// rather than imported here: this keeps the policy testable without a Claude or
// Codex host and makes a missing adapter a refusal instead of an implicit
// session/CLI fallback.

const crypto = require('crypto');
const defaultPolicy = require('./model-policy.cjs');
const canonicalResolveDispatch = defaultPolicy.resolveDispatch;
const canonicalValidateResolution = defaultPolicy.validateResolution;
const canonicalStableStringify = defaultPolicy.stableStringify;

const OBSERVATION_UNKNOWN = 'unknown';

function boundaryError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'DispatchBoundaryError';
  error.code = code;
  error.details = details;
  return error;
}

function refuse(code, message, details = {}) {
  throw boundaryError(code, message, details);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function snapshot(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) refuse('INVALID_VALUE', 'dispatch data cannot contain circular references');
  seen.set(value, true);
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) result[key] = snapshot(child, seen);
  seen.delete(value);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_RECEIPT', `${label} must be a non-empty, whitespace-free string`, { label });
  }
  return value;
}

function newDispatchId() {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `dispatch-${Date.now().toString(36)}-${suffix}`;
}

function adapterFor(adapters, runtime) {
  const value = adapters && adapters[runtime];
  if (typeof value === 'function') return { launch: value };
  if (isObject(value)) return value;
  refuse(
    'MISSING_ADAPTER',
    `no ${runtime} dispatch adapter was injected; refusing to fall back to an inherited session or CLI default`,
    { runtime },
  );
}

function invokeSync(fn, receiver, args, label) {
  const result = fn.apply(receiver, args);
  if (result && typeof result.then === 'function') {
    refuse('ASYNC_ADAPTER', `${label} returned a Promise; the synchronous boundary cannot prove its receipt`, { label });
  }
  return result;
}

function invokeLaunch(fn, receiver, args) {
  return fn.apply(receiver, args);
}

function adapterObservationUnavailable(adapter) {
  return Boolean(
    adapter && (
      adapter.observationUnavailable === true
      || adapter.observes === false
      || adapter.observation === 'unavailable'
      || adapter.capabilities && (
        adapter.capabilities.observedModel === false
        || adapter.capabilities.observedEffort === false
        || adapter.capabilities.observation === 'unavailable'
      )
    ),
  );
}

function adapterSupports(adapter, resolution) {
  if (Array.isArray(adapter.supportedModels) && !adapter.supportedModels.includes(resolution.model)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved model ${resolution.model}`, { model: resolution.model });
  }
  if (adapter.supportedModels instanceof Set && !adapter.supportedModels.has(resolution.model)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved model ${resolution.model}`, { model: resolution.model });
  }
  if (Array.isArray(adapter.supportedEfforts) && !adapter.supportedEfforts.includes(resolution.effort)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved effort ${resolution.effort}`, { effort: resolution.effort });
  }
  if (adapter.supportedEfforts instanceof Set && !adapter.supportedEfforts.has(resolution.effort)) {
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter does not support resolved effort ${resolution.effort}`, { effort: resolution.effort });
  }
  const supports = typeof adapter.supports === 'function'
    ? invokeSync(adapter.supports, adapter, [resolution], 'adapter.supports')
    : true;
  if (supports === false || supports && supports.valid === false) {
    const reason = supports && typeof supports.reason === 'string' ? `: ${supports.reason}` : '';
    refuse('UNSUPPORTED_SELECTION', `${resolution.runtime} adapter cannot apply the resolved selection${reason}`, { resolution });
  }
}

function validateWithAdapter(resolution, adapter) {
  canonicalValidateResolution(resolution, { requireDispatchId: true });
  adapterSupports(adapter, resolution);
  let validatedResolution = resolution;
  if (resolution.agent_file) {
    if (typeof adapter.validateGeneratedAgent !== 'function') {
      refuse('STALE_GENERATED_AGENT', `Codex static dispatch requires ${resolution.agent_file} existence/content/fingerprint validation before launch`, { agent_file: resolution.agent_file });
    }
    const evidence = invokeSync(adapter.validateGeneratedAgent, adapter, [resolution], 'adapter.validateGeneratedAgent');
    if (!isObject(evidence) || evidence.valid !== true || evidence.exists !== true || evidence.content_verified !== true || evidence.policy_hash !== resolution.policy_hash || evidence.agent_file !== resolution.agent_file) {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} is missing, stale, or not bound to the active policy fingerprint`, { expected: { agent_file: resolution.agent_file, policy_hash: resolution.policy_hash }, actual: evidence });
    }
    if (typeof evidence.agent_file_digest !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.agent_file_digest)) {
      refuse('STALE_GENERATED_AGENT', `generated agent ${resolution.agent_file} did not return a content digest`, { agent_file: resolution.agent_file });
    }
    validatedResolution = deepFreeze(snapshot({ ...resolution, agent_file_digest: evidence.agent_file_digest }));
  }
  if (typeof adapter.validate === 'function') {
    const result = invokeSync(adapter.validate, adapter, [validatedResolution], 'adapter.validate');
    if (result === false || result && result.valid === false) {
      const reason = result && typeof result.reason === 'string' ? `: ${result.reason}` : '';
      refuse('UNSUPPORTED_SELECTION', `adapter validation refused the resolved selection${reason}`, { resolution: validatedResolution });
    }
  }
  return validatedResolution;
}

function unwrapReceipt(value) {
  if (isObject(value) && isObject(value.application_receipt)) return value.application_receipt;
  if (isObject(value) && isObject(value.receipt)) return value.receipt;
  return value;
}

function observedValue(receipt, field, applied, allowUnknown) {
  if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
    if (allowUnknown) return OBSERVATION_UNKNOWN;
    refuse('MISSING_RECEIPT', `application receipt is missing ${field}`, { field });
  }
  const value = receipt[field];
  if (value === OBSERVATION_UNKNOWN) {
    if (!allowUnknown) refuse('NONCOMPLIANT_RECEIPT', `${field}=unknown is not permitted when the adapter claims observation support`, { field });
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '' || /[\s\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_RECEIPT', `${field} must be a concrete whitespace-free value or unknown`, { field });
  }
  if (value !== applied) {
    refuse('NONCOMPLIANT_RECEIPT', `${field} ${JSON.stringify(value)} contradicts applied value ${JSON.stringify(applied)}`, { field, applied, observed: value });
  }
  return value;
}

function verifyApplicationReceipt(resolution, rawReceipt, options = {}) {
  const receipt = unwrapReceipt(rawReceipt);
  if (!isObject(receipt)) {
    refuse('MISSING_RECEIPT', 'launch did not return an application receipt; a successful process exit is not evidence of application');
  }
  const requiredFields = [
    'receipt_type',
    'runtime',
    'role',
    'dispatch_id',
    'launch_id',
    'requested_model',
    'requested_effort',
    'applied_model',
    'applied_effort',
    'policy_hash',
  ];
  if (options.requireComplianceProof !== false) {
    requiredFields.push('compliance', 'compliance_proof');
  }
  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(receipt, field)) {
      refuse('MISSING_RECEIPT', `application receipt is missing ${field}`, { field });
    }
  }
  nonEmpty(receipt.runtime, 'runtime');
  nonEmpty(receipt.role, 'role');
  nonEmpty(receipt.dispatch_id, 'dispatch_id');
  nonEmpty(receipt.policy_hash, 'policy_hash');
  if (receipt.runtime !== resolution.runtime) {
    refuse('NONCOMPLIANT_RECEIPT', `application receipt runtime ${JSON.stringify(receipt.runtime)} does not match ${resolution.runtime}`, { expected: resolution.runtime, actual: receipt.runtime });
  }
  if (receipt.receipt_type !== 'adr-014.application' || receipt.role !== resolution.role) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt type or role does not match the immutable resolution', { expected: { receipt_type: 'adr-014.application', role: resolution.role }, actual: { receipt_type: receipt.receipt_type, role: receipt.role } });
  }
  if (receipt.policy_hash !== resolution.policy_hash) {
    refuse('STALE_POLICY', 'application receipt policy fingerprint does not match the resolved policy', { expected: resolution.policy_hash, actual: receipt.policy_hash });
  }
  if (receipt.dispatch_id !== resolution.dispatch_id) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt dispatch_id does not match the boundary dispatch', { expected: resolution.dispatch_id, actual: receipt.dispatch_id });
  }
  nonEmpty(receipt.launch_id, 'launch_id');
  if (receipt.requested_model !== resolution.requested_model || receipt.requested_effort !== resolution.requested_effort) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt requested values do not match the immutable resolution', {
      expected: { model: resolution.requested_model, effort: resolution.requested_effort },
      actual: { model: receipt.requested_model, effort: receipt.requested_effort },
    });
  }
  if (receipt.applied_model !== resolution.model || receipt.applied_effort !== resolution.effort) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt applied values do not match the resolved selection', {
      expected: { model: resolution.model, effort: resolution.effort },
      actual: { model: receipt.applied_model, effort: receipt.applied_effort },
    });
  }
  if (resolution.agent_file) {
    if (receipt.agent_file !== resolution.agent_file) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt agent_file does not match the resolved generated file', { expected: resolution.agent_file, actual: receipt.agent_file });
    }
  } else if (receipt.agent_file !== undefined && receipt.agent_file !== null) {
    refuse('NONCOMPLIANT_RECEIPT', 'a dynamic/Workflow launch must not claim a static agent file', { actual: receipt.agent_file });
  }
  if (receipt.backend !== undefined && receipt.backend !== resolution.backend) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt backend does not match the resolved backend', { expected: resolution.backend, actual: receipt.backend });
  }
  if (receipt.mechanism !== undefined && receipt.mechanism !== resolution.mechanism) {
    refuse('NONCOMPLIANT_RECEIPT', 'application receipt mechanism does not match the resolved mechanism', { expected: resolution.mechanism, actual: receipt.mechanism });
  }
  if (options.requireComplianceProof !== false) {
    if (receipt.compliance !== 'verified' || !isObject(receipt.compliance_proof)) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt must carry boundary compliance proof');
    }
    if (receipt.compliance_proof.status !== 'verified'
        || receipt.compliance_proof.boundary !== 'adr-014.dispatch-boundary'
        || receipt.compliance_proof.policy_hash !== receipt.policy_hash
        || receipt.compliance_proof.dispatch_id !== receipt.dispatch_id
        || receipt.compliance_proof.launch_id !== receipt.launch_id) {
      refuse('NONCOMPLIANT_RECEIPT', 'application receipt compliance proof is incomplete or contradictory');
    }
  }
  if (resolution.agent_file) {
    if (typeof resolution.agent_file_digest !== 'string' || receipt.agent_file_digest !== resolution.agent_file_digest) {
      refuse('NONCOMPLIANT_RECEIPT', 'static Codex receipt must carry the validated generated-agent digest', { expected: resolution.agent_file_digest, actual: receipt.agent_file_digest });
    }
  }

  const adapter = options.adapter || null;
  const allowUnknown = adapterObservationUnavailable(adapter);
  const observedModel = observedValue(receipt, 'observed_model', receipt.applied_model, allowUnknown);
  const observedEffort = observedValue(receipt, 'observed_effort', receipt.applied_effort, allowUnknown);
  const normalized = {
    ...snapshot(receipt),
    observed_model: observedModel,
    observed_effort: observedEffort,
  };
  return deepFreeze(normalized);
}

function withoutBoundaryClaims(evidence) {
  const {
    compliance: ignoredCompliance,
    compliance_proof: ignoredProof,
    observation_unavailable: ignoredObservationCapability,
    ...applicationEvidence
  } = evidence;
  return applicationEvidence;
}

function finalizeApplicationReceipt(resolution, evidence, adapter) {
  const finalized = {
    ...withoutBoundaryClaims(evidence),
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: evidence.launch_id,
    },
  };
  return verifyApplicationReceipt(resolution, finalized, { adapter });
}

function recorderFor(options, adapter) {
  if (typeof options.recorder === 'function') return options.recorder;
  if (options.recorder && typeof options.recorder.record === 'function') {
    return options.recorder.record.bind(options.recorder);
  }
  if (adapter && typeof adapter.record === 'function') return adapter.record.bind(adapter);
  return null;
}

function createDispatchBoundary(options = {}) {
  if (!isObject(options)) refuse('INVALID_INPUT', 'boundary options must be an object');
  const policy = options.policy || defaultPolicy;
  if (policy !== defaultPolicy) {
    refuse('NONCANONICAL_POLICY', 'dispatch is bound to the canonical ADR-014 policy; custom policy injection is not permitted');
  }
  if (!policy || typeof policy.resolveDispatch !== 'function' || typeof policy.validateResolution !== 'function') {
    refuse('INVALID_INPUT', 'boundary policy must expose resolveDispatch and validateResolution');
  }
  const adapters = options.adapters || {};
  const trustedReceipts = new Map();
  const latestReceiptByTuple = new Map();
  const consumedReceiptIds = new Set();

  function receiptTupleKey(runtime, role) {
    return `${runtime}:${role}`;
  }

  function verifyPriorReceipt(receipt, expected = {}) {
    if (!isObject(receipt)) return null;
    const stored = trustedReceipts.get(receipt.dispatch_id);
    if (!stored || stableReceipt(receipt) !== stableReceipt(stored)) return null;
    if (receipt.runtime !== expected.runtime || receipt.role !== expected.role) return null;
    if (expected.previousDispatchId !== receipt.dispatch_id) return null;
    if (expected.expectedModel !== undefined && receipt.applied_model !== expected.expectedModel) return null;
    if (expected.expectedEffort !== undefined && receipt.applied_effort !== expected.expectedEffort) return null;
    const tuple = receiptTupleKey(receipt.runtime, receipt.role);
    if (latestReceiptByTuple.get(tuple) !== receipt.dispatch_id) return null;
    if (consumedReceiptIds.has(receipt.dispatch_id)) return null;
    consumedReceiptIds.add(receipt.dispatch_id);
    return stored;
  }

  function registerReceipt(receipt) {
    const stored = deepFreeze(snapshot(receipt));
    const prior = trustedReceipts.get(stored.dispatch_id);
    if (prior && stableReceipt(prior) !== stableReceipt(stored)) {
      refuse('NONCOMPLIANT_RECEIPT', 'dispatch id was already registered with different application evidence', { dispatch_id: stored.dispatch_id });
    }
    if (prior) return prior;
    trustedReceipts.set(stored.dispatch_id, stored);
    latestReceiptByTuple.set(receiptTupleKey(stored.runtime, stored.role), stored.dispatch_id);
    return stored;
  }

  function stableReceipt(receipt) {
    return canonicalStableStringify(receipt);
  }

  function resolve(input) {
    if (!isObject(input)) refuse('INVALID_INPUT', 'dispatch input must be an object');
    const withId = Object.prototype.hasOwnProperty.call(input, 'dispatch_id')
      || Object.prototype.hasOwnProperty.call(input, 'dispatchId')
      ? input
      : { ...input, dispatch_id: newDispatchId() };
    return deepFreeze(snapshot(canonicalResolveDispatch(withId, {
      receiptVerifier: verifyPriorReceipt,
    })));
  }

  function validate(resolution, validateOptions = {}) {
    const adapter = validateOptions.adapter || adapterFor(validateOptions.adapters || adapters, resolution && resolution.runtime);
    validateWithAdapter(resolution, adapter);
    return true;
  }

  function receipt(resolution, rawReceipt, receiptOptions = {}) {
    return verifyApplicationReceipt(resolution, rawReceipt, {
      adapter: receiptOptions.adapter || adapterFor(receiptOptions.adapters || adapters, resolution && resolution.runtime),
    });
  }

  function dispatch(input, context = {}) {
    const resolution = resolve(input);
    const adapter = adapterFor(adapters, resolution.runtime);
    const record = recorderFor(options, adapter);
    if (!record) {
      refuse('RECORD_UNAVAILABLE', 'durable dispatch recording is mandatory; refusing to launch without a recorder');
    }
    const stages = [
      { stage: 'resolve', status: 'passed', policy_version: resolution.policy_version, policy_hash: resolution.policy_hash },
    ];
    const validatedResolution = validateWithAdapter(resolution, adapter);
    stages.push({ stage: 'validate', status: 'passed' });
    const finish = (launchResult) => {
      const rawReceipt = unwrapReceipt(launchResult);
      const applicationEvidence = verifyApplicationReceipt(validatedResolution, rawReceipt, {
        adapter,
        requireComplianceProof: false,
      });
      const strippedEvidence = withoutBoundaryClaims(applicationEvidence);
      stages.push({ stage: 'launch', status: 'passed', launch_id: strippedEvidence.launch_id });

      const baseTrace = {
      dispatch_id: validatedResolution.dispatch_id,
      policy_version: validatedResolution.policy_version,
      policy_hash: validatedResolution.policy_hash,
      runtime: validatedResolution.runtime,
      role: validatedResolution.role,
      logical_rung: validatedResolution.logical_rung,
      rung: validatedResolution.rung,
      route: validatedResolution.route,
      backend: validatedResolution.backend,
      mechanism: validatedResolution.mechanism,
      resolution: validatedResolution,
      requested: { model: validatedResolution.requested_model, effort: validatedResolution.requested_effort },
      applied: { model: strippedEvidence.applied_model, effort: strippedEvidence.applied_effort },
      observed: { model: strippedEvidence.observed_model, effort: strippedEvidence.observed_effort },
      requested_model: validatedResolution.requested_model,
      requested_effort: validatedResolution.requested_effort,
      applied_model: strippedEvidence.applied_model,
      applied_effort: strippedEvidence.applied_effort,
      observed_model: strippedEvidence.observed_model,
      observed_effort: strippedEvidence.observed_effort,
      application_evidence: strippedEvidence,
      receipt: strippedEvidence,
      };
      const recordInput = deepFreeze(snapshot({ ...baseTrace, trace: [...stages] }));
      const recordResult = invokeSync(record, null, [recordInput], 'dispatch recorder');
      if (recordResult !== true && !(recordResult && recordResult.recorded === true)) {
        refuse('RECORD_FAILED', 'durable dispatch recording did not return affirmative acknowledgement; the launch is not compliant', { dispatch_id: resolution.dispatch_id });
      }
      stages.push({ stage: 'record', status: 'passed' });
      const applicationReceipt = finalizeApplicationReceipt(validatedResolution, applicationEvidence, adapter);
      stages.push({ stage: 'receipt', status: 'passed', launch_id: applicationReceipt.launch_id });
      registerReceipt(applicationReceipt);
      return deepFreeze(snapshot({
        ...baseTrace,
        applied: { model: applicationReceipt.applied_model, effort: applicationReceipt.applied_effort },
        observed: { model: applicationReceipt.observed_model, effort: applicationReceipt.observed_effort },
        applied_model: applicationReceipt.applied_model,
        applied_effort: applicationReceipt.applied_effort,
        observed_model: applicationReceipt.observed_model,
        observed_effort: applicationReceipt.observed_effort,
        receipt: applicationReceipt,
        trace: stages,
      }));
    };
    const fn = typeof adapter.launch === 'function'
      ? adapter.launch
      : typeof adapter.apply === 'function'
        ? adapter.apply
        : null;
    if (!fn) refuse('MISSING_ADAPTER', `${resolution.runtime} dispatch adapter has no launch method`, { runtime: resolution.runtime });
    const launchResult = invokeLaunch(fn, adapter, [validatedResolution, context]);
    if (launchResult && typeof launchResult.then === 'function') {
      return launchResult.then(finish);
    }
    return finish(launchResult);
  }

  return Object.freeze({ resolve, validate, receipt, dispatch });
}

function resolveDispatch(input) {
  return defaultPolicy.resolveDispatch(input);
}

function validateDispatch(resolution, options = {}) {
  return createDispatchBoundary(options).validate(resolution, options);
}

function dispatch(input, options = {}) {
  return createDispatchBoundary(options).dispatch(input, options.context || {});
}

module.exports = {
  OBSERVATION_UNKNOWN,
  newDispatchId,
  createDispatchBoundary,
  resolveDispatch,
  validateDispatch,
  verifyApplicationReceipt,
  dispatch,
  dispatchThroughBoundary: dispatch,
  boundaryError,
};
