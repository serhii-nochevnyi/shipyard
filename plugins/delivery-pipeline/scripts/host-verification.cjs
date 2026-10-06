'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createVerificationRunner, createHostProfileRunner } = require('./command-runner.cjs');
const { scopedTree } = require('./delivery-commit-finalizer.cjs');

const MAX_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ASSIGNMENT_BYTES = 16 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeExclusive(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
    try {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {}
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function refusal(message) {
  const error = new Error('host-verification: ' + message);
  error.code = 'VERIFICATION_FAILED';
  return error;
}

function tokenize(command) {
  if (!command || /[|;&<>`$\\\r\n]/.test(command)) throw refusal('unrunnable shell operator in PLAN command');
  const argv = [];
  let token = '';
  let quote = null;
  let active = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) { argv.push(token); token = ''; active = false; }
    } else {
      token += char;
      active = true;
    }
  }
  if (quote || !argv.length && !active) throw refusal('unrunnable quoted PLAN command');
  if (active) argv.push(token);
  if (argv.some((part) => !part || part.includes('\0'))) throw refusal('unrunnable empty PLAN argument');
  if ((argv[0] === 'bash' || argv[0] === '/bin/bash' || argv[0] === 'sh')
      && argv.slice(1).some((part) => /^-[A-Za-z]*c[A-Za-z]*$/.test(part))) {
    throw refusal('unrunnable shell command launcher in PLAN command');
  }
  return argv;
}

function planCommands(pinnedPlanText) {
  if (typeof pinnedPlanText !== 'string') throw refusal('pinned PLAN text is required');
  const lines = pinnedPlanText.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+Verification commands\s*$/.test(line));
  if (heading < 0) return [];
  const commands = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const bullet = /^\s*[-*]\s+`(.*)`\s*$/.exec(line);
    if (bullet) commands.push(tokenize(bullet[1]));
  }
  return commands;
}

function admit(commands, allowList) {
  if (!Array.isArray(commands)) throw refusal('PLAN commands must be an array');
  if (!Array.isArray(allowList)) return Object.freeze({ commands: [], not_allowed: [], configured: false });
  const approved = [];
  const notAllowed = [];
  for (const argv of commands) {
    const entry = [...allowList].sort((left, right) => (right.argv?.length || 0) - (left.argv?.length || 0))
      .find((item) => Array.isArray(item.argv) && item.argv.length
      && item.argv.every((part, index) => part === argv[index])
      && (item.profile !== 'host' || item.argv.length === argv.length));
    if (!entry || !['host', 'sandbox'].includes(entry.profile === undefined ? 'sandbox' : entry.profile)) {
      notAllowed.push(argv); continue;
    }
    approved.push(Object.freeze({ argv: [...argv], profile: entry.profile || 'sandbox',
      timeout_ms: (entry.timeout_s || DEFAULT_TIMEOUT_MS / 1000) * 1000 }));
  }
  return Object.freeze({ commands: approved, not_allowed: notAllowed, configured: true });
}

function assignPlan(planText, allowList) {
  const commands = planCommands(planText);
  // Preserve legacy explicit verification specs with no PLAN commands. A PLAN
  // that names assertions requires current configuration before dispatch.
  if (!commands.length && !Array.isArray(allowList)) return null;
  const admitted = admit(commands, allowList);
  if (!admitted.configured || admitted.not_allowed.length || !admitted.commands.length) {
    const error = refusal(!admitted.configured ? 'HOLD: verification allow-list is absent'
      : admitted.not_allowed.length ? 'HOLD: PLAN command has no approved profile or exact host argv'
        : 'HOLD: PLAN has no verification commands');
    error.status = 'hold';
    error.command = admitted.not_allowed[0] || commands[0] || null;
    error.retryable = false;
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(admitted.commands), 'utf8') > MAX_ASSIGNMENT_BYTES) {
    const error = refusal('HOLD: approved command assignment exceeds 16384 bytes');
    error.status = 'hold';
    error.retryable = false;
    throw error;
  }
  return Object.freeze(admitted.commands.map((command) => Object.freeze({ ...command,
    argv: Object.freeze([...command.argv]) })));
}

function executable(program, worktree) {
  if (program === 'node') return process.execPath;
  if (program === 'make' || program === 'bash') {
    const candidates = program === 'make' ? ['/usr/bin/make', '/bin/make'] : ['/bin/bash', '/usr/bin/bash'];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw refusal(program + ' is unavailable on the verification host');
    return found;
  }
  if (!path.isAbsolute(program)) {
    const found = (process.env.PATH || '').split(path.delimiter)
      .map((directory) => path.join(directory, program)).find((candidate) => {
        try { const stat = fs.statSync(candidate); return stat.isFile() && (stat.mode & 0o111) !== 0; }
        catch { return false; }
      });
    if (!found) throw refusal('PLAN executable is unavailable on the host: ' + program);
    const resolved = fs.realpathSync(found);
    if (resolved === worktree || resolved.startsWith(worktree + path.sep)) {
      throw refusal('PLAN executable resolves inside the agent worktree: ' + program);
    }
    return resolved;
  }
  return program;
}

function defaultSandboxRunner(worktree, stateRoot, program) {
  const commonDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 10000 }).trim();
  return createVerificationRunner({ readOnlyPaths: [worktree, commonDir, path.dirname(process.execPath), path.dirname(program)],
    deniedPaths: [stateRoot, path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.ssh'),
      ...(process.env.GNUPGHOME ? [process.env.GNUPGHOME] : []),
      ...(process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [])],
    envAllowlist: ['PATH', 'LANG', 'LC_ALL'] });
}

function run(admitted, options = {}) {
  if (!admitted.configured) return [];
  const worktree = fs.realpathSync(options.worktree);
  const treeDigest = options.treeDigest || (() => scopedTree({ worktree,
    expectedHead: options.expectedHead, files_modified: options.files_modified }).tree);
  const tree = () => {
    try { return { digest: treeDigest(), error: null }; }
    catch (error) { return { digest: null, error: error.code || 'TREE_UNAVAILABLE' }; }
  };
  const results = admitted.not_allowed.map((argv) => Object.freeze({ argv, profile: null,
    outcome: 'not_allowed', status: null, signal: null, timed_out: false,
    stdout_sha256: sha256(''), stderr_sha256: sha256(''), tree_before: tree().digest, tree_after: tree().digest }));
  const skipped = (command) => Object.freeze({ argv: [...command.argv], profile: command.profile,
    timeout_ms: command.timeout_ms, backend: null, status: null, signal: null, timed_out: false,
    stdout_sha256: sha256(''), stderr_sha256: sha256(''), tree_before: null, tree_after: null,
    outcome: 'skipped' });
  if (results.length) return Object.freeze([...results, ...admitted.commands.map(skipped)]);
  for (const [index, command] of admitted.commands.entries()) {
    const before = tree();
    let result;
    try {
      if (before.error) throw refusal('scoped tree unavailable before verification');
      const spec = { id: 'plan-' + (results.length + 1), executable: executable(command.argv[0], worktree),
        argv: command.argv.slice(1), cwd: worktree, timeoutMs: command.timeout_ms, maxOutputBytes: MAX_OUTPUT };
      const runner = command.profile === 'host'
        ? options.hostRunner || createHostProfileRunner({ timeoutMs: command.timeout_ms, maxOutput: MAX_OUTPUT,
          envAllowList: ['PATH', 'LANG', 'LC_ALL'] })
        : options.sandboxRunner || defaultSandboxRunner(worktree, options.stateRoot, spec.executable);
      result = runner.run(spec);
    } catch (error) {
      result = { status: null, signal: null, timed_out: false, error_code: error.code || 'RUNNER_FAILED',
        stdout: '', stderr: error.message };
    }
    const after = tree();
    const passed = result.status === 0 && !result.signal && !result.timed_out && !result.error_code
      && !after.error && before.digest === after.digest;
    results.push(Object.freeze({ argv: [...command.argv], profile: command.profile,
      timeout_ms: command.timeout_ms, backend: result.backend?.kind || (command.profile === 'host' ? 'host' : null),
      backend_digest: result.backend?.digest || null, profile_sha256: result.profile_sha256 || null,
      status: result.status ?? null, signal: result.signal || null, timed_out: Boolean(result.timed_out),
      error_code: result.error_code || before.error || after.error || null,
      stdout_sha256: result.stdout_sha256 || sha256(result.stdout || ''),
      stderr_sha256: result.stderr_sha256 || sha256(result.stderr || ''),
      tree_before: before.digest, tree_after: after.digest, outcome: passed ? 'passed' : 'failed' }));
    if (!passed) {
      results.push(...admitted.commands.slice(index + 1).map(skipped));
      break;
    }
  }
  return Object.freeze(results);
}

function evidence(results, meta) {
  if (!meta || typeof meta.stateRoot !== 'string') throw refusal('host state root is required');
  const directory = path.join(meta.stateRoot, 'verification');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'hmac.key');
  writeExclusive(keyPath, crypto.randomBytes(32));
  const stat = fs.lstatSync(keyPath);
  const key = fs.readFileSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || key.length !== 32) {
    throw refusal('host verification key is invalid');
  }
  const payload = { schema: 'shipyard.host-verification.v1', ticket: meta.ticket || null,
    plan_sha256: meta.plan_sha256 || null,
    verification: meta.configured === false ? 'not-configured' : 'configured', results };
  const envelope = { format: 'shipyard.host-authenticated.v1', payload,
    integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', key).update(canonical(payload)).digest('hex') } };
  const digest = sha256(canonical(envelope));
  const file = path.join(directory, digest + '.json');
  const serialized = JSON.stringify(envelope) + '\n';
  if (!writeExclusive(file, serialized)) {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)
        || fs.readFileSync(file, 'utf8') !== serialized) throw refusal('host verification evidence changed');
  }
  return Object.freeze({ digest, path: file, outcome: meta.configured === false ? 'not-configured'
    : results.length && results.every((result) => result.outcome === 'passed') ? 'passed' : 'failed' });
}

function readEvidence(file, digest) {
  const keyPath = path.join(path.dirname(file), 'hmac.key');
  if (!fs.existsSync(keyPath)) return null;
  const keyStat = fs.lstatSync(keyPath);
  let recordStat;
  try { recordStat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077)
      || !recordStat.isFile() || recordStat.isSymbolicLink() || (recordStat.mode & 0o077)
      || recordStat.size > MAX_OUTPUT) return null;
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) return null;
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (!envelope || envelope.format !== 'shipyard.host-authenticated.v1'
      || envelope.payload?.schema !== 'shipyard.host-verification.v1'
      || sha256(canonical(envelope)) !== digest
      || envelope.integrity?.algorithm !== 'hmac-sha256'
      || !/^[0-9a-f]{64}$/.test(envelope.integrity?.mac || '')) return null;
  const expected = crypto.createHmac('sha256', key).update(canonical(envelope.payload)).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(envelope.integrity.mac, 'hex'))) return null;
  return envelope.payload;
}

function verifyPlan({ planText, allowList, worktree, stateRoot, ticket, planSha256,
  expectedHead, files_modified, sandboxRunner, hostRunner, treeDigest }) {
  const admitted = Array.isArray(allowList) ? admit(planCommands(planText), allowList) : admit([], null);
  const results = run(admitted, { worktree, stateRoot, expectedHead, files_modified,
    sandboxRunner, hostRunner, treeDigest });
  const sealed = evidence(results, { stateRoot, ticket, plan_sha256: planSha256,
    configured: admitted.configured });
  if (admitted.configured && (!results.length || sealed.outcome !== 'passed')) {
    const failure = results.find((result) => result.outcome !== 'passed');
    const error = refusal(failure ? `${failure.argv.join(' ')}: ${failure.outcome}${failure.tree_before !== failure.tree_after
      ? ' (changed scoped tree)' : ''}` : 'PLAN has no verification commands');
    error.status = 'verification_failed';
    error.command = failure?.argv || null;
    error.evidence_digest = sealed.digest;
    error.retryable = Boolean(failure && failure.outcome === 'failed' && failure.profile
      && Number.isSafeInteger(failure.status) && failure.status !== 0 && !failure.signal
      && !failure.timed_out && !failure.error_code && failure.tree_before === failure.tree_after);
    throw error;
  }
  return sealed;
}

module.exports = Object.freeze({ planCommands, admit, assignPlan, run, evidence, readEvidence,
  collectVerificationEvidence: verifyPlan, verifyPlan });
