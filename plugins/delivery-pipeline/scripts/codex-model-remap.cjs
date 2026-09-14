'use strict';

// Compatibility entrypoint for named Codex keys. Project remaps are assertions
// against ADR-014, never alternative model sources or GSD catalog fallbacks.
const fs = require('fs');
const path = require('path');
const policy = require('./model-policy.cjs');
const { CODEX_MODEL_IDS } = require('./runtime-adapters.cjs');
const { REPAIR } = require('./codex-dispatch-adapter.cjs');

function refuse(message) {
  throw policy.policyError('CONFLICTING_OVERRIDE', message + '. Remove the conflicting Codex override. ' + REPAIR);
}

function normalizeModel(value) {
  const model = typeof value === 'string' ? value : value && value.model;
  if (typeof model !== 'string' || !Object.values(CODEX_MODEL_IDS).includes(model)) {
    refuse('Codex models must be exact Terra/Sol/Luna/Astra IDs');
  }
  return model;
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
  const entries = [];
  for (const [source, value] of [
    ['model_policy.runtime_tiers.codex', config.model_policy?.runtime_tiers?.codex],
    ['model_profile_overrides.codex', config.model_profile_overrides?.codex],
  ]) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(source + ' must be an object');
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(CODEX_MODEL_IDS, key)) refuse(source + '.' + key + ' is not a canonical named Codex key');
      if (normalizeModel(entry) !== CODEX_MODEL_IDS[key]) refuse(source + '.' + key + ' contradicts ADR-014');
      entries.push({ source: source + '.' + key, key, entry });
    }
  }
  return entries;
}

function createCodexRemapper({ cwd = process.cwd(), config } = {}) {
  remapEntries(config === undefined ? readProjectConfig(cwd) : config);
  return (key) => {
    if (!Object.hasOwn(CODEX_MODEL_IDS, key)) refuse('unknown named Codex model ' + JSON.stringify(key));
    return CODEX_MODEL_IDS[key];
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

function validateCodexConfiguration(resolution, config, capabilities = {}) {
  policy.validateResolution(resolution);
  if (config.model_policy?.runtime !== undefined && config.model_policy.runtime !== 'codex') {
    refuse('model_policy.runtime contradicts the Codex dispatch');
  }
  for (const { source, key, entry } of remapEntries(config)) {
    if (key !== resolution.model_key || typeof entry === 'string') continue;
    for (const field of ['effort', 'reasoning_effort']) {
      if (entry[field] !== undefined && entry[field] !== resolution.effort) refuse(source + '.' + field + ' contradicts the resolved effort');
    }
  }
  // Check both namespaces; namespace precedence cannot hide a conflict.
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    const palette = config[namespace]?.codex_models;
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
      if (model !== resolution.model) continue;
      if (entry.effort !== undefined && entry.effort !== resolution.effort) refuse('palette effort contradicts ' + resolution.role + '/' + resolution.rung);
      if (entry.min_cli !== undefined
          && (typeof capabilities.cliVersion !== 'string' || !/^\d+(?:\.\d+)*$/.test(capabilities.cliVersion)
            || compareVersions(capabilities.cliVersion, entry.min_cli) < 0)) {
        refuse(model + ' requires Codex CLI ' + entry.min_cli + '; host version is unavailable or too old');
      }
    }
    if (!seen.has(resolution.model)) refuse(namespace + '.codex_models does not contain required model ' + resolution.model);
  }
  return true;
}

module.exports = Object.freeze({ createCodexRemapper, normalizeModel, readProjectConfig, validateCodexConfiguration });
