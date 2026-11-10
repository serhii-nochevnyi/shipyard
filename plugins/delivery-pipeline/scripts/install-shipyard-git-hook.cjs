#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'shipyard.native-git-hooks.v1';
const HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist',
  'p4-pre-submit', 'post-index-change'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function git(worktree, args, env = process.env, optional = false) {
  env = { ...env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const result = spawnSync('git', ['-C', worktree, ...args], { env, encoding: 'utf8', timeout: 10000 });
  if (optional && result.status === 1) return null;
  if (result.error || result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (result.error?.message || result.stderr));
  return result.stdout.trim();
}

function filesIn(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = path.join(prefix, entry.name);
      if (entry.name === '.DS_Store') return [];
      if (entry.isDirectory()) return filesIn(root, relative);
      if (!entry.isFile()) throw new Error('hook payload contains a non-regular entry: ' + relative);
      return [relative];
    });
}

function payloadDigest(root) {
  const hash = crypto.createHash('sha256');
  for (const relative of filesIn(root)) hash.update(relative).update('\0').update(fs.readFileSync(path.join(root, relative))).update('\0');
  return hash.digest('hex');
}

function readInstall(hooksPath, commonRoot) {
  const relative = path.relative(path.join(commonRoot, 'shipyard', 'native-hooks', 'installs'), hooksPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const file = path.join(hooksPath, '..', 'config.json');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema !== SCHEMA) return null;
  if (value.commonRoot !== commonRoot) throw new Error('native hook installation belongs to another repository');
  return value;
}

function shim(adapter, configFile, name) {
  return '#!/bin/sh\n# shipyard-native-git-hook\nexec ' + quote(process.execPath) + ' ' + quote(adapter)
    + ' --config ' + quote(configFile) + (name === 'pre-push' ? '' : ' --delegate ' + quote(name)) + ' "$@"\n';
}

function sourceScripts(supplied) {
  const candidates = [supplied, process.env.SHIPYARD_SCRIPTS, __dirname].filter(Boolean);
  const result = candidates.find(root => fs.existsSync(path.join(root, 'native-pre-push.cjs'))
    && fs.existsSync(path.join(root, 'publish-gate.cjs')));
  if (!result) throw new Error('native hook scripts unavailable; set SHIPYARD_SCRIPTS or --scripts');
  return fs.realpathSync(result);
}

function setup(options) {
  const env = options.env || process.env;
  const worktree = fs.realpathSync(git(options.worktree || process.cwd(), ['rev-parse', '--show-toplevel'], env));
  const commonRoot = fs.realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env));
  const configured = git(worktree, ['config', '--path', '--get', 'core.hooksPath'], env, true);
  const hooksPath = configured === null
    ? git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], env)
    : path.resolve(worktree, configured);
  return { env, worktree, commonRoot, hooksPath,
    hooksSpec: configured === null ? hooksPath : configured, old: readInstall(hooksPath, commonRoot) };
}

