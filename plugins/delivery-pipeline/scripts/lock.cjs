#!/usr/bin/env node
'use strict';

// Cross-process advisory locking + atomic file replacement.
//
// The conveyor used to have exactly ONE writer: the delivery run itself. The PR
// sentinel (references/pr-sentinel.md) breaks that assumption — it runs
// CONCURRENTLY with the main loop and touches the same two shared resources:
//
//   state  — .planning/graph/delivery-state.json|yaml, delivery-front.json and
//            the append-only journal. Two state-syncs interleaving their
//            writeFileSync calls produce a truncated/half-written snapshot, and
//            the loser silently drops the winner's transitions.
//   git    — `git worktree add` and branch creation write to the SHARED .git
//            (index.lock). The main loop creating a worktree while the sentinel
//            pushes a fix in another one is the documented index-lock race.
//
// So both are taken under a named lock, and every state file is REPLACED via
// rename(2) instead of being written in place: a reader that opens the file
// mid-write must see the old snapshot, never half of the new one.
//
//   const { withLock, writeAtomic, lockDirFor } = require('./lock.cjs');
//   withLock(lockDirFor(root), 'state', () => { ...read, modify, write... });
//
// The lock is a DIRECTORY (mkdir is atomic on every POSIX filesystem, unlike
// "check then create"), holding an owner.json so a stale lock can be identified
// and taken over — a killed session must not wedge the next run forever. The
// directory and its owner.json are two calls, though, so every live acquire
// spends a moment holding a lock that cannot yet name its holder; see
// OWNERLESS_GRACE_MS for how that window is told apart from a death in it.
//
// OWNERSHIP IS PROVEN, NEVER ASSUMED. A TTL is a guess about liveness, and two
// unconditional operations built on that guess handed the section to two writers
// (audit F12, executed): a holder whose own section outran its TTL was taken over
// correctly, and then its `release()` removed its SUCCESSOR's live lock, after
// which a third writer walked in. Both halves are now conditional on identity:
// the owner file carries a random TOKEN and `release()` has to present it (a
// holder that lost the lock removes nothing, and says so), while a takeover first
// claims the HOLDER it is displacing — `mkdir <lock>.stale-<who>` — and only then
// moves that holder's directory out of the way, verifying afterwards that what it
// moved is what it judged. See `takeover` for why the obvious `rm`-then-`mkdir`
// and the almost-obvious rename-aside both hand the lock to two writers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 120_000;   // a holder older than this is presumed dead
const DEFAULT_WAIT_MS = 60_000;   // how long we queue before giving up
const POLL_MS = 120;

// How long a lock directory that has no owner.json yet is presumed HELD. The
// mkdir and the writeFileSync that follows it are microseconds apart, so two
// seconds cover that window by orders of magnitude while staying 1/60 of the
// TTL — a session killed between the two calls is still taken over, two seconds
// later instead of instantly. It also clears the one-second mtime granularity
// some filesystems still report, which would otherwise make a directory created
// this instant read as nearly a second old.
const OWNERLESS_GRACE_MS = 2_000;

// These scripts are synchronous end to end, so the wait has to be synchronous
// too. A `while (Date.now() < t) {}` spin would burn a core precisely while the
// other process is doing the work we are waiting for.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockDirFor(root) {
  return path.join(root || process.cwd(), '.planning', 'graph', '.locks');
}

function ownerFile(lockPath) {
  return path.join(lockPath, 'owner.json');
}

// The owner file as BOTH the parsed record and the exact bytes on disk. The bytes
// matter because they are the holder's IDENTITY: a takeover has to name which
// holder it is displacing, and it has to be able to prove afterwards that the
// directory it moved is the one it judged. A corrupt file yields `owner: null`
// (identical to a missing one, which the grace below relies on) while still
// giving those bytes an identity.
function ownerRecord(lockPath) {
  let raw = null;
  try { raw = fs.readFileSync(ownerFile(lockPath), 'utf8'); } catch { return { raw: null, owner: null }; }
  try { return { raw, owner: JSON.parse(raw) }; } catch { return { raw, owner: null }; }
}

