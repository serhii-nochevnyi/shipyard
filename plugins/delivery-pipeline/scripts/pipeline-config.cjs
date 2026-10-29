#!/usr/bin/env node
'use strict';

// TWO CONFIG NAMESPACES, both in .planning/config.json:
//
//   delivery_pipeline.*  the capability's own declared config (GSD-native: it is
//                        what the capability's gate `when:` clauses read, and it
//                        is settable/validated through GSD's config tooling).
//                        PREFERRED — it wins over pipeline.* below.
//   pipeline.*           shipyard's runtime knobs. `pipeline` is NOT a valid GSD
//                        config key, so `/gsd-config --set pipeline.x` is
//                        rejected; edit config.json directly, or use the
//                        delivery_pipeline.* form for the keys that have one.
//
// GSD's own top-level keys are READ (never written) where the conveyor has to
// agree with GSD: `runtime`, `git.base_branch`, `git.branching_strategy`,
// `response_language`. Disagreeing with them silently is how an epic branch ends
// up cut from main in a repo that integrates into develop.

const fs = require('fs');
const path = require('path');
const { resolveRuntime, readInheritedConfig } = require('./runtime-context.cjs');
const modelPolicy = require('./model-policy.cjs');
const { resolveIntegrationBranch, architectureTarget } = require('./architecture-target.cjs');

// A dispatch context is issued by loadConfig, not by a caller mutating the
// returned config. Keep that binding private so routed readers can reject a
// replacement before they fall back to compatibility behavior.
const LOADED_DISPATCH_CONTEXTS = new WeakMap();

// GSD resolves project-relative agent skills without consulting config.runtime,
// which is the only form that remains correct when Claude and Codex share one
// checkout. gsd-tune generates this projection from the canonical delivery-rules
// source before it writes the agent_skills entries.
const PROJECT_DELIVERY_RULES = '.shipyard/generated/gsd-delivery-rules';

const TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

// Workflow's agent() accepts these; GSD's ladder also has `minimal`, which is
// Codex-only and clamps to `low`. `ultra` is deliberately NOT here: it is
// advertised by one Codex model that no built-in path selects (ADR-005 D6/D7).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MECHANICAL_ROLES = new Set(['drift-check']);

// ── task levels (ADR-012) ───────────────────────────────────────────────────
//
// Role alone is too coarse for a cost policy: a four-file low-risk executor
// and a high-risk cross-cutting executor do not buy the same amount of model
// quality. The level is derived from facts already present in the ticket or
// dispatch. It is deliberately an ordered vocabulary so a requested level can
// be guarded against an unsafe downgrade rather than trusted as prose.
const TASK_LEVELS = ['mechanical', 'routine', 'complex', 'critical', 'recovery'];
const TASK_LEVEL_RANK = Object.fromEntries(TASK_LEVELS.map((level, i) => [level, i]));
const LADDER_MODES = ['conservative', 'adaptive'];

// The first treatment is intentionally narrow. These are the roles for which a
// small, low-risk task has a bounded failure surface and can be evaluated
// against the existing acceptance gates. Repair and judgment roles stay on the
// quality floor until their own evidence earns a broader treatment.
const ADAPTIVE_ROUTINE_ROLES = new Set(['executor', 'research']);
const ADAPTIVE_ROUTINE_MAX_FILES = 4;

function integerSignal(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function taskLevelRoute(role, signals = {}, cfg = {}) {
  requireCompatibility(cfg, 'taskLevelRoute');
  const requested = TASK_LEVELS.includes(signals.taskLevel) ? signals.taskLevel : null;
  let value;
  let rule;

  // A completed recovery history is stronger evidence than the role's normal
  // classification. In particular, pr-sentinel has a cheap normal lane but
  // still needs its generated `-deep` file after an exhausted repair signature,
  // and arch-review needs the same file after a contested judgement.
  const exhaustedRepair = REPAIR_ROLES && REPAIR_ROLES.has(role)
    && signals.signatureState === 'repeat_exhausted';
  const contestedJudgement = JUDGMENT_ROLES && JUDGMENT_ROLES.has(role)
    && signals.contested === true;
  if (exhaustedRepair) {
    value = 'recovery';
    rule = 'auto:recovery:exhausted';
  } else if (contestedJudgement) {
    value = 'recovery';
    rule = 'auto:recovery:contested';
  } else if (MECHANICAL_ROLES.has(role) || role === 'pr-sentinel') {
    value = 'mechanical';
    rule = 'auto:mechanical';
  } else if (signals.risk === 'high' || signals.checkpoint === true) {
    value = 'critical';
    rule = 'auto:critical';
  } else if (JUDGMENT_ROLES && JUDGMENT_ROLES.has(role)) {
    value = 'complex';
    rule = 'auto:complex';
  } else {
    const files = integerSignal(signals.files);
    const routine = cfg.model_ladder === 'adaptive'
      && ADAPTIVE_ROUTINE_ROLES.has(role)
      && signals.risk === 'low'
      && files !== null
      && files > 0
      && files <= ADAPTIVE_ROUTINE_MAX_FILES
      && signals.checkpoint !== true
      && signals.contested !== true
      && signals.signatureState === undefined;
    if (routine) {
      value = 'routine';
      rule = `auto:routine<=${ADAPTIVE_ROUTINE_MAX_FILES}files`;
    } else {
      value = 'complex';
      rule = 'auto:complex';
    }
  }

  // A caller may request a higher lane explicitly, which is useful for a
  // measured canary or a human-marked critical task. A lower request is
  // guarded by the inferred minimum; missing evidence therefore never buys a
  // cheaper model by accident.
  if (requested) {
    // These roles are deliberately mechanical. A prose flag must not turn a
    // merge sentinel or drift inventory into a premium model; their external
    // gates are the authority and the generated Codex bundle has no critical
    // variant for them.
    // A repair sentinel is normally mechanical, but its evidence-backed
    // recovery lane is the deliberate exception that makes the generated
    // `-deep` file reachable after `repeat_exhausted`.
    const evidencedRecovery = requested === 'recovery'
      && ((REPAIR_ROLES && REPAIR_ROLES.has(role)
        && signals.signatureState === 'repeat_exhausted')
        || (JUDGMENT_ROLES && JUDGMENT_ROLES.has(role)
          && signals.contested === true));
    if ((MECHANICAL_ROLES.has(role) || role === 'pr-sentinel')
        && requested !== 'mechanical' && !evidencedRecovery) {
      return { value, rule: `guarded:${value}`, requested };
    }
    // `routine` and `recovery` have role-specific contracts. Accepting either
    // for an unrelated role would make telemetry claim a lane that has no model
    // implementation behind it. A caller can still request `complex` or
    // `critical` for any non-mechanical role.
    if (requested === 'routine' && !ADAPTIVE_ROUTINE_ROLES.has(role)) {
      return { value, rule: `guarded:${value}`, requested };
    }
    if (requested === 'recovery' && !evidencedRecovery) {
      return { value, rule: `guarded:${value}`, requested };
    }
    if (TASK_LEVEL_RANK[requested] < TASK_LEVEL_RANK[value]) {
      return { value, rule: `guarded:${value}`, requested };
    }
    return { value: requested, rule: `explicit:${requested}`, requested };
  }
  return { value, rule };
}

// ── the Codex model palette (ADR-005 D6/D7) ──────────────────────────────────
//
// An ORDERED list of the models a Codex agent may be written with, each with the
// effort to USE — not the deepest the model accepts. That distinction is the
// whole reason the field is shaped this way: ranking the models by which effort
// levels they SUPPORT is what produced three wrong ladders in a row (GSD's
// `codexModelEffort` is a support matrix, and nothing in it claims to be a
// quality ranking).
//
// FIRST entry is the workhorse floor every role gets; LAST is the ceiling, which
// only the integrator takes statically and the `-deep` agents make reachable
// (ADR-005 D8 — on that runtime an agent is a FILE, so an escalation needs its
// own file). `min_cli` is the Codex CLI version that can first CONFIGURE the
// model; the generator refuses an entry above the host's version rather than
// writing an agent the runtime may ignore. There is no id registry to validate a
// model against — GSD's catalog does not carry every model an operator may have
// — so an unknown id cannot be distinguished from a new one, and a hardcoded
// allowlist here would go stale faster than the models do.
//
// Sol is the compatibility workhorse and ceiling for the current cost-efficient
// Codex palette. Routed Codex dispatch reads ADR-014 directly; this palette
// remains a compatibility input for callers that do not request a routed decision.
const DEFAULT_CODEX_MODELS = [
  { model: 'gpt-6.1-sol', effort: 'high', min_cli: '0.155.1' },
  { model: 'gpt-6.1-sol', effort: 'xhigh', min_cli: '0.155.1' },
];
const CODEX_MODEL_KEYS = new Set(['model', 'effort', 'min_cli']);

// `model[:effort][@min_cli]` — the GSD-settable spelling of one palette entry.
// The capability declares `codex_models` as a STRING because GSD's capability
// config vocabulary is boolean|string|number|enum (its own
// `validateConfigSliceEntry`), so an array-typed slice would not be a declared,
// settable knob at all. A hand-edited config may still use the object form.
function parseCodexModelEntry(text) {
  const raw = String(text).trim();
  if (!raw) return null;
  const at = raw.indexOf('@');
  const head = at === -1 ? raw : raw.slice(0, at);
  const minCli = at === -1 ? undefined : raw.slice(at + 1).trim();
  const colon = head.indexOf(':');
  const model = (colon === -1 ? head : head.slice(0, colon)).trim();
  const effort = colon === -1 ? undefined : head.slice(colon + 1).trim();
  const entry = { model };
  if (effort) entry.effort = effort;
  if (minCli) entry.min_cli = minCli;
  return entry;
}

// One list out of any of the three accepted spellings: an array of objects, an
// array of `model:effort@min_cli` strings, or one comma-separated string.
// Malformed entries are SKIPPED with a warning — never half-honoured — and an
// empty palette means "write no model", which is the previous behaviour and a
// safe floor.
function normalizeCodexModels(value, warnings) {
  const items = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value) ? value : null;
  if (items === null) {
    warnings.push(
      'pipeline.codex_models must be a list of {model, effort} entries (or a "model:effort@min_cli, …" string) — ignored'
    );
    return null;
  }
  const out = [];
  for (const item of items) {
    const entry = typeof item === 'string' || typeof item === 'number'
      ? parseCodexModelEntry(item)
      : (item && typeof item === 'object' && !Array.isArray(item)) ? { ...item } : null;
    if (!entry) {
      warnings.push(`pipeline.codex_models entry ${JSON.stringify(item)} is not a model — skipped`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!CODEX_MODEL_KEYS.has(key)) {
        warnings.push(`pipeline.codex_models."${key}" is not an entry field — ignored (fields: ${[...CODEX_MODEL_KEYS].join(', ')})`);
        delete entry[key];
      }
    }
    if (typeof entry.model !== 'string' || !entry.model.trim()) {
      warnings.push(`pipeline.codex_models entry ${JSON.stringify(item)} has no model id — skipped`);
      continue;
    }
    entry.model = entry.model.trim();
    if (entry.effort !== undefined && !EFFORTS.includes(entry.effort)) {
      warnings.push(
        `pipeline.codex_models."${entry.model}" effort "${entry.effort}" is not an effort level — ignored (${EFFORTS.join('|')}); the role's own effort applies`
      );
      delete entry.effort;
    }
    if (entry.min_cli !== undefined && !/^\d+(\.\d+)*$/.test(String(entry.min_cli))) {
      warnings.push(`pipeline.codex_models."${entry.model}" min_cli "${entry.min_cli}" is not a version — ignored`);
      delete entry.min_cli;
    }
    out.push(entry);
  }
  return out;
}

