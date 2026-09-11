'use strict';

// dispatch-record.cjs is the third durable store, and the only one whose subject
// is MOTION rather than a verdict. That inverts which failure is the dangerous
// one.
//
// For drift and escalation, the harm of a record that never lifts is a ticket
// re-offered too late. Here it is a ticket hidden from the run that owns it: an
// agent died, nothing was pushed, and the board quietly stops mentioning the
// work — a SILENT STALL, which the backlog note this store implements says
// plainly is worse than the spurious block it replaces.
//
// So the decisive tests in this file are the LIFTING ones. A suite that only
// proved suppression would pass against an implementation that hides tickets
// forever, and that implementation is the failure mode, not the fix.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const DISPATCH = path.join(SCRIPTS, 'dispatch-record.cjs');
const STOP_GATE = path.join(SCRIPTS, 'stop-gate.cjs');
const { activeDispatches, dispatchWhy, dispatchFingerprint, DISPATCH_SUBJECT, DISPATCH_TTL_MS } = require(DISPATCH);
// One role vocabulary for the whole conveyor — the same list `mark` validates
// against. The per-role subject table below is checked against IT, not against a
// second list written out here.
const { ROLES } = require(path.join(SCRIPTS, 'pipeline-config.cjs'));

// SHIPYARD_GRAPH_DIR is the other explicit channel for "which graph"; a value
// inherited from the runner would decide these cases instead of the flag.
const run = (args, cwd, env = {}) => spawnSync('node', [DISPATCH, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: '', ...env },
});

// A project (has a ticket graph) and a worktree beside it (has none) — the two
// cwds this command can find itself in, because the guard dispatches its fixers
// from inside worktrees.
function scratch(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-dispatch-'));
  const project = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  const graph = path.join(project, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const tickets = {};
  for (const id of Object.keys(state)) tickets[id] = { phase: id.split('-')[1] };
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  return { dir, project, worktree, graph };
}

const readState = (graph) => JSON.parse(fs.readFileSync(path.join(graph, 'delivery-state.json'), 'utf8'));
const writeState = (graph, s) => fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(s));
const store = (graph) => {
  try { return JSON.parse(fs.readFileSync(path.join(graph, 'dispatches.json'), 'utf8')).tickets || {}; }
  catch { return {}; }
};

const READY = { status: 'pending', ready: true };
// `head_sha` is what a fixer's push moves. state-sync starts recording it in
// T-24-04, so every case here must hold with it and without it.
const OPEN_PR = {
  status: 'pr-open', pr: 7, draft: true, head_sha: 'aaaa1111',
  checks: { total: 2, failing: 0, pending: 0 },
};

suite('dispatch-record — a dispatched ticket stops being offered');

test('mark records the role and activeDispatches reports it', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor'], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(graph)['T-01-01'].role, 'executor');
  const live = activeDispatches(project);
  assert.deepStrictEqual(Object.keys(live), ['T-01-01']);
  assert.equal(live['T-01-01'].role, 'executor');
});

test('the guard\'s buckets are covered too, not just the executor\'s', () => {
  // The first sighting was an executor wave, but deliver.md tells the run to post
  // the guard and NOT wait for it — so fix/finalize/merge are dispatched by
  // design, and a store that only knew about executors would still mis-report the
  // board on every healthy run.
  const { project } = scratch({ 'T-01-02': { ...OPEN_PR } });
  assert.equal(run(['mark', 'T-01-02', 'pr-sentinel'], project).status, 0);
  assert.equal(activeDispatches(project)['T-01-02'].role, 'pr-sentinel');
});

test('a role outside the ladder is refused, not filed under an unreadable name', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'finalize'], project); // a BUCKET name, not a role
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/roles:/.test(r.stderr), 'and names the vocabulary it wanted');
  assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
});

test('a ticket the board does not know is a typo, not a dispatch', () => {
  const { project } = scratch({ 'T-01-01': { ...READY } });
  assert.equal(run(['mark', 'T-09-09', 'executor'], project).status, 1);
});

suite('dispatch-record — EXPIRY: the record lifts by itself, or it is worse than the bug');

test('a MOVED delivery state lifts the record with no clear call', () => {
  // Trigger 1, and the one that carries the design: the dispatch is a claim about
  // the ticket as it stood when the work was handed over. The instant its state
  // moves, the dispatch has done its job and the board owns the ticket again —
  // nobody has to remember to clean up, which is the only property that makes
  // this safe to write from a loop that may not survive.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  assert.ok(activeDispatches(project)['T-01-01'], 'suppressed while nothing has moved');

  const s = readState(graph);
  s['T-01-01'] = { status: 'branched', ready: true, branch: 'ticket/T-01-01-x' };
  writeState(graph, s);

  assert.deepStrictEqual(activeDispatches(project), {},
    'the executor pushed — the ticket is the board\'s again, with no clear call');
  assert.ok(store(graph)['T-01-01'], 'the record is still on disk: expiry is a READ rule, not a cleanup job');
});

test('a TTL-expired record hides nothing', () => {
  // Trigger 2: a session killed mid-wave moves no state at all, so trigger 1
  // never fires. Without this backstop the ticket is hidden from every future
  // run — the silent stall.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const s = store(graph);
  s['T-01-01'].at = new Date(Date.now() - DISPATCH_TTL_MS - 60_000).toISOString();
  fs.writeFileSync(path.join(graph, 'dispatches.json'), JSON.stringify({ tickets: s }));
  assert.deepStrictEqual(activeDispatches(project), {}, 'past the TTL the work is offered again');
});

test('a record that cannot be dated is expired, never eternal', () => {
  // Every unreadable case fails TOWARDS offering the work, because the failure
  // this store must never produce is a ticket nobody is told about.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const s = store(graph);
  s['T-01-01'].at = 'the other day';
  fs.writeFileSync(path.join(graph, 'dispatches.json'), JSON.stringify({ tickets: s }));
  assert.deepStrictEqual(activeDispatches(project), {});
});

test('garbage in SHIPYARD_DISPATCH_TTL_MS does not disable the backstop', () => {
  // Number('an hour') is NaN, and `age >= NaN` is false — so a garbage value
  // would make every record read as live forever, which is the stall again.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const s = store(graph);
  s['T-01-01'].at = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(graph, 'dispatches.json'), JSON.stringify({ tickets: s }));
  const r = run(['list', '--json'], project, { SHIPYARD_DISPATCH_TTL_MS: 'an hour' });
  assert.deepStrictEqual(JSON.parse(r.stdout), {}, 'an eight-hour-old record stays expired');
});

test('clear removes it immediately', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  assert.equal(run(['clear', 'T-01-01'], project).status, 0);
  assert.deepStrictEqual(store(graph), {}, 'gone from the store');
  assert.deepStrictEqual(activeDispatches(project), {});
});

test('a dispatch for a MERGED ticket suppresses nothing', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...OPEN_PR } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'pr-sentinel'], { cwd: project });
  writeState(graph, { 'T-01-01': { status: 'merged', pr: 7 } });
  assert.deepStrictEqual(activeDispatches(project), {}, 'whoever was working on it, it landed');
});

suite('dispatch-record — the record lifts on the OWNER\'s output, never on a CI tick');

// A1, ADR-002 D1. Trigger 1 was bound to escalation-record's shared fingerprint,
// which hashes the check TALLIES — so a guard's dispatch expired the moment ANY
// check finished, which is minutes after the fixer was handed the work and long
// before it has pushed anything. The front then re-offered the PR, the stop gate
// blocked over it, and a second fixer could be dispatched at the same PR.
//
// A dispatch is a claim that an agent is producing something. It ends when THAT
// OUTPUT exists, and the output is different per role — so the field list is per
// role too, and no role's list names a tally.

const markFor = (project, ticket, role) =>
  execFileSync('node', [DISPATCH, 'mark', ticket, role], { cwd: project });

