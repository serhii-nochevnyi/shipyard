#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { withLock, writeAtomic, lockDirFor } = require('./lock.cjs');

const SCHEMA = 'shipyard.autonomous-rollout.v2';
const LEGACY_SCHEMA = 'shipyard.autonomous-rollout.v1';
const CAPABILITY_SCHEMA = 'shipyard.runtime-capability.v1';
const VERSION = 2;
const ROLLOUT_VERSION = 'v2';
const LEGACY_ROLLOUT_VERSION = 'v1';
const CAPABILITY_VERSION = 1;
const RUNTIMES = Object.freeze(['claude', 'codex']);
const PROVIDERS = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const SHARED_FILES = Object.freeze([
  'plugins/delivery-pipeline/scripts/command-runner.cjs',
  'plugins/delivery-pipeline/scripts/run-contract.cjs',
  'plugins/delivery-pipeline/scripts/run-store.cjs',
  'plugins/delivery-pipeline/scripts/run-controller.cjs',
  'plugins/delivery-pipeline/scripts/run-waker.cjs',
  'plugins/delivery-pipeline/scripts/stop-gate.cjs',
  'plugins/delivery-pipeline/scripts/ci-wait.cjs',
  'plugins/delivery-pipeline/scripts/run-reachability.cjs',
  'plugins/delivery-pipeline/scripts/run-telemetry.cjs',
  'plugins/delivery-pipeline/scripts/usage-attribution.cjs',
  'plugins/delivery-pipeline/scripts/pipeline-stats.cjs',
]);
const RUNTIME_FILES = Object.freeze({
  claude: Object.freeze([
    'plugins/delivery-pipeline/scripts/claude-runtime-host.cjs',
    'plugins/delivery-pipeline/scripts/claude-workflow-host.cjs',
    'plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs',
    'plugins/delivery-pipeline/scripts/claude-role-host.cjs',
    'plugins/delivery-pipeline/scripts/claude-delivery-host.cjs',
    'plugins/delivery-pipeline/scripts/claude-investigation-host.cjs',
    'plugins/delivery-pipeline/scripts/claude-decompose-host.cjs',
  ]),
  codex: Object.freeze([
    'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs',
    'plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs',
    'plugins/delivery-pipeline/scripts/codex-agent.cjs',
    'plugins/delivery-pipeline/scripts/codex-delivery-host.cjs',
    'plugins/delivery-pipeline/scripts/codex-decompose-host.cjs',
  ]),
});
const DEFAULTS = Object.freeze({
  runtimes: Object.freeze({ claude: false, codex: false }),
  source: 'default',
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function safe(value, field, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty safe string`);
  }
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

function failure(code, message, details = {}) {
  return { code, message, details };
}

function providerFor(runtime) {
  return PROVIDERS[runtime] || null;
}

function defaultFlag() {
  return {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: ROLLOUT_VERSION,
    status: 'disabled',
    source: DEFAULTS.source,
    runtimes: clone(DEFAULTS.runtimes),
    fingerprint: digest(DEFAULTS),
  };
}

function refusedFlag(reason) {
  return {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: ROLLOUT_VERSION,
    status: 'refused',
    source: 'config',
    runtimes: clone(DEFAULTS.runtimes),
    reason,
  };
}

function normalizedFlag(runtimes, extra = {}) {
  const enabled = RUNTIMES.some((runtime) => runtimes[runtime]);
  const result = {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: ROLLOUT_VERSION,
    status: enabled ? 'pending' : 'disabled',
    source: 'config',
    runtimes,
    ...extra,
  };
  result.fingerprint = digest({ version: ROLLOUT_VERSION, runtimes });
  return result;
}

function normalizeFlag(raw) {
  if (raw === undefined || raw === null) return defaultFlag();
  if (!object(raw)) return refusedFlag(failure('INVALID_FLAG', 'autonomous_control_plane must be an object'));
  if (raw.version === LEGACY_ROLLOUT_VERSION) {
    if (raw.schema !== undefined && raw.schema !== LEGACY_SCHEMA) {
      return refusedFlag(failure('INVALID_SCHEMA', 'legacy rollout schema does not match its version'));
    }
    if (typeof raw.enabled !== 'boolean') {
      return refusedFlag(failure('INVALID_FLAG', 'legacy rollout flag enabled must be boolean'));
    }
    if (raw.runtimes !== undefined && !object(raw.runtimes)) {
      return refusedFlag(failure('INVALID_FLAG', 'legacy rollout runtimes must be an object'));
    }
    const legacyRuntimes = object(raw.runtimes) ? raw.runtimes : {};
    if (Object.keys(legacyRuntimes).some((runtime) => !RUNTIMES.includes(runtime))) {
      return refusedFlag(failure('UNKNOWN_RUNTIME', 'legacy rollout flag contains an unsupported runtime'));
    }
    if (Object.values(legacyRuntimes).some((enabled) => typeof enabled !== 'boolean')) {
      return refusedFlag(failure('INVALID_FLAG', 'legacy rollout runtime flags must be boolean'));
    }
    if (raw.enabled && RUNTIMES.some((runtime) => legacyRuntimes[runtime] !== true)) {
      return refusedFlag(failure('RUNTIME_FLAG_INCOMPLETE', 'legacy rollout requires both runtimes to be enabled'));
    }
    return normalizedFlag(
      Object.fromEntries(RUNTIMES.map((runtime) => [runtime, raw.enabled])),
      { migrated_from: LEGACY_ROLLOUT_VERSION },
    );
  }
  if (raw.version !== ROLLOUT_VERSION) {
    return refusedFlag(failure('UNSUPPORTED_ROLLOUT_VERSION', `rollout flag version must be ${ROLLOUT_VERSION}`));
  }
  if (raw.schema !== undefined && raw.schema !== SCHEMA) {
    return refusedFlag(failure('INVALID_SCHEMA', 'rollout schema does not match its version'));
  }
  if (raw.runtimes !== undefined && !object(raw.runtimes)) {
    return refusedFlag(failure('INVALID_FLAG', 'rollout flag runtimes must be an object'));
  }
  const inputRuntimes = raw.runtimes || {};
  if (Object.keys(inputRuntimes).some((runtime) => !RUNTIMES.includes(runtime))) {
    return refusedFlag(failure('UNKNOWN_RUNTIME', 'rollout flag contains an unsupported runtime'));
  }
  for (const runtime of RUNTIMES) {
    if (inputRuntimes[runtime] !== undefined && typeof inputRuntimes[runtime] !== 'boolean') {
      return refusedFlag(failure('INVALID_FLAG', `rollout flag ${runtime} must be boolean`));
    }
  }
  const runtimes = Object.fromEntries(RUNTIMES.map((runtime) => [runtime, inputRuntimes[runtime] === true]));
  const enabled = RUNTIMES.some((runtime) => runtimes[runtime]);
  if (raw.enabled !== undefined && (typeof raw.enabled !== 'boolean' || raw.enabled !== enabled)) {
    return refusedFlag(failure('FLAG_CONFLICT', 'rollout flag enabled must match its runtime opt-ins'));
  }
  return normalizedFlag(runtimes);
}

function configPath(root) {
  return path.join(root, '.planning', 'config.json');
}

function readConfig(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) return { config: {}, error: null };
  try {
    return { config: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { config: {}, error: failure('INVALID_CONFIG', `cannot read ${path.relative(root, file)}`) };
  }
}

function flagFromConfig(config) {
  if (!object(config)) return refusedFlag(failure('INVALID_CONFIG', 'project config must be an object'));
  const delivery = object(config.delivery_pipeline) ? config.delivery_pipeline : null;
  const pipeline = object(config.pipeline) ? config.pipeline : null;
  const raw = delivery?.autonomous_control_plane
    ?? pipeline?.autonomous_control_plane
    ?? config.autonomous_control_plane;
  return normalizeFlag(raw);
}

function readFlag(root) {
  const { config, error } = readConfig(root);
  if (error) return { ...refusedFlag(error), source: 'config' };
  return flagFromConfig(config);
}

function capabilityResult(runtime, status, reason, extra = {}) {
  return {
    runtime,
    provider: providerFor(runtime),
    status,
    source: extra.source || 'live',
    observed: status === 'available',
    ...(reason ? { reason } : {}),
    ...extra,
  };
}

function scopeMismatch(expected, actual) {
  if (!object(expected)) return null;
  if (!object(actual)) return 'scope';
  for (const key of ['repository_id', 'phase', 'ticket', 'worktree', 'base', 'base_sha']) {
    if (expected[key] !== undefined && expected[key] !== actual[key]) return key;
  }
  return null;
}

function validateCapabilityEvidence(evidence, { runtime, expectedScope = null } = {}) {
  if (!object(evidence)) return capabilityResult(runtime, 'unavailable', failure('MISSING_CAPABILITY', 'live capability evidence is missing'));
  const actualRuntime = evidence.runtime;
  if (actualRuntime !== runtime) {
    return capabilityResult(runtime, 'refused', failure('WRONG_RUNTIME', 'capability evidence belongs to another runtime'), { evidence_runtime: actualRuntime });
  }
  if (evidence.schema !== CAPABILITY_SCHEMA || evidence.version !== CAPABILITY_VERSION) {
    return capabilityResult(runtime, 'refused', failure('INVALID_CAPABILITY_SCHEMA', 'capability evidence schema is unsupported'));
  }
  if (evidence.provider !== providerFor(runtime)) {
    return capabilityResult(runtime, 'refused', failure('WRONG_PROVIDER', 'runtime/provider mapping is invalid'));
  }
  if (evidence.status !== 'available' || evidence.source !== 'live' || evidence.observed !== true) {
    return capabilityResult(runtime, 'refused', failure('NON_LIVE_CAPABILITY', 'rollout requires observed live capability evidence'));
  }
  if (evidence.credentials !== 'available') {
    return capabilityResult(runtime, 'unavailable', failure('CREDENTIALS_UNAVAILABLE', 'runtime credentials are unavailable'));
  }
  if (evidence.agent_status === 'stale' || evidence.agent?.status === 'stale' || evidence.stale_agent === true) {
    return capabilityResult(runtime, 'refused', failure('STALE_AGENT', 'runtime agent evidence is stale'));
  }
  if (evidence.inherited_model === true || evidence.model?.inherited === true || evidence.selection?.inherited === true) {
    return capabilityResult(runtime, 'refused', failure('INHERITED_MODEL', 'runtime capability may not inherit a model'));
  }
  const mismatch = scopeMismatch(expectedScope, evidence.scope);
  if (mismatch || evidence.scope_status === 'mismatch') {
    return capabilityResult(runtime, 'refused', failure('WRONG_SCOPE', `runtime scope does not match${mismatch ? ` ${mismatch}` : ''}`));
  }
  if (evidence.base_status === 'stale' || evidence.base?.status === 'stale' || evidence.stale_base === true) {
    return capabilityResult(runtime, 'refused', failure('STALE_BASE', 'runtime base evidence is stale'));
  }
  if (evidence.receipts?.status !== 'verified' || evidence.receipts?.observed !== true) {
    return capabilityResult(runtime, 'unavailable', failure('RECEIPTS_UNAVAILABLE', 'verified runtime receipts are unavailable'));
  }
  if (evidence.usage?.status !== 'complete' || evidence.usage?.observed !== true) {
    return capabilityResult(runtime, 'refused', failure('INCOMPLETE_USAGE', 'complete usage evidence is required'));
  }
  if (evidence.telemetry?.status !== 'complete' || evidence.telemetry?.observed !== true) {
    return capabilityResult(runtime, 'unavailable', failure('TELEMETRY_UNAVAILABLE', 'complete runtime telemetry is unavailable'));
  }
  if (evidence.run_contract?.schema !== 'shipyard.run.v1' || evidence.run_contract.version !== 1) {
    return capabilityResult(runtime, 'refused', failure('RUN_CONTRACT_MISMATCH', 'runtime does not attest the shared run contract'));
  }
  if (evidence.agent_status && evidence.agent_status !== 'fresh') {
    return capabilityResult(runtime, 'unavailable', failure('AGENT_UNAVAILABLE', 'runtime agent is not ready'));
  }
  return capabilityResult(runtime, 'available', null, {
    evidence_schema: evidence.schema,
    capability_fingerprint: digest({
      runtime: evidence.runtime,
      provider: evidence.provider,
      scope: evidence.scope || null,
      base: evidence.base || null,
      model: evidence.model || null,
      receipts: evidence.receipts,
      usage: evidence.usage,
      telemetry: evidence.telemetry,
      run_contract: evidence.run_contract,
    }),
  });
}

function existingFiles(root, files) {
  return files.filter((file) => !fs.existsSync(path.join(root, file)));
}

function credentialResult(runtime, status, reason, extra = {}) {
  return {
    runtime,
    provider: providerFor(runtime),
    status,
    source: runtime === 'claude' ? 'claude-auth-status' : 'codex-login-status',
    ...(reason ? { reason } : {}),
    ...extra,
  };
}

function readCredentialStatus(runtime, { env = process.env, commandRunner = spawnSync } = {}) {
  if (!RUNTIMES.includes(runtime)) {
    return credentialResult(runtime, 'refused', failure('WRONG_RUNTIME', 'unsupported runtime'));
  }
  const command = runtime === 'claude' ? 'claude' : 'codex';
  const args = runtime === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  let result;
  try {
    result = commandRunner(command, args, {
      encoding: 'utf8',
      env,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_) {
    return credentialResult(runtime, 'unavailable', failure('RUNTIME_UNAVAILABLE', 'runtime CLI could not be started'));
  }
  if (result?.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'AUTH_STATUS_TIMEOUT'
      : result.error.code === 'ENOENT' ? 'RUNTIME_UNAVAILABLE' : 'AUTH_STATUS_FAILED';
    const message = code === 'RUNTIME_UNAVAILABLE' ? 'runtime CLI is not installed'
      : code === 'AUTH_STATUS_TIMEOUT' ? 'runtime authentication status timed out'
        : 'runtime authentication status could not be read';
    return credentialResult(runtime, 'unavailable', failure(code, message));
  }
  if (result?.status !== 0) {
    return credentialResult(runtime, 'unavailable', failure('CREDENTIALS_UNAVAILABLE', 'runtime authentication is not available'));
  }
  if (runtime === 'codex') return credentialResult(runtime, 'available', null);
  let status;
  try { status = JSON.parse(String(result.stdout || '')); }
  catch (_) {
    return credentialResult(runtime, 'refused', failure('AUTH_STATUS_INVALID', 'Claude authentication status is not valid JSON'));
  }
  if (!object(status) || typeof status.loggedIn !== 'boolean') {
    return credentialResult(runtime, 'refused', failure('AUTH_STATUS_INVALID', 'Claude authentication status has an unsupported shape'));
  }
  if (!status.loggedIn) {
    return credentialResult(runtime, 'unavailable', failure('CREDENTIALS_UNAVAILABLE', 'Claude is not authenticated'));
  }
  if (status.apiProvider !== 'firstParty') {
    return credentialResult(runtime, 'refused', failure('WRONG_PROVIDER', 'Claude authentication is not Anthropic first-party'));
  }
  const methods = { 'claude.ai': 'oauth', oauth: 'oauth', apikey: 'api-credential', 'api-key': 'api-credential' };
  const method = methods[String(status.authMethod || '').toLowerCase()];
  if (!method) {
    return credentialResult(runtime, 'refused', failure('AUTH_STATUS_INVALID', 'Claude authentication method is unsupported'));
  }
  return credentialResult(runtime, 'available', null, { method });
}

function probeRuntime({ root, runtime, evidence = null, expectedScope = null,
  credentialEvidence = null, commandRunner = spawnSync, env = process.env } = {}) {
  if (!RUNTIMES.includes(runtime)) return capabilityResult(runtime, 'refused', failure('WRONG_RUNTIME', 'unsupported runtime'));
  const credentials = credentialEvidence || readCredentialStatus(runtime, { env, commandRunner });
  const credentialExtra = { credential_status: credentials };
  if (credentials.status === 'refused') {
    return capabilityResult(runtime, 'refused', credentials.reason || failure('AUTH_STATUS_INVALID', 'runtime authentication was refused'), credentialExtra);
  }
  const sharedMissing = existingFiles(root, SHARED_FILES);
  const runtimeMissing = existingFiles(root, RUNTIME_FILES[runtime]);
  if (sharedMissing.length || runtimeMissing.length) {
    return capabilityResult(runtime, 'unavailable', failure('MISSING_RUNTIME_CAPABILITY', 'runtime capability files are missing', {
      shared: sharedMissing,
      runtime: runtimeMissing,
    }), { ...credentialExtra, missing_files: [...sharedMissing, ...runtimeMissing] });
  }
  if (credentials.status !== 'available') {
    return capabilityResult(runtime, 'unavailable', credentials.reason || failure('CREDENTIALS_UNAVAILABLE', 'runtime authentication is not available'), credentialExtra);
  }
  if (evidence !== null && evidence !== undefined) {
    return { ...validateCapabilityEvidence(evidence, { runtime, expectedScope }), ...credentialExtra };
  }
  return capabilityResult(runtime, 'unavailable', failure('LIVE_PROBE_REQUIRED', 'files and credentials do not prove a live runtime'), {
    ...credentialExtra,
  });
}

function capabilityMatrix({ root = process.cwd(), env = process.env, capabilities = null,
  credentialStatuses = null, commandRunner = spawnSync, expectedScope = null } = {}) {
  return Object.fromEntries(RUNTIMES.map((runtime) => [runtime, probeRuntime({
    root,
    runtime,
    env,
    evidence: capabilities?.[runtime] || null,
    credentialEvidence: credentialStatuses?.[runtime] || null,
    commandRunner,
    expectedScope,
  })]));
}

function normalizedEvaluationFlag(flag) {
  if (!flag || flag.schema !== SCHEMA) return normalizeFlag(flag);
  if (flag.status === 'refused') return refusedFlag(flag.reason || failure('INVALID_FLAG', 'rollout flag was refused'));
  return normalizeFlag({
    version: flag.rollout_version,
    runtimes: flag.runtimes,
  });
}

function evaluate({ root = process.cwd(), flag = readFlag(root), env = process.env, capabilities = null,
  credentialStatuses = null, commandRunner = spawnSync, expectedScope = null } = {}) {
  const normalized = normalizedEvaluationFlag(flag);
  const capabilitiesByRuntime = capabilityMatrix({ root, env, capabilities, credentialStatuses, commandRunner, expectedScope });
  const runtimeRollouts = Object.fromEntries(RUNTIMES.map((runtime) => {
    const optedIn = normalized.runtimes[runtime] === true;
    const capability = capabilitiesByRuntime[runtime];
    const launchesEnabled = optedIn && capability.status === 'available';
    const status = !optedIn ? 'disabled' : launchesEnabled ? 'enabled' : capability.status;
    return [runtime, {
      runtime,
      provider: providerFor(runtime),
      opted_in: optedIn,
      status,
      launches_enabled: launchesEnabled,
      credential_status: capability.credential_status,
      capability,
      rollback: rollback({ runtime, status }),
    }];
  }));
  const selected = Object.values(runtimeRollouts).filter((item) => item.opted_in);
  const launchesEnabled = normalized.status !== 'refused' && selected.some((item) => item.launches_enabled);
  let status = normalized.status === 'refused' ? 'refused'
    : selected.length === 0 ? 'disabled'
    : selected.every((item) => item.launches_enabled) ? 'enabled'
      : launchesEnabled ? 'partial'
        : selected.some((item) => item.status === 'refused') ? 'refused' : 'unavailable';
  const reason = normalized.reason || selected.find((item) => !item.launches_enabled)?.capability.reason || null;
  return {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: ROLLOUT_VERSION,
    status,
    launches_enabled: launchesEnabled,
    runtime_launches_enabled: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, runtimeRollouts[runtime].launches_enabled])),
    legacy_behavior: launchesEnabled ? 'controller_enabled_for_available_runtimes' : 'unchanged',
    flag: normalized,
    capabilities: capabilitiesByRuntime,
    runtimes: runtimeRollouts,
    ...(reason ? { reason } : {}),
    rollback: {
      action: 'rollback',
      runtimes: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, runtimeRollouts[runtime].rollback])),
      records_deleted: false,
      historical_preserved: true,
      historical_relabelled: false,
      receipts_preserved: true,
      usage_preserved: true,
    },
  };
}

function rollback({ runtime, status = 'disabled' } = {}) {
  return {
    action: 'rollback',
    ...(runtime ? { runtime } : {}),
    from_status: status,
    launches_enabled: false,
    records_deleted: false,
    historical_preserved: true,
    historical_relabelled: false,
    receipts_preserved: true,
    usage_preserved: true,
  };
}

function flagLocations(config) {
  const locations = [];
  for (const namespace of ['delivery_pipeline', 'pipeline']) {
    if (object(config[namespace]) && Object.prototype.hasOwnProperty.call(config[namespace], 'autonomous_control_plane')) {
      locations.push([namespace, 'autonomous_control_plane']);
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'autonomous_control_plane')) locations.push(['autonomous_control_plane']);
  return locations;
}

function setAt(value, keys, replacement) {
  if (!keys.length) return replacement;
  const [key, ...rest] = keys;
  return { ...value, [key]: setAt(value[key], rest, replacement) };
}

function applyRollback(root, runtime) {
  if (!RUNTIMES.includes(runtime)) {
    return { ...rollback({ status: 'refused' }), status: 'refused', changed: false,
      reason: failure('INVALID_RUNTIME', 'rollback requires --runtime claude or codex') };
  }
  const { config, error } = readConfig(root);
  if (error) return { ...rollback({ status: 'refused' }), status: 'refused', changed: false, reason: error };
  if (!object(config)) return { ...rollback({ status: 'refused' }), status: 'refused', changed: false, reason: failure('INVALID_CONFIG', 'project config must be an object') };
  const locations = flagLocations(config);
  if (!locations.length) return { ...rollback({ runtime, status: 'disabled' }), status: 'disabled', changed: false };
  const entries = locations.map((location) => ({
    location,
    raw: location.reduce((value, key) => value && value[key], config),
    current: normalizeFlag(location.reduce((value, key) => value && value[key], config)),
  }));
  const invalid = entries.find(({ current }) => current.status === 'refused');
  if (invalid) return { ...rollback({ runtime, status: 'refused' }), status: 'refused', changed: false, reason: invalid.current.reason };
  const changed = entries.some(({ current }) => current.runtimes[runtime]);
  if (!changed) return { ...rollback({ runtime, status: 'disabled' }), status: 'disabled', changed: false };
  const nextConfig = entries.reduce((value, { location, raw, current }) => {
    const nextFlag = { ...clone(raw), schema: SCHEMA, version: ROLLOUT_VERSION,
      runtimes: { ...current.runtimes, [runtime]: false } };
    delete nextFlag.enabled;
    return setAt(value, location, nextFlag);
  }, config);
  const file = configPath(root);
  withLock(lockDirFor(root), 'rollout', () => {
    writeAtomic(file, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }, { label: 'run-rollout' });
  const remainingEnabled = entries.some(({ current }) => RUNTIMES.some((name) => name !== runtime && current.runtimes[name]));
  const status = remainingEnabled ? 'partial' : 'disabled';
  return {
    ...rollback({ runtime, status: 'enabled' }),
    status,
    changed: true,
    config_path: path.relative(root, file),
    remaining_runtimes: Object.fromEntries(RUNTIMES.map((name) => [name, name !== runtime && entries.some(({ current }) => current.runtimes[name])])),
  };
}

function capabilityFile(file) {
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(parsed)) throw new Error('capability file must contain an object');
  return object(parsed.runtimes) ? parsed.runtimes : parsed;
}

function parseArgs(argv) {
  const args = { command: argv[0] || 'status', root: process.cwd(), json: false, capabilityOnly: false, capabilityFile: null, runtime: null };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--capability-only') args.capabilityOnly = true;
    else if (token === '--root') args.root = path.resolve(safe(argv[++i], '--root'));
    else if (token === '--capabilities') args.capabilityFile = path.resolve(safe(argv[++i], '--capabilities'));
    else if (token === '--runtime') {
      if (args.runtime !== null) throw new Error('--runtime may be specified only once');
      args.runtime = safe(argv[++i], '--runtime');
    }
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!['status', 'probe', 'rollback'].includes(args.command)) throw new Error(`unknown command: ${args.command}`);
  if (args.command === 'rollback' && !RUNTIMES.includes(args.runtime)) {
    throw new Error('rollback requires --runtime claude or codex');
  }
  if (args.runtime && args.command !== 'rollback') throw new Error('--runtime is supported only by rollback');
  return args;
}

function help() {
  return [
    'usage: run-rollout.cjs <status|probe> [--json] [--capability-only] [--root <project>] [--capabilities <file>]',
    '       run-rollout.cjs rollback --runtime <claude|codex> [--json] [--root <project>]',
    '',
    'Evaluate provider-specific autonomous controller rollout gates.',
  ].join('\n');
}

function execute(args) {
  if (args.help) return { result: { help: help() }, code: 0 };
  const root = path.resolve(args.root);
  if (args.command === 'rollback') {
    const result = applyRollback(root, args.runtime);
    return { result: { schema: SCHEMA, version: VERSION, rollout_version: ROLLOUT_VERSION, ...result }, code: result.status === 'refused' ? 11 : 0 };
  }
  const capabilities = capabilityFile(args.capabilityFile);
  const result = evaluate({ root, capabilities, credentialStatuses: args.credentialStatuses, commandRunner: args.commandRunner, env: args.env });
  result.command = args.command;
  result.capability_only = args.capabilityOnly;
  const code = result.status === 'refused' ? 11 : result.status === 'unavailable' ? 10 : 0;
  return { result, code };
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const output = execute(args);
    if (args.json) process.stdout.write(`${JSON.stringify(output.result)}\n`);
    else process.stdout.write(`${JSON.stringify(output.result, null, 2)}\n`);
    return output.code;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: SCHEMA, version: VERSION, status: 'refused', reason: failure('INVALID_INPUT', error.message) })}\n`);
    return 11;
  }
}

module.exports = Object.freeze({
  SCHEMA,
  CAPABILITY_SCHEMA,
  VERSION,
  ROLLOUT_VERSION,
  LEGACY_SCHEMA,
  LEGACY_ROLLOUT_VERSION,
  RUNTIMES,
  PROVIDERS,
  SHARED_FILES,
  RUNTIME_FILES,
  normalizeFlag,
  readFlag,
  readCredentialStatus,
  validateCapabilityEvidence,
  probeRuntime,
  capabilityMatrix,
  evaluate,
  rollback,
  applyRollback,
  parseArgs,
  execute,
});

if (require.main === module) process.exitCode = main();