// The roles that repair an existing PR rather than build a ticket. They are the
// ones ADR-001 D1 took the attempt counter away from, and the only ones a
// signature state applies to — an executor has no failure history to read.
const REPAIR_ROLES = new Set(['ci-fix', 'review-fix', 'pr-sentinel']);

// Every `pipeline.*` knob that goes through the shared positive-number rule
// below (loadConfig). Exported and read back by both the rule's own loop and
// its test, so a knob added here needs no second, hand-mirrored copy to drift
// out of sync with the rule that actually enforces it.
const NUMERIC_KNOBS = ['max_attempts', 'pr_fetch_limit', 'stale_merge_hours', 'stale_draft_hours',
  'plan_defect_signatures', 'fable_window_tokens', 'max_concurrent_agents'];

// ── the four statuses a ticket actually moves through ───────────────────────
//
// In OUR order (`pending` < `branched` < `pr-open` < `merged`), which is the
// order the projection's forward-only rule is measured in. These are the only
// values `state-sync.cjs` ever writes into a ticket's `status`, and therefore
// the only left-hand sides `jira_transitions` can be keyed by. The tempting
// wrong values are the FRONT's bucket names (`fix`, `finalize`, `merge`, `ci`):
// those are computed by `front.cjs` per round and never appear in the
// `status_change` stream this map is consumed against.
const TICKET_STATUSES = ['pending', 'branched', 'pr-open', 'merged'];

// One map out of either accepted spelling: an object, or one comma-separated
// `our-status:Their Target Status` string — the same two shapes `codex_models`
// takes, and for the same reason (GSD's capability config vocabulary is
// boolean|string|number|enum, so an object-typed knob would not be settable at
// all). The right-hand side is the tracker's TARGET STATUS NAME, never the name
// of a transition: the performing half looks up the offered transition whose
// target status matches, because a workflow's transition names are not a stable
// schema and its status names are.
//
// Malformed entries are SKIPPED with a warning, never half-honoured; a wholly
// unusable value keeps the empty map, which means the projection is off.
function normalizeJiraTransitions(value, warnings) {
  const items = typeof value === 'string'
    ? value.split(',')
    : (value && typeof value === 'object' && !Array.isArray(value))
      ? Object.entries(value).map(([k, v]) => `${k}:${v}`)
      : null;
  if (items === null) {
    warnings.push(
      'pipeline.jira_transitions must be a map of our status to the tracker\'s target status name '
      + '(or a "pr-open:In Progress, merged:Done" string) — ignored'
    );
    return null;
  }
  const out = {};
  for (const item of items) {
    const raw = String(item).trim();
    // A blank segment is SILENT: the capability's declared default is the empty
    // string, and `''.split(',')` is `['']`, so warning here would put a warning
    // on every load of an unconfigured project — which is how a reader learns to
    // ignore warnings. A trailing comma is the same case.
    if (!raw) continue;
    // The first colon only: a Jira status name may contain anything but is
    // conventionally spaced words, and splitting on every colon would silently
    // truncate one that carries a colon of its own.
    const colon = raw.indexOf(':');
    if (colon === -1) {
      warnings.push(
        `pipeline.jira_transitions entry "${raw}" is not "<our status>:<their target status>" — skipped`
      );
      continue;
    }
    const from = raw.slice(0, colon).trim();
    const target = raw.slice(colon + 1).trim();
    if (!TICKET_STATUSES.includes(from)) {
      warnings.push(
        `pipeline.jira_transitions."${from}" is not a ticket status — skipped `
        + `(statuses: ${TICKET_STATUSES.join(', ')}; the front's bucket names are not statuses)`
      );
      continue;
    }
    if (!target) {
      warnings.push(`pipeline.jira_transitions."${from}" has no target status name — skipped`);
      continue;
    }
    out[from] = target;
  }
  return out;
}

// One ordered set of tracker status NAMES from the comma-separated capability
// spelling. Empty segments are silent so the declared empty default remains the
// safe, disabled state; duplicate names collapse to their first occurrence.
// Status spelling is intentionally preserved after trimming because matching is
// against the tracker's name, not a normalized category or an invented alias.
function normalizePrTitleFormat(value, warnings) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(
      'pipeline.pr_title_format must be a title-format string, or a map of "owner/repo" (or "default") to a '
      + 'title-format string — ignored'
    );
    return null;
  }
  const out = {};
  for (const [key, pattern] of Object.entries(value)) {
    if (key !== 'default' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(key)) {
      warnings.push(`pipeline.pr_title_format."${key}" is not "default" or an owner/name slug — ignored`);
      continue;
    }
    if (typeof pattern !== 'string' || !pattern) {
      warnings.push(`pipeline.pr_title_format."${key}" must be a non-empty title-format string — ignored`);
      continue;
    }
    out[key] = pattern;
  }
  return out;
}

const REPOSITORY_CONFIG_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const COMMENT_MARKER_REGEX_METACHARS = new Set(['\\', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);

function normalizeRepositoryArrayMap(value, warnings, key, allowDefault, normalizeItem) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`pipeline.${key} must be an object keyed by ${allowDefault ? '"owner/repo" or "default"' : '"owner/repo"'} — ignored`);
    return null;
  }
  const out = {};
  for (const [repo, entries] of Object.entries(value)) {
    if (!(allowDefault && repo === 'default') && !REPOSITORY_CONFIG_SLUG_RE.test(repo)) {
      warnings.push(`pipeline.${key}."${repo}" is not ${allowDefault ? '"default" or ' : ''}an owner/repo slug — ignored`);
      continue;
    }
    if (!Array.isArray(entries)) {
      warnings.push(`pipeline.${key}."${repo}" must be an array — ignored`);
      continue;
    }
    const normalized = [];
    for (const entry of entries) {
      const result = normalizeItem(entry);
      if (!result.ok) {
        warnings.push(`pipeline.${key}."${repo}" ${result.error} — skipped`);
        continue;
      }
      normalized.push(result.value);
    }
    out[repo] = normalized;
  }
  return out;
}

function normalizeCommentMarkers(value, warnings) {
  return normalizeRepositoryArrayMap(value, warnings, 'comment_markers', true, (token) => {
    const chars = typeof token === 'string' ? [...token] : [];
    const invalid = typeof token !== 'string' || chars.length < 1 || chars.length > 64
      || /\s/.test(token) || chars.some((char) => COMMENT_MARKER_REGEX_METACHARS.has(char));
    return invalid
      ? { ok: false, error: `token ${JSON.stringify(token)} must be 1..64 characters with no whitespace or regex metacharacters` }
      : { ok: true, value: token };
  });
}

function normalizeReviewerBots(value, warnings) {
  return normalizeRepositoryArrayMap(value, warnings, 'reviewer_bots', true, (login) => {
    const wildcard = typeof login === 'string' && login.endsWith('*');
    const base = typeof login === 'string' ? (wildcard ? login.slice(0, -1) : login) : '';
    const name = base.endsWith('[bot]') ? base.slice(0, -5) : base;
    const valid = typeof login === 'string' && login.length > 0 && !/\s/.test(login)
      && (login.match(/\*/g) || []).length === (wildcard ? 1 : 0)
      && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)
      && (wildcard || !name.endsWith('-'));
    return valid
      ? { ok: true, value: login }
      : { ok: false, error: `login ${JSON.stringify(login)} must be a login optionally ending in one "*"` };
  });
}

function normalizeRepositoryRemedies(value, warnings) {
  return normalizeRepositoryArrayMap(value, warnings, 'repo_remedies', false, (remedy) => {
    if (!remedy || typeof remedy !== 'object' || Array.isArray(remedy)) {
      return { ok: false, error: `entry ${JSON.stringify(remedy)} must be an object` };
    }
    const allowed = new Set(['signature', 'workflow', 'inputs', 'ref', 'bot']);
    const extra = Object.keys(remedy).find((field) => !allowed.has(field));
    if (extra) return { ok: false, error: `entry has unknown field "${extra}"` };
    if (typeof remedy.signature !== 'string' || !remedy.signature.trim()) {
      return { ok: false, error: 'entry signature must be a non-empty string' };
    }
    if (typeof remedy.workflow !== 'string' || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(remedy.workflow)) {
      return { ok: false, error: 'entry workflow must be a workflow filename ending in .yml or .yaml' };
    }
    if (Object.prototype.hasOwnProperty.call(remedy, 'inputs')
        && (!remedy.inputs || typeof remedy.inputs !== 'object' || Array.isArray(remedy.inputs)
          || Object.values(remedy.inputs).some((input) => typeof input !== 'string'))) {
      return { ok: false, error: 'entry inputs must be an object of string values' };
    }
    if (Object.prototype.hasOwnProperty.call(remedy, 'ref')
        && (typeof remedy.ref !== 'string' || !remedy.ref)) {
      return { ok: false, error: 'entry ref must be a non-empty string' };
    }
    const bot = remedy.bot === undefined ? 'github-actions[bot]' : remedy.bot;
    const login = typeof bot === 'string' && bot.endsWith('[bot]') ? bot.slice(0, -5) : bot;
    if (typeof bot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)
        || login.length > 39 || login.endsWith('-') || login.includes('--')
        || bot.includes('*') || /\s/.test(bot)) {
      return { ok: false, error: `entry bot ${JSON.stringify(bot)} must be one exact GitHub login` };
    }
    const normalized = { signature: remedy.signature, workflow: remedy.workflow, bot };
    if (Object.prototype.hasOwnProperty.call(remedy, 'inputs')) {
      normalized.inputs = Object.fromEntries(Object.entries(remedy.inputs));
    }
    if (Object.prototype.hasOwnProperty.call(remedy, 'ref')) normalized.ref = remedy.ref;
    return { ok: true, value: normalized };
  });
}

