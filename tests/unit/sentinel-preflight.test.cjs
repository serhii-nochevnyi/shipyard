'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPT = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/sentinel-preflight.cjs');
const pre = require(SCRIPT);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-preflight-'));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let counter = 0;

function fixture({ trackGraph = true } = {}) {
  counter += 1;
  const dir = path.join(ROOT, `f${counter}`);
  const origin = path.join(dir, 'origin.git');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, wt);
  fs.mkdirSync(path.join(wt, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.planning', 'graph', 'delivery-state.json'), '{}');
  fs.writeFileSync(path.join(wt, 'src.txt'), 'base\n');
  git(wt, 'add', trackGraph ? '.' : 'src.txt');
  git(wt, 'commit', '--quiet', '-m', 'seed');
  git(wt, 'push', '--quiet', 'origin', 'main');
  const graphDir = path.join(wt, '.planning', 'graph');
  return { dir, origin, wt, graphDir };
}

function foreignRepo(dir) {
  const origin = path.join(dir, 'foreign-origin.git');
  const wt = path.join(dir, 'foreign-wt');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, wt);
  fs.writeFileSync(path.join(wt, 'f.txt'), 'base\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '--quiet', '-m', 'seed foreign');
  git(wt, 'push', '--quiet', 'origin', 'main');
  return { origin, wt };
}

function noopRun() {}

suite('sentinel-preflight: single repository');

test('unreachable origin refuses, naming the fetch command', () => {
  const f = fixture();
  git(f.wt, 'remote', 'set-url', 'origin', path.join(f.dir, 'missing.git'));
  assert.throws(
    () => pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run: noopRun }),
    (error) => error.code === 'BASE_FETCH_FAILED'
      && error.message.includes(`git -C ${f.wt} fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main`),
  );
});

test('a behind local base is fast-forwarded to the fetched origin tip', () => {
  const f = fixture();
  const other = `${f.wt}-other`;
  git(f.dir, 'clone', '--quiet', f.origin, other);
  fs.writeFileSync(path.join(other, 'src.txt'), 'advanced\n');
  git(other, 'add', '.');
  git(other, 'commit', '--quiet', '-m', 'advance origin');
  git(other, 'push', '--quiet', 'origin', 'main');
  const advanced = git(other, 'rev-parse', 'main');
  const behind = git(f.wt, 'rev-parse', 'main');
  assert.notStrictEqual(behind, advanced);

  const result = pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run: noopRun });
  assert.strictEqual(result.base_oid, advanced);
  assert.strictEqual(git(f.wt, 'rev-parse', 'refs/heads/main'), advanced);
  assert.strictEqual(result.synced, true);
  assert.strictEqual(result.committed, null);
});

test('a diverged local base refuses, naming branch -f and the rebase alternative', () => {
  const f = fixture();
  const other = `${f.wt}-other`;
  git(f.dir, 'clone', '--quiet', f.origin, other);
  fs.writeFileSync(path.join(other, 'src.txt'), 'origin-side\n');
  git(other, 'add', '.');
  git(other, 'commit', '--quiet', '-m', 'origin-side commit');
  git(other, 'push', '--quiet', 'origin', 'main');

  fs.writeFileSync(path.join(f.wt, 'local-only.txt'), 'local\n');
  git(f.wt, 'add', '.');
  git(f.wt, 'commit', '--quiet', '-m', 'local-only commit');

  assert.throws(
    () => pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run: noopRun }),
    (error) => error.code === 'BASE_DIVERGED'
      && error.message.includes(`git -C ${f.wt} branch -f main origin/main`)
      && error.message.includes(`git -C ${f.wt} rebase origin/main main`),
  );
});

test('a tracked graph change is committed with the conventional subject', () => {
  const f = fixture();
  const run = () => {
    fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({ synced: true }));
  };
  const before = git(f.wt, 'rev-parse', 'HEAD');
  const result = pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run });
  assert.notStrictEqual(result.committed, null);
  assert.notStrictEqual(git(f.wt, 'rev-parse', 'HEAD'), before);
  assert.strictEqual(git(f.wt, 'log', '-1', '--format=%s'), 'chore: sync delivery state');
  assert.deepStrictEqual(git(f.wt, 'diff', '--name-only', before, 'HEAD').split('\n'),
    ['.planning/graph/delivery-state.json']);
  assert.strictEqual(git(f.wt, 'status', '--porcelain'), '');
});

test('untracked .planning/ commits nothing and passes', () => {
  const f = fixture({ trackGraph: false });
  const run = () => {
    fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({ synced: true }));
  };
  const before = git(f.wt, 'rev-parse', 'HEAD');
  const result = pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run });
  assert.strictEqual(result.committed, null);
  assert.strictEqual(git(f.wt, 'rev-parse', 'HEAD'), before);
});

test('a dirty tracked source file outside .planning/graph/ refuses, naming status', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.wt, 'src.txt'), 'dirty\n');
  assert.throws(
    () => pre.preflight({ worktree: f.wt, base: 'main', graphDir: f.graphDir, run: noopRun }),
    (error) => error.code === 'WORKTREE_DIRTY' && error.message.includes(`git -C ${f.wt} status`)
      && error.message.includes('src.txt'),
  );
});

