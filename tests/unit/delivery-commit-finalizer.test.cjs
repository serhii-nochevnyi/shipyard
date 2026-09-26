'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { before, after, test } = require('node:test');
const os = require('node:os');
const { finalizeDeliveryCommit, scopedTree } = require('../../plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs');

let temporary;
let signer;
let sequence = 0;
let previousEnv;

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function git(repo, ...args) {
  return command('git', ['-C', repo, ...args]);
}

function writeShipyardManifest(repo) {
  const dir = path.join(repo, 'plugins', 'delivery-pipeline', '.claude-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'shipyard' }));
}

function makeRepo(fixtureOptions = {}) {
  const repo = path.join(temporary, `repo-${++sequence}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'ticket/T-38-03');
  git(repo, 'config', 'user.name', 'Delivery Test');
  git(repo, 'config', 'user.email', 'delivery@example.test');
  git(repo, 'config', 'user.signingkey', signer);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'src', 'second.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'base\n');
  if (fixtureOptions.exempt !== false) writeShipyardManifest(repo);
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const options = {
    ticket: 'T-38-03',
    worktree: repo,
    expectedBranch: 'ticket/T-38-03',
    expectedBase: head,
    expectedHead: head,
    expectedSigner: signer,
    files_modified: ['src/*.txt'],
    ...(fixtureOptions.ticketTitle !== undefined ? { ticketTitle: fixtureOptions.ticketTitle } : {}),
    ...(fixtureOptions.ticketType !== undefined ? { ticketType: fixtureOptions.ticketType } : {}),
  };
  return { repo, head, options };
}

function indexBytes(repo) {
  return fs.readFileSync(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index')));
}

before(() => {
  try { temporary = fs.mkdtempSync(path.join('/tmp', 'dcf-')); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dcf-')); }
  const gnupgHome = path.join(temporary, 'gnupg');
  fs.mkdirSync(gnupgHome, { mode: 0o700 });
  previousEnv = {
    GNUPGHOME: process.env.GNUPGHOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GNUPGHOME = gnupgHome;
  process.env.GIT_CONFIG_GLOBAL = path.join(temporary, 'empty-gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  command('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
    'Delivery Test <delivery@example.test>', 'ed25519', 'sign', '0']);
  const keys = command('gpg', ['--batch', '--with-colons', '--list-secret-keys']);
  signer = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
});

after(() => {
  if (previousEnv) {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

test('creates a verified signed commit and refreshes the ordinary index to a clean tree', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  git(repo, 'add', '--', 'src/owned.txt');
  fs.writeFileSync(path.join(repo, 'src', 'second.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'src', 'new.txt'), 'new\n');
  const beforeIndex = indexBytes(repo);

  const result = finalizeDeliveryCommit(options);

  assert.equal(result.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(result.previousHead, head);
  assert.equal(result.signer, signer);
  assert.deepEqual(result.changed.sort(), ['src/new.txt', 'src/owned.txt', 'src/second.txt']);
  assert.equal(git(repo, 'rev-parse', 'HEAD^'), head);
  assert.equal(git(repo, 'show', '-s', '--format=%G?%x00%GF', 'HEAD'), `G\0${signer}`);
  git(repo, 'verify-commit', 'HEAD');
  assert.notDeepEqual(indexBytes(repo), beforeIndex);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'show', 'HEAD:src/new.txt'), 'new');
  assert.equal(git(repo, 'show', 'HEAD:outside.txt'), 'base');
});

test('rejects stale branch or HEAD before changing the branch', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedBranch: 'ticket/other' }), /branch differs/);
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedHead: '0'.repeat(head.length) }), /HEAD differs/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('rejects an expected base that is not an ancestor of HEAD', () => {
  const { repo, head, options } = makeRepo();
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const unrelated = command('git', ['-C', repo, 'commit-tree', tree], { input: 'unrelated\n' });
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedBase: unrelated }), /not an ancestor/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('rejects out-of-scope worktree and index edits', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'outside\n');
  git(repo, 'add', '--', 'outside.txt');
  const beforeIndex = indexBytes(repo);
  assert.throws(() => finalizeDeliveryCommit(options), /out-of-scope paths: outside.txt/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(indexBytes(repo), beforeIndex);
});

test('rejects undeclared untracked paths and invalid declarations', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'outside\n');
  assert.throws(() => finalizeDeliveryCommit(options), /out-of-scope paths: untracked.txt/);
  assert.throws(() => finalizeDeliveryCommit({ ...options, files_modified: ['../outside.txt'] }), /repository-relative/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('rejects prior out-of-scope commits since the expected base', () => {
  const { repo, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'committed outside\n');
  git(repo, 'add', '--', 'outside.txt');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'outside');
  const head = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedHead: head }), /out-of-scope paths: outside.txt/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('fails closed when signer configuration or signer verification is missing', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  git(repo, 'config', '--unset', 'user.signingkey');
  assert.throws(() => finalizeDeliveryCommit(options), /signer|git config failed/);
  git(repo, 'config', 'user.signingkey', signer);
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedSigner: 'wrong signer' }), /does not match expectedSigner/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('rejects a configured key that cannot sign', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  git(repo, 'config', 'user.signingkey', '0000000000000000');
  assert.throws(() => finalizeDeliveryCommit(options), /git commit-tree failed/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('commits an in-scope deletion and refreshes the ordinary index', () => {
  const { repo, options } = makeRepo();
  fs.rmSync(path.join(repo, 'src', 'second.txt'));
  const beforeIndex = indexBytes(repo);
  const result = finalizeDeliveryCommit(options);
  assert.deepEqual(result.changed, ['src/second.txt']);
  assert.equal(git(repo, 'ls-tree', '--name-only', 'HEAD', 'src/second.txt'), '');
  assert.notDeepEqual(indexBytes(repo), beforeIndex);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('rejects an index-only edit that the private index cannot faithfully stage', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'index only\n');
  git(repo, 'add', '--', 'src/owned.txt');
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'src', 'second.txt'), 'worktree\n');
  const beforeIndex = indexBytes(repo);
  assert.throws(() => finalizeDeliveryCommit(options), /could not all be staged/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(indexBytes(repo), beforeIndex);
});

test('excludes only the two fixed regular untracked scratch documents', () => {
  const { repo, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, '.shipyard-pr-body.md'), 'body\n');
  fs.writeFileSync(path.join(repo, '.shipyard-evidence.md'), 'evidence\n');
  const result = finalizeDeliveryCommit(options);
  assert.deepEqual(result.changed, ['src/owned.txt']);
  assert.equal(git(repo, 'ls-tree', '--name-only', 'HEAD', '.shipyard-pr-body.md', '.shipyard-evidence.md'), '');
  assert.equal(git(repo, 'status', '--porcelain'), '?? .shipyard-evidence.md\n?? .shipyard-pr-body.md');
});

test('rejects a symlinked scratch document and other untracked host artifacts', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.symlinkSync('outside.txt', path.join(repo, '.shipyard-pr-body.md'));
  assert.throws(() => finalizeDeliveryCommit(options), /scratch document must be a regular non-symlink file/);
  fs.rmSync(path.join(repo, '.shipyard-pr-body.md'));
  fs.writeFileSync(path.join(repo, 'recorder.json'), '{}\n');
  assert.throws(() => finalizeDeliveryCommit(options), /out-of-scope paths: recorder.json/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('rejects a scratch directory and a tracked scratch edit outside scope', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.mkdirSync(path.join(repo, '.shipyard-evidence.md'));
  assert.throws(() => finalizeDeliveryCommit(options), /scratch document must be a regular non-symlink file/);
  fs.rmSync(path.join(repo, '.shipyard-evidence.md'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.shipyard-evidence.md'), 'tracked\n');
  git(repo, 'add', '--', '.shipyard-evidence.md');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'track scratch');
  const trackedHead = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, '.shipyard-evidence.md'), 'edited\n');
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedHead: trackedHead, expectedBase: trackedHead }), /out-of-scope paths: .shipyard-evidence.md/);
  assert.notEqual(trackedHead, head);
});

test('refuses an existing index lock before moving the branch', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  const beforeIndex = indexBytes(repo);
  const lock = path.resolve(repo, `${git(repo, 'rev-parse', '--git-path', 'index')}.lock`);
  fs.writeFileSync(lock, 'busy');
  assert.throws(() => finalizeDeliveryCommit(options), /EEXIST/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(indexBytes(repo), beforeIndex);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'busy');
});

test('rejects an ordinary index change made while the host signer runs', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'src', 'second.txt'), 'changed\n');
  const wrapper = path.join(temporary, `signer-${sequence}.cjs`);
  const gpgPath = command('which', ['gpg']);
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process');",
    `const env = { ...process.env }; delete env.GIT_INDEX_FILE;`,
    `const staged = spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'add', '--', 'src/second.txt'], { env });`,
    'if (staged.status !== 0) process.exit(90);',
    `const signed = spawnSync(${JSON.stringify(gpgPath)}, process.argv.slice(2), { env: process.env, stdio: 'inherit' });`,
    'process.exit(signed.status === null ? 91 : signed.status);',
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  git(repo, 'config', 'gpg.program', wrapper);
  assert.throws(() => finalizeDeliveryCommit(options), /ordinary Git index changed during finalization/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'src/second.txt');
});

test('rejects a partially staged file before replacing the ordinary index', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'staged version\n');
  git(repo, 'add', '--', 'src/owned.txt');
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'worktree version\n');
  const beforeIndex = indexBytes(repo);
  assert.throws(() => finalizeDeliveryCommit(options), /staged index content differs from worktree content/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(indexBytes(repo), beforeIndex);
});

test('exposes the exact scoped tree it signs and refuses a different expected tree', () => {
  const { repo, head, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  const scoped = scopedTree(options);
  assert.equal(scoped.head, head);
  assert.deepEqual([...scoped.changed], ['src/owned.txt']);
  assert.throws(() => finalizeDeliveryCommit({ ...options, expectedTree: '0'.repeat(40) }), /scoped tree differs/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  const result = finalizeDeliveryCommit({ ...options, expectedTree: scoped.tree });
  assert.equal(result.tree, scoped.tree);
  assert.equal(git(repo, 'rev-parse', 'HEAD^{tree}'), scoped.tree);
});

test('scoped tree refuses out-of-scope changes and tracks a changed worktree', () => {
  const { repo, options } = makeRepo();
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'one\n');
  const first = scopedTree(options).tree;
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'two\n');
  assert.notEqual(scopedTree(options).tree, first);
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'x\n');
  assert.throws(() => scopedTree(options), /out-of-scope paths/);
});

test('an exempt project keeps the legacy ticket-id subject regardless of a supplied title', () => {
  const { repo, options } = makeRepo({ exempt: true, ticketTitle: 'This title must be ignored' });
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  const result = finalizeDeliveryCommit(options);
  assert.equal(git(repo, 'log', '-1', '--format=%s', result.commit), '(T-38-03): finalize scoped changes');
});

test('a target project finalizes a conventional, id-free commit subject', () => {
  const { repo, options } = makeRepo({ exempt: false, ticketTitle: 'Fix the flaky retry loop', ticketType: 'bugfix' });
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  const result = finalizeDeliveryCommit(options);
  assert.equal(git(repo, 'log', '-1', '--format=%s', result.commit), 'fix: fix the flaky retry loop');
});

test('a target project without a ticket title refuses before touching the branch or signer', () => {
  const { repo, head, options } = makeRepo({ exempt: false });
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  assert.throws(() => finalizeDeliveryCommit(options), /ticketTitle is required/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('a target project refuses a ticket title that leaks the ticket id into the subject', () => {
  const { repo, head, options } = makeRepo({ exempt: false, ticketTitle: 'Handle the T-38-03 edge case' });
  fs.writeFileSync(path.join(repo, 'src', 'owned.txt'), 'changed\n');
  assert.throws(() => finalizeDeliveryCommit(options), /finalized commit subject failed pr-hygiene/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});
