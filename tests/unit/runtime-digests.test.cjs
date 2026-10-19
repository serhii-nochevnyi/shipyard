'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REFRESH = path.join(ROOT, 'scripts', 'refresh-runtime-digests.cjs');

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

suite('check-runtime-digest-trailer — read-only current-byte compatibility alias');

function runAlias(repo, script = path.join(ROOT, 'scripts', 'check-runtime-digest-trailer.cjs')) {
  return spawnSync(process.execPath, [script, '--base', 'nonexistent-base'], {
    cwd: repo, encoding: 'utf8',
  });
}

test('accepts current pins without Git history and leaves pins unchanged', () => {
  const { repo } = fixture();
  fs.rmSync(path.join(repo, '.git'), { recursive: true });
  const before = fs.readFileSync(path.join(repo, PIN_REL), 'utf8');
  const result = runAlias(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(repo, PIN_REL), 'utf8'), before);
});

test('rejects corrupt current bytes without writing pins', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, PIN_REL), 'utf8');
  writeFile(repo, FILE_A, 'corrupt bytes');
  assert.notEqual(runAlias(repo).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, PIN_REL), 'utf8'), before);
});

test('rejects missing pins', () => {
  const { repo } = fixture();
  fs.rmSync(path.join(repo, PIN_REL));
  assert.notEqual(runAlias(repo).status, 0);
  assert.equal(fs.existsSync(path.join(repo, PIN_REL)), false);
});

test('rejects missing runtime files without writing pins', () => {
  const { repo } = fixture();
  const before = fs.readFileSync(path.join(repo, PIN_REL), 'utf8');
  fs.rmSync(path.join(repo, FILE_A));
  assert.notEqual(runAlias(repo).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, PIN_REL), 'utf8'), before);
});

test('rejects an unavailable child script', () => {
  const { repo } = fixture();
  const isolated = path.join(repo, 'check-runtime-digest-trailer.cjs');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-runtime-digest-trailer.cjs'), isolated);
  const before = fs.readFileSync(path.join(repo, PIN_REL), 'utf8');
  assert.notEqual(runAlias(repo, isolated).status, 0);
  assert.equal(fs.readFileSync(path.join(repo, PIN_REL), 'utf8'), before);
});

test('propagates a child launch failure as nonzero', () => {
  const script = path.join(ROOT, 'scripts', 'check-runtime-digest-trailer.cjs');
  let exitCode;
  require('vm').runInNewContext(fs.readFileSync(script, 'utf8'), {
    __dirname: path.dirname(script),
    require(name) {
      if (name === 'child_process') return {
        spawnSync: () => ({ status: null, error: new Error('spawn failed') }),
      };
      return require(name);
    },
    console: { error() {} },
    process: { execPath: process.execPath, exit(code) { exitCode = code; } },
  });
  assert.equal(exitCode, 1);
});

done();
