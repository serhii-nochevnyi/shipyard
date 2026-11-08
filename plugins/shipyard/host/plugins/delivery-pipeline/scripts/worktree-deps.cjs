'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const MANAGERS = Object.freeze([
  Object.freeze({ lock: 'pnpm-lock.yaml', program: 'pnpm', args: Object.freeze(['install', '--frozen-lockfile', '--ignore-scripts']) }),
  Object.freeze({ lock: 'package-lock.json', program: 'npm', args: Object.freeze(['ci', '--ignore-scripts']) }),
  Object.freeze({ lock: 'yarn.lock', program: 'yarn', args: Object.freeze(['install', '--frozen-lockfile', '--ignore-scripts']) }),
]);

function refusal(code, message) {
  const error = new Error('worktree-deps: ' + message);
  error.code = code;
  return error;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function pendingInstall(worktree) {
  if (!isFile(path.join(worktree, 'package.json')) || isDirectory(path.join(worktree, 'node_modules'))) return null;
  return MANAGERS.find((manager) => isFile(path.join(worktree, manager.lock))) || null;
}

function onPath(program, env) {
  return (env.PATH || '').split(path.delimiter).filter(Boolean).some((directory) => {
    try { fs.accessSync(path.join(directory, program), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function ensureDependencies(worktree, options = {}) {
  const manager = pendingInstall(worktree);
  if (!manager) return Object.freeze({ installed: false });
  const env = options.env || process.env;
  const command = `${manager.program} ${manager.args.join(' ')}`;
  if (!onPath(manager.program, env)) {
    throw refusal('DEPENDENCIES_UNAVAILABLE',
      `${worktree} has ${manager.lock} but no node_modules, and ${manager.program} is not on the host PATH; install ${manager.program} or run \`${command}\` in the worktree`);
  }
  const run = options.run || ((program, args, cwd) => execFileSync(program, args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }));
  try { run(manager.program, [...manager.args], worktree); }
  catch (error) {
    const detail = String(error.stderr || error.message || '').trim().split('\n').slice(-5).join(' | ').slice(0, 400);
    throw refusal('DEPENDENCIES_INSTALL_FAILED', `\`${command}\` failed in ${worktree}: ${detail}`);
  }
  return Object.freeze({ installed: true, program: manager.program, args: [...manager.args] });
}

module.exports = Object.freeze({ ensureDependencies, pendingInstall });
