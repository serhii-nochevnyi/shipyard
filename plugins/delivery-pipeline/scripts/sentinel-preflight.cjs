#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUTPUT_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,240}$/;

function refuse(message, code = 'PREFLIGHT_REFUSED') {
  const error = new Error(`sentinel-preflight: ${message}`);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeBranch(value, label) {
  if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.startsWith('-')
      || value.includes('..') || value.endsWith('/')) {
    refuse(`${label} is not a safe Git branch`, 'INVALID_BRANCH');
  }
  return value;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: OUTPUT_MAX_BYTES }).trim();
}

// @invariant: never trim porcelain status — a leading space in the 2-char code is meaningful.
function gitStatusLines(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: OUTPUT_MAX_BYTES });
}

function tryRevParse(cwd, ref) {
  try { return git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]); } catch { return null; }
}

function currentBranch(cwd) {
  try { return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { return null; }
}

function fetchCommand(worktree, base) {
  return `git -C ${worktree} fetch --no-tags origin +refs/heads/${base}:refs/remotes/origin/${base}`;
}

function fetchBase(worktree, base) {
  try {
    execFileSync('git', ['-C', worktree, 'fetch', '--no-tags', 'origin',
      `+refs/heads/${base}:refs/remotes/origin/${base}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: OUTPUT_MAX_BYTES, timeout: FETCH_TIMEOUT_MS });
  } catch {
    refuse(`fetch of ${base} from origin failed; run: ${fetchCommand(worktree, base)}`, 'BASE_FETCH_FAILED');
  }
}

function originOid(worktree, base) {
  return git(worktree, ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
}

// @invariant: fast-forward a checked-out base with merge --ff-only, not update-ref, or the tree goes stale.
function fastForward(worktree, base, targetOid) {
  const local = tryRevParse(worktree, `refs/heads/${base}`);
  if (local === null || local === targetOid) return targetOid;
  let ancestor = false;
  try { git(worktree, ['merge-base', '--is-ancestor', local, targetOid]); ancestor = true; } catch { ancestor = false; }
  if (!ancestor) {
    refuse(`local ${base} (${local}) has diverged from origin/${base} (${targetOid}); `
      + `run: git -C ${worktree} branch -f ${base} origin/${base} to discard the local-only commits, `
      + `or rebase them first: git -C ${worktree} rebase origin/${base} ${base}`, 'BASE_DIVERGED');
  }
  if (currentBranch(worktree) === base) {
    try {
      git(worktree, ['merge', '--ff-only', targetOid]);
    } catch {
      refuse(`checked-out local ${base} could not be fast-forwarded to ${targetOid}; `
        + `run: git -C ${worktree} merge --ff-only ${targetOid}`, 'BASE_DIVERGED');
    }
    return targetOid;
  }
  try {
    git(worktree, ['update-ref', `refs/heads/${base}`, targetOid, local]);
  } catch {
    refuse(`local ${base} could not be fast-forwarded from ${local} to ${targetOid}; `
      + `run: git -C ${worktree} update-ref refs/heads/${base} ${targetOid} ${local}`, 'BASE_DIVERGED');
  }
  return targetOid;
}

function statusEntries(worktree) {
  const raw = gitStatusLines(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  return raw.split('\n').filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

// @invariant: untracked files anywhere are exempt; only tracked drift outside the graph slice refuses.
function assertNotDirtyOutsideGraph(worktree) {
  const outside = statusEntries(worktree)
    .filter((entry) => entry.status !== '??' && !entry.path.startsWith('.planning/graph/'));
  if (outside.length) {
    refuse(`tracked files outside .planning/graph/ are dirty: ${outside.map((entry) => entry.path).join(', ')}; `
      + `run: git -C ${worktree} status`, 'WORKTREE_DIRTY');
  }
}

function isTracked(projectRoot, relative) {
  try { git(projectRoot, ['ls-files', '--error-unmatch', relative]); return true; } catch { return false; }
}

function defaultRun(file, args, options) {
  return execFileSync(file, args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: OUTPUT_MAX_BYTES, ...options });
}

function runSync(projectRoot, run) {
  const scriptPath = path.join(__dirname, 'state-sync.cjs');
  const executor = typeof run === 'function' ? run : defaultRun;
  try {
    executor(process.execPath, [scriptPath], { cwd: projectRoot });
  } catch (error) {
    const detail = String(error && error.message ? error.message : error).trim().slice(0, 400);
    refuse(`state-sync failed${detail ? `: ${detail}` : ''}; run: (cd ${projectRoot} && node ${scriptPath})`, 'STATE_SYNC_FAILED');
  }
}

// @invariant: write back only .planning/graph/, and only when the project already tracks it.
function maybeCommitGraph(projectRoot) {
  if (!isTracked(projectRoot, '.planning/graph/delivery-state.json')) return null;
  const changed = statusEntries(projectRoot).some((entry) => entry.path.startsWith('.planning/graph/'));
  if (!changed) return null;
  git(projectRoot, ['add', '--', '.planning/graph']);
  git(projectRoot, ['commit', '--quiet', '-m', 'chore: sync delivery state']);
  return git(projectRoot, ['rev-parse', 'HEAD']);
}

function preflight(params) {
  if (!object(params)) refuse('preflight requires an options object', 'USAGE');
  if (typeof params.worktree !== 'string' || !params.worktree) refuse('--worktree is required', 'USAGE');
  if (typeof params.graphDir !== 'string' || !params.graphDir) refuse('--graph-dir is required', 'USAGE');
  const worktree = path.resolve(params.worktree);
  const base = safeBranch(params.base, 'base branch');
  const projectRoot = path.resolve(path.resolve(params.graphDir), '..', '..');

  fetchBase(worktree, base);
  const baseOid = fastForward(worktree, base, originOid(worktree, base));
  runSync(projectRoot, params.run);
  const committed = maybeCommitGraph(projectRoot);
  assertNotDirtyOutsideGraph(worktree);
  return { base_oid: baseOid, synced: true, committed };
}

function resolveForeignRoot(ticket, repo, state) {
  const entry = object(state[ticket]) ? state[ticket] : null;
  const resolution = entry && object(entry.repo_resolution) ? entry.repo_resolution : null;
  if (!resolution || resolution.executable !== true
      || typeof resolution.repository_root !== 'string' || !resolution.repository_root) {
    const reason = resolution && typeof resolution.reason === 'string' && resolution.reason
      ? resolution.reason : 'no executable repo_resolution recorded by state-sync';
    refuse(`${ticket} repository ${repo} has no executable checkout (${reason}); `
      + `set pipeline.repos["${repo}"] in .planning/config.json`, 'REPO_UNRESOLVED');
  }
  return path.resolve(resolution.repository_root);
}

function preflightRound(params) {
  if (!object(params)) refuse('preflightRound requires an options object', 'USAGE');
  if (typeof params.projectWorktree !== 'string' || !params.projectWorktree) refuse('--worktree is required', 'USAGE');
  if (typeof params.graphDir !== 'string' || !params.graphDir) refuse('--graph-dir is required', 'USAGE');
  if (!Array.isArray(params.prs) || !params.prs.length) refuse('prs must be a non-empty array', 'USAGE');
  const projectWt = path.resolve(params.projectWorktree);
  const resolvedGraphDir = path.resolve(params.graphDir);
  const projectRoot = path.resolve(resolvedGraphDir, '..', '..');
  const statePath = path.join(resolvedGraphDir, 'delivery-state.json');
  let state = {};
  if (fs.existsSync(statePath)) {
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { refuse('delivery state is not valid JSON'); }
  }
  if (!object(state)) refuse('delivery state must be a JSON object');

  const repos = [];
  const fetched = new Set();
  for (const pr of params.prs) {
    if (!object(pr) || typeof pr.ticket !== 'string' || !pr.ticket) refuse('each round PR requires a ticket id', 'USAGE');
    const repo = pr.repo || null;
    const base = safeBranch(pr.base, `${pr.ticket} base`);
    const root = repo ? resolveForeignRoot(pr.ticket, repo, state) : projectWt;

    const key = `${repo || ''}\u0000${base}`;
    if (fetched.has(key)) continue;
    fetched.add(key);

    fetchBase(root, base);
    const target = originOid(root, base);
    const baseOid = repo ? target : fastForward(root, base, target);
    repos.push({ repo, root, base, base_oid: baseOid });
  }

  runSync(projectRoot, params.run);
  const committed = maybeCommitGraph(projectRoot);
  assertNotDirtyOutsideGraph(projectWt);
  return { repos, synced: true, committed };
}

function parseArgs(argv) {
  const out = {};
  const names = {
    '--worktree': 'worktree', '--base': 'base', '--graph-dir': 'graphDir', '--prs-file': 'prsFile',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--round') { out.round = true; continue; }
    if (!names[arg]) refuse(`unknown argument ${arg}`, 'USAGE');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) refuse(`${arg} requires a value`, 'USAGE');
    out[names[arg]] = value;
    index += 1;
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    let result;
    if (args.round) {
      if (!args.graphDir || !args.worktree) refuse('--graph-dir and --worktree are required for --round', 'USAGE');
      if (!args.prsFile) refuse('--prs-file is required for --round', 'USAGE');
      const prs = JSON.parse(fs.readFileSync(args.prsFile, 'utf8'));
      result = preflightRound({ projectWorktree: args.worktree, graphDir: args.graphDir, prs });
    } else {
      if (!args.worktree || !args.base || !args.graphDir) {
        refuse('--worktree, --base and --graph-dir are required', 'USAGE');
      }
      result = preflight({ worktree: args.worktree, base: args.base, graphDir: args.graphDir });
    }
    process.stdout.write(args.json ? `${JSON.stringify(result)}\n` : `preflight ok: ${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = String(error.message || error).slice(0, 2000);
    if (args && args.json) process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'ERROR', error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return error.code === 'USAGE' ? 2 : 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { preflight, preflightRound, main };
