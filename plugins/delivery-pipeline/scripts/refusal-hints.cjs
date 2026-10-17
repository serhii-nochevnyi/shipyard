'use strict';

const path = require('node:path');

const BUNDLE_ROOT = path.resolve(__dirname, '..');

const DEFAULT_ENTRY = Object.freeze({
  hint: 'The host refused the request for a reason this map does not name.',
  remedy: 'Re-run the command and check the surrounding stderr for the underlying cause.',
});

const HINTS = Object.freeze({
  REFERENCE_UNAVAILABLE: Object.freeze({
    hint: 'A trusted GSD reference file is missing, unreadable, or not a bounded regular file.',
    remedy: 'Reinstall the plugin from the marketplace (Claude: claude plugin install shipyard@shipyard; Codex: codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then re-run.',
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
    remedy: 'Run node {bundle}/scripts/{host} --preflight to see the specific cause: a missing CLI needs installing and authenticating, missing or stale capability evidence needs the marketplace upgrade (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then re-run.',
  }),
  STALE_GENERATED_AGENT: Object.freeze({
    hint: 'The installed GSD agent definition no longer matches the current policy.',
    remedy: 'Upgrade the installed bundle: run codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard, then re-run.',
  }),
  UNSUPPORTED_SELECTION: Object.freeze({
    hint: 'The resolved model and effort selection is not one the runtime host supports.',
    remedy: 'Update the runtime host capabilities or the model policy, then re-run.',
  }),
  CODEX_CONFIG_FIX: Object.freeze({
    hint: 'The Codex launch was refused by a project or host configuration value, not a missing or stale install.',
    remedy: 'Fix {key} in .planning/config.json, then run: node {bundle}/scripts/gsd-tune.cjs --runtime codex --apply.',
  }),
  CODEX_GENERATED_AGENT_FIX: Object.freeze({
    hint: 'The Codex launch was refused because the generated agent definition is missing or stale.',
    remedy: 'Install an ADR-014-capable Codex host by running codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard; provide current host capabilities and retry the exact selection.',
  }),
  ARCHIVE_AUTHORITY_INVALID: Object.freeze({
    hint: 'The archive authority record is malformed or does not match this run.',
    remedy: 'Re-run from the same installed bundle that created it; if it persists, run node {bundle}/scripts/{host} --preflight and report its output.',
  }),
  ARCHIVE_AUTHORITY_REQUIRED: Object.freeze({
    hint: 'The operation needs an archive authority that was not supplied.',
    remedy: 'Re-run through the documented host entry so it supplies the authority, then retry.',
  }),
  ARCHIVE_AUTHORITY_BUSY: Object.freeze({
    hint: 'Another session holds the archive authority (owner pid {pid}).',
    remedy: "Wait for the other session to finish and re-run; a process that reused a crashed owner's pid must end first.",
  }),
  RUNTIME_CAPABILITY_MISSING: Object.freeze({
    hint: 'The runtime host has no capability evidence for the requested selection.',
    remedy: 'Run node {bundle}/scripts/{host} --preflight; if evidence is missing, upgrade the bundle (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then retry.',
  }),
  LEGACY_WRITER_STATE: Object.freeze({
    hint: 'A planning writer state file was written by an older layout.',
    remedy: 'Upgrade the installed bundle (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard) and re-run.',
  }),
  UNKNOWN_RUNTIME: Object.freeze({
    hint: 'The runtime could not be recognised from the environment.',
    remedy: 'Run from inside the Claude or Codex host session, or pass the runtime explicitly, then re-run.',
  }),
  AMBIGUOUS_RUNTIME: Object.freeze({
    hint: 'More than one runtime was detected and the host cannot choose.',
    remedy: 'Pass the runtime explicitly for this command and re-run.',
  }),
  INVALID_STORE: Object.freeze({
    hint: 'The run store content does not match the expected schema.',
    remedy: 'Run node {bundle}/scripts/{host} --preflight and report its output; the store is left untouched.',
  }),
  ADR_REQUIRED: Object.freeze({
    hint: 'Decomposition needs an accepted ADR that was not named.',
    remedy: 'Name the accepted ADR in the request and re-run.',
  }),
  ADR_PATH_INVALID: Object.freeze({
    hint: 'The named ADR path is not a valid in-repository path.',
    remedy: 'Fix the ADR path in the request to a repository-relative file and re-run.',
  }),
  ADR_UNAVAILABLE: Object.freeze({
    hint: 'The named ADR cannot be read.',
    remedy: 'Check the ADR path exists and is readable, then re-run.',
  }),
  ADR_CHANGED: Object.freeze({
    hint: 'The ADR changed after it was bound to this decomposition.',
    remedy: 'Re-run the decomposition so it binds the current ADR.',
  }),
  ADR_DIGEST_MISMATCH: Object.freeze({
    hint: 'The ADR digest does not match the bound digest.',
    remedy: 'Re-run the decomposition so it binds the current ADR digest.',
  }),
  DECOMPOSITION_SUBJECT_INVALID: Object.freeze({
    hint: 'The decomposition subject does not match the required shape.',
    remedy: 'Fix the subject fields to match the documented schema and re-run.',
  }),
  ENV_CONFLICT: Object.freeze({
    hint: 'The environment names {explicit} but the installed bundle is {bundle_value}.',
    remedy: 'Either unset the variable, or reinstall into the named home (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard) so both agree.',
  }),
  BUNDLE_MANIFEST_INVALID: Object.freeze({
    hint: 'The installed bundle manifest is missing or invalid.',
    remedy: 'Upgrade the installed bundle (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then run node {bundle}/scripts/{host} --preflight.',
  }),
  CAPABILITY_EVIDENCE_STALE: Object.freeze({
    hint: 'The capability evidence is older than the installed policy.',
    remedy: 'Upgrade the installed bundle (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then run node {bundle}/scripts/{host} --preflight.',
  }),
  CAPABILITY_SNAPSHOT_AGED: Object.freeze({
    hint: 'Warning: the capability snapshot is aged but still usable.',
    remedy: 'Run node {bundle}/scripts/{host} --preflight to refresh it when convenient.',
  }),
  LEGACY_HISTORY_UNSAFE: Object.freeze({
    hint: 'The legacy history at {path} cannot be adopted safely.',
    remedy: 'Leave the history in place and report it; adoption stays blocked until the host that wrote it is updated.',
  }),
  LEGACY_HISTORY_CHANGED: Object.freeze({
    hint: 'The legacy history at {path} changed during adoption.',
    remedy: 'Wait for the other writer to finish, then re-run; the history is left as it is.',
  }),
  LEGACY_HISTORY_UNKNOWN_MEMBER: Object.freeze({
    hint: 'The legacy history at {path} contains a member this host does not know.',
    remedy: 'Update the host that wrote the file (codex plugin marketplace upgrade shipyard, then codex plugin add shipyard@shipyard), then re-run.',
  }),
  LEGACY_HISTORY_COLLISION: Object.freeze({
    hint: 'Adopting the legacy history at {path} would collide with existing content.',
    remedy: 'Leave both in place and report the collision; adoption stays blocked.',
  }),
  LEGACY_HISTORY_MISSING: Object.freeze({
    hint: 'Warning: the expected legacy history at {path} was not found.',
    remedy: 'Continue if this project has no earlier history; otherwise re-run from the original checkout location.',
  }),
  REPOSITORY_IDENTITY_INVALID: Object.freeze({
    hint: 'The repository identity ({label}) could not be established.',
    remedy: 'Run from inside a git repository with an origin remote and re-run.',
  }),
});

