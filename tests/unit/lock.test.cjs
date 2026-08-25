'use strict';

// The lock exists because the PR sentinel writes the same state files as the main
// loop. Its failure modes are the expensive kind — a torn delivery-state.json, or
// a dead session wedging every later run — so both are pinned here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const LOCK = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'lock.cjs');
const { withLock, acquire, writeAtomic, OWNERLESS_GRACE_MS, DEFAULT_TTL_MS } = require(LOCK);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lock-'));

suite('lock — mutual exclusion');

test('a second acquire while held returns null instead of proceeding', () => {
  const held = acquire(tmp, 'state', { label: 'first' });
  assert.ok(held, 'the first acquire must succeed');
  try {
    const second = acquire(tmp, 'state', { waitMs: 200, label: 'second' });
    assert.strictEqual(second, null, 'a held lock must not be handed out twice');
  } finally {
    held.release();
  }
  const after = acquire(tmp, 'state', { waitMs: 200 });
  assert.ok(after, 'the lock must be free once released');
  after.release();
});

test('withLock releases even when the body throws', () => {
  assert.throws(() => withLock(tmp, 'state', () => { throw new Error('boom'); }));
  const h = acquire(tmp, 'state', { waitMs: 200 });
  assert.ok(h, 'a thrown body must not leak the lock');
  h.release();
});

test('withLock on a held lock is an error, never a silent bypass', () => {
  const held = acquire(tmp, 'state', { label: 'holder' });
  try {
    assert.throws(
      () => withLock(tmp, 'state', () => 'must not run', { waitMs: 150 }),
      /could not acquire the "state" lock/
    );
  } finally {
    held.release();
  }
});

test('a stale lock is taken over — a killed session must not wedge the next run', () => {
  const stale = path.join(tmp, 'stale.lock');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'owner.json'), JSON.stringify({
    pid: 999999, label: 'dead run', at: new Date(Date.now() - 10 * 60_000).toISOString(),
  }));
  const h = acquire(tmp, 'stale', { ttlMs: 60_000, waitMs: 500 });
  assert.ok(h, 'a lock older than the TTL must be taken over');
  h.release();
});

suite('lock — the owner-less window (mkdir has happened, owner.json has not)');

// Every live acquire passes through a window in which its lock directory exists
// and its owner.json does not. Judging that state stale broke LIVE locks:
//
//   P1: mkdirSync(lockPath) succeeds        <- holds the lock
//       (descheduled before writeFileSync)
//   P2: mkdirSync -> EEXIST; no owner.json yet; age unknown -> "stale"
//       breakLock(P1's live lock); mkdirSync succeeds
//   P1: resumes and writes owner.json into P2's lock
//
// Both then believe they hold it. The states are built directly on disk here:
// winning a real race is scheduling-dependent, and a flaky test in the suite
// every executor runs is worse than no test.

test('a lock directory created just now with no owner.json is HELD, not broken', () => {
  const fresh = path.join(tmp, 'fresh.lock');
  fs.mkdirSync(fresh);                        // exactly P1's state, mid-window
  const second = acquire(tmp, 'fresh', { waitMs: 250 });
  assert.strictEqual(second, null, 'a just-created owner-less lock must not be handed out');
  assert.ok(fs.existsSync(fresh), 'and it must not be broken out from under its holder');
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('past the grace an owner-less lock is taken over — a killed session must not wedge the next run', () => {
  const orphan = path.join(tmp, 'orphan.lock');
  fs.mkdirSync(orphan);
  // Back-date the directory well beyond any sane grace. Numeric utimes arguments
  // are SECONDS since the epoch; Date objects keep the unit honest.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(orphan, past, past);
  const h = acquire(tmp, 'orphan', { waitMs: 500 });
  assert.ok(h, 'an acquire that died before writing its owner must not be permanent');
  h.release();
});

test('an unparseable owner timestamp is still taken over at once, grace or no grace', () => {
  const bad = path.join(tmp, 'badstamp.lock');
  fs.mkdirSync(bad);                          // brand new: inside the grace
  fs.writeFileSync(path.join(bad, 'owner.json'), JSON.stringify({ pid: 999999, label: 'x', at: 'not-a-date' }));
  const h = acquire(tmp, 'badstamp', { waitMs: 250 });
  assert.ok(h, 'a lock that names an age nobody can read is unchanged: stale on sight');
  h.release();
});

test('the grace covers the mkdir-to-write window without approaching the TTL', () => {
  assert.ok(OWNERLESS_GRACE_MS >= 2_000,
    'it must clear the 1-second mtime granularity some filesystems still report');
  assert.ok(OWNERLESS_GRACE_MS < DEFAULT_TTL_MS / 10,
    'and stay far below the TTL, so a dead session is still taken over promptly');
});

suite('lock — cross-process (the actual scenario: sentinel + main loop)');

test('another process cannot enter the section while we hold it', () => {
  const held = acquire(tmp, 'xproc', { label: 'main loop' });
  try {
    const r = spawnSync(process.execPath, ['-e', `
      const { acquire } = require(${JSON.stringify(LOCK)});
      const h = acquire(${JSON.stringify(tmp)}, 'xproc', { waitMs: 300 });
      process.stdout.write(h ? 'GOT' : 'BLOCKED');
    `], { encoding: 'utf8' });
    assert.strictEqual(r.stdout, 'BLOCKED');
  } finally {
    held.release();
  }
});

test('lock.cjs run exits 75 when the lock is busy (the shell scripts can retry)', () => {
  const held = acquire(tmp, 'cli', { label: 'holder' });
  try {
    const marker = path.join(tmp, 'cli-ran');
    const r = spawnSync(
      process.execPath,
      [LOCK, 'run', tmp, 'cli', '--', 'touch', marker],
      { encoding: 'utf8', env: { ...process.env, SHIPYARD_LOCK_WAIT_MS: '150' } }
    );
    assert.strictEqual(r.status, 75, 'a busy lock must exit EX_TEMPFAIL, not run the command');
    assert.ok(!fs.existsSync(marker), 'the command must NOT run while the lock is held');
  } finally {
    held.release();
  }
});

suite('writeAtomic — a reader never sees half a state file');

test('the replacement is atomic and leaves no temp file behind', () => {
  const target = path.join(tmp, 'delivery-state.json');
  writeAtomic(target, '{"a":1}\n');
  writeAtomic(target, '{"a":2}\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":2}\n');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.startsWith('.delivery-state.json.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('it creates missing directories rather than failing the sync', () => {
  const target = path.join(tmp, 'nested', 'deep', 'front.json');
  writeAtomic(target, '{}\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{}\n');
});

try { execFileSync('rm', ['-rf', tmp]); } catch { /* best effort */ }

done();
