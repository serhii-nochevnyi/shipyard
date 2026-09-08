#!/usr/bin/env node
'use strict';

// gen-codex-shipyard.cjs — generate a Codex-native shipyard bundle from the
// canonical Claude Code plugin (plugins/delivery-pipeline/).
//
// Single source of truth: the Claude commands/references stay canonical; this
// script emits the Codex artifacts. Conversion is delegated to gsd-core's own
// `runtime-artifact-conversion.cjs` (required from an installed gsd-core), so
// the Claude→Codex mapping (adapter header, `$gsd-*` refs, gsd-tools shim path)
// never drifts from what `gsd-core --codex` itself produces. Only two rewrites
// are shipyard-specific and done here: the plugin-root token and our own
// `/shipyard:<cmd>` self-references (gsd-core does not know either).
//
// Output (stage dir, default .build/codex-shipyard/):
//   skills/shipyard-<cmd>/SKILL.md      → ~/.agents/skills/
//   skills/shipyard-delivery-rules/…    → ~/.agents/skills/
//   agents/shipyard-<role>.toml         → $CODEX_HOME/agents/
//   config.fragment.toml                → merged into $CODEX_HOME/config.toml
//   bundle/{scripts,references,templates} → $CODEX_HOME/shipyard/ (CLAUDE_PLUGIN_ROOT payload)
//
// The install script (install-shipyard-codex.sh) places these; this script only
// stages them and never writes outside --out.

const fs = require('fs');
const path = require('path');

