#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeAtomic } = require('./lock.cjs');

// @security: the id becomes a file name; anything outside this set (e.g. "../x", "${...}") is refused.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const BOARD_SUFFIX = `${path.sep}.planning${path.sep}graph`;

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

function gitPath(cwd, flag) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', flag],
    { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.trim()) return null;
  return path.resolve(cwd, r.stdout.trim());
}

function gitCommonDir(cwd) {
  return gitPath(cwd, '--git-common-dir');
}

function worktreesOf(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return r.stdout.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean);
}

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function markerPath(cwd, sessionId) {
  if (!validSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  const common = gitCommonDir(cwd);
  const dir = common
    ? path.join(common, 'shipyard', 'stop-gate-armed')
    : path.join(cwd, '.planning', 'graph', 'stop-gate-armed');
  return path.join(dir, `${sessionId}.json`);
}

function boardOf(dir) {
  const real = realOrNull(dir);
  if (!real || !real.endsWith(BOARD_SUFFIX)) return null;
  try { if (!fs.statSync(real).isDirectory()) return null; } catch { return null; }
  return real;
}

function resolveBoard(cwd, graphDir) {
  const explicit = graphDir || process.env.SHIPYARD_GRAPH_DIR;
  if (explicit) {
    const board = boardOf(path.resolve(cwd, explicit));
    return board ? { board, competitors: [] } : { board: null, competitors: [], refused: path.resolve(cwd, explicit) };
  }
  const own = path.join(cwd, '.planning', 'graph');
  const board = boardOf(own);
  if (!board || !['delivery-front.json', 'tickets.json'].some((f) => fs.existsSync(path.join(board, f)))) {
    return { board: null, competitors: [] };
  }
  const gitDir = gitPath(cwd, '--git-dir');
  const common = gitCommonDir(cwd);
  if (gitDir && common && realOrNull(gitDir) !== realOrNull(common)) return { board, competitors: [] };
  const competitors = [];
  for (const wt of worktreesOf(cwd)) {
    const other = boardOf(path.join(wt, '.planning', 'graph'));
    if (other && other !== board && fs.existsSync(path.join(other, 'delivery-front.json'))) competitors.push(other);
  }
  return competitors.length ? { board: null, competitors } : { board, competitors };
}

function arm(cwd, sessionId, opts = {}) {
  const file = markerPath(cwd, sessionId);
  const resolved = resolveBoard(cwd, opts.graphDir);
  const body = { session_id: sessionId, armed_at: new Date().toISOString(), cwd: path.resolve(cwd) };
  if (resolved.board) body.board = resolved.board;
  writeAtomic(file, JSON.stringify(body, null, 2) + '\n');
  return { file, board: resolved.board, competitors: resolved.competitors, refused: resolved.refused || null };
}

function readMarker(cwd, sessionId) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(cwd, sessionId), 'utf8'));
    return marker && typeof marker === 'object' && marker.session_id === sessionId ? marker : null;
  } catch {
    return null;
  }
}

function isArmed(cwd, sessionId) {
  return readMarker(cwd, sessionId) !== null;
}

function disarm(cwd, sessionId) {
  const file = markerPath(cwd, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { file, removed: false };
    throw e;
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  if (!body || typeof body !== 'object' || body.session_id !== sessionId) {
    throw new Error(`the marker at ${file} does not belong to session ${sessionId}; it was kept`);
  }
  fs.unlinkSync(file);
  return { file, removed: true };
}

module.exports = { markerPath, arm, isArmed, readMarker, disarm, validSessionId };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
  const at = argv.indexOf('--session-id');
  const sessionId = at === -1 ? process.env.CLAUDE_CODE_SESSION_ID : argv[at + 1];
  const verb = argv[0];
  if (verb !== 'arm' && verb !== 'disarm') {
    process.stderr.write('usage: stop-gate-arm.cjs arm [--session-id <id>] [--graph-dir <board>]\n'
      + '       stop-gate-arm.cjs disarm [--session-id <id>]\n');
    process.exit(1);
  }
  if (!validSessionId(sessionId)) {
    process.stderr.write(`stop-gate-arm: refusing session id ${JSON.stringify(sessionId)} — `
      + `expected 8-128 characters of [A-Za-z0-9_-]; the stop gate is NOT ${verb === 'arm' ? 'armed' : 'disarmed'}\n`);
    process.exit(1);
  }
  if (verb === 'disarm') {
    try {
      const r = disarm(process.cwd(), sessionId);
      process.stdout.write(r.removed ? `stop-gate disarmed: ${r.file}\n` : `stop-gate was not armed: ${r.file}\n`);
    } catch (e) {
      process.stderr.write(`stop-gate-arm: could not disarm (${e.message})\n`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const r = arm(process.cwd(), sessionId, { graphDir: flag('--graph-dir') });
    process.stdout.write(`stop-gate armed: ${r.file}\n`);
    if (r.board) {
      process.stdout.write(`  bound to board ${r.board}\n`);
    } else {
      process.stdout.write('  unbound (legacy): the hook scans every worktree, refuses at most once per turn\n');
      if (r.refused) process.stdout.write(`  ${r.refused} is not a .planning/graph directory, so it was not bound\n`);
      for (const c of r.competitors) process.stdout.write(`  competing board: ${c}\n`);
      process.stdout.write('  bind one with: stop-gate-arm.cjs arm --graph-dir <board>\n');
    }
  } catch (e) {
    process.stderr.write(`stop-gate-arm: could not write the marker (${e.message}); the stop gate is NOT armed\n`);
    process.exit(1);
  }
}
