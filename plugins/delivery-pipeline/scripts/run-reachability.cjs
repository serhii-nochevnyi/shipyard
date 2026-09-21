#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, owns, GRAMMAR } = require('./path-owner.cjs');

const SCHEMA = 'shipyard.run-reachability.v1';
const VERSION = 1;
const RETRYABLE_EXIT = 10;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reachabilityError(code, message, details = {}) {
  const error = new Error(`run-reachability: ${message}`);
  error.name = 'RunReachabilityError';
  error.code = code;
  error.details = details;
  return error;
}

function requireString(value, field, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw reachabilityError('INVALID_INPUT', `${field} must be a non-empty safe string`, { field });
  }
  const result = value.trim();
  if (result.length > max) throw reachabilityError('INVALID_INPUT', `${field} exceeds ${max} characters`, { field });
  return result;
}

function normalizeRemote(value) {
  const remote = requireString(value || 'origin', 'remote', 128);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw reachabilityError('INVALID_INPUT', 'remote contains unsupported characters', { remote });
  }
  return remote;
}

function normalizeBranch(value, field = 'branch') {
  const branch = requireString(value, field, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/.test(branch) || branch.includes('..') || branch.includes('//')) {
    throw reachabilityError('INVALID_INPUT', `${field} is not a safe branch name`, { field, branch });
  }
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function repoPath(value) {
  const repo = path.resolve(requireString(value, 'repo'));
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw reachabilityError('REPOSITORY_UNAVAILABLE', `repository does not exist: ${repo}`, { repo });
  }
  return repo;
}

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const value = {
    status: result.status === null ? 1 : result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
  if (value.status !== 0 && !allowFailure) {
    throw reachabilityError('GIT_FAILED', `git ${args.join(' ')} failed`, { ...value, args });
  }
  return value;
}

function canonicalRemoteBase(value, remote) {
  let base = requireString(value, 'base', 512);
  const prefixes = [`refs/remotes/${remote}/`, `${remote}/`, 'refs/heads/'];
  for (const prefix of prefixes) {
    if (base.startsWith(prefix)) {
      base = base.slice(prefix.length);
      break;
    }
  }
  if (!base || base.startsWith('/') || base.endsWith('/') || base.includes('..') || base.includes('//')
    || !/^[A-Za-z0-9._/-]+$/.test(base)) {
    throw reachabilityError('INVALID_INPUT', 'base is not a safe ref name', { base: value });
  }
  return base;
}

function remoteUrls(repo, remote) {
  const result = git(repo, ['remote', 'get-url', '--all', remote], { allowFailure: true });
  if (result.status !== 0 || !result.stdout) {
    throw reachabilityError('ORIGIN_UNAVAILABLE', `remote ${remote} is not configured`, { remote });
  }
  const urls = result.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  if (urls.length !== 1) {
    throw reachabilityError('ORIGIN_AMBIGUOUS', `remote ${remote} has ${urls.length} configured URLs`, { remote, urls });
  }
  return urls;
}

function refreshOrigin(repo, remote) {
  const result = git(repo, ['fetch', remote, '--prune'], { allowFailure: true });
  if (result.status !== 0) {
    throw reachabilityError('ORIGIN_UNAVAILABLE', `fetching ${remote} failed`, { remote, stderr: result.stderr });
  }
}

function optionalSha(repo, ref) {
  const result = git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFailure: true });
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function baseProof(repo, base, remote, fetch) {
  if (fetch) refreshOrigin(repo, remote);
  const urls = remoteUrls(repo, remote);
  const name = canonicalRemoteBase(base, remote);
  const ref = `refs/remotes/${remote}/${name}`;
  const sha = optionalSha(repo, ref);
  if (!sha) {
    throw reachabilityError('MISSING_BASE_REF', `live ${remote}/${name} does not exist`, {
      remote, base: name, base_ref: `${remote}/${name}`,
    });
  }
  const localSha = optionalSha(repo, `refs/heads/${name}`);
  return {
    remote,
    remote_url: urls[0],
    requested_base: base,
    base: name,
    base_ref: `${remote}/${name}`,
    base_sha: sha,
    local_base_sha: localSha,
    local_base_stale: Boolean(localSha && localSha !== sha),
  };
}

