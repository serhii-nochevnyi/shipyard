'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function refuseFor(message, role = 'ci-fix') {
  const error = new Error(role + ': ' + message);
  error.code = role === 'review-fix' ? 'REVIEW_FIX_SUBJECT_CHANGED' : 'CI_FIX_SUBJECT_CHANGED';
  throw error;
}
function readEvidence(file, expected, worktree, role) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.startsWith(worktree + path.sep)
      || !/^[0-9a-f]{64}$/.test(expected || '')) refuseFor('canonical evidence path and SHA256 required', role);
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(file) !== file
        || before.size < 1 || before.size > 8 * 1024 * 1024) refuseFor('evidence must be a bounded regular file inside worktree', role);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if ([after, current].some(stat => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== before[key]))
        || digest(bytes) !== expected) refuseFor('evidence changed', role);
    return Object.freeze({ path: file, sha256: expected, dev: before.dev, ino: before.ino,
      text: bytes.toString('utf8') });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function prepare({ graphDir, ticket, worktree, pr, expected_head, plan_sha256, evidence_path, evidence_sha256, role = 'ci-fix' }, options = {}) {
  const refuse = (message) => refuseFor(message, role);
  const git = args => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  if (fs.realpathSync(worktree) !== worktree || git(['rev-parse', '--show-toplevel']) !== worktree) refuse('worktree differs');
  const graphFile = path.join(graphDir, 'tickets.json');
  const graphBytes = fs.readFileSync(graphFile);
  const row = JSON.parse(graphBytes).tickets?.[ticket];
  const boardRaw = JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json')));
  const board = (boardRaw.tickets || boardRaw)[ticket];
  if (!row || !board || !Number.isSafeInteger(pr) || pr < 1 || board.pr !== pr
      || board.branch !== row.branch || git(['symbolic-ref', '--short', 'HEAD']) !== row.branch) refuse('ticket or canonical PR differs');
  const planPath = path.resolve(graphDir, '../..', row.plan);
  const project = path.resolve(graphDir, '../..');
  if (!planPath.startsWith(project + path.sep) || fs.realpathSync(planPath) !== planPath
      || !fs.lstatSync(planPath).isFile() || !/^[0-9a-f]{64}$/.test(plan_sha256 || '')
      || digest(fs.readFileSync(planPath)) !== plan_sha256) refuse('PLAN changed');
  const head = git(['rev-parse', 'HEAD']);
  if (!expected_head || head !== (options.expectedLocalHead || expected_head)) refuse('HEAD changed');
  const base = board.base || row.pr_base;
  const live = options.getPullRequest ? options.getPullRequest({ worktree, pr, repo: row.repo || null })
    : JSON.parse((options.execFileSync || execFileSync)('gh', ['pr', 'view', String(pr),
      ...(row.repo ? ['--repo', row.repo] : []), '--json', 'number,state,headRefName,headRefOid,baseRefName'],
    { cwd: worktree, encoding: 'utf8', timeout: 30000 }));
  if (live.number !== pr || live.state !== 'OPEN' || live.headRefName !== row.branch
      || live.headRefOid !== expected_head || live.baseRefName !== base) refuse('live OPEN PR differs');
  const evidence = readEvidence(evidence_path, evidence_sha256, worktree, role);
  if (git(['rev-parse', 'HEAD']) !== head || git(['symbolic-ref', '--short', 'HEAD']) !== row.branch
      || digest(fs.readFileSync(planPath)) !== plan_sha256 || digest(fs.readFileSync(graphFile)) !== digest(graphBytes))
    refuse('canonical inputs changed during live PR authentication');
  return Object.freeze({ ticket, pr, worktree, head: expected_head, base, plan_sha256, graph_sha256: digest(graphBytes), evidence });
}
function recheck(selector, prepared, options) {
  const current = prepare(selector, options);
  if (JSON.stringify(current) !== JSON.stringify(prepared)) refuseFor('launch subject changed', selector.role);
}
module.exports = { prepare, recheck, readEvidence };
