#!/usr/bin/env node
'use strict';

// Single deterministic reader for the conveyor's `.planning/config.json` →
// `pipeline` block, plus the role × risk × attempt model policy.
//
// Before this module the policy lived only as prose inside the skills, so it was
// unenforceable and drifted (it named model IDs the Agent tool does not accept).
// Now the skills ASK for a model instead of reasoning one out:
//
//   node pipeline-config.cjs resolve                      # effective config, JSON
//   node pipeline-config.cjs model <role> [flags]         # one tier alias
//
//   flags: --risk low|medium|high  --type <plan type>  --files <n>
//          --attempt <n>  --checkpoint  --code-change  --previous-failed
//
// The ONLY model values emitted are the tier aliases the Agent tool accepts:
// `opus`, `sonnet`, `haiku`. Full model IDs are deliberately never produced —
// those belong to GSD's own `model_overrides`, which GSD resolves itself.

const fs = require('fs');
const path = require('path');

const TIERS = ['opus', 'sonnet', 'haiku'];

const DEFAULTS = {
  integration_mode: 'epic-stacked',   // | direct-to-main
  model_policy: 'balanced',           // economy | balanced | premium
  use_workflow: 'auto',               // auto | false
  max_attempts: 5,                    // babysit rounds per PR
  pr_fetch_limit: 1000,               // `gh pr list --limit`
  stale_merge_hours: 4,
  stale_draft_hours: 24,
  worktree_root: null,                // null → <repo>/../.wt-<repo-name>
  models: {},                         // per-role override → tier alias
  jira: { enabled: true, project: null, issue_type: 'Task', epic_issue_type: 'Epic' },
};

const KNOWN_KEYS = new Set([...Object.keys(DEFAULTS)]);
const KNOWN_JIRA_KEYS = new Set(['enabled', 'project', 'issue_type', 'epic_issue_type']);
const ROLES = ['integrator', 'arch-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research'];

// Judgment roles are never cheapened: there is no mechanical safety net above
// them, so a false verdict is the most expensive kind of error in the pipeline.
const JUDGMENT_ROLES = new Set(['integrator', 'arch-review']);

function configPath(root) {
  return path.join(root || process.cwd(), '.planning', 'config.json');
}

function loadConfig(root) {
  const file = configPath(root);
  const warnings = [];
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      warnings.push(`${path.relative(root || process.cwd(), file)} is not valid JSON (${e.message}) — using defaults`);
      raw = {};
    }
  }
  const pipeline = (raw && typeof raw.pipeline === 'object' && raw.pipeline) || {};

  const cfg = { ...DEFAULTS, jira: { ...DEFAULTS.jira }, models: {} };
  for (const [key, value] of Object.entries(pipeline)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown pipeline config key "${key}" — ignored (known: ${[...KNOWN_KEYS].sort().join(', ')})`);
      continue;
    }
    if (key === 'jira') {
      if (value && typeof value === 'object') {
        for (const [jk, jv] of Object.entries(value)) {
          if (!KNOWN_JIRA_KEYS.has(jk)) {
            warnings.push(`unknown pipeline.jira key "${jk}" — ignored`);
            continue;
          }
          cfg.jira[jk] = jv;
        }
      }
      continue;
    }
    if (key === 'models') {
      if (value && typeof value === 'object') {
        for (const [role, tier] of Object.entries(value)) {
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
      }
      continue;
    }
    cfg[key] = value;
  }

  if (!['epic-stacked', 'direct-to-main'].includes(cfg.integration_mode)) {
    warnings.push(`pipeline.integration_mode "${cfg.integration_mode}" is unknown — falling back to epic-stacked`);
    cfg.integration_mode = 'epic-stacked';
  }
  if (!['economy', 'balanced', 'premium'].includes(cfg.model_policy)) {
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

  return { config: cfg, warnings, file, exists: fs.existsSync(file) };
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

module.exports = { loadConfig, resolveModel, DEFAULTS, TIERS, ROLES };

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
    process.stdout.write(resolveModel(role, signals, config) + '\n');
    process.exit(0);
  }

  process.stderr.write('usage: pipeline-config.cjs <resolve|model <role> [flags]>\n');
  process.exit(2);
}
