'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subject-contract-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function repo(name, remote) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

const D = 'd'.repeat(64), H = 'a'.repeat(40), B = 'b'.repeat(40);
const FIELDS = {
  'planning-input': repository => ({ phase: 50, input: 'INV-017', repository }),
  'decomposition-seal': repository => ({ phase: 50, repository, adr: D }),
  integrator: repository => ({ phase: '50-make-launch', repository, tickets: D }),
  'architecture-review': repository => ({ phase: '50-make-launch', repository, tickets: D, pr: 9, head: H, base: B }),
};

test('identity is equal from the root and from a linked worktree', () => {
  const root = repo('plain');
  const linked = path.join(scratch, 'plain-linked');
  git(root, 'worktree', 'add', '-q', linked, '-b', 'linked');
  assert.equal(target.repositoryIdentity(linked), target.repositoryIdentity(root));
  assert.equal(target.repositoryIdentity(root), path.join(root, '.git'));
});

test('identity works for a path with a space and a non-ASCII path', () => {
  for (const name of ['with space', 'репо']) {
    const root = repo(name);
    assert.equal(target.repositoryIdentity(root), path.join(root, '.git'));
  }
});

test('identity refuses a semicolon, a tab and a failing git', () => {
  for (const name of ['semi;colon', 'tab\there']) {
    const root = repo(name);
    assert.throws(() => target.repositoryIdentity(root), { code: 'REPOSITORY_IDENTITY_INVALID' });
  }
  assert.throws(() => target.repositoryIdentity(path.join(scratch, 'absent')), { code: 'REPOSITORY_IDENTITY_INVALID' });
});

test('identity makes its git call through the injected runner only', () => {
  const root = repo('injected');
  const calls = [];
  const value = target.repositoryIdentity(root, { execFileSync: (...args) => { calls.push(args); return '.git\n'; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-C', root, 'rev-parse', '--git-common-dir']);
  assert.equal(value, path.join(root, '.git'));
});

test('every family round-trips every repository form', () => {
  const values = ['/Volumes/KINGSTON/claude-shipyard/.git', '/Volumes/My Disk/shipyard/.git', '/Users/сергій/репо/.git', 'serhii-nochevnyi/shipyard'];
  for (const [name, make] of Object.entries(FIELDS)) {
    for (const value of values) {
      const fields = make(value);
      const parsed = target.parseSubject(name, target.buildSubject(name, fields));
      assert.ok(parsed, `${name} ${value}`);
      for (const [key, expected] of Object.entries(fields)) assert.equal(parsed[key], String(expected));
    }
  }
});

test('every family rejects a semicolon or control character in builder and parser', () => {
  for (const [name, make] of Object.entries(FIELDS)) {
    for (const bad of ['/a;b/.git', '/a\tb/.git', '/a\nb/.git', '']) {
      assert.throws(() => target.buildSubject(name, make(bad)), /repository/);
    }
    const good = target.buildSubject(name, make('/ok/.git'));
    for (const bad of ['/a;b/.git', '/a\tb/.git']) {
      assert.equal(target.parseSubject(name, good.replace('/ok/.git', bad)), null);
    }
  }
  assert.throws(() => target.buildSubject('nope', {}), /unknown subject family/);
});

test('PHASE_SUBJECT accepts a space and a non-ASCII character and rejects a semicolon', () => {
  const make = repository => `phase=50-x;repository=${repository};tickets=${D};pr=1;head=${H};base=${B}`;
  assert.ok(target.PHASE_SUBJECT.test(make('/Volumes/My Disk/репо/.git')));
  assert.ok(!target.PHASE_SUBJECT.test(make('/a;b/.git')));
});

test('accepted values list the identity first and the legacy owner/repo second', () => {
  const withRemote = repo('remote', 'git@github.com:Serhii-Nochevnyi/Shipyard.git');
  assert.deepEqual(target.acceptedRepositoryValues(withRemote), [path.join(withRemote, '.git'), 'serhii-nochevnyi/shipyard']);
  const without = repo('no-remote');
  assert.deepEqual(target.acceptedRepositoryValues(without), [path.join(without, '.git')]);
});
