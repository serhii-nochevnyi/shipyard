#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const commentPolicy = require('./comment-policy.cjs');
const { repoRootOf } = require('./graph-dir.cjs');

function value(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const result = argv[i + 1];
  if (!result || result.startsWith('--')) throw new Error(`--${name} requires a value`);
  return result;
}

function git(worktree, args) {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function resolveProjectRoot(argv, worktree) {
  const flag = value(argv, 'project-root');
  if (flag) return path.resolve(flag);
  if (process.env.SHIPYARD_PROJECT_ROOT) return path.resolve(process.env.SHIPYARD_PROJECT_ROOT);
  return repoRootOf(worktree);
}

function recordedBase(projectRoot, ticket) {
  if (!projectRoot || !ticket) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(projectRoot, '.planning', 'graph', 'delivery-state.json'), 'utf8'));
  } catch {
    return null;
  }
  const entry = raw && typeof raw === 'object' ? raw[ticket] : null;
  return entry && typeof entry.base === 'string' && entry.base ? entry.base : null;
}

function resolveOriginHead(worktree) {
  let ref;
  try {
    ref = git(worktree, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  } catch {
    return null;
  }
  const prefix = 'refs/remotes/origin/';
  return ref.startsWith(prefix) ? `origin/${ref.slice(prefix.length)}` : null;
}

function baseFor(worktree, requested, { ticket = null, projectRoot = null } = {}) {
  const seen = new Set();
  const tried = [];
  function attempt(candidate, base_source) {
    if (!candidate || seen.has(candidate)) return null;
    seen.add(candidate);
    tried.push(candidate);
    try {
      git(worktree, ['rev-parse', '--verify', `${candidate}^{commit}`]);
      return { base: candidate, base_source };
    } catch {
      return null;
    }
  }

  let hit = attempt(requested, 'flag')
    || attempt(process.env.COMMENT_POLICY_BASE, 'env')
    || attempt(process.env.SHIPYARD_COMMENT_BASE, 'env')
    || attempt(process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null, 'env');
  if (hit) return hit;

  const recorded = recordedBase(projectRoot, ticket);
  hit = attempt(recorded ? `origin/${recorded}` : null, 'recorded')
    || attempt(recorded, 'recorded');
  if (hit) return hit;

  hit = attempt(resolveOriginHead(worktree), 'origin-head')
    || attempt('origin/main', 'fallback')
    || attempt('main', 'fallback');
  if (hit) return hit;

  throw new Error(`cannot resolve a base ref in ${worktree} (tried ${tried.join(', ') || 'nothing'})`);
}

function main(argv = process.argv.slice(2)) {
  const worktree = path.resolve(value(argv, 'worktree') || process.cwd());
  if (!fs.existsSync(path.join(worktree, '.git'))) throw new Error(`not a git worktree: ${worktree}`);
  const ticket = value(argv, 'ticket');
  const projectRoot = resolveProjectRoot(argv, worktree);
  const { base, base_source } = baseFor(worktree, value(argv, 'base'), { ticket, projectRoot });
  const result = commentPolicy.analyze(worktree, base, { workingTree: argv.includes('--working-tree') });
  const output = {
    gate: 'publish',
    ticket: ticket || null,
    base,
    base_source,
    worktree,
    working_tree: result.working_tree,
    ok: result.ok,
    totals: result.totals,
    violations: result.violations,
    skipped: result.skipped,
  };
  if (argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
  else if (result.ok) console.log(`publish-gate: OK — ${result.totals.comment_lines} non-allowed comment line(s)`);
  else console.error(`publish-gate: BLOCKED — ${result.violations.length} file(s) contain non-allowed added comments`);
  return result.ok ? 0 : 1;
}

module.exports = { baseFor, main };

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(`publish-gate: ${error.message}`);
    process.exitCode = 2;
  }
}
