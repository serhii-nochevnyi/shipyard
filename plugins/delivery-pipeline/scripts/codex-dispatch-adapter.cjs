'use strict';

// The host supplies availability and native launch methods; absence is a
// refusal. Static hosts must consume immutable agent_file_content, never reopen
// agent_file as a path. Launch results must attest applied_model/applied_effort,
// launch_id, and (for static launches) agent_file_digest. Only the boundary can
// turn this application evidence into a compliant, durably recorded receipt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const policy = require('./model-policy.cjs');
const { CODEX_MODEL_IDS } = require('./runtime-adapters.cjs');
const { generatedAgentEvidence } = require('./dispatch-boundary.cjs');

const REPAIR = 'Install an ADR-014-capable Codex host and regenerate agents with install-shipyard-codex.sh --phase 2; provide current host capabilities and retry the exact selection.';
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
function refuse(code, message) {
  throw policy.policyError(code, message + '. ' + REPAIR);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A selector may carry an operator remap alongside the immutable ADR-014
// resolution. Keep the canonical view available when the selection is passed
// through JSON, where the non-enumerable in-process reference is lost.
function canonicalView(resolution) {
  if (!object(resolution)) return resolution;
  if (object(resolution.canonical_resolution)) return resolution.canonical_resolution;
  if (typeof resolution.canonical_model === 'string'
      && typeof resolution.effective_model === 'string'
      && resolution.model === resolution.effective_model
      && resolution.model !== resolution.canonical_model) {
    const candidate = { ...resolution, model: resolution.canonical_model, requested_model: resolution.canonical_model };
    if (object(candidate.launch_arguments) && (candidate.agent_file === null || candidate.agent_file === undefined)) {
      candidate.launch_arguments = { ...candidate.launch_arguments, model: resolution.canonical_model };
    }
    return candidate;
  }
  return resolution;
}

function effectiveModelFor(resolution, canonical) {
  const explicit = resolution && resolution.effective_model;
  const model = explicit === undefined
    ? (resolution && resolution.model !== canonical.model ? resolution.model : canonical.model)
    : explicit;
  if (typeof model !== 'string' || !model.trim()) {
    refuse('CONFLICTING_OVERRIDE', 'effective Codex model must be a non-empty model id');
  }
  if (explicit !== undefined && resolution.model !== canonical.model && resolution.model !== explicit) {
    refuse('CONFLICTING_OVERRIDE', 'effective Codex selection disagrees with its model');
  }
  if (canonical.agent_file && model !== canonical.model) {
    refuse('CONFLICTING_OVERRIDE', 'static Codex selections cannot use an effective model remap');
  }
  return model.trim();
}

// Deliberately accept the generator's flat TOML subset, not arbitrary TOML.
// In particular, model-looking text in instructions or a table is not evidence.
function readGeneratedSelection(content) {
  const fields = {};
  const comments = {};
  const lines = content.split(/\r?\n/);
  let instructions = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const match = line.match(/^# shipyard-policy-([a-z]+)\s*=\s*"([^"]*)"\s*$/);
      if (match) {
        if (Object.hasOwn(comments, match[1])) refuse('STALE_GENERATED_AGENT', 'duplicate policy identity');
        comments[match[1]] = match[2];
      }
      continue;
    }
    const instruction = line.match(/^developer_instructions\s*=\s*(.*)$/);
    if (instruction) {
      const rest = [instruction[1], ...lines.slice(index + 1)].join('\n').trim();
      if (rest.startsWith("'''")) {
        const end = rest.indexOf("'''", 3);
        if (end < 0 || rest.slice(end + 3).trim()) refuse('STALE_GENERATED_AGENT', 'invalid generated instructions or trailing configuration');
      } else {
        try {
          if (typeof JSON.parse(rest) !== 'string') throw new Error('not a string');
        } catch (_) {
          refuse('STALE_GENERATED_AGENT', 'invalid generated instructions');
        }
      }
      instructions = true;
      break;
    }
    const match = line.match(/^(name|description|sandbox_mode|model|model_reasoning_effort)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/);
    if (!match || Object.hasOwn(fields, match[1])) refuse('STALE_GENERATED_AGENT', 'unsupported or duplicate generated configuration');
    try { fields[match[1]] = JSON.parse(match[2]); }
    catch (_) { refuse('STALE_GENERATED_AGENT', 'invalid generated scalar'); }
  }
  if (!instructions) refuse('STALE_GENERATED_AGENT', 'missing generated developer instructions');
  return { fields, comments };
}

