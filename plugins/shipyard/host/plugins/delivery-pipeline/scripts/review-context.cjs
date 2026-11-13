'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { resolveGraphDir, resolveOriginRef } = require('./graph-dir.cjs');
const { repositorySlug } = require('./comment-policy.cjs');
const { loadConfig } = require('./pipeline-config.cjs');
const { resolveTicketBase } = require('./ticket-base.cjs');

function gitEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
}

function readJson(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) {
    throw new Error('review context requires a bounded regular file: ' + file);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error('invalid review context at ' + file + ': ' + error.message); }
}

function branchName(ref) {
  let name = String(ref || '');
  for (const prefix of ['refs/remotes/origin/', 'refs/heads/', 'origin/']) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  return name;
}

function lookupPullRequest({ worktree, branch, repo }) {
  const argv = ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '100',
    '--json', 'number,baseRefName,headRefName'];
  if (repo) argv.push('--repo', repo);
  const result = spawnSync('gh', argv, { cwd: worktree, encoding: 'utf8', timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { throw new Error('invalid open PR metadata for ' + branch); }
  if (!Array.isArray(rows)) throw new Error('invalid open PR metadata for ' + branch);
  const matches = rows.filter(row => row.headRefName === branch);
  if (matches.length > 1) throw new Error('ambiguous open PRs for branch ' + branch);
  return matches[0] || null;
}

function resolveReviewContext({ worktree, branch, ticket, projectRoot, graphDir, requestedBase,
  configuredBase, pushBase, head, lookupPr = lookupPullRequest } = {}) {
  if (!branch) branch = git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  branch = String(branch);
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length);
  if (!branch) throw new Error('publication requires an identified source branch');
  if (!graphDir) graphDir = projectRoot ? path.join(projectRoot, '.planning', 'graph') : resolveGraphDir([], worktree).dir;
  const graph = graphDir && readJson(path.join(graphDir, 'tickets.json'));
  if (graph && (!graph.tickets || typeof graph.tickets !== 'object' || Array.isArray(graph.tickets))) {
    throw new Error('invalid ticket graph for review context: ' + graphDir);
  }
  if (!projectRoot && graph) projectRoot = path.resolve(graphDir, '..', '..');
  const repo = repositorySlug(worktree);
  const ownRepo = projectRoot && repositorySlug(projectRoot);
  const matches = Object.entries(graph?.tickets || {}).filter(([, row]) => row && row.branch === branch
    && (row.repo ? row.repo.toLowerCase() === repo?.toLowerCase() : !ownRepo || ownRepo.toLowerCase() === repo?.toLowerCase()));
  if (matches.length > 1) throw new Error('ambiguous graph branch ' + branch + ': ' + matches.map(([id]) => id).join(', '));
  const match = matches[0];
  if (ticket === 'publish') ticket = null;
  if (ticket && graph && (!match || match[0] !== ticket)) throw new Error('ticket does not match graph branch ' + branch);
  if (match) ticket = match[0];
  const state = graphDir && readJson(path.join(graphDir, 'delivery-state.json'));
  const rows = state?.tickets || state;
  const board = ticket && rows?.[ticket];
  if (board?.branch && board.branch !== branch) throw new Error('delivery board branch differs for ' + ticket);
  const scope = { worktree, branch, ticket: ticket || null, repo, ownRepo, projectRoot, graph, state, match, board,
    requestedBase, configuredBase, lookupPr };
  const identity = { ticket: ticket || null, branch, projectRoot: projectRoot || null, graphDir: graph ? graphDir : null };
  if (!pushBase) return { ...resolveNamedBase(scope, false), ...identity };
  const transport = { base: pushBase, base_source: 'remote-oid', push_base: pushBase, ...identity };
  let named;
  try { named = resolveNamedBase(scope, true); } catch { return transport; }
  const base_commit = verifiedReviewBase(worktree, named.base, head, pushBase);
  return base_commit ? { ...named, base_commit, push_base: pushBase, ...identity } : transport;
}

