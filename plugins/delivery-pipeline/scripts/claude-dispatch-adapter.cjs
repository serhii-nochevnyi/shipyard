'use strict';

// Claude is a workflow-native runtime. The host must advertise the exact
// aliases and effort values it can apply, and its launch method must return
// application evidence. The dispatch boundary is the only layer that turns
// this evidence into a compliant, durably recorded receipt.
const policy = require('./model-policy.cjs');
const { isDeepStrictEqual } = require('node:util');
const { CLAUDE_MODEL_ALIASES } = require('./runtime-adapters.cjs');
const {
  createDispatchBoundary,
  GSD_LAUNCH_MECHANISM,
  validateGsdRole,
  isDurableRecorder,
} = require('./dispatch-boundary.cjs');

const REPAIR = 'Install an ADR-014-capable Claude host with explicit workflow model and effort support; provide current host capabilities and retry the exact selection.';
const ARTIFACT_ENVELOPE_MAX_BYTES = 8192;
const ARTIFACT_SUMMARY_MAX_CHARS = 500;

function refuse(code, message) {
  throw policy.policyError(code, message + '. ' + REPAIR);
}

function isBoundaryFailure(error) {
  return !!error && (error.name === 'DispatchBoundaryError' || error.name === 'DispatchPolicyError');
}

function boundaryFailure(code, message, cause) {
  const error = policy.policyError(code, message + '. ' + REPAIR);
  error.name = 'DispatchBoundaryError';
  if (cause !== undefined) error.cause = cause;
  return error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function artifactText(value, label, max = ARTIFACT_SUMMARY_MAX_CHARS) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_ARTIFACT', `${label} must be non-empty text`);
  }
  if (Array.from(value).length > max) {
    refuse('INVALID_ARTIFACT', `${label} exceeds its ${max}-character bound`);
  }
  return value;
}

function artifactPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_ARTIFACT', `${label} must be a non-empty path`);
  }
  return value;
}

function artifactReference(value, label) {
  if (!object(value)
      || typeof value.path !== 'string'
      || value.path.trim() === ''
      || /[\u0000-\u001f\u007f]/.test(value.path)
      || !Number.isInteger(value.bytes) || value.bytes < 0
      || value.content_bytes !== value.bytes
      || typeof value.sha256 !== 'string'
      || value.sha256 !== value.digest
      || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    refuse('INVALID_ARTIFACT', `${label} must be a bounded immutable file reference`);
  }
  return Object.freeze({
    path: value.path,
    bytes: value.bytes,
    content_bytes: value.content_bytes,
    sha256: value.sha256,
    digest: value.digest,
  });
}

function boundedActionable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string') artifactText(value, 'actionable_delta');
    return value;
  }
  if (!object(value)) refuse('INVALID_ARTIFACT', 'actionable_delta must be a bounded JSON value');
  const allowed = new Set(['type', 'path', 'sha256', 'digest', 'note', 'next', 'action', 'owner', 'reason']);
  const output = {};
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) continue;
    const item = value[key];
    if (typeof item === 'string') output[key] = artifactText(item, `actionable_delta.${key}`);
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) refuse('INVALID_ARTIFACT', `actionable_delta.${key} must be finite`);
      output[key] = item;
    } else if (typeof item === 'boolean' || item === null) output[key] = item;
  }
  return output;
}

