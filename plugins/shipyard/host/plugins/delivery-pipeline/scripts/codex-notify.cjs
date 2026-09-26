#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const observer = require('./session-observer.cjs');

function readDelegate(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && value.version === 1 && (Array.isArray(value.delegate) || value.delegate === null)
      ? value.delegate
      : null;
  } catch {
    return null;
  }
}

function main(argv = process.argv.slice(2)) {
  const payloadText = argv.at(-1) || '';
  let payload = {};
  try { payload = JSON.parse(payloadText); } catch {}
  const codexHome = process.env.CODEX_HOME || path.resolve(__dirname, '..', '..');
  const graph = process.env.SHIPYARD_GRAPH_DIR
    || path.resolve(payload.cwd || process.cwd(), '.planning', 'graph');
  const db = process.env.SHIPYARD_CODEX_LOG_DB || path.join(codexHome, 'logs_2.sqlite');
  try { observer.observeCodexDatabase(db, graph, { threadId: payload.thread_id, turnId: payload.turn_id }); } catch {}

  const delegateFile = process.env.SHIPYARD_CODEX_NOTIFY_DELEGATE
    || path.resolve(__dirname, '..', '..', 'shipyard-notify-delegate.json');
  const delegate = readDelegate(delegateFile);
  if (!delegate || !delegate.length) return 0;
  try {
    const child = spawn(delegate[0], delegate.slice(1).concat(payloadText), {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {}
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
