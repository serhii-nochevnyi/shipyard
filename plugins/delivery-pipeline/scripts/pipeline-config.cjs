#!/usr/bin/env node
'use strict';

// Single deterministic reader for the conveyor's configuration, plus the
// role × risk × attempt model policy and the matching reasoning effort.
//
// Before this module the policy lived only as prose inside the skills, so it was
// unenforceable and drifted (it named model IDs the Agent tool does not accept).
// Now the skills ASK for a model instead of reasoning one out:
//
//   node pipeline-config.cjs resolve                      # effective config, JSON
//   node pipeline-config.cjs model <role> [flags]         # one tier alias
//   node pipeline-config.cjs model <role> --json [flags]  # {model, effort}
//
//   flags: --risk low|medium|high  --type <plan type>  --files <n>
//          --attempt <n>  --checkpoint  --code-change  --previous-failed
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
// Codex-only and clamps to `low`, and `max`, which is Anthropic-only.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_TIER_DEFAULTS = { light: 'low', standard: 'high', heavy: 'xhigh' };
// Roles whose work is mechanical reconciliation: they stay cheap on effort even
// when the model tier is raised by an override.
const MECHANICAL_ROLES = new Set(['drift-check']);

const DEFAULTS = {
  integration_mode: 'epic-stacked',   // | direct-to-main
  model_policy: 'balanced',           // economy | balanced | premium
  use_workflow: 'auto',               // auto | false
  max_attempts: 5,                    // babysit rounds per PR
  pr_fetch_limit: 1000,               // `gh pr list --limit`
  stale_merge_hours: 4,
  stale_draft_hours: 24,
  worktree_root: null,                // null → <repo>/../.wt-<repo-name>
  graph_gate: true,                   // mirrors the capability's declared key
  models: {},                         // per-role override → tier alias
  effort: {},                         // per-role override → effort level
  jira: { enabled: true, project: null, issue_type: 'Task', epic_issue_type: 'Epic' },
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_JIRA_KEYS = new Set(['enabled', 'project', 'issue_type', 'epic_issue_type']);
const ROLES = ['integrator', 'arch-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research'];

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

  const cfg = { ...DEFAULTS, jira: { ...DEFAULTS.jira }, models: {}, effort: {} };
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
  for (const numeric of ['max_attempts', 'pr_fetch_limit', 'stale_merge_hours', 'stale_draft_hours']) {
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
  cfg.gsd = {
    runtime: typeof raw.runtime === 'string' ? raw.runtime : null,
    base_branch: typeof git.base_branch === 'string' && git.base_branch ? git.base_branch : null,
    branching_strategy: typeof git.branching_strategy === 'string' ? git.branching_strategy : null,
    response_language: typeof raw.response_language === 'string' ? raw.response_language : null,
  };
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

// role × risk × attempt routing. Returns a tier alias the Agent tool accepts.
function resolveModel(role, signals = {}, cfg = DEFAULTS) {
  const override = cfg.models && cfg.models[role];
  if (override) return override;

  const profile = cfg.model_policy || 'balanced';
  if (JUDGMENT_ROLES.has(role)) return 'opus'; // top tier under EVERY profile

  const risk = signals.risk || 'medium';
  const attempt = Number(signals.attempt) || 1;

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
      // cheap first strike, escalate on an actual failure
      return attempt >= 2 || signals.previousFailed ? 'opus' : 'sonnet';
    case 'review-fix':
      return signals.codeChange === false ? 'sonnet' : 'opus';
    case 'drift-check':
      return 'sonnet';
    case 'research':
      return signals.type === 'alternatives' ? 'opus' : 'sonnet';
    default:
      return 'opus';
  }
}

// Reasoning effort, mirroring GSD's light/standard/heavy tier defaults. Effort
// follows the RESOLVED model, so escalating a repair to the top tier raises its
// effort too — except for mechanical roles, which stay cheap either way.
function resolveEffort(role, model, cfg = DEFAULTS) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  const clamp = (level) => {
    // `minimal` is Codex-only in GSD and is not in Workflow's enum at all.
    if (level === 'minimal') return 'low';
    // `max` is Anthropic-only; GSD clamps it to xhigh on Codex.
    if (level === 'max' && runtime === 'codex') return 'xhigh';
    return EFFORTS.includes(level) ? level : 'high';
  };
  const override = cfg.effort && cfg.effort[role];
  if (override) return clamp(override);
  const tier = MECHANICAL_ROLES.has(role)
    ? 'light'
    : TOP_TIERS.has(model) ? 'heavy' : model === 'haiku' ? 'light' : 'standard';
  return clamp(EFFORT_TIER_DEFAULTS[tier]);
}

module.exports = { loadConfig, resolveModel, resolveEffort, DEFAULTS, TIERS, EFFORTS, ROLES };

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
    const signals = {
      risk: flag('risk'),
      type: flag('type'),
      files: flag('files'),
      attempt: flag('attempt'),
      checkpoint: rest.includes('--checkpoint'),
      previousFailed: rest.includes('--previous-failed'),
      codeChange: rest.includes('--no-code-change') ? false : undefined,
    };
    for (const w of warnings) process.stderr.write(`pipeline-config: warning: ${w}\n`);
    const model = resolveModel(role, signals, config);
    if (rest.includes('--json')) {
      process.stdout.write(JSON.stringify({ model, effort: resolveEffort(role, model, config) }) + '\n');
    } else {
      process.stdout.write(model + '\n');
    }
    process.exit(0);
  }

  process.stderr.write('usage: pipeline-config.cjs <resolve|model <role> [--json] [flags]>\n');
  process.exit(2);
}
