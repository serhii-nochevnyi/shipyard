'use strict';

// The stop gate is the only shipyard component whose failure mode is BOTH ways
// round, so both directions are tested here:
//
//   too permissive → the defect it exists for (a run ends with the front full,
//     which deliver.md forbids in prose and could not enforce);
//   too aggressive → a session that cannot be ended, in a project that never
//     asked for a conveyor, or over work nobody intends to take.
//
// The second is the worse of the two — a guard that traps you gets uninstalled,
// after which it enforces nothing at all. Hence five separate escape hatches,
// one test each.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'stop-gate.cjs'
);

const fresh = () => new Date().toISOString();
const agesAgo = () => new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

// A front with two live items — the shape that MUST be refused.
const live = (over = {}) => ({
  generated_at: fresh(),
  actionable_count: 2,
  left_behind_count: 0,
  actionable: { execute: ['T-01-03'], fix: ['T-01-02'], publish: [], finalize: [], merge: [] },
  ...over,
});

// project(front) — a scratch cwd; front === null means "no conveyor here".
function project(front) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stopgate-'));
  if (front !== null) {
    fs.mkdirSync(path.join(dir, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'graph', 'delivery-front.json'),
      typeof front === 'string' ? front : JSON.stringify(front)
    );
  }
  return dir;
}

// run(front, payload) → the parsed hook verdict, or null when it stayed silent.
function run(front, payload = {}, env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd: project(front), input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the hook must always exit 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

suite('stop-gate — refuses the stop while the front has live work');

test('a non-empty fresh front blocks the stop', () => {
  const v = run(live());
  assert.equal(v.decision, 'block', 'a live front must block');
  assert.ok(/2 item\(s\) are actionable/.test(v.reason), 'the reason names the count');
});

test('the reason names the actual tickets, not just a number', () => {
  const { reason } = run(live());
  assert.ok(reason.includes('T-01-03'), 'names the executable ticket');
  assert.ok(reason.includes('T-01-02'), 'names the fixable ticket');
  assert.ok(reason.includes('execute:') && reason.includes('fix:'), 'names the buckets');
});

test('the reason points at the loop-back, not just "you have work"', () => {
  // A refusal that does not say what to do next reads as an obstacle and gets
  // worked around — the run summarises anyway, one message later.
  const { reason } = run(live());
  assert.ok(/state-sync/.test(reason), 'names the resync step');
  assert.ok(/fixpoint: YES/.test(reason), 'names the only legitimate stop');
  assert.ok(/drift-record\.cjs mark/.test(reason), 'names the way OUT for work not to be taken');
});

suite('stop-gate — the escape hatches');

test('stop_hook_active is honoured, so a refusal cannot become a loop', () => {
  assert.equal(run(live(), { stop_hook_active: true }), null,
    'a second stop must pass — the run has already been told once');
});

test('a project with no delivery front is not a conveyor project', () => {
  assert.equal(run(null), null, 'the gate is global; it must be silent everywhere else');
});

test('a stale front never traps a session', () => {
  assert.equal(run(live({ generated_at: agesAgo() })), null,
    'a front from a run that ended hours ago describes nothing current');
  // ...and the staleness window is tunable, so a long-running project can widen it.
  assert.equal(
    run(live({ generated_at: new Date(Date.now() - 90 * 1000).toISOString() }),
        {}, { SHIPYARD_STOP_GATE_FRESH_MS: '60000' }),
    null, 'SHIPYARD_STOP_GATE_FRESH_MS moves the window');
});

test('a front of only left-behind work is a decision, not motion', () => {
  // front.cjs already says so in its own fixpoint text. Blocking here would
  // demand the run take tickets whose phase has shipped without them.
  assert.equal(run(live({ actionable_count: 2, left_behind_count: 2 })), null,
    'all-left-behind must pass');
  assert.equal(run(live({ actionable_count: 2, left_behind_count: 1 })).decision, 'block',
    'but ONE live item among them still blocks');
});

test('waiting on CI is not a reason to block', () => {
  // The conveyor is explicitly allowed to wait; front.cjs keeps ci out of
  // actionable_count, so an empty count is the whole test.
  assert.equal(run({
    generated_at: fresh(), actionable_count: 0, left_behind_count: 0,
    actionable: {}, waiting: { ci: ['T-01-01'], merge_human: ['T-01-04'] },
  }), null, 'nothing actionable → the run may stop and wait');
});

suite('stop-gate — degrades quietly');

test('an unreadable front does not trap the session', () => {
  assert.equal(run('{not json'), null, 'a corrupt front is a bug elsewhere, not a trap here');
  // JSON.parse("null") succeeds — reading .generated_at off it would throw, and
  // an uncaught throw breaks "it always exits 0".
  assert.equal(run('null'), null, 'a null front is as unreadable as a corrupt one');
});

test('garbage in SHIPYARD_STOP_GATE_FRESH_MS does not disable the staleness hatch', () => {
  // Number('an hour') is NaN, and `age > NaN` is false — so a garbage value used
  // to make EVERY front read as fresh, quietly re-arming the trap the window
  // exists to prevent. It must fall back to the default instead.
  assert.equal(
    run(live({ generated_at: agesAgo() }), {}, { SHIPYARD_STOP_GATE_FRESH_MS: 'an hour' }),
    null, 'a six-hour-old front stays stale under a garbage env var');
});

test('no stdin payload at all is survivable', () => {
  const r = spawnSync('node', [SCRIPT], { cwd: project(live()), input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, 'must not crash without a payload');
  assert.equal(JSON.parse(r.stdout).decision, 'block', 'and still enforces');
});

done();