function readOwner(lockPath) {
  return ownerRecord(lockPath).owner;
}

// Which holder we are looking at, as a filename-safe string. It is derived from
// the owner bytes when there are any, and from the directory's own mtime when
// there are not (the owner-less window). Two contenders that saw the SAME holder
// compute the SAME identity — which is what makes the claim below exactly-once.
//
// `null` means NOTHING was observed: the lock directory went away between the
// EEXIST that sent us here and this read. That is not an identity and it must not
// be treated as one. Under the old `rm`-based takeover it was harmless ("removing
// a directory that is already gone is a no-op"), but a takeover that MOVES the
// directory will happily move whatever has appeared at the name since — measured:
// an `ownerless-gone` claim renamed a live holder's fresh lock aside, and the
// six-way race produced two holders again. A caller that observed nothing has
// nothing to displace, so it simply asks again.
function identityOf(raw, lockPath) {
  if (raw !== null) return `owner-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
  try { return `ownerless-${Math.round(fs.statSync(lockPath).mtimeMs)}`; } catch { return null; }
}

// When the mkdir happened, straight from the filesystem — the age an owner-less
// lock cannot state itself. A lock that vanished while we looked at it reports
// NaN, which the negated comparison below reads as "not held any more"; the
// takeover that follows finds nothing to move and simply reports failure, so the
// retry re-runs the mkdir. (`identityOf` catches the common form of that case
// earlier and more cheaply — this is the residual window between its stat and
// this one.)
function ownerlessAgeMs(lockPath) {
  try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return NaN; }
}

// Take a stale lock over, and do it EXACTLY ONCE per holder. Deleting the
// directory in place is what let two writers into the section (audit F12): the
// decision "this holder is dead" is made from a read, and by the time the delete
// runs the directory may have been replaced by a LIVE holder. `rm` then `mkdir` is
// two steps, so two contenders could both delete and both create.
//
// A bare `rename` aside is not enough either, and this was measured rather than
// reasoned: with a unique aside name per attempt, contender B — whose staleness
// read predated A's completed takeover — renamed A's brand-new LIVE lock aside and
// created its own. Two holders, reproduced in six-way races on this machine.
//
// So the claim is a DIRECTORY named after the holder being displaced:
//
//   mkdir <lock>.stale-<identity>      the exclusive step. Everyone who saw this
//                                      holder computes this name, and `mkdir` hands
//                                      it to exactly one of them; the rest are told
//                                      EEXIST and simply ask for the lock again.
//   rename <lock> -> <claim>/dead      moves the dead directory out of the way in
//                                      one step, into a name only the claimant has.
//   verify <claim>/dead                the proof. If the directory we moved is not
//                                      the holder we judged, we moved someone
//                                      LIVE — so it goes straight back and this
//                                      attempt reports failure.
//
// The claim is kept (that is what makes it exactly-once) and swept later, because
// `.planning/graph/` is TRACKED here and claims must not accumulate.
//
// Returns whether the contended name is now free BECAUSE OF THIS CALL. Either way
// the caller re-asks: winning the claim does not by itself confer the lock, and
// losing it does not forbid asking.
function takeover(lockPath, identity, ttlMs) {
  const claim = `${lockPath}.stale-${identity}`;
  sweepClaims(lockPath, ttlMs);
  try {
    fs.mkdirSync(claim);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // This holder has already been claimed, so whatever sits at the lock now is
    // not ours to move. One exception: a claimant killed between its mkdir and
    // its rename leaves an EMPTY claim, and every later contender would then spin
    // on it — a wedge of exactly the kind the TTL exists to prevent. An empty
    // claim past the grace is therefore swept, and the retry re-attempts it.
    try {
      if (fs.readdirSync(claim).length === 0 &&
          Date.now() - fs.statSync(claim).mtimeMs >= OWNERLESS_GRACE_MS) {
        fs.rmSync(claim, { recursive: true, force: true });
      }
    } catch { /* raced with the claimant */ }
    return false;
  }
  const dead = path.join(claim, 'dead');
  try {
    fs.renameSync(lockPath, dead);
  } catch {
    // ENOENT — the holder released, or another contender's normal acquire has the
    // name. Nothing was moved and nothing needs undoing.
    return false;
  }
  if (identityOf(ownerRecord(dead).raw, dead) !== identity) {
    // We moved a directory that is not the one we judged: the dead holder
    // released and someone acquired normally between our read and our rename. Put
    // it back — an unrestored live lock is two writers in the section, which is
    // the entire defect this function exists to close. The claim stays, so nobody
    // repeats this attempt with the same stale observation.
    try { fs.renameSync(dead, lockPath); } catch { /* a new holder already took the name */ }
    process.stderr.write(
      `lock: stood down from taking over "${path.basename(lockPath)}" — it changed hands while we were reading it.\n`
    );
    return false;
  }
  return true;
}

// Claims from earlier takeovers. Kept for at least the TTL so a straggling
// contender that saw the same holder still collides with the claim instead of
// re-taking a lock somebody else now holds; removed after that, because this
// directory is committed to git and one entry per killed session would pile up.
// Only ever called on the (rare) takeover path.
function sweepClaims(lockPath, ttlMs) {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.stale-`;
  const horizon = Math.max(Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS, OWNERLESS_GRACE_MS);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < horizon) continue;
    } catch { continue; }
    try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Release a lock this handle actually holds — and NOTHING else. Three outcomes,