test('a finished check does NOT lift a fixer\'s dispatch', () => {
  // The measured shape: review-fix is dispatched at a PR with three checks still
  // running; one finishes 40 seconds later, having nothing to do with the fixer.
  const { project, graph } = scratch({
    'T-01-01': { ...OPEN_PR, draft: false, checks: { total: 17, failing: 1, pending: 3 } },
  });
  markFor(project, 'T-01-01', 'review-fix');
  assert.ok(activeDispatches(project)['T-01-01'], 'held while the fixer works');

  const s = readState(graph);
  s['T-01-01'].checks = { total: 17, failing: 1, pending: 2 };
  writeState(graph, s);
  assert.ok(activeDispatches(project)['T-01-01'],
    'a check finishing is not the fixer\'s output — the dispatch must hold');

  s['T-01-01'].head_sha = 'bbbb2222';
  writeState(graph, s);
  assert.deepStrictEqual(activeDispatches(project), {},
    'a new head IS the fixer\'s output — the board owns the ticket again');
});

test('an executor\'s dispatch still lifts the moment a branch or a PR appears', () => {
  // Unchanged behaviour, pinned beside the change: the executor's output is
  // visible as status/branch/pr, and none of that is a tally.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  markFor(project, 'T-01-01', 'executor');
  const s = readState(graph);
  s['T-01-01'] = { status: 'branched', ready: true, branch: 'ticket/T-01-01-x' };
  writeState(graph, s);
  assert.deepStrictEqual(activeDispatches(project), {}, 'lifted, with no clear call');
});

test('arch-review holds through a re-run and lifts on the trailer it writes', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...OPEN_PR, draft: false } });
  markFor(project, 'T-01-01', 'arch-review');
  const s = readState(graph);
  s['T-01-01'].checks = { total: 34, failing: 0, pending: 12 };
  writeState(graph, s);
  assert.ok(activeDispatches(project)['T-01-01'], 'a whole pipeline re-run is not a verdict');
  s['T-01-01'].gate = { 'arch-review': 'conform' };
  writeState(graph, s);
  assert.deepStrictEqual(activeDispatches(project), {}, 'the trailer is the judge\'s output');
});

test('pr-sentinel holds through a re-run and lifts when the base moves', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...OPEN_PR, draft: false, pr_base: 'ticket/T-01-00-x' } });
  markFor(project, 'T-01-01', 'pr-sentinel');
  const s = readState(graph);
  s['T-01-01'].checks = { total: 3, failing: 0, pending: 1 };
  writeState(graph, s);
  assert.ok(activeDispatches(project)['T-01-01'], 'the guard has not merged or retargeted anything yet');
  s['T-01-01'].pr_base = 'epic/24-the-conveyor';
  writeState(graph, s);
  assert.deepStrictEqual(activeDispatches(project), {}, 'the retarget is the guard\'s own output');
});

test('every role in the ladder has a subject, and no subject names a check tally', () => {
  // The table is keyed off `ROLES` — the vocabulary `mark` already validates
  // against — so a role added to the ladder cannot silently fall back to a list
  // that describes somebody else's output. And the whole point of the ticket: a
  // tally appears in NO role's fields.
  for (const role of ROLES) {
    const spec = DISPATCH_SUBJECT[role];
    assert.ok(spec, `${role} has no dispatch subject`);
    assert.ok(spec.fields.length, `${role}'s subject names no field`);
    assert.ok(spec.lifts, `${role}'s subject has no sentence for the board`);
    for (const f of spec.fields) {
      assert.ok(!/^checks/.test(f), `${role} must not expire against ${f}`);
    }
  }
});

test('a role\'s fingerprint moves only for that role\'s own output', () => {
  const base = { ...OPEN_PR, draft: false, pr_base: 'epic/24-x' };
  const tick = { ...base, checks: { total: 17, failing: 1, pending: 9 } };
  for (const role of ROLES) {
    assert.equal(dispatchFingerprint(role, tick), dispatchFingerprint(role, base),
      `${role}'s dispatch must survive a CI tick`);
  }
  assert.notEqual(dispatchFingerprint('review-fix', { ...base, head_sha: 'zzzz' }),
    dispatchFingerprint('review-fix', base), 'a push is the fixer\'s output');
  assert.notEqual(dispatchFingerprint('executor', { ...base, status: 'branched' }),
    dispatchFingerprint('executor', base), 'a branch is the executor\'s');
});

test('a kind-less record from the previous release keeps the shared hash', () => {
  // No store migration: a dispatch written before this split is bound to the hash
  // that includes the tallies, and it keeps expiring against that one until it
  // lifts — within the TTL either way.
  const { project, graph } = scratch({ 'T-01-01': { ...OPEN_PR, draft: false } });
  const { fingerprint } = require(path.join(SCRIPTS, 'escalation-record.cjs'));
  fs.writeFileSync(path.join(graph, 'dispatches.json'), JSON.stringify({
    tickets: {
      'T-01-01': {
        role: 'review-fix', at: new Date().toISOString(),
        fingerprint: fingerprint(readState(graph)['T-01-01']), pr: 7,
      },
    },
  }));
  assert.ok(activeDispatches(project)['T-01-01'], 'in force');
  const s = readState(graph);
  s['T-01-01'].checks = { total: 2, failing: 0, pending: 1 };
  writeState(graph, s);
  assert.deepStrictEqual(activeDispatches(project), {},
    'and it still lifts on a tally change — the old rule, unchanged');
});

test('mark records which hash the dispatch is bound to', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...OPEN_PR, draft: false } });
  markFor(project, 'T-01-01', 'review-fix');
  const rec = store(graph)['T-01-01'];
  assert.equal(rec.fingerprint_kind, 'role', 'so the reader knows which rule to compare with');
  assert.equal(rec.fingerprint, dispatchFingerprint('review-fix', readState(graph)['T-01-01']));
});

test('the board\'s sentence names the output that will lift it, and not a check', () => {
  // The reader who does not know what ends the dispatch reaches for `clear`, and a
  // `clear` that becomes routine clears work that has not returned. The old
  // sentence listed "a check" among the things that return the ticket, which was
  // both wrong and an invitation to distrust the board.
  const why = dispatchWhy('T-01-01', { role: 'review-fix', at: new Date().toISOString() });
  assert.ok(/review-fix/.test(why), why);
  assert.ok(/head/.test(why), `it must name the fixer's own output: ${why}`);
  assert.ok(!/a check/.test(why), `and must not promise a check lifts it: ${why}`);
  assert.ok(/\d+m/.test(why), 'the timeout is still named');
  assert.ok(/branch/.test(dispatchWhy('T', { role: 'executor', at: new Date().toISOString() })),
    'and each role gets its own output named');
});

suite('dispatch-record — the stop gate goes silent, measured end to end');

// The whole point of the ticket, and the acceptance criterion insists it be
// measured rather than inferred from a bucket name: the gate reads
// delivery-front.json and nothing else, so the only honest proof is to drive the
// real hook with the real file this change produces.
function board(project, front) {
  fs.writeFileSync(
    path.join(project, '.planning', 'graph', 'delivery-front.json'),
    JSON.stringify({
      // FRESH on purpose: the gate has a staleness hatch, and a stale seed would
      // make this suite pass through that instead of through the dispatch.
      generated_at: new Date().toISOString(),
      parked_by_run: [], auto_merge: 'off',
      left_behind_count: 0, ...front,
    }, null, 2)
  );
}

const gate = (cwd) => spawnSync('node', [STOP_GATE], {
  cwd, input: '{}', encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: '' },
});

test('the gate blocks a fully actionable board (the negative control)', () => {
  const { project } = scratch({ 'T-01-01': { ...READY }, 'T-01-02': { ...OPEN_PR } });
  board(project, {
    actionable_count: 2,
    actionable: { execute: ['T-01-01'], publish: [], fix: [], finalize: ['T-01-02'], merge: [] },
  });
  const r = gate(project);
  assert.equal(r.status, 0, 'the hook always exits 0');
  assert.equal(JSON.parse(r.stdout).decision, 'block', 'without this the next assertion proves nothing');
});

