'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'wait-events.cjs'
);

function graph() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-wait-events-'));
  const graphDir = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  return graphDir;
}

function context(graphDir) {
  return {
    graphDir,
    run_id: 'run-33-01',
    ticket: 'T-33-01',
    repository: 'acme/widgets',
    pr: 101,
    head: 'head-a',
  };
}

function loadWaitEvents() {
  delete require.cache[require.resolve(SCRIPT)];
  return require(SCRIPT);
}

function store(graphDir) {
  return JSON.parse(fs.readFileSync(path.join(graphDir, 'wait-events.json'), 'utf8'));
}

function ghStub(root, rows, exit = 0) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    `cat <<'JSON'\n${JSON.stringify(rows)}\nJSON\n` +
    `exit ${exit}\n`, { mode: 0o755 });
  return bin;
}

function realStateSyncFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-state-sync-publish-'));
  const graphDir = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
    git: { base_branch: 'main' },
    delivery_pipeline: { integration_mode: 'direct-to-main', gsd_sync: false },
  }));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: {
    'T-33-01': { phase: '33', wave: 1, branch: 'ticket/T-33-01', depends_on: [] },
  } }));
  const modeFile = path.join(root, 'gh-mode');
  fs.writeFileSync(modeFile, 'pending');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const pendingPr = {
    number: 101, state: 'OPEN', isDraft: false, headRefName: 'ticket/T-33-01',
    headRefOid: 'head-a', baseRefName: 'main', mergedAt: null,
    createdAt: '2026-09-16T00:00:00Z', url: 'https://example.test/pr/101', title: 'T-33-01',
    reviewDecision: 'APPROVED', body: '', mergeStateStatus: 'CLEAN',
  };
  const greenPr = { ...pendingPr, headRefOid: 'head-b' };
  const reviewPr = { ...pendingPr, reviewDecision: 'CHANGES_REQUESTED' };
  fs.writeFileSync(path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    `mode=$(cat ${JSON.stringify(modeFile)})\n` +
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then\n' +
    `  if [ "$mode" = "pending" ]; then cat <<'JSON'\n${JSON.stringify([pendingPr])}\nJSON\n` +
    `  elif [ "$mode" = "review" ]; then cat <<'JSON'\n${JSON.stringify([reviewPr])}\nJSON\n` +
    `  else cat <<'JSON'\n${JSON.stringify([greenPr])}\nJSON\n` +
    '  fi\n' +
    '  exit 0\n' +
    'fi\n' +
    'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\n' +
    `  if [ "$mode" != "green" ]; then cat <<'JSON'\n${JSON.stringify([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }])}\nJSON\n    exit 8\n` +
    `  else cat <<'JSON'\n${JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }])}\nJSON\n    exit 0\n` +
    '  fi\n' +
    'fi\n' +
    'if [ "$1" = "api" ]; then\n' +
    '  case "$2" in\n' +
    '    */compare/*) printf "0\\n" ;;\n' +
    '    *) printf "main\\n" ;;\n' +
    '  esac\n' +
    '  exit 0\n' +
    'fi\n' +
    'echo "unhandled gh fixture: $*" >&2\n' +
    'exit 1\n', { mode: 0o755 });
  return { root, graphDir, modeFile, bin };
}

function runStateSync(fixture, failAfter = null) {
  const env = {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH}`,
  };
  if (failAfter) env.SHIPYARD_STATE_SYNC_FAIL_AFTER = failAfter;
  else delete env.SHIPYARD_STATE_SYNC_FAIL_AFTER;
  return spawnSync(process.execPath, [STATE_SYNC], {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

function runCiWait(fixture, args) {
  const env = { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` };
  return spawnSync(process.execPath, [CI_WAIT, '--graph', fixture.graphDir, ...args], {
    cwd: fixture.root,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

async function waitForFile(file, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fs.existsSync(file);
}

const CI_WAIT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'ci-wait.cjs'
);
const STATE_SYNC = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'state-sync.cjs'
);

suite('wait-events — durable semantic transition delivery');