function normalizeVerificationCommands(value, warnings) {
  return normalizeRepositoryArrayMap(value, warnings, 'verification_commands', true, (command) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return { ok: false, error: `entry ${JSON.stringify(command)} must be an object with an argv array` };
    }
    const allowed = new Set(['argv', 'profile', 'timeout_s']);
    const extra = Object.keys(command).find((field) => !allowed.has(field));
    if (extra) return { ok: false, error: `entry has unknown field "${extra}"` };
    if (!Array.isArray(command.argv) || command.argv.length === 0
        || command.argv.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
      return { ok: false, error: 'entry argv must be a non-empty array of non-empty strings; shell strings are refused' };
    }
    if (Object.prototype.hasOwnProperty.call(command, 'profile')
        && command.profile !== 'sandbox' && command.profile !== 'host') {
      return { ok: false, error: 'entry profile must be "sandbox" or "host"' };
    }
    if (Object.prototype.hasOwnProperty.call(command, 'timeout_s')
        && (!Number.isInteger(command.timeout_s) || command.timeout_s < 1 || command.timeout_s > 3600)) {
      return { ok: false, error: 'entry timeout_s must be an integer from 1 to 3600' };
    }
    return {
      ok: true,
      value: {
        argv: command.argv.slice(),
        profile: command.profile || 'sandbox',
        ...(Object.prototype.hasOwnProperty.call(command, 'timeout_s') ? { timeout_s: command.timeout_s } : {}),
      },
    };
  });
}

function repoValue(cfg, key, repo) {
  const source = cfg && cfg.config && Array.isArray(cfg.warnings) ? cfg.config : cfg;
  const map = source && source[key];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  if (Object.prototype.hasOwnProperty.call(map, repo) && map[repo] !== undefined) return map[repo] ?? null;
  if (key === 'repo_remedies') return null;
  if (Object.prototype.hasOwnProperty.call(map, 'default')) return map.default ?? null;
  return null;
}

function normalizeJiraTodoStatuses(value, warnings) {
  if (typeof value !== 'string') {
    warnings.push(
      'jira_todo_statuses must be a comma-separated string of tracker status names — ignored'
    );
    return null;
  }
  const out = [];
  const seen = new Set();
  for (const item of value.split(',')) {
    const status = item.trim();
    if (!status || seen.has(status)) continue;
    seen.add(status);
    out.push(status);
  }
  return out;
}

const DEFAULTS = {
  integration_mode: 'epic-stacked',   // | direct-to-main
  model_policy: 'balanced',           // economy | balanced | premium
  // conservative preserves the role floor; adaptive classifies each dispatch
  // and opens the routine lane for bounded low-risk work.
  model_ladder: 'conservative',       // conservative | adaptive
  use_workflow: 'auto',               // auto | false
  // The PR sentinel: who drives open PRs to green and lands them in the stack
  // while the main loop cascades onward.
  //   sentinel:   auto (background guard when the runtime has one, otherwise a
  //               mandatory duty pass every round) | off (main loop only)
  //   auto_merge: epic — the sentinel squashes a green+conform ticket PR into
  //               its base (phase epic or parent ticket branch). The epic →
  //               integration-branch PR is NEVER auto-merged; that stays human.
  //               off — every merge is a human's, the pre-sentinel behaviour.
  code_review: 'hold',                // @contract: report | hold
  sentinel: 'auto',                   // auto | off
  auto_merge: 'epic',                 // epic | off
  // A PR with NO reported checks is not a green PR — nothing ran. Both the board
  // (front.cjs) and the guard (sentinel.cjs) therefore withhold the two actions
  // that walk such a PR towards landing, and this is the project's way to say
  // "there is no CI here, that absence is expected". Opt-in only, and it fails
  // towards the human: see the coercion below.
  merge_without_ci: false,
  max_attempts: 5,                    // babysit rounds per PR (the backstop, not the ladder's input)
  // How many agents a wave may hold at once (ADR-005 D11). The one axis no
  // choice of TIER can address: the model policy is per dispatch and a spend
  // limit is per SESSION, so what decides whether a run survives is how many
  // dispatches are open together. On 2026-09-07 a run held nine opus/xhigh
  // executors and a fable guard in flight, hit a per-session limit, and six
  // agents died mid-ticket — five tickets lost their commits and the recovery
  // cost a whole re-dispatch round. Priced on that session's volumes the entire
  // ladder question is worth ~$26; this one is worth the run.
  //
  // 4 is a MEASUREMENT, not a round number: the largest wave this repository has
  // completed without an interruption. Every role counts against it, the PR
  // sentinel included — it is an agent, it holds tickets, and that session's
  // failure included one.
  //
  // `front.cjs` reports it as `capacity: {max, in_flight, free}` and deliver.md
  // builds the wave from `capacity.free`; the remainder is taken next round. A
  // wave wider than the cap is CUT, never refused. Note the two failure
  // directions are different on purpose: a malformed value here falls back to
  // this default (below, with every other positive-number knob), because a typo
  // in a number is not a decision to stop working — while a config file that
  // does not PARSE resolves to a cap of 0 in front.cjs, because then no policy
  // is in effect at all and a dispatch is a mutation.
  max_concurrent_agents: 4,
  // K of the k-distinct rule: this many DIFFERENT failure signatures with no
  // green means the ticket is wrong, not the fix (ADR-001 D2). Same default as
  // `failure-signature.cjs verdict --k`, and the two must agree.
  plan_defect_signatures: 3,
  pr_fetch_limit: 1000,               // `gh pr list --limit`
  stale_merge_hours: 4,
  stale_draft_hours: 24,
  worktree_root: null,                // null → <repo>/../.wt-<repo-name>
  graph_gate: true,                   // mirrors the capability's declared key
  gsd_sync: true,                     // mirrors the capability's declared key
  models: {},                         // per-role override → tier alias
  effort: {},                         // per-role override → effort level
  // The CEILING, and the consent that unlocks it (ADR-005 D5). `off` is the
  // default because an unconsented Fable request in a background session waits
  // out `dialogExpiry` and then ends the turn WITHOUT SENDING: silence is not
  // consent, exactly as decomposition treats pre-authorization. Under `off`
  // every ceiling route degrades to `opus` at `max` and prints the reason, so
  // the escalation still happens — one rung lower and visibly.
  fable: 'off',                       // off | auto
  // The window route's threshold: five times the largest input measured on this
  // repository (the phase-24 epic diff, the integrator's own input, at 210 KB
  // ≈ 52k tokens). The caller MEASURES and passes `--input-tokens`; the resolver
  // only decides. Absent, the route cannot fire — an absent signal must never
  // resolve upward.
  fable_window_tokens: 250000,
  // The Codex model palette, in preference order (see DEFAULT_CODEX_MODELS).
  // Mirrors the capability's declared `delivery_pipeline.codex_models`.
  codex_models: DEFAULT_CODEX_MODELS,
  // Sibling repositories the graph delivers into ("owner/name" → absolute local
  // checkout path). Tracking a foreign repo needs nothing but `delivery.repo` on
  // the ticket; EXECUTING there needs a local checkout, because worktrees,
  // commits and pushes are local git operations.
  repos: {},
  // The root where a future foreign-repository checkout may be placed. It is
  // resolved per project by loadConfig; null is reserved for a malformed
  // explicit value so a writer cannot mistake bad configuration for consent.
  repos_root: null,
  pr_title_format: null,
  comment_markers: null,
  reviewer_bots: null,
  repo_remedies: null,
  verification_commands: null,
  jira: { enabled: true, project: null, issue_type: 'Task', epic_issue_type: 'Epic' },
  // Our ticket status → the tracker's TARGET STATUS NAME, for the projection
  // (ADR-008 D2). TOP-LEVEL and flat, deliberately NOT a member of `jira`:
  // `delivery_pipeline` is merged over `pipeline` SHALLOWLY, so an object-valued
  // `jira` in one namespace replaces the other's wholesale and a nested knob
  // would vanish the moment a user set one key in the other place.
  // EMPTY IS OFF, and empty is the default — the same posture as `fable: off`:
  // silence is not consent to write into someone's tracker.
  jira_transitions: {},
  // Tracker status NAME allowlist for the eligibility gate. EMPTY IS OFF.
  jira_todo_statuses: [],
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_JIRA_KEYS = new Set(['enabled', 'project', 'issue_type', 'epic_issue_type']);
const COMPATIBILITY_ROLES = Object.freeze(['integrator', 'arch-review', 'code-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research', 'pr-sentinel']);
// Existing board/recorder consumers use ROLES with their compatibility tables.
// Routed consumers share the canonical vocabulary, including decomposition,
// explicitly; expanding ROLES would advertise support those tables do not have.
const ROLES = COMPATIBILITY_ROLES;
const ROUTED_ROLES = modelPolicy.ROLES;

const JUDGMENT_ROLES = new Set(['integrator', 'arch-review', 'code-review']);

// GSD's own model_profile vocabulary, accepted as an alias for ours so a user who
// knows GSD does not get a "not one of economy|balanced|premium" warning.
const PROFILE_ALIASES = { budget: 'economy', quality: 'premium', adaptive: 'balanced', inherit: 'balanced' };

function configPath(root) {
  return path.join(root || process.cwd(), '.planning', 'config.json');
}

// Path policy shared by pipeline-config and repo-resolve. Keep the physical
// resolution here: a second string-prefix implementation in the resolver would
// eventually disagree on symlinks, missing clone destinations, or `sub_repos`.
function policyPath(value) {
  let current = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync(current), ...missing);
  } catch {
    return path.resolve(value);
  }
}