function normalizeDeclaration(value) {
  const declaration = requireString(value, 'declared path', 1024);
  if (declaration.startsWith('/') || declaration.split('/').includes('..')) {
    throw reachabilityError('DECLARATION_UNREACHABLE', `declared path escapes the repository: ${declaration}`, { declaration });
  }
  const parsed = parse(declaration);
  if (parsed.error) {
    throw reachabilityError('DECLARATION_INVALID', `${declaration}: ${parsed.error}; ${GRAMMAR}`, { declaration });
  }
  return declaration;
}

function declaredFiles(repo, baseSha, declared = []) {
  if (!Array.isArray(declared)) throw reachabilityError('INVALID_INPUT', 'declared must be an array');
  const declarations = declared.map(normalizeDeclaration);
  const result = git(repo, ['ls-tree', '-r', '--name-only', baseSha]);
  const files = result.stdout ? result.stdout.split('\n').filter(Boolean) : [];
  const matches = declarations.map((declaration) => ({
    declaration,
    files: files.filter((file) => owns(declaration, file)),
  }));
  return {
    declarations,
    matched_files: [...new Set(matches.flatMap((row) => row.files))].sort(),
    matches,
    missing_declarations: matches.filter((row) => row.files.length === 0).map((row) => row.declaration),
  };
}

function worktreeRows(repo) {
  const result = git(repo, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  if (result.status !== 0) throw reachabilityError('WORKTREE_UNKNOWN', 'git worktree ownership could not be read', { stderr: result.stderr });
  const rows = [];
  let row = {};
  const flush = () => {
    if (row.worktree) rows.push(row);
    row = {};
  };
  for (const line of result.stdout.split('\n')) {
    if (!line) {
      flush();
      continue;
    }
    const at = line.indexOf(' ');
    row[line.slice(0, at)] = line.slice(at + 1);
  }
  flush();
  return rows;
}

function branchDistance(repo, baseSha, branchSha) {
  const result = git(repo, ['rev-list', '--left-right', '--count', `${baseSha}...${branchSha}`], { allowFailure: true });
  if (result.status !== 0 || !result.stdout) return null;
  const [baseAhead, branchAhead] = result.stdout.split(/\s+/).map(Number);
  if (![baseAhead, branchAhead].every(Number.isSafeInteger)) return null;
  return { base_ahead: baseAhead, branch_ahead: branchAhead };
}

function ancestry(repo, baseSha, branchSha) {
  const result = git(repo, ['merge-base', '--is-ancestor', baseSha, branchSha], { allowFailure: true });
  if (result.status === 0) return { ok: true, distance: branchDistance(repo, baseSha, branchSha) };
  return { ok: false, distance: branchDistance(repo, baseSha, branchSha) };
}

function samePath(left, right) {
  return fs.realpathSync(left) === fs.realpathSync(right);
}

function branchProof(repo, baseSha, branch, worktree, remote) {
  const branchSha = optionalSha(repo, `refs/heads/${branch}`);
  const remoteBranchSha = optionalSha(repo, `refs/remotes/${remote}/${branch}`);
  const exists = fs.existsSync(worktree);
  const result = {
    branch,
    branch_sha: branchSha,
    remote_branch_sha: remoteBranchSha,
    worktree: path.resolve(worktree),
    worktree_exists: exists,
    worktree_branch: null,
    worktree_head: null,
    distance: null,
  };
  if (exists) {
    const rows = worktreeRows(repo);
    const row = rows.find((item) => samePath(item.worktree, result.worktree));
    if (!row) throw reachabilityError('WORKTREE_UNOWNED', 'worktree is not registered with this repository', result);
    const rawWorktreeBranch = String(row.branch || '');
    const worktreeBranch = rawWorktreeBranch.startsWith('refs/heads/')
      ? rawWorktreeBranch.slice('refs/heads/'.length)
      : rawWorktreeBranch;
    result.worktree_branch = worktreeBranch || null;
    if (worktreeBranch !== branch) {
      throw reachabilityError('WORKTREE_BRANCH_MISMATCH', `worktree belongs to ${worktreeBranch || 'detached HEAD'}, expected ${branch}`, result);
    }
  }
  if (!branchSha && !exists) return { ...result, kind: 'new', ancestry: null };
  if (!branchSha) {
    throw reachabilityError('WORKTREE_UNKNOWN', 'worktree exists without its local branch ref', result);
  }
  if (exists) {
    const common = git(result.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true });
    const expectedCommon = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true });
    if (common.status !== 0 || expectedCommon.status !== 0 || !samePath(common.stdout, expectedCommon.stdout)) {
      throw reachabilityError('WORKTREE_REPOSITORY_MISMATCH', 'worktree belongs to another repository', { ...result, repository: common.stdout });
    }
    result.worktree_head = optionalSha(result.worktree, 'HEAD');
    if (!result.worktree_head || result.worktree_head !== branchSha) {
      throw reachabilityError('WORKTREE_HEAD_MISMATCH', 'worktree HEAD does not match its local branch ref', result);
    }
  }
  const proof = ancestry(repo, baseSha, branchSha);
  result.distance = proof.distance;
  result.ancestry = proof;
  if (!proof.ok) {
    throw reachabilityError('BASE_NOT_ANCESTOR', `live base is not an ancestor of ${branch}`, result);
  }
  return { ...result, kind: exists ? 'reused' : 'existing-branch' };
}

