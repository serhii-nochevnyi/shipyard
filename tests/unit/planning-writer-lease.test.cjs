'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { createPlanningWriterLease, sharedPlanningWriterRoot, assertNoLegacyPlanningWriter,
  captureSealManifest, assertSealManifest } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'planning-writer-lease.cjs');

function fixture(fn) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-state-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-worktree-'));
  try { return fn({ stateRoot, worktree }); }
  finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('canonical aliases address one shared physical writer and release permits reacquisition', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '.planning', 'phases', '38-phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  const alias = path.join(stateRoot, 'phase-alias');
  fs.symlinkSync(phaseDir, alias);
  const shared = sharedPlanningWriterRoot(path.join(stateRoot, 'shared'));
  const claude = createPlanningWriterLease({ stateRoot: shared, worktree, phaseDir });
  const codex = createPlanningWriterLease({ stateRoot: shared, worktree, phaseDir: alias });
  assert.equal(claude.file, codex.file);
  const first = claude.acquire({ owner: 'claude', base_revision: 'rev' });
  const original = fs.readFileSync(claude.file, 'utf8');
  assert.throws(() => codex.acquire({ owner: 'codex', base_revision: 'rev' }), { code: 'WRITER_LEASED' });
  assert.equal(fs.readFileSync(claude.file, 'utf8'), original);
  claude.release(first);
  const next = codex.acquire({ owner: 'codex', base_revision: 'rev' });
  assert.ok(next.epoch > first.epoch);
  codex.release(next);
}));

test('full completion manifest binds unchanged PLAN and CONTEXT bytes alongside a changed PLAN', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '38-phase');
  fs.mkdirSync(phaseDir);
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# First\n');
  fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Second\n');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const snapshot = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Edited\n');
  const declared = ['38-01-PLAN.md'];
  const outputs = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    declared, changed: lease.changedSince(snapshot).changed });
  assert.deepEqual(Object.keys(outputs).sort(), ['38-01-PLAN.md', '38-02-PLAN.md', 'CONTEXT.md']);
  assert.equal(outputs['38-02-PLAN.md'].origin, 'unchanged-baseline');
  assert.equal(outputs['CONTEXT.md'].origin, 'unchanged-baseline');
  assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot, declared,
    changed: declared, outputs, lease });
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Tampered\n');
  assert.throws(() => assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    declared, changed: declared, outputs, lease }), { code: 'FOREIGN_EDIT' });
}));

test('legacy private active and corrupt leases refuse without changing their bytes', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '38-phase');
  fs.mkdirSync(phaseDir);
  const privateRoot = path.join(stateRoot, 'private');
  const lease = createPlanningWriterLease({ stateRoot: privateRoot, worktree, phaseDir });
  lease.acquire({ owner: 'legacy', base_revision: 'rev' });
  const before = fs.readFileSync(lease.file);
  assert.throws(() => assertNoLegacyPlanningWriter({ worktree, phaseDir, roots: [privateRoot] }),
    { code: 'LEGACY_WRITER_STATE' });
  assert.deepEqual(fs.readFileSync(lease.file), before);
  fs.writeFileSync(lease.file, '{invalid');
  const corrupt = fs.readFileSync(lease.file);
  assert.throws(() => assertNoLegacyPlanningWriter({ worktree, phaseDir, roots: [privateRoot] }),
    { code: 'LEGACY_WRITER_STATE' });
  assert.deepEqual(fs.readFileSync(lease.file), corrupt);
}));

test('a stateRoot inside the worktree is refused', () => fixture(({ worktree }) => {
  assert.throws(() => createPlanningWriterLease({ stateRoot: worktree, worktree, phaseDir: 'phase' }),
    (error) => error.code === 'INVALID_STATE_ROOT');
  assert.throws(() => createPlanningWriterLease({ stateRoot: path.join(worktree, 'state'), worktree, phaseDir: 'phase' }),
    (error) => error.code === 'INVALID_STATE_ROOT');
}));

test('different phases in one worktree never contend', () => fixture(({ stateRoot, worktree }) => {
  const leaseA = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase-a' });
  const leaseB = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase-b' });
  const a = leaseA.acquire({ owner: 'owner-a', base_revision: 'rev' });
  const b = leaseB.acquire({ owner: 'owner-b', base_revision: 'rev' });
  assert.equal(typeof a.token, 'string');
  assert.equal(typeof b.token, 'string');
  assert.notEqual(leaseA.key, leaseB.key);
}));