// and they are deliberately distinct because they mean different things:
//
//   the directory is gone      — someone already swept it; nothing to do, nothing
//                                to say (a release is not a complaint about being
//                                early);
//   it names a DIFFERENT token — this holder's section outran its TTL and a
//                                successor took the lock over. Removing it here is
//                                precisely audit F12, so it is refused;
//   no owner.json at all       — a successor mid-acquire, inside the owner-less
//                                window every holder passes through (T-22-04). The
//                                token cannot match, so this refuses too: an
//                                absent owner is not this holder's owner.
//
// It never throws. `withLock` calls it from a `finally`, so a throw here would
// replace the body's own error — or invent one for a section that succeeded.
function releaseOwned(lockPath, owner) {
  if (!fs.existsSync(lockPath)) return;
  const holder = readOwner(lockPath);
  if (holder && owner && holder.token && owner.token && holder.token === owner.token) {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* raced with a sweeper */ }
    return;
  }
  const who = holder
    ? `${holder.label || 'an unnamed holder'} (pid ${holder.pid}, since ${holder.at})`
    : 'a successor that has not named itself yet';
  process.stderr.write(
    `lock: refusing to release the "${path.basename(lockPath).replace(/\.lock$/, '')}" lock — ` +
    `it is now held by ${who}, not by this holder (pid ${process.pid}). ` +
    'This section ran past the lock TTL and was taken over while it was still running; ' +
    'whatever it wrote may have interleaved with the new holder.\n'
  );
}

