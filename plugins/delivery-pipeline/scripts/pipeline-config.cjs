#!/usr/bin/env node
'use strict';

// Single deterministic reader for the conveyor's configuration, plus the
// role × risk model policy, the matching reasoning effort, and the repair
// STRATEGY a failure signature's history implies.
//
// Before this module the policy lived only as prose inside the skills, so it was
// unenforceable and drifted (it named model IDs the Agent tool does not accept).
// Now the skills ASK for a model instead of reasoning one out:
//
//   node pipeline-config.cjs resolve                      # effective config, JSON
//   node pipeline-config.cjs model <role> [flags]         # one tier alias
//   node pipeline-config.cjs model <role> --json [flags]  # {model, effort}
//                                                        # + strategy, with --signature-state
//
//   flags: --risk low|medium|high  --type <plan type>  --files <n>
//          --checkpoint  --code-change|--no-code-change
//          --signature-state first|progress|repeat|flake_candidate|flake|plan_defect
//          --attempt <n>  --previous-failed   ← accepted, but INERT (see below)
//
// REPAIRS ESCALATE BY STRATEGY, NOT BY TIER (ADR-001 D1). The repair roles
// (ci-fix, review-fix, pr-sentinel) used to read `attempt >= 2 → opus`, which is
// "try harder": the observed loss is one wrong hypothesis re-tried by three
// models in sequence. Their tier is now role × risk alone, and the failure
// SIGNATURE's history — computed by failure-signature.cjs, passed in as
// `--signature-state` — decides what to do differently, plus how deep to think
// at the same tier. `--attempt` and `--previous-failed` remain accepted for the
// callers and docs that still pass them (and the attempt counter remains as
// telemetry), but they no longer route anything.
//
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

// The Agent tool validates `model` against exactly these aliases.
// `fable` is Claude Fable 5: Opus-tier, 1M-token context, adaptive thinking at
// xhigh effort. It is the only alias that expresses "top tier WITH a 1M window"
// — which is what this repo's long-broken `opus[1m]` was reaching for. It is a
// paid model, so it is opt-in via `models`, never a default.
const TIERS = ['opus', 'sonnet', 'haiku', 'fable'];
const TOP_TIERS = new Set(['opus', 'fable']);

