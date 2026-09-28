'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'comment-policy.cjs');
const PUBLISH_SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'publish-gate.cjs');
const commentPolicy = require(SCRIPT);

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

function run(repo, args, env = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env });
}

function runPublish(repo, args) {
  return spawnSync(process.execPath, [PUBLISH_SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
}

function args(command, repo, extra = []) {
  return [command, 'T-01-01', '--worktree', repo, '--base', 'main', ...extra];
}

function read(repo, file) {
  return fs.readFileSync(path.join(repo, file), 'utf8');
}

function configureMarkers(projectRoot, markers) {
  const planning = path.join(projectRoot, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({
    delivery_pipeline: { comment_markers: markers },
  }));
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

test('publish gate includes uncommitted worktree additions', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\nconst next = value + 1;\n' },
  );
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// explain the implementation\n');
  const result = runPublish(repo, ['--base', 'main', '--working-tree', '--json']);
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.violations, ['src/app.js']);
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

test('configured markers apply to the matching origin repository only', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// @ai-generated model=x\n' },
  );
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  configureMarkers(repo, { 'acme/app': ['@ai-generated'] });

  const matching = commentPolicy.analyze(repo, 'main', { projectRoot: repo });
  assert.strictEqual(matching.ok, true);
  assert.deepStrictEqual(matching.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:', '@ai-generated',
  ]);

  git(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);
  const other = commentPolicy.analyze(repo, 'main', { projectRoot: repo });
  assert.strictEqual(other.ok, false);
  assert.deepStrictEqual(other.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
});

test('direct check and clean CLI load markers from a distinct project root', () => {
  const repo = fixture(
    { 'src/app.js': 'const answer = 42;\n' },
    { 'src/app.js': '// @ai-generated model=x\nconst answer = 42;\n' },
  );
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-comment-project-'));
  configureMarkers(projectRoot, { 'acme/app': ['@ai-generated'] });
  const cliArgs = ['--project-root', projectRoot, '--json'];

  const checked = run(repo, args('check', repo, cliArgs));
  const cleaned = run(repo, args('clean', repo, cliArgs));
  assert.deepStrictEqual([checked.status, cleaned.status], [0, 0],
    `${checked.stdout}${checked.stderr}${cleaned.stdout}${cleaned.stderr}`);
  assert.deepStrictEqual(JSON.parse(checked.stdout).policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:', '@ai-generated',
  ]);
  assert.deepStrictEqual(JSON.parse(cleaned.stdout).before.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:', '@ai-generated',
  ]);
});

test('direct CLI uses SHIPYARD_PROJECT_ROOT but does not infer it from the worktree', () => {
  const repo = fixture(
    { 'src/app.js': 'const answer = 42;\n' },
    { 'src/app.js': '// @ai-generated model=x\nconst answer = 42;\n' },
  );
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  configureMarkers(repo, { 'acme/app': ['@ai-generated'] });

  const fromWorktreeRoot = run(repo, args('check', repo, ['--json']), {
    ...process.env,
    SHIPYARD_PROJECT_ROOT: '',
  });
  const fromEnvironment = run(repo, args('check', repo, ['--json']), {
    ...process.env,
    SHIPYARD_PROJECT_ROOT: repo,
  });
  assert.deepStrictEqual([fromWorktreeRoot.status, fromEnvironment.status], [1, 0],
    `${fromWorktreeRoot.stdout}${fromWorktreeRoot.stderr}${fromEnvironment.stdout}${fromEnvironment.stderr}`);
  assert.deepStrictEqual(JSON.parse(fromWorktreeRoot.stdout).policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
  assert.strictEqual(JSON.parse(fromEnvironment.stdout).policy.allowed_markers.includes('@ai-generated'), true);
});

test('direct CLI fails closed when the target worktree has no origin', () => {
  const repo = fixture(
    { 'src/app.js': 'const answer = 42;\n' },
    { 'src/app.js': '// @ai-generated model=x\nconst answer = 42;\n' },
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-comment-project-'));
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  configureMarkers(projectRoot, { 'acme/app': ['@ai-generated'] });

  const result = run(repo, args('check', repo, ['--project-root', projectRoot, '--json']));
  assert.strictEqual(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
});

test('omitting the project root ignores tempting target config but an explicit root stays trusted', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    {
      'src/app.js': [
        'const value = 1;',
        '// @target-generated model=x',
        '// @trusted-generated model=y',
      ].join('\n') + '\n',
    },
  );
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  configureMarkers(repo, { 'acme/app': ['@target-generated'] });
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-trusted-project-'));
  configureMarkers(projectRoot, { 'acme/app': ['@trusted-generated'] });

  const trusted = commentPolicy.analyze(repo, 'main', { projectRoot });
  assert.strictEqual(trusted.policy.allowed_markers.includes('@trusted-generated'), true);
  assert.strictEqual(trusted.policy.allowed_markers.includes('@target-generated'), false);
  assert.strictEqual(trusted.files[0].comment_lines, 1);

  const missingRoot = run(repo, args('check', repo, ['--json']), {
    ...process.env,
    SHIPYARD_PROJECT_ROOT: '',
  });
  assert.strictEqual(missingRoot.status, 1, missingRoot.stdout + missingRoot.stderr);
  assert.deepStrictEqual(JSON.parse(missingRoot.stdout).policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
  assert.strictEqual(JSON.parse(missingRoot.stdout).files[0].comment_lines, 2);
});

test('configured markers match scp-style origins with git output newlines', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// @ai-generated model=x\n' },
  );
  git(repo, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  configureMarkers(repo, { 'acme/app': ['@ai-generated'] });

  assert.strictEqual(commentPolicy.repositorySlug(repo), 'acme/app');
  const report = commentPolicy.analyze(repo, 'main', { projectRoot: repo });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.policy.allowed_markers.includes('@ai-generated'), true);
});

