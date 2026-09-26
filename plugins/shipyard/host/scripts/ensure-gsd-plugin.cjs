#!/usr/bin/env node
'use strict';

// @contract: GSD must be installed as an enabled marketplace plugin.
const { spawnSync } = require('node:child_process');
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
function ensure(runtime) {
  if (!['claude', 'codex'].includes(runtime)) throw new Error('runtime must be claude or codex');
  const result = run(runtime, ['plugin', 'marketplace', 'list', '--json'], true);
  const marketplaces = runtime === 'codex' ? result.marketplaces : result;
  if (!marketplaces.some(m => m.name === 'gsd-core')) {
    run(runtime, ['plugin', 'marketplace', 'add', 'open-gsd/gsd-core']);
  }
  let plugin = installed(runtime);
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
module.exports = { ensure, installed };
if (require.main === module) {
  try { ensure(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