test('different worktrees never contend', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-state-'));
  const worktreeA = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-worktree-a-'));
  const worktreeB = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-worktree-b-'));
  try {
    const leaseA = createPlanningWriterLease({ stateRoot, worktree: worktreeA, phaseDir: 'phase' });
    const leaseB = createPlanningWriterLease({ stateRoot, worktree: worktreeB, phaseDir: 'phase' });
    const a = leaseA.acquire({ owner: 'same-owner', base_revision: 'rev' });
    const b = leaseB.acquire({ owner: 'same-owner', base_revision: 'rev' });
    assert.equal(typeof a.token, 'string');
    assert.equal(typeof b.token, 'string');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(worktreeA, { recursive: true, force: true });
    fs.rmSync(worktreeB, { recursive: true, force: true });
  }
});

test('acquire refuses WRITER_LEASED, naming the live owner and its expiry', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 500 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  assert.equal(first.epoch, 0);
  assert.equal(first.expires_at, 1_500);
  let caught;
  try { lease.acquire({ owner: 'owner-b', base_revision: 'rev-1' }); }
  catch (error) { caught = error; }
  assert.equal(caught.code, 'WRITER_LEASED');
  assert.equal(caught.details.owner, 'owner-a');
  assert.equal(caught.details.expires_at, 1_500);
}));

test('the same owner may reacquire while still live, and the epoch strictly increases', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 500 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  const second = lease.acquire({ owner: 'owner-a', base_revision: 'rev-2' });
  assert.equal(second.epoch, first.epoch + 1);
  assert.notEqual(second.token, first.token);
}));

test('a live heartbeat wins a race against a later acquire once the ttl has nominally passed', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 100 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  clock = 1_150;
  const renewed = lease.heartbeat({ token: first.token, epoch: first.epoch });
  assert.equal(renewed.expires_at, 1_250);
  assert.throws(() => lease.acquire({ owner: 'owner-b', base_revision: 'rev-1' }), (error) => error.code === 'WRITER_LEASED');
}));

test('a takeover that runs before the original owner heartbeats fences the old token', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 100 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  clock = 1_150;
  const second = lease.acquire({ owner: 'owner-b', base_revision: 'rev-1' });
  assert.equal(second.epoch, first.epoch + 1);
  assert.throws(() => lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-1' }),
    (error) => error.code === 'WRITER_FENCED');
  assert.throws(() => lease.heartbeat({ token: first.token, epoch: first.epoch }), (error) => error.code === 'WRITER_FENCED');
}));

test('assertFence refuses LEASE_EXPIRED once the ttl elapses with no takeover', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 100 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  clock = 1_101;
  assert.throws(() => lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-1' }),
    (error) => error.code === 'LEASE_EXPIRED');
}));

test('assertFence refuses BASE_MOVED when the base revision differs', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  assert.throws(() => lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-2' }),
    (error) => error.code === 'BASE_MOVED');
}));

test('assertFence succeeds while the token, epoch and base revision all match', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  const result = lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-1' });
  assert.equal(result.ok, true);
  assert.equal(result.owner, 'owner-a');
}));

test('release marks the lease inactive so a new owner may acquire immediately', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  assert.deepEqual(lease.release({ token: first.token, epoch: first.epoch }), { released: true });
  assert.throws(() => lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-1' }),
    (error) => error.code === 'WRITER_FENCED');
  const second = lease.acquire({ owner: 'owner-b', base_revision: 'rev-1' });
  assert.equal(second.epoch, first.epoch + 1);
}));

test('release refuses WRITER_FENCED for a token that no longer matches', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase' });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  assert.throws(() => lease.release({ token: 'wrong-token', epoch: first.epoch }), (error) => error.code === 'WRITER_FENCED');
}));

test('recover refuses while the owner is live and unexpired', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  assert.throws(() => lease.recover({ owner: 'owner-b', reason: 'crash recovery drill' }), (error) => error.code === 'WRITER_LEASED');
}));

test('recover treats unknown process-probe errors as live until explicit expiry', () => fixture(({ stateRoot, worktree }) => {
  let now = 1000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => now, ttlMs: 100 });
  lease.acquire({ owner: 'original', base_revision: 'rev' });
  const originalKill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('probe unavailable'), { code: 'EACCES' }); };
    assert.throws(() => lease.recover({ owner: 'successor', reason: 'crash' }), { code: 'WRITER_LEASED' });
    now = 1100;
    assert.equal(lease.recover({ owner: 'successor', reason: 'expired' }).recovered, true);
  } finally { process.kill = originalKill; }
}));

test('recover succeeds once the ttl has expired, with a strictly greater epoch', () => fixture(({ stateRoot, worktree }) => {
  let clock = 1_000;
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', now: () => clock, ttlMs: 100 });
  const first = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  clock = 1_200;
  const recovered = lease.recover({ owner: 'owner-b', reason: 'session crashed mid plan' });
  assert.ok(recovered.epoch > first.epoch);
}));

