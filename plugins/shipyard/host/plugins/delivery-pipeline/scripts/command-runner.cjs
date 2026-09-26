'use strict';

const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_BYTES = 2048;

function integer(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function timeoutFromEnv(name, fallback = DEFAULT_TIMEOUT_MS, maximum = 10 * 60 * 1000) {
  const value = Number(process.env[name]);
  return integer(value, fallback, maximum);
}

function tail(value, limit = DEFAULT_DIAGNOSTIC_BYTES) {
  const text = String(value || '').trim();
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function redact(value) {
  return String(value || '')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:--?|["']?)(?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[=:]\s*["']?)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*["'])[^"']+/gi, '$1[REDACTED]');
}

function displayCommand(file, args = []) {
  return [file, ...args].map((value) => redact(value)).join(' ');
}

function runBounded(file, args = [], options = {}) {
  const timeoutMs = integer(options.timeoutMs, DEFAULT_TIMEOUT_MS, options.maxTimeoutMs || 10 * 60 * 1000);
  const maxBuffer = integer(options.maxBuffer, DEFAULT_MAX_BUFFER_BYTES, 256 * 1024 * 1024);
  const started = process.hrtime.bigint();
  let result;
  try {
    const { timeoutMs: _timeout, maxBuffer: _buffer, ...spawnOptions } = options;
    result = spawnSync(file, args, {
      ...spawnOptions,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      stdio: spawnOptions.stdio || ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    result = { status: null, signal: null, stdout: '', stderr: '', error };
  }
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  const error = result.error || null;
  return {
    command: displayCommand(file, args),
    file,
    args: args.map((value) => redact(value)),
    status: result.status === undefined ? null : result.status,
    signal: result.signal || null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error,
    errorCode: error && error.code ? error.code : null,
    timedOut: Boolean(error && error.code === 'ETIMEDOUT'),
    elapsedMilliseconds: Math.round(elapsedMilliseconds),
    timeoutMs,
  };
}

function diagnostic(result, limit = DEFAULT_DIAGNOSTIC_BYTES) {
  if (!result) return 'command did not return a result';
  const parts = [];
  if (result.timedOut) parts.push(`timed out after ${result.timeoutMs}ms`);
  else if (result.error) parts.push(redact(result.error.message || String(result.error)));
  else if (result.status !== 0) parts.push(`exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`);
  const stderr = redact(tail(result.stderr, limit));
  const stdout = redact(tail(result.stdout, limit));
  if (stderr) parts.push(`stderr: ${stderr}`);
  if (stdout && !stderr) parts.push(`stdout: ${stdout}`);
  return parts.join('; ') || 'completed successfully';
}

function runChecked(file, args = [], options = {}) {
  const result = runBounded(file, args, options);
  if (result.error || result.status !== 0) {
    const error = new Error(`${result.command} failed: ${diagnostic(result)}`);
    error.code = result.timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED';
    error.result = result;
    throw error;
  }
  return result;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER_BYTES,
  diagnostic,
  displayCommand,
  redact,
  runBounded,
  runChecked,
  tail,
  timeoutFromEnv,
};
