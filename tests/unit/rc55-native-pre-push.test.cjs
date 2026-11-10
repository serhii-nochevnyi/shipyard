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