test('once both are dispatched the gate stays silent — and the FILE says why', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY }, 'T-01-02': { ...OPEN_PR } });
  board(project, {
    actionable_count: 2,
    actionable: { execute: ['T-01-01'], publish: [], fix: [], finalize: ['T-01-02'], merge: [] },
  });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-02', 'review-fix'], { cwd: project });

  // The board on disk — the artifact the hook actually reads — not a value
  // recomputed in this process.
  const front = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-front.json'), 'utf8'));
  assert.equal(front.actionable_count, 0, 'nothing is anyone else\'s to start');
  assert.deepStrictEqual(front.waiting.dispatched.slice().sort(), ['T-01-01', 'T-01-02']);
  assert.equal(front.fixpoint, false, 'in flight is not an ending');
  assert.equal(front.sentinel.clear, false, 'the guard is mid-round, and the board must not say otherwise');

  const r = gate(project);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'no block message at all');
});

test('the mark that hides the work also puts it back', () => {
  // The other half of the same measurement: a `clear` must re-arm the gate, or
  // the store has traded a spurious block for a permanent one.
  const { project } = scratch({ 'T-01-01': { ...READY } });
  board(project, {
    actionable_count: 1,
    actionable: { execute: ['T-01-01'], publish: [], fix: [], finalize: [], merge: [] },
  });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  assert.equal(gate(project).stdout.trim(), '');
  execFileSync('node', [DISPATCH, 'clear', 'T-01-01'], { cwd: project });
  assert.equal(JSON.parse(gate(project).stdout).decision, 'block', 'the board offers it again');
});

test('a project with no board never gets one conjured for it', () => {
  // The gate is installed globally. A front written where state-sync never wrote
  // one would arm it in a directory that never asked for a conveyor.
  const { project } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  assert.ok(!fs.existsSync(path.join(project, '.planning', 'graph', 'delivery-front.json')));
  assert.equal(gate(project).stdout.trim(), '', 'and the gate stays silent, as it does anywhere else');
});

test('the refresh inherits the sync\'s facts instead of restamping them', () => {
  // `generated_at` is how fresh the GITHUB read is, and the gate's staleness
  // hatch rests on it. Re-stamping it here would make an old board read as
  // current — a trap re-armed by the very command that exists to relax the gate.
  const { project, graph } = scratch({ 'T-01-01': { ...READY }, 'T-01-02': { ...OPEN_PR } });
  const generated = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  board(project, {
    generated_at: generated, parked_by_run: ['T-01-02'], auto_merge: 'epic',
    actionable_count: 1,
    actionable: { execute: ['T-01-01'], publish: [], fix: [], finalize: [], merge: [] },
  });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const front = JSON.parse(fs.readFileSync(path.join(graph, 'delivery-front.json'), 'utf8'));
  assert.equal(front.generated_at, generated, 'the sync\'s timestamp survives');
  assert.deepStrictEqual(front.parked_by_run, ['T-01-02'], 'and this session\'s parks');
  assert.ok(front.parked.blocked.includes('T-01-02'), 'which are still applied to the recomputed board');
  assert.equal(front.auto_merge, 'epic');
});

suite('dispatch-record — one --graph spelling means one --graph parser');

// The guard dispatches its fixers from inside ticket worktrees, which have no
// `.planning/` of their own. Every sibling store grew this parser on the PR where
// a reviewer happened to hit it; it is pinned here on the first one instead.

test('a mark from a worktree with no graph refuses instead of writing into the void', () => {
  const { worktree } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor'], worktree);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'and leaves no stray .planning behind');
});

test('a flag-shaped --graph value is refused, not resolved', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor', '--graph', '--json'], project);
  assert.equal(r.status, 1, `must refuse (${r.stderr})`);
  assert.ok(/"--json"/.test(r.stderr), 'and names the token it refused');
  assert.deepStrictEqual(store(graph), {}, 'no silent redirect into the project store');
  assert.ok(!fs.existsSync(path.join(project, '--json')), 'and no directory called "--json"');
});

test('--graph with no value at all is refused', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor', '--graph'], project);
  assert.equal(r.status, 1, `must refuse (${r.stderr})`);
  assert.deepStrictEqual(store(graph), {}, 'and does not fall back to the cwd graph');
});

test('a real --graph works in either position, from a foreign cwd', () => {
  // A flag tolerated at one end of the argv is a trap for the caller who puts it
  // at the other — and the subcommand must survive the strip (`i !== flagAt + 1`
  // with no flag present reads as `i !== 0` and eats it).
  const first = scratch({ 'T-01-01': { ...READY } });
  const rf = run(['--graph', first.graph, 'mark', 'T-01-01', 'executor'], first.worktree);
  assert.equal(rf.status, 0, `flag first must succeed (${rf.stderr})`);
  assert.ok(store(first.graph)['T-01-01'], 'recorded in the PROJECT graph');

  const last = scratch({ 'T-01-01': { ...READY } });
  const rl = run(['mark', 'T-01-01', 'executor', '--graph', last.graph], last.worktree);
  assert.equal(rl.status, 0, `flag last must succeed (${rl.stderr})`);
  assert.ok(store(last.graph)['T-01-01'], 'recorded in the PROJECT graph');
});

suite('dispatch-record — a whole wave is marked at once');

test('six concurrent marks all survive', async () => {
  // The main loop dispatches a wave, not a ticket. An unsynchronized load→save
  // loses records, and a lost dispatch is a ticket the board offers to a second
  // agent while the first is still writing it.
  const state = {};
  for (let i = 1; i <= 6; i++) state[`T-01-0${i}`] = { ...READY };
  const { project, graph } = scratch(state);
  await Promise.all([1, 2, 3, 4, 5, 6].map((i) => new Promise((resolve) => {
    require('child_process')
      .spawn('node', [DISPATCH, 'mark', `T-01-0${i}`, 'executor'], { cwd: project, stdio: 'ignore' })
      .on('close', resolve);
  })));
  assert.equal(Object.keys(store(graph)).length, 6, `all six must survive: ${Object.keys(store(graph)).join(', ')}`);
});

test('every dispatch reaches the journal exactly once', () => {
  // Nothing else records WHEN work was handed over. The TTL above had to be
  // inferred from PR timestamps for want of this line.
  const state = {};
  for (let i = 1; i <= 3; i++) state[`T-01-0${i}`] = { ...READY };
  const { project, graph } = scratch(state);
  for (let i = 1; i <= 3; i++) {
    execFileSync('node', [DISPATCH, 'mark', `T-01-0${i}`, 'executor'], { cwd: project });
  }
  const log = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 3, 'one line per dispatch');
  assert.ok(log.every((e) => e.event === 'dispatch' && e.role === 'executor'));
  assert.equal(new Set(log.map((e) => e.ticket)).size, 3, 'no ticket logged twice');
});

test('mark-many validates and journals one wave under one mutation', () => {
  const state = {};
  for (let i = 1; i <= 3; i++) state[`T-01-0${i}`] = { ...READY };
  const { project, graph } = scratch(state);
  const payload = [
    {
      ticket: 'T-01-01', role: 'executor', model: 'opus', effort: 'high',
      route: 'tier=floor(opus) effort=row(high)', task_level: 'routine',
      runtime: 'claude', backend: 'workflow', effort_applied: 'high', agent_id: 'workflow-1',
    },
    {
      ticket: 'T-01-02', role: 'executor', model: 'opus', effort: 'high',
      route: 'tier=floor(opus) effort=row(high)', task_level: 'routine',
      runtime: 'claude', backend: 'workflow', effort_applied: 'high', agent_id: 'workflow-2',
    },
    {
      ticket: 'T-01-03', role: 'executor', model: 'opus', effort: 'high',
      route: 'tier=floor(opus) effort=row(high)', task_level: 'routine',
      runtime: 'claude', backend: 'workflow', effort_applied: 'high', agent_id: 'workflow-3',
    },
  ];
  const r = spawnSync('node', [DISPATCH, 'mark-many', '--stdin'], {
    cwd: project, input: JSON.stringify(payload), encoding: 'utf8',
  });
  assert.equal(r.status, 0, `batch must succeed (${r.stderr})`);
  assert.match(r.stdout, /dispatch recorded for 3 ticket\(s\)/);
  assert.deepStrictEqual(Object.keys(store(graph)).sort(), ['T-01-01', 'T-01-02', 'T-01-03']);
  const log = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 3, 'one journal line per payload item');
  assert.deepStrictEqual(log.map((e) => e.ticket).sort(), ['T-01-01', 'T-01-02', 'T-01-03']);
  assert.ok(log.every((e) => e.event === 'dispatch' && e.backend === 'workflow' && e.effort_applied === 'high'));
  assert.equal(new Set(log.map((e) => e.dispatch_id)).size, 3, 'each ticket gets its own usage join key');
});