test('recover succeeds when the owner pid is dead, even before the ttl expires', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-state-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-worktree-'));
  try {
    const script = [
      'const mod = require(process.argv[1]);',
      'const lease = mod.createPlanningWriterLease({ stateRoot: process.argv[2], worktree: process.argv[3], phaseDir: "phase", ttlMs: 100000 });',
      'process.stdout.write(JSON.stringify(lease.acquire({ owner: "owner-a", base_revision: "rev-1" })));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script, MODULE_PATH, stateRoot, worktree], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const first = JSON.parse(child.stdout);
    assert.equal(typeof first.token, 'string');
    const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
    const recovered = lease.recover({ owner: 'owner-b', reason: 'the acquiring process already exited' });
    assert.ok(recovered.epoch > first.epoch);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('changedSince reports only files whose digest changed, carrying the lease as writer evidence', () => fixture(({ stateRoot, worktree }) => {
  const phaseDirAbs = path.join(worktree, 'phase');
  fs.mkdirSync(phaseDirAbs, { recursive: true });
  fs.writeFileSync(path.join(phaseDirAbs, 'a.md'), 'alpha');
  fs.writeFileSync(path.join(phaseDirAbs, 'b.md'), 'bravo');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase' });
  const before = lease.snapshotTree();
  const acquired = lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  fs.writeFileSync(path.join(phaseDirAbs, 'b.md'), 'bravo-2');
  fs.writeFileSync(path.join(phaseDirAbs, 'c.md'), 'charlie');
  const after = lease.changedSince(before);
  assert.deepEqual(after.changed, ['b.md', 'c.md']);
  assert.equal(after.lease.token, acquired.token);
  assert.equal(after.lease.owner, 'owner-a');
}));

test('acquire refuses non-object input and missing required fields', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase' });
  assert.throws(() => lease.acquire(), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => lease.acquire({ owner: 'owner-a' }), (error) => error.code === 'INVALID_INPUT');
}));

test('acquire is exclusive across concurrent Node processes racing the same key', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-race-state-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-race-worktree-'));
  try {
    const script = [
      'const mod = require(process.argv[1]);',
      'const lease = mod.createPlanningWriterLease({ stateRoot: process.argv[2], worktree: process.argv[3], phaseDir: "phase" });',
      'process.send("ready");',
      'process.once("message", () => {',
      '  let out;',
      '  try { out = { admitted: true, ...lease.acquire({ owner: process.argv[4], base_revision: "rev-1" }) }; }',
      '  catch (error) { out = { admitted: false, code: error.code }; }',
      '  process.stdout.write(JSON.stringify(out));',
      '  process.disconnect();',
      '});',
    ].join('\n');
    const children = Array.from({ length: 6 }, (_unused, index) => {
      const child = spawn(process.execPath, ['-e', script, MODULE_PATH, stateRoot, worktree, `owner-${index}`], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const ready = new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('child exited before ready')));
      });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
          try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
      });
      return { child, ready, result };
    });
    await Promise.all(children.map(({ ready }) => ready));
    children.forEach(({ child }) => child.send('go'));
    const results = await Promise.all(children.map(({ result }) => result));
    assert.equal(results.filter((r) => r.admitted).length, 1);
    assert.equal(results.filter((r) => !r.admitted && r.code === 'WRITER_LEASED').length, 5);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test('control: a plain check-then-write with no shared lock lets two racers both believe they won', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-naive-'));
  const targetFile = path.join(stateRoot, 'naive-lease.json');
  try {
    const script = [
      'const fs = require("fs");',
      'const file = process.argv[1];',
      'const owner = process.argv[2];',
      'let admittedAtCheck = false;',
      'process.send("ready");',
      'process.on("message", (msg) => {',
      '  if (msg === "go-check") {',
      '    let existing = null;',
      '    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { existing = null; }',
      '    admittedAtCheck = !existing;',
      '    process.send("checked");',
      '  } else if (msg === "go-write") {',
      '    if (admittedAtCheck) fs.writeFileSync(file, JSON.stringify({ owner }));',
      '    process.stdout.write(JSON.stringify({ admitted: admittedAtCheck }));',
      '    process.disconnect();',
      '  }',
      '});',
    ].join('\n');
    const children = Array.from({ length: 2 }, (_unused, index) => {
      const child = spawn(process.execPath, ['-e', script, targetFile, `owner-${index}`], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const ready = deferred();
      const checked = deferred();
      child.on('message', (msg) => {
        if (msg === 'ready') ready.resolve();
        else if (msg === 'checked') checked.resolve();
      });
      child.once('error', (error) => { ready.reject(error); checked.reject(error); });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
          try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
      });
      return { child, ready: ready.promise, checked: checked.promise, result };
    });
    await Promise.all(children.map(({ ready }) => ready));
    children.forEach(({ child }) => child.send('go-check'));
    await Promise.all(children.map(({ checked }) => checked));
    children.forEach(({ child }) => child.send('go-write'));
    const results = await Promise.all(children.map(({ result }) => result));
    assert.equal(results.filter((r) => r.admitted).length, 2);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
