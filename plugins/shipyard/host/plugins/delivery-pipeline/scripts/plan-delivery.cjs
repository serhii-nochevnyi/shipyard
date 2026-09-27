'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { MAX_REFERENCE_BYTES } = require('./claude-reference-content.cjs');

const MAX_TOTAL_BYTES = 256 * 1024;
const BARE_PHASE_NAMES = ['RESEARCH', 'CONTEXT'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(code, message) {
  const error = new Error(`plan-delivery: ${message}`);
  error.code = code;
  throw error;
}

function tryGit(cwd, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim() };
  } catch (error) {
    return { ok: false, error };
  }
}

function parseWorktreeRows(output) {
  const rows = [];
  let row = null;
  for (const line of output.split('\n')) {
    if (!line) { if (row) rows.push(row); row = null; continue; }
    if (!row) row = {};
    const at = line.indexOf(' ');
    if (at === -1) row[line] = true;
    else row[line.slice(0, at)] = line.slice(at + 1);
  }
  if (row) rows.push(row);
  return rows;
}

function containingRow(rows, dir) {
  let best = null;
  for (const row of rows) {
    if (typeof row.worktree !== 'string') continue;
    let wt;
    try { wt = fs.realpathSync(row.worktree); } catch { continue; }
    const rel = path.relative(wt, dir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (!best || wt.length > best.wt.length) best = { ...row, wt };
    }
  }
  return best;
}

function sourceLabel(source) {
  return source === 'flag' ? 'the --graph flag'
    : source === 'env' ? 'SHIPYARD_GRAPH_DIR'
      : 'the default .planning/graph location';
}

// @contract: the three canonical cases are exhaustive; anything else refuses GRAPH_NOT_CANONICAL.
function assertCanonicalGraph({ graphDir, worktree, source } = {}) {
  if (typeof graphDir !== 'string' || !graphDir.trim()) {
    reject('GRAPH_NOT_CANONICAL', 'a canonical graph directory is required');
  }
  let dir;
  try { dir = fs.realpathSync(graphDir); }
  catch { reject('GRAPH_NOT_CANONICAL', `canonical graph directory is unavailable: ${graphDir}`); }
  const inside = tryGit(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return;
  const list = tryGit(dir, ['worktree', 'list', '--porcelain']);
  if (!list.ok) reject('GRAPH_NOT_CANONICAL', `git worktree ownership could not be read for ${dir}`);
  const rows = parseWorktreeRows(list.out);
  if (!rows.length) reject('GRAPH_NOT_CANONICAL', `git worktree ownership could not be read for ${dir}`);
  const main = fs.realpathSync(rows[0].worktree);
  const containing = containingRow(rows, dir);
  if (!containing) reject('GRAPH_NOT_CANONICAL', `${dir} is not inside any known worktree of its repository`);
  if (containing.wt === main) return;
  const relative = path.relative(containing.wt, dir).split(path.sep).join('/');
  const ticketsRef = `HEAD:${relative ? `${relative}/tickets.json` : 'tickets.json'}`;
  if (tryGit(containing.wt, ['cat-file', '-e', ticketsRef]).ok) return;
  reject('GRAPH_NOT_CANONICAL',
    `${dir} (from ${sourceLabel(source)}) is an untracked graph copy inside a non-main worktree `
    + `(${containing.wt})${worktree ? ` requested for worktree ${worktree}` : ''}`);
}

// @security: O_NOFOLLOW open plus a post-read dev/ino recheck defeats a symlink swap mid-read.
function readBoundedUtf8(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    return { reason: error.code === 'ELOOP' ? 'not-regular' : 'missing' };
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return { reason: 'not-regular' };
    if (before.size > maxBytes) return { reason: 'too-large' };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) return { reason: 'too-large' };
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      return { reason: 'not-regular' };
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { return { reason: 'not-utf8' }; }
    return { bytes: buffer.subarray(0, length), text };
  } finally {
    fs.closeSync(fd);
  }
}

function stripLineSuffix(token) {
  return token.replace(/:\d+(?:-\d+)?$/, '');
}

function isUnsafeReference(display) {
  return /[<>…*]/.test(display) || display.split('/').includes('..');
}

function classifyStatic(display) {
  if (isUnsafeReference(display)) return 'placeholder';
  if (display === '.planning/graph' || display.startsWith('.planning/graph/')) return 'machine-state';
  return null;
}

