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
const { activeEscalations, fingerprint } = require(SCRIPT);

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

suite('escalation-record — plan_defect is a verdict about the PLAN, not the PR');

// The third terminal outcome (ADR-001, D1/D3). `failure-signature.cjs verdict`
// reaches `plan_defect` when k distinct signatures have been tried with no green:
// the ticket has not "failed", the PLAN is wrong. So it parks with its evidence
// and tells the morning human to re-decompose — and, unlike an escalation, a push
// or an answered review must NOT lift it. Only re-planning does, which is exactly
// drift-record's rule applied to this store's records.

const PLAN_BODY = '---\nphase: 20\nplan: 09\n---\n\n## Goal\n\nrewrite the widget\n';

function planned(state) {
  const dir = project(state);
  const plan = path.join(dir, 'plan.md');
  fs.writeFileSync(plan, PLAN_BODY);
  return { dir, plan };
}

const storeOf = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'graph', 'escalations.json'), 'utf8')).tickets;

const journal = (dir) => {
  const f = path.join(dir, '.planning', 'graph', 'delivery-log.jsonl');
  return fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
};

test('mark-plan-defect parks and journals in ONE act, kind-tagged', () => {
  const { dir, plan } = planned();
  const r = run(dir, [
    'mark-plan-defect', 'T-16-05', plan,
    'the plan assumes a sync endpoint; the API streams, so no fix inside these files can pass',
    '--signature', 'aaaa1111', '--signature', 'bbbb2222',
  ]);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);

  const rec = storeOf(dir)['T-16-05'];
  assert.equal(rec.kind, 'plan_defect', 'the kind is what the expiry branches on');
  assert.ok(/streaming|streams/.test(rec.reason), 'the raw reason is stored, unprefixed');
  assert.equal(rec.plan, plan, 'absolute: mark runs in a worktree, reads happen at the project root');
  assert.ok(rec.plan_hash, 'bound to the plan content, or the verdict would never expire');
  assert.deepEqual(rec.signatures, ['aaaa1111', 'bbbb2222'], 'the evidence travels with the verdict');
  assert.equal(rec.pr, 606);

  const log = journal(dir);
  assert.equal(log.length, 1, 'exactly one event — never the park without the journal line');
  assert.equal(log[0].event, 'plan_defect');
  assert.equal(log[0].ticket, 'T-16-05');
  assert.equal(log[0].pr, 606);
  assert.deepEqual(log[0].signatures, ['aaaa1111', 'bbbb2222']);
  assert.equal(log[0].plan_hash, rec.plan_hash, 'the journal carries the binding too');
  assert.equal(log[0].by, 'escalation-record');
});

test('--signature is collected from any position, distinct only, never into the reason', () => {
  const { dir, plan } = planned();
  const r = run(dir, [
    'mark-plan-defect', '--signature', 'dup9', 'T-16-05', plan, '--signature', 'dup9',
    '--signature', 'ffff', 'k', 'distinct', 'failures', 'and', 'no', 'green',
  ]);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  const rec = storeOf(dir)['T-16-05'];
  assert.deepEqual(rec.signatures, ['dup9', 'ffff'], 'the same signature twice is one piece of evidence');
  assert.equal(rec.reason, 'k distinct failures and no green', 'flag text must not be swallowed into the reason');
});

test('with no --signature at all the record still carries the field, empty', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan names a module that no longer exists']);
  assert.deepEqual(storeOf(dir)['T-16-05'].signatures, [], 'a shape the reader can count on');
});

test('the reason comes back prefixed with what the morning human must DO', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan splits a file two tickets both own']);
  assert.equal(
    activeEscalations(dir)['T-16-05'],
    'plan_defect — re-decompose: the plan splits a file two tickets both own',
    "the front's why-message and the sentinel's PARKED_WHY quote this string verbatim"
  );
});

for (const [what, move] of [
  ['the human answers the review', (t) => { t.review_decision = 'APPROVED'; }],
  ['someone pushes and CI re-runs', (t) => { t.checks = { total: 4, failing: 0, pending: 2 }; }],
  ['it is undrafted', (t) => { t.draft = false; }],
]) {
  test(`the park HOLDS when ${what} — the PR moving says nothing about the plan`, () => {
    const { dir, plan } = planned();
    run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan targets a module that no longer exists']);
    const s = stateOf(dir); move(s['T-16-05']); setState(dir, s);
    assert.ok(activeEscalations(dir)['T-16-05'],
      'lifting here would hand the same wrong plan straight back to an executor');
  });
}

