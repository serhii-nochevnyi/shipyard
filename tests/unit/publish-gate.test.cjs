'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'publish-gate.cjs');
const commentPolicy = require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'comment-policy.cjs'));

const trash = [];
process.on('exit', () => {
  for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function gitEnv(gitconfig) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GITHUB_BASE_REF: '',
    COMMENT_POLICY_BASE: '',
    SHIPYARD_COMMENT_BASE: '',
    SHIPYARD_PROJECT_ROOT: '',
  };
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  return (r.stdout || '').trim();
}

function root() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-pubgate-')));
  trash.push(dir);
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  return { dir, env: gitEnv(gitconfig) };
}

function makeOrigin(dir, env, { defaultBranch, extraBranches = [] }) {
  const bare = path.join(dir, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', bare], { env });
  git(bare, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], env);

  const seed = path.join(dir, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  spawnSync('git', ['init', '-q', seed], { env });
  git(seed, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], env);
  git(seed, ['config', 'user.email', 'pg@example.com'], env);
  git(seed, ['config', 'user.name', 'pg test'], env);
  git(seed, ['config', 'commit.gpgsign', 'false'], env);
  git(seed, ['commit', '-q', '--allow-empty', '-m', 'init'], env);
  git(seed, ['remote', 'add', 'origin', bare], env);
  git(seed, ['push', '-q', '-u', 'origin', defaultBranch], env);

  for (const branch of extraBranches) {
    git(seed, ['checkout', '-q', '-b', branch], env);
    git(seed, ['commit', '-q', '--allow-empty', '-m', branch], env);
    git(seed, ['push', '-q', 'origin', branch], env);
  }
  return bare;
}

function cloneWorktree(dir, bare, env) {
  const worktree = path.join(dir, 'worktree');
  const r = spawnSync('git', ['clone', '-q', bare, worktree], { env });
  if (r.status !== 0) throw new Error(`git clone failed:\n${r.stderr}`);
  return worktree;
}

function fetchOnlyWorktree(dir, bare, env) {
  const worktree = path.join(dir, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  spawnSync('git', ['init', '-q', worktree], { env });
  git(worktree, ['remote', 'add', 'origin', bare], env);
  git(worktree, ['fetch', '-q', 'origin'], env);
  // @invariant: origin/HEAD must be absent — recent git auto-sets it on fetch, so delete it explicitly
  spawnSync('git', ['-C', worktree, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], { env });
  return worktree;
}

function writeState(worktree, ticket, base) {
  const graph = path.join(worktree, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ [ticket]: { base } }, null, 2));
}

function run(worktree, { env, ticket, extra = [] }) {
  const argv = ['--worktree', worktree, '--working-tree', '--json', ...extra];
  if (ticket) argv.push('--ticket', ticket);
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', env });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

suite('publish-gate — resolves the base from the recorded ticket base and origin/HEAD');

test('origin default master, no main: resolves origin/master via origin/HEAD', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'master' });
  const worktree = cloneWorktree(dir, bare, env);
  const r = run(worktree, { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.base, 'origin/master');
  assert.strictEqual(r.json.base_source, 'origin-head');
});

test('origin default develop, no main: resolves origin/develop via origin/HEAD', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'develop' });
  const worktree = cloneWorktree(dir, bare, env);
  const r = run(worktree, { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.base, 'origin/develop');
  assert.strictEqual(r.json.base_source, 'origin-head');
});

test('a recorded delivery-state base wins over origin/HEAD for a ticket branch', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'master', extraBranches: ['epic/43-x'] });
  const worktree = cloneWorktree(dir, bare, env);
  const projectRoot = path.join(dir, 'project-root');
  fs.mkdirSync(projectRoot, { recursive: true });
  writeState(projectRoot, 'T-43-01', 'epic/43-x');
  const r = run(worktree, { env, ticket: 'T-43-01', extra: ['--project-root', projectRoot] });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.base, 'origin/epic/43-x');
  assert.strictEqual(r.json.base_source, 'recorded');
});

test('a Shipyard-shaped fixture (main, no origin/HEAD) still resolves origin/main', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'main' });
  const worktree = fetchOnlyWorktree(dir, bare, env);
  const r = run(worktree, { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.base, 'origin/main');
  assert.strictEqual(r.json.base_source, 'fallback');
  const report = commentPolicy.analyze(worktree, 'origin/main', {
    workingTree: true,
    projectRoot: worktree,
    repo: commentPolicy.repositorySlug(worktree),
  });
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:',
  ]);
});

test('a configured repository marker uses the target origin when project root differs', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'main' });
  const worktree = cloneWorktree(dir, bare, env);
  git(worktree, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'], env);
  const projectRoot = path.join(dir, 'project-root');
  fs.mkdirSync(projectRoot, { recursive: true });
  spawnSync('git', ['init', '-q', projectRoot], { env });
  git(projectRoot, ['remote', 'add', 'origin', 'https://github.com/acme/project-config.git'], env);
  const planning = path.join(projectRoot, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({
    delivery_pipeline: { comment_markers: { 'acme/app': ['@ai-generated'] } },
  }));
  const source = path.join(worktree, 'src', 'app.js');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '// @ai-generated model=x\nconst answer = 42;\n');
  git(worktree, ['add', 'src/app.js'], env);

  assert.strictEqual(commentPolicy.repositorySlug(projectRoot), 'acme/project-config');
  assert.strictEqual(commentPolicy.repositorySlug(worktree), 'acme/app');
  const r = run(worktree, { env, extra: ['--project-root', projectRoot] });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const report = commentPolicy.analyze(worktree, 'origin/main', {
    workingTree: true,
    projectRoot,
    repo: commentPolicy.repositorySlug(worktree),
  });
  assert.deepStrictEqual(report.policy.allowed_markers, [
    '@invariant:', '@security:', '@contract:', '@ai-generated',
  ]);
});

