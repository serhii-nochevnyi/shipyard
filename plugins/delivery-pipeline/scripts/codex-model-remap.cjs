'use strict';

// Configuration validator for named Codex palette assertions. ADR-014 owns the
// concrete selection: these namespaces may confirm that selection, never remap
// it to a GSD/provider model.
const fs = require('fs');
const path = require('path');
const policy = require('./model-policy.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const { CODEX_MODEL_IDS } = require('./runtime-adapters.cjs');
const { hintFor } = require('./refusal-hints.cjs');

const REPAIR = hintFor('CODEX_GENERATED_AGENT_FIX').remedy;

function repairFor(code, details = {}) {
  const key = details && typeof details.key === 'string' ? details.key.trim() : '';
  if (code === 'CONFLICTING_OVERRIDE' && key) {
    return hintFor('CODEX_CONFIG_FIX').remedy.replace('{key}', key);
  }
  return REPAIR;
}

function refuse(message, code = 'CONFLICTING_OVERRIDE', details = {}) {
  throw policy.policyError(code, message + '. Remove the conflicting Codex override. ' + repairFor(code, details), details);
}

function normalizeModel(value, source) {
  const model = typeof value === 'string' ? value : value && value.model;
  if (typeof model !== 'string' || !model.trim()) {
    refuse('Codex model must be a non-empty model id or an object with a non-empty model id', undefined, source ? { key: source } : {});
  }
  return model.trim();
}

function normalizePalette(value, source) {
  if (typeof value !== 'string') return value;
  const warnings = [];
  const normalized = pipelineConfig.normalizeCodexModels(value, warnings);
  if (!Array.isArray(normalized) || warnings.length) {
    const detail = warnings.length ? `: ${warnings.join('; ')}` : '';
    refuse(`${source} is not a valid documented comma-separated Codex palette${detail}`, undefined, { key: source });
  }
  return normalized;
}

function readProjectConfig(cwd, file = path.join(cwd, '.planning', 'config.json')) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(source + ' must be an object', undefined, { key: source });
    for (const [key, entry] of Object.entries(value)) {
      if (!key.trim()) refuse(source + ' contains an unnamed Codex tier', undefined, { key: source });
      const entrySource = source + '.' + key.trim();
      entries.push({ source: entrySource, key: key.trim(), entry, model: normalizeModel(entry, entrySource) });
    }
  }
  return entries;
}

function assertNamedPaletteAssertions(entries) {
  const mapped = new Map();
  for (const current of entries) {
    const previous = mapped.get(current.key);
    if (previous && previous.model !== current.model) {
      refuse(`${current.source} contradicts ${previous.source}`, undefined, { key: current.source });
    }
    if (!previous) mapped.set(current.key, current);
    const expected = CODEX_MODEL_IDS[current.key];
    if (!expected) {
      refuse(`${current.source} must use one of the named Codex keys: ${Object.keys(CODEX_MODEL_IDS).join(', ')}`, undefined, { key: current.source });
    }
    if (current.model !== expected) {
      refuse(`${current.source} cannot replace canonical ${current.key} model ${expected} with ${current.model}`, undefined, { key: current.source });
    }
  }
}

function loadCodexRemap({ cwd = process.cwd(), config } = {}) {
  const sourceConfig = config === undefined ? readProjectConfig(cwd) : config;
  const entries = remapEntries(sourceConfig || {});
  assertNamedPaletteAssertions(entries);
  // Retain the compatibility export, but make its no-remap behavior explicit.
  return Object.freeze({ remap: () => null, sourceConfig });
}

function createCodexRemapper(options) {
  return loadCodexRemap(options).remap;
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
  if (!policy.EFFORTS.includes(configured)) refuse(source + ' is not a valid effort', undefined, { key: source });
  const configuredIndex = policy.EFFORTS.indexOf(configured);
  const canonicalIndex = policy.EFFORTS.indexOf(resolution.effort);
  if (configuredIndex < canonicalIndex) {
    refuse(`${source} is below the canonical ${resolution.role}/${resolution.rung} effort ${resolution.effort}`, undefined, { key: source });
  }
}

