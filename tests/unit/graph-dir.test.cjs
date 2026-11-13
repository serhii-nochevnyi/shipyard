'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { resolveGraphDir, projectWorktree } = require('../../plugins/delivery-pipeline/scripts/graph-dir.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeGraph(root, tickets, extra = {}) {
  const dir = path.join(root, '.planning', 'graph');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tickets.json'), JSON.stringify({ ...extra, tickets }));
  return dir;
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-graph-dir-')));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Graph Dir Test');
  git(main, 'config', 'user.email', 'graph-dir@example.test');
  fs.writeFileSync(path.join(main, 'README.md'), 'root\n');
  git(main, 'add', '.');
  git(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const mainGraph = writeGraph(main, {
    'T-01-01': { branch: 'ticket/T-01-01-old', epic: 'epic/01-old' },
    'T-01-02': { branch: 'feat/hygiene-ticket', epic: 'feat/old-epic' },
  }, { epics: { 1: { branch: 'epic/01-old' } } });
  const worktree = (name, branch, ...extra) => {
    const dir = path.join(root, name);
    git(main, 'worktree', 'add', '-q', ...extra, ...(branch ? ['-b', branch] : []), dir);
    return dir;
  };
  return { root, main, mainGraph, worktree };
}

function withCwd(dir, run) {
  const saved = process.env.SHIPYARD_GRAPH_DIR;
  const original = process.cwd();
  delete process.env.SHIPYARD_GRAPH_DIR;
  process.chdir(dir);
  try { return run(); } finally {
    process.chdir(original);
    if (saved !== undefined) process.env.SHIPYARD_GRAPH_DIR = saved;
  }
}

const ownTickets = { 'T-02-01': { branch: 'ticket/T-02-01-new', epic: 'epic/02-new' } };

suite('graph-dir — linked project worktree');

test('a linked project worktree resolves its own untracked graph, from the worktree argument and from cwd', () => {
  const f = fixture();
  try {
    const project = f.worktree('project', 'project/next');
    const graphDir = writeGraph(project, ownTickets);
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], project), { dir: graphDir, how: 'project-worktree' });
    });
    withCwd(project, () => {
      assert.deepEqual(resolveGraphDir([], null), { dir: graphDir, how: 'project-worktree' });
    });
    assert.equal(projectWorktree(graphDir, { graphDir }).worktree, project);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('the main checkout keeps its own graph', () => {
  const f = fixture();
  try {
    f.worktree('project', 'project/next');
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], f.main), { dir: f.mainGraph, how: 'worktree-repo' });
    });
    assert.equal(projectWorktree(f.mainGraph, { graphDir: f.mainGraph }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ticket, epic and graph-named branches with an untracked copy resolve to the main checkout', () => {
  const f = fixture();
  try {
    const cases = [
      f.worktree('ticket', 'ticket/T-02-01-new'),
      f.worktree('epic', 'epic/02-new'),
      f.worktree('row-branch', 'feat/hygiene-ticket'),
      f.worktree('row-epic', 'feat/old-epic'),
    ];
    for (const dir of cases) {
      const copy = writeGraph(dir, ownTickets);
      withCwd(os.tmpdir(), () => {
        assert.deepEqual(resolveGraphDir([], dir), { dir: f.mainGraph, how: 'worktree-repo' }, dir);
      });
      assert.equal(projectWorktree(copy, { graphDir: copy }), null, dir);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a branch named by the local graph alone is a delivery worktree', () => {
  const f = fixture();
  try {
    const dir = f.worktree('local-row', 'feat/new-ticket');
    const copy = writeGraph(dir, { 'T-02-01': { branch: 'feat/new-ticket' } });
    assert.equal(projectWorktree(copy, { graphDir: copy }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a detached linked worktree is never a project worktree', () => {
  const f = fixture();
  try {
    const dir = f.worktree('detached', null, '--detach');
    const copy = writeGraph(dir, ownTickets);
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], dir), { dir: f.mainGraph, how: 'worktree-repo' });
    });
    assert.equal(projectWorktree(copy, { graphDir: copy }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a graph whose tickets the main checkout already holds is a copy, not a project graph', () => {
  const f = fixture();
  try {
    const dir = f.worktree('copy', 'project/copy');
    const copy = writeGraph(dir, { 'T-01-01': { branch: 'ticket/T-01-01-old' } });
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], dir), { dir: f.mainGraph, how: 'worktree-repo' });
    });
    assert.equal(projectWorktree(copy, { graphDir: copy }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a graph tracked in a linked worktree keeps main-first resolution, on a ticket or a project branch', () => {
  const f = fixture();
  try {
    for (const [name, branch] of [['tracked-ticket', 'ticket/T-02-01-new'], ['tracked-project', 'project/tracked']]) {
      const dir = f.worktree(name, branch);
      writeGraph(dir, ownTickets);
      git(dir, 'add', '.planning/graph/tickets.json');
      git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tracked graph');
      withCwd(os.tmpdir(), () => {
        assert.deepEqual(resolveGraphDir([], dir), { dir: f.mainGraph, how: 'worktree-repo' }, name);
      });
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a graph-less project worktree with its own untracked .planning reports none, not the main graph', () => {
  const f = fixture();
  try {
    const dir = f.worktree('graphless', 'project/graphless');
    fs.mkdirSync(path.join(dir, '.planning', 'investigations'), { recursive: true });
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], dir), { dir: path.join(dir, '.planning', 'graph'), how: 'none' });
    });
    const bare = f.worktree('bare', 'project/bare');
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], bare), { dir: f.mainGraph, how: 'worktree-repo' });
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a ticket worktree of a project-worktree graph resolves main by default and the named graph explicitly', () => {
  const f = fixture();
  try {
    const project = f.worktree('project', 'project/next');
    const graphDir = writeGraph(project, ownTickets);
    const ticket = f.worktree('ticket', 'ticket/T-02-01-new');
    withCwd(os.tmpdir(), () => {
      assert.deepEqual(resolveGraphDir([], ticket), { dir: f.mainGraph, how: 'worktree-repo' });
      process.env.SHIPYARD_GRAPH_DIR = graphDir;
      try {
        assert.deepEqual(resolveGraphDir([], ticket), { dir: graphDir, how: 'env' });
      } finally { delete process.env.SHIPYARD_GRAPH_DIR; }
    });
    assert.equal(projectWorktree(graphDir, { graphDir, requester: ticket }).worktree, project);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a requester from another repository does not extend acceptance to a project worktree graph', () => {
  const f = fixture();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-graph-dir-other-')));
  try {
    git(other, 'init', '-q', '-b', 'main');
    const project = f.worktree('project', 'project/next');
    const graphDir = writeGraph(project, ownTickets);
    assert.equal(projectWorktree(graphDir, { graphDir, requester: other }), null);
    assert.equal(projectWorktree(graphDir, { graphDir, requester: path.join(other, 'missing') }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('an unreadable local or main graph refuses the project-worktree status', () => {
  const f = fixture();
  try {
    const project = f.worktree('project', 'project/next');
    const graphDir = path.join(project, '.planning', 'graph');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), '{not json');
    assert.equal(projectWorktree(graphDir, { graphDir }), null);
    writeGraph(project, ownTickets);
    fs.writeFileSync(path.join(f.mainGraph, 'tickets.json'), '[]');
    assert.equal(projectWorktree(graphDir, { graphDir }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

done();