test('an unchanged pending sequence does not dispatch, but a failure transition replays one action after restart', () => {
  // This is the first RED assertion for the ticket. Keep it a behavior assertion
  // rather than an import/fixture failure while the producer is still absent.
  assert.equal(fs.existsSync(SCRIPT), true, 'the durable waiter producer exists');
  if (!fs.existsSync(SCRIPT)) return;

  const waitEvents = require(SCRIPT);
  const graphDir = graph();
  const ctx = context(graphDir);
  const pendingChecks = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const failedChecks = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };

  const first = waitEvents.observe({ ...ctx, observation: pendingChecks }, { now: 1000 });
  assert.equal(first.action, null, 'the initial pending observation is only a baseline');

  const unchanged = waitEvents.observe({ ...ctx, observation: pendingChecks }, { now: 2000 });
  assert.equal(unchanged.action, null, 'an unchanged pending sequence yields no model work');

  const changed = waitEvents.observe({ ...ctx, observation: failedChecks }, { now: 3000 });
  assert.ok(changed.action, 'pending-to-failed creates a model-work event');
  assert.equal(changed.transition_sequence, 1, 'the first semantic transition is sequenced');

  delete require.cache[require.resolve(SCRIPT)];
  const restarted = require(SCRIPT);
  const delivered = restarted.pending(ctx, { now: 4000 });
  assert.equal(delivered.action_id, changed.action.action_id, 'restart recovers the same action');
  assert.equal(delivered.dispatch_id, changed.action.dispatch_id, 'replay keeps one dispatch identity');

  const replay = restarted.pending(ctx, { now: 5000 });
  assert.equal(replay.action_id, changed.action.action_id, 'an unacknowledged action is redelivered');
  assert.equal(replay.replay, true, 'the second read is identified as a replay');

  const ack = restarted.acknowledge(ctx, {
    action_id: changed.action.action_id,
    dispatch_id: changed.action.dispatch_id,
    decision: 'reserved',
    now: 6000,
  });
  assert.equal(ack.acknowledged, true, 'the durable reservation can be acknowledged');
});

suite('wait-events — semantic identity, review facts and bounded wake');

test('reordering checks/reviews and changing timestamps does not create a transition', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const a = {
    checks: [
      { name: 'lint', state: 'SUCCESS', bucket: 'pass', completed_at: '2026-09-16T01:00:00Z' },
      { name: 'build', state: 'IN_PROGRESS', bucket: 'pending', completed_at: '2026-09-16T01:01:00Z' },
    ],
    reviews: [
      { reviewer: 'copilot', state: 'COMMENTED', submitted_at: '2026-09-16T01:00:00Z' },
      { reviewer: 'coderabbit', state: 'PENDING', submitted_at: '2026-09-16T01:02:00Z' },
    ],
  };
  const b = {
    checks: [a.checks[1], a.checks[0]],
    reviews: [a.reviews[1], a.reviews[0]],
  };
  waitEvents.observe({ ...ctx, observation: a }, { now: 1000 });
  const result = waitEvents.observe({ ...ctx, observation: b }, { now: 2000 });
  assert.equal(result.changed, false, 'response ordering and timestamps are incidental');
  assert.equal(result.transition_sequence, 0, 'no semantic transition was recorded');
  assert.equal(result.action, null, 'reordered pending facts do not wake model work');
});

test('ABA is a new transition even when the digest returns to its first value', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const a = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const b = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
  waitEvents.observe({ ...ctx, observation: a }, { now: 1000 });
  const first = waitEvents.observe({ ...ctx, observation: b }, { now: 2000 });
  waitEvents.pending(ctx, { now: 2050 });
  waitEvents.acknowledge(ctx, { action_id: first.action.action_id, dispatch_id: first.action.dispatch_id, decision: 'no-action', now: 2100 });
  const back = waitEvents.observe({ ...ctx, observation: a }, { now: 3000 });
  assert.equal(back.transition_sequence, 2, 'A→B→A has two transitions, not one digest toggle');
  assert.ok(back.action, 'returning to A is a meaningful transition');
  assert.notEqual(back.action.action_id, first.action.action_id, 'ABA cannot reuse a prior action');
});

test('a review-only change wakes while CI remains pending', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const pendingCi = {
    checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }],
    reviews: [{ reviewer: 'coderabbit', state: 'PENDING' }],
  };
  const reviewChanged = {
    checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }],
    reviews: [{ reviewer: 'coderabbit', state: 'CHANGES_REQUESTED' }],
  };
  waitEvents.observe({ ...ctx, observation: pendingCi }, { now: 1000 });
  const result = waitEvents.observe({ ...ctx, observation: reviewChanged }, { now: 2000 });
  assert.ok(result.action, 'review transition creates a compact model-work event');
  assert.equal(result.action.reason, 'semantic-observation-transition');
});

