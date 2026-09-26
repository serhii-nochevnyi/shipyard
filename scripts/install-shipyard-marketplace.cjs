#!/usr/bin/env node
'use strict';

// One explicit installation transaction starts both marketplace installations.
// Codex has no declarative plugin dependency resolver; do not invent a manifest
// field or claim that its Install button runs a post-install script.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ensure } = require('./ensure-gsd-plugin.cjs');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.status}`);
}
function main(args) {
  const runtime = args.shift();
  if (!['claude', 'codex'].includes(runtime)) throw new Error('Usage: node scripts/install-shipyard-marketplace.cjs <claude|codex> [--source <marketplace-root-or-git-url>]');
  let source = 'serhii-nochevnyi/shipyard';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--source' || !args[1]) throw new Error('Expected --source <marketplace-root-or-git-url>');
    source = args[1];
  }
  ensure(runtime);
  run(runtime, ['plugin', 'marketplace', 'add', source]);
  run(runtime, ['plugin', runtime === 'codex' ? 'add' : 'install', 'shipyard@shipyard']);
  if (runtime === 'codex') {
    const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const result = spawnSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error('Cannot verify installed Shipyard plugin');
    const plugin = JSON.parse(result.stdout).installed.find(p => p.pluginId === 'shipyard@shipyard' && p.enabled);
    if (!plugin) throw new Error('Shipyard plugin is not installed and enabled');
    const cache = path.join(home, 'plugins/cache/shipyard/shipyard');
    const candidates = [plugin.version, 'local'].filter(Boolean).map(v => path.join(cache, v));
    const installed = candidates.find(p => fs.existsSync(path.join(p, 'package-build.json')));
    if (!installed) throw new Error('Marketplace Shipyard lacks native Codex packaging; update the marketplace source before continuing');
    run(process.execPath, [path.join(installed, 'host/scripts/bootstrap-shipyard-plugin.cjs')]);
  } else {
    // Claude's manifest dependency is also supported by native plugin install.
    // Host hooks and GSD capability are installed from this checkout's release.
    const root = path.resolve(__dirname, '..');
    run('bash', [path.join(root, 'scripts/ensure-gsd-core.sh'), 'claude']);
    const env = { ...process.env, SHIPYARD_GSD_AUTO_INSTALL: '0' };
    run('bash', [path.join(root, 'scripts/install-shipyard-claude-hook.sh')], env);
    run('bash', [path.join(root, 'scripts/install-shipyard-capability.sh'), 'claude'], env);
  }
}
module.exports = { main };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