// @contract: matched .planning/ spans are masked before the bare-name scan so an embedded name is never matched twice.
function collectReferences(planText, planRelPath) {
  const lines = planText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Context\s*\(Reads\)\s*$/i.test(line.trim()));
  if (start === -1) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    section.push(line);
  }
  const text = section.join('\n');
  const phaseDir = path.posix.dirname(planRelPath.split(path.sep).join('/'));
  const matches = [];
  const planningRe = /\.planning\/[^\s`,;)]+/g;
  let m;
  while ((m = planningRe.exec(text))) matches.push({ index: m.index, raw: m[0], kind: 'planning' });
  let masked = text;
  for (const { index, raw } of matches) {
    masked = masked.slice(0, index) + ' '.repeat(raw.length) + masked.slice(index + raw.length);
  }
  const phaseRe = new RegExp(`\\b(?:\\d{2}-)?(?:${BARE_PHASE_NAMES.join('|')})(?:\\.md)?(?::\\d+(?:-\\d+)?)?\\b`, 'g');
  while ((m = phaseRe.exec(masked))) matches.push({ index: m.index, raw: m[0], kind: 'phase' });
  matches.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const references = [];
  for (const { raw, kind } of matches) {
    const stripped = stripLineSuffix(raw);
    const display = kind === 'planning' ? stripped
      : `${phaseDir}/${/\.md$/.test(stripped) ? stripped : `${stripped}.md`}`;
    if (seen.has(display)) continue;
    seen.add(display);
    references.push({ display, reason: classifyStatic(display) });
  }
  return references;
}

// @contract: worktree is optional context only; graphDir alone decides in-worktree vs delivered.
function deliverPlan({ graphDir, row, worktree, expectedSha256 } = {}) {
  if (!object(row) || typeof row.plan !== 'string' || !row.plan.trim()
      || path.isAbsolute(row.plan) || row.plan.split('/').includes('..')) {
    reject('PLAN_UNDELIVERABLE', 'canonical graph names no approved source PLAN');
  }
  const projectRoot = path.resolve(graphDir, '..', '..');
  const resolvedPlanPath = path.resolve(projectRoot, row.plan);
  let planRealPath = resolvedPlanPath;
  try { planRealPath = fs.realpathSync(resolvedPlanPath); } catch { /* validated below */ }
  if (typeof worktree === 'string' && worktree.trim()) {
    let realWorktree = worktree;
    try { realWorktree = fs.realpathSync(worktree); } catch { /* keep as given */ }
    const rel = path.relative(realWorktree, planRealPath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return Object.freeze({ mode: 'in-worktree' });
    }
  }
  const planRead = readBoundedUtf8(resolvedPlanPath, MAX_REFERENCE_BYTES);
  if (planRead.reason) reject('PLAN_UNDELIVERABLE', `approved plan is ${planRead.reason}: ${row.plan}`);
  if (!planRead.text.trim()) reject('PLAN_UNDELIVERABLE', `approved plan is empty: ${row.plan}`);
  const planSha256 = crypto.createHash('sha256').update(planRead.bytes).digest('hex');
  if (typeof expectedSha256 === 'string' && expectedSha256 && expectedSha256 !== planSha256) {
    reject('PLAN_DIGEST_MISMATCH', `approved plan digest differs from the expected value: ${row.plan}`);
  }
  const references = collectReferences(planRead.text, row.plan);
  let totalBytes = 0;
  const files = [];
  const notDelivered = [];
  for (const ref of references) {
    if (ref.reason) { notDelivered.push({ path: ref.display, reason: ref.reason }); continue; }
    const absolute = path.resolve(projectRoot, ref.display);
    let fstat;
    try { fstat = fs.lstatSync(absolute); }
    catch { notDelivered.push({ path: ref.display, reason: 'missing' }); continue; }
    if (fstat.isDirectory()) { notDelivered.push({ path: ref.display, reason: 'directory' }); continue; }
    if (!fstat.isFile() || fstat.isSymbolicLink()) {
      notDelivered.push({ path: ref.display, reason: 'not-regular' }); continue;
    }
    if (fstat.size > MAX_REFERENCE_BYTES) { notDelivered.push({ path: ref.display, reason: 'too-large' }); continue; }
    if (totalBytes + fstat.size > MAX_TOTAL_BYTES) {
      notDelivered.push({ path: ref.display, reason: 'budget-exceeded' }); continue;
    }
    const read = readBoundedUtf8(absolute, MAX_REFERENCE_BYTES);
    if (read.reason) { notDelivered.push({ path: ref.display, reason: read.reason }); continue; }
    totalBytes += read.bytes.length;
    files.push(Object.freeze({
      path: ref.display, sha256: crypto.createHash('sha256').update(read.bytes).digest('hex'), content: read.text,
    }));
  }
  return Object.freeze({
    mode: 'delivered',
    plan: Object.freeze({ path: row.plan, sha256: planSha256, content: planRead.text }),
    files: Object.freeze(files),
    not_delivered: Object.freeze(notDelivered),
  });
}

module.exports = Object.freeze({
  MAX_REFERENCE_BYTES,
  MAX_TOTAL_BYTES,
  assertCanonicalGraph,
  deliverPlan,
});