// Workflow's agent() accepts these; GSD's ladder also has `minimal`, which is
// Codex-only and clamps to `low`. `ultra` is deliberately NOT here: it is
// advertised by one Codex model that no built-in path selects (ADR-005 D6/D7).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_TIER_DEFAULTS = { light: 'low', standard: 'high', heavy: 'xhigh' };
// Roles whose work is mechanical reconciliation: they stay cheap on effort even
// when the model tier is raised by an override.
const MECHANICAL_ROLES = new Set(['drift-check']);

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
// `gpt-5.6-sol` is deliberately absent: with `xhigh`/`max` retired on that
// runtime its only distinguishing property (advertising `ultra`) buys nothing, so
// no built-in path selects it. It stays a value a person may configure — see the
// capability's declared default, which mirrors this list.
const DEFAULT_CODEX_MODELS = [
  { model: 'gpt-5.6-terra', effort: 'high' },
  { model: 'gpt-6-astra', effort: 'high', min_cli: '0.153.1' },
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

// What a signature's history means for the NEXT move. The keys are
// failure-signature.cjs's verdict enum verbatim — it is the contract between the
// two files, so a synonym or a seventh word here is a silent no-op there (the
// unit test asserts the two lists are identical). Not imported: this reader must
// stay free of the journal/lock chain, since every skill loads it.
//
// The values are pinned strings the babysit loop switches on. The last three
// mean "do not dispatch a fixer at all".
const STRATEGIES = {
  first: 'fix',
  progress: 'continue',
  // Hold the tier, change the approach: re-read the plan, widen the context,
  // raise the hypothesis above the symptom.
  repeat: 'rethink',
  flake_candidate: 'rerun',
  flake: 'quarantine',
  plan_defect: 'park',
};
const SIGNATURE_STATES = Object.keys(STRATEGIES);

// Own-property only: `strategyFor('toString')` must be unknown, not a function.
function strategyFor(state) {
  return Object.prototype.hasOwnProperty.call(STRATEGIES, state) ? STRATEGIES[state] : undefined;
}

const DEFAULTS = {
  integration_mode: 'epic-stacked',   // | direct-to-main
  model_policy: 'balanced',           // economy | balanced | premium
  use_workflow: 'auto',               // auto | false
  // The PR sentinel: who drives open PRs to green and lands them in the stack
  // while the main loop cascades onward.
  //   sentinel:   auto (background guard when the runtime has one, otherwise a
  //               mandatory duty pass every round) | off (main loop only)
  //   auto_merge: epic — the sentinel squashes a green+conform ticket PR into
  //               its base (phase epic or parent ticket branch). The epic →
  //               integration-branch PR is NEVER auto-merged; that stays human.
  //               off — every merge is a human's, the pre-sentinel behaviour.
  sentinel: 'auto',                   // auto | off
  auto_merge: 'epic',                 // epic | off
  // A PR with NO reported checks is not a green PR — nothing ran. Both the board
  // (front.cjs) and the guard (sentinel.cjs) therefore withhold the two actions
  // that walk such a PR towards landing, and this is the project's way to say
  // "there is no CI here, that absence is expected". Opt-in only, and it fails
  // towards the human: see the coercion below.
  merge_without_ci: false,
  max_attempts: 5,                    // babysit rounds per PR (the backstop, not the ladder's input)
  // K of the k-distinct rule: this many DIFFERENT failure signatures with no
  // green means the ticket is wrong, not the fix (ADR-001 D2). Same default as
  // `failure-signature.cjs verdict --k`, and the two must agree.
  plan_defect_signatures: 3,
  pr_fetch_limit: 1000,               // `gh pr list --limit`
  stale_merge_hours: 4,
  stale_draft_hours: 24,
  worktree_root: null,                // null → <repo>/../.wt-<repo-name>
  graph_gate: true,                   // mirrors the capability's declared key
  models: {},                         // per-role override → tier alias
  effort: {},                         // per-role override → effort level
  // The Codex model palette, in preference order (see DEFAULT_CODEX_MODELS).
  // Mirrors the capability's declared `delivery_pipeline.codex_models`.
  codex_models: DEFAULT_CODEX_MODELS,
  // Sibling repositories the graph delivers into ("owner/name" → absolute local
  // checkout path). Tracking a foreign repo needs nothing but `delivery.repo` on
  // the ticket; EXECUTING there needs a local checkout, because worktrees,
  // commits and pushes are local git operations.
  repos: {},
  jira: { enabled: true, project: null, issue_type: 'Task', epic_issue_type: 'Epic' },
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_JIRA_KEYS = new Set(['enabled', 'project', 'issue_type', 'epic_issue_type']);
const ROLES = ['integrator', 'arch-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research', 'pr-sentinel'];

// Judgment roles are never cheapened: there is no mechanical safety net above
// them, so a false verdict is the most expensive kind of error in the pipeline.
const JUDGMENT_ROLES = new Set(['integrator', 'arch-review']);

// GSD's own model_profile vocabulary, accepted as an alias for ours so a user who
// knows GSD does not get a "not one of economy|balanced|premium" warning.
const PROFILE_ALIASES = { budget: 'economy', quality: 'premium', adaptive: 'balanced', inherit: 'balanced' };

function configPath(root) {
  return path.join(root || process.cwd(), '.planning', 'config.json');
}

function loadConfig(root) {
  const base = root || process.cwd();
  const file = configPath(base);
  const warnings = [];
  let raw = {};
  const exists = fs.existsSync(file);
  if (exists) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      warnings.push(`${path.relative(base, file)} is not valid JSON (${e.message}) — using defaults`);
      raw = {};
    }
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  // delivery_pipeline.* (the capability's declared, GSD-native namespace) wins
  // over pipeline.* for any key present in both.
  const merged = { ...obj(raw.pipeline), ...obj(raw.delivery_pipeline) };

  // GSD's own `sub_repos` (both the flat and the nested shape it accepts). It is
  // the declared way to say "this nested checkout belongs to my project", and
  // findProjectRoot honours it BEFORE its git-boundary guard — so it is the fix
  // we point at when a `pipeline.repos` path turns out to be nested.
  const subReposRaw = raw.sub_repos ?? obj(raw.planning).sub_repos;
  const subRepos = Array.isArray(subReposRaw) ? subReposRaw : [];

  // Every container value is copied, never shared with DEFAULTS: a caller that
  // sorts or filters the palette in place would otherwise change what the next
  // loadConfig() in the same process returns.
  const cfg = {
    ...DEFAULTS,
    jira: { ...DEFAULTS.jira },
    models: {},
    effort: {},
    repos: {},
    codex_models: DEFAULT_CODEX_MODELS.map((e) => ({ ...e })),
  };
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
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
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
        // A sibling checkout NESTED inside this project is the one layout where
        // GSD's project-root resolution changed under us: since gsd-core 1.9.1
        // (#2843) findProjectRoot refuses to cross a git-repo boundary, so any
        // GSD tooling run inside that nested repo no longer sees THIS project's
        // .planning/ — it resolves to the child repo, silently. GSD's own escape
        // hatch is `sub_repos`, which is checked before the boundary guard, so
        // declaring it there restores the crossing deliberately.
        const rel = path.relative(base, local);
        const nested = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (nested && !subRepos.includes(rel.split(path.sep)[0])) {
          warnings.push(
            `pipeline.repos."${slug}" = "${local}" is nested inside this project. Since gsd-core 1.9.1, ` +
            'GSD tooling run there resolves to that repo instead of this project (findProjectRoot no longer ' +
            `crosses a git-repo boundary). Either check it out outside the project, or add "${rel.split(path.sep)[0]}" ` +
            'to sub_repos in .planning/config.json so GSD keeps resolving here.'
          );
        }
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
        cfg.effort[role] = level;
      }
      continue;
    }
    cfg[key] = value;
  }

  // Enum-ish knobs: a misspelling here decides whether PRs get merged at all, so
  // it is reported rather than silently coerced to the safe value.
  if (cfg.auto_merge === true) cfg.auto_merge = 'epic';
  if (cfg.auto_merge === false) cfg.auto_merge = 'off';
  if (!['epic', 'off'].includes(cfg.auto_merge)) {
    warnings.push(`pipeline.auto_merge "${cfg.auto_merge}" is unknown — falling back to off (values: epic | off)`);
    cfg.auto_merge = 'off';
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
  for (const numeric of ['max_attempts', 'pr_fetch_limit', 'stale_merge_hours', 'stale_draft_hours', 'plan_defect_signatures']) {
    const n = Number(cfg[numeric]);
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`pipeline.${numeric} must be a positive number — using ${DEFAULTS[numeric]}`);
      cfg[numeric] = DEFAULTS[numeric];
    } else {
      cfg[numeric] = n;
    }
  }
  cfg.use_workflow = cfg.use_workflow === false || cfg.use_workflow === 'false' ? false : 'auto';
  cfg.graph_gate = cfg.graph_gate !== false;

  // ── GSD's own settings the conveyor must agree with ───────────────────────
  const git = obj(raw.git);
  const workflow = obj(raw.workflow);
  cfg.gsd = {
    runtime: typeof raw.runtime === 'string' ? raw.runtime : null,
    base_branch: typeof git.base_branch === 'string' && git.base_branch ? git.base_branch : null,
    branching_strategy: typeof git.branching_strategy === 'string' ? git.branching_strategy : null,
    response_language: typeof raw.response_language === 'string' ? raw.response_language : null,
    use_worktrees: typeof workflow.use_worktrees === 'boolean' ? workflow.use_worktrees : null,
  };
  // Same collision as branching_strategy, one level down. GSD's writer workflows
  // fork their own git worktree when this is true — and the conveyor calls
  // `/gsd-code-review --fix` from INSIDE a ticket worktree, so the fixer would
  // nest a worktree within ours and commit the fix where no PR is watching.
  // GSD 1.9.1 made `--fix` honor this setting, which is what makes `false` the
  // correct value rather than a preference.
  // No warning: `true` is GSD's own default and is fine here. This used to warn,
  // on the belief that `/gsd-code-review --fix` — which the conveyor DOES call
  // from inside a ticket worktree — would fork a nested one. Checked against the
  // source (1.9.1): code-review never mentions worktrees, and `git worktree add`
  // lives only in execute-phase, new-workspace and worktree-safety.cjs, none of
  // which the conveyor invokes. The boundary that DOES matter is stated
  // elsewhere and is about wave parallelism, not this flag: no shipyard path may
  // call `execute-phase`, because two orchestrators creating worktrees for the
  // same plans would collide. Keep the check keyed to that, not to a setting.
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
          `runtime — it is silently skipped on runtime "${cfg.gsd.runtime}". Use the bare global form instead ` +
          '(e.g. "global:shipyard-delivery-rules", installed under the runtime\'s global skills dir).'
        );
      }
    }
  }

  return { config: cfg, warnings, file, exists };
}