function defaultRepositoryRoot(projectRoot = process.cwd()) {
  return path.resolve(path.dirname(path.resolve(projectRoot)));
}

function repositoryRootValue(value, projectRoot = process.cwd()) {
  // GSD materializes string capability defaults into config.json. The declared
  // empty string is therefore the persisted spelling of an omitted root, not a
  // malformed operator policy; keep it on the documented project-parent path.
  if (value === undefined || value === '') {
    return { valid: true, path: defaultRepositoryRoot(projectRoot), reason: null };
  }
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    return {
      valid: false,
      path: null,
      reason: 'pipeline.repos_root must be a non-empty absolute path',
    };
  }
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return {
        valid: false,
        path: null,
        reason: 'pipeline.repos_root must name a directory or a path that does not exist yet',
      };
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return {
        valid: false,
        path: null,
        reason: `pipeline.repos_root cannot be inspected (${error.code || error.message})`,
      };
    }
    // stat follows symlinks and reports a dangling link as ENOENT. lstat keeps
    // that occupied destination fail-closed while still allowing a genuinely
    // absent root, which a later clone may create.
    try {
      fs.lstatSync(resolved);
      return {
        valid: false,
        path: null,
        reason: 'pipeline.repos_root must name a directory or a path that does not exist yet',
      };
    } catch (entryError) {
      if (entryError && entryError.code !== 'ENOENT') {
        return {
          valid: false,
          path: null,
          reason: `pipeline.repos_root cannot be inspected (${entryError.code || entryError.message})`,
        };
      }
    }
  }
  return { valid: true, path: resolved, reason: null };
}

function isWithin(root, candidate) {
  const relative = path.relative(policyPath(root), policyPath(candidate));
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

/**
 * Validate a repository checkout or future clone destination.
 *
 * `requireInsideRoot` applies the configured clone root in addition to the
 * project nesting rule. The helper does not require the candidate to exist and
 * never creates or modifies a path.
 *
 * @param {string} candidate
 * @param {{projectRoot?: string, reposRoot?: string|null, subRepos?: string[], requireInsideRoot?: boolean, label?: string}} options
 * @returns {{valid: boolean, path: string|null, project_root: string, repos_root: string|null, reason: string|null}}
 */
function validateRepositoryDestination(candidate, options = {}) {
  const {
    projectRoot = process.cwd(),
    reposRoot,
    subRepos = [],
    requireInsideRoot = false,
    label = 'repository destination',
  } = options;
  const project = policyPath(projectRoot);
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) {
    return {
      valid: false,
      path: null,
      project_root: project,
      repos_root: null,
      reason: `${label} must be a non-empty absolute path`,
    };
  }
  const target = policyPath(candidate);
  const relative = path.relative(project, target);
  if (relative === '') {
    return {
      valid: false,
      path: target,
      project_root: project,
      repos_root: null,
      reason: `${label} "${target}" is the project root and cannot be adopted`,
    };
  }
  const nested = relative
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
  if (nested) {
    const top = relative.split(path.sep)[0];
    if (!Array.isArray(subRepos) || !subRepos.includes(top)) {
      return {
        valid: false,
        path: target,
        project_root: project,
        repos_root: null,
        reason: `${label} "${target}" is nested inside this project "${project}" without sub_repos declaration for "${top}"`,
      };
    }
  }

  let root = null;
  if (requireInsideRoot) {
    const rootResult = repositoryRootValue(reposRoot, projectRoot);
    if (!rootResult.valid) {
      return {
        valid: false,
        path: target,
        project_root: project,
        repos_root: null,
        reason: rootResult.reason,
      };
    }
    root = policyPath(rootResult.path);
    if (!isWithin(root, target)) {
      return {
        valid: false,
        path: target,
        project_root: project,
        repos_root: root,
        reason: `${label} "${target}" is outside pipeline.repos_root "${root}"`,
      };
    }
  }
  return {
    valid: true,
    path: target,
    project_root: project,
    repos_root: root,
    reason: null,
  };
}