test('full and partial outages remain unknown and cannot create a model-work event', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const healthy = {
    checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }],
    reviews: [{ reviewer: 'coderabbit', state: 'PENDING' }],
  };
  const partial = { checks: null, reviews: healthy.reviews };
  const full = { checks: null, reviews: null };
  waitEvents.observe({ ...ctx, observation: healthy }, { now: 1000 });
  const p = waitEvents.observe({ ...ctx, observation: partial }, { now: 2000 });
  assert.equal(p.action, null, 'a partial outage does not wake from incomplete evidence');
  assert.equal(p.record.observation_availability, 'partial');
  const f = waitEvents.observe({ ...ctx, observation: full }, { now: 3000 });
  assert.equal(f.action, null, 'a full outage is not a semantic work request');
  assert.equal(f.record.observation_availability, 'unknown');
});

test('recovery compares against the last trusted observation instead of losing a change in the outage', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const healthyA = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const outage = { checks: null };
  const healthyB = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
  waitEvents.observe({ ...ctx, observation: healthyA }, { now: 1000 });
  waitEvents.observe({ ...ctx, observation: outage }, { now: 2000 });
  const same = waitEvents.observe({ ...ctx, observation: healthyA }, { now: 3000 });
  assert.equal(same.action, null, 'recovering to the last trusted fact is not a new transition');
  const changed = waitEvents.observe({ ...ctx, observation: healthyB }, { now: 4000 });
  assert.ok(changed.action, 'a real change learned after recovery is not lost');
});

test('the deadline and capped backoff survive a process restart', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const observation = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const first = waitEvents.observe({ ...ctx, observation }, { now: 1000, timeout_ms: 1000, interval_ms: 100 });
  assert.equal(Date.parse(first.deadline), 2000, 'the deadline is persisted');
  assert.equal(first.backoff, 100, 'the first wake uses the configured interval');
  const second = waitEvents.observe({ ...ctx, observation }, { now: 1100, timeout_ms: 999999, interval_ms: 100 });
  assert.equal(second.backoff, 200, 'unchanged observations use bounded exponential backoff');
  assert.equal(Date.parse(second.deadline), 2000, 'a restart cannot extend the deadline');
  const restarted = loadWaitEvents();
  const terminal = restarted.observe({ ...ctx, observation }, { now: 2000, timeout_ms: 999999, interval_ms: 100 });
  assert.equal(terminal.terminal.event_type, 'timeout', 'deadline expiry is a terminal event');
  assert.equal(terminal.action, null, 'timeout is never success or model work');
  const late = restarted.observe({ ...ctx, observation: { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] } }, { now: 3000, interval_ms: 100 });
  assert.equal(late.action, null, 'a transition after the deadline cannot become a late model request');
});

test('an active window resumes, while a completed window gets a fresh deadline', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const observationA = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const observationB = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
  const first = waitEvents.observe({ ...ctx, observation: observationA, window_id: 'window-a' }, {
    now: 1000, timeout_ms: 1000, interval_ms: 100,
  });
  const resumed = waitEvents.observe({ ...ctx, observation: observationA, window_id: 'window-b' }, {
    now: 1100, timeout_ms: 999999, interval_ms: 100,
  });
  assert.equal(Date.parse(resumed.deadline), Date.parse(first.deadline),
    'a restart before terminal expiry keeps the active window deadline');
  const terminal = waitEvents.observe({ ...ctx, observation: observationA, window_id: 'window-a' }, {
    now: 2000, timeout_ms: 999999, interval_ms: 100,
  });
  assert.equal(terminal.terminal.event_type, 'timeout');
  const fresh = waitEvents.observe({ ...ctx, observation: observationB, window_id: 'window-c' }, {
    now: 3000, timeout_ms: 1000, interval_ms: 100,
  });
  assert.equal(fresh.terminal, null, 'a new wait window clears the previous terminal marker');
  assert.equal(Date.parse(fresh.deadline), 4000, 'the new window receives its own deadline');
  assert.ok(fresh.action, 'a transition in the new window is eligible for delivery');
});

