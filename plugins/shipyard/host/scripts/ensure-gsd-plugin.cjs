#!/usr/bin/env node
'use strict';

// @contract: GSD must be installed as an enabled marketplace plugin.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const GSD_REPO = 'open-gsd/gsd-core';
const GSD_PLUGIN_REF = 'plugin';
// @contract: Codex installs only local entries, so it reads a Shipyard-owned copy of GSD's prebuilt plugin ref.
const MARKETPLACE = Object.freeze({ claude: GSD_REPO, codex: `${GSD_REPO}@${GSD_PLUGIN_REF}` });
const CODEX_MARKETPLACE_DIR = 'shipyard-gsd-marketplace';
function run(runtime, args, json = false) {
  const result = spawnSync(runtime, args, { encoding: 'utf8', timeout: 180000,
    maxBuffer: 8 * 1024 * 1024, stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`${runtime} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  }
  return json ? JSON.parse(result.stdout) : undefined;
}
function installed(runtime) {
  const result = run(runtime, ['plugin', 'list', '--json'], true);
  return (runtime === 'codex' ? result.installed : result).find(p =>
    (p.pluginId || p.id) === 'gsd-core@gsd-core' &&
    (runtime !== 'claude' || p.scope === 'user'));
}
function localEntry(marketplace) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(marketplace.root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    return typeof manifest.plugins?.find(entry => entry?.name === 'gsd-core')?.source === 'string';
  } catch { return false; }
}
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || result.status}`);
  }
  return result.stdout.trim();
}
function codexMarketplace(env = process.env) {
  const root = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), CODEX_MARKETPLACE_DIR);
  const checkout = path.join(root, 'gsd-core');
  const source = env.SHIPYARD_GSD_PLUGIN_SOURCE || `https://github.com/${GSD_REPO}.git`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  git(['clone', '--quiet', '--depth', '1', '--branch', GSD_PLUGIN_REF, source, checkout]);
  const commit = git(['-C', checkout, 'rev-parse', 'HEAD']);
  let upstream;
  try {
    upstream = JSON.parse(fs.readFileSync(path.join(checkout, '.claude-plugin', 'marketplace.json'), 'utf8'));
  } catch (error) {
    throw new Error(`${MARKETPLACE.codex} has no readable .claude-plugin/marketplace.json: ${error.message}`);
  }
  const entry = upstream.plugins?.find(plugin => plugin?.name === 'gsd-core');
  if (!entry || !fs.existsSync(path.join(checkout, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`${MARKETPLACE.codex} does not ship the gsd-core plugin at its root`);
  }
  fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
  const manifest = { ...upstream, name: 'gsd-core', plugins: [{ ...entry, source: './gsd-core' }] };
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'shipyard-source.json'),
    `${JSON.stringify({ repo: GSD_REPO, ref: GSD_PLUGIN_REF, commit, version: entry.version || null }, null, 2)}\n`);
  return root;
}
function ensure(runtime) {
  if (!['claude', 'codex'].includes(runtime)) throw new Error('runtime must be claude or codex');
  const result = run(runtime, ['plugin', 'marketplace', 'list', '--json'], true);
  const marketplaces = runtime === 'codex' ? result.marketplaces : result;
  const marketplace = marketplaces.find(m => m.name === 'gsd-core');
  let plugin = installed(runtime);
  if (runtime === 'codex' && (!marketplace || (!plugin && !localEntry(marketplace)))) {
    if (marketplace) run(runtime, ['plugin', 'marketplace', 'remove', 'gsd-core']);
    run(runtime, ['plugin', 'marketplace', 'add', codexMarketplace()]);
  } else if (!marketplace) run(runtime, ['plugin', 'marketplace', 'add', MARKETPLACE[runtime]]);
  if (!plugin) run(runtime, ['plugin', runtime === 'codex' ? 'add' : 'install', 'gsd-core@gsd-core']);
  else if (!plugin.enabled) {
    // @contract: Codex add and Claude enable activate installed dependencies.
    run(runtime, ['plugin', runtime === 'codex' ? 'add' : 'enable', 'gsd-core@gsd-core']);
  }
  plugin = installed(runtime);
  if (!plugin?.enabled) throw new Error(`gsd-core@gsd-core is not enabled for ${runtime}`);
  console.log(`✓ GSD marketplace plugin ${plugin.version} enabled for ${runtime}`);
  return plugin;
}
module.exports = { ensure, installed, codexMarketplace, MARKETPLACE, CODEX_MARKETPLACE_DIR };
if (require.main === module) {
  try { ensure(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
