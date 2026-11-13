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
  delete f.env.SHIPYARD_SCRIPTS;
  f.env.SHIPYARD_PUBLISH_GATE = path.join(root, 'plugins/delivery-pipeline/scripts/publish-gate.cjs');
  const hook = path.join(f.root, '.git/hooks/pre-push');
  const source = path.join(root, 'scripts/shipyard-pre-push-gate.sh');
  fs.writeFileSync(hook, '#!/bin/sh\nexec bash ' + "'" + source.replace(/'/g, "'\\''") + "'" + ' "$@"\n', { mode: 0o755 });
  f.git('checkout', '-qb', 'feature');
  return { ...f, extra, push: (...args) => spawnSync('git', args, { cwd: f.root, env: f.env, encoding: 'utf8' }) };
}

function withPr(f, baseRefName, headRefName = 'feature') {
  const rows = JSON.stringify([{ number: 7, baseRefName, headRefName }]);
  fs.writeFileSync(path.join(f.extra, 'gh'), "#!/bin/sh\nprintf '%s\\n' '" + rows + "'\n", { mode: 0o755 });
}

function publishFeature(f) {
  f.git('push', '--no-verify', '-q', 'origin', 'feature');
  return f.git('rev-parse', 'HEAD');
}

function advanceMain(f, file, content) {
  f.git('checkout', '-q', 'main');
  f.write(file, content);
  f.commit('main advances');
  f.git('push', '--no-verify', '-q', 'origin', 'main');
  f.git('checkout', '-q', 'feature');
}

function inheritMainCommentary(f) {
  f.write('docs/notes.md', '# Notes\n');
  f.commit('feature docs');
  const remoteHead = publishFeature(f);
  advanceMain(f, 'lib.js', 'const lib = 1;\n// inherited main commentary\n');
  f.git('merge', '-q', '--no-edit', 'origin/main');
  delete f.env.SHIPYARD_COMMENT_BASE;
  return remoteHead;
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

test('a base merge of commented main publishes a documentation-only PR diff', (t) => {
  const f = pushFixture(t);
  inheritMainCommentary(f);
  f.write('docs/notes.md', '# Notes\n\nAcceptance evidence.\n');
  f.commit('documentation only');
  withPr(f, 'main');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a base merge with a recorded board base also narrows to the ticket diff', (t) => {
  const f = pushFixture(t);
  f.git('checkout', '-q', 'main');
  f.write('.planning/graph/tickets.json', JSON.stringify({ tickets: { 'T-13-06': { branch: 'feature', pr_base: 'main' } } }));
  f.write('.planning/graph/delivery-state.json', JSON.stringify({ 'T-13-06': { branch: 'feature', base: 'main' } }));
  f.commit('graph');
  f.git('push', '--no-verify', '-q', 'origin', 'main');
  f.git('checkout', '-q', 'feature');
  f.git('merge', '-q', '--ff-only', 'main');
  inheritMainCommentary(f);
  f.env.SHIPYARD_GRAPH_DIR = path.join(f.root, '.planning/graph');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a base merge still rejects a forbidden comment in the ticket-owned change', (t) => {
  const f = pushFixture(t);
  const remoteHead = inheritMainCommentary(f);
  f.write('app.js', 'const value = 2;\n// feature commentary\n');
  f.commit('feature comment');
  withPr(f, 'main');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=origin/main base_source=pull-request push_base=' + remoteHead), result.stderr);
  assert.match(result.stderr, /app\.js:2/);
  assert.doesNotMatch(result.stderr, /lib\.js/);
});

test('a forbidden comment introduced by merge-conflict resolution is rejected', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 3;\n');
  f.commit('feature value');
  publishFeature(f);
  advanceMain(f, 'app.js', 'const value = 2;\n');
  assert.notEqual(f.push('merge', '--no-edit', 'origin/main').status, 0);
  f.write('app.js', 'const value = 4;\n// resolution commentary\n');
  f.commit('resolve conflict');
  delete f.env.SHIPYARD_COMMENT_BASE;
  withPr(f, 'main');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /base_source=pull-request/);
  assert.match(result.stderr, /app\.js:2/);
});

test('an incremental push with an open PR still rejects new commentary', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 2;\n');
  f.commit('feature');
  publishFeature(f);
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 3;\n// incremental commentary\n');
  f.commit('incremental comment');
  withPr(f, 'main');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /app\.js:2/);
});

test('an initial push with an open PR checks the full ticket diff', (t) => {
  const f = pushFixture(t);
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 3;\n// initial commentary\n');
  f.commit('initial comment');
  withPr(f, 'main');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /base=origin\/main base_source=pull-request/);
});

for (const [name, setup] of [
  ['no open PR or recorded base', () => {}],
  ['an unavailable PR base', (f) => withPr(f, 'missing')],
  ['a PR for another head', (f) => withPr(f, 'main', 'other')],
  ['an environment-only base', (f) => { f.env.SHIPYARD_COMMENT_BASE = 'main'; }],
]) test('a base merge with ' + name + ' keeps the remote range and blocks inherited commentary', (t) => {
  const f = pushFixture(t);
  const remoteHead = inheritMainCommentary(f);
  setup(f);
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=' + remoteHead + ' base_source=remote-oid'), result.stderr);
  assert.match(result.stderr, /lib\.js:2/);
});

test('a PR base that already contains the pushed head cannot hide new commentary', (t) => {
  const f = pushFixture(t);
  const remoteHead = publishFeature(f);
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 2;\n// shadowed commentary\n');
  f.commit('shadowed comment');
  f.git('push', '--no-verify', '-q', 'origin', 'HEAD:refs/heads/shadow');
  withPr(f, 'shadow');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=' + remoteHead + ' base_source=remote-oid'), result.stderr);
  assert.match(result.stderr, /app\.js:2/);
});

test('an unrelated PR base with an identical tree cannot hide new commentary', (t) => {
  const f = pushFixture(t);
  const remoteHead = publishFeature(f);
  delete f.env.SHIPYARD_COMMENT_BASE;
  f.write('app.js', 'const value = 2;\n// unrelated commentary\n');
  f.commit('unrelated comment');
  f.git('checkout', '-q', '--orphan', 'orphan');
  f.commit('orphan copy');
  f.git('push', '--no-verify', '-q', 'origin', 'orphan');
  f.git('checkout', '-q', 'feature');
  withPr(f, 'orphan');
  const result = f.push('push', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=' + remoteHead + ' base_source=remote-oid'), result.stderr);
});

test('a force push after a base merge keeps the direct remote range', (t) => {
  const f = pushFixture(t);
  f.write('app.js', 'const value = 2;\n');
  f.commit('feature');
  const remoteHead = publishFeature(f);
  advanceMain(f, 'lib.js', 'const lib = 1;\n// inherited main commentary\n');
  f.git('reset', '-q', '--hard', 'origin/main');
  f.write('docs/notes.md', '# Notes\n');
  f.commit('rewritten feature');
  delete f.env.SHIPYARD_COMMENT_BASE;
  withPr(f, 'main');
  const result = f.push('push', '--force', 'origin', 'feature');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('base=' + remoteHead + ' base_source=remote-oid'), result.stderr);
  assert.match(result.stderr, /lib\.js:2/);
});
