#!/usr/bin/env node
'use strict';

// Select the generated Codex agent file for one dispatch.
//
// Codex agent configuration is static, so the model ladder needs a small
// runtime selector at the point where the dispatch is prepared:
//
//   node codex-agent.cjs select <role> --json [--project-dir <project>] [signals]
//
// The selector returns the concrete file (for static roles), or model (for the
// main-loop executor), and effort that must be recorded with
// dispatch-record.cjs. It shares classification and route semantics with
// pipeline-config.cjs; it never invents a model id.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pc = require(path.join(__dirname, 'pipeline-config.cjs'));
const { createCodexRemapper } = require(path.join(__dirname, 'codex-model-remap.cjs'));

const ROLE_ALIASES = { 'inv-research': 'research' };
const AGENT_ROLE = (role) => ROLE_ALIASES[role] || role;
const DEEP_ROLES = new Set(['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']);
const CRITICAL_ROLES = new Set(['inv-research', 'arch-review', 'ci-fix', 'review-fix']);
const DEEP_SUFFIX = '-deep';
const CRITICAL_SUFFIX = '-critical';
const PREFIX = 'shipyard-';

function fail(message, code = 1) {
  const err = new Error(message);
  err.exitCode = code;
  throw err;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  const booleans = new Set(['contested', 'checkpoint', 'code-change', 'no-code-change', 'previous-failed', 'json']);
  const values = new Set([
    'agent-dir', 'project-dir', 'risk', 'type', 'input-tokens', 'files', 'attempt',
    'signature-state', 'task-level',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!booleans.has(name) && !values.has(name)) fail(`unknown option --${name}`, 2);
    if (booleans.has(name)) {
      if (flags.has(name)) fail(`--${name} given more than once`);
      flags.set(name, true);
      continue;
    }
    const value = argv[++i];
    if (value === undefined || String(value).startsWith('--')) fail(`--${name} needs a value`);
    if (flags.has(name)) fail(`--${name} given more than once`);
    flags.set(name, String(value));
  }
  return { flags, positionals };
}

function value(flags, name) {
  return flags.has(name) ? flags.get(name) : undefined;
}

function signalsFrom(flags) {
  let signatureState;
  const rawSignature = value(flags, 'signature-state');
  if (rawSignature !== undefined) {
    if (!pc.SIGNATURE_STATES.includes(rawSignature)) {
      fail(`"${rawSignature}" is not a signature state (states: ${pc.SIGNATURE_STATES.join(', ')})`, 2);
    }
    signatureState = rawSignature;
  }
  const requested = value(flags, 'task-level');
  let taskLevel;
  if (requested !== undefined) {
    if (!pc.TASK_LEVELS.includes(requested)) {
      fail(`"${requested}" is not a task level (levels: ${pc.TASK_LEVELS.join(', ')})`, 2);
    }
    taskLevel = requested;
  }
  const risk = value(flags, 'risk');
  if (risk !== undefined && !['low', 'medium', 'high'].includes(risk)) {
    fail(`"${risk}" is not a risk level (levels: low, medium, high)`, 2);
  }
  if (flags.has('code-change') && flags.has('no-code-change')) {
    fail('--code-change and --no-code-change cannot be used together', 2);
  }
  return {
    risk,
    type: value(flags, 'type'),
    inputTokens: value(flags, 'input-tokens'),
    files: value(flags, 'files'),
    contested: flags.has('contested'),
    checkpoint: flags.has('checkpoint'),
    codeChange: flags.has('code-change') ? true : flags.has('no-code-change') ? false : undefined,
    attempt: value(flags, 'attempt'),
    previousFailed: flags.has('previous-failed'),
    signatureState,
    taskLevel,
  };
}

function agentDirFrom(flags) {
  return path.resolve(expandHome(value(flags, 'agent-dir'))
    || process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'agents')
    || path.join(os.homedir(), '.codex', 'agents'));
}

// A Codex worktree normally has the generated agent files but not the
// project's .planning/config.json. Resolve policy from the conveyor project
// explicitly in that case; otherwise a selector run from the worktree would
// silently fall back to the conservative defaults and dispatch the wrong lane.
function projectDirFrom(flags) {
  const configured = value(flags, 'project-dir');
  return configured === undefined
    ? process.cwd()
    : path.resolve(expandHome(configured));
}

