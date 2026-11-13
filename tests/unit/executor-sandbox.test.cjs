'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, done, assert } = require('./assert-harness.cjs');
const { normalizeConfig, resolveExecutorSandbox } = require('../../plugins/delivery-pipeline/scripts/executor-sandbox.cjs');
const { loadConfig } = require('../../plugins/delivery-pipeline/scripts/pipeline-config.cjs');

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-executor-sandbox-')));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'wt', 'T-1');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'root');
  git(repo, 'worktree', 'add', '-q', '-b', 'ticket/T-1', worktree);
  return { base, home, repo, worktree };
}

const refused = (pattern) => (error) => error.code === 'EXECUTOR_SANDBOX_INVALID' && pattern.test(error.message);

test('config shape: arrays of plain absolute or home paths and lowercase host names', () => {
  assert.deepEqual(normalizeConfig({ allow_write: ['~/.cache/pnpm', '/opt/cache', '/opt/cache'], allowed_domains: ['registry.npmjs.org', '*.npmjs.org'] }),
    { ok: true, value: { allow_write: ['~/.cache/pnpm', '/opt/cache'], allowed_domains: ['registry.npmjs.org', '*.npmjs.org'] } });
  assert.deepEqual(normalizeConfig({}), { ok: true, value: { allow_write: [], allowed_domains: [] } });
  for (const bad of [[], 'x', { other: [] }, { allow_write: 'x' }, { allow_write: ['relative'] }, { allow_write: ['/opt/*'] },
    { allow_write: ['/opt/../etc'] }, { allowed_domains: ['*'] }, { allowed_domains: ['https://npmjs.org'] },
    { allowed_domains: ['Registry.NPMJS.org'] }, { allowed_domains: ['localhost'] }]) {
    assert.equal(normalizeConfig(bad).ok, false, JSON.stringify(bad));
  }
});

test('loadConfig keeps a valid executor_sandbox and warns about an invalid one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-executor-sandbox-config-'));
  try {
    fs.mkdirSync(path.join(root, '.planning'));
    const write = (value) => fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ delivery_pipeline: { executor_sandbox: value } }));
    write({ allow_write: ['~/.cache/node/corepack'], allowed_domains: ['registry.npmjs.org'] });
    assert.deepEqual(loadConfig(root).config.executor_sandbox, { allow_write: ['~/.cache/node/corepack'], allowed_domains: ['registry.npmjs.org'] });
    write({ allow_write: ['cache'] });
    const loaded = loadConfig(root);
    assert.equal(loaded.config.executor_sandbox, null);
    assert.ok(loaded.warnings.some((warning) => warning.includes('executor_sandbox')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolution expands home paths and accepts unrelated caches', () => {
  const f = fixture();
  try {
    assert.deepEqual(resolveExecutorSandbox(null, { home: f.home, worktree: f.worktree }), { allowWrite: [], allowedDomains: [] });
    const resolved = resolveExecutorSandbox({ allow_write: ['~/.cache/node/corepack', '~/.local/state/fnm_multishells', path.join(f.base, 'opt')],
      allowed_domains: ['registry.npmjs.org'] }, { home: f.home, worktree: f.worktree });
    assert.deepEqual(resolved.allowWrite, [path.join(f.home, '.cache/node/corepack'), path.join(f.home, '.local/state/fnm_multishells'), path.join(f.base, 'opt')]);
    assert.deepEqual(resolved.allowedDomains, ['registry.npmjs.org']);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('resolution refuses paths that contain or enter host-owned roots', () => {
  const f = fixture();
  const resolve = (entry, extra) => resolveExecutorSandbox({ allow_write: [entry] }, { home: f.home, worktree: f.worktree, protectedPaths: extra });
  try {
    assert.throws(() => resolve('/'), refused(/home directory/));
    assert.throws(() => resolve('~/'), refused(/home directory/));
    assert.throws(() => resolve(f.base), refused(/home directory/));
    assert.throws(() => resolve(path.join(f.base, 'wt')), refused(/ticket worktree/));
    for (const entry of ['~/.ssh', '~/.ssh/keys', '~/.gnupg', '~/.claude', '~/.codex', '~/.config/gh', '~/.local/state/shipyard/claude', '~/.local/state', '~/.gitconfig']) {
      assert.throws(() => resolve(entry), refused(/host-owned/), entry);
    }
    assert.throws(() => resolve(path.join(f.repo, 'node_modules')), refused(/host-owned/));
    assert.throws(() => resolve(path.join(f.repo, '.git', 'hooks')), refused(/host-owned/));
    assert.throws(() => resolve(path.join(f.base, 'state', 'x'), [path.join(f.base, 'state')]), refused(/host-owned/));
    fs.symlinkSync(path.join(f.home, '.ssh'), path.join(f.base, 'link'));
    fs.mkdirSync(path.join(f.home, '.ssh'));
    assert.throws(() => resolve(path.join(f.base, 'link', 'x')), refused(/host-owned/));
    assert.throws(() => resolveExecutorSandbox({ allow_write: ['relative'] }, { home: f.home }), refused(/must be absolute/));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

done();
