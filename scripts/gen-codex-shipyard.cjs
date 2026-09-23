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
//   bundle/{scripts,references,templates}, bundle/codex-capabilities.json
//                                      → $CODEX_HOME/shipyard/ (CLAUDE_PLUGIN_ROOT payload)
//
// The install script (install-shipyard-codex.sh) places these; this script only
// stages them and leaves no persistent output outside --out. A disposable
// sibling is used during generation so a failed run preserves the prior stage.
// `--project-dir` identifies the checkout whose `.planning/config.json` must be readable. ADR-014 owns the
// selection grid; project compatibility palettes cannot override it. Host
// availability comes from an explicit snapshot or the Codex CLI model catalog.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(msg) {
  process.stderr.write(`gen-codex-shipyard: ${msg}\n`);
  process.exit(1);
}

function readCodexCliCapabilities() {
  const result = spawnSync('codex', ['debug', 'models'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit ${result.status}`;
    fail(`read Codex CLI model catalog with codex debug models: ${detail}`);
  }

  let catalog;
  try { catalog = JSON.parse(result.stdout); }
  catch (error) { fail(`parse Codex CLI model catalog: ${error.message}`); }
  if (!catalog || !Array.isArray(catalog.models)) fail('Codex CLI model catalog is missing models');

  const models = catalog.models.filter((model) => model && typeof model.slug === 'string'
    && model.slug && model.visibility === 'list' && model.supported_in_api === true);
  const supportedSelections = models.flatMap((model) => (Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels : [])
    .filter((level) => level && typeof level.effort === 'string' && level.effort)
    .map((level) => ({ model: model.slug, effort: level.effort })))
    .sort((left, right) => left.model.localeCompare(right.model) || left.effort.localeCompare(right.effort));
  return {
    supportedModels: [...new Set(models.map((model) => model.slug))].sort(),
    supportedEfforts: [...new Set(supportedSelections.map((selection) => selection.effort))].sort(),
    supportedSelections: [...new Map(supportedSelections.map((selection) => [
      `${selection.model}\0${selection.effort}`, selection,
    ])).values()],
  };
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
    const resolved = c && path.resolve(c);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  fail(
    'could not locate gsd-core runtime-artifact-conversion.cjs.\n' +
      `  looked in: ${candidates.join(', ')}\n` +
      '  install gsd-core for Codex first: npx --yes @opengsd/gsd-core@latest --codex --global',
  );
}

// Static selections come only from ADR-014 metadata. Project palettes/remaps
// remain compatibility settings for other callers; they cannot tune this bundle.
const policy = require('../plugins/delivery-pipeline/scripts/model-policy.cjs');
const {
  codexSkillNames, codexStaticVariants, validateCodexCapabilities, validateCodexBundle,
  payloadFiles, payloadDigests, CODEX_CAPABILITIES_BUNDLE_FILE,
} = require('../plugins/delivery-pipeline/scripts/gsd-tune.cjs');
const digest = (content) => require('crypto').createHash('sha256').update(content).digest('hex');

// Compatibility exports use generated reference names (research is inv-research)
// and describe only canonical static files, without restoring the retired grid.
const DEEP_SUFFIX = policy.variantSuffix('ci-fix', 'repeat_exhausted');
const CRITICAL_SUFFIX = policy.variantSuffix('arch-review', 'critical');
const staticRolesWithSuffix = (suffix) => new Set(codexStaticVariants()
  .filter(({ file, reference }) => file === `shipyard-${reference}${suffix}.toml`)
  .map(({ reference }) => reference));
const DEEP_ROLES = staticRolesWithSuffix(DEEP_SUFFIX);
const CRITICAL_ROLES = staticRolesWithSuffix(CRITICAL_SUFFIX);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

let activeStageDir = null;
function cleanupStage() {
  if (activeStageDir) rmrf(activeStageDir);
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

function readShipyardVersion(pluginDir) {
  const file = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
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
  return JSON.stringify(String(value));
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
  // The generator belongs to this checkout, so its safe default is the source
  // repository rather than the caller's shell cwd. An installer invoked from a
  // ticket worktree otherwise reads that worktree's absent config and silently
  // bakes the conservative defaults. `--project-dir` makes the policy root
  // explicit for callers that generate a plugin from elsewhere.
  const projectDir = path.resolve(expandHome(args['project-dir']) || repoRoot);
  const pluginDir = expandHome(args.plugin) || path.join(repoRoot, 'plugins', 'delivery-pipeline');
  const outDir = expandHome(args.out) || path.join(repoRoot, '.build', 'codex-shipyard');
  const codexHome = expandHome(args['codex-home']) || process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
  // A malformed --phase used to become NaN, which silently compared false in
  // every gate: no deliver skill AND every phase-2 agent emitted anyway.
  const phaseArg = args.phase === undefined ? '2' : String(args.phase);
  if (!/^[12]$/.test(phaseArg)) fail(`--phase must be 1 or 2 (got "${args.phase}")`);
  const phase = Number(phaseArg);
  // Where the CLAUDE_PLUGIN_ROOT payload lands on the host (absolute, host-installed).
  const scriptsRoot = expandHome(args['bundle-root']) || path.join(codexHome, 'shipyard');

  if (!fs.existsSync(pluginDir)) fail(`plugin dir not found: ${pluginDir}`);
  const gsdLib = resolveGsdLib(args['gsd-lib'], codexHome);
  // Capture the converter before loading or generating anything. Validation
  // compares this exact pre-generation snapshot with the live file again, so a
  // concurrent refresh cannot silently produce a bundle whose manifest names a
  // converter different from the one that was loaded.
  const gsdLibDigest = digest(fs.readFileSync(gsdLib));
  const convert = require(gsdLib);
  for (const fn of ['convertClaudeCommandToCodexSkill', 'convertClaudeToCodexMarkdown']) {
    if (typeof convert[fn] !== 'function') fail(`gsd-core lib missing export ${fn} (incompatible version?)`);
  }

  // Refuse unreadable policy input and missing required sources before touching
  // an existing stage. Generate in a disposable sibling, validate it fully,
  // then publish it as one directory replacement so a failed conversion or
  // payload copy cannot erase the previous valid stage.
  const loaded = require(path.resolve(pluginDir, 'scripts/pipeline-config.cjs')).loadConfig(projectDir);
  if (!loaded.valid) fail('cannot read project config: ' + loaded.error.message);
  const variants = codexStaticVariants(phase);
  for (const { reference } of variants) {
    const source = path.join(pluginDir, 'references', reference + '.md');
    if (!fs.existsSync(source)) fail('required reference missing: ' + source);
  }
  const capabilitiesFile = args.capabilities || process.env.SHIPYARD_CODEX_CAPABILITIES_FILE;
  let capabilities;
  let capabilitiesRaw;
  if (capabilitiesFile) {
    try {
      capabilitiesRaw = fs.readFileSync(capabilitiesFile, 'utf8');
      capabilities = JSON.parse(capabilitiesRaw);
    }
    catch (error) { fail('read host capabilities with --capabilities or SHIPYARD_CODEX_CAPABILITIES_FILE: ' + error.message); }
  } else {
    capabilities = readCodexCliCapabilities();
    capabilitiesRaw = JSON.stringify(capabilities, null, 2) + '\n';
  }
  validateCodexCapabilities(capabilities, phase);

  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const stageDir = fs.mkdtempSync(`${outDir}.stage-`);
  activeStageDir = stageDir;
  process.once('exit', cleanupStage);

  // ── commands → Codex skills ───────────────────────────────────────────────
  // route (entry router) and bench (off-conveyor) are meta / no ticket graph —
  // always available in both phases
  const commands = codexSkillNames(phase).filter((name) => name !== 'shipyard-delivery-rules')
    .map((name) => name.slice('shipyard-'.length));
  const emittedSkills = [];
  for (const cmd of commands) {
    const src = path.join(pluginDir, 'commands', `${cmd}.md`);
    if (!fs.existsSync(src)) fail(`command not found: ${src}`);
    const skillName = `shipyard-${cmd}`;
    const raw = fs.readFileSync(src, 'utf8');
    const converted = shipyardRewrites(convert.convertClaudeCommandToCodexSkill(raw, skillName), scriptsRoot);
    writeFile(path.join(stageDir, 'skills', skillName, 'SKILL.md'), converted);
    emittedSkills.push(skillName);
  }

  // ── delivery-rules skill (guidance for planner/executor) ───────────────────
  const drSrc = path.join(pluginDir, 'skills', 'delivery-rules', 'SKILL.md');
  if (fs.existsSync(drSrc)) {
    const skillName = 'shipyard-delivery-rules';
    const raw = fs.readFileSync(drSrc, 'utf8');
    const converted = shipyardRewrites(convert.convertClaudeCommandToCodexSkill(raw, skillName), scriptsRoot);
    writeFile(path.join(stageDir, 'skills', skillName, 'SKILL.md'), converted);
    emittedSkills.push(skillName);
  }

  // ── all required static role/rung variants ───────────────────────────────
  const emittedAgents = [];
  const agentDigests = {};
  for (const variant of variants) {
    const raw = fs.readFileSync(path.join(pluginDir, 'references', variant.reference + '.md'), 'utf8');
    const body = shipyardRewrites(convert.convertClaudeToCodexMarkdown(raw), scriptsRoot);
    const agentName = variant.file.replace(/\.toml$/, '');
    const description = deriveDescription(raw, variant.role) + ' (' + variant.rung + ')';
    const identity = {
      id: policy.POLICY.id, version: policy.POLICY_VERSION, hash: policy.POLICY_HASH,
      runtime: 'codex', role: variant.role, rung: variant.rung,
    };
    const content = Object.entries(identity).map(([key, value]) => '# shipyard-policy-' + key + ' = ' + tomlBasic(value) + '\n').join('')
      + 'name = ' + tomlBasic(agentName) + '\n'
      + 'description = ' + tomlBasic(description) + '\n'
      + 'sandbox_mode = ' + tomlBasic(variant.sandbox) + '\n'
      + 'model = ' + tomlBasic(variant.model) + '\n'
      + 'model_reasoning_effort = ' + tomlBasic(variant.effort) + '\n'
      + 'developer_instructions = ' + tomlMultiline(body) + '\n';
    writeFile(path.join(stageDir, 'agents', variant.file), content);
    agentDigests[variant.file] = digest(content);
    emittedAgents.push({ agentName, description });
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
    writeFile(path.join(stageDir, 'config.fragment.toml'), frag);
  }

  // ── CLAUDE_PLUGIN_ROOT payload (scripts/references/templates/workflows) ────
  // `workflows` is included even though Codex has no Workflow tool: the deliver
  // skill's ${CLAUDE_PLUGIN_ROOT} references are rewritten to the bundle root, and
  // leaving the directory out pointed those paths at files that do not exist.
  for (const sub of ['scripts', 'references', 'templates', 'workflows']) {
    const s = path.join(pluginDir, sub);
    if (fs.existsSync(s)) copyDir(s, path.join(stageDir, 'bundle', sub));
  }
  // gsd-tune uses one project-relative delivery-rules projection for both
  // runtimes. Keep the canonical, runtime-neutral source beside the Codex
  // bundle so the installed copy can generate that projection without reading
  // the checkout it was built from.
  const neutralRules = path.join(pluginDir, 'skills', 'delivery-rules');
  if (fs.existsSync(path.join(neutralRules, 'SKILL.md'))) {
    copyDir(neutralRules, path.join(stageDir, 'bundle', 'skills', 'delivery-rules'));
  }
  // Preserve the exact, explicitly supplied host-evidence document beside the
  // installed selector. A policy-derived copy would claim support that was
  // never measured; this file is only a durable copy of the caller's input.
  writeFile(path.join(stageDir, 'bundle', CODEX_CAPABILITIES_BUNDLE_FILE), capabilitiesRaw);

  // The manifest binds ownership, policy identity, files and registrations.
  const skillFiles = payloadFiles(path.join(stageDir, 'skills'));
  const bundleFiles = payloadFiles(path.join(stageDir, 'bundle'));
  const manifest = {
    shipyard_version: readShipyardVersion(pluginDir),
    phase,
    policy_id: policy.POLICY.id,
    policy_version: policy.POLICY_VERSION,
    policy_hash: policy.POLICY_HASH,
    capabilities_file: CODEX_CAPABILITIES_BUNDLE_FILE,
    capabilities_digest: digest(capabilitiesRaw),
    agent_digests: agentDigests,
    config_digest: digest(fs.readFileSync(path.join(stageDir, 'config.fragment.toml'))),
    dynamic_roles: policy.DYNAMIC_ROLES,
    codexHome,
    scriptsRoot,
    skills: emittedSkills,
    skill_digests: Object.fromEntries(emittedSkills.map((name) => [
      name, digest(fs.readFileSync(path.join(stageDir, 'skills', name, 'SKILL.md'))),
    ])),
    skill_files: skillFiles,
    skill_file_digests: payloadDigests(path.join(stageDir, 'skills'), skillFiles),
    bundle_files: bundleFiles,
    bundle_digests: payloadDigests(path.join(stageDir, 'bundle'), bundleFiles),
    agents: emittedAgents.map((a) => a.agentName),
    agent_files: emittedAgents.map((a) => `${a.agentName}.toml`),
    registrations: emittedAgents.map((a) => `agents.${a.agentName}`),
    gsdLib,
    gsd_lib: gsdLib,
    gsd_lib_digest: gsdLibDigest,
  };
  writeFile(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  validateCodexBundle(stageDir, { codexHome, phase, capabilities });
  let previousDir = null;
  const outExists = fs.existsSync(outDir) || (() => {
    try { return fs.lstatSync(outDir) !== undefined; } catch { return false; }
  })();
  if (outExists) {
    previousDir = fs.mkdtempSync(`${outDir}.previous-`);
    rmrf(previousDir);
    fs.renameSync(outDir, previousDir);
  }
  try {
    fs.renameSync(stageDir, outDir);
    activeStageDir = null;
  } catch (error) {
    if (previousDir && !fs.existsSync(outDir)) {
      try { fs.renameSync(previousDir, outDir); previousDir = null; } catch { /* preserve the original error */ }
    }
    throw error;
  }
  if (previousDir) rmrf(previousDir);
  process.stdout.write(
    `staged ${emittedSkills.length} skills, ${emittedAgents.length} agents → ${outDir} (phase ${phase})\n`,
  );
}

module.exports = { codexStaticVariants, validateCodexBundle, DEEP_ROLES, DEEP_SUFFIX, CRITICAL_ROLES, CRITICAL_SUFFIX };

// The installer runs this as a script; the unit test requires it as a module.
if (require.main === module) {
  try { main(); } catch (error) { fail(error.message); }
}
