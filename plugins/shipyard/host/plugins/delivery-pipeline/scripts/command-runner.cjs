'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

const SANDBOX_CANDIDATES = Object.freeze({
  darwin: Object.freeze(['/usr/bin/sandbox-exec']),
  linux: Object.freeze(['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']),
});
const LINUX_SYSTEM_PATHS = Object.freeze(['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']);
const MAX_VERIFICATION_OUTPUT_BYTES = 1024 * 1024;

function sandboxError(code, message) {
  const error = new Error(`verification runner: ${message}`);
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function realOrResolved(file) {
  try { return fs.realpathSync(file); } catch (_) { return path.resolve(file); }
}

function selectSandboxBackend(options = {}) {
  const platform = options.platform || process.platform;
  const kind = platform === 'darwin' ? 'sandbox-exec' : platform === 'linux' ? 'bwrap' : null;
  const candidates = options.candidates || SANDBOX_CANDIDATES[platform] || [];
  if (!kind || !candidates.length) {
    throw sandboxError('SANDBOX_UNAVAILABLE', `no supported OS sandbox backend for ${platform}; run verification on macOS or Linux with bwrap`);
  }
  for (const candidate of candidates) {
    let real;
    try {
      real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    } catch (_) { continue; }
    return Object.freeze({ kind, path: real, digest: sha256(fs.readFileSync(real)) });
  }
  throw sandboxError('SANDBOX_UNAVAILABLE', `${kind} is not installed; install it on the verification host`);
}

function sbplString(value) {
  return JSON.stringify(value);
}

function darwinProfile({ writable, denied }) {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix-shm iokit-open)',
    '(allow file-read*)',
    ...denied.map((entry) => `(deny file-read* file-write* (subpath ${sbplString(entry)}))`),
    `(allow file-write* (subpath ${sbplString(writable)}) (literal "/dev/null"))`,
    '(allow file-ioctl (literal "/dev/null"))',
    '',
  ].join('\n');
}

function linuxArguments({ readOnly, writable, denied, cwd, env }) {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv'];
  const mounted = [];
  for (const entry of [...LINUX_SYSTEM_PATHS, ...readOnly]) {
    if (!fs.existsSync(entry) || mounted.includes(entry)) continue;
    mounted.push(entry);
    args.push('--ro-bind', entry, entry);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--bind', writable, writable);
  for (const entry of denied) {
    if (!mounted.some((root) => entry === root || entry.startsWith(root + path.sep))) continue;
    let stat;
    try { stat = fs.statSync(entry); } catch (_) { continue; }
    if (stat.isDirectory()) args.push('--tmpfs', entry);
    else args.push('--ro-bind', '/dev/null', entry);
  }
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  args.push('--chdir', cwd, '--');
  return args;
}

function verificationSpec(spec) {
  const valid = spec && typeof spec === 'object' && !Array.isArray(spec)
    && typeof spec.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(spec.id)
    && typeof spec.executable === 'string' && path.isAbsolute(spec.executable)
    && Array.isArray(spec.argv) && spec.argv.every((value) => typeof value === 'string' && !value.includes('\0'))
    && typeof spec.cwd === 'string' && path.isAbsolute(spec.cwd)
    && Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0 && spec.timeoutMs <= 10 * 60 * 1000
    && Number.isSafeInteger(spec.maxOutputBytes) && spec.maxOutputBytes > 0
    && spec.maxOutputBytes <= MAX_VERIFICATION_OUTPUT_BYTES;
  if (!valid) throw sandboxError('VERIFICATION_SPEC_UNSUPPORTED', 'verification spec needs id, absolute executable/cwd, argv, timeoutMs and maxOutputBytes');
  return Object.freeze({ id: spec.id, executable: spec.executable, argv: Object.freeze([...spec.argv]),
    cwd: spec.cwd, timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes });
}

function bounded(text, limit) {
  const buffer = Buffer.from(text || '', 'utf8');
  return buffer.length > limit ? buffer.subarray(0, limit).toString('utf8') : buffer.toString('utf8');
}

function createVerificationRunner(options = {}) {
  const backend = options.backend || selectSandboxBackend(options);
  if (!backend || !['sandbox-exec', 'bwrap'].includes(backend.kind) || !path.isAbsolute(backend.path || '')) {
    throw sandboxError('SANDBOX_UNAVAILABLE', 'verification runner requires a host-approved OS sandbox backend');
  }
  const readOnly = [...new Set((options.readOnlyPaths || []).map(realOrResolved))];
  const denied = [...new Set((options.deniedPaths || []).map(realOrResolved))];
  const allow = new Set(options.envAllowlist || ['PATH', 'LANG', 'LC_ALL']);
  const sourceEnv = options.env || process.env;
  const tempRoot = realOrResolved(options.tempRoot || os.tmpdir());

  function run(rawSpec) {
    const spec = verificationSpec(rawSpec);
    const cwd = realOrResolved(spec.cwd);
    if (!readOnly.some((root) => cwd === root || cwd.startsWith(root + path.sep))) {
      throw sandboxError('VERIFICATION_SPEC_UNSUPPORTED', 'verification cwd must be inside a read-only mounted path');
    }
    const writable = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'shipyard-verify-')));
    try {
      const env = {};
      for (const key of allow) if (typeof sourceEnv[key] === 'string') env[key] = sourceEnv[key];
      env.TMPDIR = writable;
      env.HOME = writable;
      let file;
      let args;
      let profile;
      if (backend.kind === 'sandbox-exec') {
        profile = darwinProfile({ writable, denied });
        file = backend.path;
        args = ['-p', profile, spec.executable, ...spec.argv];
      } else {
        const prefix = linuxArguments({ readOnly, writable, denied, cwd, env });
        profile = prefix.join('\0');
        file = backend.path;
        args = [...prefix, spec.executable, ...spec.argv];
      }
      const result = runBounded(file, args, {
        cwd, env: backend.kind === 'sandbox-exec' ? env : {}, timeoutMs: spec.timeoutMs,
        maxBuffer: spec.maxOutputBytes * 4,
      });
      const stdout = bounded(result.stdout, spec.maxOutputBytes);
      const stderr = bounded(result.stderr, spec.maxOutputBytes);
      return Object.freeze({
        id: spec.id,
        spec_sha256: sha256(JSON.stringify(spec)),
        status: result.status,
        signal: result.signal,
        error_code: result.errorCode,
        timed_out: result.timedOut,
        stdout,
        stderr,
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
        backend: Object.freeze({ kind: backend.kind, path: backend.path, digest: backend.digest }),
        profile_sha256: sha256(profile),
      });
    } finally {
      fs.rmSync(writable, { recursive: true, force: true });
    }
  }

  if (options.probe !== false) {
    const probe = run({ id: 'sandbox-probe', executable: process.execPath, argv: ['-e', ''],
      cwd: readOnly[0] || tempRoot, timeoutMs: 10_000, maxOutputBytes: 4096 });
    if (probe.status !== 0 || probe.error_code || probe.timed_out) {
      throw sandboxError('SANDBOX_UNAVAILABLE', `${backend.kind} cannot apply a profile here (${tail(probe.stderr, 200) || probe.error_code || probe.status}); run verification on a host that permits it`);
    }
  }
  return Object.freeze({ backend, run });
}

module.exports = {
  SANDBOX_CANDIDATES,
  selectSandboxBackend,
  createVerificationRunner,
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
