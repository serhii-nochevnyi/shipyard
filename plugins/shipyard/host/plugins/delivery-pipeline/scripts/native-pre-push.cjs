#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const publishGate = require('./publish-gate.cjs');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
}

function priorHook(config, name) {
  if (!config.previousHooksPath) return null;
  const file = path.resolve(process.cwd(), config.previousHooksPath, name);
  try {
    if (!fs.statSync(file).isFile()) return null;
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch { return null; }
}

function delegate(config, name, args, input) {
  const file = priorHook(config, name);
  if (!file) return 0;
  const result = spawnSync(file, args, input === undefined ? { stdio: 'inherit' }
    : { input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) throw new Error('prior hook failed: ' + result.error.message);
  return result.status === null ? 1 : result.status;
}

function parseUpdates(input) {
  if (input.length > 8 * 1024 * 1024) throw new Error('pre-push ref input exceeds 8 MiB');
  return input.toString('utf8').split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !fields[2].startsWith('refs/')
      || ![fields[1], fields[3]].every(oid => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) {
      throw new Error('invalid Git pre-push ref update');
    }
    return { localRef: fields[0], oid: fields[1], remoteRef: fields[2], remoteOid: fields[3] };
  });
}

function run(input, args, config = {}) {
  const prior = delegate(config, 'pre-push', args, input);
  if (prior !== 0) return prior;
  const updates = parseUpdates(input);
  const worktree = git(['rev-parse', '--show-toplevel']);
  if (config.commonRoot && fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== config.commonRoot) {
    throw new Error('native hook belongs to a different repository');
  }
  for (const update of updates) {
    if (/^0+$/.test(update.oid)) continue;
    if (!update.remoteRef.startsWith('refs/heads/')) {
      process.stderr.write('shipyard native pre-push: unmanaged non-branch ref ' + update.remoteRef + '\n');
      continue;
    }
    if (git(['cat-file', '-t', update.oid]) !== 'commit') throw new Error('branch update must name a commit');
    const argv = ['--managed', '--worktree', worktree, '--branch', update.remoteRef.slice('refs/heads/'.length), '--head', update.oid];
    for (const [name, value] of [['project-root', config.projectRoot || process.env.SHIPYARD_PROJECT_ROOT],
      ['graph', config.graphDir || process.env.SHIPYARD_GRAPH_DIR], ['fallback-base', config.base]]) {
      if (value) argv.push('--' + name, value);
    }
    const status = publishGate.main(argv);
    if (status !== 0) return status;
  }
  return 0;
}

function main(argv = process.argv.slice(2)) {
  let config = {};
  if (argv[0] === '--config') {
    const file = argv[1];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('native hook config must be a bounded regular file');
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.schema !== 'shipyard.native-git-hooks.v1') throw new Error('unsupported native hook configuration');
    argv = argv.slice(2);
  }
  if (argv[0] === '--delegate') return delegate(config, argv[1], argv.slice(2));
  return run(fs.readFileSync(0), argv, config);
}

module.exports = { run, main, parseUpdates };

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error('shipyard native pre-push: ' + error.message); process.exitCode = 2; }
}
