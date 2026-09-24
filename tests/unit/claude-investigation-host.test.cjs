'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT_PATH = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/claude-investigation-host.cjs');

test('spawning with bad argv exits 1, keeps the first stderr line, and appends a hint line', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n');
  assert.equal(lines[0], 'claude-investigation-host: --request-file <json> is required');
  assert.match(lines[1], /^hint\[INVALID_HOST\]: /);
});

test('spawning with a caller-supplied host module still refuses with the pinned message and a hint line', () => {
  const result = spawnSync(process.execPath,
    [SCRIPT_PATH, '--args-file', '/tmp/args.json', '--host-module', '/tmp/host.cjs'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--request-file <json> is required/);
  const lines = result.stderr.split('\n');
  assert.match(lines[1], /^hint\[INVALID_HOST\]: /);
});