const LAUNCH_CODES = Object.freeze(["ARCHIVE_AUTHORITY_INVALID", "ARCHIVE_AUTHORITY_REQUIRED", "ARCHIVE_AUTHORITY_BUSY", "RUNTIME_CAPABILITY_MISSING", "LEGACY_WRITER_STATE", "UNKNOWN_RUNTIME", "AMBIGUOUS_RUNTIME", "INVALID_STORE", "ADR_REQUIRED", "ADR_PATH_INVALID", "ADR_UNAVAILABLE", "ADR_CHANGED", "ADR_DIGEST_MISMATCH", "DECOMPOSITION_SUBJECT_INVALID", "ENV_CONFLICT", "BUNDLE_MANIFEST_INVALID", "CAPABILITY_EVIDENCE_STALE", "CAPABILITY_SNAPSHOT_AGED", "LEGACY_HISTORY_UNSAFE", "LEGACY_HISTORY_CHANGED", "LEGACY_HISTORY_UNKNOWN_MEMBER", "LEGACY_HISTORY_COLLISION", "LEGACY_HISTORY_MISSING", "REPOSITORY_IDENTITY_INVALID", "REFERENCE_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "STALE_GENERATED_AGENT", "CODEX_CONFIG_FIX", "CODEX_GENERATED_AGENT_FIX"]);

function hintFor(code) {
  if (typeof code === 'string' && Object.hasOwn(HINTS, code)) return HINTS[code];
  return DEFAULT_ENTRY;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;

const TOKEN_FALLBACKS = Object.freeze({
  host: 'the host script',
  pid: 'unknown',
  explicit: 'an explicitly named home',
  bundle_value: 'a different home',
  path: 'an unreported path',
  label: 'unknown',
  key: 'the refused key',
  bundle: BUNDLE_ROOT,
});

// @invariant: a rendered hint never carries a raw placeholder or a control character.
function stripControl(value) {
  return String(value).replace(CONTROL, '');
}

function formatHint(code, vars) {
  const label = stripControl(typeof code === 'string' && code.trim() ? code : 'UNKNOWN');
  const entry = hintFor(code);
  const supplied = vars && typeof vars === 'object' ? vars : {};
  const fill = (text) => text.replace(/\{(\w+)\}/g, (token, name) => {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (value !== undefined && value !== null && value !== '') return stripControl(value);
    return Object.hasOwn(TOKEN_FALLBACKS, name) ? TOKEN_FALLBACKS[name] : 'unspecified';
  });
  return `hint[${label}]: ${fill(entry.hint)} \u2014 remedy: ${fill(entry.remedy)}`;
}

module.exports = Object.freeze({ HINTS, LAUNCH_CODES, hintFor, formatHint, stripControl });
