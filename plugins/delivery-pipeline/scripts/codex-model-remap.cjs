'use strict';

// Compatibility entrypoint for named Codex keys. The ADR-014 resolver chooses
// the rung and effort; this module carries the operator's effective concrete
// model remap to the Codex selector without maintaining a stale model registry.
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./model-policy.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const { REPAIR } = require('./codex-dispatch-adapter.cjs');

function refuse(message) {
  throw policy.policyError('CONFLICTING_OVERRIDE', message + '. Remove the conflicting Codex override. ' + REPAIR);
}

function normalizeModel(value) {
  const model = typeof value === 'string' ? value : value && value.model;
  if (typeof model !== 'string' || !model.trim()) {
    refuse('Codex model must be a non-empty model id or an object with a non-empty model id');
  }
  return model.trim();
}

function normalizePalette(value, source) {
  if (typeof value !== 'string') return value;
  const warnings = [];
  const normalized = pipelineConfig.normalizeCodexModels(value, warnings);
  if (!Array.isArray(normalized) || warnings.length) {
    const detail = warnings.length ? `: ${warnings.join('; ')}` : '';
    refuse(`${source} is not a valid documented comma-separated Codex palette${detail}`);
  }
  return normalized;
}

function readProjectConfig(cwd, file = path.join(cwd, '.planning', 'config.json')) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    refuse('cannot read project model configuration ' + file + ': ' + error.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('project model configuration must be an object');
  return raw;
}

function remapEntries(config) {
  const sourceConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const entries = [];
  for (const [source, value] of [
    ['model_policy.runtime_tiers.codex', sourceConfig.model_policy?.runtime_tiers?.codex],
    ['model_profile_overrides.codex', sourceConfig.model_profile_overrides?.codex],
  ]) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(source + ' must be an object');
    for (const [key, entry] of Object.entries(value)) {
      if (!key.trim()) refuse(source + ' contains an unnamed Codex tier');
      entries.push({ source: source + '.' + key, key: key.trim(), entry, model: normalizeModel(entry) });
    }
  }
  return entries;
}

function assertNoConflictingRemaps(entries) {
  const mapped = new Map();
  for (const current of entries) {
    const previous = mapped.get(current.key);
    if (previous && previous.model !== current.model) {
      refuse(`${current.source} contradicts ${previous.source}`);
    }
    if (!previous) mapped.set(current.key, current);
  }
}

function loadGsdConfig(codexHome, cwd) {
  const lib = path.join(codexHome, 'gsd-core', 'bin', 'lib');
  const loader = require(path.join(lib, 'config-loader.cjs'));
  if (typeof loader.loadConfig !== 'function') throw new Error('gsd-core config-loader lacks loadConfig');
  const write = process.stderr.write;
  try {
    process.stderr.write = () => true;
    return loader.loadConfig(cwd) || {};
  } finally {
    process.stderr.write = write;
  }
}

function createCodexRemapper({ cwd = process.cwd(), config, codexHome, env = process.env, log = () => {} } = {}) {
  let sourceConfig = config;
  if (sourceConfig === undefined) {
    const projectFile = path.join(cwd, '.planning', 'config.json');
    // Validate an existing project file ourselves before consulting GSD. This
    // preserves the fail-closed distinction between malformed project policy
    // and an absent project file, even when GSD would fall back to defaults.
    sourceConfig = fs.existsSync(projectFile) ? readProjectConfig(cwd) : undefined;
    if (sourceConfig === undefined) {
      const home = codexHome || env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      try {
        sourceConfig = loadGsdConfig(home, cwd);
      } catch (error) {
        log(`codex-agent: could not load GSD's model remap (${error.message}); using project keys\n`);
        sourceConfig = readProjectConfig(cwd);
      }
    }
  }
  const entries = remapEntries(sourceConfig || {});
  assertNoConflictingRemaps(entries);
  const mapped = new Map(entries.map((entry) => [entry.key, entry]));
  return (key) => {
    if (typeof key !== 'string' || !key.trim()) return null;
    return mapped.get(key.trim())?.model || null;
  };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  }
  return 0;
}

function effortAtLeastConfigured(source, configured, resolution) {
  if (configured === undefined) return;
  if (!policy.EFFORTS.includes(configured)) refuse(source + ' is not a valid effort');
  const configuredIndex = policy.EFFORTS.indexOf(configured);
  const canonicalIndex = policy.EFFORTS.indexOf(resolution.effort);
  if (configuredIndex < canonicalIndex) {
    refuse(`${source} is below the canonical ${resolution.role}/${resolution.rung} effort ${resolution.effort}`);
  }
}

function validateCodexConfiguration(resolution, config = {}, capabilities = {}, options = {}) {
  const sourceConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  policy.validateResolution(resolution);
  if (sourceConfig.model_policy?.runtime !== undefined && sourceConfig.model_policy.runtime !== 'codex') {
    refuse('model_policy.runtime contradicts the Codex dispatch');
  }
  const effectiveModel = options.effectiveModel ?? resolution.effective_model ?? resolution.model;
  if (typeof effectiveModel !== 'string' || !effectiveModel.trim()) {
    refuse('effective Codex model must be a non-empty model id');
  }
  if (resolution.agent_file && effectiveModel !== resolution.model) {
    refuse('static Codex selections cannot use an effective model remap');
  }
  const remapKeys = new Set([
    resolution.model_key,
    resolution.logical_model,
    ...(Array.isArray(options.remapKeys) ? options.remapKeys : []),
  ].filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()));
  const entries = remapEntries(config);
  assertNoConflictingRemaps(entries);
  for (const { source, key, entry } of entries) {
    if (typeof entry === 'string' || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const field of ['effort', 'reasoning_effort']) {
      if (entry[field] === undefined) continue;
      if (!policy.EFFORTS.includes(entry[field])) refuse(source + '.' + field + ' is not a valid effort');
      if (remapKeys.has(key)) effortAtLeastConfigured(source + '.' + field, entry[field], resolution);
    }
  }
  // Check both namespaces; namespace precedence cannot hide a conflict.
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    const source = `${namespace}.codex_models`;
    const palette = normalizePalette(sourceConfig[namespace]?.codex_models, source);
    if (palette === undefined) continue;
    if (!Array.isArray(palette) || !palette.length) refuse(namespace + '.codex_models must declare a non-empty named palette');
    const seen = new Set();
    for (const entry of palette) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse(namespace + '.codex_models entries must be objects');
      const model = normalizeModel(entry);
      if (seen.has(model)) refuse(namespace + '.codex_models has duplicate model ' + model);
      seen.add(model);
      if (entry.effort !== undefined && !policy.EFFORTS.includes(entry.effort)) refuse('invalid palette effort for ' + model);
      if (entry.min_cli !== undefined && (typeof entry.min_cli !== 'string' || !/^\d+(?:\.\d+)*$/.test(entry.min_cli))) {
        refuse('invalid CLI version floor for ' + model);
      }
      if (model !== effectiveModel) continue;
      if (entry.effort !== undefined) effortAtLeastConfigured(source + '.' + model + '.effort', entry.effort, resolution);
      if (entry.min_cli !== undefined
          && (typeof capabilities.cliVersion !== 'string' || !/^\d+(?:\.\d+)*$/.test(capabilities.cliVersion)
            || compareVersions(capabilities.cliVersion, entry.min_cli) < 0)) {
        refuse(model + ' requires Codex CLI ' + entry.min_cli + '; host version is unavailable or too old');
      }
    }
  }
  return true;
}

module.exports = Object.freeze({ createCodexRemapper, normalizeModel, readProjectConfig, validateCodexConfiguration });