test('publish gate ignores a tempting target config when the project root is omitted', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'main' });
  const worktree = cloneWorktree(dir, bare, env);
  git(worktree, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'], env);
  const planning = path.join(worktree, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({
    delivery_pipeline: { comment_markers: { 'acme/app': ['@ai-generated'] } },
  }));
  const source = path.join(worktree, 'src', 'app.js');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '// @ai-generated model=x\nconst answer = 42;\n');
  git(worktree, ['add', 'src/app.js'], env);

  const r = run(worktree, { env, extra: ['--base', 'origin/main'] });
  assert.strictEqual(r.status, 1, r.stderr || r.stdout);
  assert.deepStrictEqual(r.json.violations, ['src/app.js']);
});

test('no candidate at all exits 2, naming the tried candidates', () => {
  const { dir, env } = root();
  const worktree = path.join(dir, 'lone');
  spawnSync('git', ['init', '-q', worktree], { env });
  const r = run(worktree, { env });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /cannot resolve a base ref/);
  assert.match(r.stderr, /origin\/main/);
});

test('SHIPYARD_PROJECT_ROOT wins over the main-worktree discovery', () => {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'main', extraBranches: ['epic/43-y'] });
  const worktree = cloneWorktree(dir, bare, env);
  const otherRoot = path.join(dir, 'other-project');
  fs.mkdirSync(otherRoot, { recursive: true });
  writeState(otherRoot, 'T-43-01', 'epic/43-y');
  const r = run(worktree, { env: { ...env, SHIPYARD_PROJECT_ROOT: otherRoot }, ticket: 'T-43-01' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.base, 'origin/epic/43-y');
  assert.strictEqual(r.json.base_source, 'recorded');
});

suite('publish-gate — a supplied remote commit cannot hide newly introduced code');

function pushedFeature() {
  const { dir, env } = root();
  const bare = makeOrigin(dir, env, { defaultBranch: 'main' });
  const worktree = cloneWorktree(dir, bare, env);
  for (const [key, val] of [['user.email', 'pg@example.com'], ['user.name', 'pg test'], ['commit.gpgsign', 'false']]) {
    git(worktree, ['config', key, val], env);
  }
  git(worktree, ['checkout', '-q', '-b', 'feature'], env);
  fs.writeFileSync(path.join(worktree, 'app.js'), 'const value = 1;\n// forged-range commentary\n');
  git(worktree, ['add', 'app.js'], env);
  git(worktree, ['commit', '-q', '-m', 'comment'], env);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const rows = JSON.stringify([{ number: 7, baseRefName: 'main', headRefName: 'feature' }]);
  fs.writeFileSync(path.join(bin, 'gh'), "#!/bin/sh\nprintf '%s\\n' '" + rows + "'\n", { mode: 0o755 });
  const prEnv = { ...env, PATH: bin + path.delimiter + env.PATH };
  delete prEnv.SHIPYARD_GRAPH_DIR;
  return { dir, env: prEnv, worktree, head: git(worktree, ['rev-parse', 'HEAD'], env) };
}

function pushCheck(f, pushBase) {
  const argv = [SCRIPT, '--managed', '--worktree', f.worktree, '--branch', 'feature', '--head', f.head,
    '--push-base', pushBase, '--json'];
  const r = spawnSync(process.execPath, argv, { cwd: f.worktree, encoding: 'utf8', env: f.env });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, stderr: r.stderr || '', json };
}

test('a push base equal to the pushed head still reviews the open PR diff', () => {
  const f = pushedFeature();
  const r = pushCheck(f, f.head);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.json.base, 'origin/main');
  assert.strictEqual(r.json.base_source, 'pull-request');
  assert.strictEqual(r.json.push_base, f.head);
  assert.deepStrictEqual(r.json.violations, ['app.js']);
});

test('an unrelated push base with an identical tree is refused', () => {
  const f = pushedFeature();
  git(f.worktree, ['checkout', '-q', '--orphan', 'orphan'], f.env);
  git(f.worktree, ['commit', '-q', '-m', 'orphan copy'], f.env);
  const orphan = git(f.worktree, ['rev-parse', 'HEAD'], f.env);
  git(f.worktree, ['checkout', '-q', '-f', 'feature'], f.env);
  const r = pushCheck(f, orphan);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /shares no history/);
});

test('a rewritten push base keeps the direct remote range and blocks', () => {
  const f = pushedFeature();
  git(f.worktree, ['checkout', '-q', '-b', 'rewritten', 'origin/main'], f.env);
  fs.writeFileSync(path.join(f.worktree, 'other.js'), 'const other = 1;\n');
  git(f.worktree, ['add', 'other.js'], f.env);
  git(f.worktree, ['commit', '-q', '-m', 'rewritten remote'], f.env);
  const rewritten = git(f.worktree, ['rev-parse', 'HEAD'], f.env);
  git(f.worktree, ['checkout', '-q', 'feature'], f.env);
  const r = pushCheck(f, rewritten);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.json.base, rewritten);
  assert.strictEqual(r.json.base_source, 'remote-oid');
});

test('a zero push base is refused', () => {
  const f = pushedFeature();
  const r = pushCheck(f, '0'.repeat(40));
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /nonzero Git commit OID/);
});

done();
