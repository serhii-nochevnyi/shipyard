'use strict';

// Runtime-owned concrete palettes. The canonical policy owns the role grids and
// evidence rules; each runtime names its own native model keys. Claude's keys
// are the existing aliases themselves and are intentionally not translations of
// Codex's Luna/Sol vocabulary. Astra remains registered for compatibility with
// older explicit configurations, but is not selected by the current grid.

const CODEX_MODEL_IDS = Object.freeze({
  luna: 'gpt-6-luna',
  astra: 'gpt-6-astra',
  sol: 'gpt-6-sol',
});

const CLAUDE_MODEL_ALIASES = Object.freeze({
  sonnet: 'sonnet',
  opus: 'claude-opus-5-5',
  fable: 'fable',
});

function modelFor(runtime, modelKey) {
  const map = runtime === 'codex' ? CODEX_MODEL_IDS : runtime === 'claude' ? CLAUDE_MODEL_ALIASES : null;
  return map && Object.prototype.hasOwnProperty.call(map, modelKey) ? map[modelKey] : undefined;
}

function matchesModelObservation(runtime, observed, applied) {
  if (typeof observed !== 'string' || typeof applied !== 'string') return false;
  if (runtime === 'claude' && applied === 'sonnet') return /^claude-sonnet-\d+(?:-[A-Za-z0-9.]+)*$/.test(observed);
  if (runtime === 'claude' && applied === 'fable') return /^claude-fable-[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*$/.test(observed);
  return observed === applied;
}

const RUNTIME_ADAPTERS = Object.freeze({
  codex: Object.freeze({
    runtime: 'codex',
    modelFor: (modelKey) => modelFor('codex', modelKey),
    models: CODEX_MODEL_IDS,
  }),
  claude: Object.freeze({
    runtime: 'claude',
    modelFor: (modelKey) => modelFor('claude', modelKey),
    models: CLAUDE_MODEL_ALIASES,
  }),
});

function adapterForRuntime(runtime) {
  return Object.prototype.hasOwnProperty.call(RUNTIME_ADAPTERS, runtime)
    ? RUNTIME_ADAPTERS[runtime]
    : null;
}

// Export the adapter catalog as read-only compatibility data. Canonical policy
// resolution captures its own mapping snapshot and never dispatches through
// these replaceable entrypoints.
module.exports = Object.freeze({
  CODEX_MODEL_IDS,
  CLAUDE_MODEL_ALIASES,
  RUNTIME_ADAPTERS,
  adapterForRuntime,
  matchesModelObservation,
  modelFor,
});
