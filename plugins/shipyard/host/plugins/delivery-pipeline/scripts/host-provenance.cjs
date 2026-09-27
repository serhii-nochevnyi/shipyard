#!/usr/bin/env node
'use strict';

// @contract: Install provenance is a sidecar file, never a receipt field; its shape is frozen for both runtimes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'shipyard.host-provenance.v1';
const FILE = '.shipyard-provenance.json';
const KINDS = new Set(['release', 'dogfood']);

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 });
  return result.error || result.status !== 0 ? null : result.stdout;
}

function checkoutRoot(dir) {
  if (!fs.existsSync(dir)) return null;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top ? top.trim() : null;
}

function pluginVersion(pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

function freeze({ install_kind, version, source_sha, dirty }) {
  if (!KINDS.has(install_kind)) throw new Error(`install_kind must be release or dogfood, got ${install_kind}`);
  return Object.freeze({ schema: SCHEMA, install_kind, version: version || null,
    source_sha: source_sha || null, dirty: dirty === true });
}

function derive({ pluginRoot, version }) {
  const ver = version || pluginVersion(pluginRoot);
  const top = checkoutRoot(pluginRoot);
  if (!top) return freeze({ install_kind: 'release', version: ver, source_sha: null, dirty: false });
  const sha = (git(top, ['rev-parse', 'HEAD']) || '').trim() || null;
  const status = git(top, ['status', '--porcelain']);
  return freeze({ install_kind: 'dogfood', version: ver, source_sha: sha, dirty: status === null || status.trim() !== '' });
}

function readRecord(dir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return record && record.schema === SCHEMA ? freeze(record) : null;
  } catch {
    return null;
  }
}

function current({ pluginRoot }) {
  return readRecord(pluginRoot) || derive({ pluginRoot });
}

function fromEnv({ pluginRoot, version, env = process.env }) {
  if (env.SHIPYARD_INSTALL_KIND) {
    return freeze({ install_kind: env.SHIPYARD_INSTALL_KIND, version: version || pluginVersion(pluginRoot),
      source_sha: env.SHIPYARD_SOURCE_SHA || null, dirty: env.SHIPYARD_SOURCE_DIRTY === '1' });
  }
  return derive({ pluginRoot, version });
}

function writeInstallRecord(dir, record) {
  const file = path.join(dir, FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(freeze(record), null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  return file;
}

function isDogfood(p) {
  return !!p && p.install_kind === 'dogfood';
}

function cli(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument: ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  if (command !== 'record' || !opts['plugin-root'] || !opts.out) {
    throw new Error('usage: host-provenance.cjs record --plugin-root DIR --out DIR [--kind release|dogfood] [--version V]');
  }
  const env = opts.kind ? { ...process.env, SHIPYARD_INSTALL_KIND: opts.kind } : process.env;
  const record = opts.kind === 'dogfood' && !env.SHIPYARD_SOURCE_SHA
    ? { ...derive({ pluginRoot: opts['plugin-root'], version: opts.version }), install_kind: 'dogfood' }
    : fromEnv({ pluginRoot: opts['plugin-root'], version: opts.version, env });
  const file = writeInstallRecord(opts.out, record);
  process.stdout.write(`${file}\n`);
}

module.exports = { SCHEMA, FILE, current, derive, fromEnv, readRecord, writeInstallRecord, isDogfood, checkoutRoot };

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
