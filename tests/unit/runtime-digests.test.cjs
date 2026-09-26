'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REFRESH = path.join(ROOT, 'scripts', 'refresh-runtime-digests.cjs');
const CHECK_TRAILER = path.join(ROOT, 'scripts', 'check-runtime-digest-trailer.cjs');

const FILE_A = 'plugins/delivery-pipeline/scripts/runtime-adapters.cjs';
const FILE_B = 'plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs';
const PIN_REL = 'tests/unit/runtime-file-digests.json';

const trash = [];
process.on('exit', () => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function gitEnv(gitconfig) {
  return { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return (r.stdout || '').trim();
}

function initRepo(dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', dir], { env });
  git(dir, ['config', 'user.email', 'digests@example.com'], env);
  git(dir, ['config', 'user.name', 'digests test'], env);
  git(dir, ['config', 'commit.gpgsign', 'false'], env);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writePin(dir, files) {
  writeFile(dir, PIN_REL, `${JSON.stringify({ schema: 'shipyard.runtime-file-digests.v1', files }, null, 2)}\n`);
}

function readPin(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, PIN_REL), 'utf8'));
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-digests-')));
  trash.push(root);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = gitEnv(gitconfig);
  const repo = path.join(root, 'repo');
  initRepo(repo, env);
  writeFile(repo, FILE_A, 'const a = 1;\n');
  writeFile(repo, FILE_B, 'const b = 2;\n');
  writePin(repo, {
    [FILE_A]: sha256('const a = 1;\n'),
    [FILE_B]: sha256('const b = 2;\n'),
  });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'base'], env);
  return { repo, env };
}

function runRefresh(repo, args) {
  return spawnSync(process.execPath, [REFRESH, ...args], { cwd: repo, encoding: 'utf8' });
}

function runCheckTrailer(repo, args) {
  return spawnSync(process.execPath, [CHECK_TRAILER, ...args], { cwd: repo, encoding: 'utf8' });
}

suite('refresh-runtime-digests — recompute and print the trailer lines to add');

test('rewrites a stale digest and prints the trailer line for only the changed file', () => {
  const { repo } = fixture();
  writeFile(repo, FILE_A, 'const a = 2;\n');
  const result = runRefresh(repo, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime-Digest-Refresh: plugins\/delivery-pipeline\/scripts\/runtime-adapters\.cjs/);
  assert.doesNotMatch(result.stdout, /claude-dispatch-adapter\.cjs/);
  const pin = readPin(repo);
  assert.equal(pin.files[FILE_A], sha256('const a = 2;\n'));
  assert.equal(pin.files[FILE_B], sha256('const b = 2;\n'));
  assert.equal(pin.schema, 'shipyard.runtime-file-digests.v1');
});

test('--check fails on a stale pin without writing', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, PIN_REL), 'utf8');
  writeFile(repo, FILE_B, 'const b = 3;\n');
  const result = runRefresh(repo, ['--check']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(repo, PIN_REL), 'utf8'), before, '--check must not write');
});

test('--check passes when every digest is already current', () => {
  const { repo } = fixture();
  const result = runRefresh(repo, ['--check']);
  assert.equal(result.status, 0, result.stderr);
});

test('refuses when a listed file is missing', () => {
  const { repo } = fixture();
  fs.rmSync(path.join(repo, FILE_A));
  const result = runRefresh(repo, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime-adapters\.cjs/);
});

suite('check-runtime-digest-trailer — CI-verified commit trailer over the pin');

test('passes an annotated pin commit', () => {
  const { repo, env } = fixture();
  const base = git(repo, ['rev-parse', 'HEAD'], env);
  writeFile(repo, FILE_A, 'const a = 2;\n');
  writePin(repo, { [FILE_A]: sha256('const a = 2;\n'), [FILE_B]: sha256('const b = 2;\n') });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', `Refresh pin\n\nRuntime-Digest-Refresh: ${FILE_A}`], env);
  const result = runCheckTrailer(repo, ['--base', base]);
  assert.equal(result.status, 0, result.stderr);
});

test('fails an unannotated pin commit, naming the commit and the missing path', () => {
  const { repo, env } = fixture();
  const base = git(repo, ['rev-parse', 'HEAD'], env);
  writeFile(repo, FILE_A, 'const a = 2;\n');
  writePin(repo, { [FILE_A]: sha256('const a = 2;\n'), [FILE_B]: sha256('const b = 2;\n') });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'Refresh pin'], env);
  const head = git(repo, ['rev-parse', 'HEAD'], env);
  const result = runCheckTrailer(repo, ['--base', base]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(head));
  assert.match(result.stderr, /runtime-adapters\.cjs/);
});

test('fails a trailer naming the wrong file', () => {
  const { repo, env } = fixture();
  const base = git(repo, ['rev-parse', 'HEAD'], env);
  writeFile(repo, FILE_A, 'const a = 2;\n');
  writePin(repo, { [FILE_A]: sha256('const a = 2;\n'), [FILE_B]: sha256('const b = 2;\n') });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', `Refresh pin\n\nRuntime-Digest-Refresh: ${FILE_B}`], env);
  const result = runCheckTrailer(repo, ['--base', base]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime-adapters\.cjs/);
});

test('ignores commits that do not touch the JSON', () => {
  const { repo, env } = fixture();
  const base = git(repo, ['rev-parse', 'HEAD'], env);
  writeFile(repo, 'README.md', 'unrelated change\n');
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'unrelated'], env);
  const result = runCheckTrailer(repo, ['--base', base]);
  assert.equal(result.status, 0, result.stderr);
});

test('treats a pin file missing from the parent as no previous pin', () => {
  const { repo, env } = fixture();
  git(repo, ['rm', '-q', PIN_REL], env);
  git(repo, ['commit', '-q', '-m', 'drop pin'], env);
  const base = git(repo, ['rev-parse', 'HEAD'], env);
  writePin(repo, { [FILE_A]: sha256('const a = 1;\n'), [FILE_B]: sha256('const b = 2;\n') });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'seed pin'], env);
  const result = runCheckTrailer(repo, ['--base', base]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /fatal/);
});

test('ignores pin commits a base merge brought in', () => {
  const { repo, env } = fixture();
  git(repo, ['checkout', '-q', '-b', 'ticket'], env);
  writeFile(repo, 'README.md', 'ticket change\n');
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'ticket work'], env);
  git(repo, ['checkout', '-q', 'main'], env);
  writeFile(repo, FILE_B, 'const b = 3;\n');
  writePin(repo, { [FILE_A]: sha256('const a = 1;\n'), [FILE_B]: sha256('const b = 3;\n') });
  git(repo, ['add', '-A'], env);
  git(repo, ['commit', '-q', '-m', 'unannotated pin change on main'], env);
  git(repo, ['checkout', '-q', 'ticket'], env);
  git(repo, ['merge', '-q', '--no-edit', 'main'], env);
  const result = runCheckTrailer(repo, ['--base', 'main']);
  assert.equal(result.status, 0, result.stderr);
});

done();
