'use strict';

// Claude is a workflow-native runtime. The host must advertise the exact
// aliases and effort values it can apply, and its launch method must return
// application evidence. The dispatch boundary is the only layer that turns
// this evidence into a compliant, durably recorded receipt.
const policy = require('./model-policy.cjs');
const { CLAUDE_MODEL_ALIASES } = require('./runtime-adapters.cjs');
const { createDispatchBoundary } = require('./dispatch-boundary.cjs');

const REPAIR = 'Install an ADR-014-capable Claude host with explicit workflow model and effort support; provide current host capabilities and retry the exact selection.';
const WORKFLOW_CAPABILITIES = Object.freeze({
  supportedModels: Object.freeze(Object.values(CLAUDE_MODEL_ALIASES)),
  supportedEfforts: Object.freeze(['high', 'medium', 'max']),
  observedModel: false,
  observedEffort: false,
});

function refuse(code, message) {
  throw policy.policyError(code, message + '. ' + REPAIR);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAvailability(resolution, capabilities) {
  policy.validateResolution(resolution);
  if (resolution.runtime !== 'claude') {
    refuse('UNSUPPORTED_SELECTION', 'Claude adapter requires runtime claude');
  }
  if (!object(capabilities)) {
    refuse('UNSUPPORTED_SELECTION', 'missing Claude host capabilities');
  }
  for (const [key, value] of [
    ['supportedModels', resolution.model],
    ['supportedEfforts', resolution.effort],
  ]) {
    if (!Array.isArray(capabilities[key]) || !capabilities[key].includes(value)) {
      refuse('UNSUPPORTED_SELECTION', 'host ' + key + ' does not explicitly support ' + value);
    }
  }
  if (capabilities.supportedSelections !== undefined
      && (!Array.isArray(capabilities.supportedSelections)
        || !capabilities.supportedSelections.some((entry) => object(entry)
          && entry.model === resolution.model && entry.effort === resolution.effort))) {
    refuse('UNSUPPORTED_SELECTION', 'host does not support the required model/effort pair');
  }
  return true;
}

function validateLaunchContext(resolution, context) {
  if (!object(context)) refuse('INVALID_INPUT', 'launch context must be an object');
  for (const source of [context, context.launch_arguments, context.selection, context.session]) {
    if (source === undefined) continue;
    if (!object(source)) refuse('CONFLICTING_OVERRIDE', 'launch selection overrides must be objects');
    for (const [field, expected] of [
      ['runtime', resolution.runtime],
      ['role', resolution.role],
      ['rung', resolution.rung],
      ['logical_rung', resolution.logical_rung],
      ['model', resolution.model],
      ['requested_model', resolution.model],
      ['applied_model', resolution.model],
      ['effort', resolution.effort],
      ['reasoning_effort', resolution.effort],
      ['model_reasoning_effort', resolution.effort],
      ['agent_file', null],
    ]) {
      if (source[field] !== undefined && source[field] !== expected) {
        refuse('CONFLICTING_OVERRIDE', 'launch context contradicts resolved ' + field);
      }
    }
    if (source.inline || source.inherit || source.session_inherited) {
      refuse('UNSUPPORTED_SELECTION', 'launch context requests inherited or inline selection');
    }
  }
}

function validateLaunchArguments(resolution) {
  const args = resolution.launch_arguments;
  if (!object(args)
      || args.model !== resolution.model
      || args.effort !== resolution.effort
      || (args.reasoning_effort !== undefined && args.reasoning_effort !== resolution.effort)
      || args.inline || args.inherit || args.session_inherited) {
    refuse('CONFLICTING_OVERRIDE', 'Claude launch arguments do not match the canonical explicit selection');
  }
}

function createClaudeDispatchAdapter(options = {}) {
  const host = options.host || {};
  // Snapshot advertised capabilities so later caller/host mutation cannot
  // weaken a selection that has already crossed the adapter boundary.
  const capabilities = JSON.parse(JSON.stringify(options.capabilities || host.capabilities || {}));
  const launchNative = host.launch;

  function validate(resolution) {
    validateAvailability(resolution, capabilities);
    if (resolution.agent_file !== undefined && resolution.agent_file !== null) {
      refuse('UNSUPPORTED_SELECTION', 'Claude launches use explicit workflow arguments, not an agent file');
    }
    validateLaunchArguments(resolution);
    return true;
  }

  function applicationReceipt(resolution, applied, selection) {
    if (!object(applied)) refuse('MISSING_RECEIPT', 'host returned no application evidence');
    if (typeof applied.launch_id !== 'string' || !applied.launch_id || /\s/.test(applied.launch_id)
        || typeof applied.applied_model !== 'string' || typeof applied.applied_effort !== 'string') {
      refuse('MISSING_RECEIPT', 'host must report a launch identity and concrete applied selection');
    }
    if (applied.applied_model !== selection.model || applied.applied_effort !== selection.effort) {
      refuse('NONCOMPLIANT_RECEIPT', 'host applied a different Claude model or effort');
    }
    const observations = {};
    for (const [field, supported, expected] of [
      ['observed_model', 'observedModel', applied.applied_model],
      ['observed_effort', 'observedEffort', applied.applied_effort],
    ]) {
      const observed = applied[field] === undefined && capabilities[supported] === false
        ? 'unknown' : applied[field];
      if (observed !== expected && !(observed === 'unknown' && capabilities[supported] === false)) {
        refuse('NONCOMPLIANT_RECEIPT', 'host is missing or contradicts ' + field);
      }
      observations[field] = observed;
    }
    return Object.freeze({
      receipt_type: 'adr-014.application', runtime: 'claude', role: resolution.role,
      dispatch_id: resolution.dispatch_id, launch_id: applied.launch_id,
      requested_model: resolution.requested_model, requested_effort: resolution.requested_effort,
      applied_model: applied.applied_model, applied_effort: applied.applied_effort,
      ...observations, policy_hash: resolution.policy_hash,
      backend: resolution.backend, mechanism: resolution.mechanism,
    });
  }

  function launch(resolution, context = {}) {
    policy.validateResolution(resolution, { requireDispatchId: true });
    validate(resolution);
    validateLaunchContext(resolution, context);
    if (typeof launchNative !== 'function') {
      refuse('MISSING_ADAPTER', 'host lacks the required explicit Claude workflow launch method');
    }
    const selection = Object.freeze({
      model: resolution.launch_arguments.model,
      effort: resolution.launch_arguments.effort,
    });
    const result = launchNative.call(host, selection, context);
    return result && typeof result.then === 'function'
      ? result.then((applied) => applicationReceipt(resolution, applied, selection))
      : applicationReceipt(resolution, result, selection);
  }

  const adapter = {
    runtime: 'claude', models: CLAUDE_MODEL_ALIASES,
    capabilities: Object.freeze({
      observedModel: capabilities.observedModel !== false,
      observedEffort: capabilities.observedEffort !== false,
    }),
    supports: (resolution) => validateAvailability(resolution, capabilities),
    validate,
  };
  // The boundary uses method presence to decide whether it can safely reserve
  // an id and launch.  Exposing a method that only throws after reservation
  // would leave a durable phantom reservation behind a missing host.
  if (typeof launchNative === 'function') adapter.launch = launch;
  return Object.freeze(adapter);
}

function createInProcessRecorder() {
  const reserved = new Set();
  const records = new Map();
  return Object.freeze({
    reserve(dispatchId) {
      if (reserved.has(dispatchId) || records.has(dispatchId)) return false;
      reserved.add(dispatchId);
      return { reserved: true };
    },
    record(record) {
      if (!object(record) || typeof record.dispatch_id !== 'string') return false;
      records.set(record.dispatch_id, record);
      return { recorded: true };
    },
    finalize(record) {
      if (!object(record) || typeof record.dispatch_id !== 'string') return false;
      records.set(record.dispatch_id, record);
      return { finalized: true };
    },
    getRecord(dispatchId) {
      return records.get(dispatchId) || null;
    },
  });
}

// Workflow scripts receive the native `agent` callback but do not receive a
// policy resolver. Keep the host callback behind the same adapter and boundary
// used by direct callers so the agent is invoked only after resolve, validate,
// and reservation, and its application receipt is recorded before the result
// is returned to the workflow.
function createClaudeWorkflowDispatch(options = {}) {
  if (!object(options)) refuse('INVALID_INPUT', 'Claude workflow dispatch options must be an object');
  if (typeof options.agent !== 'function') refuse('MISSING_ADAPTER', 'Claude workflow dispatch requires the native agent callback');
  if (typeof options.prompt !== 'string') refuse('INVALID_INPUT', 'Claude workflow dispatch requires a prompt');
  if (typeof options.role !== 'string' || !options.role.trim()) refuse('INVALID_INPUT', 'Claude workflow dispatch requires a role');
  if (typeof options.model !== 'string' || !options.model.trim()
      || typeof options.effort !== 'string' || !options.effort.trim()) {
    refuse('INVALID_INPUT', 'Claude workflow dispatch requires explicit model and effort');
  }

  const capabilities = options.capabilities === undefined
    ? WORKFLOW_CAPABILITIES
    : options.capabilities;
  const recorder = options.recorder === undefined ? createInProcessRecorder() : options.recorder;
  if (!(typeof recorder === 'function'
      || (recorder && typeof recorder === 'object' && typeof recorder.record === 'function'))) {
    refuse('RECORD_UNAVAILABLE', 'Claude workflow dispatch requires a receipt recorder');
  }
  const agentOptions = object(options.agentOptions) ? { ...options.agentOptions } : {};
  const launchId = options.launchId === undefined
    ? `workflow-${options.role}-${String(options.label || 'dispatch').replace(/[^A-Za-z0-9_.:-]+/g, '_')}`
    : options.launchId;
  if (typeof launchId !== 'string' || !launchId || /\s/.test(launchId)) {
    refuse('INVALID_INPUT', 'Claude workflow dispatch requires a whitespace-free launch id');
  }

  let agentResult;
  const host = {
    capabilities,
    launch(selection) {
      const result = options.agent(options.prompt, {
        ...agentOptions,
        model: selection.model,
        effort: selection.effort,
      });
      const capture = (value) => {
        agentResult = value;
        return {
          launch_id: launchId,
          applied_model: selection.model,
          applied_effort: selection.effort,
        };
      };
      return result && typeof result.then === 'function' ? result.then(capture) : capture(result);
    },
  };
  const adapter = createClaudeDispatchAdapter({ host, capabilities });
  const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder });
  const input = {
    runtime: 'claude',
    role: options.role,
    model: options.model,
    effort: options.effort,
  };
  if (options.signals !== undefined) input.signals = options.signals;
  if (options.priorApplied !== undefined) {
    input.signals = { ...(input.signals || {}), priorApplied: options.priorApplied };
  }
  if (options.priorReceipt !== undefined) input.priorReceipt = options.priorReceipt;
  if (options.dispatchId !== undefined) input.dispatch_id = options.dispatchId;
  if (options.previousDispatchId !== undefined) input.previous_dispatch_id = options.previousDispatchId;
  const context = options.context === undefined ? {} : options.context;
  const finish = (record) => {
    if (!object(record) || !object(record.receipt) || record.receipt.compliance !== 'verified') {
      refuse('MISSING_RECEIPT', 'Claude workflow dispatch completed without a boundary-verified application receipt');
    }
    return Object.freeze({ result: agentResult, receipt: record.receipt, record });
  };
  const record = boundary.dispatch(input, context);
  return record && typeof record.then === 'function' ? record.then(finish) : finish(record);
}

module.exports = Object.freeze({
  CLAUDE_MODEL_ALIASES,
  REPAIR,
  validateAvailability,
  createClaudeDispatchAdapter,
  createClaudeWorkflowDispatch,
});
