'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lock-liveness-')));
const originalHomedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(home, { recursive: true, force: true }); });

const { suite, test: runTest, done, assert } = require('./assert-harness.cjs');
const lock = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
const ROLE_ARTIFACT = path.join(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const roleArtifact = require(ROLE_ARTIFACT);

let pendingCase = Promise.resolve();
function test(name, callback) {
  runTest(name, () => {
    const current = pendingCase.then(callback);
    pendingCase = current.catch(() => {});
    return current;
  });
}

function loadSeam(file) {
  const Module = require('node:module');
  const fs = require('node:fs');
  const path = require('node:path');
  const seamModule = new Module(file, module);
  seamModule.filename = file;
  seamModule.paths = Module._nodeModulePaths(path.dirname(file));
  const source = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '\n')
    + '\nmodule.exports = Object.freeze({ ...module.exports, __seam: '
    + '{ authorityState, withArchiveAuthorityLock, writeArchiveCatalogue } });\n';
  seamModule._compile(source, file);
  return seamModule.exports;
}

const childFile = path.join(home, 'lock-child.cjs');
fs.writeFileSync(childFile, `'use strict';
const os = require('node:os');
os.homedir = () => process.env.TEST_HOME;
const loadSeam = ${loadSeam.toString()};
const seam = loadSeam(process.env.ROLE_ARTIFACT).__seam;
const started = Date.now();
const report = value => process.stdout.write(JSON.stringify({ ...value, elapsed: Date.now() - started }) + '\\n');
try { report({ ok: true, value: seam.withArchiveAuthorityLock(process.argv[2], () => 'ran') }); }
catch (error) { report({ ok: false, code: error.code, message: error.message }); }
`);

function runChild(worktree) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile, worktree], {
      env: { ...process.env, TEST_HOME: home, ROLE_ARTIFACT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); }
      catch { reject(new Error('child exited ' + code + ': ' + stdout + stderr)); }
    });
  });
}

function fixture(name) {
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lock-' + name + '-')));
  const store = path.join(worktree, '.planning/graph/dispatches.json');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  roleArtifact.trustedBookkeepingMutation(worktree, () => fs.writeFileSync(store, '{"original":1}'));
  const directory = roleArtifact.archiveAuthorityDirectory(worktree);
  return {
    worktree, directory,
    catalogue: path.join(directory, 'catalogue.json'),
    lockPath: path.join(directory, 'catalogue.lock'),
    clean() { fs.rmSync(worktree, { recursive: true, force: true }); },
  };
}

function sleeper() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("up\\n");setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

function assertUntouched(value, before) {
  assert.deepEqual(fs.readFileSync(value.catalogue), before.catalogue);
  assert.deepEqual(fs.readdirSync(value.directory).sort(), before.names);
}

function snapshot(value) {
  return { catalogue: fs.readFileSync(value.catalogue), names: fs.readdirSync(value.directory).sort() };
}

suite('archive catalogue lock — bounded wait and named refusal');

test('a fresh live owner that releases within the bounded wait is waited for', async () => {
  const value = fixture('wait');
  const held = lock.acquire(value.directory, 'catalogue', { waitMs: 0, label: 'holder-session' });
  try {
    assert(held);
    const release = setTimeout(() => held.release(), 1500);
    const result = await runChild(value.worktree);
    clearTimeout(release);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value, 'ran');
    assert.ok(result.elapsed >= 800, 'the second session waited for the holder: ' + result.elapsed + ' ms');
    assert.ok(result.elapsed < 15000, 'the wait stayed bounded: ' + result.elapsed + ' ms');
    assert.equal(fs.existsSync(value.lockPath), false);
  } finally { held?.release(); value.clean(); }
});

