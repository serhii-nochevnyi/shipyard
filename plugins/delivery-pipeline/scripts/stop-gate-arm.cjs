#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeAtomic } = require('./lock.cjs');

// @security: the id becomes a file name; anything outside this set (e.g. "../x", "${...}") is refused.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

function gitCommonDir(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.trim()) return null;
  return path.resolve(cwd, r.stdout.trim());
}

function markerPath(cwd, sessionId) {
  if (!validSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  const common = gitCommonDir(cwd);
  const dir = common
    ? path.join(common, 'shipyard', 'stop-gate-armed')
    : path.join(cwd, '.planning', 'graph', 'stop-gate-armed');
  return path.join(dir, `${sessionId}.json`);
}

function arm(cwd, sessionId) {
  const file = markerPath(cwd, sessionId);
  const body = { session_id: sessionId, armed_at: new Date().toISOString(), cwd: path.resolve(cwd) };
  writeAtomic(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

function isArmed(cwd, sessionId) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(cwd, sessionId), 'utf8'));
    return Boolean(marker && typeof marker === 'object' && marker.session_id === sessionId);
  } catch {
    return false;
  }
}

module.exports = { markerPath, arm, isArmed, validSessionId };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--session-id');
  const sessionId = at === -1 ? process.env.CLAUDE_CODE_SESSION_ID : argv[at + 1];
  if (argv[0] !== 'arm') {
    process.stderr.write('usage: stop-gate-arm.cjs arm [--session-id <id>]\n');
    process.exit(1);
  }
  if (!validSessionId(sessionId)) {
    process.stderr.write(`stop-gate-arm: refusing session id ${JSON.stringify(sessionId)} — `
      + 'expected 8-128 characters of [A-Za-z0-9_-]; the stop gate is NOT armed\n');
    process.exit(1);
  }
  try {
    process.stdout.write(`stop-gate armed: ${arm(process.cwd(), sessionId)}\n`);
  } catch (e) {
    process.stderr.write(`stop-gate-arm: could not write the marker (${e.message}); the stop gate is NOT armed\n`);
    process.exit(1);
  }
}
