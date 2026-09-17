'use strict';

// Runtime context is deliberately process-local. A checkout can be driven by
// Claude Code and Codex at the same time, so the project file must not be the
// place where the active host is persisted. GSD's own precedence is the model:
// an explicit runtime context wins, then the installed runtime marker, and the
// old project-level value is only a compatibility fallback.

const fs = require('fs');
const path = require('path');

const KNOWN_RUNTIMES = new Set(['claude', 'codex']);
const TRANSFER_CAPABILITY_SCHEMA = 'shipyard.session-transfer-capability.v1';
const TRANSFER_PROOF_CATEGORIES = Object.freeze([
  'fresh_bounded_context',
  'supported_launch_api',
  'active_child_enumeration',
  'durable_owner_acknowledgment',
  'dispatch_application_evidence_continuity',
  'crash_recovery',
]);
const TRANSFER_REFUSAL = 'automatic transfer is unsupported and unproven until a reviewed runtime-specific proving ground supplies every required evidence category';

function normalizeRuntime(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return null;
  if (['claude', 'claude-code', 'claude-cli'].includes(normalized)) return 'claude';
  if (['codex', 'codex-cli', 'codex-app'].includes(normalized)) return 'codex';
  // Preserve future runtime ids without allowing path/control characters into
  // diagnostics or route tokens.
  const safe = normalized.replace(/[^a-z0-9.-]/g, '');
  return safe || null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readJsonRuntime(root) {
  if (!root) return null;
  try {
    const file = path.join(root, '.planning', 'config.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? normalizeRuntime(parsed.runtime)
      : null;
  } catch {
    // The config reader owns malformed-config diagnostics. Runtime resolution
    // is advisory and must not turn that diagnostic into a stack trace.
    return null;
  }
}

function markerFromCoreHome(coreHome, strict = false) {
  const home = nonEmpty(coreHome);
  if (!home) return null;
  try {
    const marker = path.join(home, '.gsd-runtime');
    if (!fs.existsSync(marker)) return null;
    const value = fs.readFileSync(marker, 'utf8');
    return strict ? value : normalizeRuntime(value);
  } catch (error) {
    if (strict) throw runtimeError('UNKNOWN_RUNTIME', 'gsd-core-marker', error.message);
    return null;
  }
}

function markerFromTools(toolsPath, strict = false) {
  const tools = nonEmpty(toolsPath);
  if (!tools) return null;
  // <runtime-home>/gsd-core/bin/gsd-tools.cjs → <runtime-home>/gsd-core
  return markerFromCoreHome(path.resolve(path.dirname(tools), '..'), strict);
}

function markerFromPath(candidate) {
  const source = nonEmpty(candidate);
  if (!source) return null;
  const normalized = source.split(path.sep).join('/');
  // Installed Codex Shipyard scripts live under <CODEX_HOME>/shipyard; Claude
  // plugin scripts live under <CLAUDE_HOME>/.claude/plugins. Do not classify the
  // repository itself: `/claude-shipyard/` is a project name, not a runtime.
  if (/(^|\/)\.codex(?:\/|$)/.test(normalized)) return 'codex';
  if (/(^|\/)\.claude(?:\/|$)/.test(normalized)) return 'claude';
  return null;
}

function hostRuntime(env) {
  const codexSession = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']
    .some((key) => nonEmpty(env[key]));
  if (codexSession) return { runtime: 'codex', source: 'codex-session-env' };

  if (nonEmpty(env.CLAUDE_PLUGIN_ROOT) || nonEmpty(env.CLAUDE_CODE_ENTRYPOINT)) {
    return { runtime: 'claude', source: 'claude-session-env' };
  }
  return null;
}

// CODEX_HOME identifies an installed Codex configuration, not necessarily the
// runtime of the current process: a Claude session on a dual-runtime machine
// may inherit that variable too. It is therefore weaker than a session signal
// and weaker than an explicit legacy project value. Bundle paths and GSD's own
// marker remain stronger, because they belong to the install actually executing.
function installedRuntime(env) {
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (!codexHome) return null;
  try {
    return fs.existsSync(path.join(codexHome, 'config.toml'))
      ? { runtime: 'codex', source: 'codex-config-home' }
      : null;
  } catch {
    // An unreadable home is not proof that the current process is Codex.
    return null;
  }
}

function resolveRuntime(root, options = {}) {
  if (options.routed === true) return resolveDispatchContext(root, options);
  const env = options.env || process.env;
  const persisted = readJsonRuntime(root);
  const candidates = [
    [options.runtime, 'option'],
    [env.SHIPYARD_RUNTIME, 'shipyard-env'],
    [env.GSD_RUNTIME, 'gsd-env'],
    [options.runtimeMarker, 'runtime-marker'],
    [markerFromTools(options.gsdTools || env.SHIPYARD_GSD_TOOLS || env.GSD_TOOLS), 'gsd-tools-marker'],
    [markerFromCoreHome(options.gsdCoreHome || env.GSD_CORE_HOME), 'gsd-core-marker'],
    [markerFromPath(options.scriptPath), 'bundle-path'],
  ];

  for (const [value, source] of candidates) {
    const runtime = normalizeRuntime(value);
    if (runtime) {
      return {
        runtime,
        source,
        persisted,
        conflict: persisted && persisted !== runtime ? { persisted, effective: runtime } : null,
      };
    }
  }

  const host = hostRuntime(env);
  if (host) {
    return {
      runtime: host.runtime,
      source: host.source,
      persisted,
      conflict: persisted && persisted !== host.runtime
        ? { persisted, effective: host.runtime }
        : null,
    };
  }

  const persistedRuntime = normalizeRuntime(persisted);
  if (persistedRuntime) {
    return { runtime: persistedRuntime, source: 'project-config-legacy', persisted: persistedRuntime, conflict: null };
  }

  const installed = installedRuntime(env);
  if (installed) {
    return { runtime: installed.runtime, source: installed.source, persisted, conflict: null };
  }

  const fallback = normalizeRuntime(options.defaultRuntime);
  return { runtime: fallback, source: fallback ? 'default' : 'ambiguous', persisted, conflict: null };
}

function runtimeError(code, source, message) {
  return require('./model-policy.cjs').policyError(code, `${source}: ${message}`, { source });
}

// GSD inherits global defaults only when the project has no .planning directory.
// Inspect the original values: its permissive parser is not a routed fallback.
function readInheritedConfig(root, options = {}) {
  if (root && fs.existsSync(path.join(root, '.planning'))) return {};
  const env = options.env || process.env;
  const home = env.GSD_HOME || env.HOME || require('os').homedir();
  const file = path.join(home, '.gsd', 'defaults.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('must be a JSON object');
    }
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw runtimeError('INVALID_CONFIG', file, `cannot inspect inherited GSD settings: ${error.message}`);
  }
}

// Dispatches need evidence of the executing host. Installation presence,
// project state and compatibility defaults cannot establish that identity.
function resolveDispatchContext(root, options = {}) {
  const env = options.env || process.env;
  for (const [object, key, source] of [[options, 'runtime', 'option.runtime'],
    [options, 'runtimeMarker', 'runtime-marker'], [env, 'SHIPYARD_RUNTIME', 'SHIPYARD_RUNTIME'],
    [env, 'GSD_RUNTIME', 'GSD_RUNTIME']]) {
    if (object[key] === null) throw runtimeError('UNKNOWN_RUNTIME', source, 'runtime must not be null');
  }
  const candidates = [
    [options.runtime, 'option.runtime'],
    [nonEmpty(env.SHIPYARD_RUNTIME), 'SHIPYARD_RUNTIME'],
    [nonEmpty(env.GSD_RUNTIME), 'GSD_RUNTIME'],
    [options.runtimeMarker, 'runtime-marker'],
    [markerFromTools(options.gsdTools, true), 'option.gsdTools'],
    [markerFromTools(env.SHIPYARD_GSD_TOOLS, true), 'SHIPYARD_GSD_TOOLS'],
    [markerFromTools(env.GSD_TOOLS, true), 'GSD_TOOLS'],
    [markerFromCoreHome(options.gsdCoreHome, true), 'option.gsdCoreHome'],
    [markerFromCoreHome(env.GSD_CORE_HOME, true), 'GSD_CORE_HOME'],
    [markerFromPath(options.scriptPath), 'bundle-path'],
    [nonEmpty(env.CODEX_SANDBOX) || nonEmpty(env.CODEX_SANDBOX_NETWORK_DISABLED) ? 'codex' : undefined, 'codex-session-env'],
    [nonEmpty(env.CLAUDE_PLUGIN_ROOT) || nonEmpty(env.CLAUDE_CODE_ENTRYPOINT) ? 'claude' : undefined, 'claude-session-env'],
  ].filter(([value]) => value !== undefined && value !== null);
  let selected;
  for (const [value, source] of candidates) {
    // Do not sanitize malformed IDs into a supported runtime.
    const runtime = typeof value === 'string' && /^[a-zA-Z_ -]+$/.test(value.trim())
      ? normalizeRuntime(value) : null;
    if (!KNOWN_RUNTIMES.has(runtime)) {
      throw runtimeError('UNKNOWN_RUNTIME', source, `unknown runtime ${JSON.stringify(value)}`);
    }
    if (selected && selected.runtime !== runtime) {
      throw runtimeError('AMBIGUOUS_RUNTIME', source,
        `runtime ${runtime} conflicts with ${selected.source} (${selected.runtime})`);
    }
    if (!selected) selected = { runtime, source };
  }
  if (!selected) {
    throw runtimeError('AMBIGUOUS_RUNTIME', 'runtime-context',
      'no active runtime; project-config-legacy, CODEX_HOME and defaultRuntime are compatibility-only');
  }
  const { POLICY_VERSION, POLICY_HASH } = require('./model-policy.cjs');
  const persisted = readJsonRuntime(root);
  const context = {
    ...selected,
    persisted,
    conflict: persisted && persisted !== selected.runtime
      ? { persisted, effective: selected.runtime } : null,
    policy_version: POLICY_VERSION,
    policy_hash: POLICY_HASH,
  };
  if (options.dispatch_id !== undefined) {
    const id = options.dispatch_id;
    if (typeof id !== 'string' || !id || /[\s\u0000-\u001f\u007f]/.test(id)) {
      throw runtimeError('INVALID_INPUT', 'dispatch_id', 'must be a non-empty, whitespace-free launch identity');
    }
    context.dispatch_id = id;
  }
  if (context.conflict) Object.freeze(context.conflict);
  return Object.freeze(context);
}

function cleanEvidenceText(value) {
  return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim().slice(0, 256) : null;
}

function capabilityContext(root, options = {}) {
  const supplied = options.runtime_context || options.runtimeContext;
  const context = supplied || resolveDispatchContext(root, {
    ...options,
    routed: true,
  });
  if (!context || !KNOWN_RUNTIMES.has(context.runtime)) {
    throw runtimeError('UNKNOWN_RUNTIME', 'transfer-capability', 'a strict active runtime context is required');
  }
  const { POLICY_VERSION, POLICY_HASH } = require('./model-policy.cjs');
  if (context.policy_version !== POLICY_VERSION || context.policy_hash !== POLICY_HASH) {
    throw runtimeError('STALE_POLICY', 'transfer-capability', 'runtime context policy evidence is stale or missing');
  }
  if (options.runtime !== undefined && normalizeRuntime(options.runtime) !== context.runtime) {
    throw runtimeError('AMBIGUOUS_RUNTIME', 'transfer-capability',
      `requested runtime ${JSON.stringify(options.runtime)} conflicts with active runtime ${context.runtime}`);
  }
  return context;
}

function reportTransferCapability(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw runtimeError('INVALID_INPUT', 'transfer-capability', 'capability options must be an object');
  }
  const context = capabilityContext(options.root || options.cwd || null, options);
  const host = options.host || options.host_capabilities || options.hostCapabilities || {};
  if (!host || typeof host !== 'object' || Array.isArray(host)) {
    throw runtimeError('INVALID_INPUT', 'transfer-capability', 'host evidence must be an object');
  }
  const hostRuntime = normalizeRuntime(host.runtime);
  if (hostRuntime && hostRuntime !== context.runtime) {
    throw runtimeError('AMBIGUOUS_RUNTIME', 'transfer-capability',
      `host runtime ${hostRuntime} conflicts with active runtime ${context.runtime}`);
  }
  const hostVersion = cleanEvidenceText(host.version || host.host_version || options.host_version);
  const rawEvidence = options.evidence || options.proof || {};
  if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
    throw runtimeError('INVALID_INPUT', 'transfer-capability', 'transfer proof evidence must be an object');
  }
  const evidence = {};
  const missing = [];
  for (const category of TRANSFER_PROOF_CATEGORIES) {
    const raw = rawEvidence[category];
    const sameHost = raw && raw.runtime === context.runtime && raw.host_version === hostVersion;
    const usable = sameHost && raw.status === 'proven'
      && cleanEvidenceText(raw.evidence_id)
      && raw.synthetic !== true
      && raw.reviewed === true
      && cleanEvidenceText(raw.source)
      && raw.source !== 'synthetic-fixture'
      && raw.source !== 'cli';
    evidence[category] = {
      status: usable ? 'unproven' : (raw ? 'missing' : 'missing'),
      evidence_id: usable ? cleanEvidenceText(raw.evidence_id) : null,
      source: usable ? cleanEvidenceText(raw.source) : null,
      runtime: raw && cleanEvidenceText(raw.runtime),
      host_version: raw && cleanEvidenceText(raw.host_version),
      reason: usable ? 'a positive observation still needs the separately reviewed host adapter contract' : 'no trusted host-bound proving-ground evidence',
    };
    if (!usable) missing.push(category);
  }
  if (!hostVersion) missing.unshift('host_version');
  if (!missing.includes('reviewed_host_adapter_contract')) missing.push('reviewed_host_adapter_contract');
  if (!missing.includes('real_proving_ground_run')) missing.push('real_proving_ground_run');
  return Object.freeze({
    schema: TRANSFER_CAPABILITY_SCHEMA,
    version: 1,
    runtime: context.runtime,
    runtime_source: context.source,
    policy_version: context.policy_version,
    policy_hash: context.policy_hash,
    host: Object.freeze({ runtime: hostRuntime || null, version: hostVersion, evidence_source: cleanEvidenceText(host.source) }),
    evidence: Object.freeze(evidence),
    required_evidence: Object.freeze([...TRANSFER_PROOF_CATEGORIES]),
    missing_evidence: Object.freeze([...new Set(missing)]),
    status: 'unsupported',
    confidence: 'unproven',
    reason: TRANSFER_REFUSAL,
    automatic_transfer: Object.freeze({
      allowed: false,
      status: 'unsupported',
      confidence: 'unproven',
      side_effect: 'none',
      reason: TRANSFER_REFUSAL,
    }),
    manual_resume: Object.freeze({
      status: 'available',
      required: true,
      instruction: 'checkpoint at a clean boundary, then explicitly resume and acknowledge the successor after live revalidation',
    }),
  });
}

module.exports = {
  KNOWN_RUNTIMES,
  TRANSFER_CAPABILITY_SCHEMA,
  TRANSFER_PROOF_CATEGORIES,
  TRANSFER_REFUSAL,
  normalizeRuntime,
  readJsonRuntime,
  resolveRuntime,
  resolveDispatchContext,
  reportTransferCapability,
  readInheritedConfig,
};
