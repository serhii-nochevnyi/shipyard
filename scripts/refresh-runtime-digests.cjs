#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.cwd();
const PIN_PATH = path.join(ROOT, 'tests', 'unit', 'runtime-file-digests.json');
const SCHEMA = 'shipyard.runtime-file-digests.v1';

function die(msg, code = 1) {
  console.error(`refresh-runtime-digests: ${msg}`);
  process.exit(code);
}

function loadPin() {
  let raw;
  try {
    raw = fs.readFileSync(PIN_PATH, 'utf8');
  } catch (e) {
    die(`cannot read ${PIN_PATH}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${PIN_PATH} is not valid JSON: ${e.message}`);
  }
  return {};
}

function digestFor(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) die(`listed file is missing: ${rel}`);
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const pin = loadPin();
  const files = pin.files || {};
  const sortedPaths = Object.keys(files).sort();
  const nextFiles = {};
  const changed = [];
  for (const rel of sortedPaths) {
    const digest = digestFor(rel);
    if (digest !== files[rel]) changed.push(rel);
    nextFiles[rel] = digest;
  }

  if (check) process.exit(changed.length ? 1 : 0);
  if (!changed.length) process.exit(0);

  fs.writeFileSync(PIN_PATH, `${JSON.stringify({ schema: SCHEMA, files: nextFiles }, null, 2)}\n`);
  for (const rel of changed) console.log(`Runtime-Digest-Refresh: ${rel}`);
}

main();