test('mark-many rejects the whole batch before writing when one item is invalid', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = spawnSync('node', [DISPATCH, 'mark-many', '--stdin'], {
    cwd: project,
    input: JSON.stringify([
      { ticket: 'T-01-01', role: 'executor', model: 'opus' },
      { ticket: 'T-01-01', role: 'executor', model: 'opus' },
    ]),
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, 'duplicate ticket must refuse the batch');
  assert.match(r.stderr, /duplicate ticket/);
  assert.deepStrictEqual(store(graph), {}, 'a failed batch must not write the valid prefix');
  assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')), 'a failed batch must not append journal lines');
});

test('clear-many removes a completed wave with one refresh and is idempotent', () => {
  const state = {};
  for (let i = 1; i <= 3; i++) state[`T-01-0${i}`] = { ...READY };
  const { project, graph } = scratch(state);
  const mark = [DISPATCH, 'mark'];
  for (let i = 1; i <= 3; i++) {
    execFileSync('node', [...mark, `T-01-0${i}`, 'executor'], { cwd: project });
  }
  const before = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8');
  const completed = Object.entries(store(graph)).map(([ticket, record]) => ({
    ticket, dispatch_id: record.dispatch_id,
  }));
  const r = spawnSync('node', [DISPATCH, 'clear-many', '--stdin'], {
    cwd: project,
    input: JSON.stringify(completed),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `batch clear must succeed (${r.stderr})`);
  assert.match(r.stdout, /dispatch cleared for 3 of 3 ticket\(s\)/);
  assert.deepStrictEqual(store(graph), {}, 'all completed records are removed');
  assert.equal(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'), before,
    'clearing is not a second dispatch event');

  // A result can arrive after a record has already lifted on its owner output;
  // the batch remains safe to replay and reports the missing records honestly.
  const again = spawnSync('node', [DISPATCH, 'clear-many', '--stdin'], {
    cwd: project,
    input: JSON.stringify(completed),
    encoding: 'utf8',
  });
  assert.equal(again.status, 0, `replaying clear-many must be harmless (${again.stderr})`);
  assert.match(again.stdout, /dispatch cleared for 0 of 3 ticket\(s\)/);
});

test('clear-many rejects duplicate or malformed ids before mutating the store', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const before = store(graph);
  for (const input of [
    [{ ticket: 'T-01-01', dispatch_id: 'd' }, { ticket: 'T-01-01', dispatch_id: 'e' }],
    [{ ticket: 'T-01-01', dispatch_id: 7 }],
    {},
  ]) {
    const r = spawnSync('node', [DISPATCH, 'clear-many', '--stdin'], {
      cwd: project, input: JSON.stringify(input), encoding: 'utf8',
    });
    assert.equal(r.status, 1, `invalid clear-many payload must refuse: ${JSON.stringify(input)}`);
    assert.deepStrictEqual(store(graph), before, 'a rejected clear batch leaves existing records intact');
  }
});

test('clear-many does not erase a newer dispatch when an older completion arrives', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const oldId = store(graph)['T-01-01'].dispatch_id;
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor'], { cwd: project });
  const currentId = store(graph)['T-01-01'].dispatch_id;
  assert.notEqual(oldId, currentId);
  const r = spawnSync('node', [DISPATCH, 'clear-many', '--stdin'], {
    cwd: project,
    input: JSON.stringify([{ ticket: 'T-01-01', dispatch_id: oldId }]),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dispatch cleared for 0 of 1 ticket\(s\)/);
  assert.equal(store(graph)['T-01-01'].dispatch_id, currentId);
});

suite('dispatch-record — a dispatch records WHAT it dispatched, or says it does not know');

// The whole value of these fields is that a later ladder review reads the journal
// instead of arguing from judgement. That only holds if the record is honest about
// the half nobody measured: the Agent tool takes no effort, so an Agent-dispatched
// judge runs at the SESSION's depth whatever the ladder chose. A recorder that
// helpfully filled the field in would make those rows indistinguishable from the
// Workflow rows that really did carry it — and a review comparing the two would
// conclude something false about both.
//
// So the ABSENCE test comes first: it is the case a later convenience default
// breaks, and it is the only thing standing between this journal and a plausible
// fiction.

const journal = (graph) => fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse);
const lastDispatch = (graph) => journal(graph).filter((e) => e.event === 'dispatch').pop();
const DECIDED_KEYS = [
  'model', 'effort', 'effort_applied', 'reason', 'task_level', 'runtime', 'backend',
  'observed_model', 'observed_effort', 'agent_file', 'agent_id',
];
// What `pipeline-config.cjs model executor --json` returns for a signal-less
// dispatch, in its own `route` field. Taken from the resolver rather than typed
// here — a fixture that drifts from the grammar would make every test below
// assert against a route the resolver cannot produce.
const { routeOf, parseRoute } = require(path.join(SCRIPTS, 'pipeline-config.cjs'));
const ROUTE = routeOf('executor', {});

test('every mark creates a dispatch id for the later usage join', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor'], project);
  assert.equal(r.status, 0, r.stderr);
  const rec = store(graph)['T-01-01'];
  const ev = lastDispatch(graph);
  assert.match(rec.dispatch_id, /^dispatch-/);
  assert.equal(ev.dispatch_id, rec.dispatch_id, 'the store and journal share the same join key');
  assert.ok(r.stdout.includes(`dispatch_id=${rec.dispatch_id}`), 'the caller can pass the id to the attribution ledger');
});

test('an explicit dispatch id is preserved and cannot be active on two tickets', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY }, 'T-01-02': { ...READY } });
  assert.equal(run(['mark', 'T-01-01', 'executor', '--dispatch-id', 'dispatch-fixed'], project).status, 0);
  const rejected = run(['mark', 'T-01-02', 'executor', '--dispatch-id', 'dispatch-fixed'], project);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /already active/);
  assert.equal(store(graph)['T-01-01'].dispatch_id, 'dispatch-fixed');
  assert.ok(!store(graph)['T-01-02'], 'the duplicate id does not create a second active join');
});

test('a mark with no flags writes NO such key at all — not null', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  assert.equal(run(['mark', 'T-01-01', 'executor'], project).status, 0);
  const rec = store(graph)['T-01-01'];
  const ev = lastDispatch(graph);
  for (const k of DECIDED_KEYS) {
    assert.ok(!(k in rec), `the record must not carry "${k}" at all (got ${JSON.stringify(rec[k])})`);
    assert.ok(!(k in ev), `the journal line must not carry "${k}" at all (got ${JSON.stringify(ev[k])})`);
  }
});

