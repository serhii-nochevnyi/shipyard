'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'comment-policy.cjs');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function fixture(base, change) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-comment-policy-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const [name, content] of Object.entries(base)) {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['checkout', '-qb', 'ticket/T-01-01']);
  for (const [name, content] of Object.entries(change)) {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'change']);
  return repo;
}

function run(repo, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
}

function args(command, repo, extra = []) {
  return [command, 'T-01-01', '--worktree', repo, '--base', 'main', ...extra];
}

function read(repo, file) {
  return fs.readFileSync(path.join(repo, file), 'utf8');
}

suite('comment-policy — strict pre-push policy and explicit cleanup');

test('blocks a file whose added comments exceed its added code', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// explain the implementation\n// explain it again\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.violations, ['src/app.js']);
  assert.strictEqual(report.files[0].cleanable_comment_lines, 2);
  assert.strictEqual(report.files[0].code_lines, 0);
});

test('blocks one added explanatory comment even when code outnumbers it', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\nconst next = value + 1;\n// explain the implementation\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.violations, ['src/app.js']);
  assert.strictEqual(report.files[0].comment_lines, 1);
  assert.strictEqual(report.files[0].code_lines, 1);
});

test('allows only short invariant, security and contract markers', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    {
      'src/app.js': [
        'const value = 1;',
        '// @invariant: value is normalized',
        '// @security: reject untrusted input',
        '/* @contract: output is stable */',
      ].join('\n') + '\n',
    },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.totals.comment_lines, 0);
  assert.strictEqual(report.totals.protected_comment_lines, 3);
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:',
    '@security:',
    '@contract:',
  ]);
});

test('rejects long, historical and multiline marker comments', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    {
      'src/app.js': [
        '// @contract: required by ADR-013',
        ['// @security: ', 'x'.repeat(130)].join(''),
        '/* @invariant: this continues',
        ' * on another line',
        ' */',
      ].join('\n') + '\n',
    },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.violations, ['src/app.js']);
  assert.strictEqual(report.files[0].manual_comment_lines, 3);
  assert.strictEqual(report.files[0].cleanable_comment_lines, 2);
});

test('counts only added lines and skips documentation files', () => {
  const repo = fixture(
    { 'src/app.js': '// existing comment\nconst value = 1;\n', 'README.md': '# Readme\n' },
    { 'src/app.js': '// existing comment\nconst value = 1;\nconst next = value + 1;\n', 'README.md': '# Readme\n// prose\n// more prose\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.files.length, 1);
  assert.strictEqual(report.files[0].comment_lines, 0);
  assert.deepStrictEqual(report.skipped, [{ path: 'README.md', reason: 'unsupported-file-type' }]);
});

test('exempts directives, licenses, generated markers and shebangs', () => {
  const repo = fixture(
    { 'src/run.sh': '#!/usr/bin/env bash\n' },
    { 'src/run.sh': '#!/usr/bin/env bash\n# shellcheck disable=SC2086\n# SPDX-License-Identifier: MIT\n# generated file\necho ready\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.totals.comment_lines, 0);
  assert.strictEqual(report.totals.protected_comment_lines, 3);
});

test('does not treat a URL in a string as a comment', () => {
  const repo = fixture(
    { 'src/app.js': 'const url = "https://example.test/a//b";\n' },
    { 'src/app.js': 'const url = "https://example.test/a//b";\nconst next = url;\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.totals.comment_lines, 0);
  assert.strictEqual(report.totals.code_lines, 1);
});

test('does not treat comment markers inside Python triple-quoted strings as comments', () => {
  const repo = fixture(
    { 'src/doc.py': 'value = 1\n' },
    { 'src/doc.py': '"""documentation\n# this is string content\n"""\nvalue = 1\nnext = value\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.totals.comment_lines, 0);
});

test('does not treat shell parameter expansion as a comment', () => {
  const repo = fixture(
    { 'src/run.sh': '#!/usr/bin/env bash\n' },
    { 'src/run.sh': '#!/usr/bin/env bash\nvalue=${value#prefix}\necho "$value"\n' },
  );
  const result = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.totals.comment_lines, 0);
  assert.strictEqual(report.totals.code_lines, 2);
});

test('dry-run previews removable lines and apply removes only full-line additions', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// remove this narration\n// remove this too\nmodule.exports = value;\n' },
  );
  const preview = run(repo, args('clean', repo, ['--json']));
  assert.strictEqual(preview.status, 1, preview.stdout + preview.stderr);
  const previewReport = JSON.parse(preview.stdout);
  assert.strictEqual(previewReport.ok, false);
  assert.strictEqual(previewReport.before.files[0].cleanable_comment_lines, 2);
  assert.strictEqual(read(repo, 'src/app.js').includes('// remove this narration'), true);

  const applied = run(repo, args('clean', repo, ['--apply', '--json']));
  assert.strictEqual(applied.status, 0, applied.stdout + applied.stderr);
  const appliedReport = JSON.parse(applied.stdout);
  assert.strictEqual(appliedReport.removed.length, 2);
  assert.strictEqual(appliedReport.after.ok, true);
  assert.strictEqual(read(repo, 'src/app.js'), 'const value = 1;\nmodule.exports = value;\n');

  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'clean']);
  const checked = run(repo, args('check', repo, ['--json']));
  assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
});

test('keeps multiline and inline comments for manual review', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\nconst next = value; // inline explanation\n/* block explanation\n * second line\n */\n' },
  );
  const before = read(repo, 'src/app.js');
  const preview = run(repo, args('clean', repo, ['--json']));
  assert.strictEqual(preview.status, 1, preview.stdout + preview.stderr);
  const previewReport = JSON.parse(preview.stdout);
  assert.strictEqual(previewReport.before.files[0].cleanable_comment_lines, 0);
  assert.strictEqual(previewReport.before.files[0].manual_comment_lines, 4);

  const applied = run(repo, args('clean', repo, ['--apply', '--json']));
  assert.strictEqual(applied.status, 1, applied.stdout + applied.stderr);
  assert.strictEqual(read(repo, 'src/app.js'), before);
  assert.strictEqual(JSON.parse(applied.stdout).removed.length, 0);
});

test('refuses cleanup over an uncommitted tracked worktree', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// narration\n// more narration\n' },
  );
  fs.appendFileSync(path.join(repo, 'src/app.js'), 'const next = value;\n');
  const result = run(repo, args('clean', repo, ['--apply', '--json']));
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /clean tracked worktree/);
});

done();