test('actionable work interrupts waiting without manufacturing a model event', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const observation = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  waitEvents.observe({ ...ctx, observation }, { now: 1000 });
  const result = waitEvents.observe({ ...ctx, observation, eligibility: {
    actionable_count: 1,
    left_behind_count: 0,
    actionable: { execute: ['T-33-02'] },
    waiting: { dispatched: [] },
  } }, { now: 2000 });
  assert.equal(result.interrupted, true, 'newly actionable work lifts the wait');
  assert.equal(result.action, null, 'the dispatcher, not the waiter, owns actionable work');
});

test('a suppressed transition remains pending until unrelated actionable work is served', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const baseline = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const changed = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
  waitEvents.observe({ ...ctx, observation: baseline }, { now: 1000 });
  const suppressed = waitEvents.observe({ ...ctx, observation: changed, eligibility: {
    actionable_count: 1,
    left_behind_count: 0,
    actionable: { execute: ['T-33-02'] },
    waiting: { dispatched: [] },
  } }, { now: 2000 });
  assert.equal(suppressed.action, null, 'the active turn owns the actionable work');
  const delivered = waitEvents.observe({ ...ctx, observation: changed, eligibility: {
    actionable_count: 0,
    left_behind_count: 0,
    actionable: {},
    waiting: { dispatched: [] },
  } }, { now: 3000 });
  assert.ok(delivered.action, 'the suppressed transition is emitted after the turn is free');
});

test('CLI observe and pending share the graph-derived run id by default', () => {
  const graphDir = graph();
  const observationFile = path.join(path.dirname(graphDir), 'observation.json');
  fs.writeFileSync(observationFile, JSON.stringify({ checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] }));
  const common = ['--graph', graphDir, '--ticket', 'T-33-01', '--repository', 'acme/widgets', '--pr', '101', '--head', 'head-a'];
  const first = spawnSync(process.execPath, [SCRIPT, 'observe', ...common, '--observation-file', observationFile], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(first.status, 0, 'the CLI baseline succeeds');
  fs.writeFileSync(observationFile, JSON.stringify({ checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] }));
  const second = spawnSync(process.execPath, [SCRIPT, 'observe', ...common, '--observation-file', observationFile], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(second.status, 0, 'the CLI transition succeeds');
  const pending = spawnSync(process.execPath, [SCRIPT, 'pending', ...common], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(pending.status, 0, 'pending uses the producer default run id');
  assert.ok(JSON.parse(pending.stdout).action_id, 'the transition is addressable by the shared default');
});

test('duplicate acknowledgment is idempotent and leaves no pending action', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const a = waitEvents.observe({ ...ctx, observation: { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] } }, { now: 1000 });
  const b = waitEvents.observe({ ...ctx, observation: { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] } }, { now: 2000 });
  const consumed = waitEvents.pending(ctx, { now: 2500 });
  assert.equal(consumed.action_id, b.action.action_id, 'the action is durably consumed before it can be acknowledged');
  const ack = { action_id: b.action.action_id, dispatch_id: b.action.dispatch_id, decision: 'reserved', now: 3000 };
  const first = waitEvents.acknowledge(ctx, ack);
  const duplicate = waitEvents.acknowledge(ctx, ack);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true, 'a repeated acknowledgment does not create a second write');
  assert.equal(waitEvents.pending(ctx, { now: 4000 }), null, 'acknowledged work is no longer pending');
  assert.equal(a.action, null, 'the baseline did not create an untracked action');
});

test('malformed and newer stores refuse closed without erasing history', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const file = path.join(graphDir, 'wait-events.json');
  fs.writeFileSync(file, '{"schema_version":1,"records":');
  const malformed = waitEvents.observe({ ...ctx, observation: { checks: [] } }, { now: 1000 });
  assert.equal(malformed.code, 'STORE_MALFORMED');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"schema_version":1,"records":', 'malformed history is preserved');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, records: { corrupted: {} } }));
  const malformedRecord = waitEvents.observe({ ...ctx, observation: { checks: [] } }, { now: 1000 });
  assert.equal(malformedRecord.code, 'STORE_MALFORMED', 'a malformed record refuses without rebuilding history');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema_version: 1, records: { corrupted: {} } });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 99, records: {} }));
  const newer = waitEvents.pending(ctx, { now: 1000 });
  assert.equal(newer.code, 'STORE_NEWER_SCHEMA');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema_version: 99, records: {} },
    'a newer schema is not downgraded or erased');
});