test('default configured markers do not apply when origin cannot identify a repository', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// @ai-generated model=x\n' },
  );
  configureMarkers(repo, { default: ['@ai-generated'] });

  const report = commentPolicy.analyze(repo, 'main', { projectRoot: repo });
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
});

test('configured marker tokens containing whitespace or regex metacharacters are dropped', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    {
      'src/app.js': [
        'const value = 1;',
        '// @bad marker model=x',
        '// @bad(marker model=x',
      ].join('\n') + '\n',
    },
  );
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  configureMarkers(repo, { 'acme/app': ['@bad marker', '@bad('] });

  const report = commentPolicy.analyze(repo, 'main', { projectRoot: repo });
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.files[0].comment_lines, 2);
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
});

test('editing an existing comment is reported without blocking', () => {
  const repo = fixture(
    { 'src/app.js': '// stale explanation\nconst value = 1;\n' },
    { 'src/app.js': '// updated explanation\nconst value = 1;\n' },
  );
  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.files[0].added_lines, 0);
  assert.strictEqual(report.files[0].comment_lines, 0);
  assert.deepStrictEqual(report.files[0].findings.map((finding) => finding.kind), ['edited_comment']);
});

test('editing an existing comment in a renamed file uses the old-path pre-image', () => {
  const repo = fixture(
    {
      'src/old.js': [
        '// stale explanation',
        'const value = 1;',
        'const keep = 2;',
        'const another = 3;',
      ].join('\n') + '\n',
    },
    {
      'src/new.js': [
        '// revised explanation',
        'const value = 1;',
        'const keep = 2;',
        'const another = 3;',
      ].join('\n') + '\n',
    },
  );
  git(repo, ['rm', 'src/old.js']);
  git(repo, ['commit', '-qm', 'rename and edit existing comment']);

  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.files[0].comment_lines, 0);
  assert.deepStrictEqual(report.files[0].findings.map((finding) => finding.kind), ['edited_comment']);
});

test('cross-language rename scans the pre-image with the old language and still blocks new comments', () => {
  const repo = fixture(
    {
      'src/old.py': [
        '# stale explanation',
        'value = 1',
        'value += 2',
        'value += 3',
        'value += 4',
        'value += 5',
      ].join('\n') + '\n',
    },
    {
      'src/new.js': [
        '// revised explanation',
        'value = 1',
        'value += 2',
        'value += 3',
        'value += 4',
        'value += 5',
        '// net-new free comment',
      ].join('\n') + '\n',
    },
  );
  git(repo, ['rm', 'src/old.py']);
  git(repo, ['commit', '-qm', 'rename Python file to JavaScript and edit comment']);

  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.files.length, 1);
  assert.strictEqual(report.files[0].path, 'src/new.js');
  assert.strictEqual(report.files[0].language, 'c-like');
  assert.strictEqual(report.files[0].comment_lines, 1);
  assert.strictEqual(report.files[0].added_lines, 1);
  assert.deepStrictEqual(report.files[0].findings.map((finding) => finding.kind), [
    'edited_comment',
    'cleanable',
  ]);
  assert.strictEqual(report.ok, false);
});