function validateCodexConfiguration(resolution, config = {}, capabilities = {}, options = {}) {
  const sourceConfig = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  policy.validateResolution(resolution);
  if (sourceConfig.model_policy?.runtime !== undefined && sourceConfig.model_policy.runtime !== 'codex') {
    refuse('model_policy.runtime contradicts the Codex dispatch', undefined, { key: 'model_policy.runtime' });
  }
  if (options.effectiveModel !== undefined && options.effectiveModel !== resolution.model) {
    refuse('Codex launch validation must use the resolver canonical concrete model');
  }
  for (const field of ['canonical_resolution', 'canonical_model', 'effective_model', 'model_source', 'remap_key']) {
    if (resolution[field] !== undefined) refuse('Codex resolution contains forbidden remap provenance ' + field);
  }
  const entries = remapEntries(config);
  assertNamedPaletteAssertions(entries);
  for (const { source, key, entry } of entries) {
    if (typeof entry === 'string' || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const field of ['effort', 'reasoning_effort']) {
      if (entry[field] === undefined) continue;
      const fieldSource = source + '.' + field;
      if (!policy.EFFORTS.includes(entry[field])) refuse(fieldSource + ' is not a valid effort', undefined, { key: fieldSource });
      if (key === resolution.model_key) effortAtLeastConfigured(fieldSource, entry[field], resolution);
    }
  }
  // Check both namespaces; namespace precedence cannot hide a conflict.
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    const source = `${namespace}.codex_models`;
    const palette = normalizePalette(sourceConfig[namespace]?.codex_models, source);
    if (palette === undefined) continue;
    if (!Array.isArray(palette) || !palette.length) refuse(namespace + '.codex_models must declare a non-empty named palette', undefined, { key: source });
    const seen = new Set();
    const entriesByModel = new Map();
    for (const entry of palette) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) refuse(namespace + '.codex_models entries must be objects', undefined, { key: source });
      const model = normalizeModel(entry, source);
      if (!Object.values(CODEX_MODEL_IDS).includes(model)) {
        refuse(source + ' contains a model outside the named ADR-014 Codex palette: ' + model, undefined, { key: source });
      }
      const selection = `${model}/${entry.effort || ''}`;
      if (seen.has(selection)) refuse(namespace + '.codex_models has duplicate selection ' + selection, undefined, { key: source });
      seen.add(selection);
      if (entry.effort !== undefined && !policy.EFFORTS.includes(entry.effort)) refuse('invalid palette effort for ' + model, undefined, { key: source });
      if (entry.min_cli !== undefined && (typeof entry.min_cli !== 'string' || !/^\d+(?:\.\d+)*$/.test(entry.min_cli))) {
        refuse('invalid CLI version floor for ' + model, undefined, { key: source });
      }
      if (!entriesByModel.has(model)) entriesByModel.set(model, []);
      entriesByModel.get(model).push(entry);
    }
    for (const [model, entries] of entriesByModel) {
      if (model !== resolution.model) continue;
      const exact = entries.filter((entry) => entry.effort === undefined || entry.effort === resolution.effort);
      const selected = exact.length ? exact : [entries.reduce((best, entry) =>
        policy.EFFORTS.indexOf(entry.effort || resolution.effort) > policy.EFFORTS.indexOf(best.effort || resolution.effort)
          ? entry : best)];
      for (const entry of selected) {
        if (entry.effort !== undefined) effortAtLeastConfigured(source + '.' + model + '.effort', entry.effort, resolution);
        if (entry.min_cli !== undefined
            && (typeof capabilities.cliVersion !== 'string' || !/^\d+(?:\.\d+)*$/.test(capabilities.cliVersion)
              || compareVersions(capabilities.cliVersion, entry.min_cli) < 0)) {
          refuse(model + ' requires Codex CLI ' + entry.min_cli + '; host version is unavailable or too old');
        }
      }
    }
  }
  return true;
}

module.exports = Object.freeze({
  REPAIR, repairFor, createCodexRemapper, loadCodexRemap, normalizeModel, readProjectConfig,
  validateCodexConfiguration,
});