function fail(msg) {
  process.stderr.write(`gen-codex-shipyard: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return require('os').homedir();
  if (p.startsWith('~/')) return path.join(require('os').homedir(), p.slice(2));
  return p;
}

// Resolve gsd-core's conversion module from an installed Codex config home.
function resolveGsdLib(explicit, codexHome) {
  const candidates = [];
  if (explicit) candidates.push(expandHome(explicit));
  candidates.push(path.join(codexHome, 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs'));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  fail(
    'could not locate gsd-core runtime-artifact-conversion.cjs.\n' +
      `  looked in: ${candidates.join(', ')}\n` +
      '  install gsd-core for Codex first: npx --yes @opengsd/gsd-core@latest --codex --global',
  );
}

// ── the model palette, rendered for Codex ────────────────────────────────────
//
// On Claude the ladder reaches the agents at CALL time: the Workflow path passes
// `model` and `effort` into every agent(). Codex has no such hook — an agent is a
// static .toml — so a role's model and effort are written at generation time.
//
// Two layers, and we own only the first. `pipeline-config.cjs` decides the TIER
// (opus|sonnet|haiku) and the effort — shipyard policy, and the single source.
// The second layer is which concrete model a tier means, and on this runtime it
// is the OPERATOR's, not the catalog's: `pipeline.codex_models` is an ordered
// palette of `{model, effort, min_cli}` (ADR-005 D6/D7). The floor entry goes to
// every role, the ceiling to the integrator — exactly as `integrator` takes the
// 1M tier on the other runtime — and the four escalating roles get a SECOND file
// at the ceiling, because a signal cannot reach an agent that does not exist
// (D8). A GSD remap key still wins over the palette, resolved through GSD's own
// resolver: reading `runtimeTierDefaults` straight out of the catalog, as this
// did, meant `model_policy.runtime_tiers.codex.*` and
// `model_profile_overrides.codex.*` changed nothing while the docs said they did.
//
// The signals are necessarily BASELINE (risk medium, attempt 1): risk is a
// per-ticket fact and attempts are a per-run one, and neither exists when a
// static file is written. The `-deep` files are how the escalation survives that.
//
// The Codex agent names are not all ladder role names: the investigation
// researcher ships as `inv-research` (its reference file) while the ladder calls
// the role `research`. Unmapped, it fell through to the ladder's `default` and
// would have been billed as a judgment role.
const LADDER_ROLE = { 'inv-research': 'research' };

// The roles a signal escalates, and therefore the ones that get a second agent
// FILE at the palette's ceiling (ADR-005 D8): a repair role when its failure
// signature has repeated with the deeper strategy already spent
// (`repeat_exhausted`), the judge when the journal already holds a `violation`
// for this ticket. The integrator gets no variant — one call per phase, already
// at the ceiling.
const DEEP_ROLES = new Set(['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']);
const DEEP_SUFFIX = '-deep';

// Numeric, part by part: a string compare makes 0.153.4 > 0.153.1 true by luck
// and 0.153.10 > 0.153.9 false.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10));
  const pb = String(b).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// What the HOST's CLI is, because the palette's ceiling may be a model an older
// CLI cannot be configured with. `SHIPYARD_CODEX_CLI_VERSION` is the override
// tests and pinned hosts use; otherwise ask the CLI itself. Unknown counts as
// BELOW any floor: the guard exists to avoid writing an agent the runtime may
// ignore, and the fallback (the previous palette entry) always works.
function detectCodexCliVersion(env) {
  const pinned = String((env && env.SHIPYARD_CODEX_CLI_VERSION) || '').trim();
  if (pinned) return pinned;
  // Bounded: a CLI that stalls here would stall the installer with nothing on
  // screen, and a timeout lands in the same branch as "no version" — unknown,
  // therefore below any floor.
  const r = require('child_process').spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  const m = String(`${r.stdout || ''} ${r.stderr || ''}`).match(/\d+(?:\.\d+)+/);
  return m ? m[0] : null;
}

// "Has the user REMAPPED this tier?" — asked through GSD's own resolver, so the
// precedence its docs promise (model_policy.runtime_tiers, then
// model_profile_overrides) is the precedence we honour. The builtin catalog value
// is deliberately NOT a remap: it is what the palette replaces.
//
// GSD's loadConfig reads `<cwd>/.planning/config.json` and falls back to
// `~/.gsd/defaults.json` only when the project has no config of its own — so a
// global remap is invisible when the generator runs from a checkout that IS a GSD
// project. Same cwd rule as the palette; not ours to change, but worth knowing
// when a remap "does not take".
function gsdCodexRemapper(codexHome, cwd, log) {
  try {
    const lib = path.join(codexHome, 'gsd-core', 'bin', 'lib');
    const { resolveModelPolicy, resolveTierEntry } = require(path.join(lib, 'model-resolver.cjs'));
    const { loadConfig } = require(path.join(lib, 'config-loader.cjs'));
    if (typeof resolveTierEntry !== 'function' || typeof loadConfig !== 'function') {
      throw new Error('gsd-core model-resolver/config-loader lack the expected exports');
    }
    // GSD's loader reports on stderr what it does not recognise — shipyard's own
    // `pipeline` namespace among it — plus every global default a project config
    // shadows. None of that is actionable for whoever ran the installer, and in
    // installer output it reads as a failed install, so THIS read is muted. Our
    // own lines are not.
    const write = process.stderr.write;
    let gsd;
    try {
      process.stderr.write = () => true;
      gsd = loadConfig(cwd) || {};
    } finally {
      process.stderr.write = write;
    }
    return (tier) => {
      if (!tier) return null;
      const policy = gsd.model_policy && typeof gsd.model_policy === 'object'
        ? { ...gsd.model_policy, runtime: 'codex' }
        : null;
      const fromPolicy = policy && typeof resolveModelPolicy === 'function'
        ? resolveModelPolicy(policy, tier)
        : null;
      if (typeof fromPolicy === 'string' && fromPolicy) return fromPolicy;
      const overrides = gsd.model_profile_overrides;
      if (!overrides || typeof overrides !== 'object') return null;
      const mapped = resolveTierEntry({ runtime: 'codex', tier, overrides });
      const builtin = resolveTierEntry({ runtime: 'codex', tier, overrides: undefined });
      if (mapped && mapped.model && (!builtin || mapped.model !== builtin.model)) return mapped.model;
      return null;
    };
  } catch (e) {
    log(`gen-codex-shipyard: could not read GSD's model remap (${e.message}) — the palette decides alone\n`);
    return () => null;
  }
}

