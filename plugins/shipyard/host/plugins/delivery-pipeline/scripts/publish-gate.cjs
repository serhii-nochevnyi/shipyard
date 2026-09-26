#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const commentPolicy = require('./comment-policy.cjs');

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

function baseFor(worktree, requested) {
  const candidates = [
    requested,
    process.env.COMMENT_POLICY_BASE,
    process.env.SHIPYARD_COMMENT_BASE,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'origin/main',
    'main',
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      git(worktree, ['rev-parse', '--verify', `${candidate}^{commit}`]);
      return candidate;
    } catch {}
  }
  throw new Error(`cannot resolve a base ref in ${worktree}`);
}

function main(argv = process.argv.slice(2)) {
  const worktree = path.resolve(value(argv, 'worktree') || process.cwd());
  if (!fs.existsSync(path.join(worktree, '.git'))) throw new Error(`not a git worktree: ${worktree}`);
  const base = baseFor(worktree, value(argv, 'base'));
  const result = commentPolicy.analyze(worktree, base, { workingTree: argv.includes('--working-tree') });
  const output = {
    gate: 'publish',
    ticket: value(argv, 'ticket') || null,
    base,
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
