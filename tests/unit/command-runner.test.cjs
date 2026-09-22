'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  diagnostic,
  redact,
  runBounded,
  runChecked,
} = require('../../plugins/delivery-pipeline/scripts/command-runner.cjs');

test('bounded runner returns normal output and status', () => {
  const result = runBounded(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 1000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.timedOut, false);
});

test('bounded runner turns a hung child into a safe timeout diagnostic', () => {
  const result = runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 25 });
  assert.equal(result.timedOut, true);
  assert.match(diagnostic(result), /timed out after 25ms/);
});

test('diagnostics redact credentials from output and command arguments', () => {
  const result = runBounded(process.execPath, [
    '-e', 'process.stderr.write("token=hunter2 Bearer abc123")',
    '--token=hunter2',
  ], { timeoutMs: 1000 });
  const message = diagnostic(result);
  assert.doesNotMatch(message, /hunter2|abc123/);
  assert.match(message, /REDACTED/);
  assert.doesNotMatch(result.command, /hunter2/);
  assert.equal(redact('password: hunter2'), 'password: [REDACTED]');
});

test('runChecked exposes a stable failure code', () => {
  assert.throws(
    () => runChecked(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 1000 }),
    (error) => error.code === 'COMMAND_FAILED' && /exited 7/.test(error.message),
  );
});