// A config file that EXISTS but cannot be read is not the same fact as one that
// is ABSENT, and every mutating caller has to be able to tell them apart (ADR-004
// D2, audit F03). Absent means "nobody has configured this yet", and the defaults
// are exactly the right answer. Unparseable means "what this project decided is
// UNKNOWN" — and a truncated file that said `auto_merge: off` used to resolve to
// the DEFAULT `epic` with nothing but a warning, so the guard merged under a
// policy the file forbade.
//
// So `valid` is the field a WRITER checks and `config` stays populated for
// readers: a board still has to render, a `resolve` still has to print. The
// absent/unparseable split is the same distinction `drift-needed.cjs`'s
// `readJsonDistinct` draws over delivery-state.json, drawn here over the config;
// `exists` was already half of it.
//
//   { valid: true,  error: null }                  absent, or parsed to an object
//   { valid: false, error: {file, relative, message} }  exists and does not parse
//
// `error.file` is ABSOLUTE (ci-wait.cjs runs from a worktree, where a relative
// path names nothing a person can open) and `error.relative` is the project-root
// spelling the human-facing sentences use.
function loadConfig(root, options = {}) {
  const base = root || process.cwd();
  const file = configPath(base);
  const warnings = [];
  let raw = {};
  let error = null;
  const exists = fs.existsSync(file);
  const invalid = (message) => {
    error = { file, relative: path.relative(base, file), message };
    raw = {};
    // The warning says INVALID rather than "using defaults", because the
    // defaults are precisely what must NOT apply: state-sync prints every
    // warning on the board, and "using defaults" beside "no policy in effect"
    // is the board contradicting itself in two consecutive lines.
    warnings.push(
      `${error.relative} ${message} — INVALID: no policy is in effect. Every mutation refuses `
      + '(no merge, no escalation) until the file parses; the fix is the file, not a flag.'
    );
  };
  if (exists) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      invalid(`is not valid JSON (${e.message})`);
    }
    // Checked BEFORE anything reads `raw.pipeline`: `JSON.parse('null')` returns
    // null and the very next line used to throw a TypeError on it, so a config
    // containing `null` took state-sync and the sentinel down with a stack trace
    // instead of a refusal. An array or a scalar is the same absence of a
    // configuration, reported the same way.
    if (!error) {
      const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalid(`is not a JSON object (got ${shape})`);
      } else {
        raw = parsed;
      }
    }
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  // delivery_pipeline.* (the capability's declared, GSD-native namespace) wins
  // over pipeline.* for any key present in both.
  const legacyPipeline = obj(raw.pipeline);
  const declaredPipeline = obj(raw.delivery_pipeline);
  const merged = { ...legacyPipeline, ...declaredPipeline };
  if (Object.prototype.hasOwnProperty.call(legacyPipeline, 'gsd_sync')) {
    if (!Object.prototype.hasOwnProperty.call(declaredPipeline, 'gsd_sync')) {
      if (typeof legacyPipeline.gsd_sync === 'boolean') merged.gsd_sync = legacyPipeline.gsd_sync;
      else delete merged.gsd_sync;
    }
    warnings.push('pipeline.gsd_sync is deprecated — rename it to delivery_pipeline.gsd_sync');
  }

  // GSD's own `sub_repos` (both the flat and the nested shape it accepts). It is
  // the declared way to say "this nested checkout belongs to my project", and
  // findProjectRoot honours it BEFORE its git-boundary guard — so it is the fix
  // we point at when a `pipeline.repos` path turns out to be nested.
  const subReposRaw = raw.sub_repos ?? obj(raw.planning).sub_repos;
  const subRepos = Array.isArray(subReposRaw) ? subReposRaw : [];

  // Every nested value is copied, never shared with DEFAULTS: a caller that
  // sorts or filters the palette in place would otherwise change what the next
  // loadConfig() in the same process returns.
  const runtimeContext = resolveRuntime(base, {
    ...options,
    // Parse/configuration validity is the first refusal for routed loads. The
    // strict runtime context is resolved below, after malformed project and
    // inherited configuration can be reported with their own source.
    routed: false,
    scriptPath: options.scriptPath || __filename,
  });
  // Keep a strict context even for compatibility loads. A later routed caller
  // must see the original error/overrides, not the parser's sanitized defaults.
  let dispatchRuntime;
  let dispatchError;
  let inheritedConfig = {};
  try {
    if (error) throw modelPolicy.policyError('INVALID_CONFIG', error.message, { source: file });
    inheritedConfig = readInheritedConfig(base, options);
    dispatchRuntime = resolveRuntime(base, { ...options, scriptPath: options.scriptPath || __filename, routed: true });
  } catch (failure) {
    if (options.routed === true) throw failure;
    dispatchError = { code: failure.code, message: failure.message, details: failure.details };
  }

  const dispatchContext = {
    // This is the immutable mode boundary. `cfg.routed` remains as a legacy
    // compatibility field for readers, but routed selection must never trust a
    // caller-controlled copy of it after this context has been created.
    mode: options.routed === true ? 'routed' : 'compatibility',
    routed: options.routed === true,
    runtime: dispatchRuntime || null,
    error: dispatchError || null,
    // Store selection inputs before namespace merging and validation. In
    // particular a rejected full model ID must not disappear at this boundary.
    configuration: selectionConfig({ ...inheritedConfig, ...raw }),
  };
  const cfg = {
    ...DEFAULTS,
    jira: { ...DEFAULTS.jira },
    models: {},
    effort: {},
    repos: {},
    codex_models: DEFAULT_CODEX_MODELS.map((e) => ({ ...e })),
    jira_transitions: {},
    jira_todo_statuses: [],
    routed: options.routed === true,
    policy_version: modelPolicy.POLICY_VERSION,
    policy_hash: modelPolicy.POLICY_HASH,
    dispatch_context: dispatchContext,
  };
  LOADED_DISPATCH_CONTEXTS.set(cfg, dispatchContext);
  for (const [key, value] of Object.entries(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown pipeline config key "${key}" — ignored (known: ${[...KNOWN_KEYS].sort().join(', ')})`);
      continue;
    }
    if (key === 'jira') {
      for (const [jk, jv] of Object.entries(obj(value))) {
        if (!KNOWN_JIRA_KEYS.has(jk)) { warnings.push(`unknown pipeline.jira key "${jk}" — ignored`); continue; }
        cfg.jira[jk] = jv;
      }
      continue;
    }
    if (key === 'models') {
      for (const [role, tier] of Object.entries(obj(value))) {
        if (!ROLES.includes(role)) {
          warnings.push(`pipeline.models."${role}" is not a pipeline role — ignored (roles: ${ROLES.join(', ')})`);
          continue;
        }
        if (!TIERS.includes(tier)) {
          warnings.push(
            `pipeline.models."${role}" = "${tier}" is not a tier alias — ignored. Use one of ${TIERS.join('|')}; ` +
            'full model IDs are not accepted by the Agent tool (set them in GSD model_overrides instead).'
          );
          continue;
        }
        cfg.models[role] = tier;
      }
      continue;
    }
    if (key === 'repos') {
      for (const [slug, local] of Object.entries(obj(value))) {
        if (!REPOSITORY_CONFIG_SLUG_RE.test(slug)) {
          warnings.push(`pipeline.repos."${slug}" is not an owner/name slug — ignored (it must match delivery.repo in the plans)`);
          continue;
        }
        if (typeof local !== 'string' || !local) {
          warnings.push(`pipeline.repos."${slug}" must be a path to the local checkout — ignored`);
          continue;
        }
        if (!path.isAbsolute(local)) {
          warnings.push(`pipeline.repos."${slug}" = "${local}" is relative — the conveyor runs from several worktrees, so it must be an ABSOLUTE path`);
          continue;
        }
        // A sibling checkout nested inside this project is the one layout where
        // GSD's project-root resolution changed under us. Keep this warning on
        // the shared helper so resolver adoption and config loading cannot
        // disagree about the same physical path.
        const destination = validateRepositoryDestination(local, {
          projectRoot: base,
          subRepos,
          label: `pipeline.repos."${slug}" = "${local}"`,
        });
        if (!destination.valid) warnings.push(destination.reason);
        cfg.repos[slug] = local;
      }
      continue;
    }
    if (key === 'codex_models') {
      const palette = normalizeCodexModels(value, warnings);
      // A wholly unusable value keeps the shipped palette; an explicitly EMPTY
      // one is honoured, because "write no model" is a legitimate choice.
      if (palette !== null) cfg.codex_models = palette;
      continue;
    }
    if (key === 'jira_transitions') {
      const map = normalizeJiraTransitions(value, warnings);
      // A wholly unusable value keeps the empty map, which is the projection
      // switched off — the safe direction for anything that writes to a tracker.
      if (map !== null) cfg.jira_transitions = map;
      continue;
    }
    if (key === 'jira_todo_statuses') {
      const statuses = normalizeJiraTodoStatuses(value, warnings);
      // A malformed value keeps the empty list, which leaves eligibility off.
      if (statuses !== null) cfg.jira_todo_statuses = statuses;
      continue;
    }
    if (key === 'pr_title_format') {
      const format = normalizePrTitleFormat(value, warnings);
      if (format !== null) cfg.pr_title_format = format;
      continue;
    }
    if (key === 'comment_markers') {
      const markers = normalizeCommentMarkers(value, warnings);
      if (markers !== null) cfg.comment_markers = markers;
      continue;
    }
    if (key === 'reviewer_bots') {
      const bots = normalizeReviewerBots(value, warnings);
      if (bots !== null) cfg.reviewer_bots = bots;
      continue;
    }
    if (key === 'repo_remedies') {
      const remedies = normalizeRepositoryRemedies(value, warnings);
      if (remedies !== null) cfg.repo_remedies = remedies;
      continue;
    }
    if (key === 'verification_commands') {
      const commands = normalizeVerificationCommands(value, warnings);
      if (commands !== null) cfg.verification_commands = commands;
      continue;
    }
    if (key === 'effort') {
      for (const [role, level] of Object.entries(obj(value))) {
        if (!ROLES.includes(role)) {
          warnings.push(`pipeline.effort."${role}" is not a pipeline role — ignored`);
          continue;
        }
        if (level !== 'minimal' && !EFFORTS.includes(level)) {
          warnings.push(`pipeline.effort."${role}" = "${level}" is not an effort level — ignored (${EFFORTS.join('|')})`);
          continue;
        }
        // ADR-005 D3: the override is read BEFORE the signature rule, so on a
        // repair role it also switches off the depth rung a repeated failure
        // earns. It keeps its precedence — a person who measured something wins —
        // but it no longer does that silently, because shipping the effort table
        // as configuration is exactly how the repair ladder was disabled once.
        if (REPAIR_ROLES.has(role)) {
          warnings.push(
            `pipeline.effort."${role}" = "${level}" outranks the repair ladder's depth rung: a repeated ` +
            'failure signature would otherwise raise this role to "max". It is honoured, but the escalation ' +
            'is now off for this role — remove the key to get it back.'
          );
        }
        cfg.effort[role] = level;
      }
      continue;
    }
    cfg[key] = value;
  }

  // Resolve the root after the namespace merge so delivery_pipeline.repos_root
  // wins over the legacy spelling just like every other pipeline key. A bad
  // explicit value becomes null rather than silently becoming the project
  // parent; repo-resolve then refuses a clone until the policy is fixed.
  const repositoryRoot = repositoryRootValue(merged.repos_root, base);
  cfg.repos_root = repositoryRoot.path;
  if (!repositoryRoot.valid) warnings.push(`${repositoryRoot.reason} — ignored; cloning is refused until it is fixed`);
  // The resolver consumes this normalized declaration through the same config
  // object and the same destination helper below.
  cfg.sub_repos = subRepos;

  // Enum-ish knobs: a misspelling here decides whether PRs get merged at all, so
  // it is reported rather than silently coerced to the safe value.
  if (cfg.auto_merge === true) cfg.auto_merge = 'epic';
  if (cfg.auto_merge === false) cfg.auto_merge = 'off';
  if (!['epic', 'off'].includes(cfg.auto_merge)) {
    warnings.push(`pipeline.auto_merge "${cfg.auto_merge}" is unknown — falling back to off (values: epic | off)`);
    cfg.auto_merge = 'off';
  }
  if (!['report', 'hold'].includes(cfg.code_review)) {
    warnings.push(`delivery_pipeline.code_review "${cfg.code_review}" is unknown — falling back to ${DEFAULTS.code_review} (values: report | hold)`);
    cfg.code_review = DEFAULTS.code_review;
  }
  if (cfg.sentinel === true) cfg.sentinel = 'auto';
  if (cfg.sentinel === false) cfg.sentinel = 'off';
  if (!['auto', 'off'].includes(cfg.sentinel)) {
    warnings.push(`pipeline.sentinel "${cfg.sentinel}" is unknown — falling back to auto (values: auto | off)`);
    cfg.sentinel = 'auto';
  }
  // The sentinel is what performs an auto-merge; without a guard there is nobody
  // to re-verify the gate against live GitHub, so the pair must stay consistent.
  if (cfg.sentinel === 'off' && cfg.auto_merge === 'epic') {
    warnings.push('pipeline.sentinel is off, so nothing can auto-merge — treating pipeline.auto_merge as off (turn the sentinel back on to land ticket PRs automatically)');
    cfg.auto_merge = 'off';
  }
  // The polarity is deliberately asymmetric, the same way `preauthorized` is in
  // front.cjs: this knob authorizes landing a PR that nothing verified, so only
  // a real `true` (or the string a hand-edited JSON file acquires) opts in, and
  // anything else is reported rather than silently honoured. A misspelling here
  // must not read as consent.
  if (cfg.merge_without_ci === 'true') cfg.merge_without_ci = true;
  if (cfg.merge_without_ci === 'false') cfg.merge_without_ci = false;
  if (typeof cfg.merge_without_ci !== 'boolean') {
    warnings.push(
      `pipeline.merge_without_ci "${cfg.merge_without_ci}" is not a boolean — using false, ` +
      'so a PR with no reported checks stays a human\'s merge (values: true | false)'
    );
    cfg.merge_without_ci = false;
  }
  // The consent knob for the paid ceiling, with `sentinel`'s polarity and for a
  // sharper reason: this one authorizes a model that may bill usage credits and
  // whose consent prompt an unattended session cannot answer. So only a real
  // `auto` opts in, and anything else is reported rather than honoured — a
  // misspelling must never read as consent.
  if (cfg.fable === true) cfg.fable = 'auto';
  if (cfg.fable === false) cfg.fable = 'off';
  if (!['auto', 'off'].includes(cfg.fable)) {
    warnings.push(
      `pipeline.fable "${cfg.fable}" is unknown — falling back to off (values: auto | off), ` +
      'so the ceiling routes degrade to opus at high effort'
    );
    cfg.fable = 'off';
  }
  if (!['epic-stacked', 'direct-to-main'].includes(cfg.integration_mode)) {
    warnings.push(`pipeline.integration_mode "${cfg.integration_mode}" is unknown — falling back to epic-stacked`);
    cfg.integration_mode = 'epic-stacked';
  }
  if (PROFILE_ALIASES[cfg.model_policy]) {
    cfg.model_policy = PROFILE_ALIASES[cfg.model_policy];
  } else if (!['economy', 'balanced', 'premium'].includes(cfg.model_policy)) {
    warnings.push(`pipeline.model_policy "${cfg.model_policy}" is unknown — falling back to balanced`);
    cfg.model_policy = 'balanced';
  }
  if (!LADDER_MODES.includes(cfg.model_ladder)) {
    warnings.push(
      `pipeline.model_ladder "${cfg.model_ladder}" is unknown — falling back to conservative ` +
      `(values: ${LADDER_MODES.join(' | ')})`
    );
    cfg.model_ladder = 'conservative';
  }
  // ONE numeric rule for every positive-number knob, and it is shared on purpose:
  // a bespoke coercion per knob is one more place to get the fallback direction
  // wrong. Two values used to pass it silently, and BOTH were properties of the
  // rule rather than of any knob — so they were shipped accepted for every one of
  // these seven at once, and probing only the endpoints is exactly how:
  //
  //   `true`  — `Number(true) === 1`, a positive finite number, so
  //             `max_concurrent_agents: true` capped a whole session at ONE agent
  //             with no warning. `false` (→ 0 → the default) is the mirror, which
  //             is why checking `false` proved nothing. A boolean is not a number:
  //             it is refused BEFORE Number(), and a numeric STRING still works,
  //             because a hand-edited config.json legitimately acquires those.
  //   `4.5`   — survived intact and produced a FRACTIONAL board (`free: 0.5` is
  //             truthy, so front.cjs's `free === 0` fixpoint branch never fired
  //             while nothing could actually be dispatched). Floored, and the
  //             floor is reported: a silently rounded knob is a value the operator
  //             did not set.
  //
  // The floor runs BEFORE the positivity check, so `0.5` floors to 0 and then
  // falls back to the default like any other non-positive value. That is
  // deliberate rather than incidental: `front.cjs`'s `capMax` reserves `max === 0`
  // for exactly one fact — no policy could be READ — and `formatFront` words its
  // line off it, so letting a parsing file resolve 0 would make the board report
  // it as unparseable. A malformed number in a readable file falls back; only an
  // unreadable file dispatches nothing.
  for (const numeric of NUMERIC_KNOBS) {
    const given = cfg[numeric];
    if (typeof given === 'boolean') {
      warnings.push(
        `pipeline.${numeric} is ${given}, which is not a number — using ${DEFAULTS[numeric]} `
        + '(a boolean coerces to 1 or 0, so it would silently read as a value nobody set)'
      );
      cfg[numeric] = DEFAULTS[numeric];
      continue;
    }
    const asNumber = Number(given);
    const n = Number.isFinite(asNumber) ? Math.floor(asNumber) : asNumber;
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`pipeline.${numeric} must be a positive number — using ${DEFAULTS[numeric]}`);
      cfg[numeric] = DEFAULTS[numeric];
    } else {
      if (n !== asNumber) {
        warnings.push(`pipeline.${numeric} is ${asNumber}, which is not a whole number — using ${n}`);
      }
      cfg[numeric] = n;
    }
  }
  cfg.use_workflow = cfg.use_workflow === false || cfg.use_workflow === 'false' ? false : 'auto';
  cfg.graph_gate = cfg.graph_gate !== false;

  // These values are the normalized pipeline controls the routed bridge passes
  // to the canonical resolver. Keep the normalized copy inside the frozen
  // context so a post-load mutation of the compatibility-shaped `cfg` cannot
  // change consent or the window threshold after the boundary was crossed.
  dispatchContext.normalized = {
    fable: cfg.fable,
    fable_window_tokens: cfg.fable_window_tokens,
    model_policy: cfg.model_policy,
  };

  // ── GSD's own settings the conveyor must agree with ───────────────────────
  const git = obj(raw.git);
  const workflow = obj(raw.workflow);
  cfg.gsd = {
    // `runtime` is an execution-context value. GSD resolves it from
    // GSD_RUNTIME/the per-install marker; a project value is retained only as
    // a legacy fallback by runtime-context.cjs. This lets one checkout be used
    // by Claude and Codex concurrently without rewriting config.json per run.
    runtime: runtimeContext.runtime,
    runtime_source: runtimeContext.source,
    persisted_runtime: runtimeContext.persisted,
    base_branch: typeof git.base_branch === 'string' && git.base_branch ? git.base_branch : null,
    branching_strategy: typeof git.branching_strategy === 'string' ? git.branching_strategy : null,
    response_language: typeof raw.response_language === 'string' ? raw.response_language : null,
    use_worktrees: typeof workflow.use_worktrees === 'boolean' ? workflow.use_worktrees : null,
  };
  if (runtimeContext.conflict) {
    warnings.push(
      `project runtime "${runtimeContext.conflict.persisted}" is a legacy persisted value, but the active ` +
      `runtime is "${runtimeContext.conflict.effective}" (${runtimeContext.source}); using the active runtime. ` +
      'Remove the top-level "runtime" key from .planning/config.json so both runtimes can share this checkout.'
    );
  }
  // @invariant: no shipyard path may call execute-phase; workflow.use_worktrees is not warned on.
  // GSD's phase/milestone strategies create their own branches; the conveyor owns
  // branching (epic/<phase> + ticket/<id>) and the two would fight over it.
  if (cfg.gsd.branching_strategy && cfg.gsd.branching_strategy !== 'none') {
    warnings.push(
      `git.branching_strategy is "${cfg.gsd.branching_strategy}", but the delivery conveyor owns branching ` +
      '(epic/<phase> + ticket/<id> + PR per ticket). Set it to "none" so GSD does not also create phase/milestone branches.'
    );
  }
  // The plugin-namespaced agent_skills form only resolves on the claude runtime.
  const agentSkills = obj(raw.agent_skills);
  for (const [agent, entries] of Object.entries(agentSkills)) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const namespaced = entry.startsWith('global:') && entry.slice(7).includes(':');
      if (namespaced && cfg.gsd.runtime && cfg.gsd.runtime !== 'claude') {
        warnings.push(
          `agent_skills."${agent}" uses "${entry}", a plugin-namespaced skill that GSD resolves ONLY on the claude ` +
          `runtime — it is silently skipped on runtime "${cfg.gsd.runtime}". Use the project-relative ` +
          `"${PROJECT_DELIVERY_RULES}" projection instead (run gsd-tune.cjs --apply).`
        );
      }
      if (entry === PROJECT_DELIVERY_RULES
          && !fs.existsSync(path.join(base, PROJECT_DELIVERY_RULES, 'SKILL.md'))) {
        warnings.push(
          `agent_skills."${agent}" points at "${PROJECT_DELIVERY_RULES}", but its SKILL.md is missing — ` +
          'run gsd-tune.cjs --apply to generate the Shipyard project skill projection.'
        );
      }
    }
  }

  freezeSelection(dispatchContext);
  return { config: cfg, warnings, file, exists, valid: error === null, error };
}

