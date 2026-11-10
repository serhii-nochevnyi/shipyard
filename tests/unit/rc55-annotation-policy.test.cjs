'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const policy = require('../../plugins/delivery-pipeline/scripts/comment-policy.cjs');
const { fixture } = require('./rc55-fixture.cjs');

const PHP = ['<?php', '// @ai-generated', 'class Example {', '/**', ' * Return the selected proxy.',
  ' * @return ClassProxy', ' */', 'public function proxy() {}', '/**', ' * @dataProvider cases', ' */',
  'public function testValid($case) {}', 'public function execute() {', '/** @var ClassProxy $proxy */',
  '$proxy = $this->proxy();', '}', '}', ''].join('\n');
const RULE = { tags: ['@ai-generated', '@dataProvider', '@var', '@return'], public_methods: true };

function configured(t, repo = 'acme/app', rule = RULE, body = PHP) {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  f.write('.planning/config.json', JSON.stringify({ pipeline: { comment_docblocks: { [repo]: rule } } }));
  f.write('Example.php', body);
  f.commit('functional documentation');
  return f;
}

test('repository opt-in preserves functional tags and bounded public method PHPDoc', (t) => {
  const f = configured(t);
  const report = policy.analyze(f.root, 'main', { projectRoot: f.root });
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.ok(report.totals.protected_comment_lines > 5);
});

test('docblock allowances do not apply to other repositories or malformed rules', (t) => {
  for (const [repo, rule] of [['other/app', RULE], ['acme/app', { ...RULE, public_methods: 'true' }]]) {
    const f = configured(t, repo, rule);
    assert.equal(policy.analyze(f.root, 'main', { projectRoot: f.root }).ok, false);
  }
});

test('unknown tags, historical narration and private method prose remain refused', (t) => {
  for (const body of [
    '<?php\n/**\n * @dataProvider cases\n * because old ticket PDF-123 needed this\n */\npublic function testValid() {}\n',
    '<?php\n/**\n * @unlisted annotation\n */\npublic function testValid() {}\n',
    '<?php\n/**\n * Describe private details.\n */\nprivate function details() {}\n',
  ]) {
    const f = configured(t, 'acme/app', RULE, body);
    assert.equal(policy.analyze(f.root, 'main', { projectRoot: f.root }).ok, false);
  }
});

test('cleanup removes an unrelated added comment while retaining configured functional documentation', (t) => {
  const f = configured(t, 'acme/app', RULE, PHP + '// explain this change\n');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/comment-policy.cjs'),
    'clean', 'T-55-05', '--worktree', f.root, '--base', 'main', '--project-root', f.root, '--apply', '--json'],
  { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'Example.php'), 'utf8'), PHP);
});

test('empty functional annotations and line-comment return prose remain findings', t => {
  for (const body of ['<?php\n/** @var */\n', '<?php\n// @return This is purely explanatory prose rather than a type\n',
    '<?php\n/** @param string */\n', '<?php\n/** @throws */\n']) {
    const f = configured(t, 'acme/app', { tags: ['@var', '@return', '@param', '@throws'], public_methods: false }, body);
    assert.equal(policy.analyze(f.root, 'main', { projectRoot: f.root }).ok, false, body);
  }
});

test('aligned functional parameter documentation survives analysis and cleanup', t => {
  for (const separator of ['  ', '\t\t']) {
    const body = '<?php\n/** @param string' + separator + '$value */\nfunction sample($value) {}\n';
    const f = configured(t, 'acme/app', { tags: ['@param'], public_methods: false }, body + '// unrelated explanatory comment\n');
    const report = policy.analyze(f.root, 'main', { projectRoot: f.root });
    assert.equal(report.files.find(row => row.path === 'Example.php').findings.length, 1);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/comment-policy.cjs'),
      'clean', 'T-55-05', '--worktree', f.root, '--base', 'main', '--project-root', f.root, '--apply', '--json'],
      { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(f.root, 'Example.php'), 'utf8'), body);
  }
});
