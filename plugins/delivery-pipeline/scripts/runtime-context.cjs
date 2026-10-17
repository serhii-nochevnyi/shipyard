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
const CODEX_CAPABILITIES_BUNDLE_FILE = 'codex-capabilities.json';

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

function hostEnvironmentError(code, message, vars) {
  const error = new Error('runtime-context: ' + message);
  error.name = 'HostEnvironmentError';
  error.code = code;
  if (vars) error.vars = Object.freeze({ ...vars });
  return error;
}

function physicalPath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function readBundleManifest(home, bundleRoot) {
  const file = path.join(home, 'agents', '.shipyard-manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw hostEnvironmentError('BUNDLE_MANIFEST_INVALID', `cannot read the installer manifest ${file}: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw hostEnvironmentError('BUNDLE_MANIFEST_INVALID', `the installer manifest ${file} must be a JSON object`);
  }
  for (const [field, expected] of [['scriptsRoot', bundleRoot], ['codexHome', home]]) {
    const declared = typeof manifest[field] === 'string' ? physicalPath(manifest[field]) : null;
    if (declared !== expected) {
      throw hostEnvironmentError('BUNDLE_MANIFEST_INVALID',
        `manifest ${field} ${JSON.stringify(manifest[field])} does not name this bundle (${expected})`);
    }
  }
  return { file, manifest };
}

// @security: bundle evidence is trusted only after its installer digest and the capability grid both agree.
function readBundleCapabilities(bundleRoot, manifest) {
  const file = path.join(bundleRoot, CODEX_CAPABILITIES_BUNDLE_FILE);
  if (manifest.capabilities_file !== CODEX_CAPABILITIES_BUNDLE_FILE) {
    throw hostEnvironmentError('BUNDLE_MANIFEST_INVALID',
      `manifest capabilities_file ${JSON.stringify(manifest.capabilities_file)} is not ${CODEX_CAPABILITIES_BUNDLE_FILE}`);
  }
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) { throw hostEnvironmentError('CAPABILITY_EVIDENCE_STALE', `cannot read ${file}: ${error.message}`); }
  const actual = require('crypto').createHash('sha256').update(raw).digest('hex');
  if (actual !== manifest.capabilities_digest) {
    throw hostEnvironmentError('CAPABILITY_EVIDENCE_STALE',
      `${file} digest ${actual} differs from the installer manifest digest ${manifest.capabilities_digest}`);
  }
  let capabilities;
  try {
    capabilities = JSON.parse(raw.toString('utf8'));
    require('./gsd-tune.cjs').validateCodexCapabilities(capabilities, manifest.phase);
  } catch (error) {
    throw hostEnvironmentError('CAPABILITY_EVIDENCE_STALE', `${file} does not satisfy the ADR-014 grid: ${error.message}`);
  }
  return { file, capabilities };
}

const RESOLVER_CODES = Object.freeze([
  'ENV_CONFLICT', 'BUNDLE_MANIFEST_INVALID', 'CAPABILITY_EVIDENCE_STALE',
]);

function claudeHomeOf(env) {
  const configured = env && nonEmpty(env.CLAUDE_CONFIG_DIR);
  if (configured) return configured;
  return path.join((env && nonEmpty(env.HOME)) || require('os').homedir(), '.claude');
}

function resolveClaudeHome({ env = process.env } = {}) {
  return claudeHomeOf(env);
}

function explicitCodexHome(env, flags) {
  return nonEmpty(flags && flags.codexHome) || (env && nonEmpty(env.CODEX_HOME)) || null;
}

function explicitCapabilitiesFile(env, flags) {
  return nonEmpty(flags && flags.capabilitiesFile)
    || (env && nonEmpty(env.SHIPYARD_CODEX_CAPABILITIES_FILE)) || null;
}

function sameFile(candidate, expectedFile, expectedDigest) {
  const physical = physicalPath(candidate);
  if (physical && physical === physicalPath(expectedFile)) return true;
  try {
    return require('crypto').createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') === expectedDigest;
  } catch { return false; }
}