test('a fresh live owner that never releases ends in a named refusal after the bounded wait', async () => {
  const value = fixture('busy');
  const held = lock.acquire(value.directory, 'catalogue', { waitMs: 0, label: 'holder-session' });
  try {
    assert(held);
    const ownerFile = path.join(held.path, 'owner.json');
    const ownerBytes = fs.readFileSync(ownerFile);
    const before = snapshot(value);
    const result = await runChild(value.worktree);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'ARCHIVE_AUTHORITY_BUSY');
    assert.ok(result.elapsed >= 4000, 'the refusal came after the bounded wait: ' + result.elapsed + ' ms');
    assert.ok(result.elapsed < 20000, 'the refusal stayed bounded: ' + result.elapsed + ' ms');
    assert.match(result.message, /holder-session/);
    assert.ok(result.message.includes('pid ' + process.pid), result.message);
    assert.ok(result.message.includes(JSON.parse(ownerBytes).at), result.message);
    assert.deepEqual(fs.readFileSync(ownerFile), ownerBytes);
    assert.deepEqual(fs.readdirSync(held.path), ['owner.json']);
    assertUntouched(value, before);
  } finally { held?.release(); value.clean(); }
});

test('a live pid holding an owner record older than the lock TTL is refused at once without takeover', async () => {
  const value = fixture('reused');
  const other = await sleeper();
  try {
    fs.mkdirSync(value.lockPath, { mode: 0o700 });
    const ownerFile = path.join(value.lockPath, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: other.pid, label: 'reused-pid-owner',
      at: '2000-01-01T00:00:00.000Z', token: 'old-token' }) + '\n');
    const ownerBytes = fs.readFileSync(ownerFile);
    const before = snapshot(value);
    const result = await runChild(value.worktree);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'ARCHIVE_AUTHORITY_BUSY');
    assert.ok(result.elapsed < 3500, 'the refusal was immediate, not a wait: ' + result.elapsed + ' ms');
    assert.match(result.message, /older than the lock TTL/);
    assert.match(result.message, /reused/);
    assert.ok(result.message.includes('pid ' + other.pid), result.message);
    assert.deepEqual(fs.readFileSync(ownerFile), ownerBytes);
    assertUntouched(value, before);
  } finally { other.kill('SIGKILL'); value.clean(); }
});

test('measurement: lock.cjs alone takes over a live pid whose record is older than the TTL', async () => {
  const value = fixture('measure');
  const other = await sleeper();
  try {
    fs.mkdirSync(value.lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(value.lockPath, 'owner.json'), JSON.stringify({ pid: other.pid,
      label: 'reused-pid-owner', at: '2000-01-01T00:00:00.000Z', token: 'old-token' }) + '\n');
    const taken = lock.acquire(value.directory, 'catalogue', { waitMs: 0, label: 'measure' });
    assert(taken, 'the lock primitive trusts the TTL and ignores pid liveness');
    taken.release();
  } finally { other.kill('SIGKILL'); value.clean(); }
});

test('a dead pid with a stale record is taken over exactly as before', async () => {
  const value = fixture('dead');
  try {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.mkdirSync(value.lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(value.lockPath, 'owner.json'), JSON.stringify({ pid: dead,
      label: 'crashed-owner', at: '2000-01-01T00:00:00.000Z', token: 'dead-token' }) + '\n');
    const result = await runChild(value.worktree);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value, 'ran');
    assert.ok(result.elapsed < 8000, 'takeover did not wait: ' + result.elapsed + ' ms');
    assert.equal(fs.existsSync(value.lockPath), false);
  } finally { value.clean(); }
});

test('a lock path that is not a physical directory is refused with its cause and changes nothing', async () => {
  const value = fixture('alias');
  try {
    fs.writeFileSync(value.lockPath, 'not a directory');
    const before = snapshot(value);
    const result = await runChild(value.worktree);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'ARCHIVE_AUTHORITY_BUSY');
    assert.match(result.message, /not a physical directory/);
    assert.match(result.message, /remove/);
    assertUntouched(value, before);
  } finally { value.clean(); }
});

test('a holder that releases between the existence check and the lock inspection is not a failure', async () => {
  const value = fixture('released');
  const original = fs.lstatSync;
  let raced = 0;
  try {
    fs.mkdirSync(value.lockPath);
    fs.lstatSync = function (target, ...rest) {
      if (target === value.lockPath && raced === 0) { raced += 1; fs.rmdirSync(value.lockPath); }
      return original.call(this, target, ...rest);
    };
    const seam = loadSeam(ROLE_ARTIFACT).__seam;
    assert.equal(seam.withArchiveAuthorityLock(value.worktree, () => 'ran'), 'ran');
    assert.equal(raced, 1, 'the release raced the inspection');
    assert.equal(fs.existsSync(value.lockPath), false);
  } finally { fs.lstatSync = original; value.clean(); }
});

done();