function freezeSelection(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSelection(child);
    Object.freeze(value);
  }
  return value;
}

function selectionConfig(raw) {
  const keys = ['models', 'effort', 'model_overrides', 'model', 'reasoning_effort',
    'override', 'overrides', 'selection', 'inline', 'inherit', 'session_inherited',
    'model_profile', 'model_policy', 'fable', 'fable_window_tokens', 'codex_models'];
  const pick = (object) => Object.fromEntries(keys
    .filter((key) => Object.prototype.hasOwnProperty.call(object, key))
    .map((key) => [key, object[key]]));
  const result = pick(raw);
  // GSD's Codex remap namespaces are not pipeline configuration, but they are
  // still launch inputs. Keep the raw values so a later routed call cannot
  // validate a sanitized pipeline view while the Codex adapter reads these
  // entries independently.
  for (const namespace of ['model_policy', 'model_profile_overrides']) {
    if (Object.prototype.hasOwnProperty.call(raw, namespace)) result[namespace] = raw[namespace];
  }
  for (const namespace of ['pipeline', 'delivery_pipeline', 'gsd']) {
    if (raw[namespace] && typeof raw[namespace] === 'object') result[namespace] = pick(raw[namespace]);
  }
  return result;
}

const GSD_ROLE_KEYS = Object.freeze({
  research: ['research', 'gsd-project-researcher', 'gsd-phase-researcher'],
  decomposition: ['planning', 'gsd-planner', 'gsd-plan-checker'],
  executor: ['execution', 'gsd-executor'],
  'pr-sentinel': ['verification', 'gsd-verifier'],
  integrator: ['verification', 'gsd-integration-checker'],
  'drift-check': ['verification', 'gsd-verifier'],
  'arch-review': ['verification'],
  'code-review': ['verification'],
  'ci-fix': ['execution', 'gsd-debugger'],
  'review-fix': ['execution', 'gsd-code-fixer'],
});

function codexRemapSelection(value) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const model = typeof value === 'string'
    ? value.trim()
    : object && typeof object.model === 'string'
      ? object.model.trim()
      : null;
  // codex-model-remap accepts a string or {model}; keep any effort fields so a
  // contradictory compound GSD entry cannot hide behind its matching model.
  return object ? { ...object, model } : { model: model || value };
}

function isGsdStageTier(name, value) {
  return ['planning', 'execution', 'research', 'verification'].includes(name)
    && ['opus', 'sonnet', 'haiku'].includes(value);
}

function configurationSelections(raw, role, runtime, modelKey) {
  const selections = [];
  const addSelection = (source, selection) => {
    if (selection !== undefined) selections.push({ source, selection });
  };
  const add = (source, field, value) => {
    addSelection(source, value === undefined ? undefined : { [field]: value });
  };
  // GSD's canonical policy resolver treats these as configuration override
  // sources. Keep them in the canonical request below and mirror the same
  // source-level validation here for compatibility-shaped namespaces.
  const modelPolicy = raw.model_policy;
  if (modelPolicy !== undefined) {
    if (!modelPolicy || typeof modelPolicy !== 'object' || Array.isArray(modelPolicy)) {
      add('config.model_policy', 'model', modelPolicy);
    } else {
      add('config.model_policy.runtime', 'runtime', modelPolicy.runtime);
      const values = modelPolicy.models;
      if (values !== undefined) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          add('config.model_policy.models', 'model', values);
        } else {
          add(`config.model_policy.models.${role}`, 'model', values[role]);
        }
      }
    }
  }
  if (runtime === 'codex') {
    for (const [source, values] of [
      ['model_policy.runtime_tiers.codex', raw.model_policy?.runtime_tiers?.codex],
      ['model_profile_overrides.codex', raw.model_profile_overrides?.codex],
    ]) {
      if (values === undefined) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        addSelection(`config.${source}`, { model: values });
        continue;
      }
      const alias = { luna: 'sonnet', astra: 'opus' }[modelKey];
      for (const tier of new Set([modelKey, alias].filter(Boolean))) {
        if (Object.prototype.hasOwnProperty.call(values, tier)) {
          addSelection(`config.${source}.${tier}`, codexRemapSelection(values[tier]));
        }
      }
    }
  }
  for (const [prefix, cfg] of [['config', raw], ...['pipeline', 'delivery_pipeline', 'gsd']
    .filter((key) => raw[key]).map((key) => [key, raw[key]])]) {
    const gsdNamespace = prefix === 'config' || prefix === 'gsd';
    const keys = new Set([role, ...(gsdNamespace ? GSD_ROLE_KEYS[role] || [] : [])]);
    for (const [key, field] of [['models', 'model'], ['effort', 'effort'], ['model_overrides', 'model']]) {
      const values = cfg[key];
      if (values === undefined) continue;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        add(`${prefix}.${key}`, field, values);
        continue;
      }
      for (const name of keys) {
        // gsd-tune's stage tiers are portable GSD preferences, not concrete
        // Shipyard selections (even when their spelling is a Claude alias).
        // Only this vocabulary at these stage keys is superseded by ADR-014;
        // role/agent keys, model_overrides and concrete stage IDs still validate.
        if (gsdNamespace && key === 'models' && isGsdStageTier(name, values[name])) continue;
        add(`${prefix}.${key}.${name}`, field, values[name]);
      }
      if (key === 'effort') {
        for (const name of keys) add(`${prefix}.effort.agent_overrides.${name}`, field, values.agent_overrides?.[name]);
        // Generic GSD tier defaults do not select a routed role's effort.
        // Preserve validation of unknown tiers/values and concrete overrides.
        for (const [tier, effort] of Object.entries(values.routing_tier_defaults || {})) {
          if (gsdNamespace && ['light', 'standard', 'heavy'].includes(tier)
              && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) continue;
          add(`${prefix}.effort.routing_tier_defaults.${tier}`, field, effort);
        }
      }
    }
    for (const field of ['model', 'reasoning_effort', 'inline', 'inherit', 'session_inherited']) {
      add(`${prefix}.${field}`, field, cfg[field]);
    }
    for (const field of ['override', 'overrides', 'selection']) {
      if (cfg[field] !== undefined) selections.push({ source: `${prefix}.${field}`, selection: cfg[field] });
    }
  }
  return selections;
}

