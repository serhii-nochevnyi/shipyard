'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PRINCIPAL = 'shipyard-host-signer';
const GPG_FINGERPRINT = /^[0-9A-F]{40}$/i;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SSH_KEY_TYPE = /^(?:ssh-[a-z0-9]+|ecdsa-sha2-nistp\d+|sk-[a-z0-9@.-]+)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_FILE_MAX_BYTES = 64 * 1024;

class SignerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignerError';
    this.code = code;
  }
}

function text(error) {
  return String(error.stderr || error.message).trim();
}

function execute(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, ...options,
  });
}

function configValue(worktree, name, env) {
  try {
    return execute('git', ['-C', worktree, 'config', '--get', name], { env }).trim();
  } catch (error) {
    if (error.status === 1 && !String(error.stderr || '').trim()) return '';
    throw new SignerError('SIGNER_UNAVAILABLE', `Git configuration ${name} cannot be read: ${text(error)}`);
  }
}

function signingFormat(worktree, env) {
  const format = configValue(worktree, 'gpg.format', env).toLowerCase();
  if (format === '' || format === 'openpgp') return 'openpgp';
  if (format === 'ssh') return 'ssh';
  throw new SignerError('SIGNER_UNSUPPORTED',
    `gpg.format=${format} is not supported for delivery signing; use openpgp or ssh`);
}

function gpgSigner(key, env) {
  let output;
  try {
    output = execute('gpg', ['--batch', '--with-colons', '--list-secret-keys', key], { env });
  } catch (error) {
    throw new SignerError('SIGNER_UNAVAILABLE', `host signing key cannot be resolved: ${text(error)}`);
  }
  const lines = output.split(/\r?\n/);
  const secretKeys = lines.filter((line) => line.startsWith('sec:'));
  const fingerprint = lines.find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (secretKeys.length !== 1 || !GPG_FINGERPRINT.test(fingerprint || '')) {
    throw new SignerError('SIGNER_UNAVAILABLE', 'host signing key has no unique full fingerprint');
  }
  return { format: 'openpgp', fingerprint, publicKey: null };
}

function expandHome(file) {
  return file === '~' ? os.homedir() : file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

function isLiteralKey(key) {
  return key.startsWith('key::') || /^(?:ssh-|ecdsa-|sk-)/.test(key);
}

function readKeyFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw new SignerError('SIGNER_UNAVAILABLE', `host signing key file cannot be read: ${error.message}`);
  }
  if (!stat.isFile() || stat.size > KEY_FILE_MAX_BYTES) {
    throw new SignerError('SIGNER_UNAVAILABLE', 'host signing key file must be a bounded regular file');
  }
  return fs.readFileSync(file, 'utf8');
}

function publicKeyLine(content) {
  const line = content.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry && !entry.startsWith('#'));
  const [type, blob] = (line || '').split(/\s+/);
  if (!SSH_KEY_TYPE.test(type || '') || !BASE64.test(blob || '')) {
    throw new SignerError('SIGNER_UNAVAILABLE', 'host signing key is not an SSH public key');
  }
  return `${type} ${blob}`;
}

function sshPublicKey(worktree, key) {
  if (isLiteralKey(key)) return publicKeyLine(key.replace(/^key::/, ''));
  let file = expandHome(key);
  if (!path.isAbsolute(file)) file = path.resolve(worktree, file);
  const content = readKeyFile(file);
  if (/^-----BEGIN |^PuTTY-User-Key-File/.test(content)) {
    const sibling = `${file}.pub`;
    if (!fs.existsSync(sibling)) {
      throw new SignerError('SIGNER_UNAVAILABLE',
        'host signing key is a private key without a sibling .pub file; point user.signingkey at the public key');
    }
    return publicKeyLine(readKeyFile(sibling));
  }
  return publicKeyLine(content);
}

function sshSigner(worktree, key, env) {
  const publicKey = sshPublicKey(worktree, key);
  let output;
  try {
    output = execute('ssh-keygen', ['-E', 'sha256', '-l', '-f', '-'], { env, input: `${publicKey}\n` });
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'ssh-keygen is not available' : text(error);
    throw new SignerError('SIGNER_UNAVAILABLE', `host signing key cannot be resolved: ${reason}`);
  }
  const fingerprint = output.trim().split(/\s+/)[1];
  if (!SSH_FINGERPRINT.test(fingerprint || '')) {
    throw new SignerError('SIGNER_UNAVAILABLE', 'host signing key has no SHA256 fingerprint');
  }
  return { format: 'ssh', fingerprint, publicKey };
}

function resolveSigner(worktree, options = {}) {
  const env = options.env || process.env;
  const format = signingFormat(worktree, env);
  const key = configValue(worktree, 'user.signingkey', env);
  if (!key) throw new SignerError('SIGNER_UNAVAILABLE', 'host Git signer is unavailable');
  return format === 'ssh' ? sshSigner(worktree, key, env) : gpgSigner(key, env);
}

function signerFingerprint(worktree, options = {}) {
  return resolveSigner(worktree, options).fingerprint;
}

// @security: SSH verification trusts only the configured host key, never the operator's allowed-signers file.
function verifyCommitSignature(worktree, commit, options = {}) {
  const env = options.env || process.env;
  let directory = null;
  let config = [];
  try {
    if (signingFormat(worktree, env) === 'ssh') {
      const { publicKey } = resolveSigner(worktree, { env });
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-allowed-signers-'));
      const file = path.join(directory, 'allowed_signers');
      fs.writeFileSync(file, `${PRINCIPAL} namespaces="git" ${publicKey}\n`, { mode: 0o600 });
      config = ['-c', `gpg.ssh.allowedSignersFile=${file}`, '-c', 'gpg.ssh.program=ssh-keygen'];
    }
    const base = ['-C', worktree, ...config];
    try {
      execute('git', [...base, 'verify-commit', commit], { env });
    } catch (error) {
      throw new SignerError('SIGNATURE_INVALID', `git verify-commit failed: ${text(error)}`);
    }
    let output;
    try {
      output = execute('git', [...base, 'show', '-s', '--format=%G?%x00%GF', commit], { env });
    } catch (error) {
      throw new SignerError('SIGNATURE_INVALID', `git show failed: ${text(error)}`);
    }
    const [code, signer] = output.trim().split('\0');
    return { code, signer };
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function forcedSigningConfig(env = process.env) {
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const forced = [['commit.gpgsign', 'true'], ['merge.gpgSign', 'true']];
  const result = { GIT_CONFIG_COUNT: String(start + forced.length) };
  forced.forEach(([key, value], index) => {
    result[`GIT_CONFIG_KEY_${start + index}`] = key;
    result[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return result;
}

module.exports = {
  SignerError, signingFormat, resolveSigner, signerFingerprint, verifyCommitSignature, forcedSigningConfig,
};
