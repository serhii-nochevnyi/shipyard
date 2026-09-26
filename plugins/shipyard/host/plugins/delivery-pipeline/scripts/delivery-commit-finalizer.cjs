'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse, owns } = require('./path-owner.cjs');
const SCRATCH = new Set(['.shipyard-pr-body.md', '.shipyard-evidence.md']);

function fail(message) {
  throw new Error(`delivery commit finalizer: ${message}`);
}

function git(worktree, args, env, options = {}) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: options.binary ? 'buffer' : 'utf8',
      input: options.input,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    fail(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

function entriesFromStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const entry = fields[i];
    if (entry.length < 4 || entry[2] !== ' ') fail('unrecognized Git status entry');
    const status = entry.slice(0, 2);
    if (status.includes('U') || status === 'AA' || status === 'DD') fail('unmerged paths are present');
    entries.push({ path: entry.slice(3), status });
    if (/[RC]/.test(status)) {
      i++;
      if (i >= fields.length - 1) fail('incomplete Git rename status');
      entries.push({ path: fields[i], status });
    }
  }
  return entries;
}

function scopedStatus(worktree, env) {
  const entries = entriesFromStatus(git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env, { binary: true }));
  for (const name of SCRATCH) {
    let file;
    try {
      file = fs.lstatSync(path.join(worktree, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink()) fail(`scratch document must be a regular non-symlink file: ${name}`);
  }
  const paths = new Set();
  for (const entry of entries) {
    if (SCRATCH.has(entry.path) && entry.status === '??') {
      continue;
    } else {
      paths.add(entry.path);
    }
  }
  return [...paths];
}

function nulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function validDeclaration(declaration) {
  if (typeof declaration !== 'string' || !declaration || declaration.includes('\0') || declaration.includes('\\')) return false;
  const body = declaration.endsWith('/**') ? declaration.slice(0, -3) : declaration.replace(/\/+$/, '');
  if (body.startsWith('/') || body.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return !parse(declaration).error;
}

function requireOid(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) fail(`${label} must be a full commit ID`);
  return value;
}

function indexSnapshot(indexPath) {
  const stat = fs.lstatSync(indexPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ordinary Git index must be a regular file');
  return { stat, bytes: fs.readFileSync(indexPath) };
}

function sameIndex(indexPath, original) {
  const current = indexSnapshot(indexPath);
  return current.bytes.equals(original.bytes) &&
    ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((field) => current.stat[field] === original.stat[field]);
}

function indexEntries(worktree, env) {
  const entries = new Map();
  for (const entry of nulPaths(git(worktree, ['ls-files', '--stage', '-z'], env, { binary: true }))) {
    const tab = entry.indexOf('\t');
    if (tab < 0) fail('unrecognized Git index entry');
    entries.set(entry.slice(tab + 1), entry.slice(0, tab));
  }
  return entries;
}

function finalizeDeliveryCommit(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('trusted host options are required');
  const { ticket, worktree, expectedBranch, expectedBase, expectedHead, expectedSigner } = options;
  const declared = options.files_modified;
  if (typeof ticket !== 'string' || !/^T-\d{2}-\d{2}$/.test(ticket)) fail('ticket must be a ticket ID');
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) fail('worktree must be an absolute path');
  if (typeof expectedBranch !== 'string' || !expectedBranch) fail('expectedBranch is required');
  requireOid(expectedBase, 'expectedBase');
  requireOid(expectedHead, 'expectedHead');
  if (!Array.isArray(declared) || !declared.length || declared.some((entry) => !validDeclaration(entry))) {
    fail('files_modified must contain valid repository-relative declarations');
  }
  if (typeof expectedSigner !== 'string' || !expectedSigner.trim()) fail('expectedSigner is required');

  const root = fs.realpathSync(worktree);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;

  if (path.resolve(git(root, ['rev-parse', '--show-toplevel'], env).trim()) !== root) fail('worktree is not the repository root');
  const branchRef = git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim();
  if (branchRef !== `refs/heads/${expectedBranch}`) fail('branch differs from expectedBranch');
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim();
  if (head !== expectedHead) fail('HEAD differs from expectedHead');
  const base = git(root, ['rev-parse', '--verify', `${expectedBase}^{commit}`], env).trim();
  if (base !== expectedBase) fail('base differs from expectedBase');
  let ancestor;
  try {
    ancestor = git(root, ['merge-base', base, head], env).trim();
  } catch {
    fail('expectedBase is not an ancestor of HEAD');
  }
  if (ancestor !== base) fail('expectedBase is not an ancestor of HEAD');

  const covered = (file) => declared.some((entry) => owns(entry, file));
  const committed = nulPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', base, head], env, { binary: true }));
  const status = scopedStatus(root, env);
  const outside = [...new Set([...committed, ...status].filter((file) => !covered(file)))];
  if (outside.length) fail(`out-of-scope paths: ${outside.join(', ')}`);
  if (!status.length) fail('no worktree changes to commit');
  const indexPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index'], env).trim());
  const originalIndex = indexSnapshot(indexPath);

  const signingKey = git(root, ['config', '--get', 'user.signingkey'], env).trim();
  if (!signingKey) fail('host Git signer is not configured');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-commit-index-'));
  const privateEnv = { ...env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  try {
    git(root, ['read-tree', head], privateEnv);
    git(root, ['add', '--all', '--', ...status.map((file) => `:(literal)${file}`)], privateEnv);
    const staged = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], privateEnv, { binary: true }));
    if (!staged.length) fail('no staged changes to commit');
    const stagedOutside = staged.filter((file) => !covered(file));
    if (stagedOutside.length) fail(`out-of-scope staged paths: ${stagedOutside.join(', ')}`);
    if (status.some((file) => !staged.includes(file))) fail('worktree changes could not all be staged');
    const originalEntries = indexEntries(root, env);
    const privateEntries = indexEntries(root, privateEnv);
    const originallyStaged = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], env, { binary: true }));
    if (originallyStaged.some((file) => originalEntries.get(file) !== privateEntries.get(file))) {
      fail('staged index content differs from worktree content');
    }
    const currentStatus = scopedStatus(root, env);
    if (currentStatus.some((file) => !covered(file))) fail('out-of-scope changes appeared during finalization');
    if (currentStatus.length !== status.length || currentStatus.some((file) => !status.includes(file))) {
      fail('worktree paths changed during finalization');
    }
    if (nulPaths(git(root, ['diff', '--name-only', '-z'], privateEnv, { binary: true })).length) {
      fail('worktree content changed during finalization');
    }
    if (git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim() !== head ||
        git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim() !== branchRef) fail('branch moved during finalization');

    const tree = git(root, ['write-tree'], privateEnv).trim();
    if (options.expectedTree !== undefined && tree !== requireOid(options.expectedTree, 'expectedTree')) {
      fail('scoped tree differs from expectedTree');
    }
    const commit = git(root, ['commit-tree', '-S', tree, '-p', head], privateEnv, {
      input: `(${ticket}): finalize scoped changes\n`,
    }).trim();
    git(root, ['verify-commit', commit], env);
    const signature = git(root, ['show', '-s', '--format=%G?%x00%GF', commit], env).trim().split('\0');
    if (!['G', 'U'].includes(signature[0]) || signature[1] !== expectedSigner.trim()) {
      fail('commit signature does not match expectedSigner');
    }
    const lockPath = `${indexPath}.lock`;
    let lockFd;
    let ownsLock = false;
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
      if (!sameIndex(indexPath, originalIndex)) fail('ordinary Git index changed during finalization');
      const finalStatus = scopedStatus(root, env);
      if (finalStatus.length !== status.length || finalStatus.some((file) => !status.includes(file)) ||
          nulPaths(git(root, ['diff', '--name-only', '-z'], privateEnv, { binary: true })).length) {
        fail('worktree changed during signing');
      }
      if (git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim() !== branchRef ||
          git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim() !== head) {
        fail('branch moved during signing');
      }
      fs.writeFileSync(lockFd, fs.readFileSync(privateEnv.GIT_INDEX_FILE));
      fs.fsyncSync(lockFd);
      fs.closeSync(lockFd);
      lockFd = undefined;
      git(root, ['update-ref', branchRef, commit, head], env);
      try {
        fs.renameSync(lockPath, indexPath);
        ownsLock = false;
      } catch (error) {
        git(root, ['update-ref', branchRef, head, commit], env);
        throw error;
      }
    } finally {
      if (lockFd !== undefined) fs.closeSync(lockFd);
      if (ownsLock) fs.rmSync(lockPath, { force: true });
    }
    return Object.freeze({ ticket, worktree: root, base, previousHead: head, commit, tree, signer: signature[1], changed: staged });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function scopedTree(options) {
  if (!options || typeof options !== 'object') fail('trusted host options are required');
  const declared = options.files_modified;
  if (!Array.isArray(declared) || !declared.length || declared.some((entry) => !validDeclaration(entry))) {
    fail('files_modified must contain valid repository-relative declarations');
  }
  const root = fs.realpathSync(options.worktree);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim();
  if (options.expectedHead !== undefined && head !== requireOid(options.expectedHead, 'expectedHead')) {
    fail('HEAD differs from expectedHead');
  }
  const status = scopedStatus(root, env);
  const outside = status.filter((file) => !declared.some((entry) => owns(entry, file)));
  if (outside.length) fail(`out-of-scope paths: ${outside.join(', ')}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-tree-'));
  const privateEnv = { ...env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  try {
    git(root, ['read-tree', head], privateEnv);
    if (status.length) git(root, ['add', '--all', '--', ...status.map((file) => `:(literal)${file}`)], privateEnv);
    const changed = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], privateEnv, { binary: true }));
    return Object.freeze({ head, tree: git(root, ['write-tree'], privateEnv).trim(), changed: Object.freeze(changed) });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = Object.freeze({ finalizeDeliveryCommit, scopedTree });