// One policy per run: the palette is filtered against the CLI once, so the
// version refusal is ONE line rather than one per role, and GSD's config is read
// once rather than eleven times.
function codexModelPolicy(pluginDir, codexHome, opts = {}) {
  const log = opts.log || ((m) => process.stderr.write(m));
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const inert = { forRole: () => ({ model: null, effort: null }), palette: [], cliVersion: null };

  let pc;
  let cfg;
  try {
    // require() treats a bare relative path as a PACKAGE name, so `--plugin
    // plugins/delivery-pipeline` resolved to nothing and every agent silently
    // shipped without a model — the failure this function exists to prevent,
    // wearing its own fallback as a disguise.
    pc = require(path.resolve(pluginDir, 'scripts', 'pipeline-config.cjs'));
    const loaded = pc.loadConfig(cwd);
    // Force the codex branch of the policy regardless of where we generate from:
    // the 1M tier is Claude-only and must degrade here, and the effort axis is
    // flat here and nowhere else.
    cfg = { ...loaded.config, gsd: { ...(loaded.config.gsd || {}), runtime: 'codex' } };
    for (const w of loaded.warnings || []) {
      if (/codex_models/.test(w)) log(`gen-codex-shipyard: ${w}\n`);
    }
  } catch (e) {
    log(`gen-codex-shipyard: could not load the model policy (${e.message}) — every agent stays on the CLI default\n`);
    return inert;
  }

  const cliVersion = detectCodexCliVersion(env);
  const palette = [];
  for (const entry of Array.isArray(cfg.codex_models) ? cfg.codex_models : []) {
    if (entry.min_cli && (!cliVersion || compareVersions(cliVersion, entry.min_cli) < 0)) {
      log(
        `gen-codex-shipyard: not writing "${entry.model}" — configuring it needs Codex CLI ${entry.min_cli}, ` +
        `this host reports ${cliVersion || 'no version'}. Every role gets the previous palette entry instead.\n`
      );
      continue;
    }
    palette.push(entry);
  }
  if (!palette.length) {
    log('gen-codex-shipyard: no usable model in the palette — every agent stays on the CLI default\n');
  }
  const floor = palette[0] || null;
  const ceiling = palette.length ? palette[palette.length - 1] : null;
  const remapFor = gsdCodexRemapper(codexHome, cwd, log);

  // The palette entry's effort is the effort to USE for that model, so the role
  // rule may ask for LESS but never more: the mechanical role keeps its `low`,
  // and nothing pays above what the operator measured the model to be best at.
  const EFFORTS = Array.isArray(pc.EFFORTS) ? pc.EFFORTS : [];
  const lowerEffort = (a, b) => {
    if (!a) return b || null;
    if (!b) return a;
    const ia = EFFORTS.indexOf(a);
    const ib = EFFORTS.indexOf(b);
    if (ia === -1 || ib === -1) return a;
    return ia <= ib ? a : b;
  };

  const forRole = (role, { deep = false } = {}) => {
    try {
      const ladderRole = LADDER_ROLE[role] || role;
      const tier = pc.resolveModel(ladderRole, {}, cfg);
      const effort = pc.resolveEffort(ladderRole, tier, cfg, {});
      const remapped = remapFor(tier);
      // A remapped tier is one model for every role that resolves to it, so the
      // palette's floor/ceiling distinction does not apply — and the entry's
      // declared effort belongs to the entry's model, not to this one.
      if (remapped) return { model: remapped, effort };
      const entry = deep || role === 'integrator' ? ceiling : floor;
      if (!entry) return { model: null, effort };
      return { model: entry.model, effort: lowerEffort(effort, entry.effort) };
    } catch (e) {
      log(`gen-codex-shipyard: could not resolve a model for ${role} (${e.message}) — leaving the agent on the CLI default\n`);
      return { model: null, effort: null };
    }
  };

  return { forRole, palette, cliVersion };
}