function reachableResult(input, base, paths, branch, branchState) {
  const branchDetails = { ...(branchState || {}) };
  delete branchDetails.branch;
  return Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    ok: true,
    status: 'reachable',
    repository: input.repo,
    ticket: input.ticket || null,
    origin: {
      remote: base.remote,
      url: base.remote_url,
      requested_base: base.requested_base,
      base: base.base,
      ref: base.base_ref,
      sha: base.base_sha,
      local_sha: base.local_base_sha,
      local_stale: base.local_base_stale,
    },
    declared: paths,
    branch: { name: branch, ...branchDetails },
  });
}

function pendingResult(input, error) {
  return Object.freeze({
    schema: SCHEMA,
    version: VERSION,
    ok: false,
    status: 'retryable_pending',
    repository: input.repo || null,
    ticket: input.ticket || null,
    reason: { code: error.code || 'REACHABILITY_UNKNOWN', message: error.message, details: error.details || {} },
  });
}

function proveReachability(options = {}) {
  if (!object(options)) throw reachabilityError('INVALID_INPUT', 'options must be an object');
  const repo = repoPath(options.repo || options.repository);
  const remote = normalizeRemote(options.remote);
  const base = baseProof(repo, options.base, remote, options.fetch === true);
  const paths = declaredFiles(repo, base.base_sha, options.declared || []);
  const branch = options.branch ? normalizeBranch(options.branch) : null;
  const worktree = options.worktree ? path.resolve(requireString(options.worktree, 'worktree')) : path.join(repo, '.shipyard-worktree');
  const branchState = branch ? branchProof(repo, base.base_sha, branch, worktree, remote) : { kind: 'unbound' };
  return reachableResult({ ...options, repo }, base, paths, branch, branchState);
}

function prove(options = {}) {
  try {
    return { result: proveReachability(options), exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && error.code) return { result: pendingResult(options, error), exitCode: RETRYABLE_EXIT };
    throw error;
  }
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function cli(argv = process.argv.slice(2)) {
  const command = argv[0] || 'prove';
  if (command !== 'prove') throw reachabilityError('INVALID_INPUT', `unknown command ${command}`);
  const repo = repoPath(argValue(argv, '--repo') || process.cwd());
  const ticket = argValue(argv, '--ticket');
  let declared = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--declared' && argv[index + 1]) declared.push(argv[index + 1]);
  }
  const graph = argValue(argv, '--graph');
  if (ticket) {
    const graphDir = graph ? path.resolve(graph) : path.join(repo, '.planning', 'graph');
    const file = path.join(graphDir, 'tickets.json');
    if (!fs.existsSync(file)) throw reachabilityError('GRAPH_UNAVAILABLE', `ticket graph is missing: ${graphDir}`, { graphDir });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = raw.tickets && raw.tickets[ticket];
    if (!row) throw reachabilityError('TICKET_UNKNOWN', `ticket ${ticket} is not in the graph`, { ticket });
    declared = Array.isArray(row.files) ? row.files : declared;
  }
  const { result, exitCode } = prove({
    repo,
    ticket,
    base: argValue(argv, '--base'),
    branch: argValue(argv, '--branch'),
    worktree: argValue(argv, '--worktree'),
    remote: argValue(argv, '--remote') || 'origin',
    declared,
    fetch: argv.includes('--fetch'),
  });
  console.log(JSON.stringify(result, null, 2));
  return exitCode;
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  RETRYABLE_EXIT,
  proveReachability,
  prove,
  canonicalRemoteBase,
  declaredFiles,
  branchDistance,
});

if (require.main === module) {
  try {
    process.exitCode = cli();
  } catch (error) {
    const result = pendingResult({}, error);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = error.code ? RETRYABLE_EXIT : 2;
  }
}
