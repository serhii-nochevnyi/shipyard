'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { createPlanningWriterLease, sharedPlanningWriterRoot,
  captureSealManifest, assertSealManifest, pidAlive, phaseDirectory, sealOutputPaths, resolvePhaseArtifact,
  parsePhaseDirectoryName, liveLaunchChild } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');

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
  const changed = lease.changedSince(snapshot).changed;
  assert.deepEqual(changed, ['38-01-PLAN.md']);
  const outputs = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot, changed });
  assert.deepEqual(Object.keys(outputs).sort(), ['38-01-PLAN.md', '38-02-PLAN.md', 'CONTEXT.md']);
  assert.equal(outputs['38-02-PLAN.md'].origin, 'unchanged-baseline');
  assert.equal(outputs['CONTEXT.md'].origin, 'unchanged-baseline');
  assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot, changed, outputs, lease });
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Tampered\n');
  assert.throws(() => assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    changed, outputs, lease }), { code: 'FOREIGN_EDIT' });
}));

test('zero-padded phase plans remain bound through completion and recovery', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '01-phase');
  fs.mkdirSync(phaseDir);
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Baseline\n');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const snapshot = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# New plan\n');
  const changed = lease.changedSince(snapshot).changed;
  assert.deepEqual(changed, ['01-01-PLAN.md']);
  const outputs = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot, changed });
  assert.deepEqual(Object.keys(outputs).sort(), ['01-01-PLAN.md', '01-02-PLAN.md', 'CONTEXT.md']);
  assert.equal(outputs['01-02-PLAN.md'].origin, 'unchanged-baseline');
  assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot, changed, outputs, lease });
  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Altered\n');
  assert.throws(() => assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    changed, outputs, lease }), { code: 'FOREIGN_EDIT' });
}));

test('the seal manifest takes the changed set from the host delta and refuses writes outside the role outputs', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '38-phase');
  fs.mkdirSync(phaseDir);
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# First\n');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const snapshot = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Second\n');
  const outputs = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    changed: lease.changedSince(snapshot).changed });
  assert.equal(outputs['38-02-PLAN.md'].origin, 'child-change');
  fs.writeFileSync(path.join(phaseDir, 'notes.md'), 'stray\n');
  const stray = lease.changedSince(snapshot).changed;
  assert.deepEqual(stray, ['38-02-PLAN.md', 'notes.md']);
  assert.throws(() => captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot, changed: stray }),
    { code: 'FOREIGN_EDIT' });
  assert.throws(() => assertSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    changed: ['38-02-PLAN.md'], outputs, lease }), { code: 'FOREIGN_EDIT' });
  fs.rmSync(path.join(phaseDir, 'notes.md'));
  fs.rmSync(path.join(phaseDir, '38-02-PLAN.md'));
  const withContext = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Created by the planner\n');
  assert.equal(captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot: withContext,
    changed: ['CONTEXT.md'] })['CONTEXT.md'].origin, 'child-change');
  const baselineContext = lease.snapshotTree();
  fs.appendFileSync(path.join(phaseDir, 'CONTEXT.md'), 'locked decision rewritten\n');
  assert.throws(() => captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot: baselineContext,
    changed: lease.changedSince(baselineContext).changed }), { code: 'FOREIGN_EDIT' });
  fs.rmSync(path.join(phaseDir, 'CONTEXT.md'));
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Edited\n');
  assert.throws(() => assertSealManifest({ role: 'gsd-plan-checker', phaseDir, snapshot,
    changed: lease.changedSince(snapshot).changed, outputs: {}, lease }), { code: 'RECOVERY_ARTIFACT_ALTERED' });
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

test('pidAlive treats only a vanished process as stopped', () => {
  assert.equal(pidAlive(process.pid), true);
  for (const unknown of [0, -1, 1.5, NaN, '1']) assert.equal(pidAlive(unknown), true);
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(pidAlive(child.pid), false);
});