test('the Agent path omits --effort-applied and the key STAYS out', () => {
  // The ticket's reason for existing. `arch-review` is dispatched with the Agent
  // tool, which has no effort parameter, so `xhigh` is what the ladder decided and
  // nothing observed what ran. A `null` here would read as a measured unknown.
  const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
  const r = run(['mark', 'T-01-02', 'arch-review', '--model', 'opus', '--effort', 'xhigh'], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  const rec = store(graph)['T-01-02'];
  const ev = lastDispatch(graph);
  assert.equal(rec.effort, 'xhigh', 'what the resolver decided is recorded');
  assert.equal(ev.effort, 'xhigh');
  assert.ok(!('effort_applied' in rec), 'and what the spawn carried is UNRECORDED, not null');
  assert.ok(!('effort_applied' in ev), 'in the journal too — the query reads that key by presence');
});

test('the two claims are never collapsed into one', () => {
  // Not a hypothetical: the deepening the ladder chooses and the depth a spawn can
  // carry are different numbers, and the only implementation that can prove it
  // never copies one into the other is one that records them apart.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  assert.equal(run(['mark', 'T-01-01', 'executor', '--effort', 'high', '--effort-applied', 'low'], project).status, 0);
  const rec = store(graph)['T-01-01'];
  assert.equal(rec.effort, 'high', 'the resolver\'s decision, verbatim');
  assert.equal(rec.effort_applied, 'low', 'and the spawn\'s, verbatim — neither borrowed from the other');
});

test('the full round trip reaches the store AND the journal', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run([
    'mark', 'T-01-01', 'executor',
    '--model', 'opus', '--effort', 'high', '--effort-applied', 'high', '--route', ROUTE,
  ], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  // The KEY is still `reason` — two journal rows carry it and deliver.md's ladder
  // query greps for it — and the VALUE is now the resolver's own route.
  const expect = { model: 'opus', effort: 'high', effort_applied: 'high', reason: ROUTE };
  const rec = store(graph)['T-01-01'];
  for (const [k, v] of Object.entries(expect)) assert.equal(rec[k], v, `record.${k}`);
  const ev = lastDispatch(graph);
  for (const [k, v] of Object.entries(expect)) assert.equal(ev[k], v, `journal.${k}`);
  assert.equal(ev.role, 'executor', 'and the fields the event already had are untouched');
  assert.equal(ev.by, 'dispatch-record');
});

test('requested, applied and observed routing facts round-trip separately', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run([
    'mark', 'T-01-01', 'executor', '--model', 'opus', '--effort', 'high',
    '--effort-applied', 'high', '--route', ROUTE, '--task-level', 'complex',
    '--runtime', 'claude', '--backend', 'workflow', '--observed-model', 'claude-opus-5',
    '--observed-effort', 'xhigh',
  ], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  const rec = store(graph)['T-01-01'];
  assert.equal(rec.task_level, 'complex');
  assert.equal(rec.runtime, 'claude');
  assert.equal(rec.backend, 'workflow');
  assert.equal(rec.effort, 'high', 'requested resolver effort');
  assert.equal(rec.effort_applied, 'high', 'spawn effort');
  assert.equal(rec.observed_model, 'claude-opus-5');
  assert.equal(rec.observed_effort, 'xhigh', 'runtime observation is allowed to differ');
  const ev = lastDispatch(graph);
  for (const key of ['task_level', 'runtime', 'backend', 'effort', 'effort_applied', 'observed_model', 'observed_effort']) {
    assert.equal(ev[key], rec[key], `journal carries ${key}`);
  }
});

test('a known runtime cannot create an unmeasured model dispatch', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor', '--runtime', 'codex'], project);
  assert.equal(r.status, 1, `must refuse (${r.stderr})`);
  assert.ok(/must carry.*model.*route/.test(r.stderr), r.stderr);
  assert.deepStrictEqual(store(graph), {});
});

test('observed model ids reject whitespace and controls but keep opaque ids flexible', () => {
  for (const bad of ['claude opus', 'claude\topus', 'claude\nopus']) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run([
      'mark', 'T-01-01', 'executor', '--runtime', 'claude', '--observed-model', bad,
    ], project);
    assert.equal(r.status, 1, `${JSON.stringify(bad)} must refuse (${r.stderr})`);
    assert.ok(/whitespace or a control character/.test(r.stderr), r.stderr);
    assert.deepStrictEqual(store(graph), {});
  }
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const ok = run([
    'mark', 'T-01-01', 'executor', '--runtime', 'claude', '--route', ROUTE,
    '--observed-model', 'claude-opus-5.1-preview', '--observed-effort', 'unknown',
  ], project);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(store(graph)['T-01-01'].observed_model, 'claude-opus-5.1-preview');
  assert.equal(store(graph)['T-01-01'].observed_effort, 'unknown');
});

test('the flags survive --graph in any position, from a foreign cwd', () => {
  // The guard marks its fixers from inside a ticket worktree, so the two parsers
  // have to coexist: one --graph spelling, stripped anywhere, and the strip must
  // not eat a value flag or the subcommand.
  const s = scratch({ 'T-01-01': { ...READY } });
  const r = run(['--graph', s.graph, 'mark', 'T-01-01', 'ci-fix', '--model', 'sonnet', '--effort', 'high'], s.worktree);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(s.graph)['T-01-01'].model, 'sonnet');
  assert.equal(store(s.graph)['T-01-01'].effort, 'high');
});

test('a value outside TIERS/EFFORTS is refused by name, in the role refusal\'s shape', () => {
  // A mis-spelled alias recorded silently is worse than no field: it would be
  // counted later as fact. The message therefore names the rejected value and
  // prints the accepted set, exactly as the unknown-role refusal does.
  const cases = [
    [['--model', 'gpt-5.6-sol'], 'gpt-5.6-sol', /tiers:/],
    [['--effort', 'ultra'], 'ultra', /efforts:/],
    [['--effort-applied', 'ultra'], 'ultra', /efforts:/],
  ];
  for (const [flags, value, vocabulary] of cases) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run(['mark', 'T-01-01', 'arch-review', ...flags], project);
    assert.equal(r.status, 1, `${flags[0]} must refuse (${r.stderr})`);
    assert.ok(r.stderr.includes(`"${value}"`), `${flags[0]} names the rejected value: ${r.stderr}`);
    assert.ok(vocabulary.test(r.stderr), `${flags[0]} prints the accepted set: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, 'and nothing at all is recorded');
    assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')), 'no half-written journal line either');
  }
});

test('an unknown flag, a duplicate and a missing value are all refused', () => {
  // gate-trailer.cjs's three holes, inherited on purpose. `--modle opus` does not
  // fail on its own: it records a dispatch with no model, which is the silent
  // omission this ticket exists to end.
  const cases = [
    [['--modle', 'opus'], /flags:/],
    [['--model', 'opus', '--model', 'sonnet'], /more than once/],
    [['--model'], /needs a value/],
    [['--effort', '--route', 'x'], /needs a value/],
    [['--route', ''], /not a resolver route/],
    [['opus'], /unexpected argument/],
  ];
  for (const [flags, expected] of cases) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run(['mark', 'T-01-01', 'executor', ...flags], project);
    assert.equal(r.status, 1, `${flags.join(' ')} must refuse (${r.stdout}${r.stderr})`);
    assert.ok(expected.test(r.stderr), `${flags.join(' ')} says why: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, `${flags.join(' ')} records nothing`);
  }
});

test('--agent-file records the Codex file that ran, and refuses one nothing produces', () => {
  // On Codex the model lives IN the file, so the ordinary/-deep choice IS the
  // dispatch's decision. A name the generator does not produce is unverifiable,
  // and an unverifiable name is worse than none.
  const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
  const ok = run(['mark', 'T-01-02', 'arch-review', '--agent-file', 'shipyard-arch-review-deep'], project);
  assert.equal(ok.status, 0, `must succeed (${ok.stderr})`);
  assert.equal(store(graph)['T-01-02'].agent_file, 'shipyard-arch-review-deep', 'verbatim');
  assert.equal(lastDispatch(graph).agent_file, 'shipyard-arch-review-deep');

  const claude = scratch({ 'T-01-02': { ...OPEN_PR } });
  const impossible = run([
    'mark', 'T-01-02', 'arch-review', '--runtime', 'claude',
    '--agent-file', 'shipyard-arch-review', '--route', ROUTE,
  ], claude.project);
  assert.equal(impossible.status, 1, impossible.stderr);
  assert.match(impossible.stderr, /Codex-only/);
  assert.deepStrictEqual(store(claude.graph), {});

  for (const bad of ['shipyard-nope', 'arch-review', 'shipyard-integrator-deep']) {
    const s = scratch({ 'T-01-02': { ...OPEN_PR } });
    const r = run(['mark', 'T-01-02', 'arch-review', '--agent-file', bad], s.project);
    assert.equal(r.status, 1, `"${bad}" must refuse (${r.stderr})`);
    assert.ok(r.stderr.includes(`"${bad}"`), 'and names it');
    assert.deepStrictEqual(store(s.graph), {}, 'nothing recorded');
  }
});