test('editing the plan lifts it by itself — that edit IS the re-decomposition', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan predates the streaming API']);
  assert.ok(activeEscalations(dir)['T-16-05'], 'parked while the plan is byte-identical');
  fs.appendFileSync(plan, '\nnow it names the streaming endpoint\n');
  assert.equal(activeEscalations(dir)['T-16-05'], undefined, 'no second command to remember');
});

test('a plan that is gone lifts it too — there is nothing left to park against', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan predates the streaming API']);
  fs.unlinkSync(plan);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined,
    'a verdict on a plan nobody can read is spent, not eternal');
});

test('a merged ticket is not parked, whatever the plan said', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan predates the streaming API']);
  const s = stateOf(dir); s['T-16-05'].status = 'merged'; setState(dir, s);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined, 'it landed — the exclusion is one rule for both kinds');
});

test('a kind-less legacy record keeps the PR-fingerprint rule, byte for byte', () => {
  // Every record written before this phase has no `kind`. Reading one as a plan
  // defect would park it forever: it has no plan to expire against. Written by
  // hand on purpose, so the case survives any future change to `mark`.
  const { dir } = planned();
  fs.writeFileSync(path.join(dir, '.planning', 'graph', 'escalations.json'), JSON.stringify({
    tickets: {
      'T-16-05': {
        reason: 'recorded by an older shipyard',
        fingerprint: fingerprint(stateOf(dir)['T-16-05']),
        pr: 606,
        at: '2026-08-01T00:00:00.000Z',
      },
    },
  }));
  assert.equal(activeEscalations(dir)['T-16-05'], 'recorded by an older shipyard',
    'in force, and unprefixed — the kind-less rule is untouched');
  const s = stateOf(dir); s['T-16-05'].review_decision = 'APPROVED'; setState(dir, s);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined, 'and it still lifts when the human acts');
});

test('a plan defect with no reason is refused — the human inherits only this string', () => {
  const { dir, plan } = planned();
  const r = run(dir, ['mark-plan-defect', 'T-16-05', plan]);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/reason/i.test(r.stderr), 'and say why');
  assert.ok(/plan/i.test(r.stderr), 'naming what the reason must be ABOUT — the plan, not the attempt');
  assert.ok(!fs.existsSync(path.join(dir, '.planning', 'graph', 'escalations.json')),
    'nothing is written on refusal');
});

test('an unreadable plan path is refused — a verdict with nothing to expire against', () => {
  const { dir } = planned();
  const r = run(dir, ['mark-plan-defect', 'T-16-05', path.join(dir, 'no-such-plan.md'), 'the plan is wrong']);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/never expire/.test(r.stderr), r.stderr);
});

test('an unknown ticket is refused here too, not parked into the void', () => {
  const { dir, plan } = planned();
  const r = run(dir, ['mark-plan-defect', 'T-99-99', plan, 'typo in the id']);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/delivery-state/.test(r.stderr), 'and point at the real cause');
});