// `fable` exists on the Claude runtime only. GSD's tier vocabulary is
// opus|sonnet|haiku, and the Codex agent files are rendered through that map, so
// asking for `fable` there produces a model nobody can resolve. Runtime-aware
// here rather than at every call site: the ladder is the one place that decides
// what "top tier" means.
//
// UNSET means opus, not fable — the asymmetry is deliberate. The two failures are
// not equal: on Claude, `opus` instead of `fable` costs a smaller context window
// on a job that usually fits anyway; on Codex, `fable` is a model id nothing can
// resolve. So the default is the one that degrades rather than the one that
// breaks, and the 1M tier is taken only where the runtime SAYS it is available.
// `gsd-tune.cjs` writes that declaration — it is in the REQUIRED group precisely
// because several behaviours, this one included, hang off it.
const RUNTIMES_WITH_1M_TIER = new Set(['claude']);
function topTier(cfg) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  return RUNTIMES_WITH_1M_TIER.has(runtime) ? 'fable' : 'opus';
}

// A tier alias means the same STRENGTH everywhere but not the same ECONOMICS.
// On Claude, `opus` is the ordinary choice for writing code. On Codex the top
// tier is a premium reasoning model, and GSD's own catalog shows what that is
// worth: of its 34 Codex agents, exactly TWO take the top model — `gsd-planner`
// and `gsd-eval-planner`. Its executor, code-fixer, code-reviewer, debugger and
// security-auditor are all on the workhorse tier. A straight tier-for-tier
// mapping put four of our seven roles on the premium model, which is not the same
// policy expressed on a different runtime — it is a more expensive one.
//
// So outside Claude the top model goes to NOBODY here, exactly as in GSD: the
// only agents it gives `sol` to are `gsd-planner` and `gsd-eval-planner`, and the
// conveyor has no planner among its roles — decomposition is done by the main
// loop, not by a role agent. Its reviewer, executor, fixer and debugger are all
// on the workhorse. GSD expresses depth through EFFORT at the same model —
// `gsd-debugger` and `gsd-security-auditor` are `gsd-executor`'s model at xhigh
// — and that is what this cap used to lean on. It no longer holds THERE:
// ADR-005 D6 measured that the deeper efforts buy nothing on that runtime, so
// the effort axis is two values wide (see RUNTIMES_WITH_FLAT_EFFORT) and depth
// comes back from the model, through a second agent FILE per escalating role
// (D8). The cap still stands, because what it decides is which tier the
// GENERATOR renders a palette entry for, and the palette's own ceiling is what
// the escalation reaches.
const RUNTIMES_WITH_PREMIUM_TOP_TIER = new Set(['codex']);

