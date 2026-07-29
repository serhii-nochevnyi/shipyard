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
const { withLock, acquire, writeAtomic } = require(LOCK);

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

test('a lock directory with no owner.json is treated as stale, not as held forever', () => {
  const orphan = path.join(tmp, 'orphan.lock');
  fs.mkdirSync(orphan);
  const h = acquire(tmp, 'orphan', { waitMs: 500 });
  assert.ok(h, 'an acquire that died before writing its owner must not be permanent');
  h.release();
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
