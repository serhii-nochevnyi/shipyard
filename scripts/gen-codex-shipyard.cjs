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
      '  install gsd-core for Codex first: npx --yes @opengsd/gsd-core@1.7.0 --codex --global',
  );
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
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
    'integrator': { sandbox: 'workspace-write', phase: 2 },
  };
  const emittedAgents = [];
  for (const [role, meta] of Object.entries(ROLES)) {
    if (meta.phase > phase) continue;
    const src = path.join(pluginDir, 'references', `${role}.md`);
    if (!fs.existsSync(src)) continue; // reference optional
    const agentName = `shipyard-${role}`;
    const raw = fs.readFileSync(src, 'utf8');
    const body = shipyardRewrites(convert.convertClaudeToCodexMarkdown(raw), scriptsRoot);
    const description = deriveDescription(raw, role);
    const toml =
      `name = ${tomlBasic(agentName)}\n` +
      `description = ${tomlBasic(description)}\n` +
      `sandbox_mode = ${tomlBasic(meta.sandbox)}\n` +
      `developer_instructions = ${tomlMultiline(body)}\n`;
    writeFile(path.join(outDir, 'agents', `${agentName}.toml`), toml);
    emittedAgents.push({ agentName, description });
  }

  // ── config fragment registering our agents (merged non-destructively) ──────
  if (emittedAgents.length) {
    let frag = '# shipyard delivery-pipeline agents — merged into $CODEX_HOME/config.toml\n';
    for (const { agentName, description } of emittedAgents) {
      const cfgPath = path.join(codexHome, 'agents', `${agentName}.toml`);
      frag += `\n[agents.${agentName}]\n`;
      frag += `description = ${tomlBasic(description)}\n`;
      frag += `config_file = ${tomlBasic(cfgPath)}\n`;
    }
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

main();
