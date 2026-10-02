#!/usr/bin/env node
'use strict';

// @contract: Install GSD and Shipyard marketplace plugins in one explicit setup.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ensure } = require('./ensure-gsd-plugin.cjs');
function isolatedEnvironment(runtime, env, home) {
  for (const key of runtime === 'codex' ? ['CODEX_HOME'] : ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'])
    if (env[key] !== undefined && (!env[key] || !path.isAbsolute(env[key]))) throw new Error(`isolation refusal: absolute ${key} required`);
  const defaultHome = path.join(env.HOME || os.homedir(), `.${runtime}`);
  if (!Object.hasOwn(env, 'SHIPYARD_ISOLATION_ROOT') && !env.SHIPYARD_DOGFOOD_ROOT
    && env.SHIPYARD_INSTALL_KIND !== 'dogfood' && path.resolve(home) === path.resolve(defaultHome)) return env;
  const envelope = env.SHIPYARD_ISOLATION_ROOT ?? (runtime === 'codex' ? home : '');
  const result = spawnSync('bash', [path.join(__dirname, 'ensure-gsd-core.sh'), '--isolation-env', runtime, envelope],
    { env, encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || `isolation refusal: ${result.error?.message}`);
  return { ...env, ...JSON.parse(result.stdout).environment };
}
function prepareDirectories(env) {
  if (!env.SHIPYARD_ISOLATION_ROOT) return;
  for (const key of ['HOME', 'TMPDIR', 'npm_config_cache', 'npm_config_prefix'])
    fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.status}`);
}
function capture(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, env });
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
  const env = { SHIPYARD_INSTALL_KIND: isTaggedRelease(state) ? 'release' : 'dogfood',
    SHIPYARD_SOURCE_SHA: state.sha || '', SHIPYARD_SOURCE_DIRTY: state.dirty ? '1' : '0' };
  if (env.SHIPYARD_INSTALL_KIND === 'dogfood') env.SHIPYARD_SOURCE_ROOT = fs.realpathSync(source);
  return env;
}
// @contract: Formula shared with install-shipyard-codex.sh's own dogfood-root fallback.
function userHome(env = process.env) {
  return path.resolve(env.HOME || os.homedir());
}
function dogfoodHome(runtime, sourceRoot, env = process.env) {
  const digest = crypto.createHash('sha256').update(sourceRoot).digest('hex').slice(0, 16);
  const base = env.XDG_STATE_HOME || path.join(userHome(env), '.local', 'state');
  return path.resolve(base, 'shipyard', 'dogfood', runtime, digest);
}
function samePath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync(resolved); } catch { return resolved; }
  };
  return canonical(left) === canonical(right);
}
function selectCodexTarget(source, baseEnv = process.env, inspect = inspectCheckout, { pinDefaultHome = false } = {}) {
  if (baseEnv.CODEX_HOME !== undefined && (!baseEnv.CODEX_HOME || !path.isAbsolute(baseEnv.CODEX_HOME)))
    throw new Error('isolation refusal: absolute CODEX_HOME required');
  const kindEnv = installKindEnv(source, inspect);
  let env = { ...baseEnv, ...kindEnv };
  const hasExplicitHome = typeof baseEnv.CODEX_HOME === 'string' && baseEnv.CODEX_HOME.length > 0;
  const sharedDefault = path.join(userHome(baseEnv), '.codex');
  let home = hasExplicitHome ? path.resolve(baseEnv.CODEX_HOME) : sharedDefault;

  if (env.SHIPYARD_INSTALL_KIND === 'dogfood') {
    const dedicated = dogfoodHome('codex', env.SHIPYARD_SOURCE_ROOT, baseEnv);
    if (hasExplicitHome && samePath(home, sharedDefault)) {
      throw new Error(`Refusing dogfood Codex source ${source}: CODEX_HOME is the shared default ` +
        `${sharedDefault}, and a dogfood install there overwrites the release cache other sessions use. ` +
        `Unset CODEX_HOME to use the dedicated ${dedicated}, or set CODEX_HOME="${dedicated}" directly.`);
    }
    if (!hasExplicitHome) {
      home = dedicated;
      delete env.XDG_STATE_HOME;
      console.log(`→ dogfood Codex home: ${dedicated}`);
      console.log(`  export CODEX_HOME="${dedicated}"`);
    }
  }

  // @invariant: Marketplace, ensure and bootstrap children use the selected CODEX_HOME.
  if (hasExplicitHome || env.SHIPYARD_INSTALL_KIND === 'dogfood' || pinDefaultHome) env.CODEX_HOME = home;
  else delete env.CODEX_HOME;
  env = isolatedEnvironment('codex', env, home);
  prepareDirectories(env);
  if (env.SHIPYARD_INSTALL_KIND === 'dogfood') fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { env, home };
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
function installCodexMarketplace(source, execute = run, read = capture, env = process.env) {
  env = isolatedEnvironment('codex', env, env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
  prepareDirectories(env);
  const executeOriginal = execute;
  execute = (command, args) => {
    env = isolatedEnvironment('codex', env, env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
    try { return executeOriginal(command, args, env); }
    finally { env = isolatedEnvironment('codex', env, env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')); }
  };
  const existing = read('codex', ['plugin', 'marketplace', 'list', '--json'], env)
    .marketplaces.find(item => item.name === 'shipyard');
  const target = codexMarketplaceSource(source);
  const registered = existing?.marketplaceSource;
  if (!registered || registered.sourceType === target.sourceType && registered.source === target.source) {
    if (!registered || target.sourceType === 'local')
      execute('codex', ['plugin', 'marketplace', 'add', source], env);
    else execute('codex', ['plugin', 'marketplace', 'upgrade', 'shipyard'], env);
    execute('codex', ['plugin', 'add', 'shipyard@shipyard'], env);
    return;
  }
  const former = registered.source;
  const hadPlugin = read('codex', ['plugin', 'list', '--json'], env).installed
    .some(item => item.pluginId === 'shipyard@shipyard');
  execute('codex', ['plugin', 'marketplace', 'remove', 'shipyard'], env);
  try {
    execute('codex', ['plugin', 'marketplace', 'add', source], env);
    execute('codex', ['plugin', 'add', 'shipyard@shipyard'], env);
  } catch (error) {
    try {
      execute('codex', ['plugin', 'marketplace', 'remove', 'shipyard'], env);
      execute('codex', ['plugin', 'marketplace', 'add', former], env);
      if (hadPlugin) execute('codex', ['plugin', 'add', 'shipyard@shipyard'], env);
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
function installClaudeMarketplace(source, execute = run, read = capture, inspect = inspectCheckout, env = process.env) {
  refuseUnreleasedClaudeSource(source, inspect);
  env = isolatedEnvironment('claude', env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
  prepareDirectories(env);
  const executeOriginal = execute, readOriginal = read;
  execute = (command, args) => {
    env = isolatedEnvironment('claude', env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
    try { return executeOriginal(command, args, env); }
    finally { env = isolatedEnvironment('claude', env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude')); }
  };
  read = (command, args) => readOriginal(command, args, env);
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
  pluginHome, baseEnv = process.env, selection) {
  const target = selection || selectCodexTarget(source, baseEnv, inspect);
  const env = target.env;
  const home = path.resolve(pluginHome || target.home);
  let listed;
  try { listed = read('codex', ['plugin', 'list', '--json'], env); } catch { throw new Error('Cannot verify installed Shipyard plugin'); }
  const plugin = listed.installed.find(p => p.pluginId === 'shipyard@shipyard' && p.enabled);
  if (!plugin) throw new Error('Shipyard plugin is not installed and enabled');
  const cache = path.join(home, 'plugins/cache/shipyard/shipyard');
  const candidates = [plugin.version, 'local'].filter(Boolean).map(v => path.join(cache, v));
  const installed = candidates.find(p => fs.existsSync(path.join(p, 'package-build.json')));
  if (!installed) throw new Error('Marketplace Shipyard lacks native Codex packaging; update the marketplace source before continuing');
  execute(process.execPath, [path.join(installed, 'host/scripts/bootstrap-shipyard-plugin.cjs')], env);
}
function ensureWithEnvironment(runtime, env, ensureRuntime, runCommand = run) {
  if (ensureRuntime === ensure) {
    // @contract: Run the unchanged ensure helper with CODEX_HOME supplied as child env.
    runCommand(process.execPath, [path.join(__dirname, 'ensure-gsd-plugin.cjs'), runtime], env);
    return;
  }
  return ensureRuntime(runtime, env);
}
function main(args, commands = {}) {
  const runtime = args.shift();
  if (!['claude', 'codex'].includes(runtime)) throw new Error('Usage: node scripts/install-shipyard-marketplace.cjs <claude|codex> [--source <marketplace-root-or-git-url>]');
  let source = 'serhii-nochevnyi/shipyard';
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--source' || !args[1]) throw new Error('Expected --source <marketplace-root-or-git-url>');
    source = args[1];
  }
  let env = commands.env || process.env;
  const inspect = commands.inspect || inspectCheckout;
  const execute = commands.execute || run;
  const read = commands.read || capture;
  const ensureRuntime = commands.ensure || ensure;
  const runCommand = commands.run || run;
  if (runtime === 'codex') {
    const selected = selectCodexTarget(source, env, inspect, { pinDefaultHome: true });
    ensureWithEnvironment(runtime, selected.env, ensureRuntime, runCommand);
    selected.env = isolatedEnvironment(runtime, selected.env, selected.home);
    installCodexMarketplace(source, execute, read, selected.env);
    selected.env = isolatedEnvironment(runtime, selected.env, selected.home);
    setupCodexHost(source, execute, read, inspect, undefined, selected.env, selected);
    return;
  }
  refuseUnreleasedClaudeSource(source, inspect);
  env = isolatedEnvironment(runtime, env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
  prepareDirectories(env);
  ensureWithEnvironment(runtime, env, ensureRuntime, runCommand);
  env = isolatedEnvironment(runtime, env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
  installClaudeMarketplace(source, execute, read, inspect, env);
  env = isolatedEnvironment(runtime, env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
  // @contract: Claude host hooks and capability come from this release checkout.
  const root = path.resolve(__dirname, '..');
  run('bash', [path.join(root, 'scripts/ensure-gsd-core.sh'), 'claude'], env);
  env = isolatedEnvironment(runtime, env, env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(env.HOME || os.homedir(), '.claude'));
  let claudeEnv = { ...env, ...installKindEnv(source), SHIPYARD_GSD_AUTO_INSTALL: '0' };
  run('bash', [path.join(root, 'scripts/install-shipyard-claude-hook.sh')], claudeEnv);
  claudeEnv = isolatedEnvironment(runtime, claudeEnv, claudeEnv.CLAUDE_CONFIG_DIR || claudeEnv.CLAUDE_HOME || path.join(claudeEnv.HOME || os.homedir(), '.claude'));
  run('bash', [path.join(root, 'scripts/install-shipyard-capability.sh'), 'claude'], claudeEnv);
}
module.exports = { main, installCodexMarketplace, claudeMarketplaceMatches,
  claudeMarketplaceSource, installClaudeMarketplace, installKindEnv, setupCodexHost, dogfoodHome,
  selectCodexTarget };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
