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
const { activeDispatches, DISPATCH_TTL_MS } = require(DISPATCH);

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
const OPEN_PR = { status: 'pr-open', pr: 7, draft: true, checks: { total: 2, failing: 0, pending: 0 } };

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

done();
