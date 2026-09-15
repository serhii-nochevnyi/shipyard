#!/usr/bin/env node
'use strict';

// Resolve every role through the authoritative configuration bridge. Selection
// is a preflight result, not proof of launch; callers launch through the dispatch
// boundary with createCodexDispatchAdapter and a native host implementation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('./pipeline-config.cjs');
const boundary = require('./dispatch-boundary.cjs');
const policy = require('./model-policy.cjs');
const { createCodexDispatchAdapter, REPAIR } = require('./codex-dispatch-adapter.cjs');
const { createCodexRemapper, readProjectConfig, validateCodexConfiguration } = require('./codex-model-remap.cjs');

const ROLE_ALIASES = Object.freeze({ 'inv-research': 'research' });
const CAPABILITIES_CONTRACT = 'provide current host capabilities through options.capabilities/options.host.capabilities or the CLI --capabilities-file <json> (supportedModels and supportedEfforts)';
// The GSD compatibility tier that the Codex selector historically passed to
// its remapper. The ADR-014 resolver owns the concrete rung; this alias only
// identifies which operator remap is effective for a dynamic Codex launch.
const CODEX_GSD_REMAP_TIER = 'sonnet';

function fail(message, code = 'INVALID_INPUT') {
  throw policy.policyError(code, message + '. ' + REPAIR);
}
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function expandHome(value) {
  if (value === '~') return os.homedir();
  return value && value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  const booleans = new Set(['contested', 'checkpoint', 'critical', 'json']);
  const values = new Set([
    'agent-dir', 'project-dir', 'capabilities-file', 'risk', 'type', 'complexity',
    'input-tokens', 'files', 'signature-state', 'dispatch-id',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (!booleans.has(name) && !values.has(name)) fail('unknown option --' + name);
    if (flags.has(name)) fail('--' + name + ' given more than once');
    if (booleans.has(name)) { flags.set(name, true); continue; }
    const value = argv[++index];
    if (value === undefined || String(value).startsWith('--') || String(value).trim() === '') fail('--' + name + ' needs a value');
    flags.set(name, String(value));
  }
  return { flags, positionals };
}
function signalsFrom(flags) {
  const signals = {};
  for (const [flag, key] of [
    ['risk', 'risk'], ['type', 'type'], ['complexity', 'complexity'],
    ['input-tokens', 'inputTokens'], ['signature-state', 'signatureState'],
    ['contested', 'contested'], ['checkpoint', 'checkpoint'], ['critical', 'critical'],
  ]) {
    if (flags.has(flag)) signals[key] = flags.get(flag);
  }
  // `--files` remains a documented selector input, but ADR-014 no longer has a
  // files-gated rung. Accept it for older callers and deliberately keep it out
  // of the canonical signal object so a compatibility value cannot become an
  // unverified promotion.
  return policy.normalizeSignals(signals);
}
function projectDirFrom(flags) {
  return path.resolve(expandHome(flags.get('project-dir')) || process.cwd());
}
function agentDirFrom(flags, env = process.env) {
  return path.resolve(expandHome(flags.get('agent-dir'))
    || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents'));
}
function readCapabilities(file) {
  if (!file) fail(CAPABILITIES_CONTRACT, 'UNSUPPORTED_SELECTION');
  let capabilities;
  try {
    capabilities = JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), 'utf8'));
  }
  catch (error) { fail('cannot read host capabilities: ' + error.message, 'UNSUPPORTED_SELECTION'); }
  if (!isObject(capabilities)) fail('host capabilities file must contain a JSON object', 'UNSUPPORTED_SELECTION');
  return capabilities;
}

function capabilitiesFrom(options, flags) {
  if (Object.prototype.hasOwnProperty.call(options, 'capabilities') && options.capabilities !== undefined) {
    return options.capabilities;
  }
  if (options.host !== undefined) {
    if (!isObject(options.host)) fail('host capability source must be an object', 'UNSUPPORTED_SELECTION');
    if (Object.prototype.hasOwnProperty.call(options.host, 'capabilities')
        && options.host.capabilities !== undefined) return options.host.capabilities;
  }
  const file = options.capabilitiesFile || flags.get('capabilities-file');
  if (!file) fail(CAPABILITIES_CONTRACT, 'UNSUPPORTED_SELECTION');
  return readCapabilities(file);
}

