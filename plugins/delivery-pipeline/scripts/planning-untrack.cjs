#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applies } = require('./pr-hygiene.cjs');

const GITIGNORE_LINE = '/.planning/';
const CONFIRM_TOKEN = 'untrack-planning';
const COMMIT_SUBJECT = 'chore: stop tracking local planning files';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function isDirty(root) {
  return git(root, ['status', '--porcelain']).trim().length > 0;
}

function currentBranch(root) {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

function defaultBranch(root) {
  try {
    const symbolic = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (symbolic) return symbolic.replace(new RegExp('^origin/'), '');
  } catch {}
  try {
    const viaGh = execFileSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (viaGh) return viaGh;
  } catch {}
  return null;
}

function isPlanningTracked(root) {
  return git(root, ['ls-files', '--', '.planning']).trim().length > 0;
}

function gitignoreHasEntry(root) {
  let content = '';
  try { content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return false; }
  return content.split('\n').some((line) => ['/.planning/', '.planning/', '.planning'].includes(line.trim()));
}

function appendGitignoreEntry(root) {
  const file = path.join(root, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch {}
  const withNewline = content.length && !content.endsWith('\n') ? `${content}\n` : content;
  fs.writeFileSync(file, `${withNewline}${GITIGNORE_LINE}\n`);
}

function plan(root) {
  return {
    root,
    gitignore_line: gitignoreHasEntry(root) ? null : GITIGNORE_LINE,
    untrack_command: 'git rm -r --cached .planning',
    already_untracked: !isPlanningTracked(root),
  };
}

function apply({ root, confirm }) {
  if (confirm !== CONFIRM_TOKEN) fail('CONFIRMATION_REQUIRED', `--apply requires --confirm ${CONFIRM_TOKEN}`);
  if (!applies({ root })) fail('EXEMPT_REPOSITORY', 'the Shipyard repository is exempt from the .planning untrack migration');
  if (isDirty(root)) fail('DIRTY_WORKTREE', 'the worktree has uncommitted changes; commit or stash before untracking .planning');
  const branch = currentBranch(root);
  const base = defaultBranch(root);
  if (!base) fail('DEFAULT_BRANCH_UNKNOWN', 'the repository default branch could not be determined; refusing to apply');
  if (branch === base) {
    fail('ON_DEFAULT_BRANCH', `refusing to apply on the default branch (${base}); run this on a feature branch and open a PR`);
  }
  if (!isPlanningTracked(root)) fail('ALREADY_UNTRACKED', '.planning/ is already untracked in this repository');

  if (!gitignoreHasEntry(root)) appendGitignoreEntry(root);
  git(root, ['add', '--', '.gitignore']);
  git(root, ['rm', '-r', '--cached', '--quiet', '.planning']);
  git(root, ['commit', '-m', COMMIT_SUBJECT]);
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  return { root, branch, base, commit, message: COMMIT_SUBJECT };
}

function flagValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail('USAGE', `--${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const root = flagValue(argv, 'project-root');
  if (!root) fail('USAGE', '--project-root is required');
  return {
    root,
    apply: argv.includes('--apply'),
    confirm: flagValue(argv, 'confirm'),
    json: argv.includes('--json'),
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root);
  if (!args.apply) {
    const result = plan(root);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`planning-untrack: dry run for ${root}`);
      console.log(result.gitignore_line
        ? `  would append to .gitignore: ${result.gitignore_line}`
        : '  .gitignore already ignores .planning/');
      console.log(`  would run: ${result.untrack_command}`);
      if (result.already_untracked) console.log('  note: .planning/ is already untracked; --apply would refuse');
    }
    return 0;
  }
  const result = apply({ root, confirm: args.confirm });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`planning-untrack: committed ${result.commit} on ${result.branch} ("${result.message}")`);
  return 0;
}

module.exports = {
  plan,
  apply,
  isDirty,
  currentBranch,
  defaultBranch,
  isPlanningTracked,
  gitignoreHasEntry,
  GITIGNORE_LINE,
  CONFIRM_TOKEN,
  COMMIT_SUBJECT,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`planning-untrack: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 2;
  }
}