function tomlField(text, field) {
  const m = String(text).match(new RegExp(`^${field}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

function readAgent(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { model: null, effort: null, error: e.message };
  }
  return {
    model: tomlField(text, 'model'),
    effort: tomlField(text, 'model_reasoning_effort'),
    error: null,
  };
}

function detectCodexCliVersion(env = process.env) {
  const pinned = String((env && env.SHIPYARD_CODEX_CLI_VERSION) || '').trim();
  if (pinned) return pinned;
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  const match = String(`${result.stdout || ''} ${result.stderr || ''}`).match(/\d+(?:\.\d+)+/);
  return match ? match[0] : null;
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => parseInt(part, 10));
  const right = String(b).split('.').map((part) => parseInt(part, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = Number.isFinite(left[i]) ? left[i] : 0;
    const y = Number.isFinite(right[i]) ? right[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function usableCodexPalette(cfg, env = process.env) {
  const cliVersion = detectCodexCliVersion(env);
  const allEntries = Array.isArray(cfg.codex_models)
    ? cfg.codex_models.filter((entry) => entry && entry.model)
    : [];
  return {
    cliVersion,
    allEntries,
    entries: allEntries.filter((entry) => {
      if (!entry.min_cli) return true;
      return Boolean(cliVersion) && compareVersions(cliVersion, entry.min_cli) >= 0;
    }),
  };
}

function lowerEffort(requested, configured) {
  if (!requested) return configured || null;
  if (!configured) return requested;
  const efforts = Array.isArray(pc.EFFORTS) ? pc.EFFORTS : [];
  const requestedIndex = efforts.indexOf(requested);
  const configuredIndex = efforts.indexOf(configured);
  if (requestedIndex === -1 || configuredIndex === -1) return configured;
  return efforts[Math.min(requestedIndex, configuredIndex)];
}

// Executors have no static Codex agent file: the main loop creates the
// worktree and dispatches gsd-executor (or performs the fallback inline). The
// palette still needs to be resolved at that point so a supported
// spawn_agent/codex exec path does not inherit the session model by accident.
function selectDynamicExecutor(cfg, classification, signals, env = process.env, projectDir = process.cwd()) {
  const { cliVersion, allEntries, entries } = usableCodexPalette(cfg, env);
  const ceiling = classification.value === 'recovery'
    || classification.value === 'critical'
      && (cfg.model_ladder === 'adaptive' || classification.requested === 'critical');
  const route = pc.routeOf('executor', signals, cfg);
  const parsedRoute = pc.parseRoute(route);
  if (!parsedRoute) fail(`the shared resolver returned an invalid route for executor: ${route}`);
  const requestedEffort = parsedRoute.effort.effort;
  const remapFor = createCodexRemapper({ codexHome: env.CODEX_HOME, cwd: projectDir, env });
  const remapped = remapFor(parsedRoute.tier.model);
  const declaredFloor = new Map(
    allEntries.filter((entry) => entry.min_cli).map((entry) => [entry.model, entry.min_cli]),
  );
  const remapFloor = declaredFloor.get(remapped);
  const remapUsable = remapped && (!remapFloor || (cliVersion && compareVersions(cliVersion, remapFloor) >= 0));
  const common = {
    role: 'executor',
    ladder_role: 'executor',
    task_level: classification.value,
    task_level_rule: classification.rule,
    ladder_mode: cfg.model_ladder,
    agent_file: null,
    agent_path: null,
    model_tier: parsedRoute.tier.model,
    requested_effort: requestedEffort,
    route,
    project_dir: path.resolve(projectDir),
  };
  if (remapUsable) {
    return {
      ...common,
      model: remapped,
      // A remapped model is an operator choice, so its effort is the shared
      // resolver's effort rather than the palette entry's measured effort.
      effort: requestedEffort,
      model_source: 'gsd-remap',
      palette_lane: 'remap',
    };
  }
  if (!entries.length) {
    // An empty or CLI-filtered palette is intentional: generated Codex files
    // omit `model` in this state and let the CLI choose its default. Returning
    // an explicit null lets the caller omit --model without aborting dispatch.
    return {
      ...common,
      model: null,
      effort: requestedEffort,
      model_source: 'codex-cli-default',
      palette_lane: 'default',
      selection_reason: 'no_usable_palette_entry',
      ...(remapped ? { remap_fallback: 'declared_cli_floor' } : {}),
    };
  }
  const entry = ceiling ? entries[entries.length - 1] : entries[0];
  return {
    ...common,
    model: entry.model,
    effort: lowerEffort(requestedEffort, entry.effort),
    model_source: 'codex_models',
    ...(ceiling ? { palette_lane: 'ceiling' } : { palette_lane: 'floor' }),
  };
}

function candidateSuffix(role, level, mode = 'adaptive') {
  const generatedRole = role;
  if (level === 'recovery' && DEEP_ROLES.has(generatedRole)) return DEEP_SUFFIX;
  if (mode === 'adaptive' && level === 'critical' && CRITICAL_ROLES.has(generatedRole)) return CRITICAL_SUFFIX;
  return '';
}

function selectAgent(role, options = {}) {
  const requestedRole = String(role || '');
  const ladderRole = AGENT_ROLE(requestedRole);
  const validRoles = new Set([...(pc.ROLES || []), 'inv-research']);
  if (!validRoles.has(requestedRole)) fail(`unknown role "${requestedRole}" (roles: ${[...validRoles].join(', ')})`, 2);
  const loaded = pc.loadConfig(options.cwd || process.cwd());
  if (!loaded.valid) fail(`project model policy is invalid: ${loaded.error.file} — ${loaded.error.message}`);
  const cfg = {
    ...loaded.config,
    gsd: { ...(loaded.config.gsd || {}), runtime: 'codex' },
  };
  const signals = options.signals || {};
  const classification = pc.taskLevelRoute(ladderRole, signals, cfg);
  if (ladderRole === 'executor') {
    return {
      ...selectDynamicExecutor(
        cfg,
        classification,
        signals,
        options.env || process.env,
        options.cwd || process.cwd(),
      ),
      project_dir: path.resolve(options.cwd || process.cwd()),
    };
  }
  const baseRole = requestedRole === 'research' ? 'inv-research' : requestedRole;
  const suffix = candidateSuffix(baseRole, classification.value, cfg.model_ladder);
  const baseName = `${PREFIX}${baseRole}`;
  const wantedName = `${baseName}${suffix}`;
  const dir = options.agentDir || agentDirFrom(options.flags || new Map());
  const wantedPath = path.join(dir, `${wantedName}.toml`);
  let selectedName = wantedName;
  let selectedPath = wantedPath;
  let fallback = null;
  // The classifier still labels a high-risk/checkpoint dispatch `critical` in
  // conservative mode so telemetry describes the work. Conservative policy does
  // not emit first-attempt critical files, however, and silently selecting the
  // ordinary file would make the label look like an enforced premium lane. Keep
  // the ordinary file as the safe compatibility fallback, but say why it was
  // selected. Adaptive mode reaches the same fallback only when the generated
  // variant is genuinely unavailable.
  if (classification.value === 'critical'
      && cfg.model_ladder !== 'adaptive'
      && CRITICAL_ROLES.has(baseRole)) {
    fallback = {
      requested: `${baseName}${CRITICAL_SUFFIX}`,
      reason: 'the project ladder is conservative, so no first-attempt critical Codex variant is generated',
    };
  }
  if (!fs.existsSync(selectedPath) && suffix) {
    selectedName = baseName;
    selectedPath = path.join(dir, `${baseName}.toml`);
    fallback = {
      requested: wantedName,
      reason: `the generated ${wantedName}.toml is unavailable; the configured palette has no distinct ${classification.value} variant`,
    };
  }
  if (!fs.existsSync(selectedPath)) {
    fail(`Codex agent file not found: ${selectedPath}. Run install-shipyard-codex.sh --phase 2 first`);
  }
  const fields = readAgent(selectedPath);
  if (fields.error) fail(`cannot read Codex agent file ${selectedPath}: ${fields.error}`);
  const route = pc.routeOf(ladderRole, signals, cfg);
  const parsedRoute = pc.parseRoute(route);
  if (!parsedRoute) fail(`the shared resolver returned an invalid route for ${ladderRole}: ${route}`);
  return {
    role: requestedRole,
    ladder_role: ladderRole,
    task_level: classification.value,
    task_level_rule: classification.rule,
    ladder_mode: cfg.model_ladder,
    agent_file: selectedName,
    agent_path: selectedPath,
    model: fields.model,
    effort: fields.effort,
    // `model` is the concrete id read from the static Codex file. The recorder's
    // requested model field is the shared tier alias, so expose it separately
    // instead of making callers parse the route or passing a concrete id where
    // dispatch-record expects `opus|sonnet|haiku|fable`.
    model_tier: parsedRoute.tier.model,
    requested_effort: parsedRoute.effort.effort,
    route,
    project_dir: path.resolve(options.cwd || process.cwd()),
    ...(fallback ? { fallback } : {}),
  };
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const [cmd, role] = positionals;
  if (cmd !== 'select' || !role) {
    fail('usage: codex-agent.cjs select <role> [--json] [--project-dir <project>] [--agent-dir <dir>] [signals]', 2);
  }
  const result = selectAgent(role, {
    flags,
    cwd: projectDirFrom(flags),
    signals: signalsFrom(flags),
    agentDir: agentDirFrom(flags),
  });
  process.stdout.write(flags.has('json')
    ? `${JSON.stringify(result)}\n`
    : `${result.agent_file || result.model}\n`);
}

module.exports = {
  selectAgent,
  parseArgs,
  signalsFrom,
  candidateSuffix,
  detectCodexCliVersion,
  compareVersions,
  usableCodexPalette,
  selectDynamicExecutor,
  projectDirFrom,
  ROLE_ALIASES,
  DEEP_ROLES,
  CRITICAL_ROLES,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`codex-agent: ${e.message}\n`);
    process.exit(e.exitCode || 1);
  }
}
