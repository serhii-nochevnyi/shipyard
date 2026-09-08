'use strict';

// The lock exists because the PR sentinel writes the same state files as the main
// loop. Its failure modes are the expensive kind — a torn delivery-state.json, or
// a dead session wedging every later run — so both are pinned here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));
const LOCK = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'lock.cjs');
const { withLock, acquire, writeAtomic, sleepSync, OWNERLESS_GRACE_MS, DEFAULT_TTL_MS } = require(LOCK);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lock-'));

// `release()` refusing to remove a lock it no longer owns says so on stderr, and
// that sentence is part of the contract: a holder whose section ran past its own
// TTL has to learn it lost the lock. Captured rather than printed, so asserting
// it does not turn every green run into a wall of warnings.
function stderrOf(fn) {
  const said = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return said.join('');
}

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
//       removes P1's LIVE lock; mkdirSync succeeds
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

suite('lock — ownership is PROVEN, not assumed (audit F12)');

// Takeover used to be judged by AGE alone and `release()` removed the directory
// unconditionally, so the two together handed the section to two writers:
//
//   A: acquire            <- holds it
//   (A's section runs past its own TTL — a slow gh call, a scheduler pause)
//   B: acquire -> A is stale -> takes it over        <- holds it
//   A: release()          -> removes B's LIVE lock
//   C: acquire            -> the directory is gone -> succeeds
//
// B and C are then both inside a section whose whole purpose is that one writer
// is. The audit executed exactly this (F12) and every call succeeded. The TTL
// changes how OFTEN it happens, never whether the protocol is correct — so the
// owner file carries a token and a release has to present it.

test("an expired holder's release does not remove its successor's lock", () => {
  const lockPath = path.join(tmp, 'f12.lock');
  const a = acquire(tmp, 'f12', { ttlMs: 50, waitMs: 200, label: 'A' });
  assert.ok(a, 'A takes the lock');
  sleepSync(150);                                    // A's own TTL runs out
  const b = acquire(tmp, 'f12', { ttlMs: 50, waitMs: 500, label: 'B' });
  assert.ok(b, 'B takes over the expired lock — that part is by design');

  const said = stderrOf(() => assert.doesNotThrow(() => a.release()));
  assert.ok(fs.existsSync(lockPath), "B's lock must survive A's release");
  assert.ok(/refusing to release/.test(said), `the refusal has to be visible: ${JSON.stringify(said)}`);
  assert.ok(/\bB\b/.test(said), `and name who holds it now: ${JSON.stringify(said)}`);

  const c = acquire(tmp, 'f12', { waitMs: 200, label: 'C' });
  assert.strictEqual(c, null, 'and no third writer may enter while B still holds it');

  b.release();
  assert.ok(!fs.existsSync(lockPath), 'B releasing its OWN lock still frees it');
});

test('every acquire stamps a token no other holder can present', () => {
  const first = acquire(tmp, 'token', { label: 'first' });
  const one = JSON.parse(fs.readFileSync(path.join(first.path, 'owner.json'), 'utf8'));
  assert.ok(typeof one.token === 'string' && one.token.length >= 16,
    `the owner file must carry a token: ${JSON.stringify(one)}`);
  first.release();
  const second = acquire(tmp, 'token', { label: 'second' });
  const two = JSON.parse(fs.readFileSync(path.join(second.path, 'owner.json'), 'utf8'));
  assert.notStrictEqual(two.token, one.token, 'a re-acquire is a NEW holder, so a new token');
  second.release();
});

test('a release whose lock directory is already gone says nothing', () => {
  const h = acquire(tmp, 'vanished', { label: 'A' });
  fs.rmSync(h.path, { recursive: true, force: true });   // someone swept it
  const said = stderrOf(() => assert.doesNotThrow(() => h.release()));
  assert.strictEqual(said, '', 'nothing to remove is nothing to complain about');
});

test('a successor still inside its owner-less grace is not released either', () => {
  // The successor's own mkdir-to-write window (T-22-04): the directory exists and
  // names nobody yet. An expired holder must read that as "not mine" — the token
  // check cannot pass, so the ABSENCE of an owner file has to refuse too, or the
  // one microsecond every acquire spends there is a hole straight back to F12.
  const a = acquire(tmp, 'grace', { ttlMs: 50, label: 'A' });
  sleepSync(150);
  fs.rmSync(a.path, { recursive: true, force: true });
  fs.mkdirSync(a.path);                                  // exactly a successor, mid-acquire
  const said = stderrOf(() => assert.doesNotThrow(() => a.release()));
  assert.ok(fs.existsSync(a.path), "the successor's lock survives");
  assert.ok(/refusing to release/.test(said), `the refusal has to be visible: ${JSON.stringify(said)}`);
  fs.rmSync(a.path, { recursive: true, force: true });
});