test('unsupported old language on rename fails closed for new comments', () => {
  const repo = fixture(
    {
      'src/old.unknown': [
        '# old unsupported comment',
        'value = 1',
        'value += 2',
        'value += 3',
        'value += 4',
        'value += 5',
      ].join('\n') + '\n',
    },
    {
      'src/new.js': [
        '// revised comment',
        'value = 1',
        'value += 2',
        'value += 3',
        'value += 4',
        'value += 5',
        '// net-new free comment',
      ].join('\n') + '\n',
    },
  );
  git(repo, ['rm', 'src/old.unknown']);
  git(repo, ['commit', '-qm', 'rename unsupported source to JavaScript']);

  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.files.length, 1);
  assert.strictEqual(report.files[0].path, 'src/new.js');
  assert.strictEqual(report.files[0].comment_lines, 2);
  assert.strictEqual(report.ok, false);
});

test('turning a code line into a comment still blocks', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': '// const value = 1;\n' },
  );
  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.files[0].comment_lines, 1);
});

test('a net-new free comment still blocks', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// new explanation\n' },
  );
  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.files[0].comment_lines, 1);
});

test('committed diff uses merge-base pre-image while worktree diff uses base-tip pre-image', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': '// ticket explanation\n' },
  );

  git(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(repo, 'src/app.js'), '// base explanation\n');
  git(repo, ['add', 'src/app.js']);
  git(repo, ['commit', '-qm', 'base changes code to comment']);
  git(repo, ['checkout', 'ticket/T-01-01']);

  const committed = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(committed.ok, false);
  assert.strictEqual(committed.files[0].comment_lines, 1);
  assert.deepStrictEqual(committed.files[0].findings.map((finding) => finding.kind), ['cleanable']);

  fs.writeFileSync(path.join(repo, 'src/app.js'), '// revised ticket explanation\n');
  const workingTree = commentPolicy.analyze(repo, 'main', { workingTree: true });
  assert.strictEqual(workingTree.ok, true);
  assert.strictEqual(workingTree.files[0].comment_lines, 0);
  assert.deepStrictEqual(workingTree.files[0].findings.map((finding) => finding.kind), ['edited_comment']);
});

test('deleting a comment does not create an added-line report', () => {
  const repo = fixture(
    { 'src/app.js': '// existing explanation\nconst value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n' },
  );
  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.files, []);
});

test('editing inside a block comment uses the whole base blob to recognize its pre-image', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n/*\n * stale explanation\n */\n' },
    { 'src/app.js': 'const value = 1;\n/*\n * revised explanation\n */\n' },
  );
  const report = commentPolicy.analyze(repo, 'main');
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(report.files[0].findings.map((finding) => finding.kind), ['edited_comment']);
});

test('project configuration is read from the supplied project root, not the ticket worktree', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    {
      'src/app.js': 'const value = 1;\n// @ai-generated model=x\n',
      '.planning/config.json': JSON.stringify({
        delivery_pipeline: { comment_markers: { 'acme/app': ['@ai-generated'] } },
      }) + '\n',
    },
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-comment-project-'));
  const report = commentPolicy.analyze(repo, 'main', { projectRoot, repo: 'acme/app' });
  assert.strictEqual(report.ok, false);
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
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

test('generated marketplace host copies are skipped only when identical to canonical files', () => {
  const source = 'scripts/fixture.cjs';
  const copy = 'plugins/shipyard/host/scripts/fixture.cjs';
  const repo = fixture({ [source]: '// existing comment\nconst answer = 1;\n' },
    { [copy]: '// existing comment\nconst answer = 1;\n' });
  const good = runPublish(repo, ['--base', 'main', '--json']);
  assert.strictEqual(good.status, 0, good.stdout + good.stderr);
  assert(JSON.parse(good.stdout).skipped.some(item => item.path === copy
    && item.reason === 'verified-generated-copy'));
  fs.writeFileSync(path.join(repo, copy), '// altered comment\nconst answer = 1;\n');
  const bad = runPublish(repo, ['--base', 'main', '--working-tree', '--json']);
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /differs from canonical source/);
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

test('clean --apply refuses an invalid project config and names it without changing files', () => {
  const repo = fixture(
    { 'src/app.js': 'const value = 1;\n' },
    { 'src/app.js': 'const value = 1;\n// remove this narration\n' },
  );
  const configFile = path.join(repo, '.planning', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{ invalid json');
  const before = read(repo, 'src/app.js');

  const result = run(repo, args('clean', repo, ['--project-root', repo, '--apply', '--json']));
  assert.strictEqual(result.status, 2, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(configFile), result.stderr);
  assert.strictEqual(read(repo, 'src/app.js'), before);
});

done();