test('two observer processes serialize one semantic transition', async () => {
  const graphDir = graph();
  const ctx = context(graphDir);
  const observationA = { checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }] };
  const observationB = { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] };
  const modulePath = JSON.stringify(SCRIPT);
  const encode = (observation) => JSON.stringify({ ...ctx, observation });
  const child = (observation) => new Promise((resolve, reject) => {
    const source = `const w=require(${modulePath}); process.stdout.write(JSON.stringify(w.observe(${encode(observation)},{now:2000})));`;
    const p = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (chunk) => { stdout += chunk; });
    p.stderr.on('data', (chunk) => { stderr += chunk; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `exit ${code}`)));
  });
  const baseline = loadWaitEvents();
  baseline.observe({ ...ctx, observation: observationA }, { now: 1000 });
  const results = await Promise.all([child(observationB), child(observationB)]);
  assert.equal(results.filter((r) => r.action).length, 1, 'only one concurrent observer creates the transition');
  const actions = Object.values(store(graphDir).records)[0].actions;
  assert.equal(Object.keys(actions).length, 1, 'the durable store contains one action');
  assert.equal(Object.values(store(graphDir).records)[0].transition_sequence, 1);
});

test('a killed ci-wait child leaves an event for the restarted command consumer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-ciwait-child-'));
  const graphDir = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'delivery-front.json'), JSON.stringify({
    actionable_count: 0, left_behind_count: 0,
    actionable: { execute: [], publish: [], fix: [], finalize: [], merge: [] },
    waiting: { ci: ['T-33-01'], dispatched: [], parent: [], merge_human: [], human: [] },
    fixpoint: false,
  }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({
    'T-33-01': { pr: 101, repo: 'acme/widgets', status: 'pr-open', head_sha: 'head-a' },
  }));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets: { 'T-33-01': {} } }));
  const bin = ghStub(root, [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }], 8);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const child = spawn(process.execPath, [CI_WAIT, '--graph', graphDir, '--run-id', 'restart-run', '--timeout', '10', '--interval', '1', '--json'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(await waitForFile(path.join(graphDir, 'wait-events.json')), true,
    'the killed waiter published before sleeping');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  ghStub(root, [{ name: 'build', state: 'FAILURE', bucket: 'fail' }], 1);
  const restarted = spawnSync(process.execPath, [CI_WAIT, '--graph', graphDir, '--run-id', 'restart-run', '--timeout', '1', '--interval', '1', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(restarted.status, 0, 'the restarted waiter returns normally on a live failure observation');
  const result = JSON.parse(restarted.stdout);
  assert.ok(result.wait_event && result.wait_event.action_id, 'the restarted waiter reports the durable action');

  const consumer = spawnSync(process.execPath, [SCRIPT, 'pending', '--graph', graphDir, '--run-id', 'restart-run', '--ticket', 'T-33-01', '--repository', 'acme/widgets', '--pr', '101', '--head', 'head-a'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(consumer.status, 0, 'the command consumer can reserve the event');
  const reserved = JSON.parse(consumer.stdout);
  assert.equal(reserved.action_id, result.wait_event.action_id, 'consumer and waiter share one action identity');
  const ack = spawnSync(process.execPath, [SCRIPT, 'acknowledge', '--graph', graphDir, '--run-id', 'restart-run', '--ticket', 'T-33-01', '--repository', 'acme/widgets', '--pr', '101', '--action-id', reserved.action_id, '--dispatch-id', reserved.dispatch_id, '--decision', 'reserved'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(ack.status, 0, 'the consumer acknowledges only after reserving dispatch');
  assert.equal(JSON.parse(ack.stdout).acknowledged, true);
});

suite('wait-events — published state binding and overlay recovery');

function publishedFixture(graphDir, waitEvents, state, front, projection, generation = 1) {
  const stateRaw = JSON.stringify(state, null, 2) + '\n';
  const frontRaw = JSON.stringify(front, null, 2) + '\n';
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), stateRaw);
  fs.writeFileSync(path.join(graphDir, 'delivery-front.json'), frontRaw);
  fs.writeFileSync(path.join(graphDir, 'delivery-state-meta.json'), JSON.stringify({
    schema_version: 1,
    generation,
    observation_generation: generation,
    observation_projection: projection,
    binding: {
      schema_version: 1,
      state_digest: waitEvents.digest(stateRaw),
      front_digest: waitEvents.digest(frontRaw),
      observation_digest: waitEvents.digest(projection),
      observation_generation: generation,
    },
  }, null, 2) + '\n');
}

function publishedState(checkState = 'IN_PROGRESS') {
  return { 'T-33-01': {
    pr: 101, repo: 'acme/widgets', head_sha: 'head-a', status: 'pr-open',
    checks: { total: 1, pending: checkState === 'IN_PROGRESS' ? 1 : 0, failing: checkState === 'FAILURE' ? 1 : 0 },
    review_decision: null,
  } };
}

function publishedFront() {
  return {
    actionable_count: 0,
    left_behind_count: 0,
    actionable: { execute: [], publish: [], fix: [], finalize: [], merge: [] },
    waiting: { ci: ['T-33-01'], dispatched: [], parent: [], merge_human: [], human: [] },
    fixpoint: false,
  };
}

test('the state-sync source publishes a versioned observation binding', () => {
  const source = fs.readFileSync(STATE_SYNC, 'utf8');
  assert.ok(/observation_projection/.test(source), 'state-sync persists a canonical observation projection');
  assert.ok(/state_digest/.test(source), 'state-sync binds authoritative state bytes');
  assert.ok(/observation_generation/.test(source), 'state-sync binds the observation generation');
});

test('an interrupted real publication is refused at every write boundary and repairs on restart', () => {
  for (const point of ['state', 'yaml', 'front', 'metadata']) {
    const fixture = realStateSyncFixture();
    const waitEvents = loadWaitEvents();
    const ctx = { ...context(fixture.graphDir), head: undefined };
    const initial = runStateSync(fixture);
    assert.equal(initial.status, 0, `${point}: the baseline state-sync publishes`);
    const baseline = waitEvents.observePublished(ctx, { now: 1000 });
    assert.equal(baseline.action, null, `${point}: the complete baseline is only a baseline`);

    fs.writeFileSync(fixture.modeFile, 'green');
    const interrupted = runStateSync(fixture, point);
    assert.notEqual(interrupted.status, 0, `${point}: the injected failure stops before final publication`);
    const refused = waitEvents.observePublished(ctx, { now: 2000 });
    assert.equal(refused.code, 'RESYNC_REQUIRED', `${point}: mixed bytes cannot wake work`);
    assert.equal(refused.action, null, `${point}: refusal has no dispatch action`);

    const repaired = runStateSync(fixture);
    assert.equal(repaired.status, 0, `${point}: a restart repairs the incomplete publication`);
    const transition = waitEvents.observePublished(ctx, { now: 3000 });
    assert.ok(transition.action, `${point}: the repaired semantic transition is published once`);
    const unchanged = waitEvents.observePublished(ctx, { now: 4000 });
    assert.equal(unchanged.action, null, `${point}: rereading the repaired snapshot does not duplicate work`);
  }
});

test('the real waiter refreshes the bound publisher before comparing live CI and review facts', () => {
  const fixture = realStateSyncFixture();
  const waitEvents = loadWaitEvents();
  const ctx = {
    graphDir: fixture.graphDir,
    run_id: 'publisher-run',
    ticket: 'T-33-01',
    repository: null,
    pr: 101,
    head: 'head-a',
  };
  assert.equal(runStateSync(fixture).status, 0, 'the publisher establishes the initial bound snapshot');
  const baseline = waitEvents.observe({
    ...ctx,
    observation: {
      checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }],
      review_decision: 'APPROVED',
      head: 'head-a',
    },
  }, { now: Date.now() });
  assert.equal(baseline.action, null, 'the seeded live facts establish only a baseline');

  fs.writeFileSync(fixture.modeFile, 'green');
  const result = runCiWait(fixture, ['--run-id', 'publisher-run', '--timeout', '3', '--interval', '1', '--json']);
  assert.equal(result.status, 0, 'the real waiter returns after the refreshed live transition');
  const output = JSON.parse(result.stdout);
  assert.equal(output.settled, 'T-33-01', 'the live check still controls settlement');
  assert.ok(output.wait_event && output.wait_event.action_id,
    'the refreshed publisher facts produce the durable transition event');
});

test('the real waiter wakes on a review transition while CI remains pending', () => {
  const fixture = realStateSyncFixture();
  const waitEvents = loadWaitEvents();
  const ctx = {
    graphDir: fixture.graphDir,
    run_id: 'review-wake-run',
    ticket: 'T-33-01',
    repository: null,
    pr: 101,
    head: 'head-a',
  };
  assert.equal(runStateSync(fixture).status, 0, 'the publisher establishes the pending baseline');
  const baseline = waitEvents.observe({
    ...ctx,
    observation: {
      checks: [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }],
      review_decision: 'APPROVED',
      head: 'head-a',
    },
  }, { now: Date.now() });
  assert.equal(baseline.action, null, 'the pending review facts establish only a baseline');

  fs.writeFileSync(fixture.modeFile, 'review');
  const result = runCiWait(fixture, [
    '--run-id', 'review-wake-run', '--timeout', '3', '--interval', '1', '--json',
  ]);
  assert.equal(result.status, 0, 'a semantic review wake is a normal waiter result');
  const output = JSON.parse(result.stdout);
  assert.equal(output.settled, null, 'CI remains pending when the review wake is delivered');
  assert.equal(output.transitioned, true, 'the waiter identifies the semantic wake');
  assert.ok(output.wait_event && output.wait_event.action_id,
    'the review transition is returned through the durable event contract');
  assert.ok(output.rounds < 3, 'the waiter returns before another polling interval');
});

test('mixed state/front bytes refuse an event, while a complete publication survives an overlay refresh', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const pending = publishedState();
  const projection = { tickets: { 'T-33-01': { checks: pending['T-33-01'].checks, review_decision: null } } };
  publishedFixture(graphDir, waitEvents, pending, publishedFront(), projection);
  const baseline = waitEvents.observePublished(ctx, { now: 1000 });
  assert.equal(baseline.action, null, 'a complete publication establishes a baseline');

  const mixed = publishedState('FAILURE');
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify(mixed, null, 2) + '\n');
  const refused = waitEvents.observePublished(ctx, { now: 2000 });
  assert.equal(refused.code, 'RESYNC_REQUIRED', 'state written before metadata is not trusted');
  assert.equal(refused.action, null, 'mixed snapshot cannot wake model work');

  publishedFixture(graphDir, waitEvents, pending, publishedFront(), projection, 2);
  const overlay = { ...publishedFront(), dispatches_applied_at: 'later', generation: undefined };
  fs.writeFileSync(path.join(graphDir, 'delivery-front.json'), JSON.stringify(overlay, null, 2) + '\n');
  const unchanged = waitEvents.observePublished(ctx, { now: 3000 });
  assert.equal(unchanged.action, null, 'overlay-only front refresh does not create an observation transition');
  assert.equal(unchanged.record.observation_digest, baseline.record.observation_digest);

  const failed = publishedState('FAILURE');
  const failedProjection = { tickets: { 'T-33-01': { checks: failed['T-33-01'].checks, review_decision: null } } };
  publishedFixture(graphDir, waitEvents, failed, publishedFront(), failedProjection, 3);
  const transition = waitEvents.observePublished(ctx, { now: 4000 });
  assert.ok(transition.action, 'a complete changed publication creates one transition');
  assert.equal(transition.transition_sequence, 1);
});