function boundedEnvelope(value) {
  if (!object(value)) refuse('INVALID_ARTIFACT', 'trusted role-artifact envelope must be an object');
  const output = {};
  const strings = [
    'schema', 'role', 'ticket', 'subject', 'outcome', 'status', 'verdict',
    'summary', 'notes', 'hypothesis',
  ];
  const integers = ['version', 'pr', 'blocking_count', 'moved_count', 'reuse_candidates_count', 'evidence_count'];
  for (const key of strings) {
    if (value[key] !== undefined) {
      // The executor contract permits an empty summary when the agent supplied
      // no synopsis; it is still bounded metadata and must not be turned into a
      // false acceptance failure at this transport boundary.
      output[key] = key === 'summary' && value[key] === ''
        ? ''
        : artifactText(value[key], `envelope.${key}`);
    }
  }
  for (const key of integers) {
    if (value[key] !== undefined) {
      if (!Number.isInteger(value[key]) || value[key] < 0) refuse('INVALID_ARTIFACT', `envelope.${key} must be a non-negative integer`);
      output[key] = value[key];
    }
  }
  if (value.pushed !== undefined) {
    if (typeof value.pushed !== 'boolean') refuse('INVALID_ARTIFACT', 'envelope.pushed must be boolean');
    output.pushed = value.pushed;
  }
  if (value.actionable_delta !== undefined) output.actionable_delta = boundedActionable(value.actionable_delta);
  if (value.overflow !== undefined) {
    if (!object(value.overflow)) refuse('INVALID_ARTIFACT', 'envelope.overflow must be an object');
    const overflow = {};
    if (Array.isArray(value.overflow.fields)) {
      if (value.overflow.fields.length > 16 || value.overflow.fields.some((item) => typeof item !== 'string')) {
        refuse('INVALID_ARTIFACT', 'envelope.overflow.fields is not bounded');
      }
      overflow.fields = value.overflow.fields.map((item) => artifactText(item, 'envelope.overflow.fields[]', 100));
    }
    if (value.overflow.reference !== undefined) overflow.reference = artifactReference(value.overflow.reference, 'envelope.overflow.reference');
    output.overflow = overflow;
  }
  if (value.integration_base !== undefined) {
    if (!object(value.integration_base)) refuse('INVALID_ARTIFACT', 'envelope.integration_base must be an object');
    output.integration_base = {};
    for (const key of ['ref', 'commit', 'tree']) {
      if (value.integration_base[key] !== undefined) output.integration_base[key] = artifactText(value.integration_base[key], `envelope.integration_base.${key}`, 200);
    }
  }
  for (const key of ['evidence_index', 'findings_index']) {
    if (value[key] !== undefined) {
      const reference = artifactReference(value[key], `envelope.${key}`);
      output[key] = reference;
      const refKey = `${key}_ref`;
      if (value[refKey] !== undefined) {
        const ref = artifactReference(value[refKey], `envelope.${refKey}`);
        if (!isDeepStrictEqual(reference, ref)) refuse('INVALID_ARTIFACT', `envelope.${key} and ${refKey} disagree`);
      }
      output[refKey] = reference;
    }
  }
  if (output.summary === undefined) refuse('INVALID_ARTIFACT', 'trusted role-artifact envelope requires a bounded summary');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(output), 'utf8'); } catch (error) {
    refuse('INVALID_ARTIFACT', `trusted role-artifact envelope is not serializable: ${error.message}`);
  }
  if (size > ARTIFACT_ENVELOPE_MAX_BYTES) refuse('INVALID_ARTIFACT', 'trusted role-artifact envelope exceeds its bounded return contract');
  return Object.freeze(output);
}

function canonicalArtifact(value) {
  if (!object(value)
      || value.schema !== 'shipyard.role-artifact.v1'
      || typeof (value.artifact_ref || value.artifact_path) !== 'string'
      || typeof value.artifact_digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.artifact_digest)) {
    throw boundaryFailure('INVALID_ARTIFACT', 'trusted role-artifact consumer returned no validated references');
  }
  const artifactRef = artifactPath(value.artifact_ref || value.artifact_path, 'artifact reference');
  const evidenceIndex = artifactReference(value.evidence_index, 'artifact evidence_index');
  const envelope = boundedEnvelope(value.envelope);
  if (!object(envelope.evidence_index)
      || !isDeepStrictEqual(envelope.evidence_index, evidenceIndex)) {
    throw boundaryFailure('INVALID_ARTIFACT', 'trusted role-artifact evidence index does not match its envelope');
  }
  const output = {
    schema: value.schema,
    artifact_ref: artifactRef,
    artifact_path: artifactRef,
    artifact_digest: value.artifact_digest,
    envelope,
    evidence_index: evidenceIndex,
  };
  if (value.findings_index !== undefined) {
    const findingsIndex = artifactReference(value.findings_index, 'artifact findings_index');
    if (!object(envelope.findings_index) || !isDeepStrictEqual(envelope.findings_index, findingsIndex)) {
      throw boundaryFailure('INVALID_ARTIFACT', 'trusted role-artifact findings index does not match its envelope');
    }
    output.findings_index = findingsIndex;
  }
  return Object.freeze(output);
}

