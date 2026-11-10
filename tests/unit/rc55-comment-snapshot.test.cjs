'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../plugins/delivery-pipeline/scripts/comment-policy.cjs');
const { fixture } = require('./rc55-fixture.cjs');

test('committed comments are checked against committed bytes after disk shortening', (t) => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  f.write('app.js', 'const value = 1;\nconst other = 2;\n// forbidden committed narration\n');
  f.commit('comment');
  f.write('app.js', 'const value = 1;\n');
  const report = policy.analyze(f.root, 'main');
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, ['app.js']);
  assert.equal(report.files[0].findings[0].line, 3);
  assert.equal(policy.analyze(f.root, 'main', { workingTree: true }).ok, true);
});

test('a pinned non-HEAD commit checks its own file even when disk has no such path', (t) => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  f.write('other.js', '// forbidden pushed narration\n');
  const pushed = f.commit('other branch');
  f.git('checkout', '-q', 'main');
  const report = policy.analyze(f.root, 'main', { head: pushed });
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, ['other.js']);
  assert.equal(policy.analyze(f.root, 'main').ok, true);
});