test('legacy metadata requests resync without erasing wait history or issuing work', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const state = publishedState();
  const front = publishedFront();
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(graphDir, 'delivery-front.json'), JSON.stringify(front));
  fs.writeFileSync(path.join(graphDir, 'delivery-state-meta.json'), JSON.stringify({ generation: 4, observed_at: '2026-09-16T00:00:00Z' }));
  const result = waitEvents.observePublished(ctx, { now: 1000 });
  assert.equal(result.code, 'RESYNC_REQUIRED');
  assert.equal(result.action, null);
  assert.equal(fs.existsSync(path.join(graphDir, 'wait-events.json')), false, 'legacy state does not create a wait event');
});

test('newer published metadata refuses work even when its nested binding looks valid', () => {
  const waitEvents = loadWaitEvents();
  const graphDir = graph();
  const ctx = context(graphDir);
  const state = publishedState();
  const front = publishedFront();
  const projection = { tickets: { 'T-33-01': { checks: state['T-33-01'].checks, review_decision: null } } };
  publishedFixture(graphDir, waitEvents, state, front, projection);
  const metadataFile = path.join(graphDir, 'delivery-state-meta.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  metadata.schema_version = 99;
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));

  const result = waitEvents.observePublished(ctx, { now: 1000 });
  assert.equal(result.code, 'RESYNC_REQUIRED', 'a newer metadata envelope cannot authorize an event');
  assert.equal(result.action, null);
  assert.equal(fs.existsSync(path.join(graphDir, 'wait-events.json')), false,
    'refusal does not create an event store');
});

done();