test('the accepted agent files ARE the ones the generator emits', () => {
  // The recorder cannot require the generator — it lives in scripts/ at the repo
  // root and never ships inside the bundle — so the deep set is a local copy. This
  // is the test that stops the copy drifting, the same way DISPATCH_SUBJECT is
  // checked against ROLES rather than against a second list.
  const gen = require(path.join(__dirname, '..', '..', 'scripts', 'gen-codex-shipyard.cjs'));
  const {
    codexAgentFiles, CODEX_DEEP_ROLES, CODEX_DEEP_SUFFIX,
    CODEX_CRITICAL_ROLES, CODEX_CRITICAL_SUFFIX,
  } = require(DISPATCH);
  assert.deepStrictEqual([...CODEX_DEEP_ROLES].sort(), [...gen.DEEP_ROLES].sort(),
    'the deep-eligible roles must be the generator\'s own');
  assert.equal(CODEX_DEEP_SUFFIX, gen.DEEP_SUFFIX);
  assert.deepStrictEqual([...CODEX_CRITICAL_ROLES].sort(), [...gen.CRITICAL_ROLES].sort(),
    'the critical-eligible roles must be the generator\'s own');
  assert.equal(CODEX_CRITICAL_SUFFIX, gen.CRITICAL_SUFFIX);

  // And the ordinary names are one per shipped reference — the generator's own
  // filter — so a reference added there is accepted here without an edit.
  const refs = fs.readdirSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'references'))
    .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const files = codexAgentFiles();
  for (const role of refs) assert.ok(files.has(`shipyard-${role}`), `shipyard-${role} must be accepted`);
  assert.equal(files.size, refs.length + gen.DEEP_ROLES.size + gen.CRITICAL_ROLES.size, 'and nothing else is');
});

test('the front does not gain a field — the overlay is byte-identical', () => {
  // The stop gate reads delivery-front.json, and `refreshFront` rewrites it from a
  // FIXED key list. A new field smuggled into the overlay would either vanish
  // (harmless but a lie in the caller's head) or change the board's shape for a
  // reader that is not ours.
  const seed = (project) => board(project, {
    actionable_count: 1,
    actionable: { execute: ['T-01-01'], publish: [], fix: [], finalize: [], merge: [] },
  });
  const strip = (raw) => {
    const f = JSON.parse(raw);
    // Stamped from the clock on every refresh, so it can never match across two
    // runs; everything else must.
    delete f.dispatches_applied_at;
    delete f.generated_at;
    return f;
  };
  const bare = scratch({ 'T-01-01': { ...READY } });
  seed(bare.project);
  assert.equal(run(['mark', 'T-01-01', 'ci-fix'], bare.project).status, 0);

  const rich = scratch({ 'T-01-01': { ...READY } });
  seed(rich.project);
  // `ci-fix` on both sides, and not `executor`: the role has to be identical for
  // the boards to compare, and it has to be one with an agent file for the
  // --agent-file half of this test to mean anything.
  assert.equal(run([
    'mark', 'T-01-01', 'ci-fix', '--model', 'opus', '--effort', 'high',
    '--effort-applied', 'high', '--route', ROUTE, '--agent-file', 'shipyard-ci-fix-deep',
    '--agent-id', 'agent_01FIXER',
  ], rich.project).status, 0);

  const richRaw = fs.readFileSync(path.join(rich.graph, 'delivery-front.json'), 'utf8');
  assert.deepStrictEqual(
    strip(richRaw),
    strip(fs.readFileSync(path.join(bare.graph, 'delivery-front.json'), 'utf8')),
    'the flags must change nothing about the board'
  );
  for (const k of DECIDED_KEYS) {
    assert.ok(!richRaw.includes(`"${k}"`), `the front must not carry "${k}"`);
  }
  assert.ok(!richRaw.includes('tier=floor'), 'nor the resolver route the reason now holds');
});

suite('dispatch-record — the reason is the RESOLVER\'s route, not the caller\'s sentence');

// The field shipped as `--reason <text>` and deliver.md said the text was "the
// branch the resolver already returned". It was not: the resolver returned
// `{model, effort}` and named the route on stderr, as prose — so the journal held
// the caller's READING of the ladder, in whatever words that caller chose. The
// field exists to make a later ladder review cheap by counting rows, and two
// vocabularies in one field cannot be counted (ADR-006 D5).

test('the route grammar the recorder validates against IS the resolver\'s own', () => {
  // Not a copy: `parseRoute` is exported by the resolver and required here, so the
  // routes it can emit and the routes this recorder accepts are the same set by
  // construction. `CODEX_DEEP_ROLES` is the local copy this repo already pays a
  // pin test for, and one is enough.
  assert.ok(parseRoute(ROUTE), `the resolver's own output must parse: ${ROUTE}`);
  assert.equal(parseRoute(ROUTE).tier.model, 'opus');
  assert.equal(parseRoute(ROUTE).effort.effort, 'high');
});

