'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const ARM = path.join(SCRIPTS, 'stop-gate-arm.cjs');
const armer = require(ARM);

const tmp = (tag) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `shipyard-arm-${tag}-`)));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const baseEnv = () => { const env = { ...process.env }; delete env.CLAUDE_CODE_SESSION_ID; return env; };
const cli = (cwd, ...args) => spawnSync('node', [ARM, ...args], { cwd, encoding: 'utf8', env: baseEnv() });
const cliWithSession = (cwd, sessionId, ...args) => spawnSync('node', [ARM, ...args],
  { cwd, encoding: 'utf8', env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: sessionId } });
const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};

suite('stop-gate-arm — session id validation');

test('an unsubstituted ${CLAUDE_SESSION_ID} literal exits 1 without writing', () => {
  const dir = tmp('literal');
  const r = cli(dir, 'arm', '--session-id', '${CLAUDE_SESSION_ID}');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(/NOT armed/.test(r.stderr), 'a plain message');
  assert.deepStrictEqual(listAll(dir), []);
});

test('a traversal id exits 1 without writing', () => {
  const dir = tmp('traversal');
  const r = cli(dir, 'arm', '--session-id', '../x');
  assert.equal(r.status, 1);
  assert.deepStrictEqual(listAll(dir), []);
});

test('missing or short ids are refused', () => {
  const dir = tmp('short');
  assert.equal(cli(dir, 'arm').status, 1);
  assert.equal(cli(dir, 'arm', '--session-id', 'abc').status, 1);
  assert.equal(cli(dir, 'arm', '--session-id', 'x'.repeat(129)).status, 1);
  assert.throws(() => armer.markerPath(dir, '../escape-attempt'));
  assert.equal(armer.isArmed(dir, '../escape-attempt'), false);
});

test('without --session-id the session id comes from CLAUDE_CODE_SESSION_ID', () => {
  const dir = tmp('env-session');
  const id = '7bcbbf57-9cd4-4d9b-b17a-6064eae1b7c1';
  const r = cliWithSession(dir, id, 'arm');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(armer.isArmed(dir, id), true);
});

test('an explicit --session-id wins over CLAUDE_CODE_SESSION_ID', () => {
  const dir = tmp('explicit-session');
  const r = cliWithSession(dir, 'env-session-00000001', 'arm', '--session-id', 'flag-session-0000001');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(armer.isArmed(dir, 'flag-session-0000001'), true);
  assert.equal(armer.isArmed(dir, 'env-session-00000001'), false);
});

test('an invalid CLAUDE_CODE_SESSION_ID is refused without writing', () => {
  const dir = tmp('env-invalid');
  const r = cliWithSession(dir, '../escape', 'arm');
  assert.equal(r.status, 1);
  assert.ok(/NOT armed/.test(r.stderr));
  assert.deepStrictEqual(listAll(dir), []);
});

suite('stop-gate-arm — marker location and body');

test('inside a git repo the marker lives under the git common dir, shared by worktrees', () => {
  const root = tmp('git');
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', path.join(root, 'wt'), '-b', 'wt');
  const r = cli(main, 'arm', '--session-id', 'git-session-0001');
  assert.equal(r.status, 0, r.stderr);
  const expected = path.join(main, '.git', 'shipyard', 'stop-gate-armed', 'git-session-0001.json');
  assert.equal(armer.markerPath(main, 'git-session-0001'), expected);
  assert.equal(armer.markerPath(path.join(root, 'wt'), 'git-session-0001'), expected);
  const body = JSON.parse(fs.readFileSync(expected, 'utf8'));
  assert.equal(body.session_id, 'git-session-0001');
  assert.equal(body.cwd, main);
  assert.ok(!Number.isNaN(Date.parse(body.armed_at)));
  assert.equal(armer.isArmed(path.join(root, 'wt'), 'git-session-0001'), true);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(expected)), ['git-session-0001.json'],
    'the atomic write leaves no temp file');
});

test('outside git the marker falls back to .planning/graph/stop-gate-armed', () => {
  const dir = tmp('nogit');
  assert.equal(cli(dir, 'arm', '--session-id', 'plain-session-01').status, 0);
  const file = path.join(dir, '.planning', 'graph', 'stop-gate-armed', 'plain-session-01.json');
  assert.equal(armer.markerPath(dir, 'plain-session-01'), file);
  assert.equal(armer.isArmed(dir, 'plain-session-01'), true);
});

suite('stop-gate-arm — isArmed is false on anything but a matching marker');

test('foreign, malformed and unreadable markers are not armed', () => {
  const dir = tmp('bad');
  armer.arm(dir, 'someone-else-01');
  assert.equal(armer.isArmed(dir, 'this-session-01'), false, 'no marker');
  const mismatch = armer.markerPath(dir, 'mismatch-session');
  fs.writeFileSync(mismatch, JSON.stringify({ session_id: 'someone-else-01' }));
  assert.equal(armer.isArmed(dir, 'mismatch-session'), false, 'foreign body');
  fs.writeFileSync(armer.markerPath(dir, 'garbage-session'), '{not json');
  assert.equal(armer.isArmed(dir, 'garbage-session'), false, 'malformed');
  fs.writeFileSync(armer.markerPath(dir, 'null-session-01'), 'null');
  assert.equal(armer.isArmed(dir, 'null-session-01'), false, 'null body');
  fs.mkdirSync(armer.markerPath(dir, 'dir-session-001'));
  assert.equal(armer.isArmed(dir, 'dir-session-001'), false, 'unreadable');
});

suite('stop-gate-arm — ships with the stop bundle');

test('stop-gate.cjs requires the arm module by a relative path', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'stop-gate.cjs'), 'utf8');
  assert.ok(/require\('\.\/stop-gate-arm\.cjs'\)/.test(src));
});

test('stop-gate-arm.cjs requires only built-ins and relative modules', () => {
  const src = fs.readFileSync(ARM, 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(reqs.length > 0);
  for (const r of reqs) {
    assert.ok(r.startsWith('./') || require('module').builtinModules.includes(r), `unexpected require ${r}`);
  }
});

done();