test('phaseDirectory resolves one canonical phase directory and refuses anything else', () => fixture(({ worktree }) => {
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const phases = path.join(fs.realpathSync(worktree), '.planning', 'phases');
  fs.mkdirSync(path.join(phases, '01-one'), { recursive: true });
  fs.mkdirSync(path.join(phases, '10-ten'));
  fs.mkdirSync(path.join(phases, '10-again'));
  assert.equal(phaseDirectory(path.dirname(path.dirname(phases)), '01', refuse), path.join(phases, '01-one'));
  for (const phase of [2, 10]) assert.throws(() => phaseDirectory(path.dirname(path.dirname(phases)), phase, refuse), { code: 'PHASE_DIRECTORY_MISSING' });
  fs.renameSync(phases, `${phases}-real`);
  fs.symlinkSync(`${phases}-real`, phases);
  assert.throws(() => phaseDirectory(path.dirname(path.dirname(phases)), 1, refuse), /root is not canonical/);
}));

function researcherSeal(phaseDirName, files) {
  return fixture(({ stateRoot, worktree }) => {
    const phaseDir = path.join(worktree, phaseDirName);
    fs.mkdirSync(phaseDir);
    const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
    const snapshot = lease.snapshotTree();
    for (const name of files) fs.writeFileSync(path.join(phaseDir, name), '# Research\n');
    const changed = lease.changedSince(snapshot).changed;
    return captureSealManifest({ role: 'gsd-phase-researcher', phaseDir, snapshot, changed });
  });
}

test('the researcher seal is the RESEARCH file GSD wrote, padded or not', () => {
  assert.deepEqual(Object.keys(researcherSeal('01-phase', ['01-RESEARCH.md'])), ['01-RESEARCH.md']);
  assert.deepEqual(Object.keys(researcherSeal('01-phase', ['1-RESEARCH.md'])), ['1-RESEARCH.md']);
  assert.deepEqual(Object.keys(researcherSeal('12-phase', ['12-RESEARCH.md'])), ['12-RESEARCH.md']);
  assert.deepEqual(Object.keys(researcherSeal('ABC-01-phase', ['01-RESEARCH.md'])), ['01-RESEARCH.md']);
  assert.deepEqual(Object.keys(researcherSeal('ABC-01-phase', ['ABC-01-RESEARCH.md'])), ['ABC-01-RESEARCH.md']);
  assert.equal(researcherSeal('01-phase', ['01-RESEARCH.md'])['01-RESEARCH.md'].origin, 'child-change');
});

test('a phase with both padded and unpadded RESEARCH files is refused as ambiguous, and a missing one is named', () => {
  assert.throws(() => researcherSeal('01-phase', ['01-RESEARCH.md', '1-RESEARCH.md']), { code: 'AMBIGUOUS_ARTIFACT' });
  assert.throws(() => researcherSeal('01-phase', []), (error) => error.code === 'MISSING_ARTIFACT'
    && /01-RESEARCH\.md/.test(error.message) && /1-RESEARCH\.md/.test(error.message));
});

test('CONTEXT resolves bare or padded, is refused when both exist, and a changed padded CONTEXT stays frozen for the planner', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '01-phase');
  fs.mkdirSync(phaseDir);
  assert.equal(resolvePhaseArtifact(phaseDir, 'CONTEXT'), null);
  fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
  assert.equal(resolvePhaseArtifact(phaseDir, 'CONTEXT'), '01-CONTEXT.md');
  assert.deepEqual(sealOutputPaths('gsd-planner', phaseDir), ['01-01-PLAN.md', '01-CONTEXT.md']);
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const snapshot = lease.snapshotTree();
  fs.appendFileSync(path.join(phaseDir, '01-CONTEXT.md'), 'rewritten\n');
  assert.throws(() => captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot,
    changed: lease.changedSince(snapshot).changed }), { code: 'FOREIGN_EDIT' });
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Bare\n');
  assert.throws(() => resolvePhaseArtifact(phaseDir, 'CONTEXT'), { code: 'AMBIGUOUS_ARTIFACT' });
}));

