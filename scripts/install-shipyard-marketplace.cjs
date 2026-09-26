#!/usr/bin/env node
'use strict';

// @contract: Install GSD and Shipyard marketplace plugins in one explicit setup.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ensure } = require('./ensure-gsd-plugin.cjs');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.status}`);
}
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return JSON.parse(result.stdout);
}
function codexMarketplaceSource(source) {
  if (fs.existsSync(source)) return { sourceType: 'local', source: fs.realpathSync(source) };
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return { sourceType: 'git', source: `https://github.com/${source}.git` };
  return { sourceType: 'git', source };
}
function installCodexMarketplace(source) {
  const existing = capture('codex', ['plugin', 'marketplace', 'list', '--json'])
    .marketplaces.find(item => item.name === 'shipyard');
  const target = codexMarketplaceSource(source);
  const registered = existing?.marketplaceSource;
  if (!registered || registered.sourceType === target.sourceType && registered.source === target.source) {
    run('codex', ['plugin', 'marketplace', 'add', source]);
    run('codex', ['plugin', 'add', 'shipyard@shipyard']);
    return;
  }
  const former = registered.source;
  const hadPlugin = capture('codex', ['plugin', 'list', '--json']).installed
    .some(item => item.pluginId === 'shipyard@shipyard');
  run('codex', ['plugin', 'marketplace', 'remove', 'shipyard']);
  try {
    run('codex', ['plugin', 'marketplace', 'add', source]);
    run('codex', ['plugin', 'add', 'shipyard@shipyard']);
  } catch (error) {
    try {
      run('codex', ['plugin', 'marketplace', 'remove', 'shipyard']);
      run('codex', ['plugin', 'marketplace', 'add', former]);
      if (hadPlugin) run('codex', ['plugin', 'add', 'shipyard@shipyard']);
    } catch (rollback) { throw new Error(`${error.message}; marketplace rollback failed: ${rollback.message}`); }
    throw error;
  }
}
function claudeMarketplaceMatches(existing, source) {
  if (!existing || existing.ref) return false;
  if (fs.existsSync(source)) return existing.source === 'directory' &&
    fs.existsSync(existing.path || '') && fs.realpathSync(existing.path) === fs.realpathSync(source);
  const github = source.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return !!github && existing.source === 'github' && existing.repo === github[1];
}
function claudeMarketplaceSource(existing) {
  if (existing.source === 'github' && existing.repo)
    return `${existing.repo}${existing.ref ? '@' + existing.ref : ''}`;
  if (existing.source === 'directory' && existing.path) return existing.path;
  if (existing.url) return existing.url;
  throw new Error('Cannot restore previous Claude marketplace source');
}
function installClaudeMarketplace(source, execute = run, read = capture) {
  const existing = read('claude', ['plugin', 'marketplace', 'list', '--json'])
    .find(item => item.name === 'shipyard');
  const installed = read('claude', ['plugin', 'list', '--json'])
    .find(item => item.id === 'shipyard@shipyard');
  if (claudeMarketplaceMatches(existing, source)) {
    execute('claude', ['plugin', 'marketplace', 'update', 'shipyard']);
    execute('claude', ['plugin', installed ? 'update' : 'install', 'shipyard@shipyard']);
    return;
  }
  // @contract: A pinned marketplace cannot be updated to an unpinned source in place.
  const former = existing && claudeMarketplaceSource(existing);
  if (existing) execute('claude', ['plugin', 'marketplace', 'remove', 'shipyard']);
  try {
    execute('claude', ['plugin', 'marketplace', 'add', source]);
    execute('claude', ['plugin', 'install', 'shipyard@shipyard']);
  } catch (error) {
    if (former) {
      try {
        const current = read('claude', ['plugin', 'marketplace', 'list', '--json']);
        if (current.some(item => item.name === 'shipyard'))
          execute('claude', ['plugin', 'marketplace', 'remove', 'shipyard']);
        execute('claude', ['plugin', 'marketplace', 'add', former]);
        if (installed) {
          execute('claude', ['plugin', 'install', 'shipyard@shipyard']);
          if (!installed.enabled) execute('claude', ['plugin', 'disable', 'shipyard@shipyard']);
        }
      } catch (rollback) { throw new Error(`${error.message}; marketplace rollback failed: ${rollback.message}`); }
    }
    throw error;
  }
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
  if (runtime === 'codex') installCodexMarketplace(source);
  else installClaudeMarketplace(source);
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
    // @contract: Claude host hooks and capability come from this release checkout.
    const root = path.resolve(__dirname, '..');
    run('bash', [path.join(root, 'scripts/ensure-gsd-core.sh'), 'claude']);
    const env = { ...process.env, SHIPYARD_GSD_AUTO_INSTALL: '0' };
    run('bash', [path.join(root, 'scripts/install-shipyard-claude-hook.sh')], env);
    run('bash', [path.join(root, 'scripts/install-shipyard-capability.sh'), 'claude'], env);
  }
}
module.exports = { main, claudeMarketplaceMatches, claudeMarketplaceSource, installClaudeMarketplace };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
