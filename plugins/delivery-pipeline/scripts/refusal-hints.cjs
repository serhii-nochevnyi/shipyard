'use strict';

const DEFAULT_ENTRY = Object.freeze({
  hint: 'The host refused the request for a reason this map does not name.',
  remedy: 'Re-run the command and check the surrounding stderr for the underlying cause.',
});

const HINTS = Object.freeze({
  REFERENCE_UNAVAILABLE: Object.freeze({
    hint: 'A trusted GSD reference file is missing, unreadable, or not a bounded regular file.',
    remedy: 'Reinstall the GSD core: run bash scripts/ensure-gsd-core.sh claude, or make install-shipyard-claude-hook, then re-run.',
  }),
  INVALID_INPUT: Object.freeze({
    hint: 'The request does not match the shape this host requires.',
    remedy: 'Fix the request to match the documented shape and re-run.',
  }),
  UNSUPPORTED_ROLE: Object.freeze({
    hint: 'The requested role is not one of the typed GSD roles this host supports.',
    remedy: 'Request one of the supported typed GSD roles and re-run.',
  }),
  SCOPE_MISMATCH: Object.freeze({
    hint: 'The request scope does not match the canonical run scope this host expects.',
    remedy: 'Fix the scope fields (worktree, ticket, phase, runtime, provider) and re-run.',
  }),
  INVALID_SIGNAL: Object.freeze({
    hint: 'A decomposition signal has an unsupported name or value.',
    remedy: 'Use only the documented signal names and values and re-run.',
  }),
  CONFLICTING_OVERRIDE: Object.freeze({
    hint: 'The request tries to override a value the dispatch boundary already owns.',
    remedy: 'Remove the conflicting field from the request and re-run.',
  }),
  NONCOMPLIANT_RECEIPT: Object.freeze({
    hint: 'The typed GSD dispatch produced a receipt that failed compliance verification.',
    remedy: 'Re-run the dispatch; reinstall the runtime host if it keeps failing.',
  }),
  MISSING_RECEIPT: Object.freeze({
    hint: 'The run finished without a verified dispatch receipt.',
    remedy: 'Re-run the dispatch and confirm the runtime host records a receipt.',
  }),
  INVALID_HOST: Object.freeze({
    hint: 'The host received arguments or options it does not accept.',
    remedy: 'Fix the arguments to match the documented CLI usage and re-run.',
  }),
  INVALID_ARTIFACT: Object.freeze({
    hint: 'The produced artifact does not match the schema the trusted consumer requires.',
    remedy: 'Fix the artifact fields to match the documented schema and re-run.',
  }),
  INVALID_RESULT: Object.freeze({
    hint: 'The dispatch result does not match the shape the boundary requires.',
    remedy: 'Fix the result fields to match the documented schema and re-run.',
  }),
  RUNTIME_UNAVAILABLE: Object.freeze({
    hint: 'The runtime this host needs is not reachable right now.',
    remedy: 'Install and authenticate the runtime, then re-run.',
  }),
  STALE_GENERATED_AGENT: Object.freeze({
    hint: 'The installed GSD agent definition no longer matches the current policy.',
    remedy: 'Reinstall the generated agents: run make install-shipyard-codex, then re-run.',
  }),
  UNSUPPORTED_SELECTION: Object.freeze({
    hint: 'The resolved model and effort selection is not one the runtime host supports.',
    remedy: 'Update the runtime host capabilities or the model policy, then re-run.',
  }),
});

function hintFor(code) {
  if (typeof code === 'string' && Object.hasOwn(HINTS, code)) return HINTS[code];
  return DEFAULT_ENTRY;
}

function formatHint(code) {
  const label = typeof code === 'string' && code.trim() ? code : 'UNKNOWN';
  const entry = hintFor(code);
  return `hint[${label}]: ${entry.hint} — remedy: ${entry.remedy}`;
}

module.exports = Object.freeze({ HINTS, hintFor, formatHint });