test('a hand-composed reason is REFUSED, and the message names where the value comes from', () => {
  // Its own branch, not the generic unexpected-argument path: that message names
  // neither the replacement flag nor the command that produces its value, and a
  // caller who cannot see the way forward composes a sentence somewhere else.
  for (const text of ['role baseline', 'signature repeat', 'xhigh because risk high', '']) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run(['mark', 'T-01-01', 'executor', '--reason', text], project);
    assert.equal(r.status, 1, `"${text}" must refuse (${r.stdout}${r.stderr})`);
    assert.ok(/no longer accepted/.test(r.stderr), `it says the flag is gone: ${r.stderr}`);
    assert.ok(/pipeline-config\.cjs model/.test(r.stderr), `and names the resolver: ${r.stderr}`);
    assert.ok(/--route/.test(r.stderr), `and the flag that replaces it: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, 'and nothing is recorded');
  }
});

test('--route records the resolver\'s route VERBATIM, in the store and the journal', () => {
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor', '--route', ROUTE], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(graph)['T-01-01'].reason, ROUTE, 'verbatim, under the key the query already reads');
  assert.equal(lastDispatch(graph).reason, ROUTE);
});

test('--route alone fills model/effort from its own parse, rather than leaving them absent', () => {
  // Copilot: a `--route`-only mark used to store a `reason` that NAMES a model
  // and effort while leaving the structured `model`/`effort` fields empty — a
  // record self-inconsistent in exactly the way the pair/route cross-check
  // exists to catch, just from the other direction. `route` and `{model,
  // effort}` are one claim in two encodings (unlike `effort`/`effort_applied`,
  // which stay deliberately un-cross-filled because they measure different
  // things), so the parse backfills what the flags did not supply.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run(['mark', 'T-01-01', 'executor', '--route', ROUTE], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  const rec = store(graph)['T-01-01'];
  assert.equal(rec.model, parseRoute(ROUTE).tier.model, 'model is read out of the route, not left absent');
  assert.equal(rec.effort, parseRoute(ROUTE).effort.effort, 'same for effort');
  assert.equal(rec.reason, ROUTE);
  // Disagreement is still refused — backfill only fires when a flag is ABSENT.
  const bad = run(['mark', 'T-01-01', 'executor', '--model', 'sonnet', '--route', ROUTE], project);
  assert.equal(bad.status, 1, 'an explicit --model that disagrees with the route must still refuse');
});

test('a sentence posted through the new flag is refused too — the grammar is the check', () => {
  // The refusal has to be about the VALUE and not about the flag's name, or the
  // change would be a rename and the journal would hold prose again by Friday.
  for (const bad of ['role baseline', 'the ceiling fired', 'tier=floor(opus)', 'tier=floor(gpt-5.6-sol) effort=row(high)']) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run(['mark', 'T-01-01', 'executor', '--route', bad], project);
    assert.equal(r.status, 1, `"${bad}" must refuse (${r.stdout}${r.stderr})`);
    assert.ok(/not a resolver route/.test(r.stderr), r.stderr);
    assert.ok(/pipeline-config\.cjs model/.test(r.stderr), 'and names where a real one comes from');
    assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
  }
});

test('a route from ANOTHER dispatch is refused — the pair and the route must agree', () => {
  // A well-formed route is not automatically THIS dispatch's route: the round
  // before, or another role's resolve, produces one that parses perfectly and
  // describes a decision nobody made here. The cross-check is the only thing that
  // can tell those apart, since the route text carries no ticket.
  const cases = [
    [['--model', 'sonnet', '--route', 'tier=floor(opus) effort=row(high)'], /tier "opus".*--model says "sonnet"/s],
    [['--effort', 'xhigh', '--route', 'tier=floor(opus) effort=row(high)'], /effort "high".*--effort says "xhigh"/s],
  ];
  for (const [flags, expected] of cases) {
    const { project, graph } = scratch({ 'T-01-01': { ...READY } });
    const r = run(['mark', 'T-01-01', 'executor', ...flags], project);
    assert.equal(r.status, 1, `${flags.join(' ')} must refuse (${r.stdout}${r.stderr})`);
    assert.ok(expected.test(r.stderr), `it names both sides: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
  }
});

test('--effort-applied is NOT cross-checked, because it is the OTHER claim', () => {
  // The two efforts are two facts (T-25-05): what the ladder decided, and what the
  // spawn could carry. On the Agent path the second is legitimately different, so
  // a check here would refuse exactly the honest dispatches those two fields exist
  // to tell apart — and the journal would lose the only rows that prove the gap.
  const { project, graph } = scratch({ 'T-01-01': { ...READY } });
  const r = run([
    'mark', 'T-01-01', 'executor', '--model', 'opus', '--effort', 'high',
    '--effort-applied', 'low', '--route', ROUTE,
  ], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(graph)['T-01-01'].effort_applied, 'low');
  assert.equal(store(graph)['T-01-01'].reason, ROUTE);
});

test('a KNOWN agent file belonging to another role is refused, and names both', () => {
  // Reproduced before it was a rule: `mark T-01-01 executor --agent-file
  // shipyard-arch-review-deep` was accepted. On Codex the model lives IN the file,
  // so a file from another role makes the model recorded beside it fiction —
  // either the dispatch ran the wrong agent or the record names the wrong file,
  // and the journal must not quietly hold it under either reading.
  const cases = [
    ['arch-review', 'shipyard-ci-fix'],
    ['arch-review', 'shipyard-ci-fix-deep'],
    ['ci-fix', 'shipyard-review-fix'],
    // The role's own file at the WRONG depth is fine — the palette's two rungs are
    // both this role's — so the refusal is about the role, never about `-deep`.
    ['pr-sentinel', 'shipyard-arch-review'],
  ];
  for (const [role, file] of cases) {
    const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
    const r = run(['mark', 'T-01-02', role, '--agent-file', file], project);
    assert.equal(r.status, 1, `${role} × ${file} must refuse (${r.stdout}${r.stderr})`);
    assert.ok(r.stderr.includes(`"${file}"`), `it names the file: ${r.stderr}`);
    assert.ok(r.stderr.includes(role), `and the role it was recorded against: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
  }
});

test('every role accepts its OWN files, and a role with none says so instead', () => {
  // The other half of the check, and the half that keeps the refusal above a
  // discriminator rather than a blanket. It is also where the assumption behind
  // the first draft died: the ladder's roles and the generator's files are NOT
  // one-to-one. `research` ships as `inv-research.md`, and `executor` has no
  // reference at all because it is dispatched by the main loop rather than by a
  // `.toml` — so a check built on `shipyard-<role>` refused every legitimate
  // research mark and offered executors a file name that does not exist.
  const { agentFilesFor, codexAgentFiles } = require(DISPATCH);
  const known = codexAgentFiles();
  let withFiles = 0;
  const claimed = new Set();
  for (const role of ROLES) {
    const files = agentFilesFor(role, known);
    if (!files.size) {
      // Any known file, to prove the refusal is about the ROLE having none rather
      // than about the file being unknown.
      const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
      const r = run(['mark', 'T-01-02', role, '--agent-file', 'shipyard-ci-fix'], project);
      assert.equal(r.status, 1, `${role} has no agent file, so it must refuse (${r.stdout}${r.stderr})`);
      assert.ok(/no agent file/.test(r.stderr), `and say which fact refused it: ${r.stderr}`);
      assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
      continue;
    }
    withFiles += 1;
    for (const file of files) {
      claimed.add(file);
      const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
      const r = run(['mark', 'T-01-02', role, '--agent-file', file], project);
      assert.equal(r.status, 0, `${role} × ${file} must be accepted (${r.stderr})`);
      assert.equal(store(graph)['T-01-02'].agent_file, file);
    }
  }
  assert.ok(withFiles >= 6, `most roles do have a file (${withFiles})`);
  // No shipped file may be unclaimed: one that no role can record is a file the
  // generator emits and this store can never name, which is the mirror of the
  // refusal above and the thing a rename would break silently.
  assert.deepStrictEqual([...claimed].sort(), [...known].sort(),
    'every agent file the generator produces is claimed by exactly one role');
});

suite('dispatch-record — WHICH agent holds it (ADR-007 D1)');

// The record named the ROLE and nothing about the agent, so `front.cjs` collapsed
// a guard's N records into one agent by adding that role string to a Set — and two
// live guards are legitimate (`deliver.md`: re-post one for PRs opened after the
// first started). Reported board: four agents genuinely out, `max=4, in_flight=3,
// free=1`. The cap authorised a fifth, which is not a cap.
//
// The identity is the id the LAUNCH returned, passed verbatim, and it is optional:
// its absence must keep costing a whole agent, because a record nobody can name is
// still an agent that was paid for.

test('--agent-id round-trips into the store, the journal and the reader', () => {
  const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
  const r = run(['mark', 'T-01-02', 'pr-sentinel', '--agent-id', 'agent_01ABCdef-9'], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(graph)['T-01-02'].agent_id, 'agent_01ABCdef-9', 'verbatim in the store');
  assert.equal(lastDispatch(graph).agent_id, 'agent_01ABCdef-9', 'and in the journal');
  assert.equal(activeDispatches(project)['T-01-02'].agent_id, 'agent_01ABCdef-9',
    'and the reader the front counts from hands it over');
});

test('a mark without it reports NO identity — never a blank one', () => {
  // `agentsInFlight` spends a whole agent on a record with no identity, so the
  // reader must say "none" in the one way that counter recognises. A `''` or a
  // `null` smuggled in as an identity is the shape that would collapse two
  // anonymous guards back into one.
  const { project } = scratch({ 'T-01-02': { ...OPEN_PR } });
  assert.equal(run(['mark', 'T-01-02', 'pr-sentinel'], project).status, 0);
  const rec = activeDispatches(project)['T-01-02'];
  assert.ok(!('agent_id' in rec), `no key at all, got ${JSON.stringify(rec)}`);
  const { agentIdOf } = require(DISPATCH);
  assert.strictEqual(agentIdOf(rec), null, 'and the shared reader answers null');
  // The flattened shape and a hand-edited blank answer the same way.
  assert.strictEqual(agentIdOf('pr-sentinel'), null);
  assert.strictEqual(agentIdOf({ role: 'pr-sentinel', agent_id: '   ' }), null);
});

test('an identity nothing can compare is refused, and the refusal says to OMIT the flag', () => {
  // No allowlist: a launch id has no vocabulary, and inventing one is the mistake
  // this repo refused for Codex model ids. Only what cannot be compared or
  // journalled is rejected — and the message must send a caller with no id to the
  // SAFE direction (no flag, one agent counted) rather than to an invented label,
  // which is the one way this field can make the count too small.
  for (const bad of ['', '   ', 'guard one', 'agent\n01', 'x'.repeat(201)]) {
    const { project, graph } = scratch({ 'T-01-02': { ...OPEN_PR } });
    const r = run(['mark', 'T-01-02', 'pr-sentinel', '--agent-id', bad], project);
    assert.equal(r.status, 1, `${JSON.stringify(bad)} must refuse (${r.stdout}${r.stderr})`);
    assert.ok(/OMIT the flag/.test(r.stderr), `and names the safe direction: ${r.stderr}`);
    assert.ok(/verbatim/.test(r.stderr), `and where the value comes from: ${r.stderr}`);
    assert.deepStrictEqual(store(graph), {}, 'nothing recorded');
  }
});

test('two guards recorded through the real CLI come out as TWO agents, end to end', () => {
  // The whole chain, measured rather than reasoned: mark → activeDispatches →
  // computeFront. Guard A holds two PRs, guard B holds one. Before the field
  // existed this board reported `in_flight: 1` however many guards were out.
  const ids = ['T-01-02', 'T-01-03', 'T-01-04'];
  const { project } = scratch(Object.fromEntries(ids.map((id, i) => [id, { ...OPEN_PR, pr: 7 + i }])));
  for (const [id, agent] of [[ids[0], 'agent_A'], [ids[1], 'agent_A'], [ids[2], 'agent_B']]) {
    assert.equal(run(['mark', id, 'pr-sentinel', '--agent-id', agent], project).status, 0);
  }
  const { computeFront } = require(path.join(SCRIPTS, 'front.cjs'));
  const f = computeFront(
    Object.fromEntries(ids.map((id) => [id, {}])),
    readState(path.join(project, '.planning', 'graph')),
    { maxConcurrentAgents: 4, dispatched: activeDispatches(project) }
  );
  assert.strictEqual(f.capacity.in_flight, 2, 'two guards, two agents');
  assert.strictEqual(f.capacity.free, 2);
});

suite('dispatch-record — the docs pass what the record needs, and the query reads it back');

const DOC_MARKS = [
  [path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'commands', 'deliver.md'), 3],
  [path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'references', 'pr-sentinel.md'), 1],
];

test('every documented mark invocation passes the resolved pair', () => {
  // Asserted as a COUNT, not as a spot check: a dispatch added later must not be
  // able to forget the flags, and that is only enforceable if the number of
  // invocation lines and the number of lines carrying `--model` are compared. The
  // corollary is a discipline on the prose — the literal token appears on
  // invocation lines only, and the fields are named without their dashes when a
  // sentence explains them.
  for (const [file, expected] of DOC_MARKS) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const marks = lines.filter((l) => /dispatch-record\.cjs mark <T>/.test(l));
    const rel = path.basename(file);
    assert.ok(marks.length >= expected, `${rel}: expected at least ${expected} mark invocations, found ${marks.length}`);
    for (const l of marks) {
      assert.ok(/--model /.test(l), `${rel}: a mark invocation with no --model: ${l.trim()}`);
      assert.ok(/--effort /.test(l), `${rel}: a mark invocation with no --effort: ${l.trim()}`);
    }
    assert.equal(lines.filter((l) => /--model /.test(l)).length, marks.length,
      `${rel}: --model must appear on the mark invocation lines and nowhere else`);
    // `--reason` is refused by `mark` now (ADR-006 D5) — a MARK INVOCATION that
    // still spells it is not a style nit, it is an instruction the recorder will
    // reject at the moment a guard follows it. Scoped to the invocation lines,
    // not the whole file: prose elsewhere legitimately NAMES the retired flag to
    // explain the change. This is the exact hole a prior version of this same
    // test had (it checked --model/--effort only) while
    // `references/pr-sentinel.md` spelt `--reason "<branch>"` on its own copy of
    // this invocation and went undetected.
    for (const l of marks) {
      assert.ok(!/--reason\b/.test(l),
        `${rel}: a mark invocation still spells the refused --reason flag: ${l.trim()}`);
    }
  }
});

test('every mark deliver.md documents passes the agent identity too', () => {
  // Scoped to deliver.md — DOC_MARKS[0] — on purpose. `references/pr-sentinel.md`
  // carries one mark of its own for a FIXER, whose cardinality is 'ticket' (one
  // agent per record either way, so the identity changes no count there), and that
  // file belongs to another ticket in this phase; adding the assertion over it
  // would fail on a file this change may not touch. Named here rather than left
  // implicit: a deferral addressed to nobody is how the defect above shipped.
  //
  // Presence only, with no "and nowhere else" half: the identity has to be
  // EXPLAINED in prose beside the invocations, and the prose spells it without
  // dashes (`agent id`, `agent_id`) precisely so it stays out of this grep.
  const [file] = DOC_MARKS[0];
  const marks = fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => /dispatch-record\.cjs mark <T>/.test(l));
  assert.ok(marks.length >= 3, `expected the documented invocations, found ${marks.length}`);
  for (const l of marks) {
    assert.ok(/--agent-id /.test(l),
      `a documented mark that records no holder: ${l.trim()}`);
  }
});

test('delivery docs prefer one mark/clear batch per fan-out', () => {
  const sentinel = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'references', 'pr-sentinel.md'), 'utf8');
  assert.match(sentinel, /dispatch-record\.cjs mark-many --stdin/,
    'the background guard must use the same batch launch path');
  assert.match(sentinel, /dispatch-record\.cjs clear-many --stdin/,
    'the background guard must use the same batch cleanup path');
  const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'dispatch-record.md'), 'utf8');
  assert.match(docs, /dispatch-record\.cjs mark-many --stdin/,
    'the operator reference must expose the one-call launch recording path');
  assert.match(docs, /dispatch-record\.cjs clear-many --stdin/,
    'the operator reference must expose the one-call completion cleanup path');
});