// Where the effort axis is flat: one cheap value for the mechanical role, one
// working value for everything else (ADR-005 D6). Not a limitation of the
// runtime — a measurement of it.
const RUNTIMES_WITH_FLAT_EFFORT = new Set(['codex']);
function capForRuntime(tier, cfg) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  if (!RUNTIMES_WITH_PREMIUM_TOP_TIER.has(runtime)) return tier;
  return TOP_TIERS.has(tier) ? 'sonnet' : tier;
}

// The ladder BEFORE the runtime cap — the strength this role deserves. Kept
// separate so the effort rule can see the escalation the cap swallowed.
function ladderTier(role, signals = {}, cfg = DEFAULTS) {
  const override = cfg.models && cfg.models[role];
  if (override) return override;

  const profile = cfg.model_policy || 'balanced';
  // The two judgment roles are never cheapened — top tier under EVERY profile —
  // and on a runtime that HAS a 1M-context tier they take it, because the window
  // is what actually distinguishes their work: arch-review reads the whole diff
  // against every ADR/INTERFACES/DATA-MODEL at once, and the integrator
  // reconciles across repositories. Everywhere else `fable` would only be a more
  // expensive `opus` — an executor on a three-file ticket gains nothing from it.
  // Elsewhere (Codex) there is no such tier: GSD's tier set is opus|sonnet|haiku,
  // so this must degrade to `opus` rather than emit a name the runtime rejects.
  if (JUDGMENT_ROLES.has(role)) return topTier(cfg);

  const risk = signals.risk || 'medium';

  if (profile === 'premium') return role === 'drift-check' ? 'sonnet' : 'opus';

  switch (role) {
    case 'executor': {
      if (risk === 'high' || signals.checkpoint) return 'opus';
      const light = risk === 'low' && (signals.type === 'research' || Number(signals.files) <= 2);
      if (light) return 'sonnet';
      if (risk === 'medium' && profile === 'economy') return 'sonnet'; // escalates via the babysit ladder
      return 'opus';
    }
    case 'ci-fix':
      // Role × risk, and nothing else. This used to read
      // `attempt >= 2 || previousFailed → opus`; ADR-001 D1 removed it, because
      // a bigger model on the same wrong hypothesis is the failure mode, not the
      // remedy. A repeat now changes strategy and effort (see resolveEffort).
      return risk === 'high' ? 'opus' : 'sonnet';
    case 'review-fix':
      return signals.codeChange === false ? 'sonnet' : 'opus';
    case 'pr-sentinel':
      // The guard judges bot feedback AND edits code, but its merge decision is
      // mechanical (sentinel.cjs enforces the gate), so it follows ci-fix's
      // ladder — including D1: the attempt count is gone, what is left is the
      // stakes of the PR in front of it.
      return risk === 'high' || signals.checkpoint ? 'opus' : 'sonnet';
    case 'drift-check':
      return 'sonnet';
    case 'research':
      return signals.type === 'alternatives' ? 'opus' : 'sonnet';
    default:
      return 'opus';
  }
}

