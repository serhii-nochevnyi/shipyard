'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('./lib.cjs');

const ITERATIONS = 5;
const LEGACY_MEMBERS = 64;
const LOCK_BOUND_MS = 5000;
const MARGIN_MS = 6000;

const fixture = lib.createFixture();

function loadRoleArtifact() {
  return require(path.join(fixture.scriptsDir, 'role-artifact.cjs'));
}

function seedLegacy(projectRoot) {
  const directory = path.join(projectRoot, '.planning/graph/provenance');
  fs.mkdirSync(directory, { recursive: true });
  const bytes = new Map();
  for (let index = 0; index < LEGACY_MEMBERS; index++) {
    const name = `legacy-${String(index).padStart(2, '0')}.json`;
    const content = JSON.stringify({ legacy: index, nonce: crypto.randomBytes(8).toString('hex') }) + '\n';
    fs.writeFileSync(path.join(directory, name), content);
    bytes.set(name, content);
  }
  return { directory, bytes };
}

function assertSidecars(seed) {
  assert.deepEqual(fs.readdirSync(seed.directory).filter((name) => name.startsWith('legacy-')).sort(), [...seed.bytes.keys()].sort());
  for (const [name, content] of seed.bytes) {
    assert.equal(fs.readFileSync(path.join(seed.directory, name), 'utf8'), content, `sidecar ${name} changed`);
  }
}

function barrierWrapper() {
  const file = path.join(fixture.workRoot, 'barrier.cjs');
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
const [ready, script, ...rest] = process.argv.slice(2);
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(ready)) Atomics.wait(cell, 0, 0, 5);
process.argv = [process.argv[0], script, ...rest];
require('node:module').runMain();
`);
  return file;
}

function startHost(script, args, extraEnv, ready, wrapper) {
  const child = spawn(process.execPath, ['--require', fixture.guard.file, wrapper, ready, script, ...args], {
    cwd: fixture.project, env: { PATH: fixture.path, HOME: fixture.home, ...extraEnv },
  });
  const result = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
  return result;
}

function codexRequest(project, tag) {
  const file = path.join(fixture.workRoot, `codex-request-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify({
    scope: {
      run_id: `concurrency-${tag}`, ticket: project.otherTicket, phase: project.otherPhase,
      worktree: project.root, runtime: 'codex', provider: 'openai',
    },
    role: 'pr-sentinel',
    signals: {},
    context: { prompt: 'Guard the open pull request of the fixture ticket and report what you performed or refused.' },
  }));
  return file;
}

const claudeLayout = lib.stageClaudeLayout(fixture);
const fakeClaude = lib.installFakeClaude(fixture);
const codexHost = path.join(fixture.scriptsDir, 'codex-delivery-host.cjs');
const claudeHost = path.join(claudeLayout.scriptsDir, 'claude-role-host.cjs');
const wrapper = barrierWrapper();
const PRE_ADMISSION = /PREFLIGHT_FAILED|STALE_CONTEXT|BASE_REVISION_UNAVAILABLE/;

function explain(label, outcome, run) {
  return `${label}: ${JSON.stringify(outcome)}\n${String(run.stderr).slice(0, 1500)}`;
}

function assertAllowed(label, outcome, run) {
  assert.ok(['reached', 'refused'].includes(outcome.kind), explain(label, outcome, run));
  if (outcome.kind === 'refused') {
    assert.deepEqual(outcome.labels, ['ARCHIVE_AUTHORITY_BUSY'], explain(label, outcome, run));
    assert.equal(outcome.execs, 0, explain(label, outcome, run));
    assert.match(run.stderr, /pid \d+/, explain(label, outcome, run));
    assert.match(run.stderr, /role-archive-authority/, explain(label, outcome, run));
  }
}

async function concurrentPair(project, tag, ready) {
  const claudeRequest = lib.writeClaudeRoleRequest(fixture, project);
  const codexBefore = fixture.readCodexLog().length;
  const claudeBefore = fakeClaude.readLog().length;
  const codex = startHost(codexHost, ['--args-file', codexRequest(project, tag)], {}, ready, wrapper);
  const claude = startHost(claudeHost, ['--args-file', claudeRequest], claudeLayout.env, ready, wrapper);
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(ready, '');
  const [codexRun, claudeRun] = await Promise.all([codex, claude]);
  const codexLines = fixture.readCodexLog().slice(codexBefore);
  const claudeLines = fakeClaude.readLog().slice(claudeBefore);
  return {
    codex: { run: codexRun, lines: codexLines, outcome: lib.classifyLaunch(codexRun, codexLines) },
    claude: { run: claudeRun, lines: claudeLines, outcome: lib.classifyLaunch(claudeRun, claudeLines) },
  };
}