test('deliver.md\'s ladder query runs, and UNCONFIRMED is a bucket rather than a hole', () => {
  // The doc's own block is executed, not a copy of it: a query that has drifted
  // from the field names is the one thing that makes this evidence unreadable at
  // the moment somebody needs it.
  const doc = fs.readFileSync(DOC_MARKS[0][0], 'utf8');
  const block = (doc.match(/```bash\n([\s\S]*?)```/g) || [])
    .map((b) => b.replace(/^```bash\n/, '').replace(/```$/, ''))
    .find((b) => b.includes('delivery-log.jsonl') && b.includes('effort_applied'));
  assert.ok(block, 'deliver.md must carry the ladder query beside the flags');

  const { project } = scratch({ 'T-01-01': { ...READY }, 'T-01-02': { ...OPEN_PR } });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-01', 'executor',
    '--model', 'opus', '--effort', 'high', '--effort-applied', 'high'], { cwd: project });
  execFileSync('node', [DISPATCH, 'mark', 'T-01-02', 'arch-review',
    '--model', 'opus', '--effort', 'xhigh'], { cwd: project });

  const r = spawnSync('bash', ['-c', block], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, `the query must run (${r.stderr})`);
  assert.ok(/executor opus resolved:high applied:high': 1/.test(r.stdout),
    `the Workflow row is counted: ${r.stdout}`);
  assert.ok(/arch-review opus resolved:xhigh applied:UNCONFIRMED': 1/.test(r.stdout),
    `and the Agent row reads UNCONFIRMED rather than a guess: ${r.stdout}`);
});

done();