// role × risk × attempt routing. Returns a tier alias the Agent tool accepts.
function resolveModel(role, signals = {}, cfg = DEFAULTS) {
  return capForRuntime(ladderTier(role, signals, cfg), cfg);
}

// Reasoning effort, mirroring GSD's light/standard/heavy tier defaults. Effort
// follows the RESOLVED model, so escalating a repair to the top tier raises its
// effort too — except for mechanical roles, which stay cheap either way.
//
// `signals` is optional and carries two things. First, the signature state: on a
// REPEAT the tier holds and the effort deepens (ADR-001 D1) — the model stays
// where it is and thinks harder about a different hypothesis, rather than the
// rejected "same hypothesis, bigger model". Second, the escalation the runtime
// cap swallowed: where the cap demoted the model, the escalation must not vanish
// with it. GSD does exactly this — `gsd-debugger` is its executor's model at a
// higher effort — so a capped repair runs the workhorse at heavy rather than the
// premium model at heavy.
//
// Both of those are the ladder on a runtime that HAS depth on this axis. Where
// the axis is flat (ADR-005 D6) neither applies and the answer is two-valued;
// that branch is first below, right after the explicit override.
function resolveEffort(role, model, cfg = DEFAULTS, signals = null) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  const clamp = (level) => {
    // `minimal` is Codex-only in GSD and is not in Workflow's enum at all.
    // There is deliberately no `max` → `xhigh` clamp for Codex any more: both
    // halves of its justification were false (ADR-005 D7). GSD's
    // `codexModelEffort._baseline` advertises `max` for every model, and
    // `advertisedCodexEffort` returns that baseline for any model it does not
    // name — which the palette's ceiling is. No built-in path asks for `max`
    // there, so the clamp only ever rewrote an operator's explicit choice.
    if (level === 'minimal') return 'low';
    return EFFORTS.includes(level) ? level : 'high';
  };
  const override = cfg.effort && cfg.effort[role];
  if (override) return clamp(override);
  // ADR-005 D6 — on THIS runtime the effort axis has two values, by measurement
  // rather than by limitation: `xhigh` and `max` cost more there without a
  // better result, and the ceiling model's best results are at `high`. So the
  // ladder below does not apply; depth comes from the MODEL instead, which is
  // what the `-deep` agents make reachable (D8). Placed after the override so an
  // explicit configuration still wins, and before the repeat rule because there
  // is no deeper rung here to escalate INTO — a repeat still changes strategy
  // (`rethink`), which is the half that survives.
  if (RUNTIMES_WITH_FLAT_EFFORT.has(runtime)) return MECHANICAL_ROLES.has(role) ? 'low' : 'high';
  // The same failure came back: hold the tier, deepen the thinking. Placed after
  // the override so an explicit configuration still wins, and before the tier
  // table because it outranks every signal below it. No mechanical-role guard is
  // needed — no repair role is mechanical, and drift-check is not a repair.
  if (signals && REPAIR_ROLES.has(role) && signals.signatureState === 'repeat') return clamp('xhigh');
  // On a capped runtime the model can no longer express depth, so effort has to —
  // the same way GSD does it. Two things earn heavy there:
  //   * judgment, which is heavy by its nature and not by its signals;
  //   * an ESCALATION — the ladder raised this role ABOVE its own baseline
  //     (a high-risk or checkpointed ticket, an economy-profile executor on a
  //     risky one, `alternatives` research). Comparing against the role's
  //     baseline rather than against "is it top tier" is what separates a repair
  //     on a high-risk ticket (heavy) from an executor whose baseline was top
  //     tier all along (standard) — on a capped runtime both arrive as the same
  //     alias and would otherwise be indistinguishable.
  const escalated = signals
    && ladderTier(role, signals, cfg) !== ladderTier(role, {}, cfg)
    && TOP_TIERS.has(ladderTier(role, signals, cfg));
  const tier = MECHANICAL_ROLES.has(role)
    ? 'light'
    : (JUDGMENT_ROLES.has(role) || TOP_TIERS.has(model) || escalated) ? 'heavy'
      : model === 'haiku' ? 'light' : 'standard';
  return clamp(EFFORT_TIER_DEFAULTS[tier]);
}

