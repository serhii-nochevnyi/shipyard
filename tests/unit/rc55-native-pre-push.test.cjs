'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./rc55-fixture.cjs');
const root = path.resolve(__dirname, '../..');

function pushFixture(t) {
  const f = fixture(t);
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-push-'));
  t.after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const remote = path.join(extra, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote], { env: f.env }).status, 0);
  f.git('remote', 'set-url', 'origin', remote);
  f.git('push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(extra, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.env.PATH = extra + path.delimiter + f.env.PATH;
  f.env.SHIPYARD_COMMENT_BASE = 'main';
  f.env.SHIPYARD_PUBLISH_GATE = path.join(root, 'plugins/delivery-pipeline/scripts/publish-gate.cjs');
  const hook = path.join(f.root, '.git/hooks/pre-push');
  const source = path.join(root, 'scripts/shipyard-pre-push-gate.sh');
  fs.writeFileSync(hook, '#!/bin/sh\nexec bash ' + "'" + source.replace(/'/g, "'\\''") + "'" + ' "$@"\n', { mode: 0o755 });
  f.git('checkout', '-qb', 'feature');
  return { ...f, push: (...args) => spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' }) };
}

test('a real push with global Git flags rejects committed comments despite clean disk', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 1;\n// forbidden committed commentary\n');
  f.commit('comment');
  f.write('app.js', 'const value = 1;\n');
  const result = f.push('--no-pager', '-C', f.root, 'push', 'origin', 'feature');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /app\.js:2/);
  assert.match(result.stderr, /base=.*main.*base_source=env/);
});

test('a real push checks a non-HEAD ref and ignores dirty disk commentary', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 2;\n');
  f.commit('valid feature');
  f.git('checkout', '-q', 'main');
  f.write('app.js', '// dirty commentary is not being pushed\n');
  const result = f.push('push', 'origin', 'feature:feature');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a subsequent push without a base override ignores already published epic comments', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 1;\n// accepted epic history\n');
  f.commit('published epic history');
  f.git('push', '--no-verify', '-q', 'origin', 'feature');
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 2;\n// accepted epic history\n');
  f.commit('new code only');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a subsequent push still rejects comments added beyond the remote commit', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 1;\n// accepted epic history\n');
  const remoteHead = f.commit('published epic history');
  f.git('push', '--no-verify', '-q', 'origin', 'feature');
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 2;\n// accepted epic history\n// new forbidden comment\n');
  f.commit('new comment');
  const result = f.push('push', 'origin', 'feature');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /app\.js:3/);
  assert.ok(result.stderr.includes('base=' + remoteHead + ' base_source=remote-oid'), result.stderr);
});

test('a force push compares the destination tree directly rather than its merge base', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 1;\n// accepted epic history\n');
  f.commit('published epic history');
  f.git('push', '--no-verify', '-q', 'origin', 'feature');
  f.git('reset', '--hard', f.base);
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 2;\n// accepted epic history\n');
  f.commit('rewritten code only');
  const result = f.push('push', '--force', 'origin', 'feature');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('an unavailable remote object refuses with fetch guidance instead of falling back to main', (t) => {
  const f = pushFixture(t);
  const oid = f.git('rev-parse', 'HEAD');
  const result = spawnSync(process.execPath, [path.join(root, 'plugins/delivery-pipeline/scripts/native-pre-push.cjs')], {
    cwd: f.root, env: f.env, encoding: 'utf8',
    input: 'refs/heads/feature ' + oid + ' refs/heads/feature ' + 'a'.repeat(40) + '\n',
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /remote push base.*not available locally.*fetch/i);
});

test('each ref in a multi-branch push uses its own remote commit', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 1;\n// first published history\n');
  f.commit('first history');
  f.git('checkout', '-qb', 'other', f.base);
  f.write('app.js', 'const other = 1;\n// second published history\n');
  const otherHead = f.commit('second history');
  f.git('push', '--no-verify', '-q', 'origin', 'feature', 'other');
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.git('checkout', '-q', 'feature');
  f.write('app.js', 'const value = 2;\n// first published history\n');
  f.commit('valid first update');
  f.git('checkout', '-q', 'other');
  f.write('app.js', 'const other = 2;\n// second published history\n// forbidden second update\n');
  f.commit('invalid second update');
  const result = f.push('push', 'origin', 'feature', 'other');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=' + otherHead + ' base_source=remote-oid'), result.stderr);
  assert.match(result.stderr, /app\.js:3/);
  assert.doesNotMatch(result.stderr, /app\.js:2/);
});
