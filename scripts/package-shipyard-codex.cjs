#!/usr/bin/env node
'use strict';

// @contract: Package reviewed source; generate host-bound agents on installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const scripts = ['bootstrap-shipyard-plugin.cjs', 'ensure-gsd-plugin.cjs', 'ensure-gsd-core.sh',
  'install-shipyard-codex.sh', 'gen-codex-shipyard.cjs', 'merge-codex-config.cjs', 'configure-codex-notify.cjs'];
const names = ['route', 'investigate', 'decompose', 'deliver', 'bench', 'delivery-rules'];
function build(destination = path.join(root, 'plugins/shipyard')) {
  fs.mkdirSync(destination, { recursive: true });
  for (const dir of ['host', 'skills', 'hooks']) fs.rmSync(path.join(destination, dir), { recursive: true, force: true });
  const write = (file, content) => {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  };
  for (const file of scripts) write('host/scripts/' + file, fs.readFileSync(path.join(root, 'scripts', file)));
  for (const dir of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline']) {
    fs.cpSync(path.join(root, dir), path.join(destination, 'host', dir), { recursive: true,
      filter: source => !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(source) });
  }
  const sourceManifest = require(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'));
  const manifest = { name: 'shipyard', version: sourceManifest.version,
    description: sourceManifest.description, author: sourceManifest.author,
    repository: 'https://github.com/serhii-nochevnyi/shipyard', skills: './skills/',
    interface: { displayName: 'Shipyard', shortDescription: 'Research, plan and deliver with GSD.',
      longDescription: 'Native Codex delivery workflows with GSD plugin dependency setup, validated agents and host gates.',
      developerName: sourceManifest.author.name, category: 'Productivity', capabilities: ['Read', 'Write'],
      defaultPrompt: ['Use Shipyard to route this task.'] } };
  for (const name of names) {
    const file = name === 'delivery-rules' ? 'skills/delivery-rules/SKILL.md' : `commands/${name}.md`;
    const source = fs.readFileSync(path.join(root, 'plugins/delivery-pipeline', file), 'utf8');
    const description = source.match(/^description:\s*(.+)$/m)?.[1] || `Shipyard ${name} workflow`;
    write(`skills/shipyard-${name}/SKILL.md`, `---\nname: shipyard-${name}\ndescription: ${description}\n---\n\n` +
      `# Shipyard ${name}\n\n` +
      'Resolve this installed skill directory from its supplied absolute SKILL.md path. ' +
      'The plugin root is two directories above it. Run, with that absolute root:\n\n' +
      '```sh\nnode "<plugin-root>/host/scripts/bootstrap-shipyard-plugin.cjs"\n```\n\n' +
      'This idempotently installs/enables the GSD marketplace dependency and prepares native Codex host components. ' +
      'On any failure stop and report the exact setup error; do not run a partial workflow. ' +
      'If setup registered agents for the first time, start a new Codex session before dispatching them.\n\n' +
      'Read the complete file at `${CODEX_HOME:-$HOME/.codex}/shipyard-native-skills/shipyard-' + name + '/SKILL.md` ' +
      'using shell expansion (CODEX_HOME takes precedence), then execute that workflow with the original user arguments. ' +
      'Do not summarize or substitute its runtime policy, model selection, validation, gates, or receipts.\n');
  }
  write('hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
    command: 'node "${PLUGIN_ROOT}/host/scripts/bootstrap-shipyard-plugin.cjs"', timeout: 360,
    statusMessage: 'Preparing Shipyard and GSD' }] }] } }, null, 2) + '\n');
  const hash = crypto.createHash('sha256');
  function walk(dir, prefix = '') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + ent.name;
      if (relative === 'package-build.json' || relative === '.codex-plugin/plugin.json') continue;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), relative + '/');
      else { hash.update(relative + '\0'); hash.update(fs.readFileSync(path.join(dir, ent.name))); }
    }
  }
  walk(destination);
  const sourceDigest = hash.digest('hex');
  // @contract: The content suffix makes every changed package a fresh Codex cache version.
  manifest.version = `${sourceManifest.version}+codex.${sourceDigest.slice(0, 16)}`;
  write('.codex-plugin/plugin.json', JSON.stringify(manifest, null, 2) + '\n');
  const digest = crypto.createHash('sha256').update(sourceDigest).update('\0')
    .update(fs.readFileSync(path.join(destination, '.codex-plugin/plugin.json'))).digest('hex');
  write('package-build.json', JSON.stringify({ version: manifest.version, digest,
    skills: names.map(n => 'shipyard-' + n) }, null, 2) + '\n');
  return destination;
}
function packageFreshnessRequired(baseRef) {
  return !/^(epic|ticket)\//.test(String(baseRef || ''));
}

module.exports = { build, packageFreshnessRequired };
if (require.main === module) console.log(build(process.argv[2]));
