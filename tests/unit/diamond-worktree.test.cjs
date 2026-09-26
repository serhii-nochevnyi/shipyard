'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts');
const WORKTREE = path.join(SCRIPTS, 'ticket-worktree.sh');
const SCOPE_GATE = path.join(SCRIPTS, 'scope-gate.cjs');
const EPIC = 'epic/90-diamond';
const B = (n) => `ticket/T-90-0${n}-t`;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-diamond-wt-'));
const gitconfig = path.join(workspace, 'gitconfig');
fs.writeFileSync(gitconfig, '[user]\n\tname = Diamond Test\n\temail = diamond@example.test\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
for (const key of Object.keys(process.env)) {
  if (/^(?:SHIPYARD_|GSD_|GIT_)/.test(key)) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
try { process.env.GNUPGHOME = fs.mkdtempSync(path.join('/tmp', 'dgpg-')); }
catch { process.env.GNUPGHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dgpg-')); }
fs.chmodSync(process.env.GNUPGHOME, 0o700);

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const commitAll = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); };

const TICKETS = {
  'T-90-01': { phase: '90', repo: null, branch: B(1), depends_on: [], epic: EPIC, files: ['a.txt', 'shared.txt'] },
  'T-90-02': { phase: '90', branch: B(2), depends_on: [], epic: EPIC, files: ['b.txt'] },
  'T-90-03': { phase: '90', branch: B(3), depends_on: ['T-90-01', 'T-90-02'], primary_parent: 'T-90-01', epic: EPIC, files: ['c.txt'] },
};

let sequence = 0;
function project({ conflict = false } = {}) {
  const dir = path.join(workspace, `p${++sequence}`);
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', seed);
  write(seed, 'shared.txt', 'one\n');
  commitAll(seed, 'root');
  git(seed, 'checkout', '-qb', EPIC);
  write(seed, 'b.txt', 'b\n');
  if (conflict) write(seed, 'shared.txt', 'epic\n');
  commitAll(seed, 'T-90-02 lands');
  git(seed, 'checkout', '-qb', B(1), 'main');
  write(seed, 'a.txt', 'a\n');
  if (conflict) write(seed, 'shared.txt', 'primary\n');
  commitAll(seed, 'T-90-01');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main', EPIC, B(1));
  git(dir, 'clone', '-q', origin, clone);
  const graph = path.join(clone, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ epics: { 90: { branch: EPIC } }, tickets: TICKETS }));
  fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), '.planning/\n');
  return { dir, clone, graph, wtRoot: path.join(dir, 'wt') };
}

function create(p, ticket, branch, base) {
  return spawnSync('bash', [WORKTREE, 'create', ticket, branch, base], {
    cwd: p.clone, encoding: 'utf8', env: { ...process.env, SHIPYARD_WORKTREE_ROOT: p.wtRoot },
  });
}

function scopeGate(p, wt, ticket, base) {
  return spawnSync(process.execPath, [SCOPE_GATE, ticket, '--worktree', wt, '--base', base, '--graph', p.graph, '--json'], {
    cwd: p.dir, encoding: 'utf8',
  });
}

let signer = null;
function signerKey() {
  if (signer) return signer;
  try {
    execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
      'Diamond Test <diamond@example.test>', 'ed25519', 'sign', '0'], { stdio: 'ignore' });
    const keys = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], { encoding: 'utf8' });
    signer = keys.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9];
  } catch {
    signer = 'D1A40D00000000000000000000000000DEADBEEF';
  }
  return signer;
}

function finalize(p, wt, ticket, baseRef) {
  const { finalizeDeliveryCommit } = require(path.join(SCRIPTS, 'delivery-commit-finalizer.cjs'));
  git(wt, 'config', 'user.signingkey', signerKey());
  const previous = process.cwd();
  process.chdir(p.dir);
  try {
    finalizeDeliveryCommit({
      ticket, worktree: wt, expectedBranch: TICKETS[ticket].branch,
      expectedBase: git(wt, 'rev-parse', `${baseRef}^{commit}`), expectedHead: git(wt, 'rev-parse', 'HEAD'),
      expectedSigner: signerKey(), files_modified: TICKETS[ticket].files,
      ticketTitle: 'Diamond child work', ticketType: 'implementation',
    });
    return null;
  } catch (error) {
    return error.message;
  } finally {
    process.chdir(previous);
  }
}

