'use strict';

// Runtime-owned concrete mappings.  model-policy.cjs owns only logical roles,
// rungs, and evidence rules; these adapters translate a logical model at the
// last responsible moment without changing Claude's existing aliases.

const CODEX_MODEL_IDS = Object.freeze({
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  luna: 'gpt-5.6-luna',
  astra: 'gpt-6-astra',
});

const CLAUDE_MODEL_ALIASES = Object.freeze({
  terra: 'sonnet',
  sol: 'opus',
  luna: 'opus',
  astra: 'fable',
});

function modelFor(runtime, logicalModel) {
  const map = runtime === 'codex' ? CODEX_MODEL_IDS : runtime === 'claude' ? CLAUDE_MODEL_ALIASES : null;
  return map && map[logicalModel];
}

const RUNTIME_ADAPTERS = Object.freeze({
  codex: Object.freeze({
    runtime: 'codex',
    modelFor: (logicalModel) => modelFor('codex', logicalModel),
    models: CODEX_MODEL_IDS,
  }),
  claude: Object.freeze({
    runtime: 'claude',
    modelFor: (logicalModel) => modelFor('claude', logicalModel),
    models: CLAUDE_MODEL_ALIASES,
  }),
});

function adapterForRuntime(runtime) {
  return RUNTIME_ADAPTERS[runtime] || null;
}

// Export the adapter catalog as read-only compatibility data. Canonical policy
// resolution captures its own mapping snapshot and never dispatches through
// these replaceable entrypoints.
module.exports = Object.freeze({
  CODEX_MODEL_IDS,
  CLAUDE_MODEL_ALIASES,
  RUNTIME_ADAPTERS,
  adapterForRuntime,
  modelFor,
});
