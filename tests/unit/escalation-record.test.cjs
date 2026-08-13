'use strict';

// An escalation used to travel ONLY as `--parked`, a flag the caller re-passed on
// every state-sync. Nothing on disk recorded it, so the next session opened blind:
// the front offered the ticket back and the run re-dispatched review-fix and
// arch-review against a PR a human had already been asked to resolve. Verified on
// the proving ground — the same graph read `fixpoint: YES` with the flag and
// `finalize: T-16-05` without it, and T-16-05's escalation was never journalled at
// all, so even the metric was blind.
//
// The tests below pin the three properties that make the durable version safe:
// it holds while nothing moves, it LIFTS ITSELF when a human acts, and it refuses
// to be recorded without the reason the next session inherits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const SCRIPT = path.join(SCRIPTS, 'escalation-record.cjs');
const { activeEscalations } = require(SCRIPT);

// A ticket mid-flight: PR open, green, still a draft — the front calls this
// `finalize`, i.e. actionable, which is exactly what must NOT happen once parked.
const OPEN_PR = {
  branch: 'ticket/T-16-05-x', pr: 606, status: 'pr-open', draft: true,
  review_decision: 'CHANGES_REQUESTED',
  checks: { total: 4, failing: 0, pending: 0, none_reported: false },
};

function project(state = { 'T-16-05': { ...OPEN_PR } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-escal-'));
  const graph = path.join(dir, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  // delivery-state.json is a FLAT map of ticket ids — no wrapper. A fixture that
  // wraps it tests a shape state-sync never writes.
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-16-05': {} } }));
  return dir;
}

const run = (cwd, args) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const stateOf = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'graph', 'delivery-state.json'), 'utf8'));
const setState = (dir, t) =>
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'delivery-state.json'), JSON.stringify(t));

suite('escalation-record — the park outlives the session');

test('a marked escalation is in force in a later run, with its reason', () => {
  const dir = project();
  const r = run(dir, ['mark', 'T-16-05', 'auth', 'token', 'expired;', 'a', 'human', 'must', 'reissue', 'it']);
  assert.equal(r.status, 0, `mark must succeed (${r.stderr})`);
  // A fresh read, as a new session would do — no flag, no memory.
  const active = activeEscalations(dir);
  assert.equal(active['T-16-05'], 'auth token expired; a human must reissue it',
    'the reason is what the next session inherits');
});

test('marking journals the escalation in the same act', () => {
  // T-16-05 was parked with no journal entry because parking and journalling were
  // two separate things and only one got done.
  const dir = project();
  run(dir, ['mark', 'T-16-05', 'needs', 'a', 'human']);
  const log = fs.readFileSync(path.join(dir, '.planning', 'graph', 'delivery-log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1, 'exactly one event');
  assert.equal(log[0].event, 'escalation');
  assert.equal(log[0].ticket, 'T-16-05');
  assert.equal(log[0].pr, 606, 'the PR is carried, so stats can attribute it');
  assert.equal(log[0].reason, 'needs a human', 'the reason reaches the journal too');
});

test('an escalation with no reason is refused', () => {
  const dir = project();
  const r = run(dir, ['mark', 'T-16-05']);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/reason/i.test(r.stderr), 'and say why');
  assert.ok(!fs.existsSync(path.join(dir, '.planning', 'graph', 'escalations.json')),
    'nothing is written on refusal');
});

test('an unknown ticket is refused rather than parked into the void', () => {
  const r = run(project(), ['mark', 'T-99-99', 'typo', 'in', 'the', 'id']);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/delivery-state/.test(r.stderr), 'and point at the real cause');
});

suite('escalation-record — and lifts itself when a human acts');

test('it holds while nothing about the PR moves', () => {
  const dir = project();
  run(dir, ['mark', 'T-16-05', 'blocked', 'on', 'a', 'human']);
  assert.ok(activeEscalations(dir)['T-16-05'], 'still parked — nothing has changed');
});

for (const [what, mutate] of [
  ['the human answers the review', (t) => { t.review_decision = 'APPROVED'; }],
  ['the human undrafts it', (t) => { t.draft = false; }],
  ['someone pushes and CI re-runs', (t) => { t.checks = { total: 4, failing: 0, pending: 2 }; }],
  ['the PR is superseded by another', (t) => { t.pr = 700; }],
]) {
  test(`it lifts when ${what}`, () => {
    const dir = project();
    run(dir, ['mark', 'T-16-05', 'blocked', 'on', 'a', 'human']);
    const s = stateOf(dir); mutate(s['T-16-05']); setState(dir, s);
    assert.equal(activeEscalations(dir)['T-16-05'], undefined,
      'a human moved it — the run must reconsider, not keep parking');
  });
}

test('a merged ticket is never parked, whatever was recorded', () => {
  const dir = project();
  run(dir, ['mark', 'T-16-05', 'blocked', 'on', 'a', 'human']);
  const s = stateOf(dir); s['T-16-05'].status = 'merged'; setState(dir, s);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined,
    'whatever we gave up on, it landed — there is nothing left to escalate');
});

test('clear takes it back explicitly', () => {
  const dir = project();
  run(dir, ['mark', 'T-16-05', 'blocked', 'on', 'a', 'human']);
  const r = run(dir, ['clear', 'T-16-05']);
  assert.equal(r.status, 0);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined, 'gone');
});

test('a ticket with no PR stays parked until cleared — there is nothing to wait for', () => {
  // The "executor could not even start" case. No external event will ever move
  // it, so an automatic lift would be a lie; clear-only falls out of the same rule.
  const dir = project({ 'T-07-01': { branch: 'ticket/T-07-01-x', status: 'pending' } });
  run(dir, ['mark', 'T-07-01', 'the', 'checkout', 'it', 'needs', 'does', 'not', 'exist']);
  assert.ok(activeEscalations(dir)['T-07-01'], 'parked');
  const s = stateOf(dir); s['T-07-01'].status = 'branched'; setState(dir, s);
  assert.equal(activeEscalations(dir)['T-07-01'], undefined,
    'but real movement still lifts it — the rule is one rule');
});

suite('escalation-record — the front and the guard agree');

test('the front parks the ticket it would otherwise call finalize', () => {
  const { computeFront } = require(path.join(SCRIPTS, 'front.cjs'));
  const dir = project();
  const tickets = { 'T-16-05': {} };
  const before = computeFront(tickets, stateOf(dir), { autoMerge: true });
  assert.deepEqual(before.actionable.finalize, ['T-16-05'], 'actionable without the record');
  run(dir, ['mark', 'T-16-05', 'a', 'human', 'owns', 'the', 'API', 'key']);
  const after = computeFront(tickets, stateOf(dir), { autoMerge: true, escalated: activeEscalations(dir) });
  assert.equal(after.actionable_count, 0, 'parked with it');
  assert.ok(after.parked.blocked.includes('T-16-05'));
  assert.ok(/a human owns the API key/.test(after.why['T-16-05']),
    'and the recorded reason replaces the "escalation or attempts exhausted" disjunction');
  assert.equal(after.fixpoint, true, 'so the run may legitimately stop');
});

test('hand-logging an escalation is refused and redirected', () => {
  // Journalling it without parking records the fact and loses the verdict.
  const dir = project();
  const r = spawnSync('node', [path.join(SCRIPTS, 'log-event.cjs'), 'escalation', 'ticket=T-16-05'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/escalation-record\.cjs mark/.test(r.stderr), 'and name the command that does both');
});

done();
