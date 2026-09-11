'use strict';

// Resolve the operator's Codex model remap at dispatch time. This mirrors the
// precedence used by scripts/gen-codex-shipyard.cjs: an explicit
// model_policy.runtime_tiers.codex.<tier> wins first, followed by
// model_profile_overrides.codex.<tier>. The built-in GSD catalog is not a
// remap; the Shipyard palette deliberately replaces that catalog on Codex.

const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeModel(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.model === 'string' && value.model.trim()) {
    return value.model.trim();
  }
  return null;
}

function readProjectConfig(cwd) {
  try {
    const file = path.join(cwd, '.planning', 'config.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_error) {
    return {};
  }
}

function rawRemap(cwd, tier) {
  const config = readProjectConfig(cwd);
  const policy = config.model_policy;
  const runtime = policy && policy.runtime_tiers && policy.runtime_tiers.codex;
  const fromPolicy = runtime && normalizeModel(runtime[tier]);
  if (fromPolicy) return fromPolicy;
  const overrides = config.model_profile_overrides;
  return overrides && overrides.codex ? normalizeModel(overrides.codex[tier]) : null;
}

function loadGsdResolver(codexHome, cwd) {
  const lib = path.join(codexHome, 'gsd-core', 'bin', 'lib');
  const resolver = require(path.join(lib, 'model-resolver.cjs'));
  const loader = require(path.join(lib, 'config-loader.cjs'));
  if (typeof resolver.resolveTierEntry !== 'function' || typeof loader.loadConfig !== 'function') {
    throw new Error('gsd-core model-resolver/config-loader lack the expected exports');
  }
  // GSD reports unknown namespaces to stderr. Loading the policy is a read, not
  // a user-facing mutation, so keep that diagnostic out of selector JSON.
  const write = process.stderr.write;
  let config;
  try {
    process.stderr.write = () => true;
    config = loader.loadConfig(cwd) || {};
  } finally {
    process.stderr.write = write;
  }
  return { ...resolver, config };
}

function createCodexRemapper({ codexHome, cwd, env = process.env, log = () => {} }) {
  const home = codexHome || env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const { resolveModelPolicy, resolveTierEntry, config } = loadGsdResolver(home, cwd);
    return (tier) => {
      if (!tier) return null;
      const policy = config.model_policy && typeof config.model_policy === 'object'
        ? { ...config.model_policy, runtime: 'codex' }
        : null;
      const fromPolicy = policy && typeof resolveModelPolicy === 'function'
        ? resolveModelPolicy(policy, tier)
        : null;
      if (typeof fromPolicy === 'string' && fromPolicy) return fromPolicy;

      const overrides = config.model_profile_overrides;
      if (!overrides || typeof overrides !== 'object') return null;
      const mapped = resolveTierEntry({ runtime: 'codex', tier, overrides });
      const builtin = resolveTierEntry({ runtime: 'codex', tier, overrides: undefined });
      if (mapped && mapped.model && (!builtin || mapped.model !== builtin.model)) return mapped.model;
      return null;
    };
  } catch (error) {
    // A minimal install may not have gsd-core available. The raw fallback has
    // the same user-key precedence and never mistakes the built-in catalog for
    // an override.
    log(`codex-agent: could not load GSD's model remap (${error.message}); using project keys\n`);
    return (tier) => rawRemap(cwd, tier);
  }
}

module.exports = { createCodexRemapper, normalizeModel, readProjectConfig };
