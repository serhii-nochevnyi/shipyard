'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const reachability = require('../../plugins/delivery-pipeline/scripts/run-reachability.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-reachability-'));
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...options.env },
  }).trim();
}

function writeCommit(root, file, value, message) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), value);
  git(root, ['add', file]);
  git(root, ['-c', 'user.email=reachability@example.com', '-c', 'user.name=Reachability', 'commit', '-qm', message]);
}

function fixture() {
  const root = tempDir();
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  git(root, ['init', '-q', '--bare', origin]);
  git(root, ['init', '-q', '-b', 'main', seed]);
  git(seed, ['remote', 'add', 'origin', origin]);
  writeCommit(seed, 'src/existing.txt', 'one\n', 'initial');
  git(seed, ['push', '-q', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['clone', '-q', origin, clone]);
  git(clone, ['config', 'user.email', 'reachability@example.com']);
  git(clone, ['config', 'user.name', 'Reachability']);
  return { root, origin, seed, clone };
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

test('proves the live origin base and reports a stale local base without using it', () => {
  const f = fixture();
  try {
    writeCommit(f.seed, 'src/existing.txt', 'two\n', 'base moved');
    git(f.seed, ['push', '-q', 'origin', 'main']);
    git(f.clone, ['fetch', '-q', 'origin']);
    const result = reachability.proveReachability({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/T-37-05',
      worktree: path.join(f.root, 'worktree'),
      declared: ['src/existing.txt', 'src/new-file.txt'],
    });
    assert.equal(result.status, 'reachable');
    assert.equal(result.ok, true);
    assert.equal(result.origin.ref, 'origin/main');
    assert.equal(result.origin.sha, git(f.seed, ['rev-parse', 'main']));
    assert.equal(result.origin.local_stale, true);
    assert.deepEqual(result.declared.missing_declarations, ['src/new-file.txt']);
    assert.equal(result.branch.kind, 'new');
  } finally {
    cleanup(f);
  }
});

test('holds a stale child as retryable pending and does not move its branch', () => {
  const f = fixture();
  try {
    const old = git(f.clone, ['rev-parse', 'main']);
    git(f.clone, ['branch', 'ticket/stale', 'main']);
    writeCommit(f.seed, 'src/existing.txt', 'two\n', 'base moved');
    git(f.seed, ['push', '-q', 'origin', 'main']);
    git(f.clone, ['fetch', '-q', 'origin']);
    const result = reachability.prove({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/stale',
      worktree: path.join(f.root, 'stale-worktree'),
      declared: ['src/existing.txt'],
    });
    assert.equal(result.exitCode, reachability.RETRYABLE_EXIT);
    assert.equal(result.result.status, 'retryable_pending');
    assert.equal(result.result.reason.code, 'BASE_NOT_ANCESTOR');
    assert.equal(git(f.clone, ['rev-parse', 'refs/heads/ticket/stale']), old);
  } finally {
    cleanup(f);
  }
});

test('accepts a clean local-only child branch when the live base is its ancestor', () => {
  const f = fixture();
  try {
    git(f.clone, ['branch', 'ticket/local-only', 'origin/main']);
    const before = git(f.clone, ['rev-parse', 'refs/heads/ticket/local-only']);
    const result = reachability.proveReachability({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/local-only',
      worktree: path.join(f.root, 'local-only-worktree'),
      declared: ['src/existing.txt'],
    });
    assert.equal(result.status, 'reachable');
    assert.equal(result.branch.kind, 'existing-branch');
    assert.equal(result.branch.remote_branch_sha, null);
    assert.equal(git(f.clone, ['rev-parse', 'refs/heads/ticket/local-only']), before);
  } finally {
    cleanup(f);
  }
});

test('proves worktree ownership and refuses a path registered to another branch', () => {
  const f = fixture();
  try {
    const worktree = path.join(f.root, 'owned-worktree');
    git(f.clone, ['worktree', 'add', '-q', '-b', 'ticket/owned', worktree, 'origin/main']);
    const result = reachability.proveReachability({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/owned',
      worktree,
      declared: ['src/existing.txt'],
    });
    assert.equal(result.status, 'reachable');
    assert.equal(result.branch.kind, 'reused');
    const refused = reachability.prove({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/other',
      worktree,
      declared: ['src/existing.txt'],
    });
    assert.equal(refused.result.status, 'retryable_pending');
    assert.equal(refused.result.reason.code, 'WORKTREE_BRANCH_MISMATCH');
    assert.equal(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ticket/owned');
  } finally {
    cleanup(f);
  }
});

test('does not accept an ambiguous origin or an escaping declaration', () => {
  const f = fixture();
  try {
    git(f.clone, ['remote', 'set-url', '--add', 'origin', f.origin]);
    const ambiguous = reachability.prove({
      repo: f.clone,
      base: 'main',
      branch: 'ticket/ambiguous',
      worktree: path.join(f.root, 'ambiguous-worktree'),
      declared: ['src/existing.txt'],
    });
    assert.equal(ambiguous.result.reason.code, 'ORIGIN_AMBIGUOUS');
  } finally {
    cleanup(f);
  }
  const g = fixture();
  try {
    const escaping = reachability.prove({
      repo: g.clone,
      base: 'main',
      branch: 'ticket/escaping',
      worktree: path.join(g.root, 'escaping-worktree'),
      declared: ['../outside.txt'],
    });
    assert.equal(escaping.result.reason.code, 'DECLARATION_UNREACHABLE');
  } finally {
    cleanup(g);
  }
});