// @contract: a disagreeing explicit home or evidence file refuses; an agreeing one is accepted.
function checkExplicitSources(env, flags, home, capabilitiesFile, manifest) {
  const homes = [
    [flags && nonEmpty(flags.codexHome), '--codex-home'],
    [env && nonEmpty(env.CODEX_HOME), 'CODEX_HOME'],
  ];
  for (const [value, name] of homes) {
    if (value && (physicalPath(value) || path.resolve(value)) !== home) {
      throw hostEnvironmentError('ENV_CONFLICT',
        `${name}=${value} disagrees with the Codex home ${home} of the installed bundle that is running`,
        { explicit: `${name}=${value}`, bundle_value: home });
    }
  }
  const files = [
    [flags && nonEmpty(flags.capabilitiesFile), '--capabilities-file'],
    [env && nonEmpty(env.SHIPYARD_CODEX_CAPABILITIES_FILE), 'SHIPYARD_CODEX_CAPABILITIES_FILE'],
  ];
  for (const [value, name] of files) {
    if (value && !sameFile(value, capabilitiesFile, manifest.capabilities_digest)) {
      throw hostEnvironmentError('ENV_CONFLICT',
        `${name}=${value} disagrees with the capability evidence ${capabilitiesFile} of the installed bundle that is running`,
        { explicit: `${name}=${value}`, bundle_value: capabilitiesFile });
    }
  }
}

function resolveHostEnvironment({ scriptDir, runtime, env = process.env, flags = {} } = {}) {
  if (runtime === 'claude') {
    return Object.freeze({ mode: 'claude', runtime, claudeHome: claudeHomeOf(env) });
  }
  const source = Object.freeze({ mode: 'source', runtime: runtime || null });
  if (runtime !== 'codex' || typeof scriptDir !== 'string' || !scriptDir) return source;
  const bundleRoot = physicalPath(path.join(scriptDir, '..'));
  if (!bundleRoot || !fs.existsSync(path.join(bundleRoot, CODEX_CAPABILITIES_BUNDLE_FILE))) return source;
  const home = path.dirname(bundleRoot);
  const { file: manifestFile, manifest } = readBundleManifest(home, bundleRoot);
  const { file: capabilitiesFile, capabilities } = readBundleCapabilities(bundleRoot, manifest);
  checkExplicitSources(env, flags, home, capabilitiesFile, manifest);
  return Object.freeze({
    mode: 'installed', runtime, home, bundleRoot, manifestFile, manifest, capabilitiesFile, capabilities,
    agentsDir: path.join(home, 'agents'),
  });
}

function resolveCodexHome({ scriptDir, env = process.env, flags = {} } = {}) {
  const resolved = resolveHostEnvironment({ scriptDir, runtime: 'codex', env, flags });
  if (resolved.mode === 'installed') return resolved.home;
  return explicitCodexHome(env, flags)
    || path.join((env && nonEmpty(env.HOME)) || require('os').homedir(), '.codex');
}