test('a state-sync failure refuses, naming the command to run', () => {
  const f = fixture();
  assert.throws(
    () => pre.preflight({
      worktree: f.wt, base: 'main', graphDir: f.graphDir,
      run: () => { throw new Error('boom'); },
    }),
    (error) => error.code === 'STATE_SYNC_FAILED' && error.message.includes('boom')
      && error.message.includes(`cd ${f.wt} && node`) && error.message.includes('state-sync.cjs'),
  );
});

suite('sentinel-preflight: multi-repository round (D-44)');

test('each base is fetched in its own clone and both base oids are returned', () => {
  const f = fixture();
  const foreign = foreignRepo(f.dir);
  const foreignHead = git(foreign.wt, 'rev-parse', 'HEAD');
  const projectMainBefore = git(f.wt, 'rev-parse', 'main');
  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({
    'T-01-01': { repo_resolution: { resolution: 'configured', executable: true, repository_root: foreign.wt } },
  }));

  const result = pre.preflightRound({
    projectWorktree: f.wt,
    graphDir: f.graphDir,
    prs: [
      { ticket: 'T-00-01', repo: null, base: 'main' },
      { ticket: 'T-01-01', repo: 'acme/frontend', base: 'main' },
    ],
    run: noopRun,
  });

  assert.strictEqual(result.repos.length, 2);
  const project = result.repos.find((entry) => entry.repo === null);
  const frontend = result.repos.find((entry) => entry.repo === 'acme/frontend');
  assert.strictEqual(project.root, path.resolve(f.wt));
  assert.strictEqual(project.base_oid, projectMainBefore);
  assert.strictEqual(frontend.root, path.resolve(foreign.wt));
  assert.strictEqual(frontend.base_oid, foreignHead);
  assert.notStrictEqual(project.base_oid, frontend.base_oid);
});

test('a dirty file and a behind local base in the second clone are left untouched and do not refuse the round', () => {
  const f = fixture();
  const foreign = foreignRepo(f.dir);
  const other = `${foreign.wt}-other`;
  git(f.dir, 'clone', '--quiet', foreign.origin, other);
  fs.writeFileSync(path.join(other, 'f.txt'), 'advanced\n');
  git(other, 'add', '.');
  git(other, 'commit', '--quiet', '-m', 'advance foreign origin');
  git(other, 'push', '--quiet', 'origin', 'main');
  const advanced = git(other, 'rev-parse', 'main');
  const behindLocal = git(foreign.wt, 'rev-parse', 'main');
  assert.notStrictEqual(behindLocal, advanced);
  fs.writeFileSync(path.join(foreign.wt, 'f.txt'), 'dirty and uncommitted\n');

  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({
    'T-01-01': { repo_resolution: { resolution: 'configured', executable: true, repository_root: foreign.wt } },
  }));

  const result = pre.preflightRound({
    projectWorktree: f.wt,
    graphDir: f.graphDir,
    prs: [{ ticket: 'T-01-01', repo: 'acme/frontend', base: 'main' }],
    run: noopRun,
  });

  assert.strictEqual(result.repos[0].base_oid, advanced);
  assert.strictEqual(git(foreign.wt, 'rev-parse', 'refs/heads/main'), behindLocal);
  assert.strictEqual(fs.readFileSync(path.join(foreign.wt, 'f.txt'), 'utf8'), 'dirty and uncommitted\n');
});

test('an executable:false resolution refuses REPO_UNRESOLVED naming the pipeline.repos key', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({
    'T-01-01': { repo_resolution: { resolution: 'undiscovered', executable: false, repository_root: null, reason: 'no checkout found' } },
  }));
  assert.throws(
    () => pre.preflightRound({
      projectWorktree: f.wt,
      graphDir: f.graphDir,
      prs: [{ ticket: 'T-01-01', repo: 'acme/frontend', base: 'main' }],
      run: noopRun,
    }),
    (error) => error.code === 'REPO_UNRESOLVED'
      && error.message.includes('T-01-01') && error.message.includes('acme/frontend')
      && error.message.includes('pipeline.repos["acme/frontend"]'),
  );
});

test('the same branch name with different oids in two repositories is not a conflict', () => {
  const f = fixture();
  const foreign = foreignRepo(f.dir);
  fs.writeFileSync(path.join(f.graphDir, 'delivery-state.json'), JSON.stringify({
    'T-01-01': { repo_resolution: { resolution: 'configured', executable: true, repository_root: foreign.wt } },
  }));
  const result = pre.preflightRound({
    projectWorktree: f.wt,
    graphDir: f.graphDir,
    prs: [
      { ticket: 'T-00-01', repo: null, base: 'main' },
      { ticket: 'T-01-01', repo: 'acme/frontend', base: 'main' },
    ],
    run: noopRun,
  });
  assert.strictEqual(result.repos.length, 2);
});

done();