test('--graph records into the PROJECT from a worktree cwd, in any position', () => {
  // The verdict is reached by a fixer standing in a ticket worktree, which has no
  // .planning/ at all; without the flag the park lands where state-sync never looks.
  const { dir, plan } = planned();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-escal-wt-'));
  const r = spawnSync('node', [
    SCRIPT, '--graph', path.join(dir, '.planning', 'graph'),
    'mark-plan-defect', 'T-16-05', plan, 'three signatures, no green',
  ], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.ok(storeOf(dir)['T-16-05'], 'the park is in the project store');
  assert.ok(!fs.existsSync(path.join(elsewhere, '.planning')),
    'and no stray .planning appears in the borrowed checkout');
});

test('clear takes back a plan defect, and list names the kind', () => {
  const { dir, plan } = planned();
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan predates the new API']);
  const listed = run(dir, ['list']);
  assert.ok(/plan_defect/.test(listed.stdout), `list must show the kind (${listed.stdout})`);
  const r = run(dir, ['clear', 'T-16-05']);
  assert.equal(r.status, 0);
  assert.equal(activeEscalations(dir)['T-16-05'], undefined, 'one clear serves both kinds');
});

test('the parked set stays a flat {ticket: reason} map — the sentinel needs no change', () => {
  // sentinel.cjs consumes activeEscalations() directly and builds PARKED_WHY from
  // it. A plan defect reaches the guard for free, and only while this shape holds.
  const { dir, plan } = planned({
    'T-16-05': { ...OPEN_PR },
    'T-16-06': {
      branch: 'ticket/T-16-06-y', pr: 607, status: 'pr-open', draft: false,
      checks: { total: 1, failing: 0, pending: 0 },
    },
  });
  run(dir, ['mark-plan-defect', 'T-16-05', plan, 'the plan is wrong about the schema']);
  run(dir, ['mark', 'T-16-06', 'a', 'human', 'owns', 'the', 'API', 'key']);
  const active = activeEscalations(dir);
  assert.deepEqual(Object.keys(active).sort(), ['T-16-05', 'T-16-06'], 'both kinds, one map');
  for (const [id, reason] of Object.entries(active)) {
    assert.equal(typeof reason, 'string', `${id} must map to a plain reason string`);
  }
  assert.ok(/^plan_defect — re-decompose: /.test(active['T-16-05']));
  assert.equal(active['T-16-06'], 'a human owns the API key', 'and the older kind is untouched');
});

// The one-act claim is pinned by HOLDING the lock rather than by racing writers,
// and that is a deliberate choice with a finding behind it. Six concurrent marks
// do lose store records on this machine — 7 rounds in 12, silently, every writer
// exiting 0 with the journal complete — but the defect is in lock.cjs, not here:
// `acquire()` treats a lock directory with no owner.json as stale, and that state
// is not only "a process died mid-mkdir", it is the microsecond window EVERY
// holder passes through between `mkdirSync(lockPath)` and writing owner.json. A
// contender arriving in it breaks a live holder's lock and both enter the section.
// The pre-existing `mark` loses records at the same rate, so it is not this kind's
// bug to fix and lock.cjs is out of this ticket's files_modified — reported for a
// follow-up. A racing test here would be a 1-in-3 red in `make test-fast`, which
// every executor runs.
test('the park and its journal line sit inside ONE lock — a held lock stops both', () => {
  const { acquire, lockDirFor, sleepSync } = require(path.join(SCRIPTS, 'lock.cjs'));
  const { dir, plan } = planned();
  const graph = path.join(dir, '.planning', 'graph');
  const store = path.join(graph, 'escalations.json');
  const log = path.join(graph, 'delivery-log.jsonl');

  // The same lock directory and the same name `mutate` takes.
  const held = acquire(lockDirFor(dir), 'escalation-record', { label: 'test' });
  assert.ok(held, 'the test must own the lock before the child asks for it');

  const child = require('child_process').spawn('node',
    [SCRIPT, 'mark-plan-defect', 'T-16-05', plan, 'k distinct failures, no green'],
    { cwd: dir, stdio: 'ignore' });
  try {
    sleepSync(400);
    assert.ok(!fs.existsSync(store), 'the park waits for the lock');
    assert.ok(!fs.existsSync(log), 'and so does the journal line — neither half runs alone');
  } finally {
    held.release();
  }

  for (let i = 0; i < 150 && !fs.existsSync(log); i++) sleepSync(100);
  child.unref();
  assert.ok(fs.existsSync(log), 'the child must get the lock once it is free');
  const rec = storeOf(dir)['T-16-05'];
  const line = journal(dir).find((e) => e.event === 'plan_defect');
  assert.equal(rec.kind, 'plan_defect', 'the park landed');
  assert.ok(line, 'and so did the journal line');
  assert.equal(line.plan_hash, rec.plan_hash, 'the two halves describe the same act');
});

test('six plan defects in a row all survive, each with exactly one journal line', () => {
  const state = {};
  for (let i = 1; i <= 6; i++) {
    state[`T-20-0${i}`] = {
      branch: `ticket/T-20-0${i}-x`, pr: 700 + i, status: 'pr-open', draft: true,
      checks: { total: 1, failing: 1, pending: 0 },
    };
  }
  const { dir, plan } = planned(state);
  for (let i = 1; i <= 6; i++) {
    const r = run(dir, ['mark-plan-defect', `T-20-0${i}`, plan, 'k', 'distinct', 'failures', `on ${i}`]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(Object.keys(storeOf(dir)).length, 6, 'every park is kept');
  const events = journal(dir).filter((e) => e.event === 'plan_defect');
  assert.equal(events.length, 6, 'one journal line each');
  assert.equal(new Set(events.map((e) => e.ticket)).size, 6, 'no ticket logged twice');
});

done();