function install(options = {}) {
  const { env, worktree, commonRoot, hooksSpec, old } = setup(options);
  const scripts = sourceScripts(options.scriptsRoot);
  const bundleHash = payloadDigest(scripts);
  const stateRoot = path.join(commonRoot, 'shipyard', 'native-hooks');
  const bundles = path.join(stateRoot, 'bundles');
  const bundle = path.join(bundles, bundleHash);
  fs.mkdirSync(bundles, { recursive: true });
  if (!fs.existsSync(bundle)) {
    const temporary = fs.mkdtempSync(path.join(bundles, '.prepare-'));
    try {
      fs.cpSync(scripts, temporary, { recursive: true, dereference: false });
      if (payloadDigest(temporary) !== bundleHash) throw new Error('hook source changed while preparing installation');
      try { fs.renameSync(temporary, bundle); }
      catch (error) { if (!fs.existsSync(bundle)) throw error; }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (payloadDigest(bundle) !== bundleHash) throw new Error('installed native hook payload was altered');
  const scope = old?.configScope || (git(worktree, ['config', '--bool', '--get', 'extensions.worktreeConfig'], env, true) === 'true'
    ? '--worktree' : '--local');
  const originalConfigValue = old ? old.originalConfigValue : git(worktree, ['config', scope, '--get', 'core.hooksPath'], env, true);
  const previousHooksPath = old ? old.previousHooksPath : hooksSpec;
  const previousDirectory = path.resolve(worktree, previousHooksPath);
  const names = [...new Set([...HOOKS, ...(fs.existsSync(previousDirectory) && fs.statSync(previousDirectory).isDirectory()
    ? fs.readdirSync(previousDirectory).filter(name => /^[a-z][a-z0-9-]*$/.test(name)) : [])])].sort();
  const config = { schema: SCHEMA, commonRoot, previousHooksPath, configScope: scope, originalConfigValue,
    projectRoot: path.resolve(options.projectRoot || old?.projectRoot || worktree),
    graphDir: options.graphDir ? path.resolve(options.graphDir) : old?.graphDir || null,
    base: options.base || old?.base || null, bundleHash, hooks: names };
  const directory = path.join(stateRoot, 'installs', digest(JSON.stringify(config)));
  const configFile = path.join(directory, 'config.json');
  const adapter = path.join(bundle, 'native-pre-push.cjs');
  fs.mkdirSync(path.join(directory, 'hooks'), { recursive: true });
  const body = JSON.stringify(config, null, 2) + '\n';
  if (fs.existsSync(configFile) && fs.readFileSync(configFile, 'utf8') !== body) throw new Error('native hook configuration was altered');
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, body, { mode: 0o600, flag: 'wx' });
  for (const name of names) {
    const file = path.join(directory, 'hooks', name);
    const content = shim(adapter, configFile, name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== content) throw new Error('managed hook was altered: ' + name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content, { mode: 0o755, flag: 'wx' });
  }
  git(worktree, ['config', scope, 'core.hooksPath', path.join(directory, 'hooks')], env);
  const effective = git(worktree, ['config', '--path', '--get', 'core.hooksPath'], env);
  if (path.resolve(worktree, effective) !== path.join(directory, 'hooks')) {
    if (originalConfigValue === null) git(worktree, ['config', scope, '--unset', 'core.hooksPath'], env);
    else git(worktree, ['config', scope, 'core.hooksPath', originalConfigValue], env);
    throw new Error('a higher-priority core.hooksPath prevents native hook installation');
  }
  return { installed: true, worktree, hooksPath: path.join(directory, 'hooks'), bundleHash, previousHooksPath };
}

function uninstall(options = {}) {
  const { env, worktree, hooksPath, old } = setup(options);
  if (!old) throw new Error('the effective hooks path is not a Shipyard native installation');
  const adapter = path.join(old.commonRoot, 'shipyard', 'native-hooks', 'bundles', old.bundleHash, 'native-pre-push.cjs');
  const configFile = path.resolve(hooksPath, '..', 'config.json');
  for (const name of old.hooks) {
    if (fs.readFileSync(path.join(hooksPath, name), 'utf8') !== shim(adapter, configFile, name)) {
      throw new Error('refusing to replace a modified managed hook: ' + name);
    }
  }
  if (old.originalConfigValue === null) git(worktree, ['config', old.configScope, '--unset', 'core.hooksPath'], env);
  else git(worktree, ['config', old.configScope, 'core.hooksPath', old.originalConfigValue], env);
  return { installed: false, worktree, retainedPayload: path.dirname(hooksPath) };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] === 'uninstall' ? argv.shift() : 'install';
  if (argv[0] === 'install') argv.shift();
  const options = {};
  const fields = { '--worktree': 'worktree', '--project-root': 'projectRoot', '--graph': 'graphDir',
    '--base': 'base', '--scripts': 'scriptsRoot' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!fields[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('unknown or incomplete native hook option: ' + argv[i]);
    options[fields[argv[i]]] = argv[i + 1];
  }
  console.log(JSON.stringify(command === 'uninstall' ? uninstall(options) : install(options)));
}

module.exports = { install, uninstall, payloadDigest, HOOKS, main };
if (require.main === module) {
  try { main(); } catch (error) { console.error('install-shipyard-git-hook: ' + error.message); process.exitCode = 1; }
}
