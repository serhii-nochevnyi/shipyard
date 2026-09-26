'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'planning-untrack.cjs');
const { plan, apply, isPlanningTracked, gitignoreHasEntry, COMMIT_SUBJECT } = require(MOD);
const { check } = require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pr-hygiene.cjs'));

const trash = [];
process.on('exit', () => {
  for (const dir of trash) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

function gitEnv(gitconfig) {
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(dir, args, env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
}

function nameStatusPaths(dir, range, env) {
  const out = git(dir, ['diff', '--name-status', range], env);
  return out.split('\n').filter(Boolean).map((line) => {
    const columns = line.split('\t');
    return { status: columns[0], path: columns[columns.length - 1] };
  });
}

function hermeticRepo({ shipyard = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planning-untrack-')));
  trash.push(dir);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = gitEnv(gitconfig);
  git(dir, ['init', '-q', '-b', 'main'], env);
  git(dir, ['config', 'user.email', 'x@example.com'], env);
  git(dir, ['config', 'user.name', 'x'], env);
  git(dir, ['config', 'commit.gpgsign', 'false'], env);
  if (shipyard) {
    fs.mkdirSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'delivery-pipeline', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'shipyard' }));
  }
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'tickets.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-state.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'init'], env);
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/test/test.git'], env);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], env);
  return { dir, env };
}

suite('planning-untrack — dry run');

test('the dry run changes nothing', () => {
  const { dir, env } = hermeticRepo();
  const before = git(dir, ['status', '--porcelain'], env);
  const result = plan(dir);
  assert.strictEqual(result.already_untracked, false);
  assert.strictEqual(result.gitignore_line, '/.planning/');
  assert.strictEqual(result.untrack_command, 'git rm -r --cached .planning');
  const after = git(dir, ['status', '--porcelain'], env);
  assert.strictEqual(before, after);
  assert.strictEqual(isPlanningTracked(dir), true);
});

test('the dry run reports no gitignore line to add once one already exists', () => {
  const { dir, env } = hermeticRepo();
  fs.writeFileSync(path.join(dir, '.gitignore'), '/.planning/\n');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'add gitignore'], env);
  const result = plan(dir);
  assert.strictEqual(result.gitignore_line, null);
});

suite('planning-untrack — apply refusals');

test('apply without --confirm refuses', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  assert.throws(() => apply({ root: dir, confirm: undefined }), (error) => error.code === 'CONFIRMATION_REQUIRED');
  assert.throws(() => apply({ root: dir, confirm: 'wrong-token' }), (error) => error.code === 'CONFIRMATION_REQUIRED');
});

test('apply on the default branch refuses', () => {
  const { dir } = hermeticRepo();
  assert.throws(() => apply({ root: dir, confirm: 'untrack-planning' }), (error) => error.code === 'ON_DEFAULT_BRANCH');
});

test('apply refuses on a dirty worktree', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x\n');
  assert.throws(() => apply({ root: dir, confirm: 'untrack-planning' }), (error) => error.code === 'DIRTY_WORKTREE');
});

test('apply refuses when .planning/ is already untracked', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  apply({ root: dir, confirm: 'untrack-planning' });
  assert.throws(() => apply({ root: dir, confirm: 'untrack-planning' }), (error) => error.code === 'ALREADY_UNTRACKED');
});

test('the Shipyard manifest refuses', () => {
  const { dir, env } = hermeticRepo({ shipyard: true });
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  assert.throws(() => apply({ root: dir, confirm: 'untrack-planning' }), (error) => error.code === 'EXEMPT_REPOSITORY');
});

suite('planning-untrack — apply on a feature branch');

test('untracks .planning/, ignores it, and commits on the current branch', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  const result = apply({ root: dir, confirm: 'untrack-planning' });

  assert.strictEqual(result.branch, 'feature/untrack');
  assert.strictEqual(result.base, 'main');
  assert.strictEqual(result.message, COMMIT_SUBJECT);
  assert.strictEqual(isPlanningTracked(dir), false);
  assert.strictEqual(gitignoreHasEntry(dir), true);
  assert.strictEqual(git(dir, ['log', '-1', '--format=%s'], env), COMMIT_SUBJECT);
  assert.strictEqual(git(dir, ['rev-parse', 'HEAD'], env), result.commit);
  assert.strictEqual(git(dir, ['status', '--porcelain'], env), '');
});

suite('planning-untrack — the migration passes pr-hygiene.cjs check (D-39)');

test('the migration branch (deletions of .planning/ only) has no internal-path violation', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/untrack'], env);
  apply({ root: dir, confirm: 'untrack-planning' });

  const paths = nameStatusPaths(dir, 'main...feature/untrack', env);
  assert.ok(paths.length > 0, 'the migration diff must not be empty');
  assert.ok(paths.every((entry) => entry.status.toUpperCase().startsWith('D') || entry.path === '.gitignore'));

  const result = check({
    title: 'chore: stop tracking local planning files',
    body: 'PR body: Summary, Changes, Tests.',
    head: 'chore/stop-tracking-planning',
    base: 'main',
    paths,
    commits: [COMMIT_SUBJECT],
    jiraKeys: [],
  });
  assert.deepStrictEqual(result.violations.filter((v) => v.field === 'paths'), []);
});

test('a branch that ADDS a .planning/ file does not pass the paths rule', () => {
  const { dir, env } = hermeticRepo();
  git(dir, ['checkout', '-q', '-b', 'feature/bad-add'], env);
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'phases', 'new-file.md'), 'x\n');
  git(dir, ['add', '-A'], env);
  git(dir, ['commit', '-q', '-m', 'feat: add a plan file'], env);

  const paths = nameStatusPaths(dir, 'main...feature/bad-add', env);
  const result = check({
    title: 'feat: add a plan file',
    body: 'PR body: Summary, Changes, Tests.',
    head: 'feat/add-a-plan-file',
    base: 'main',
    paths,
    commits: ['feat: add a plan file'],
    jiraKeys: [],
  });
  assert.ok(result.violations.some((v) => v.field === 'paths' && v.rule === 'internal-path'));
});

done();