// Returns a handle ({ path, owner, release() }) or null when the wait ran out.
function acquire(dir, name, opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const label = opts.label || path.basename(process.argv[1] || 'shipyard');

  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${name}.lock`);
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      // The token is what makes `release()` an assertion of ownership rather than
      // a guess. It is written WITH the rest of the owner record — one file, one
      // write — so a reader either sees a holder it can identify or sees nothing.
      const owner = { pid: process.pid, label, at: new Date().toISOString(), token: crypto.randomBytes(12).toString('hex') };
      fs.writeFileSync(ownerFile(lockPath), JSON.stringify(owner) + '\n');
      let released = false;
      return {
        path: lockPath,
        owner,
        release() {
          if (released) return;
          released = true;
          releaseOwned(lockPath, owner);
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // ONE read of the holder, and everything below is derived from it: the
      // staleness verdict and the identity a takeover would displace have to
      // describe the same observation, or the takeover cannot prove afterwards
      // what it moved.
      const { raw, owner: holder } = ownerRecord(lockPath);
      const identity = identityOf(raw, lockPath);
      if (identity === null) {
        // The lock vanished while we were looking at it. There is no holder to
        // judge and nothing to displace — re-ask at once (the deadline is still
        // honoured, so a name that somehow flickers forever cannot trap us).
        if (Date.now() >= deadline) return null;
        continue;
      }
      let stale;
      if (holder && holder.at) {
        // A lock that names its holder is stale once that holder's own
        // timestamp is older than the TTL. An unparseable timestamp is an
        // unknown age and is taken over at once — note the negated comparison,
        // NaN < ttl is false, which is the behaviour we want here.
        stale = !(Date.now() - Date.parse(holder.at) < ttlMs);
      } else {
        // No owner.json. Two states look identical from here: a process that
        // died between the mkdir and the write, and one that is ABOUT to write.
        // The second is the common one — those two calls are microseconds apart
        // in EVERY live acquire — so treating the pair as stale broke live
        // locks out from under their holders, and both processes then believed
        // they held it. The age is not actually unknown: the lock directory's
        // own mtime records when the mkdir happened. Inside the grace the lock
        // is HELD and we queue; past it the takeover is exactly as before, so a
        // killed session still cannot wedge the next run. (A corrupt owner.json,
        // or one that names no time at all, reads the same as a missing one and
        // so waits out the grace too — a takeover delayed by two seconds and
        // nothing more. An owner.json that DOES name a time, unparseably, keeps
        // its instant takeover in the branch above.)
        stale = !(ownerlessAgeMs(lockPath) < OWNERLESS_GRACE_MS);
      }
      // A takeover that FREED the name earns an immediate retry. One that did not
      // — the claim was already taken, or the directory turned out to belong to a
      // live holder — falls through to the queue instead of spinning: every path
      // out of `takeover` used to be a success, and a hot loop over a claim
      // somebody else owns would burn a core until the wait ran out.
      if (stale && takeover(lockPath, identity, ttlMs)) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(POLL_MS);
    }
  }
}

// Runs fn under the lock, always releasing it. A lock that cannot be taken is an
// ERROR, not a silent bypass: the whole point is that two writers must not
// proceed at once, so the caller has to see it.
function withLock(dir, name, fn, opts = {}) {
  const handle = acquire(dir, name, opts);
  if (!handle) {
    const holder = readOwner(path.join(dir, `${name}.lock`));
    const who = holder ? `${holder.label} (pid ${holder.pid}, since ${holder.at})` : 'an unknown holder';
    throw new Error(
      `could not acquire the "${name}" lock — it is held by ${who}. ` +
      'Another delivery process (the PR sentinel, or a second /shipyard:deliver) is mid-write; ' +
      'wait for it, or remove the lock directory if that process is gone.'
    );
  }
  try {
    return fn();
  } finally {
    handle.release();
  }
}

// Replace a file in one step. A concurrent reader sees either the old content or
// the new one — never a truncated write. The temp file is created in the SAME
// directory so the rename stays within one filesystem.
function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

module.exports = { withLock, acquire, writeAtomic, lockDirFor, sleepSync, DEFAULT_TTL_MS, OWNERLESS_GRACE_MS };

// ── CLI: the shell scripts take the same locks (git worktree/branch surgery) ──
//   lock.cjs run <dir> <name> -- <command> [args...]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  if (argv[0] !== 'run' || sep === -1 || sep < 3) {
    process.stderr.write('usage: lock.cjs run <lock-dir> <name> -- <command> [args...]\n');
    process.exit(2);
  }
  const [, dir, name] = argv;
  const cmd = argv.slice(sep + 1);
  const { spawnSync } = require('child_process');
  // SHIPYARD_LOCK_WAIT_MS shortens the queue wait — a caller that would rather
  // retry itself (a script loop, a test) should not sit in the default minute.
  const envWait = Number(process.env.SHIPYARD_LOCK_WAIT_MS);
  let status = 0;
  try {
    withLock(dir, name, () => {
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
      status = r.status === null ? 1 : r.status;
    }, { label: `lock.cjs run ${cmd[0]}`, waitMs: Number.isFinite(envWait) && envWait > 0 ? envWait : undefined });
  } catch (e) {
    process.stderr.write(`lock: ${e.message}\n`);
    process.exit(75); // EX_TEMPFAIL — the caller may retry
  }
  process.exit(status);
}
