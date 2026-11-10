'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

for (const key of ['COMMENT_POLICY_BASE', 'SHIPYARD_COMMENT_BASE', 'GITHUB_BASE_REF',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete process.env[key];

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard rc55-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', COMMENT_POLICY_BASE: '', SHIPYARD_COMMENT_BASE: '', GITHUB_BASE_REF: '' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'RC55 test');
  git('config', 'user.email', 'rc55@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const commit = (message) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  write('app.js', 'const value = 1;\n');
  const base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return { root, env, git, write, commit, base };
}

function pushFixture(t) {
  const f = fixture(t);
  const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard push-')));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const remote = path.join(extra, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { env: f.env });
  f.git('remote', 'set-url', 'origin', remote);
  f.git('push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(extra, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.env.PATH = extra + path.delimiter + f.env.PATH;
  f.env.SHIPYARD_COMMENT_BASE = 'main';
  f.git('checkout', '-qb', 'feature');
  return { ...f, extra, remote,
    push: (...args) => spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' }) };
}

module.exports = { fixture, pushFixture };