module.exports = {
  loadConfig, resolveModel, resolveEffort, strategyFor,
  parseCodexModelEntry, normalizeCodexModels,
  DEFAULTS, TIERS, EFFORTS, ROLES, REPAIR_ROLES, STRATEGIES, SIGNATURE_STATES,
  DEFAULT_CODEX_MODELS,
};

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const { config, warnings, file, exists } = loadConfig(process.cwd());

  if (cmd === 'resolve' || cmd === undefined) {
    process.stdout.write(JSON.stringify({
      config,
      warnings,
      config_file: exists ? path.relative(process.cwd(), file) : null,
    }, null, 2) + '\n');
    process.exit(0);
  }

  if (cmd === 'model') {
    const role = rest[0];
    if (!ROLES.includes(role)) {
      process.stderr.write(`pipeline-config: unknown role "${role}" (roles: ${ROLES.join(', ')})\n`);
      process.exit(2);
    }
    const flag = (name) => {
      const i = rest.indexOf(`--${name}`);
      return i === -1 ? undefined : rest[i + 1];
    };
    // An unknown value is ignored with a warning — the same posture as every
    // invalid config value in this file, and for a sharper reason here: a
    // resolver that exits non-zero at 3am stops the round it exists to keep
    // running.
    let signatureState;
    let signatureStateWarning = null;
    if (rest.includes('--signature-state')) {
      const value = flag('signature-state');
      if (SIGNATURE_STATES.includes(value)) {
        signatureState = value;
      } else {
        signatureStateWarning =
          `--signature-state "${value === undefined ? '' : value}" is not a signature state — ignored ` +
          `(${SIGNATURE_STATES.join('|')}; compute it with \`failure-signature.cjs verdict\`)`;
      }
    }
    const signals = {
      risk: flag('risk'),
      type: flag('type'),
      files: flag('files'),
      // Accepted, recorded, and INERT for the repair roles (ADR-001 D1). They
      // stay because deliver.md still documents them and telemetry still passes
      // them; passing one is not an error, so it does not warn.
      attempt: flag('attempt'),
      previousFailed: rest.includes('--previous-failed'),
      signatureState,
      checkpoint: rest.includes('--checkpoint'),
      codeChange: rest.includes('--no-code-change') ? false : undefined,
    };
    for (const w of warnings) process.stderr.write(`pipeline-config: warning: ${w}\n`);
    if (signatureStateWarning) process.stderr.write(`pipeline-config: warning: ${signatureStateWarning}\n`);
    const model = resolveModel(role, signals, config);
    if (rest.includes('--json')) {
      const out = { model, effort: resolveEffort(role, model, config, signals) };
      // `strategy` appears ONLY when a valid state was passed, so every existing
      // consumer keeps seeing exactly `{model, effort}`.
      if (signatureState) out.strategy = strategyFor(signatureState);
      process.stdout.write(JSON.stringify(out) + '\n');
    } else {
      process.stdout.write(model + '\n');
    }
    process.exit(0);
  }

  process.stderr.write(
    'usage: pipeline-config.cjs <resolve | model <role> [--json] [flags]>\n' +
    '  flags: --risk low|medium|high  --type <plan type>  --files <n>  --checkpoint\n' +
    '         --code-change|--no-code-change\n' +
    '         --signature-state ' + SIGNATURE_STATES.join('|') + '\n' +
    '         --attempt <n>  --previous-failed  (accepted, telemetry only: they no\n' +
    '           longer route the repair roles — a repeat changes strategy, not tier)\n'
  );
  process.exit(2);
}
