'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { before, after, test } = require('node:test');
const signer = require('../../plugins/delivery-pipeline/scripts/commit-signer.cjs');

const hasSshKeygen = !spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error;
const skipSsh = hasSshKeygen ? false : 'ssh-keygen is not installed';

let temporary;
let previous;
let sequence = 0;
let keyA;
let keyB;

function run(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

function git(repo, ...args) {
  return run('git', ['-C', repo, ...args]);
}

function makeKey(name) {
  const file = path.join(temporary, 'home', '.ssh', name);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', file]);
  const pub = `${file}.pub`;
  const fingerprint = run('ssh-keygen', ['-E', 'sha256', '-lf', pub]).split(/\s+/)[1];
  return { file, pub, fingerprint, line: fs.readFileSync(pub, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ') };
}

function makeRepo(config = {}) {
  const repo = path.join(temporary, `repo-${++sequence}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Signer Test');
  git(repo, 'config', 'user.email', 'signer@example.test');
  for (const [name, value] of Object.entries(config)) git(repo, 'config', name, value);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  git(repo, 'add', '.');
  return repo;
}

function sshRepo(key, signingkey = key.pub) {
  return makeRepo({ 'gpg.format': 'ssh', 'user.signingkey': signingkey });
}

function signedCommit(repo) {
  git(repo, 'commit', '-q', '-S', '-m', 'signed');
  return git(repo, 'rev-parse', 'HEAD');
}

before(() => {
  temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'commit-signer-'));
  fs.mkdirSync(path.join(temporary, 'home', '.ssh'), { recursive: true });
  previous = {};
  const environment = {
    HOME: path.join(temporary, 'home'),
    GIT_CONFIG_GLOBAL: path.join(temporary, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    SSH_AUTH_SOCK: undefined,
    GIT_CONFIG_COUNT: undefined,
  };
  for (const [name, value] of Object.entries(environment)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  if (hasSshKeygen) {
    keyA = makeKey('id_a');
    keyB = makeKey('id_b');
  }
});

after(() => {
  for (const [name, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

test('ssh: a public key path resolves its SHA256 fingerprint and git reports the same value', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA);
  const resolved = signer.resolveSigner(repo);
  assert.equal(resolved.format, 'ssh');
  assert.equal(resolved.fingerprint, keyA.fingerprint);
  const commit = signedCommit(repo);
  assert.deepEqual(signer.verifyCommitSignature(repo, commit), { code: 'G', signer: keyA.fingerprint });
});

test('ssh: verification ignores the operator allowed-signers file and works without one', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA);
  const commit = signedCommit(repo);
  const other = path.join(temporary, 'allowed-other');
  fs.writeFileSync(other, `x@example.test ${keyB.line}\n`);
  git(repo, 'config', 'gpg.ssh.allowedSignersFile', other);
  assert.deepEqual(signer.verifyCommitSignature(repo, commit), { code: 'G', signer: keyA.fingerprint });
  assert.equal(git(repo, 'config', '--get', 'gpg.ssh.allowedSignersFile'), other);
});

test('ssh: verification works when gpg.ssh.program is a signing-only wrapper', { skip: skipSsh }, () => {
  const wrapper = path.join(temporary, 'sign-only.sh');
  fs.writeFileSync(wrapper, '#!/bin/sh\ncase " $* " in *" -Y sign "*) exec ssh-keygen "$@";; esac\nexit 1\n', { mode: 0o755 });
  const repo = sshRepo(keyA);
  git(repo, 'config', 'gpg.ssh.program', wrapper);
  const commit = signedCommit(repo);
  assert.deepEqual(signer.verifyCommitSignature(repo, commit), { code: 'G', signer: keyA.fingerprint });
  assert.equal(git(repo, 'config', '--get', 'gpg.ssh.program'), wrapper);
});

test('ssh: a private key path uses the sibling .pub and refuses a private key without one', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA, keyA.file);
  assert.equal(signer.signerFingerprint(repo), keyA.fingerprint);
  assert.equal(signer.verifyCommitSignature(repo, signedCommit(repo)).signer, keyA.fingerprint);

  const lone = path.join(temporary, 'home', '.ssh', 'id_lone');
  fs.copyFileSync(keyA.file, lone);
  fs.chmodSync(lone, 0o600);
  git(repo, 'config', 'user.signingkey', lone);
  assert.throws(() => signer.signerFingerprint(repo), (error) => error.code === 'SIGNER_UNAVAILABLE'
    && /without a sibling \.pub/.test(error.message));
});

test('ssh: home-relative and worktree-relative key paths resolve', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA, '~/.ssh/id_a.pub');
  assert.equal(signer.signerFingerprint(repo), keyA.fingerprint);
  fs.copyFileSync(keyB.pub, path.join(repo, 'signer.pub'));
  git(repo, 'config', 'user.signingkey', 'signer.pub');
  assert.equal(signer.signerFingerprint(repo), keyB.fingerprint);
});

test('ssh: key:: and bare literal keys resolve, and verify a commit signed with the same key', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA);
  const commit = signedCommit(repo);
  git(repo, 'config', 'user.signingkey', `key::${keyA.line} comment`);
  assert.equal(signer.signerFingerprint(repo), keyA.fingerprint);
  assert.deepEqual(signer.verifyCommitSignature(repo, commit), { code: 'G', signer: keyA.fingerprint });
  git(repo, 'config', 'user.signingkey', keyA.line);
  assert.equal(signer.signerFingerprint(repo), keyA.fingerprint);
});

test('ssh: a commit signed by another key is refused', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA);
  const commit = signedCommit(repo);
  git(repo, 'config', 'user.signingkey', keyB.pub);
  assert.equal(signer.signerFingerprint(repo), keyB.fingerprint);
  assert.throws(() => signer.verifyCommitSignature(repo, commit),
    (error) => error.code === 'SIGNATURE_INVALID' && /verify-commit failed/.test(error.message));
});

test('ssh: a tampered commit is refused', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA);
  const commit = signedCommit(repo);
  const forged = git(repo, 'cat-file', 'commit', commit).replace('signed', 'forged');
  const object = run('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: forged });
  assert.throws(() => signer.verifyCommitSignature(repo, object), (error) => error.code === 'SIGNATURE_INVALID');
});

test('ssh: an unreadable or malformed key is refused', { skip: skipSsh }, () => {
  const repo = sshRepo(keyA, path.join(temporary, 'missing.pub'));
  assert.throws(() => signer.signerFingerprint(repo), (error) => error.code === 'SIGNER_UNAVAILABLE');
  const garbage = path.join(temporary, 'garbage.pub');
  fs.writeFileSync(garbage, 'not a key\n');
  git(repo, 'config', 'user.signingkey', garbage);
  assert.throws(() => signer.signerFingerprint(repo), /not an SSH public key/);
  git(repo, 'config', '--unset', 'user.signingkey');
  assert.throws(() => signer.signerFingerprint(repo), /signer is unavailable/);
});

test('x509 and unknown formats are refused with a clear message', () => {
  for (const format of ['x509', 'X509', 'pgp2']) {
    const repo = makeRepo({ 'gpg.format': format, 'user.signingkey': 'ABCDEF' });
    assert.throws(() => signer.signerFingerprint(repo),
      (error) => error.code === 'SIGNER_UNSUPPORTED' && error.message.includes(`gpg.format=${format.toLowerCase()}`)
        && /use openpgp or ssh/.test(error.message));
    assert.throws(() => signer.verifyCommitSignature(repo, 'HEAD'), (error) => error.code === 'SIGNER_UNSUPPORTED');
  }
});

test('openpgp: unset and explicit gpg.format still use gpg fingerprints and gpg verification', () => {
  let gnupgHome;
  try { gnupgHome = fs.mkdtempSync(path.join('/tmp', 'csg-')); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; gnupgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csg-')); }
  fs.chmodSync(gnupgHome, 0o700);
  const env = { ...process.env, GNUPGHOME: gnupgHome };
  try {
    try {
      run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
        'Signer Test <signer@example.test>', 'ed25519', 'sign', '0'], { env });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const fingerprint = run('gpg', ['--batch', '--with-colons', '--list-secret-keys'], { env })
      .split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
    const repo = makeRepo({ 'user.signingkey': fingerprint });
    git(repo, 'commit', '-q', '-m', 'unsigned');
    run('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-S', '-m', 'signed'], { env });
    const commit = git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(signer.resolveSigner(repo, { env }), { format: 'openpgp', fingerprint, publicKey: null });
    const verified = signer.verifyCommitSignature(repo, commit, { env });
    assert.ok(['G', 'U'].includes(verified.code));
    assert.equal(verified.signer, fingerprint);
    git(repo, 'config', 'gpg.format', 'openpgp');
    assert.equal(signer.signerFingerprint(repo, { env }), fingerprint);
  } finally {
    spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env, stdio: 'ignore' });
    fs.rmSync(gnupgHome, { recursive: true, force: true });
  }
});

test('forced signing configuration keeps gpg.format and gpg.ssh.program from the environment', { skip: skipSsh }, () => {
  const repo = makeRepo();
  const base = {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gpg.format', GIT_CONFIG_VALUE_0: 'ssh',
    GIT_CONFIG_KEY_1: 'gpg.ssh.program', GIT_CONFIG_VALUE_1: '/opt/signer/op-ssh-sign',
  };
  const forced = signer.forcedSigningConfig(base);
  assert.equal(forced.GIT_CONFIG_COUNT, '4');
  const env = { ...base, ...forced };
  const read = (name) => run('git', ['-C', repo, 'config', '--get', name], { env });
  assert.equal(read('gpg.format'), 'ssh');
  assert.equal(read('gpg.ssh.program'), '/opt/signer/op-ssh-sign');
  assert.equal(read('commit.gpgsign'), 'true');
  assert.equal(read('merge.gpgSign'), 'true');
  assert.equal(signer.signingFormat(repo, env), 'ssh');
});

test('forced signing configuration starts at zero when the environment has none', () => {
  assert.deepEqual(signer.forcedSigningConfig({}), {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'merge.gpgSign', GIT_CONFIG_VALUE_1: 'true',
  });
});