function configForCodexResolution(config) {
  const original = config.dispatch_context.configuration;
  const configuration = { ...original };
  let changed = false;
  // The bridge treats these named entries as per-rung launch overrides. Resolve
  // the ADR-014 rung first, then apply the effective Codex remap below; keep
  // the raw namespaces out of the bridge input so an operator model id cannot
  // be mistaken for a canonical policy model. The raw values are still
  // validated separately, including contradictions and host availability.
  const modelPolicy = configuration.model_policy;
  if (isObject(modelPolicy) && isObject(modelPolicy.runtime_tiers)) {
    const runtimeTiers = { ...modelPolicy.runtime_tiers };
    if (Object.prototype.hasOwnProperty.call(runtimeTiers, 'codex')) {
      delete runtimeTiers.codex;
      configuration.model_policy = { ...modelPolicy, runtime_tiers: runtimeTiers };
      changed = true;
    }
  }
  const profileOverrides = configuration.model_profile_overrides;
  if (isObject(profileOverrides)
      && Object.prototype.hasOwnProperty.call(profileOverrides, 'codex')) {
    configuration.model_profile_overrides = { ...profileOverrides };
    delete configuration.model_profile_overrides.codex;
    changed = true;
  }
  // `codex_models` is a compatibility palette. Let the selector's strict
  // validator inspect the original project value, while the canonical routed
  // bridge resolves against its immutable ADR-014 grid.
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    const values = configuration[namespace];
    if (isObject(values) && Object.prototype.hasOwnProperty.call(values, 'codex_models')) {
      configuration[namespace] = { ...values };
      delete configuration[namespace].codex_models;
      changed = true;
    }
  }
  // A spread copy of a routed config loses pipeline-config's private loader
  // binding. Keep the original object whenever no Codex-only namespace needs
  // projection; callers that do need one reload the projection through the
  // strict routed loader below.
  return changed ? configuration : config;
}

function routedConfigForCodexResolution(config, cwd, env) {
  const projected = configForCodexResolution(config);
  if (projected === config) return config;

  // pipeline-config intentionally binds routed provenance by object identity.
  // The projection therefore has to be loaded as a real routed config; a
  // hand-built `{ ...config, dispatch_context: ... }` would be rejected by the
  // parent bridge and must never become a compatibility fallback.
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-codex-routed-'));
  try {
    const planningDir = path.join(shadowRoot, '.planning');
    fs.mkdirSync(planningDir);
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(projected));
    return pc.loadConfig(shadowRoot, { runtime: 'codex', env, routed: true }).config;
  } finally {
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  }
}

function remapKeysForResolution(resolution) {
  // Static files cannot be rewritten at dispatch time. Still inspect the
  // shared GSD tier for them so an effective custom remap is refused rather
  // than silently ignored behind a canonical generated artifact.
  const keys = [CODEX_GSD_REMAP_TIER];
  if (typeof resolution.model_key === 'string') keys.push(resolution.model_key);
  return [...new Set(keys)];
}

function effectiveRemapFor(resolution, config, { cwd, env } = {}) {
  const remapFor = createCodexRemapper({ config, cwd, env });
  const keys = remapKeysForResolution(resolution);
  for (const key of keys) {
    const model = remapFor(key);
    if (model) return { model, key, keys };
  }
  return { model: resolution.model, key: null, keys };
}

