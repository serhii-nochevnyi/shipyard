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
// and taken over — a killed session must not wedge the next run forever.

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 120_000;   // a holder older than this is presumed dead
const DEFAULT_WAIT_MS = 60_000;   // how long we queue before giving up
const POLL_MS = 120;

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

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(lockPath), 'utf8'));
  } catch {
    return null;
  }
}

function breakLock(lockPath) {
  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* raced with the holder */ }
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
      const owner = { pid: process.pid, label, at: new Date().toISOString() };
      fs.writeFileSync(ownerFile(lockPath), JSON.stringify(owner) + '\n');
      let released = false;
      return {
        path: lockPath,
        owner,
        release() {
          if (released) return;
          released = true;
          breakLock(lockPath);
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readOwner(lockPath);
      // No owner.json = a process died between mkdir and the write, so the age
      // is unknown; an unparseable timestamp is the same case. Both are treated
      // as stale rather than as "held forever" (note the negated comparison —
      // NaN < ttl is false, which is the behaviour we want).
      const age = holder && holder.at ? Date.now() - Date.parse(holder.at) : NaN;
      if (!(age < ttlMs)) {
        breakLock(lockPath);
        continue;
      }
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

module.exports = { withLock, acquire, writeAtomic, lockDirFor, sleepSync, DEFAULT_TTL_MS };

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
