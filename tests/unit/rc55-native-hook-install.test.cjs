'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install, uninstall } = require('../../plugins/delivery-pipeline/scripts/install-shipyard-git-hook.cjs');
const { pushFixture } = require('./rc55-fixture.cjs');

test('native install preserves original hook basename, stdin, argv and other hook execution', (t) => {
  const f = pushFixture(t);
  f.git('config', 'core.hooksPath', '.hooks');
  f.write('.hooks/pre-push', '#!/bin/sh\nprintf "%s\\n" "$(basename "$0")" "$@" > "$CAPTURE"\ncat >> "$CAPTURE"\n');
  f.write('.hooks/pre-commit', '#!/bin/sh\nprintf prior > "$COMMIT_CAPTURE"\n');
  for (const name of ['pre-push', 'pre-commit']) fs.chmodSync(path.join(f.root, '.hooks', name), 0o755);
  f.env.CAPTURE = path.join(f.extra, 'push-capture');
  f.env.COMMIT_CAPTURE = path.join(f.extra, 'commit-capture');
  const before = fs.readFileSync(path.join(f.root, '.hooks/pre-push'));
  const installed = install({ worktree: f.root, env: f.env, base: 'main' });
  f.write('app.js', 'const value = 2;\n');
  const head = f.commit('valid');
  const result = f.push('--no-pager', '-C', f.root, 'push', 'origin', 'feature');
  assert.equal(result.status, 0, result.stderr);
  const capture = fs.readFileSync(f.env.CAPTURE, 'utf8');
  assert.ok(capture.startsWith('pre-push\norigin\n' + f.remote + '\n'), capture);
  assert.ok(capture.includes('refs/heads/feature ' + head + ' refs/heads/feature '), capture);
  assert.equal(fs.readFileSync(f.env.COMMIT_CAPTURE, 'utf8'), 'prior');
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.hooks/pre-push')), before);
  assert.notEqual(installed.hooksPath, path.join(f.root, '.hooks'));
  uninstall({ worktree: f.root, env: f.env });
  assert.equal(f.git('config', '--get', 'core.hooksPath'), '.hooks');
});

test('idempotent installation leaves live payload/config bytes and timestamps unchanged', (t) => {
  const f = pushFixture(t);
  const first = install({ worktree: f.root, env: f.env, base: 'main' });
  const config = path.resolve(first.hooksPath, '../config.json');
  const hook = path.join(first.hooksPath, 'pre-push');
  const times = [fs.statSync(config).mtimeMs, fs.statSync(hook).mtimeMs];
  const second = install({ worktree: f.root, env: f.env, base: 'main' });
  assert.deepEqual(second, first);
  assert.deepEqual([fs.statSync(config).mtimeMs, fs.statSync(hook).mtimeMs], times);
});

test('a linked worktree keeps relative prior hooks relative to its own root', (t) => {
  const f = pushFixture(t);
  f.env.CAPTURE = path.join(f.extra, 'capture');
  f.git('config', 'core.hooksPath', '.hooks');
  f.write('.hooks/pre-push', '#!/bin/sh\nprintf root > "$CAPTURE"\n');
  fs.chmodSync(path.join(f.root, '.hooks/pre-push'), 0o755);
  f.commit('prior hook');
  const linked = path.join(f.extra, 'linked worktree');
  f.git('worktree', 'add', '-q', '-b', 'side', linked);
  fs.writeFileSync(path.join(linked, '.hooks/pre-push'), '#!/bin/sh\nprintf linked > "$CAPTURE"\n');
  fs.chmodSync(path.join(linked, '.hooks/pre-push'), 0o755);
  install({ worktree: f.root, env: f.env, base: 'main' });
  const result = f.push('-C', linked, 'push', 'origin', 'side');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.env.CAPTURE, 'utf8'), 'linked');
});

test('prior veto still blocks a real push and uninstall refuses altered shims', (t) => {
  const f = pushFixture(t);
  f.write('.git/hooks/pre-push', '#!/bin/sh\necho prior-veto >&2\nexit 23\n');
  fs.chmodSync(path.join(f.root, '.git/hooks/pre-push'), 0o755);
  const installed = install({ worktree: f.root, env: f.env, base: 'main' });
  const result = f.push('push', 'origin', 'feature');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior-veto/);
  fs.appendFileSync(path.join(installed.hooksPath, 'pre-push'), '\necho modified\n');
  assert.throws(() => uninstall({ worktree: f.root, env: f.env }), /modified managed hook/);
  assert.equal(f.git('config', '--get', 'core.hooksPath'), installed.hooksPath);
});

test('legacy tool payload does not infer or block a Bash variable expansion', (t) => {
  const f = pushFixture(t);
  const wrapper = path.resolve(__dirname, '../../scripts/shipyard-pre-push-gate.sh');
  const result = spawnSync('bash', [wrapper], { cwd: f.root, env: f.env, encoding: 'utf8',
    input: JSON.stringify({ cwd: f.root, tool_input: { command: 'git -C "$W" push' } }) });
  assert.equal(result.status, 0, result.stderr);
});

test('installed native payload survives source-cache removal and rejects a mixed multi-ref push atomically', t => {
  const f = pushFixture(t);
  const cache = path.join(f.extra, 'prunable cache/scripts');
  fs.cpSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts'), cache, { recursive: true });
  install({ worktree: f.root, env: f.env, scriptsRoot: cache, base: 'main' });
  fs.rmSync(path.dirname(cache), { recursive: true, force: true });
  f.write('app.js', 'const value = 2;\n'); f.commit('valid');
  f.git('branch', 'safe');
  f.write('app.js', '// forbidden\nconst value = 3;\n'); f.commit('blocked');
  const result = f.push('push', '--atomic', 'origin', 'safe:safe', 'feature:feature');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /app\.js:1/);
  assert.throws(() => f.git('ls-remote', '--exit-code', 'origin', 'refs/heads/safe'));
  f.git('checkout', '-q', 'safe');
  assert.equal(f.push('push', 'origin', 'safe:safe').status, 0);
  assert.equal(f.push('push', 'origin', ':safe').status, 0);
});

test('higher-priority hooksPath override refuses installation and restores local config', t => {
  const f = pushFixture(t);
  f.git('config', 'core.hooksPath', '.original');
  const env = { ...f.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.override' };
  assert.throws(() => install({ worktree: f.root, env, base: 'main' }), /higher|effective|override/);
  assert.equal(f.git('config', '--local', '--get', 'core.hooksPath'), '.original');
});

test('a differently named source branch resolves the destination PR and graph identity', t => {
  const f = pushFixture(t);
  f.git('checkout', '-qb', 'epic');
  f.write('app.js', '// preexisting epic commentary\nconst value=2;\n');
  const epic = f.commit('epic'); f.git('update-ref', 'refs/remotes/origin/epic', epic);
  f.git('checkout', '-qb', 'local-work');
  f.write('other.js', 'const clean=1;\n'); f.commit('valid work');
  fs.writeFileSync(path.join(f.extra, 'gh'), '#!/bin/sh\ncase " $* " in\n  *" --head feature "*) printf \'[{"headRefName":"feature","baseRefName":"epic"}]\';;\n  *) printf \'[]\';;\nesac\n', { mode: 0o755 });
  delete f.env.SHIPYARD_COMMENT_BASE;
  install({ worktree: f.root, env: f.env, base: 'main' });
  const pushed = f.push('push', 'origin', 'local-work:feature');
  assert.equal(pushed.status, 0, pushed.stderr);
});
