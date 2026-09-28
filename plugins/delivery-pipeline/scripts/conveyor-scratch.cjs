#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

const MANIFEST_NAME = '.shipyard-role-artifact.json';
const PR_BODY_NAME = '.shipyard-pr-body.md';
const EVIDENCE_NAME = '.shipyard-evidence.md';
const REPAIR_EVIDENCE_NAME = '.shipyard-repair-evidence.md';
const DRIFT_EVIDENCE_NAME = '.shipyard-drift-evidence.md';
const ARCH_REVIEW_EVIDENCE_NAME = '.shipyard-arch-review-evidence.md';
const SENTINEL_EVIDENCE_NAME = '.shipyard-sentinel-evidence.md';
const ARTIFACT_ARCHIVE_DIR = '.shipyard-role-artifacts';
const SCRATCH_FILES = Object.freeze([
  MANIFEST_NAME, PR_BODY_NAME, EVIDENCE_NAME, REPAIR_EVIDENCE_NAME,
  DRIFT_EVIDENCE_NAME, ARCH_REVIEW_EVIDENCE_NAME, SENTINEL_EVIDENCE_NAME,
]);
const SCRATCH_DIRS = Object.freeze([ARTIFACT_ARCHIVE_DIR]);
const scratchFiles = new Set(SCRATCH_FILES);

function isScratch(relPath, { forJudge = false } = {}) {
  if (typeof relPath !== 'string') return false;
  if (scratchFiles.has(relPath)) return true;
  return !forJudge && SCRATCH_DIRS.some((dir) => relPath.startsWith(dir + '/'));
}

function statusIgnoringScratch(worktree, { untracked = 'all', forJudge = true, maxBuffer = 64 * 1024 * 1024 } = {}) {
  if (!['all', 'no'].includes(untracked)) throw new TypeError('untracked must be all or no');
  let output;
  try {
    output = execFileSync('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`], {
      encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer,
    });
  } catch (error) {
    if (error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        || /maxBuffer exceeded/.test(error.message || '')) {
      return { ok: false, code: 'STATUS_TOO_LARGE' };
    }
    throw error;
  }
  const fields = output.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const field = fields[i];
    if (field.length < 4 || field[2] !== ' ') throw new Error('unrecognized Git status entry');
    const status = field.slice(0, 2);
    const relPath = field.slice(3);
    if (!(status === '??' && isScratch(relPath, { forJudge }))) entries.push({ status, path: relPath });
    if (/[RC]/.test(status)) {
      i++;
      if (i >= fields.length - 1) throw new Error('incomplete Git rename status');
      entries.push({ status, path: fields[i] });
    }
  }
  return { ok: true, entries };
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== 'list') {
    process.stderr.write('usage: conveyor-scratch.cjs list\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(SCRATCH_FILES.join('\n') + '\n');
  }
}

module.exports = Object.freeze({
  MANIFEST_NAME, PR_BODY_NAME, EVIDENCE_NAME, REPAIR_EVIDENCE_NAME,
  DRIFT_EVIDENCE_NAME, ARCH_REVIEW_EVIDENCE_NAME, SENTINEL_EVIDENCE_NAME,
  ARTIFACT_ARCHIVE_DIR, SCRATCH_FILES, SCRATCH_DIRS, isScratch, statusIgnoringScratch,
});
