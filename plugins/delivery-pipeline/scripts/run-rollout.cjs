#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withLock, writeAtomic, lockDirFor } = require('./lock.cjs');

const SCHEMA = 'shipyard.autonomous-rollout.v1';
const CAPABILITY_SCHEMA = 'shipyard.runtime-capability.v1';
const VERSION = 1;
const ROLLOUT_VERSION = 'v1';
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
  ]),
  codex: Object.freeze([
    'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs',
    'plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs',
    'plugins/delivery-pipeline/scripts/codex-agent.cjs',
  ]),
});
const CREDENTIAL_KEYS = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
});
const DEFAULTS = Object.freeze({
  enabled: false,
  version: null,
  source: 'default',
  runtimes: Object.freeze({ claude: false, codex: false }),
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
    enabled: DEFAULTS.enabled,
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
    enabled: false,
    source: 'config',
    runtimes: clone(DEFAULTS.runtimes),
    reason,
  };
}

function normalizeFlag(raw) {
  if (raw === undefined || raw === null) return defaultFlag();
  if (!object(raw)) return refusedFlag(failure('INVALID_FLAG', 'autonomous_control_plane must be an object'));
  if (raw.version !== ROLLOUT_VERSION) {
    return refusedFlag(failure('UNSUPPORTED_ROLLOUT_VERSION', `rollout flag version must be ${ROLLOUT_VERSION}`));
  }
  if (typeof raw.enabled !== 'boolean') {
    return refusedFlag(failure('INVALID_FLAG', 'rollout flag enabled must be boolean'));
  }
  if (raw.runtimes !== undefined && !object(raw.runtimes)) {
    return refusedFlag(failure('INVALID_FLAG', 'rollout flag runtimes must be an object'));
  }
  const runtimes = Object.fromEntries(RUNTIMES.map((runtime) => [runtime, raw.runtimes?.[runtime] === true]));
  if (raw.enabled && RUNTIMES.some((runtime) => !runtimes[runtime])) {
    return refusedFlag(failure('RUNTIME_FLAG_INCOMPLETE', 'both Claude and Codex must be enabled by the rollout flag'));
  }
  const normalized = {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: raw.version,
    status: raw.enabled ? 'pending' : 'disabled',
    enabled: raw.enabled,
    source: 'config',
    runtimes,
  };
  normalized.fingerprint = digest(normalized);
  return normalized;
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

function credentialNames(env, runtime) {
  return CREDENTIAL_KEYS[runtime].filter((key) => typeof env[key] === 'string' && env[key].trim());
}

function probeRuntime({ root, runtime, env = process.env, evidence = null, expectedScope = null } = {}) {
  if (!RUNTIMES.includes(runtime)) return capabilityResult(runtime, 'refused', failure('WRONG_RUNTIME', 'unsupported runtime'));
  if (evidence !== null && evidence !== undefined) return validateCapabilityEvidence(evidence, { runtime, expectedScope });
  const sharedMissing = existingFiles(root, SHARED_FILES);
  const runtimeMissing = existingFiles(root, RUNTIME_FILES[runtime]);
  if (sharedMissing.length || runtimeMissing.length) {
    return capabilityResult(runtime, 'unavailable', failure('MISSING_RUNTIME_CAPABILITY', 'runtime capability files are missing', {
      shared: sharedMissing,
      runtime: runtimeMissing,
    }), { missing_files: [...sharedMissing, ...runtimeMissing] });
  }
  const credentials = credentialNames(env, runtime);
  if (!credentials.length) {
    return capabilityResult(runtime, 'unavailable', failure('CREDENTIALS_UNAVAILABLE', 'runtime credentials are not present'), {
      credential_names: CREDENTIAL_KEYS[runtime],
    });
  }
  return capabilityResult(runtime, 'unavailable', failure('LIVE_PROBE_REQUIRED', 'files and credentials do not prove a live runtime'), {
    credential_names: credentials,
  });
}

function capabilityMatrix({ root = process.cwd(), env = process.env, capabilities = null, expectedScope = null } = {}) {
  return Object.fromEntries(RUNTIMES.map((runtime) => [runtime, probeRuntime({
    root,
    runtime,
    env,
    evidence: capabilities?.[runtime] || null,
    expectedScope,
  })]));
}

function normalizedEvaluationFlag(flag) {
  if (!flag || flag.schema !== SCHEMA) return normalizeFlag(flag);
  if (flag.status === 'refused') return refusedFlag(flag.reason || failure('INVALID_FLAG', 'rollout flag was refused'));
  return normalizeFlag({
    version: flag.rollout_version,
    enabled: flag.enabled,
    runtimes: flag.runtimes,
  });
}

function evaluate({ root = process.cwd(), flag = readFlag(root), env = process.env, capabilities = null, expectedScope = null } = {}) {
  const normalized = normalizedEvaluationFlag(flag);
  const capabilitiesByRuntime = capabilityMatrix({ root, env, capabilities, expectedScope });
  let status = normalized.status;
  let reason = normalized.reason || null;
  if (status === 'pending') {
    const results = Object.values(capabilitiesByRuntime);
    if (results.some((result) => result.status === 'refused')) {
      status = 'refused';
      reason = results.find((result) => result.status === 'refused').reason;
    } else if (results.every((result) => result.status === 'available')) {
      status = 'enabled';
    } else {
      status = 'unavailable';
      reason = results.find((result) => result.status !== 'available').reason;
    }
  }
  return {
    schema: SCHEMA,
    version: VERSION,
    rollout_version: ROLLOUT_VERSION,
    status,
    launches_enabled: status === 'enabled',
    legacy_behavior: status === 'enabled' ? 'controller_enabled' : 'unchanged',
    flag: normalized,
    capabilities: capabilitiesByRuntime,
    ...(reason ? { reason } : {}),
    rollback: rollback({ status }),
  };
}

function rollback({ status = 'disabled' } = {}) {
  return {
    action: 'rollback',
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

function applyRollback(root) {
  const { config, error } = readConfig(root);
  if (error) return { ...rollback({ status: 'refused' }), status: 'refused', changed: false, reason: error };
  if (!object(config)) return { ...rollback({ status: 'refused' }), status: 'refused', changed: false, reason: failure('INVALID_CONFIG', 'project config must be an object') };
  const locations = flagLocations(config);
  if (!locations.length) return { ...rollback({ status: 'disabled' }), status: 'disabled', changed: false };
  const entries = locations.map((location) => ({
    location,
    raw: location.reduce((value, key) => value && value[key], config),
    current: normalizeFlag(location.reduce((value, key) => value && value[key], config)),
  }));
  const invalid = entries.find(({ current }) => current.status === 'refused');
  if (invalid) return { ...rollback({ status: 'refused' }), status: 'refused', changed: false, reason: invalid.current.reason };
  const changed = entries.some(({ raw }) => raw.enabled !== false || raw.runtimes?.claude === true || raw.runtimes?.codex === true);
  if (!changed) return { ...rollback({ status: 'disabled' }), status: 'disabled', changed: false };
  const nextConfig = entries.reduce((value, { location, raw, current }) => setAt(value, location, {
    ...clone(raw),
    version: current.rollout_version,
    enabled: false,
    runtimes: { claude: false, codex: false },
  }), config);
  const file = configPath(root);
  withLock(lockDirFor(root), 'rollout', () => {
    writeAtomic(file, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }, { label: 'run-rollout' });
  return {
    ...rollback({ status: 'enabled' }),
    status: 'disabled',
    changed: true,
    config_path: path.relative(root, file),
  };
}

function capabilityFile(file) {
  if (!file) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(parsed)) throw new Error('capability file must contain an object');
  return object(parsed.runtimes) ? parsed.runtimes : parsed;
}

function parseArgs(argv) {
  const args = { command: argv[0] || 'status', root: process.cwd(), json: false, capabilityOnly: false, capabilityFile: null };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--capability-only') args.capabilityOnly = true;
    else if (token === '--root') args.root = path.resolve(safe(argv[++i], '--root'));
    else if (token === '--capabilities') args.capabilityFile = path.resolve(safe(argv[++i], '--capabilities'));
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!['status', 'probe', 'rollback'].includes(args.command)) throw new Error(`unknown command: ${args.command}`);
  return args;
}

function help() {
  return [
    'usage: run-rollout.cjs <status|probe|rollback> [--json] [--capability-only] [--root <project>] [--capabilities <file>]',
    '',
    'Evaluate the versioned autonomous controller rollout gate.',
  ].join('\n');
}

function execute(args) {
  if (args.help) return { result: { help: help() }, code: 0 };
  const root = path.resolve(args.root);
  if (args.command === 'rollback') {
    const result = applyRollback(root);
    return { result: { schema: SCHEMA, version: VERSION, rollout_version: ROLLOUT_VERSION, ...result }, code: result.status === 'refused' ? 11 : 0 };
  }
  const capabilities = capabilityFile(args.capabilityFile);
  const result = evaluate({ root, capabilities });
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
  RUNTIMES,
  PROVIDERS,
  SHARED_FILES,
  RUNTIME_FILES,
  normalizeFlag,
  readFlag,
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