function durableRecorder(value) {
  return isDurableRecorder(value);
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
      ['requested_effort', resolution.effort],
      ['applied_effort', resolution.effort],
      ['reasoning_effort', resolution.effort],
      ['model_reasoning_effort', resolution.effort],
      ['agent_file', null],
      ['gsd_role', resolution.gsd_role],
      ['gsd_launch_mechanism', resolution.gsd_role === undefined ? undefined : GSD_LAUNCH_MECHANISM],
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
  const launchTypedGsd = host.launchTypedGsd;

  function validate(resolution) {
    validateAvailability(resolution, capabilities);
    const gsdRole = validateGsdRole(resolution);
    if (gsdRole !== undefined && typeof launchTypedGsd !== 'function') {
      refuse('MISSING_ADAPTER', `Claude ${gsdRole} requires the host-owned launchTypedGsd callback`);
    }
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
    const gsdRole = validateGsdRole(resolution);
    if (gsdRole !== undefined
        && (applied.gsd_role !== gsdRole || applied.gsd_launch_mechanism !== GSD_LAUNCH_MECHANISM)) {
      refuse('NONCOMPLIANT_RECEIPT', 'Claude host did not attest the exact typed GSD callback role and launch mechanism', {
        expected: { gsd_role: gsdRole, gsd_launch_mechanism: GSD_LAUNCH_MECHANISM },
        actual: { gsd_role: applied.gsd_role, gsd_launch_mechanism: applied.gsd_launch_mechanism },
      });
    }
    return Object.freeze({
      receipt_type: 'adr-014.application', runtime: 'claude', role: resolution.role,
      dispatch_id: resolution.dispatch_id, launch_id: applied.launch_id,
      requested_model: resolution.requested_model, requested_effort: resolution.requested_effort,
      applied_model: applied.applied_model, applied_effort: applied.applied_effort,
      ...observations, policy_hash: resolution.policy_hash,
      backend: resolution.backend, mechanism: resolution.mechanism,
      ...(gsdRole !== undefined ? {
        gsd_role: gsdRole,
        gsd_launch_mechanism: applied.gsd_launch_mechanism,
      } : {}),
    });
  }

  function launch(resolution, context = {}) {
    policy.validateResolution(resolution, { requireDispatchId: true });
    validate(resolution);
    validateLaunchContext(resolution, context);
    const gsdRole = validateGsdRole(resolution);
    const method = gsdRole !== undefined ? launchTypedGsd : launchNative;
    if (typeof method !== 'function') {
      refuse('MISSING_ADAPTER', 'host lacks the required explicit Claude workflow launch method');
    }
    const selection = Object.freeze({
      model: resolution.launch_arguments.model,
      effort: resolution.launch_arguments.effort,
    });
    const launchContext = gsdRole === undefined
      ? context
      : Object.freeze({
        ...context,
        gsd_role: gsdRole,
        gsd_launch_mechanism: GSD_LAUNCH_MECHANISM,
      });
    const result = method.call(host, selection, launchContext);
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
  if (typeof launchNative === 'function' || typeof launchTypedGsd === 'function') adapter.launch = launch;
  return Object.freeze(adapter);
}

// Workflow scripts receive the native `agent` callback but do not receive a
// policy resolver. Keep the host callback behind the same adapter and boundary
// used by direct callers so the agent is invoked only after resolve, validate,
// and reservation, and its application receipt is recorded before the result
// is returned to the workflow. The native callback returns the agent's output,
// not proof of what the host applied, so the host must inject an evidence
// callback separately; requested values are never promoted to application
// evidence here.
function createClaudeWorkflowDispatch(options = {}) {
  if (!object(options)) refuse('INVALID_INPUT', 'Claude workflow dispatch options must be an object');
  const suppliedHost = object(options.host) ? options.host : null;
  // Resolve the effective typed callback before the preflight. An explicit
  // host owns the callback just as it owns capabilities, receipts, and
  // application evidence; inspecting only serializable options would reject a
  // valid typed-only host or let its absence fail after reservation.
  const typedGsdCallback = suppliedHost
    ? suppliedHost.typedGsdCallback
    : options.typedGsdCallback;
  if (typeof options.agent !== 'function' && typeof typedGsdCallback !== 'function') {
    refuse('MISSING_ADAPTER', 'Claude workflow dispatch requires the native agent callback or typed GSD callback');
  }
  if (typeof options.prompt !== 'string' && typeof options.prompt !== 'function') {
    refuse('INVALID_INPUT', 'Claude workflow dispatch requires a prompt or prompt factory');
  }
  if (typeof options.role !== 'string' || !options.role.trim()) refuse('INVALID_INPUT', 'Claude workflow dispatch requires a role');
  if (typeof options.model !== 'string' || !options.model.trim()
      || typeof options.effort !== 'string' || !options.effort.trim()) {
    refuse('INVALID_INPUT', 'Claude workflow dispatch requires explicit model and effort');
  }
  if (typeof options.agent !== 'function'
      && typeof typedGsdCallback === 'function'
      && ['research', 'decomposition'].includes(options.role)
      && options.gsdRole === undefined) {
    refuse('INVALID_INPUT', `Claude typed-only ${options.role} dispatch requires an explicit gsdRole`);
  }

  // When an explicit host is present, its closures are the trust boundary.
  // Serializable workflow args must not be able to advertise capabilities or
  // replace the host's recorder/evidence implementation.
  const capabilities = suppliedHost ? suppliedHost.capabilities : options.capabilities;
  const recorder = suppliedHost ? suppliedHost.recorder : options.recorder;
  const applicationEvidence = suppliedHost
    ? suppliedHost.applicationEvidence
    : options.applicationEvidence;
  if (capabilities === undefined) {
    refuse('UNSUPPORTED_SELECTION', 'Claude workflow dispatch requires explicit host capabilities');
  }
  if (!durableRecorder(recorder)) {
    refuse('RECORD_UNAVAILABLE', 'Claude workflow dispatch requires a durable receipt recorder');
  }
  if (typeof applicationEvidence !== 'function') {
    refuse('MISSING_RECEIPT', 'Claude workflow dispatch requires host application evidence');
  }
  if (options.gsdRole !== undefined && typeof typedGsdCallback !== 'function') {
    refuse('MISSING_ADAPTER', `Claude ${JSON.stringify(options.gsdRole)} requires the host-owned typed GSD callback`);
  }
  if (options.agentOptions !== undefined && !object(options.agentOptions)) {
    refuse('INVALID_INPUT', 'agentOptions must be an object');
  }
  if (options.requireGsdRole !== undefined && typeof options.requireGsdRole !== 'boolean') {
    refuse('INVALID_INPUT', 'requireGsdRole must be boolean when provided');
  }
  if (options.requireArtifact !== undefined && typeof options.requireArtifact !== 'boolean') {
    refuse('INVALID_INPUT', 'requireArtifact must be boolean when provided');
  }
  if (options.artifact !== undefined && !object(options.artifact)) {
    refuse('INVALID_INPUT', 'artifact metadata must be an object');
  }
  const agentOptions = options.agentOptions === undefined ? {} : { ...options.agentOptions };
  if (options.signals !== undefined && !object(options.signals)) {
    refuse('INVALID_SIGNAL', 'signals must be an object');
  }
  const signals = { ...options.signals };
  // Preserve supplied facts exactly. In particular risk is recorded context,
  // not authority to infer critical=true from a legacy model/effort pair.
  for (const field of ['risk', 'critical', 'checkpoint', 'signatureState', 'priorApplied']) {
    if (options[field] === undefined) continue;
    if (signals[field] !== undefined
        && !isDeepStrictEqual(signals[field], options[field])) {
      refuse('CONFLICTING_OVERRIDE', 'contradictory workflow signal ' + field);
    }
    signals[field] = options[field];
  }
  if (options.priorReceipt !== undefined && signals.priorApplied !== undefined
      && !isDeepStrictEqual(options.priorReceipt, signals.priorApplied)) {
    refuse('CONFLICTING_OVERRIDE', 'contradictory workflow predecessor receipts');
  }
  const context = options.context === undefined ? {} : options.context;
  const artifactConsumer = suppliedHost
    ? suppliedHost.artifactConsumer
    : options.artifactConsumer;
  const artifactRequired = options.requireArtifact === true || options.artifact !== undefined;
  let artifactMetadata;
  if (options.artifact !== undefined) {
    try {
      artifactMetadata = JSON.parse(JSON.stringify(options.artifact));
    } catch (error) {
      refuse('INVALID_INPUT', `artifact metadata must be JSON-serializable: ${error.message}`);
    }
  }
  // Artifact-required workflows must prove that their trusted consumer and
  // identity inputs exist before the boundary reserves a dispatch or invokes
  // an agent. Deferring this check until after launch can spend a model call on
  // a result that could never be accepted.
  if (artifactRequired) {
    if (!object(artifactMetadata)) refuse('INVALID_ARTIFACT', 'artifact-required dispatch needs artifact metadata');
    if (typeof artifactConsumer !== 'function') {
      refuse('MISSING_ARTIFACT', 'artifact-required dispatch needs the trusted role-artifact consumer');
    }
    for (const [field, value] of [
      ['role', artifactMetadata.role],
      ['ticket', artifactMetadata.ticket],
      ['worktreePath', artifactMetadata.worktreePath],
      ['base', artifactMetadata.base || artifactMetadata.baseRef],
    ]) {
      if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
        refuse('INVALID_ARTIFACT', `artifact metadata requires ${field} before launch`);
      }
    }
    if (['ci-fix', 'review-fix'].includes(artifactMetadata.role)
        && (!Number.isInteger(artifactMetadata.pr) || artifactMetadata.pr < 1)) {
      refuse('INVALID_ARTIFACT', 'repair artifact metadata requires a positive PR number before launch');
    }
  }

  let agentResult;
  const host = {
    capabilities,
    launch(selection, context) {
      return launchThrough(options.agent, selection, context);
    },
    launchTypedGsd(selection, context) {
      if (typeof typedGsdCallback !== 'function') {
        refuse('MISSING_ADAPTER', 'Claude typed GSD callback is unavailable');
      }
      return launchThrough(typedGsdCallback, selection, context);
    },
  };
  function launchThrough(callback, selection, context) {
      if (typeof callback !== 'function') {
        refuse('MISSING_ADAPTER', 'Claude launch callback is unavailable');
      }
      let prompt;
      try {
        prompt = typeof options.prompt === 'function' ? options.prompt() : options.prompt;
      } catch (error) {
        if (isBoundaryFailure(error)) throw error;
        throw boundaryFailure(
          'INVALID_INPUT',
          `Claude workflow prompt construction failed: ${error && error.message ? error.message : error}`,
          error,
        );
      }
      if (typeof prompt !== 'string') {
        throw boundaryFailure('INVALID_INPUT', 'Claude workflow prompt factory must return a string');
      }
      const launchOptions = Object.freeze({
        ...agentOptions,
        model: selection.model,
        effort: selection.effort,
        ...(context && context.gsd_role !== undefined ? {
          gsd_role: context.gsd_role,
          gsd_launch_mechanism: GSD_LAUNCH_MECHANISM,
        } : {}),
      });
      let result;
      try {
        result = callback(prompt, launchOptions, context && context.gsd_role);
      } catch (error) {
        if (isBoundaryFailure(error)) throw error;
        if (artifactRequired) {
          throw boundaryFailure(
            'DISPATCH_FAILED',
            `Claude agent launch failed: ${error && error.message ? error.message : error}`,
            error,
          );
        }
        throw error;
      }
      const capture = (value) => {
        agentResult = value;
        // This callback is host-owned. It must report what the host actually
        // applied; the requested selection is intentionally not passed in, so
        // this adapter cannot turn its own input into application evidence.
        try {
          const evidence = applicationEvidence.call(suppliedHost || host, { result: value, context });
          if (evidence && typeof evidence.then === 'function') {
            return evidence.catch((error) => {
              if (isBoundaryFailure(error)) throw error;
              throw boundaryFailure(
                'MISSING_RECEIPT',
                `Claude host application evidence failed: ${error && error.message ? error.message : error}`,
                error,
              );
            });
          }
          return evidence;
        } catch (error) {
          if (isBoundaryFailure(error)) throw error;
          throw boundaryFailure(
            'MISSING_RECEIPT',
            `Claude host application evidence failed: ${error && error.message ? error.message : error}`,
            error,
          );
        }
      };
      if (result && typeof result.then === 'function') {
        return result.then(capture, (error) => {
          if (isBoundaryFailure(error)) throw error;
          if (artifactRequired) {
            throw boundaryFailure(
              'DISPATCH_FAILED',
              `Claude agent launch failed: ${error && error.message ? error.message : error}`,
              error,
            );
          }
          throw error;
        });
      }
      return capture(result);
  }
  const nativeAdapter = createClaudeDispatchAdapter({ host, capabilities });
  const adapter = Object.freeze({
    ...nativeAdapter,
    validate(resolution) {
      nativeAdapter.validate(resolution);
      // Agent options reach the native host too: validate them before the
      // boundary reserves a dispatch identity, not only inside host.launch.
      validateLaunchContext(resolution, agentOptions);
      validateLaunchContext(resolution, context);
      return true;
    },
  });
  const boundary = createDispatchBoundary({
    adapters: { claude: adapter }, recorder,
    requireGsdRole: options.requireGsdRole !== false,
  });
  const input = {
    runtime: 'claude',
    role: options.role,
    model: options.model,
    effort: options.effort,
  };
  if (options.gsdRole !== undefined) input.gsd_role = options.gsdRole;
  input.signals = signals;
  if (options.priorReceipt !== undefined) input.priorReceipt = options.priorReceipt;
  if (options.dispatchId !== undefined) input.dispatch_id = options.dispatchId;
  if (options.previousDispatchId !== undefined) input.previous_dispatch_id = options.previousDispatchId;
  const complete = (record, artifact) => Object.freeze({
    result: agentResult,
    receipt: record.receipt,
    record,
    ...(artifact ? { artifact } : {}),
  });
  const finish = (record) => {
    if (!object(record) || !object(record.receipt) || record.receipt.compliance !== 'verified') {
      refuse('MISSING_RECEIPT', 'Claude workflow dispatch completed without a boundary-verified application receipt');
    }
    if (!artifactRequired || !agentResult || agentResult.status !== 'committed') return complete(record);
    let sealed;
    try {
      sealed = artifactConsumer.call(suppliedHost || host, {
        artifact: artifactMetadata,
        result: agentResult,
        record,
        receipt: record.receipt,
      });
    } catch (error) {
      if (isBoundaryFailure(error)) throw error;
      throw boundaryFailure(
        'INVALID_ARTIFACT',
        `trusted role-artifact consumer failed: ${error && error.message ? error.message : error}`,
        error,
      );
    }
    const finishArtifact = (artifact) => {
      try {
        const boundedArtifact = canonicalArtifact(artifact);
        return complete(record, boundedArtifact);
      } catch (error) {
        if (isBoundaryFailure(error)) throw error;
        throw boundaryFailure(
          'INVALID_ARTIFACT',
          `trusted role-artifact consumer returned invalid references: ${error && error.message ? error.message : error}`,
          error,
        );
      }
    };
    if (sealed && typeof sealed.then === 'function') {
      return sealed.then(finishArtifact, (error) => {
        if (isBoundaryFailure(error)) throw error;
        throw boundaryFailure(
          'INVALID_ARTIFACT',
          `trusted role-artifact consumer failed asynchronously: ${error && error.message ? error.message : error}`,
          error,
        );
      });
    }
    return finishArtifact(sealed);
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
