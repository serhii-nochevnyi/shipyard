#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const REL_PIN = 'tests/unit/runtime-file-digests.json';
const TRAILER_KEY = /^\s*Runtime-Digest-Refresh:\s*(.+?)\s*$/i;

function die(msg, code = 1) {
  console.error(`check-runtime-digest-trailer: ${msg}`);
  process.exit(code);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseBase(argv) {
  const i = argv.indexOf('--base');
  if (i === -1 || argv[i + 1] == null) die('usage: check-runtime-digest-trailer.cjs --base <ref>', 2);
  return argv[i + 1];
}

// @invariant: only the message's trailing paragraph is scanned as a trailer block.
function trailerBlock(message) {
  const lines = String(message || '').replace(/\s+$/, '').split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1;
  return lines.slice(start, end);
}

function refreshedPaths(message) {
  const paths = new Set();
  for (const line of trailerBlock(message)) {
    const m = TRAILER_KEY.exec(line);
    if (m) paths.add(m[1]);
  }
  return paths;
}

function pinAt(rev) {
  let raw;
  try {
    raw = git(['show', `${rev}:${REL_PIN}`]);
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw).files || {};
  } catch {
    return {};
  }
}

function main() {
  const base = parseBase(process.argv.slice(2));
  const range = `${base}..HEAD`;
  let shas;
  try {
    shas = git(['log', '--no-merges', '--format=%H', range, '--', REL_PIN])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse();
  } catch (e) {
    die(`git log ${range} -- ${REL_PIN} failed: ${e.message}`);
    return;
  }

  let failed = false;
  for (const sha of shas) {
    const before = pinAt(`${sha}^`);
    if (before === null) continue;
    const after = pinAt(sha) || {};
    const changed = Object.keys(after).filter((rel) => before[rel] !== after[rel]);
    if (!changed.length) continue;
    const named = refreshedPaths(git(['log', '-1', '--format=%B', sha]));
    for (const rel of changed) {
      if (!named.has(rel)) {
        console.error(`check-runtime-digest-trailer: commit ${sha} changed ${rel} without a `
          + `\`Runtime-Digest-Refresh: ${rel}\` trailer`);
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