test('phase directories may carry a project_code prefix', () => fixture(({ worktree }) => {
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const root = fs.realpathSync(worktree);
  const phases = path.join(root, '.planning', 'phases');
  fs.mkdirSync(path.join(phases, 'ABC-01-setup'), { recursive: true });
  fs.mkdirSync(path.join(phases, 'AUTH-X-02-login'));
  assert.equal(phaseDirectory(root, 1, refuse), path.join(phases, 'ABC-01-setup'));
  assert.equal(phaseDirectory(root, 2, refuse), path.join(phases, 'AUTH-X-02-login'));
  assert.deepEqual(parsePhaseDirectoryName('ABC-01-setup'), { token: 'ABC-01', number: 1 });
  assert.deepEqual(parsePhaseDirectoryName('07-plain'), { token: '07', number: 7 });
  assert.equal(parsePhaseDirectoryName('notes'), null);
  fs.mkdirSync(path.join(phases, '01-also'));
  assert.throws(() => phaseDirectory(root, 1, refuse), /found 2/);
}));

test('a missing phase directory names the searched root, the expected pattern and the remedy', () => fixture(({ worktree }) => {
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const root = fs.realpathSync(worktree);
  for (const make of [false, true]) {
    if (make) fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });
    assert.throws(() => phaseDirectory(root, 1, refuse), (error) => error.code === 'PHASE_DIRECTORY_MISSING'
      && error.message.includes(path.join(root, '.planning', 'phases'))
      && error.message.includes('.planning/phases/01-<slug>/')
      && error.message.includes('/gsd-plan-phase 1 --ingest')
      && error.message.includes('ROADMAP.md'));
  }
}));

test('a checker that edits phase files is refused as read-only, pointing at a planner re-dispatch', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '38-phase');
  fs.mkdirSync(phaseDir);
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# First\n');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const snapshot = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Revised by the checker\n');
  assert.throws(() => captureSealManifest({ role: 'gsd-plan-checker', phaseDir, snapshot,
    changed: lease.changedSince(snapshot).changed }), (error) => error.code === 'FOREIGN_EDIT'
    && /read-only/.test(error.message) && /planner re-dispatch/.test(error.message) && /38-01-PLAN\.md/.test(error.message));
}));

test('a planner revision over existing PLAN files seals the new bytes and leaves the prior seal untouched', () => fixture(({ stateRoot, worktree }) => {
  const phaseDir = path.join(worktree, '01-phase');
  fs.mkdirSync(phaseDir);
  fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# One\n');
  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Two\n');
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir });
  const first = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# One, revised once\n');
  const sealOne = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot: first,
    changed: lease.changedSince(first).changed });
  const second = lease.snapshotTree();
  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Two, revised\n');
  const sealTwo = captureSealManifest({ role: 'gsd-planner', phaseDir, snapshot: second,
    changed: lease.changedSince(second).changed });
  assert.deepEqual(Object.keys(sealTwo), Object.keys(sealOne));
  assert.equal(sealOne['01-01-PLAN.md'].origin, 'child-change');
  assert.equal(sealTwo['01-01-PLAN.md'].origin, 'unchanged-baseline');
  assert.equal(sealTwo['01-02-PLAN.md'].origin, 'child-change');
  assert.equal(sealTwo['01-01-PLAN.md'].sha256, sealOne['01-01-PLAN.md'].sha256);
  assert.notEqual(sealTwo['01-02-PLAN.md'].sha256, sealOne['01-02-PLAN.md'].sha256);
  assert.equal(sealTwo['01-CONTEXT.md'].origin, 'unchanged-baseline');
}));