function selectionWithEffectiveRemap(selection, effective) {
  if (!effective || effective.model === selection.model) return selection;
  if (!policy.DYNAMIC_ROLES.includes(selection.role)) {
    fail('static Codex selections cannot use an effective model remap', 'CONFLICTING_OVERRIDE');
  }
  const result = {
    ...selection,
    model: effective.model,
    requested_model: selection.requested_model,
    requested_effort: selection.requested_effort,
    launch_arguments: { ...selection.launch_arguments, model: effective.model },
    canonical_model: selection.model,
    effective_model: effective.model,
    model_source: 'gsd-remap',
    remap_key: effective.key,
  };
  // Keep a non-enumerable canonical reference for in-process callers. The
  // adapter can reconstruct the same view from canonical_model/effective_model
  // after a JSON round trip.
  Object.defineProperty(result, 'canonical_resolution', { value: selection });
  return Object.freeze(result);
}

function selectAgentInternal(role, options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const flags = options.flags || new Map();
  const env = options.env || process.env;
  if (options.runtime !== undefined && options.runtime !== 'codex') fail('Codex selector cannot launch another runtime');
  const loaded = pc.loadConfig(cwd, { runtime: 'codex', env, routed: true });
  const capabilities = capabilitiesFrom(options, flags);
  const resolutionConfig = routedConfigForCodexResolution(loaded.config, cwd, env);
  const resolution = pc.resolveDispatch({
    ...options, config: resolutionConfig, runtime: 'codex',
    role: ROLE_ALIASES[role] || role, signals: options.signals || {},
    dispatch_id: options.dispatch_id === undefined ? boundary.newDispatchId() : options.dispatch_id,
  });
  const projectConfig = readProjectConfig(cwd, loaded.file);
  const effective = effectiveRemapFor(resolution, projectConfig, { cwd, env });
  validateCodexConfiguration(resolution, projectConfig, capabilities, {
    remapKeys: effective.keys,
    effectiveModel: effective.model,
  });
  const agentsDir = path.resolve(options.agentDir || agentDirFrom(flags, env));
  const adapter = createCodexDispatchAdapter({ agentsDir, agentManifest: options.agentManifest, capabilities });
  const adapterResolution = effective.model === resolution.model
    ? resolution : { ...resolution, effective_model: effective.model };
  boundary.validateDispatch(adapterResolution, { adapters: { codex: adapter } });
  const evidence = resolution.agent_file ? adapter.validateGeneratedAgent(resolution) : null;
  const selected = selectionWithEffectiveRemap({
    ...resolution, project_dir: cwd,
    agent_path: resolution.agent_file ? path.join(agentsDir, resolution.agent_file) : null,
    ...(evidence ? { agent_file_digest: evidence.agent_file_digest } : {}),
  }, effective);
  return Object.isFrozen(selected) ? selected : Object.freeze(selected);
}

function selectAgent(role, options = {}) {
  try { return selectAgentInternal(role, options); }
  catch (error) {
    if (!error.message.includes(REPAIR)) error.message += '. ' + REPAIR;
    throw error;
  }
}

function plainSelection(result) {
  const target = result.agent_file || result.model;
  const effort = result.effort || result.launch_arguments?.reasoning_effort;
  if (typeof target !== 'string' || !target || typeof effort !== 'string' || !effort) {
    fail('selector cannot render a plain selection without a concrete model/file and effort');
  }
  // Preserve the historical first token (agent_file for static roles, model
  // for dynamic roles) and append the required effort as a second token.
  return `${target} ${effort}`;
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (positionals.length !== 2 || positionals[0] !== 'select') {
    fail('usage: codex-agent.cjs select <role> --capabilities-file <json> [--json] [--project-dir <project>] [--agent-dir <dir>] [canonical signals]');
  }
  const result = selectAgent(positionals[1], {
    flags, cwd: projectDirFrom(flags), signals: signalsFrom(flags),
    agentDir: agentDirFrom(flags), dispatch_id: flags.get('dispatch-id'),
  });
  process.stdout.write((flags.has('json') ? JSON.stringify(result) : plainSelection(result)) + '\n');
}

module.exports = Object.freeze({ selectAgent, parseArgs, signalsFrom, projectDirFrom, plainSelection, ROLE_ALIASES });
if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write('codex-agent: ' + error.message + '\n');
    process.exitCode = error.exitCode || 1;
  }
}
