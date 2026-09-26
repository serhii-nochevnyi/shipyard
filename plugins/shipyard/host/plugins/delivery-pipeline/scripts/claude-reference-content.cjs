'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const MAX_REFERENCE_BYTES = 64 * 1024;
const REFERENCE_IDS = Object.freeze([
  'arch-review',
  'ci-fix',
  'drift-check',
  'integrator',
  'inv-research',
  'pr-sentinel',
  'review-fix',
]);
const REFERENCE_PATHS = Object.freeze(Object.fromEntries(
  REFERENCE_IDS.map((id) => [id, path.join(PLUGIN_ROOT, 'references', `${id}.md`)]),
));

function reject(message) {
  const error = new Error(`claude-reference-content: ${message}`);
  error.code = 'INVALID_REFERENCE';
  throw error;
}

function referenceId(selection) {
  if (typeof selection !== 'string') reject('reference must be an approved ID or exact installed path');
  if (Object.hasOwn(REFERENCE_PATHS, selection)) return selection;
  const id = REFERENCE_IDS.find((candidate) => REFERENCE_PATHS[candidate] === selection);
  if (id) return id;
  reject('unknown reference ID or path');
}

function assertSafePath(file) {
  const components = [PLUGIN_ROOT, path.join(PLUGIN_ROOT, 'references'), file];
  for (let index = 0; index < components.length; index++) {
    let stat;
    try {
      stat = fs.lstatSync(components[index]);
    } catch {
      reject('approved reference is unavailable');
    }
    if (stat.isSymbolicLink()) reject('symlinked reference path is forbidden');
    if (index < components.length - 1 && !stat.isDirectory()) reject('reference parent is not a directory');
    if (index === components.length - 1 && !stat.isFile()) reject('reference is not a regular file');
  }
  try {
    if (fs.realpathSync(file) !== file) reject('symlinked reference path is forbidden');
  } catch (error) {
    if (error.code === 'INVALID_REFERENCE') throw error;
    reject('approved reference is unavailable');
  }
}

function loadClaudeReferenceContent(selection) {
  const id = referenceId(selection);
  const file = REFERENCE_PATHS[id];
  assertSafePath(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) reject('reference is not a regular file');
    if (stat.size > MAX_REFERENCE_BYTES) reject('reference exceeds size limit');
    const buffer = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_REFERENCE_BYTES) reject('reference exceeds size limit');
    assertSafePath(file);
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      reject('approved reference changed while reading');
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (content.includes(PLUGIN_ROOT)) reject('reference exposes the installed plugin path');
    return content;
  } catch (error) {
    if (error.code === 'INVALID_REFERENCE') throw error;
    reject('approved reference cannot be read');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = Object.freeze({
  MAX_REFERENCE_BYTES,
  REFERENCE_IDS,
  REFERENCE_PATHS,
  loadClaudeReferenceContent,
});