// Kept as a function of its own because it is the unit under test: one role in,
// one `{model, effort}` out. `opts.policy` reuses a policy main() already built.
function codexModelFor(role, pluginDir, codexHome, opts = {}) {
  const policy = opts.policy || codexModelPolicy(pluginDir, codexHome, opts);
  return policy.forRole(role, opts);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// Editor leftovers must not become part of a shipped bundle. Three `*.mjs.bak`
// files — stale copies of the Workflow prompt builders, differing from the live
// ones by dozens of lines — reached BOTH installed runtimes this way. Inert, but
// a reader who opens one is reading superseded logic that looks authoritative
// because it shipped.
const IGNORED = /\.(bak|orig|rej|swp)$|^\.DS_Store$|~$/;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (IGNORED.test(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// shipyard-specific rewrites applied AFTER gsd-core's converter.
function shipyardRewrites(text, scriptsRoot) {
  return (
    text
      // our own command self-references: /shipyard:deliver → $shipyard-deliver
      .replace(/\/shipyard:([a-z-]+)/g, '$shipyard-$1')
      // plugin-root token → installed bundle root (gsd-core leaves this untouched)
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, scriptsRoot)
  );
}

// TOML literal string ('''…'''). References are prose; guard against a stray '''.
function tomlMultiline(value) {
  if (value.includes("'''")) {
    // fall back to a basic double-quoted string with escapes on a single logical line
    const esc = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `"${esc}"`;
  }
  return `'''\n${value}\n'''`;
}

function tomlBasic(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// First markdown heading or first sentence → a one-line agent description.
function deriveDescription(body, roleName) {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) return firstLine.replace(/[`*_#>]/g, '').slice(0, 160);
  return `shipyard ${roleName} role`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const pluginDir = expandHome(args.plugin) || path.join(repoRoot, 'plugins', 'delivery-pipeline');
  const outDir = expandHome(args.out) || path.join(repoRoot, '.build', 'codex-shipyard');
  const codexHome = expandHome(args['codex-home']) || process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  // A malformed --phase used to become NaN, which silently compared false in
  // every gate: no deliver skill AND every phase-2 agent emitted anyway.
  const phase = args.phase === undefined ? 2 : parseInt(args.phase, 10);
  if (![1, 2].includes(phase)) fail(`--phase must be 1 or 2 (got "${args.phase}")`);
  // Where the CLAUDE_PLUGIN_ROOT payload lands on the host (absolute, host-installed).
  const scriptsRoot = expandHome(args['bundle-root']) || path.join(codexHome, 'shipyard');

  if (!fs.existsSync(pluginDir)) fail(`plugin dir not found: ${pluginDir}`);
  const gsdLib = resolveGsdLib(args['gsd-lib'], codexHome);
  const convert = require(gsdLib);
  for (const fn of ['convertClaudeCommandToCodexSkill', 'convertClaudeToCodexMarkdown']) {
    if (typeof convert[fn] !== 'function') fail(`gsd-core lib missing export ${fn} (incompatible version?)`);
  }

  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // ── commands → Codex skills ───────────────────────────────────────────────
  // route (entry router) and bench (off-conveyor) are meta / no ticket graph —
  // always available in both phases
  const commands = phase >= 2
    ? ['route', 'investigate', 'decompose', 'deliver', 'bench']
    : ['route', 'investigate', 'decompose', 'bench'];
  const emittedSkills = [];
  for (const cmd of commands) {
    const src = path.join(pluginDir, 'commands', `${cmd}.md`);
    if (!fs.existsSync(src)) fail(`command not found: ${src}`);
    const skillName = `shipyard-${cmd}`;
    const raw = fs.readFileSync(src, 'utf8');
    const converted = shipyardRewrites(convert.convertClaudeCommandToCodexSkill(raw, skillName), scriptsRoot);
    writeFile(path.join(outDir, 'skills', skillName, 'SKILL.md'), converted);
    emittedSkills.push(skillName);
  }

  // ── delivery-rules skill (guidance for planner/executor) ───────────────────
  const drSrc = path.join(pluginDir, 'skills', 'delivery-rules', 'SKILL.md');
  if (fs.existsSync(drSrc)) {
    const skillName = 'shipyard-delivery-rules';
    const raw = fs.readFileSync(drSrc, 'utf8');
    const converted = shipyardRewrites(convert.convertClaudeCommandToCodexSkill(raw, skillName), scriptsRoot);
    writeFile(path.join(outDir, 'skills', skillName, 'SKILL.md'), converted);
    emittedSkills.push(skillName);
  }

  // ── references → Codex subagents ───────────────────────────────────────────
  // read-only judges vs workspace-write workers; gated by phase.
  const ROLES = {
    'inv-research': { sandbox: 'read-only', phase: 1 },
    'arch-review': { sandbox: 'read-only', phase: 2 },
    'drift-check': { sandbox: 'read-only', phase: 2 },
    'review-fix': { sandbox: 'workspace-write', phase: 2 },
    'ci-fix': { sandbox: 'workspace-write', phase: 2 },
    'pr-sentinel': { sandbox: 'workspace-write', phase: 2 },
    'integrator': { sandbox: 'workspace-write', phase: 2 },
  };
  const emittedAgents = [];
  const policy = codexModelPolicy(pluginDir, codexHome);
  const agentToml = (agentName, description, sandbox, model, effort, body) =>
    `name = ${tomlBasic(agentName)}\n` +
    `description = ${tomlBasic(description)}\n` +
    `sandbox_mode = ${tomlBasic(sandbox)}\n` +
    (model ? `model = ${tomlBasic(model)}\n` : '') +
    (effort ? `model_reasoning_effort = ${tomlBasic(effort)}\n` : '') +
    `developer_instructions = ${tomlMultiline(body)}\n`;
  for (const [role, meta] of Object.entries(ROLES)) {
    if (meta.phase > phase) continue;
    const src = path.join(pluginDir, 'references', `${role}.md`);
    if (!fs.existsSync(src)) continue; // reference optional
    const agentName = `shipyard-${role}`;
    const raw = fs.readFileSync(src, 'utf8');
    const body = shipyardRewrites(convert.convertClaudeToCodexMarkdown(raw), scriptsRoot);
    const description = deriveDescription(raw, role);
    const base = policy.forRole(role);
    writeFile(
      path.join(outDir, 'agents', `${agentName}.toml`),
      agentToml(agentName, description, meta.sandbox, base.model, base.effort, body),
    );
    emittedAgents.push({ agentName, description });

    // The escalation variant. Written only when it would actually DIFFER from
    // the ordinary agent — a single-entry palette, or a GSD remap that maps the
    // whole tier to one model, leaves nothing for it to be, and a duplicate file
    // that reads as an escalation is worse than no file at all.
    if (!DEEP_ROLES.has(role)) continue;
    const deep = policy.forRole(role, { deep: true });
    if (!deep.model || (deep.model === base.model && deep.effort === base.effort)) continue;
    const deepName = `${agentName}${DEEP_SUFFIX}`;
    const deepBody =
      '> **Escalation variant.** The ordinary `' + agentName + '` agent has already been\n' +
      '> tried on this failure and it came back. Same contract as below, on a deeper\n' +
      '> model: change the hypothesis, do not re-run the one that just failed.\n\n' +
      body;
    writeFile(
      path.join(outDir, 'agents', `${deepName}.toml`),
      agentToml(
        deepName,
        `${description} — escalation variant, for a failure the ordinary ${agentName} already tried`,
        meta.sandbox,
        deep.model,
        deep.effort,
        deepBody,
      ),
    );
    emittedAgents.push({ agentName: deepName, description: `${description} (escalation variant)` });
  }

  // ── config fragment registering our agents (merged non-destructively) ──────
  if (emittedAgents.length) {
    // Fenced with begin/end markers, like the auto-route block in AGENTS.md, so
    // the merger can remove the WHOLE previous fragment. Table-shaped stripping
    // alone cannot: a leading comment sits before the first `[agents.shipyard-*]`
    // header and belongs to no table, so every re-install left another copy of it
    // behind (three, on a host installed three times).
    let frag = '# shipyard-agents:begin — delivery-pipeline agents, managed by install-shipyard-codex.sh\n';
    for (const { agentName, description } of emittedAgents) {
      const cfgPath = path.join(codexHome, 'agents', `${agentName}.toml`);
      frag += `\n[agents.${agentName}]\n`;
      frag += `description = ${tomlBasic(description)}\n`;
      frag += `config_file = ${tomlBasic(cfgPath)}\n`;
    }
    frag += '\n# shipyard-agents:end\n';
    writeFile(path.join(outDir, 'config.fragment.toml'), frag);
  }

  // ── CLAUDE_PLUGIN_ROOT payload (scripts/references/templates/workflows) ────
  // `workflows` is included even though Codex has no Workflow tool: the deliver
  // skill's ${CLAUDE_PLUGIN_ROOT} references are rewritten to the bundle root, and
  // leaving the directory out pointed those paths at files that do not exist.
  for (const sub of ['scripts', 'references', 'templates', 'workflows']) {
    const s = path.join(pluginDir, sub);
    if (fs.existsSync(s)) copyDir(s, path.join(outDir, 'bundle', sub));
  }

  // ── manifest (for the installer + smoke test) ──────────────────────────────
  const manifest = {
    phase,
    codexHome,
    scriptsRoot,
    skills: emittedSkills,
    agents: emittedAgents.map((a) => a.agentName),
    gsdLib,
  };
  writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(
    `staged ${emittedSkills.length} skills, ${emittedAgents.length} agents → ${outDir} (phase ${phase})\n`,
  );
}

module.exports = {
  codexModelPolicy, codexModelFor, compareVersions, detectCodexCliVersion,
  DEEP_ROLES, DEEP_SUFFIX, LADDER_ROLE,
};

// The installer runs this as a script; the unit test requires it as a module.
if (require.main === module) main();