suite('ticket-worktree.sh create — a diamond child is cut with every parent in its tree');

let diamond;
test('create prints only the path; the tree holds a.txt and b.txt and origin/<epic> is an ancestor', () => {
  diamond = project();
  const r = create(diamond, 'T-90-03', B(3), B(1));
  assert.equal(r.status, 0, r.stderr);
  const wt = r.stdout.trim();
  assert.equal(r.stdout, `${wt}\n`);
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
  assert.ok(fs.existsSync(path.join(wt, 'b.txt')));
  assert.equal(spawnSync('git', ['-C', wt, 'merge-base', '--is-ancestor', `origin/${EPIC}`, 'HEAD']).status, 0);
  assert.equal(git(wt, 'log', '-1', '--format=%s'), `Merge ${EPIC} into ${B(3)}`);
  assert.match(r.stderr, /base-merged epic\/90-diamond \([0-9a-f]{7}\) — non-primary parents T-90-02 are in this tree/);
  diamond.wt = wt;
});

test('a conflicting epic merge exits 13 naming shared.txt and leaves no worktree or branch', () => {
  const p = project({ conflict: true });
  const r = create(p, 'T-90-03', B(3), B(1));
  assert.equal(r.status, 13, r.stderr);
  assert.match(r.stderr, /shared\.txt/);
  assert.match(r.stderr, /T-90-02/);
  assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(p.wtRoot, 'T-90-03')));
  assert.equal(spawnSync('git', ['-C', p.clone, 'show-ref', '--verify', '--quiet', `refs/heads/${B(3)}`]).status, 1);
});

test('a non-diamond ticket is cut without a merge', () => {
  const p = project();
  const r = create(p, 'T-90-01', 'ticket/T-90-01-fresh', EPIC);
  assert.equal(r.status, 0, r.stderr);
  const wt = r.stdout.trim();
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(p.clone, 'rev-parse', `origin/${EPIC}`));
  assert.ok(!/base-merged/.test(r.stderr));
});

suite('scope-gate.cjs and the finalizer measure a diamond child against base ⊕ epic');

test('scope-gate passes on the declared c.txt and does not report b.txt', () => {
  write(diamond.wt, 'c.txt', 'c\n');
  commitAll(diamond.wt, 'child work');
  const r = scopeGate(diamond, diamond.wt, 'T-90-03', B(1));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.outside, []);
  assert.equal(out.changed, 1);
  assert.equal(out.diamond_epic, `origin/${EPIC}`);
});

test('scope-gate fails naming d.txt when the child also adds an undeclared d.txt', () => {
  write(diamond.wt, 'd.txt', 'd\n');
  commitAll(diamond.wt, 'undeclared');
  const r = scopeGate(diamond, diamond.wt, 'T-90-03', B(1));
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).outside, ['d.txt']);
});

test('the finalizer reports d.txt and not b.txt', () => {
  git(diamond.wt, 'reset', '-q', '--soft', 'HEAD~2');
  const message = finalize(diamond, diamond.wt, 'T-90-03', `origin/${B(1)}`);
  assert.ok(message, 'expected the finalizer to refuse');
  assert.match(message, /out-of-scope paths: d\.txt$/);
});

test('a conflicting diamond scope base makes both scripts refuse', () => {
  const p = project({ conflict: true });
  const wt = path.join(p.dir, 'manual');
  git(p.clone, 'worktree', 'add', '-q', '-b', B(3), wt, `origin/${B(1)}`);
  spawnSync('git', ['-C', wt, 'merge', '--no-edit', `origin/${EPIC}`]);
  write(wt, 'shared.txt', 'resolved\n');
  commitAll(wt, 'resolved by hand');
  write(wt, 'c.txt', 'c\n');
  const gate = scopeGate(p, wt, 'T-90-03', B(1));
  assert.equal(gate.status, 2, gate.stderr + gate.stdout);
  assert.match(gate.stderr, /diamond scope base: merging origin\/epic\/90-diamond into origin\/ticket\/T-90-01-t/);
  const message = finalize(p, wt, 'T-90-03', `origin/${B(1)}`);
  assert.match(String(message), /diamond scope base: merging origin\/epic\/90-diamond/);
});

done();