function canonicalizeRuntimeAlias(request, selection) {
  if (request.runtime !== 'claude' || typeof selection.model !== 'string') return selection;
  const model = modelPolicy.CLAUDE_MODEL_ALIASES[selection.model];
  return model ? { ...selection, model } : selection;
}

function validateSelection(request, source, selection) {
  try {
    if (typeof selection === 'string') selection = { model: selection };
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw modelPolicy.policyError('CONFLICTING_OVERRIDE', 'selection must be an object or model string');
    }
    selection = canonicalizeRuntimeAlias(request, selection);
    for (const field of ['inline', 'inherit', 'session_inherited']) {
      if (selection[field] !== undefined && typeof selection[field] !== 'boolean') {
        throw modelPolicy.policyError('UNSUPPORTED_SELECTION', `${field} must be a boolean`);
      }
    }
    modelPolicy.resolveDispatch({ ...request, override: selection });
    // Check every alias independently: one matching model/effort must not hide
    // a contradictory requested/applied value in the same override object.
    for (const field of ['requested_model', 'applied_model', 'reasoning_effort', 'requested_effort', 'applied_effort']) {
      if (selection[field] !== undefined) {
        const key = field.endsWith('model') ? 'model' : 'effort';
        const value = key === 'model'
          ? canonicalizeRuntimeAlias(request, { model: selection[field] }).model
          : selection[field];
        modelPolicy.resolveDispatch({ ...request, override: { [key]: value } });
      }
    }
  } catch (error) {
    throw modelPolicy.policyError(error.code, `${source}: ${error.message}`, { ...error.details, source });
  }
}

const GSD_MODEL_PROFILES = new Set(['quality', 'balanced', 'budget', 'adaptive', 'inherit']);
const GSD_PROFILE_FOR_POLICY = Object.freeze({
  economy: 'budget',
  balanced: 'balanced',
  premium: 'quality',
});

function boundDispatchContext(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const context = LOADED_DISPATCH_CONTEXTS.get(cfg);
  if (!context) {
    // Copies retain routed intent but lose the loader's private binding. Never
    // interpret that loss of provenance as permission to use compatibility.
    if (cfg.routed === true || cfg.dispatch_context?.mode === 'routed' || cfg.dispatch_context?.routed === true) {
      throw modelPolicy.policyError(
        'INVALID_CONFIG',
        'config.dispatch_context lacks a loadConfig binding for routed intent; reload with routed: true',
        { source: 'config.dispatch_context' },
      );
    }
    return null;
  }
  if (cfg.dispatch_context !== context) {
    throw modelPolicy.policyError(
      'INVALID_CONFIG',
      'config.dispatch_context was replaced after loadConfig',
      { source: 'config.dispatch_context' },
    );
  }
  return context;
}

function routedConfig(cfg) {
  const context = boundDispatchContext(cfg);
  return Boolean(context && context.mode === 'routed' && context.routed === true);
}

function normalizedRoutedControls(cfg, context) {
  const normalized = context.normalized;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw modelPolicy.policyError(
      'INVALID_CONFIG',
      'config.dispatch_context.normalized is missing from the frozen routed context',
      { source: 'config.dispatch_context.normalized' },
    );
  }
  // `loadConfig` normalizes an unknown pipeline profile to `balanced` for
  // compatibility readers. Routed readers must retain the raw nested value so
  // an explicit typo cannot become indistinguishable from an omitted control.
  for (const [namespace, values] of [
    ['pipeline', context.configuration?.pipeline],
    ['delivery_pipeline', context.configuration?.delivery_pipeline],
    ['gsd', context.configuration?.gsd],
  ]) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [field, valid] of [
      ['fable', (value) => ['auto', 'off'].includes(value)],
      ['fable_window_tokens', (value) => value === modelPolicy.WINDOW_THRESHOLD_TOKENS],
    ]) {
      if (Object.prototype.hasOwnProperty.call(values, field) && !valid(values[field])) {
        const source = `${namespace}.${field}`;
        throw modelPolicy.policyError('UNSUPPORTED_SELECTION',
          `${source} ${JSON.stringify(values[field])} is not a canonical routed control`, { source });
      }
      if (field === 'fable' && Object.prototype.hasOwnProperty.call(values, field)
          && values[field] !== normalized.fable) {
        const source = `${namespace}.${field}`;
        throw modelPolicy.policyError(
          'CONFLICTING_OVERRIDE',
          `${source} selects "${values[field]}", but pipeline.fable requires "${normalized.fable}"`,
          { source, expected: normalized.fable, actual: values[field] },
        );
      }
    }
    if (!Object.prototype.hasOwnProperty.call(values, 'model_policy')) continue;
    const raw = values.model_policy;
    const profile = typeof raw === 'string' ? PROFILE_ALIASES[raw] || raw : null;
    if (!['economy', 'balanced', 'premium'].includes(profile)) {
      throw modelPolicy.policyError(
        'UNSUPPORTED_SELECTION',
        `${namespace}.model_policy ${JSON.stringify(raw)} is not a supported pipeline profile`,
        { source: `${namespace}.model_policy` },
      );
    }
    if (profile !== normalized.model_policy) {
      throw modelPolicy.policyError(
        'CONFLICTING_OVERRIDE',
        `${namespace}.model_policy selects "${profile}", but pipeline.model_policy requires "${normalized.model_policy}"`,
        { source: `${namespace}.model_policy`, expected: normalized.model_policy, actual: profile },
      );
    }
  }
  for (const [field, source] of [
    ['fable', 'pipeline.fable'],
    ['fable_window_tokens', 'pipeline.fable_window_tokens'],
    ['model_policy', 'pipeline.model_policy'],
  ]) {
    if (cfg[field] !== normalized[field]) {
      throw modelPolicy.policyError(
        'INVALID_CONFIG',
        `${source} changed after the routed configuration was loaded`,
        { source },
      );
    }
  }
  if (!['auto', 'off'].includes(normalized.fable)) {
    throw modelPolicy.policyError(
      'INVALID_CONFIG',
      `pipeline.fable "${normalized.fable}" is not a normalized consent value`,
      { source: 'pipeline.fable' },
    );
  }
  if (!Number.isInteger(normalized.fable_window_tokens) || normalized.fable_window_tokens <= 0) {
    throw modelPolicy.policyError(
      'INVALID_CONFIG',
      'pipeline.fable_window_tokens is not a normalized positive integer',
      { source: 'pipeline.fable_window_tokens' },
    );
  }
  // ADR-014 fingerprints the threshold. The canonical resolver has no mutable
  // per-dispatch threshold input, so a different normalized value must refuse
  // instead of silently routing on the policy constant.
  if (normalized.fable_window_tokens !== modelPolicy.WINDOW_THRESHOLD_TOKENS) {
    throw modelPolicy.policyError(
      'UNSUPPORTED_SELECTION',
      `pipeline.fable_window_tokens is ${normalized.fable_window_tokens}, but the canonical resolver is fixed at ${modelPolicy.WINDOW_THRESHOLD_TOKENS}`,
      { source: 'pipeline.fable_window_tokens', expected: modelPolicy.WINDOW_THRESHOLD_TOKENS, actual: normalized.fable_window_tokens },
    );
  }
  return {
    fable: normalized.fable,
    fable_window_tokens: normalized.fable_window_tokens,
    model_policy: normalized.model_policy,
  };
}

function validateModelProfile(context, modelPolicyConfig, cfg, input) {
  const configuration = context.configuration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw modelPolicy.policyError('INVALID_CONFIG', 'config.dispatch_context.configuration is missing', {
      source: 'config.dispatch_context.configuration',
    });
  }
  const hasProfile = Object.prototype.hasOwnProperty.call(configuration, 'model_profile');
  // GSD's project profile default is balanced. Treating an omitted field as that
  // fixed default keeps the routed bridge deterministic while still refusing an
  // explicit inherited/unknown profile that could select another ladder.
  const profiles = [['config.model_profile', hasProfile ? configuration.model_profile : 'balanced']];
  for (const [source, object] of [['input', input], ['config', cfg],
    ['pipeline', configuration.pipeline], ['delivery_pipeline', configuration.delivery_pipeline],
    ['gsd', configuration.gsd], ['config.gsd', cfg.gsd]]) {
    if (object && Object.prototype.hasOwnProperty.call(object, 'model_profile')) {
      profiles.push([`${source}.model_profile`, object.model_profile]);
    }
  }
  const expected = GSD_PROFILE_FOR_POLICY[modelPolicyConfig.model_policy] || 'balanced';
  for (const [source, profile] of profiles) {
    if (!GSD_MODEL_PROFILES.has(profile)) {
      throw modelPolicy.policyError(
        'UNSUPPORTED_SELECTION',
        `${source} ${JSON.stringify(profile)} is not a supported GSD profile`,
        { source },
      );
    }
    if (profile !== expected) {
      throw modelPolicy.policyError(
        'CONFLICTING_OVERRIDE',
        `${source} selects "${profile}", but pipeline.model_policy requires "${expected}"`,
        { source, expected, actual: profile },
      );
    }
  }
}