// @contract: only the Codex home, capability path and runtime are set; every other key is copied untouched.
function launchEnvironment(resolved, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (resolved && resolved.mode === 'installed') {
    env.CODEX_HOME = resolved.home;
    env.SHIPYARD_CODEX_CAPABILITIES_FILE = resolved.capabilitiesFile;
    env.SHIPYARD_RUNTIME = resolved.runtime;
  } else if (resolved && resolved.mode === 'claude') {
    env.SHIPYARD_RUNTIME = resolved.runtime;
  }
  return env;
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

const PREFLIGHT_CODES = Object.freeze([
  'ENV_CONFLICT', 'BUNDLE_MANIFEST_INVALID', 'CAPABILITY_EVIDENCE_STALE', 'RUNTIME_CAPABILITY_MISSING',
  'UNKNOWN_RUNTIME', 'AMBIGUOUS_RUNTIME', 'STALE_GENERATED_AGENT', 'RUNTIME_UNAVAILABLE',
  'LEGACY_HISTORY_UNSAFE', 'LEGACY_HISTORY_CHANGED', 'LEGACY_HISTORY_UNKNOWN_MEMBER', 'LEGACY_HISTORY_MISSING',
  'ARCHIVE_AUTHORITY_INVALID', 'LEGACY_WRITER_STATE', 'INVALID_STORE',
]);

function preflightGraphDir(graphDir, worktree, env) {
  if (graphDir === null) return null;
  let candidate = graphDir;
  if (candidate === undefined) {
    candidate = nonEmpty(env.SHIPYARD_GRAPH_DIR);
    if (!candidate && typeof worktree === 'string' && worktree) {
      let top = worktree;
      try {
        top = require('child_process').execFileSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || worktree;
      } catch { top = worktree; }
      candidate = path.join(top, '.planning', 'graph');
    }
  }
  if (typeof candidate !== 'string' || !candidate) return null;
  const directory = path.resolve(candidate);
  if (path.basename(directory) !== 'graph' || path.basename(path.dirname(directory)) !== '.planning') return null;
  return fs.existsSync(directory) ? directory : null;
}

function errorCode(error) {
  return error && typeof error.code === 'string' && error.code ? error.code : 'UNKNOWN';
}

function installedCodexCliVersion() {
  const result = require('child_process').spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (!result || result.error || result.status !== 0) return null;
  const match = /(\d+\.\d+(?:\.\d+)*)/.exec(`${result.stdout || ''} ${result.stderr || ''}`);
  return match ? match[1] : null;
}

// @contract: preflight is read-only, collects every incompatibility and never throws.
function preflight(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const env = opts.env || process.env;
  const scope = opts.scope === 'environment' ? 'environment' : 'launch';
  const host = typeof opts.host === 'string' && opts.host ? opts.host : 'deliver-dispatch.cjs';
  const findings = [], warnings = [], notes = [];
  const note = (kind, detail) => notes.push({ kind, detail });
  const find = (code, detail, vars = {}) => findings.push({ code, detail: String(detail), vars: { host, ...vars } });
  const run = (name, fn) => {
    try { fn(); } catch (error) {
      const code = errorCode(error);
      if (PREFLIGHT_CODES.includes(code)) find(code, error.message, error.vars);
      else note('not-evaluated', `${name}: check not evaluated (${code})`);
    }
  };
  let resolved = null;
  run('environment and bundle', () => {
    resolved = resolveHostEnvironment({ scriptDir: opts.scriptDir, runtime: opts.runtime, env, flags: opts.flags || {} });
  });
  if (!resolved) note('not-evaluated', 'policy and generated agents: not evaluated, no resolved environment');
  const bundle = resolved && resolved.bundleRoot;
  const withBundle = (vars) => (bundle ? { ...vars, bundle } : vars);
  for (const finding of findings) finding.vars = withBundle(finding.vars);

  run('runtime identity', () => {
    resolveDispatchContext(opts.worktree, {
      routed: true, runtime: opts.runtime, env, scriptPath: opts.scriptDir,
    });
  });

  run('policy and generated agents', () => {
    if (!resolved || resolved.mode !== 'installed') return;
    const manifest = resolved.manifest;
    const stale = [];
    const { POLICY_HASH } = require('./model-policy.cjs');
    if (manifest.policy_hash !== POLICY_HASH) stale.push('policy_hash');
    const files = Array.isArray(manifest.agent_files) ? manifest.agent_files : [];
    const digests = manifest.agent_digests && typeof manifest.agent_digests === 'object' ? manifest.agent_digests : {};
    for (const name of files) {
      let actual = null;
      try {
        actual = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(resolved.agentsDir, name))).digest('hex');
      } catch { actual = null; }
      if (actual === null || actual !== digests[name]) stale.push(name);
    }
    if (stale.length) find('STALE_GENERATED_AGENT', `stale or missing: ${stale.join(', ')}`, { bundle: resolved.bundleRoot, files: stale.join(', ') });
  });

  run('capability snapshot age', () => {
    if (!resolved || resolved.mode !== 'installed') return;
    const recorded = resolved.manifest.codex_cli_version;
    if (typeof recorded !== 'string' || !recorded) return;
    const current = (typeof opts.cliVersion === 'function' ? opts.cliVersion : installedCodexCliVersion)();
    if (typeof current !== 'string' || !current || current === recorded) return;
    warnings.push({
      code: 'CAPABILITY_SNAPSHOT_AGED',
      detail: `capability evidence was recorded with Codex CLI ${recorded}; installed is ${current}`,
      vars: withBundle({ host, recorded, current }),
    });
  });

  run('runtime probe', () => {
    if (typeof opts.probe !== 'function') return;
    const result = opts.probe();
    if (result && result.status === 'unavailable') {
      const reason = String(result.reason || 'unknown');
      const code = /capability/.test(reason) ? 'RUNTIME_CAPABILITY_MISSING' : 'RUNTIME_UNAVAILABLE';
      find(code, `${reason}${result.detail ? ': ' + result.detail : ''}`, withBundle({}));
    }
  });

  if (scope === 'launch') {
    run('legacy history', () => {
      const directory = preflightGraphDir(opts.graphDir, opts.worktree, env);
      if (!directory) { note('not-evaluated', 'legacy history: not evaluated, no graph directory'); return; }
      const root = fs.realpathSync(path.resolve(directory, '..', '..'));
      const result = require('./role-artifact.cjs').classifyLegacyProvenance(root);
      if (result.state === 'unreadable') {
        note('not-evaluated', `legacy history: not evaluated, authority namespace unreadable (${result.unreadable && result.unreadable.code})`);
        return;
      }
      for (const item of result.findings) find(item.code, item.detail || item.code, withBundle({ path: item.path || '' }));
      for (const item of result.warnings) {
        warnings.push({ code: item.code, detail: item.path || item.code, vars: withBundle({ host, path: item.path || '' }) });
      }
      if (result.state === 'adoptable') note('adoptable', `legacy history: adoption will record ${result.members.length} member(s)`);
    });
    if (typeof opts.gsdRole === 'string' && opts.gsdRole && opts.worktree && opts.phaseDir) {
      run('planning writer state', () => {
        require('./planning-writer-lease.cjs').assertNoLegacyPlanningWriter({
          worktree: opts.worktree, phaseDir: opts.phaseDir, roots: opts.writerRoots || [],
        });
      });
    }
    if (typeof opts.runStoreFile === 'string' && opts.runStoreFile) {
      run('run store', () => {
        let raw;
        try { raw = fs.readFileSync(opts.runStoreFile, 'utf8'); } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) { find('INVALID_STORE', `run store is not JSON: ${error.message}`, withBundle({})); return; }
        require('./run-store.cjs').normalizeStore(parsed);
      });
    }
  }
  for (const finding of findings) finding.vars = withBundle(finding.vars);
  return { schema: 'shipyard.host-preflight.v1', ok: findings.length === 0, scope, findings, warnings, notes };
}

function emitPreflight(result, streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const { formatHint, stripControl } = require('./refusal-hints.cjs');
  const count = result.findings.length;
  const lines = [count === 0 ? 'preflight: ok' : `preflight: ${count} incompatibilities`];
  const clean = (value) => stripControl(value === undefined || value === null ? '' : value);
  for (const finding of result.findings) {
    const detail = clean(finding.detail);
    lines.push(formatHint(finding.code, finding.vars) + (detail ? ` (detail: ${detail})` : ''));
  }
  for (const warning of result.warnings) lines.push(`preflight: warning[${clean(warning.code)}] ${clean(warning.detail)}`);
  for (const item of result.notes) lines.push(`preflight: note ${clean(item.detail)}`);
  stderr.write(lines.join('\n') + '\n');
  stdout.write(JSON.stringify(result) + '\n');
  return result.ok ? 0 : 1;
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
  resolveHostEnvironment,
  launchEnvironment,
  resolveCodexHome,
  resolveClaudeHome,
  RESOLVER_CODES,
  PREFLIGHT_CODES,
  preflight,
  emitPreflight,
  reportTransferCapability,
  readInheritedConfig,
};