function resolveNamedBase({ worktree, branch, ticket, repo, ownRepo, projectRoot, graph, state, match, board,
  requestedBase, configuredBase, lookupPr }, trusted) {
  let recorded = board?.base || match?.[1].pr_base || null;
  if (match?.[1].pr_base && board) recorded = resolveTicketBase({ ticket, requestedBase: recorded, graph, state });
  const pr = lookupPr({ worktree, branch, repo });
  if (pr && (pr.headRefName !== branch || typeof pr.baseRefName !== 'string' || !pr.baseRefName)) {
    throw new Error('open PR identity differs from source branch ' + branch);
  }
  const explicit = requestedBase || process.env.COMMENT_POLICY_BASE || process.env.SHIPYARD_COMMENT_BASE
    || process.env.GITHUB_BASE_REF || null;
  if (pr && board?.base && branchName(board.base) !== branchName(pr.baseRefName)) {
    throw new Error('PR base ' + pr.baseRefName + ' conflicts with recorded base ' + board.base + '; refresh the delivery board');
  }
  if (pr && explicit && branchName(explicit) !== branchName(pr.baseRefName)) {
    const actual = resolveOriginRef(worktree, pr.baseRefName) || pr.baseRefName;
    let same = false;
    try { same = git(worktree, ['rev-parse', '--verify', explicit + '^{commit}']) === git(worktree, ['rev-parse', '--verify', actual + '^{commit}']); } catch {}
    if (!same) throw new Error('explicit base ' + explicit + ' conflicts with open PR base ' + pr.baseRefName);
  }
  if (trusted) {
    const candidate = pr?.baseRefName || recorded;
    if (!candidate || branchName(candidate) === branch) throw new Error('no trusted review base for ' + branch);
    const base = resolveOriginRef(worktree, candidate);
    if (!base) throw new Error('trusted review base is not an origin branch: ' + candidate);
    return { base, base_source: pr ? 'pull-request' : 'recorded' };
  }
  let configured = configuredBase || null;
  if (projectRoot) {
    const config = loadConfig(projectRoot);
    if (config.valid === false) throw new Error('invalid project config for review context: ' + projectRoot);
    if (!ownRepo || ownRepo.toLowerCase() === repo?.toLowerCase()) configured ||= config.gsd?.base_branch || null;
  }
  const candidate = pr?.baseRefName || explicit || recorded || configured;
  if (!candidate) throw new Error('cannot resolve review base for ' + branch + '; provide an open PR, recorded ticket base, or configure git.base_branch');
  if (branchName(candidate) === branch) throw new Error('source branch upstream cannot be its own review base: ' + branch);
  const base = resolveOriginRef(worktree, candidate) || candidate;
  git(worktree, ['rev-parse', '--verify', base + '^{commit}']);
  return { base, base_source: pr ? 'pull-request' : explicit ? (requestedBase ? 'flag' : 'env')
    : recorded ? 'recorded' : 'configured' };
}

function ancestor(worktree, older, newer) {
  const result = spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', older, newer], {
    env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('cannot compare commits ' + older + ' and ' + newer);
  return result.status === 0;
}

function verifiedReviewBase(worktree, base, head, pushBase) {
  // @security: narrow the remote range only for a fast-forward whose head is absent from the trusted base.
  try {
    const baseOid = git(worktree, ['rev-parse', '--verify', base + '^{commit}']);
    const headOid = git(worktree, ['rev-parse', '--verify', String(head || '') + '^{commit}']);
    const pushOid = git(worktree, ['rev-parse', '--verify', pushBase + '^{commit}']);
    git(worktree, ['merge-base', baseOid, headOid]);
    return !ancestor(worktree, headOid, baseOid) && ancestor(worktree, pushOid, headOid) ? baseOid : null;
  } catch { return null; }
}

module.exports = { resolveReviewContext, lookupPullRequest };