function sequentialClaude(project) {
  const request = lib.writeClaudeRoleRequest(fixture, project);
  return new Promise((resolve) => {
    const before = fakeClaude.readLog().length;
    const ready = path.join(fixture.workRoot, `ready-seq-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(ready, '');
    startHost(claudeHost, ['--args-file', request], claudeLayout.env, ready, wrapper).then((run) => {
      const lines = fakeClaude.readLog().slice(before);
      resolve({ run, lines, outcome: lib.classifyLaunch(run, lines) });
    });
  });
}

function lockHolder(project, heldMs, signalFile) {
  const script = `
const path = require('node:path'), fs = require('node:fs');
const ra = require(${JSON.stringify(path.join(fixture.scriptsDir, 'role-artifact.cjs'))});
const lock = require(${JSON.stringify(path.join(fixture.scriptsDir, 'lock.cjs'))});
const directory = ra.archiveAuthorityDirectory(${JSON.stringify(project.root)}, true);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const held = lock.acquire(directory, 'catalogue', { waitMs: 0, label: 'role-archive-authority' });
if (!held) process.exit(3);
fs.writeFileSync(${JSON.stringify(signalFile)}, String(process.pid));
lock.sleepSync(${heldMs});
held.release();
`;
  const child = spawn(process.execPath, ['-e', script], { env: { PATH: fixture.path, HOME: fixture.home } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on('close', (status) => resolve({ status, stderr })));
  return { child, done };
}

async function waitForFile(file) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function heldLockShape(index, heldMs, expected) {
  const project = lib.stageClaudeProject(fixture, `held-${index}`);
  seedLegacy(project.root);
  const signal = path.join(fixture.workRoot, `held-${index}.signal`);
  const holder = lockHolder(project, heldMs, signal);
  await waitForFile(signal);
  const ready = path.join(fixture.workRoot, `held-ready-${index}`);
  fs.writeFileSync(ready, '');
  const before = fixture.readCodexLog().length;
  const started = Date.now();
  const run = await startHost(codexHost, ['--args-file', codexRequest(project, `held-${index}`)], {}, ready, wrapper);
  const waited = Date.now() - started;
  const lines = fixture.readCodexLog().slice(before);
  const outcome = lib.classifyLaunch(run, lines);
  const released = await holder.done;
  assert.equal(released.status, 0, released.stderr);
  assert.equal(outcome.kind, expected, explain('held-lock', outcome, run));
  assert.ok(waited < LOCK_BOUND_MS + MARGIN_MS, `host waited ${waited} ms, beyond the bound plus margin`);
  if (expected === 'refused') {
    assertAllowed('held-lock', outcome, run);
    assert.ok(waited >= LOCK_BOUND_MS - 500, `refusal came after only ${waited} ms`);
  } else {
    assert.equal(lines.length, 1);
  }
  return project;
}

function assertNoOrphanLock(project) {
  const directory = loadRoleArtifact().archiveAuthorityDirectory(project.root);
  assert.equal(fs.existsSync(path.join(directory, 'catalogue.lock')), false, 'an orphaned catalogue lock remains');
}

function adoptionSnapshot(project, seed) {
  const roleArtifact = loadRoleArtifact();
  const members = roleArtifact.legacyBookkeepingMembers(project.root);
  assert.equal(members.length, LEGACY_MEMBERS, 'adoption must record every legacy member exactly once');
  assert.ok(Array.isArray(roleArtifact.historicalBookkeepingPins(project.root)), 'the catalogue must authenticate');
  const state = JSON.parse(fs.readFileSync(path.join(roleArtifact.archiveAuthorityDirectory(project.root), 'catalogue.json'), 'utf8'));
  assert.equal(Object.keys(state.payload).filter((key) => key === 'legacy_bookkeeping').length, 1);
  assertSidecars(seed);
  return JSON.stringify(members);
}

async function main() {
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  const os = require('node:os');
  const homedir = os.homedir;
  os.homedir = () => fixture.home;
  try {
    const summary = [];
    for (let index = 0; index < ITERATIONS; index++) {
      const project = lib.stageClaudeProject(fixture, `concurrency-${index}`);
      const seed = seedLegacy(project.root);
      const ready = path.join(fixture.workRoot, `ready-${index}`);
      const pair = await concurrentPair(project, `pair-${index}`, ready);
      assertAllowed(`iteration ${index} codex`, pair.codex.outcome, pair.codex.run);
      assertAllowed(`iteration ${index} claude`, pair.claude.outcome, pair.claude.run);
      assert.ok([pair.codex, pair.claude].some((host) => host.outcome.kind === 'reached'),
        `iteration ${index}: at least one host must be reached`);
      assert.doesNotMatch(pair.claude.run.stderr, PRE_ADMISSION, `iteration ${index}: the Claude host stopped before admission`);
      assert.ok(pair.claude.lines.length <= 1 && pair.codex.lines.length <= 1);
      summary.push(`${pair.codex.outcome.kind}/${pair.claude.outcome.kind}`);
      assertNoOrphanLock(project);
      const members = adoptionSnapshot(project, seed);

      const third = index % 2 === 0 ? await sequentialClaude(project) : null;
      let thirdLaunch = third;
      if (!thirdLaunch) {
        const before = fixture.readCodexLog().length;
        const run = lib.runHost(fixture, codexHost, ['--args-file', codexRequest(project, `third-${index}`)]);
        const lines = fixture.readCodexLog().slice(before);
        thirdLaunch = { run, lines, outcome: lib.classifyLaunch(run, lines) };
      }
      assert.equal(thirdLaunch.outcome.kind, 'reached', explain(`iteration ${index} third`, thirdLaunch.outcome, thirdLaunch.run));
      assert.equal(thirdLaunch.lines.length, 1);
      assert.equal(adoptionSnapshot(project, seed), members, 'a further admission changed the adopted legacy members');
      assertNoOrphanLock(project);
    }

    const shorter = await heldLockShape(0, 1500, 'reached');
    assertNoOrphanLock(shorter);
    const longer = await heldLockShape(1, LOCK_BOUND_MS + 3000, 'refused');
    assertNoOrphanLock(longer);

    assert.equal(lib.runWriteGuardControl(fixture).length, 1, 'the write guard must record a write beside the work root');
    lib.assertHarnessIsolation(fixture, { admitted: true });
    console.log(`installed-launch concurrency: OK (${ITERATIONS} iterations codex/claude: ${summary.join(' ')}; held-lock reached and refused)`);
  } finally {
    os.homedir = homedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
}

main().then(() => fixture.cleanup(), (error) => {
  console.error(error && error.stack ? error.stack : error);
  fixture.cleanup();
  process.exit(1);
});