function validateAvailability(resolution, capabilities, canonicalOverride) {
  const canonical = canonicalOverride || canonicalView(resolution);
  policy.validateResolution(canonical);
  if (canonical.runtime !== 'codex') refuse('UNSUPPORTED_SELECTION', 'Codex adapter requires runtime codex');
  if (!object(capabilities)) refuse('UNSUPPORTED_SELECTION', 'missing Codex host capabilities');
  const model = effectiveModelFor(resolution, canonical);
  for (const [key, value] of [['supportedModels', model], ['supportedEfforts', canonical.effort]]) {
    if (!Array.isArray(capabilities[key]) || !capabilities[key].includes(value)) {
      refuse('UNSUPPORTED_SELECTION', 'host ' + key + ' does not explicitly support ' + value);
    }
  }
  if (capabilities.supportedSelections !== undefined
      && (!Array.isArray(capabilities.supportedSelections)
        || !capabilities.supportedSelections.some((entry) => object(entry) && entry.model === model && entry.effort === canonical.effort))) {
    refuse('UNSUPPORTED_SELECTION', 'host does not support the required model/effort pair');
  }
  return true;
}

function createCodexDispatchAdapter(options = {}) {
  const host = options.host || {};
  const agentsDir = typeof options.agentsDir === 'string' && options.agentsDir.trim()
    ? path.resolve(options.agentsDir) : null;
  const agentManifest = options.agentManifest === undefined
    ? agentsDir && path.join(agentsDir, '.shipyard-manifest.json')
    : options.agentManifest;
  // Snapshot advertised capabilities so caller mutation cannot weaken checks.
  const capabilities = JSON.parse(JSON.stringify(options.capabilities || host.capabilities || {}));
  const launchDynamic = host.launch;
  const launchStatic = host.launchStatic;
  const validatedRepairs = new Map();

  function canonicalResolution(resolution) {
    // The boundary adds the static digest by snapshotting the resolution. Its
    // snapshot loses the predecessor receipt's object-identity capability.
    // Retain only evidence already accepted by canonical validation, and reuse
    // that identity only for an otherwise byte-equivalent dispatch resolution.
    const view = canonicalView(resolution);
    if (object(resolution?.canonical_resolution)) {
      for (const field of [
        'policy_version', 'policy_hash', 'runtime', 'role', 'model_key', 'logical_model',
        'logical_rung', 'rung', 'rung_index', 'effort', 'requested_effort', 'route',
        'backend', 'mechanism', 'signals_fired', 'signal_reasons', 'selected_signals',
        'signals', 'agent_file', 'dispatch_id',
      ]) {
        if (resolution[field] !== undefined
            && policy.stableStringify(resolution[field]) !== policy.stableStringify(view[field])) {
          refuse('INVALID_RESOLUTION', 'effective Codex selection changed canonical ' + field);
        }
      }
    }
    const previous = validatedRepairs.get(view && view.dispatch_id);
    let candidate = view;
    if (previous) {
      const { agent_file_digest: ignored, ...withoutDigest } = view;
      const { agent_file_digest: previousDigest, ...previousWithoutDigest } = previous;
      if (policy.stableStringify(withoutDigest) === policy.stableStringify(previousWithoutDigest)) {
        candidate = { ...view, signals: previous.signals };
      }
    }
    policy.validateResolution(candidate);
    if (candidate.signals.priorApplied && candidate.dispatch_id) {
      validatedRepairs.set(candidate.dispatch_id, candidate);
    }
    return candidate;
  }

  function validateGeneratedAgent(resolution) {
    const canonical = canonicalResolution(resolution);
    if (canonical.runtime !== 'codex' || !canonical.agent_file || !agentsDir) {
      refuse('STALE_GENERATED_AGENT', 'static Codex launch requires its exact agents directory and file');
    }
    if (typeof agentManifest !== 'string' || !agentManifest.trim()) refuse('STALE_GENERATED_AGENT', 'missing generated manifest path');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(agentManifest, 'utf8')); }
    catch (error) { refuse('STALE_GENERATED_AGENT', 'cannot read generated manifest: ' + error.message); }
    if (!object(manifest) || manifest.policy_id !== policy.POLICY.id
        || manifest.policy_version !== canonical.policy_version || manifest.policy_hash !== canonical.policy_hash
        || !object(manifest.agent_digests) || !Array.isArray(manifest.agent_files)
        || manifest.agent_files.filter((file) => file === canonical.agent_file).length !== 1
        || !/^[a-f0-9]{64}$/.test(manifest.agent_digests[canonical.agent_file] || '')) {
      refuse('STALE_GENERATED_AGENT', 'generated manifest lacks the exact file, digest, or current policy identity');
    }
    let content;
    try {
      const file = path.join(agentsDir, canonical.agent_file);
      const relative = path.relative(fs.realpathSync(agentsDir), fs.realpathSync(file));
      if (relative.startsWith('..') || path.isAbsolute(relative)) refuse('STALE_GENERATED_AGENT', 'generated file escapes agents directory');
      content = fs.readFileSync(file, 'utf8');
    } catch (error) { refuse('STALE_GENERATED_AGENT', 'cannot read exact generated file: ' + error.message); }
    const parsed = readGeneratedSelection(content);
    const expectedComments = {
      id: policy.POLICY.id, version: canonical.policy_version, hash: canonical.policy_hash,
      runtime: 'codex', role: canonical.role, rung: canonical.rung,
    };
    for (const [key, value] of Object.entries(expectedComments)) {
      if (parsed.comments[key] !== value) refuse('STALE_GENERATED_AGENT', 'generated policy ' + key + ' is missing or stale');
    }
    if (parsed.fields.name !== canonical.agent_file.replace(/\.toml$/, '')
        || parsed.fields.model !== canonical.model || parsed.fields.model_reasoning_effort !== canonical.effort
        || digest(content) !== manifest.agent_digests[canonical.agent_file]) {
      refuse('STALE_GENERATED_AGENT', 'generated file selection or content disagrees with policy/manifest');
    }
    // Reuse the authoritative boundary's identity/digest evidence contract.
    const evidence = generatedAgentEvidence(canonical, { agentsDir, agentManifest });
    if (!evidence || evidence.agent_file_digest !== digest(content)) {
      refuse('STALE_GENERATED_AGENT', 'generated file changed during validation');
    }
    return Object.freeze(evidence);
  }

  function validate(resolution) {
    const canonical = canonicalResolution(resolution);
    validateAvailability(resolution, capabilities, canonical);
    if (canonical.agent_file) validateGeneratedAgent(canonical);
    return true;
  }

  function applicationReceipt(resolution, applied, selection) {
    if (!object(applied)) refuse('MISSING_RECEIPT', 'host returned no application evidence');
    if (typeof applied.launch_id !== 'string' || !applied.launch_id || /\s/.test(applied.launch_id)
        || typeof applied.applied_model !== 'string' || typeof applied.applied_effort !== 'string') {
      refuse('MISSING_RECEIPT', 'host must report a launch identity and concrete applied selection');
    }
    if (applied.applied_model !== selection.model || applied.applied_effort !== selection.reasoning_effort) {
      refuse('NONCOMPLIANT_RECEIPT', 'host applied a different model or effort');
    }
    if (resolution.agent_file && applied.agent_file_digest !== selection.agent_file_digest) {
      refuse('NONCOMPLIANT_RECEIPT', 'host did not apply the validated static content digest');
    }
    const observations = {};
    for (const [field, supported, expected] of [
      ['observed_model', 'observedModel', applied.applied_model],
      ['observed_effort', 'observedEffort', applied.applied_effort],
    ]) {
      const observed = applied[field] === undefined && capabilities[supported] === false ? 'unknown' : applied[field];
      if (observed !== expected && !(observed === 'unknown' && capabilities[supported] === false)) {
        refuse('NONCOMPLIANT_RECEIPT', 'host is missing or contradicts ' + field);
      }
      observations[field] = observed;
    }
    return Object.freeze({
      receipt_type: 'adr-014.application', runtime: 'codex', role: resolution.role,
      dispatch_id: resolution.dispatch_id, launch_id: applied.launch_id,
      requested_model: selection.model, requested_effort: selection.reasoning_effort,
      applied_model: applied.applied_model, applied_effort: applied.applied_effort,
      ...observations, policy_hash: resolution.policy_hash,
      backend: resolution.backend, mechanism: resolution.mechanism,
      ...(resolution.agent_file ? { agent_file: resolution.agent_file, agent_file_digest: applied.agent_file_digest } : {}),
    });
  }

  function launch(resolution, context = {}, handoff) {
    const canonical = canonicalResolution(resolution);
    policy.validateResolution(canonical, { requireDispatchId: true });
    validate(resolution);
    if (!object(context)) refuse('INVALID_INPUT', 'launch context must be an object');
    const effectiveModel = effectiveModelFor(resolution, canonical);
    for (const source of [context, context.launch_arguments, context.selection, context.session]) {
      if (source === undefined) continue;
      if (!object(source)) refuse('CONFLICTING_OVERRIDE', 'launch selection overrides must be objects');
      for (const [field, expected] of [
        ['model', effectiveModel], ['requested_model', effectiveModel], ['applied_model', effectiveModel],
        ['effort', canonical.effort], ['reasoning_effort', canonical.effort],
        ['model_reasoning_effort', canonical.effort], ['agent_file', canonical.agent_file],
      ]) {
        if (source[field] !== undefined && source[field] !== expected) refuse('CONFLICTING_OVERRIDE', 'launch context contradicts resolved ' + field);
      }
      if (source.inherit || source.inline || source.session_inherited) refuse('UNSUPPORTED_SELECTION', 'launch context requests inherited or inline selection');
    }
    const staticRole = Boolean(canonical.agent_file);
    const method = staticRole ? launchStatic : launchDynamic;
    if (typeof method !== 'function') refuse('MISSING_ADAPTER', 'host lacks the required explicit ' + (staticRole ? 'static' : 'dynamic') + ' launch method');
    let selection;
    if (staticRole) {
      const current = validateGeneratedAgent(canonical);
      if (!handoff || handoff.agent_file !== canonical.agent_file
          || handoff.agent_file_digest !== canonical.agent_file_digest
          || handoff.agent_file_digest !== current.agent_file_digest
          || typeof handoff.agent_file_content !== 'string'
          || digest(handoff.agent_file_content) !== handoff.agent_file_digest) {
        refuse('STALE_GENERATED_AGENT', 'static launch requires the boundary-validated immutable content handoff');
      }
      const parsed = readGeneratedSelection(handoff.agent_file_content);
      selection = {
        model: parsed.fields.model, reasoning_effort: parsed.fields.model_reasoning_effort,
        agent_file: handoff.agent_file, agent_file_digest: handoff.agent_file_digest,
        agent_file_content: handoff.agent_file_content,
      };
    } else {
      if (handoff !== undefined) refuse('UNSUPPORTED_SELECTION', 'dynamic launch cannot use a static handoff');
      selection = { model: effectiveModel, reasoning_effort: canonical.effort };
    }
    Object.freeze(selection);
    validatedRepairs.delete(canonical.dispatch_id);
    const result = method.call(host, selection, context);
    return result && typeof result.then === 'function'
      ? result.then((applied) => applicationReceipt(canonical, applied, selection))
      : applicationReceipt(canonical, result, selection);
  }

  return Object.freeze({
    runtime: 'codex', models: CODEX_MODEL_IDS,
    capabilities: Object.freeze({ observedModel: capabilities.observedModel !== false, observedEffort: capabilities.observedEffort !== false }),
    supports: (resolution) => validateAvailability(resolution, capabilities),
    validate, validateGeneratedAgent,
    launch: (resolution, context) => {
      if (canonicalView(resolution).agent_file) refuse('UNSUPPORTED_SELECTION', 'static role must use launchStatic');
      return launch(resolution, context);
    },
    launchStatic: (resolution, context, handoff) => {
      if (!canonicalView(resolution).agent_file) refuse('UNSUPPORTED_SELECTION', 'dynamic role must use explicit launch arguments');
      return launch(resolution, context, handoff);
    },
  });
}

module.exports = Object.freeze({ CODEX_MODEL_IDS, REPAIR, validateAvailability, createCodexDispatchAdapter });