function deadHolderLease({ stateRoot, worktree }) {
  const script = [
    'const mod = require(process.argv[1]);',
    'const lease = mod.createPlanningWriterLease({ stateRoot: process.argv[2], worktree: process.argv[3], phaseDir: "phase", ttlMs: 100000 });',
    'process.stdout.write(JSON.stringify(lease.acquire({ owner: "owner-a", base_revision: "rev-1" })));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script, MODULE_PATH, stateRoot, worktree], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('acquire takes over an active lease whose holder pid is dead, bumping the epoch and recording why', () => fixture(({ stateRoot, worktree }) => {
  const first = deadHolderLease({ stateRoot, worktree });
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  const seen = [];
  const taken = lease.acquire({ owner: 'owner-b', base_revision: 'rev-2',
    holder_child: (held) => { seen.push(held.epoch); return null; } });
  assert.equal(taken.recovered, true);
  assert.equal(taken.epoch, first.epoch + 1);
  assert.deepEqual(seen, [first.epoch]);
  const record = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
  assert.equal(record.recovered_from_epoch, first.epoch);
  assert.match(record.recovered_reason, /dead/);
  assert.equal(record.owner, 'owner-b');
  assert.throws(() => lease.assertFence({ token: first.token, epoch: first.epoch, base_revision: 'rev-1' }),
    { code: 'WRITER_FENCED' });
}));

test('acquire never takes over a live holder, or a dead holder without a child-liveness check', () => fixture(({ stateRoot, worktree }) => {
  const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
  lease.acquire({ owner: 'owner-a', base_revision: 'rev-1' });
  let probed = false;
  assert.throws(() => lease.acquire({ owner: 'owner-b', base_revision: 'rev-1',
    holder_child: () => { probed = true; return null; } }), { code: 'WRITER_LEASED' });
  assert.equal(probed, false);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-dead-'));
  try {
    const dead = createPlanningWriterLease({ stateRoot: other, worktree, phaseDir: 'phase', ttlMs: 100_000 });
    deadHolderLease({ stateRoot: other, worktree });
    assert.throws(() => dead.acquire({ owner: 'owner-b', base_revision: 'rev-1' }), { code: 'WRITER_LEASED' });
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
}));

test('acquire refuses a dead holder whose launched child is alive, naming the child pid', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-state-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-lease-worktree-'));
  const first = deadHolderLease({ stateRoot, worktree });
  const launches = path.join(stateRoot, 'launches');
  fs.mkdirSync(launches);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(launches, 'a.launch.json'), JSON.stringify({ lease_epoch: first.epoch, child_pid: child.pid }));
    fs.writeFileSync(path.join(launches, 'stale.launch.json'), JSON.stringify({ lease_epoch: first.epoch + 7, child_pid: child.pid }));
    fs.writeFileSync(path.join(launches, 'broken.launch.json'), '{');
    const pidOf = (launch) => launch.child_pid;
    assert.equal(liveLaunchChild(launches, first.epoch, pidOf), child.pid);
    assert.equal(liveLaunchChild(launches, first.epoch + 1, pidOf), null);
    assert.equal(liveLaunchChild(path.join(stateRoot, 'absent'), first.epoch, pidOf), null);
    const lease = createPlanningWriterLease({ stateRoot, worktree, phaseDir: 'phase', ttlMs: 100_000 });
    let caught;
    try {
      lease.acquire({ owner: 'owner-b', base_revision: 'rev-2',
        holder_child: (held) => liveLaunchChild(launches, held.epoch, pidOf) });
    } catch (error) { caught = error; }
    assert.equal(caught.code, 'WRITER_LEASED');
    assert.equal(caught.details.child_pid, child.pid);
    assert.match(caught.message, new RegExp(`child pid ${child.pid}`));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const taken = lease.acquire({ owner: 'owner-b', base_revision: 'rev-2',
      holder_child: (held) => liveLaunchChild(launches, held.epoch, pidOf) });
    assert.equal(taken.epoch, first.epoch + 1);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