test('a takeover claims the holder it displaces, once, and old claims are swept', () => {
  // The claim directory IS the exactly-once step: everyone who saw the same dead
  // holder computes the same claim name and `mkdir` hands it to one of them. It
  // has to survive the takeover (a claim that is deleted at once stops excluding
  // anybody) and it must not survive forever — `.planning/graph/` is TRACKED in
  // this repo, so one entry per killed session would accumulate in git.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lock-claim-'));
  const dead = (label, age) => {
    const p = path.join(d, 'claim.lock');
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify({
      pid: 999999, label, at: new Date(Date.now() - age).toISOString(),
    }));
  };
  const claims = () => fs.readdirSync(d).filter((f) => f.startsWith('claim.lock.stale-'));

  dead('dead run', 10 * 60_000);
  const first = acquire(d, 'claim', { ttlMs: 60_000, waitMs: 500 });
  assert.ok(first, 'the stale lock is still taken over');
  assert.strictEqual(claims().length, 1, 'the takeover leaves exactly one claim');
  assert.ok(fs.existsSync(path.join(d, claims()[0], 'dead', 'owner.json')),
    "and the claim holds the displaced holder's own directory, so it stays non-empty");
  first.release();

  // Back-date that claim past the sweep horizon and take over a DIFFERENT dead
  // holder: the old claim goes, the new one stays.
  const old = path.join(d, claims()[0]);
  const past = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(old, past, past);
  dead('another dead run', 10 * 60_000);
  const second = acquire(d, 'claim', { ttlMs: 60_000, waitMs: 500 });
  assert.ok(second, 'the second stale lock is taken over too');
  assert.ok(!fs.existsSync(old), 'the expired claim is swept, so claims do not pile up in git');
  assert.strictEqual(claims().length, 1, 'and only the live claim remains');
  second.release();
  try { execFileSync('rm', ['-rf', d]); } catch { /* best effort */ }
});

test('two concurrent takeovers of one stale lock produce exactly one holder', () => {
  // Unlike the owner-less cases above, this one cannot be built on disk: the race
  // window is INSIDE a single iteration, between reading the stale owner and
  // displacing it, so no sequence of API calls reproduces it. Real contenders it
  // is — but the shape is chosen so it can only ever be red on a broken protocol:
  // every child sees the SAME dead holder, so all six compute the same claim name
  // and `mkdir` hands it to one of them, and the `mkdir` of the lock itself after
  // that has exactly one winner too. A correct lock always answers 1.
  // `waitMs: 0` keeps a loser from queueing (the deadline check sits after the
  // takeover branch, so a takeover still happens), and the winner HOLDS for a
  // moment so a second holder would overlap it rather than follow it.
  //
  // This test is why the claim is a directory and not a uniquely-named rename:
  // with one aside name per attempt it went red here at ~1 run in 4 — contender B,
  // whose staleness read predated A's completed takeover, renamed A's LIVE lock
  // aside and created its own. Two holders, on code that had already fixed F12's
  // release half.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lock-race-'));
  const stale = path.join(d, 'race.lock');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'owner.json'), JSON.stringify({
    pid: 999999, label: 'dead run', at: new Date(Date.now() - 10 * 60_000).toISOString(),
  }));
  const got = path.join(d, 'got');
  const fin = path.join(d, 'done');
  fs.mkdirSync(got);
  fs.mkdirSync(fin);

  const runner = path.join(d, 'racer.cjs');
  fs.writeFileSync(runner, `
    'use strict';
    const fs = require('fs');
    const { acquire, sleepSync } = require(${JSON.stringify(LOCK)});
    const at = Number(process.argv[2]);
    while (Date.now() < at) sleepSync(5);            // a wall-clock barrier
    const h = acquire(${JSON.stringify(d)}, 'race', { ttlMs: 60000, waitMs: 0, label: 'racer' });
    if (h) {
      fs.writeFileSync(${JSON.stringify(got)} + '/' + process.pid, h.owner.token || '');
      sleepSync(800);                                // HOLD, so a second holder overlaps
      h.release();
    }
    fs.writeFileSync(${JSON.stringify(fin)} + '/' + process.pid, '');
  `);

  const CONTENDERS = 6;
  const startAt = Date.now() + 700;
  for (let i = 0; i < CONTENDERS; i++) {
    spawn(process.execPath, [runner, String(startAt)], { stdio: 'ignore' }).unref();
  }
  const deadline = Date.now() + 30_000;
  while (fs.readdirSync(fin).length < CONTENDERS && Date.now() < deadline) sleepSync(50);
  assert.strictEqual(fs.readdirSync(fin).length, CONTENDERS, 'every contender must have finished');

  const holders = fs.readdirSync(got);
  assert.strictEqual(holders.length, 1,
    `exactly one contender may hold a stale lock's succession, got ${holders.length}: ${holders.join(', ')}`);
  assert.strictEqual(
    fs.readdirSync(d).filter((f) => f.startsWith('race.lock.stale-')).length, 1,
    'one dead holder, one claim — the claim is what made the takeover exactly-once'
  );
  try { execFileSync('rm', ['-rf', d]); } catch { /* best effort */ }
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
