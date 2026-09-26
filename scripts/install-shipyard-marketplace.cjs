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
function gitOut(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}
function inspectCheckout(source) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(source, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), 'utf8')).version;
  } catch {}
  const status = gitOut(source, ['status', '--porcelain']);
  return { version, sha: gitOut(source, ['rev-parse', 'HEAD']), dirty: status === null || status !== '',
    tagSha: version ? gitOut(source, ['rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`]) : null };
}
function isTaggedRelease(state) {
  return !state.dirty && !!state.sha && state.sha === state.tagSha;
}
function installKindEnv(source, inspect = inspectCheckout) {
  if (!fs.existsSync(source)) return { SHIPYARD_INSTALL_KIND: 'release' };
  const state = inspect(source);
  return { SHIPYARD_INSTALL_KIND: isTaggedRelease(state) ? 'release' : 'dogfood',
    SHIPYARD_SOURCE_SHA: state.sha || '', SHIPYARD_SOURCE_DIRTY: state.dirty ? '1' : '0' };
}
// @invariant: A Claude local install shares the release cache directory, so only the tagged clean release may use it.
function refuseUnreleasedClaudeSource(source, inspect = inspectCheckout) {
  if (!fs.existsSync(source)) return;
  const state = inspect(source);
  if (isTaggedRelease(state)) return;
  const reason = state.dirty ? 'has uncommitted changes' : `HEAD is not the commit tagged v${state.version}`;
  throw new Error(`Refusing local Claude marketplace source ${source}: it ${reason}, and a Claude local install ` +
    `overwrites the release cache of version ${state.version}. Run unreleased code with ` +
    'bash scripts/install-shipyard-claude-hook.sh --dogfood-root <dir>');
}
function codexMarketplaceSource(source) {
  if (fs.existsSync(source)) return { sourceType: 'local', source: fs.realpathSync(source) };
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return { sourceType: 'git', source: `https://github.com/${source}.git` };
  return { sourceType: 'git', source };
}
function installCodexMarketplace(source, execute = run, read = capture) {
  const existing = read('codex', ['plugin', 'marketplace', 'list', '--json'])
    .marketplaces.find(item => item.name === 'shipyard');
  const target = codexMarketplaceSource(source);
  const registered = existing?.marketplaceSource;
  if (!registered || registered.sourceType === target.sourceType && registered.source === target.source) {
    if (!registered || target.sourceType === 'local')
      execute('codex', ['plugin', 'marketplace', 'add', source]);
    else execute('codex', ['plugin', 'marketplace', 'upgrade', 'shipyard']);
    execute('codex', ['plugin', 'add', 'shipyard@shipyard']);
    return;
  }
  const former = registered.source;
  const hadPlugin = read('codex', ['plugin', 'list', '--json']).installed
    .some(item => item.pluginId === 'shipyard@shipyard');
  execute('codex', ['plugin', 'marketplace', 'remove', 'shipyard']);
  try {
    execute('codex', ['plugin', 'marketplace', 'add', source]);
    execute('codex', ['plugin', 'add', 'shipyard@shipyard']);
  } catch (error) {
    try {
      execute('codex', ['plugin', 'marketplace', 'remove', 'shipyard']);
      execute('codex', ['plugin', 'marketplace', 'add', former]);
      if (hadPlugin) execute('codex', ['plugin', 'add', 'shipyard@shipyard']);
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
function installClaudeMarketplace(source, execute = run, read = capture, inspect = inspectCheckout) {
  refuseUnreleasedClaudeSource(source, inspect);
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
function setupCodexHost(source, execute = run, read = capture, inspect = inspectCheckout,
  home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))) {
  let listed;
  try { listed = read('codex', ['plugin', 'list', '--json']); } catch { throw new Error('Cannot verify installed Shipyard plugin'); }
  const plugin = listed.installed.find(p => p.pluginId === 'shipyard@shipyard' && p.enabled);
  if (!plugin) throw new Error('Shipyard plugin is not installed and enabled');
  const cache = path.join(home, 'plugins/cache/shipyard/shipyard');
  const candidates = [plugin.version, 'local'].filter(Boolean).map(v => path.join(cache, v));
  const installed = candidates.find(p => fs.existsSync(path.join(p, 'package-build.json')));
  if (!installed) throw new Error('Marketplace Shipyard lacks native Codex packaging; update the marketplace source before continuing');
  execute(process.execPath, [path.join(installed, 'host/scripts/bootstrap-shipyard-plugin.cjs')],
    { ...process.env, ...installKindEnv(source, inspect) });
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
  if (runtime === 'codex') setupCodexHost(source);
  else {
    // @contract: Claude host hooks and capability come from this release checkout.
    const root = path.resolve(__dirname, '..');
    run('bash', [path.join(root, 'scripts/ensure-gsd-core.sh'), 'claude']);
    const env = { ...process.env, ...installKindEnv(source), SHIPYARD_GSD_AUTO_INSTALL: '0' };
    run('bash', [path.join(root, 'scripts/install-shipyard-claude-hook.sh')], env);
    run('bash', [path.join(root, 'scripts/install-shipyard-capability.sh'), 'claude'], env);
  }
}
module.exports = { main, installCodexMarketplace, claudeMarketplaceMatches,
  claudeMarketplaceSource, installClaudeMarketplace, installKindEnv, setupCodexHost };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