// Public configuration bridge. Pass {root, runtime, role, signals, dispatch_id}
// or a config returned by loadConfig. Never call a compatibility tier reader to
// supply a missing model/effort. Receipt-backed repair escalation stays private
// to dispatch-boundary.cjs; this reader cannot manufacture receipt authority.
function resolveDispatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw modelPolicy.policyError('INVALID_INPUT', 'dispatch input must be an object', { source: 'input' });
  }
  const cfg = input.config === undefined
    ? loadConfig(input.root, { ...input, routed: true }).config : input.config;
  const context = boundDispatchContext(cfg);
  if (!context) throw modelPolicy.policyError('INVALID_CONFIG', 'config must come from loadConfig', { source: 'config' });
  if (!routedConfig(cfg)) {
    throw modelPolicy.policyError(
      'UNSUPPORTED_SELECTION',
      'config is compatibility-only; routed callers must load with routed: true',
      { source: 'config.dispatch_context.mode' },
    );
  }
  if (context.error) throw modelPolicy.policyError(context.error.code, context.error.message, context.error.details);
  const controls = normalizedRoutedControls(cfg, context);
  const runtime = context.runtime;
  for (const [source, identity] of [['config', cfg], ['config.dispatch_context.runtime', runtime]]) {
    for (const [field, expected] of [['policy_version', modelPolicy.POLICY_VERSION], ['policy_hash', modelPolicy.POLICY_HASH]]) {
      if (identity?.[field] !== expected) {
        const location = `${source}.${field}`;
        throw modelPolicy.policyError('INVALID_CONFIG', `${location} has a missing or stale policy fingerprint`, { source: location });
      }
    }
  }
  const identity = resolveRuntime(null, {
    runtime: input.runtime !== undefined ? input.runtime : runtime.runtime,
    runtimeMarker: runtime.runtime,
    env: {},
    routed: true,
    ...(input.dispatch_id !== undefined
      ? { dispatch_id: input.dispatch_id }
      : runtime.dispatch_id !== undefined ? { dispatch_id: runtime.dispatch_id } : {}),
  });
  if (input.dispatch_id !== undefined && runtime.dispatch_id !== undefined
      && identity.dispatch_id !== runtime.dispatch_id) {
    throw modelPolicy.policyError('CONFLICTING_OVERRIDE', 'input.dispatch_id conflicts with runtime context', { source: 'input.dispatch_id' });
  }
  validateModelProfile(context, controls, cfg, input);
  if (runtime.runtime === 'codex') {
    for (const [source, object] of [['input', input], ['config', context.configuration],
      ['pipeline', context.configuration.pipeline], ['delivery_pipeline', context.configuration.delivery_pipeline],
      ['gsd', context.configuration.gsd]]) {
      if (object && Object.prototype.hasOwnProperty.call(object, 'codex_models')) {
        throw modelPolicy.policyError('UNSUPPORTED_SELECTION',
          `${source}.codex_models is compatibility-only; routed dispatch uses the canonical grid`,
          { source: `${source}.codex_models` });
      }
    }
    if (JSON.stringify(cfg.codex_models) !== JSON.stringify(DEFAULT_CODEX_MODELS)) {
      throw modelPolicy.policyError('UNSUPPORTED_SELECTION',
        'config.codex_models changed from the compatibility default', { source: 'config.codex_models' });
    }
  }
  const canonicalConfig = {
    ...context.configuration,
    // Carry the normalized controls on the request even though the current
    // canonical policy only consumes its fixed threshold. The post-resolution
    // gate below refuses any fable result that the consent cannot authorize.
    fable: controls.fable,
    fable_window_tokens: controls.fable_window_tokens,
    pipeline: {
      ...(context.configuration.pipeline && typeof context.configuration.pipeline === 'object'
        && !Array.isArray(context.configuration.pipeline) ? context.configuration.pipeline : {}),
      fable: controls.fable,
      fable_window_tokens: controls.fable_window_tokens,
    },
  };
  // `research` is both a GSD stage and a Shipyard role. Remove only recognized
  // stage tiers from the canonical input, retaining the frozen raw configuration
  // for source validation; concrete IDs and pipeline.models remain untouched.
  if (canonicalConfig.models && typeof canonicalConfig.models === 'object'
      && !Array.isArray(canonicalConfig.models)) {
    canonicalConfig.models = Object.fromEntries(Object.entries(canonicalConfig.models)
      .filter(([name, value]) => !isGsdStageTier(name, value)));
  }
  const request = { ...input, config: canonicalConfig, runtime: runtime.runtime };
  if (identity.dispatch_id !== undefined) request.dispatch_id = identity.dispatch_id;
  const resolution = modelPolicy.resolveDispatch(request);
  if (resolution.model === 'fable' && controls.fable !== 'auto') {
    throw modelPolicy.policyError(
      'CONFLICTING_OVERRIDE',
      `pipeline.fable is "${controls.fable}", so the canonical fable selection is not consented`,
      { source: 'pipeline.fable', expected: 'auto', actual: controls.fable },
    );
  }
  const selections = configurationSelections(context.configuration, resolution.role, runtime.runtime, resolution.model_key);
  if (cfg.gsd?.runtime !== runtime.runtime) {
    throw modelPolicy.policyError('CONFLICTING_OVERRIDE', 'config.gsd.runtime conflicts with runtime context', { source: 'config.gsd.runtime' });
  }
  // Also validate current parsed values, so edits made after loadConfig cannot
  // bypass checks against the original configuration.
  selections.push(...configurationSelections({ pipeline: cfg }, resolution.role, runtime.runtime, resolution.model_key));
  for (const field of ['inline', 'inherit', 'session_inherited']) {
    if (input[field] !== undefined) selections.push({ source: `input.${field}`, selection: { [field]: input[field] } });
  }
  for (const field of ['inlineOverride', 'session', 'sessionOverride', 'inherited',
    'override', 'overrides', 'selection', 'launch_arguments', 'gsdOverride', 'perRoleOverride', 'configOverride']) {
    if (input[field] !== undefined) selections.push({ source: `input.${field}`, selection: input[field] });
  }
  for (const { source, selection } of selections) {
    validateSelection(request, source, selection);
  }
  return resolution;
}

// JSON dispatch is an input boundary, so an unknown top-level field must not be
// mistaken for an omitted signal or override. Keep this allowlist aligned with
// the fields the bridge and canonical resolver inspect; nested signals retain
// their own canonical validation.
const DISPATCH_INPUT_KEYS = new Set([
  'root', 'runtime', 'role', 'signals', 'dispatch_id', 'dispatchId', 'config',
  'model_profile', 'model', 'requested_model', 'applied_model',
  'effort', 'requested_effort', 'applied_effort', 'reasoning_effort',
  'backend', 'mechanism', 'agent_file', 'logical_model', 'logical_rung', 'rung', 'rung_index',
  'override', 'overrides', 'selection', 'launch_arguments',
  'gsdOverride', 'perRoleOverride', 'configOverride',
  'inline', 'inherit', 'session_inherited',
  'inlineOverride', 'session', 'sessionOverride', 'inherited',
]);

function validateJsonDispatchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw modelPolicy.policyError('INVALID_INPUT', 'dispatch input must be an object', { source: 'input' });
  }
  const unknown = Object.keys(input).filter((key) => !DISPATCH_INPUT_KEYS.has(key));
  if (unknown.length) {
    throw modelPolicy.policyError(
      'INVALID_INPUT',
      `dispatch input has unsupported top-level field(s): ${unknown.join(', ')}`,
      { source: 'input', fields: unknown },
    );
  }
  return input;
}

function requireCompatibility(cfg, source) {
  if (routedConfig(cfg)) {
    throw modelPolicy.policyError('UNSUPPORTED_SELECTION',
      `${source} is compatibility-only; routed callers must use resolveDispatch`, { source });
  }
}

function resolveTaskLevel(role, signals = {}, cfg = DEFAULTS) {
  return taskLevelRoute(role, signals, cfg).value;
}

module.exports = {
  resolveIntegrationBranch, architectureTarget,
  resolveDispatch, COMPATIBILITY_ROLES, ROUTED_ROLES,
  loadConfig, resolveTaskLevel, repoValue,
  parseCodexModelEntry, normalizeCodexModels,
  normalizeJiraTransitions, TICKET_STATUSES, normalizePrTitleFormat,
  DEFAULTS, EFFORTS, ROLES, REPAIR_ROLES,
  TASK_LEVELS, TASK_LEVEL_RANK, LADDER_MODES, taskLevelRoute,
  DEFAULT_CODEX_MODELS, NUMERIC_KNOBS,
  defaultRepositoryRoot, repositoryRootValue, validateRepositoryDestination,
  normalizeJiraTodoStatuses,
};

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'dispatch') {
    try {
      if (rest.length > 1) throw new Error('dispatch accepts one JSON argument and no trailing arguments');
      const input = validateJsonDispatchInput(JSON.parse(rest.length === 1 ? rest[0] : fs.readFileSync(0, 'utf8')));
      process.stdout.write(JSON.stringify(resolveDispatch(input)) + '\n');
    } catch (error) {
      process.stderr.write(`pipeline-config: ${error.code || 'INVALID_INPUT'}: ${error.message}\n`);
      process.exitCode = 1;
    }
  } else if (cmd === 'resolve' || cmd === undefined) {
    const runtimeIndex = rest.indexOf('--runtime');
    const { config, warnings, file, exists, valid, error } = loadConfig(
      process.cwd(),
      runtimeIndex === -1 ? {} : { runtime: rest[runtimeIndex + 1] },
    );
    process.stdout.write(JSON.stringify({
      config,
      warnings,
      valid,
      error,
      config_file: exists ? path.relative(process.cwd(), file) : null,
    }, null, 2) + '\n');
  } else {
    process.stderr.write('usage: pipeline-config.cjs <resolve [--runtime claude|codex] | dispatch <json>>\n');
    process.exit(2);
  }
}
