'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const armer = require(path.join(SCRIPTS, 'stop-gate-arm.cjs'));
const scope = require(path.join(SCRIPTS, 'run-scope.cjs'));
const { createRunController } = require(path.join(SCRIPTS, 'run-controller.cjs'));
const waker = require(path.join(SCRIPTS, 'run-waker.cjs'));

const STOP_GATE_SRC = path.join(SCRIPTS, 'stop-gate.cjs');
const STOP_GATE_ARM_SRC = path.join(SCRIPTS, 'stop-gate-arm.cjs');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFront(dir, front) {
  fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-front.json'), JSON.stringify(front));
}

const fresh = () => new Date().toISOString();
const farFutureDueAt = () => Date.now() + 24 * 60 * 60 * 1000;

function newCounters() {
  return { polls: 0, modelTurns: 0, wakeClaims: 0 };
}

// @contract: polls=every observation; modelTurns=a block or waker launch; wakeClaims=waker claim reservations.
function callStopGate(counters, cwd, payload, env = {}) {
  counters.polls += 1;
  const r = spawnSync('node', [STOP_GATE_SRC], {
    cwd, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  const verdict = out ? JSON.parse(out) : null;
  if (verdict) counters.modelTurns += 1;
  return verdict;
}

async function callWakeOnce(counters, options) {
  counters.polls += 1;
  const result = await waker.wakeOnce(options);
  if (result.status === 'launched') { counters.modelTurns += 1; counters.wakeClaims += 1; }
  return result;
}

function beginRun(root, runId, ticket, worktree) {
  const storeDir = path.join(root, `runs-${runId}`);
  const controller = createRunController({ storeDir, ownerId: `owner-${runId}`, now: () => Date.now() });
  const run = scope.createRunScope({
    run_id: runId, repository_id: 'shipyard/phase41', phase: 41, ticket, worktree, runtime: 'claude',
    owner_id: `owner-${runId}`,
    dispatch: { dispatch_id: `dispatch-${runId}`, role: 'executor', model: 'sonnet', effort: 'high' },
  });
  controller.begin(run);
  return { controller, run, storeDir };
}

const scopedEnv = (storeDir) => ({ SHIPYARD_RUN_STORE_DIR: storeDir, SHIPYARD_RUN_CONTROL: 'scoped' });

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

suite('REQ-153 — six historical false replies: a foreign run\'s board never wakes the owner');

test('six repeated observations of another run\'s live board cost zero model turns; the owner\'s own dependency change wakes exactly once', () => {
  const root = tempDir('shipyard-p41-foreign-');
  try {
    const ownerWt = path.join(root, 'owner');
    const foreignWt = path.join(root, 'foreign');
    fs.mkdirSync(ownerWt, { recursive: true });
    writeFront(ownerWt, {
      generated_at: fresh(), actionable_count: 0, left_behind_count: 0, actionable: {}, fixpoint: true,
    });
    const { storeDir } = beginRun(root, 'p41-owner-run', 'T-41-03', ownerWt);
    const counters = newCounters();

    for (let i = 0; i < 6; i++) {
      writeFront(foreignWt, {
        generated_at: fresh(), actionable_count: 4, left_behind_count: 0,
        actionable: { execute: [], publish: [], fix: [], finalize: ['T-40-01', 'T-40-02', 'T-40-03', 'T-40-04'], merge: [] },
      });
      const verdict = callStopGate(counters, ownerWt, { run_id: 'p41-owner-run', session_id: 'p41-foreign-session' }, scopedEnv(storeDir));
      assert.equal(verdict, null, `observation ${i + 1} of the foreign run's board must not wake the owner`);
    }
    assert.equal(counters.polls, 6, 'each of the six historical observations is a separately counted shell poll');
    assert.equal(counters.modelTurns, 0, 'zero of the six historical false-reply shapes may cost a model turn once scoped');

    writeFront(ownerWt, {
      generated_at: fresh(), actionable_count: 1, left_behind_count: 0,
      actionable: { execute: ['T-41-03'], publish: [], fix: [], finalize: [], merge: [] },
    });
    const woken = callStopGate(counters, ownerWt, { run_id: 'p41-owner-run', session_id: 'p41-foreign-session' }, scopedEnv(storeDir));
    assert.ok(woken && woken.decision === 'block', 'a relevant owner (dependency) transition must wake the run');
    assert.match(woken.reason, /T-41-03/, 'the wake names the ticket that became actionable');
    assert.equal(counters.modelTurns, 1, 'exactly one model turn is spent on the one relevant transition');

    const repeat = callStopGate(
      counters, ownerWt,
      { run_id: 'p41-owner-run', session_id: 'p41-foreign-session', stop_hook_active: true },
      scopedEnv(storeDir),
    );
    assert.equal(repeat, null, 'an unchanged repeat of the same wake must not cost a second model turn');
    assert.equal(counters.modelTurns, 1, 'the repeated observation adds no further model turn');
    assert.equal(counters.polls, 8, 'the repeat is still a separately counted poll');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('REQ-153 — an unarmed session is immune to any board, including its own');

test('an unarmed session observes a live board three times and never wakes; arming the same session does', () => {
  const cwd = tempDir('shipyard-p41-unarmed-');
  try {
    writeFront(cwd, {
      generated_at: fresh(), actionable_count: 2, left_behind_count: 0,
      actionable: { execute: ['T-01-01'], fix: [], publish: [], finalize: [], merge: ['T-01-02'] },
    });
    const sessionId = 'p41-unarmed-session-000000';
    assert.equal(armer.isArmed(cwd, sessionId), false, 'the session starts unarmed');
    const counters = newCounters();
    for (let i = 0; i < 3; i++) {
      const verdict = callStopGate(counters, cwd, { session_id: sessionId });
      assert.equal(verdict, null, `unarmed observation ${i + 1} must not wake the model`);
    }
    assert.equal(counters.polls, 3);
    assert.equal(counters.modelTurns, 0, 'an unarmed session is never woken, even by its own live board');

    armer.arm(cwd, sessionId);
    assert.ok(armer.isArmed(cwd, sessionId), 'arm() records the session as armed');
    const armedVerdict = callStopGate(counters, cwd, { session_id: sessionId });
    assert.ok(armedVerdict && armedVerdict.decision === 'block',
      'the SAME live board wakes the SAME session once armed — the prior silence was not vacuous');
    assert.equal(counters.modelTurns, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

suite('REQ-153 — unchanged waiting work costs polls, never a wake');

test('repeated observation of an unmoved CI wait claims nothing', async () => {
  const root = tempDir('shipyard-p41-unchanged-');
  try {
    const worktree = path.join(root, 'owner');
    const { controller, run, storeDir } = beginRun(root, 'p41-ci-wait-run', 'T-41-03', worktree);
    controller.wait(run.run_id, { event_id: 'wait-ci-1', wake_id: 'wake-ci-1', kind: 'ci', due_at: farFutureDueAt() });
    let launches = 0;
    const launchNext = () => { launches += 1; return { step: launches }; };
    const counters = newCounters();

    for (let i = 0; i < 4; i++) {
      const result = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller, launchNext });
      assert.equal(result.status, 'waiting', `poll ${i + 1} must see the unchanged wait as still waiting`);
      assert.equal(result.readiness.ready, false);
    }
    assert.equal(counters.polls, 4, 'every observation is a separately counted poll');
    assert.equal(counters.modelTurns, 0, 'an unmoved wait condition never costs a model turn');
    assert.equal(counters.wakeClaims, 0, 'an unmoved wait condition never reserves a wake claim');
    assert.equal(launches, 0, 'the waker never launches a fresh model turn for an unmoved wait');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('REQ-153 — a changed owning CI revision claims one wake; a repeated observation claims none');

test('a recorded CI wake event launches once; the run then reads as running, not re-wakeable', async () => {
  const root = tempDir('shipyard-p41-ci-change-');
  try {
    const worktree = path.join(root, 'owner');
    const { controller, run, storeDir } = beginRun(root, 'p41-ci-change-run', 'T-41-03', worktree);
    controller.wait(run.run_id, { event_id: 'wait-ci-2', wake_id: 'wake-ci-2', kind: 'ci', due_at: farFutureDueAt() });
    let launches = 0;
    const launchNext = () => { launches += 1; return { step: launches }; };
    const counters = newCounters();

    const unchanged = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller, launchNext });
    assert.equal(unchanged.status, 'waiting');

    waker.recordWakeEvent({ store_dir: storeDir, run_id: run.run_id, kind: 'ci', wake_id: 'wake-ci-2', event_id: 'event-ci-2' });
    const changed = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller, launchNext });
    assert.equal(changed.status, 'launched', 'a changed owning CI revision claims a wake');
    assert.equal(launches, 1);
    assert.equal(counters.wakeClaims, 1, 'exactly one wake claim is reserved for the one relevant CI change');
    assert.equal(counters.modelTurns, 1, 'exactly one model turn is requested for the one relevant CI change');

    const replay = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller, launchNext });
    assert.notEqual(replay.status, 'launched', 'a repeated observation after the run woke must not launch again');
    assert.equal(launches, 1, 'the repeated observation costs no further launch');
    assert.equal(counters.wakeClaims, 1, 'the repeated observation reserves no further wake claim');
    assert.equal(counters.modelTurns, 1, 'the repeated observation requests no further model turn');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('REQ-153 — a changed owning review revision claims one wake; a duplicate claim is refused');

test('a duplicate observation of the same review wake event is refused by the durable claim store', async () => {
  const root = tempDir('shipyard-p41-review-change-');
  try {
    const worktree = path.join(root, 'owner');
    const { controller, run, storeDir } = beginRun(root, 'p41-review-change-run', 'T-41-03', worktree);
    controller.wait(run.run_id, { event_id: 'wait-review-2', wake_id: 'wake-review-2', kind: 'review', due_at: farFutureDueAt() });
    waker.recordWakeEvent({
      store_dir: storeDir, run_id: run.run_id, kind: 'review', wake_id: 'wake-review-2', event_id: 'event-review-2',
    });
    let launches = 0;
    const launchNext = () => { launches += 1; return { step: launches }; };
    // @invariant: this stub never mutates run state, isolating the claim-store dedup from state-transition blocking.
    const stubController = { wake: () => ({ woken: true }) };
    const counters = newCounters();

    const first = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller: stubController, launchNext });
    assert.equal(first.status, 'launched', 'a changed owning review revision claims one wake');
    assert.equal(launches, 1);
    assert.equal(counters.wakeClaims, 1);

    const duplicate = await callWakeOnce(counters, { run_id: run.run_id, store_dir: storeDir, controller: stubController, launchNext });
    assert.equal(duplicate.status, 'already-launched', 'the durable claim store refuses a duplicate wake for the same condition');
    assert.equal(launches, 1, 'the duplicate claim triggers no second launch');
    assert.equal(counters.wakeClaims, 1, 'the duplicate claim reserves no second wake claim');
    assert.equal(counters.modelTurns, 1, 'the duplicate claim requests no second model turn');
    assert.equal(duplicate.claim.key, first.claim.key, 'both observations resolve to the same durable claim key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('REQ-153 — installed identity is reported separately from source integration');

test('an installed copy identical to source reports matching digests; a stale one sharing the same version does not', () => {
  const root = tempDir('shipyard-p41-installed-');
  try {
    const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const sourceDigest = { stop_gate: sha256(STOP_GATE_SRC), stop_gate_arm: sha256(STOP_GATE_ARM_SRC) };

    const bundleOk = path.join(root, 'bundle-ok');
    const bundleStale = path.join(root, 'bundle-stale');
    fs.mkdirSync(bundleOk, { recursive: true });
    fs.mkdirSync(bundleStale, { recursive: true });

    fs.copyFileSync(STOP_GATE_SRC, path.join(bundleOk, 'stop-gate.cjs'));
    fs.copyFileSync(STOP_GATE_ARM_SRC, path.join(bundleOk, 'stop-gate-arm.cjs'));
    fs.writeFileSync(path.join(bundleOk, 'version.json'), JSON.stringify({ shipyard_version: '9.9.9' }));

    fs.writeFileSync(path.join(bundleStale, 'stop-gate.cjs'),
      fs.readFileSync(STOP_GATE_SRC, 'utf8').replace("'stop-gate-ledger.json'", "'stop-gate-ledger-old.json'"));
    fs.copyFileSync(STOP_GATE_ARM_SRC, path.join(bundleStale, 'stop-gate-arm.cjs'));
    fs.writeFileSync(path.join(bundleStale, 'version.json'), JSON.stringify({ shipyard_version: '9.9.9' }));

    function installedIdentity(bundleDir) {
      const version = JSON.parse(fs.readFileSync(path.join(bundleDir, 'version.json'), 'utf8')).shipyard_version;
      const digest = {
        stop_gate: sha256(path.join(bundleDir, 'stop-gate.cjs')),
        stop_gate_arm: sha256(path.join(bundleDir, 'stop-gate-arm.cjs')),
      };
      const matchesSource = digest.stop_gate === sourceDigest.stop_gate && digest.stop_gate_arm === sourceDigest.stop_gate_arm;
      return { version, digest, matchesSource };
    }

    const ok = installedIdentity(bundleOk);
    const stale = installedIdentity(bundleStale);

    assert.equal(ok.matchesSource, true, 'a byte-identical installed bundle reports as matching the source digest');
    assert.equal(stale.matchesSource, false, 'a stale installed bundle must not report as matching, regardless of its version marker');
    assert.equal(ok.version, stale.version, 'both installed bundles claim the SAME package version');
    assert.notEqual(stale.digest.stop_gate, ok.digest.stop_gate,
      'the version marker alone cannot distinguish them — only the installed-path digest can');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the source digest alone says nothing about whether any installation exists', () => {
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sourceDigest = { stop_gate: sha256(STOP_GATE_SRC), stop_gate_arm: sha256(STOP_GATE_ARM_SRC) };
  assert.match(sourceDigest.stop_gate, /^[0-9a-f]{64}$/);
  assert.match(sourceDigest.stop_gate_arm, /^[0-9a-f]{64}$/);
  const missingBundle = path.join(tempDir('shipyard-p41-missing-'), 'bundle');
  assert.equal(fs.existsSync(path.join(missingBundle, 'stop-gate.cjs')), false,
    'source integration passing this suite proves nothing about an absent installation — that is a separate, release-time check');
});

suite('REQ-153 — the arm/isArmed caller identity is scoped per repository');

test('the same session id armed in one repository does not arm it in another', () => {
  const root = tempDir('shipyard-p41-armscope-');
  try {
    const repoA = path.join(root, 'repoA');
    const repoB = path.join(root, 'repoB');
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 't@example.com');
      git(repo, 'config', 'user.name', 'T');
    }
    const sessionId = 'p41-cross-repo-session-01';
    const markerA = armer.arm(repoA, sessionId);
    assert.ok(armer.isArmed(repoA, sessionId), 'the session is armed where it called arm()');
    assert.equal(armer.isArmed(repoB, sessionId), false, 'the SAME session id is not armed in a different repository');
    assert.notEqual(markerA, armer.markerPath(repoB, sessionId),
      'each repository owns a distinct marker path — the caller\'s installed identity, apart from any source digest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

done();
