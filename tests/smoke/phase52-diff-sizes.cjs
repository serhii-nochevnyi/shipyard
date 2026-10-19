#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { productPathspec } = require('../../plugins/delivery-pipeline/scripts/development-artifacts.cjs');

const SCHEMA = 'shipyard.phase52-diff-sizes.v1';
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const LEGACY_DIFF_MAX_BYTES = 1024 * 1024;
const ARCH_REVIEW_PACKET_TOKENS = 60000;
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const USAGE = 'usage: phase52-diff-sizes.cjs --repo <dir> --commit <sha> [--commit <sha> ...] [--json]';

class Refusal extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usage = message => { throw new Refusal(`${message}\n${USAGE}`, 2); };

function parseArgs(argv) {
  const parsed = { repo: null, commits: [], json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--repo' || arg === '--commit') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) usage(`${arg} requires a value`);
      if (arg === '--commit') {
        if (!SHA_RE.test(value)) usage(`--commit must be a 40-character lowercase hex sha: ${JSON.stringify(value)}`);
        parsed.commits.push(value);
      } else {
        parsed.repo = value;
      }
    } else {
      usage(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (parsed.repo === null) usage('--repo is required');
  if (!parsed.commits.length) usage('at least one --commit is required');
  const stat = fs.statSync(parsed.repo, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) usage(`--repo is not a directory: ${JSON.stringify(parsed.repo)}`);
  parsed.repo = path.resolve(parsed.repo);
  return parsed;
}

function gitEnv() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    env: gitEnv(), encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER,
  });
}

function succeeds(repo, args) {
  try { git(repo, args); return true; } catch { return false; }
}

function flagsFor(bytes) {
  return {
    over_diff_max_bytes: bytes > DIFF_MAX_BYTES,
    over_legacy_diff_max_bytes: bytes > LEGACY_DIFF_MAX_BYTES,
    over_arch_review_tokens: Math.ceil(bytes / 4) > ARCH_REVIEW_PACKET_TOKENS,
  };
}

function measure(repo, commit) {
  if (!succeeds(repo, ['rev-parse', '--git-dir'])) throw new Refusal(`not a git repository: ${repo}`, 1);
  if (!succeeds(repo, ['cat-file', '-e', `${commit}^{commit}`])) throw new Refusal(`unknown commit ${commit} in ${repo}`, 1);
  if (!succeeds(repo, ['rev-parse', '--verify', '--quiet', `${commit}^`])) {
    throw new Refusal(`commit ${commit} is a root commit and has no first parent to diff against`, 1);
  }
  const range = [`${commit}^`, commit];
  const diff = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--unified=50', ...range, ...productPathspec()]);
  const paths = git(repo, ['diff', '--name-only', '--no-renames', '-z', ...range, ...productPathspec()])
    .toString('utf8').split('\0').filter(Boolean);
  const bytes = diff.length;
  return { commit, product_files: paths.length, product_diff_bytes: bytes,
    estimated_tokens: Math.ceil(bytes / 4), ...flagsFor(bytes) };
}

function table(rows) {
  const columns = ['commit', 'product_files', 'product_diff_bytes', 'estimated_tokens',
    'over_diff_max_bytes', 'over_legacy_diff_max_bytes', 'over_arch_review_tokens'];
  return [columns.join('\t'), ...rows.map(row => columns.map(name => String(row[name])).join('\t'))].join('\n') + '\n';
}

function main(argv) {
  const args = parseArgs(argv);
  const rows = args.commits.map(commit => measure(args.repo, commit));
  process.stdout.write(args.json
    ? JSON.stringify({ schema: SCHEMA, repo: args.repo, rows }, null, 2) + '\n'
    : table(rows));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`phase52-diff-sizes: ${error.message}\n`);
    process.exit(error instanceof Refusal ? error.exitCode : 1);
  }
}

module.exports = { SCHEMA, DIFF_MAX_BYTES, LEGACY_DIFF_MAX_BYTES, ARCH_REVIEW_PACKET_TOKENS, flagsFor, measure, parseArgs };
