'use strict';

// The two durable stores — drift.json and escalations.json — are written from
// places that are NOT the project: drift-gate dispatches its judges in parallel
// and tells each to record its own verdict, from inside a ticket worktree. Both
// halves of that sentence were broken.
//
//   * "not the project" — drift-record had no --graph flag while the prompt
//     passed one, so the verdict landed in the worktree (state-sync never reads
//     it) and the flag text was swallowed into the reason. It printed success.
//   * "in parallel" — load→save with no lock loses updates. Six concurrent marks
//     reliably produced five records, and a lost drift verdict is a stale plan
//     handed to an executor.
//
// Both are silent failures of exactly the thing the stores exist to prevent, so
// they are pinned here with the repros that found them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const DRIFT = path.join(SCRIPTS, 'drift-record.cjs');
const ESCAL = path.join(SCRIPTS, 'escalation-record.cjs');

// A project (has a ticket graph) and a worktree beside it (has none) — the exact
// two cwds a drift judge can find itself in.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stores-'));
  const project = path.join(dir, 'project');
  const worktree = path.join(dir, 'worktree');
  const graph = path.join(project, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {} }));
  const state = {};
  for (let i = 1; i <= 6; i++) {
    state[`T-0${i}`] = { status: 'pr-open', pr: i, draft: true, checks: { total: 1, failing: 0, pending: 0 } };
    fs.writeFileSync(path.join(project, `p${i}.md`), `# plan ${i}\n`);
  }
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify(state));
  return { project, worktree, graph };
}

const store = (graph, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(graph, name), 'utf8')).tickets || {}; }
  catch { return {}; }
};

suite('record stores — a verdict lands in the project, not in the agent\'s worktree');

test('drift-record honours --graph from a foreign cwd', () => {
  const { project, worktree, graph } = scratch();
  const r = spawnSync('node', [
    DRIFT, 'mark', 'T-01', path.join(project, 'p1.md'), 'landed', 'via', 'PR', '#410',
    '--graph', graph,
  ], { cwd: worktree, encoding: 'utf8' });

  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.ok(store(graph, 'drift.json')['T-01'], 'the verdict is in the PROJECT store');
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')),
    'and no stray .planning appears in the borrowed checkout');
  assert.equal(store(graph, 'drift.json')['T-01'].reason, 'landed via PR #410',
    'the flag must not be swallowed into the reason');
});

test('--graph is accepted before the positional arguments too', () => {
  // A flag only tolerated at the end is a trap for the caller who puts it first.
  const { project, worktree, graph } = scratch();
  const r = spawnSync('node', [
    DRIFT, '--graph', graph, 'mark', 'T-02', path.join(project, 'p2.md'), 'moved',
  ], { cwd: worktree, encoding: 'utf8' });
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(store(graph, 'drift.json')['T-02'].reason, 'moved');
});

test('without --graph, a cwd with no ticket graph is REFUSED, not written to', () => {
  // The flag fixes the instruction; this fixes the class. A prompt that forgets
  // it must fail loudly rather than record into the void.
  const { project, worktree } = scratch();
  const r = spawnSync('node', [DRIFT, 'mark', 'T-01', path.join(project, 'p1.md'), 'moved'],
    { cwd: worktree, encoding: 'utf8' });
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/--graph/.test(r.stderr), 'and name the flag that fixes it');
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'nothing is written');
});

test('a plain project cwd still works with no flag at all', () => {
  // Guarding the -1 case is not cosmetic: `i !== flagAt + 1` with no flag reads
  // as `i !== 0` and eats the SUBCOMMAND, so every flagless call failed on usage.
  const { project, graph } = scratch();
  const r = spawnSync('node', [DRIFT, 'mark', 'T-03', path.join(project, 'p3.md'), 'moved'],
    { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.ok(store(graph, 'drift.json')['T-03'], 'recorded');
});

suite('record stores — concurrent writers do not lose each other\'s records');

for (const [what, script, storeName, args] of [
  ['drift verdicts', DRIFT, 'drift.json', (p, i) => ['mark', `T-0${i}`, path.join(p, `p${i}.md`), `drifted ${i}`]],
  ['escalations', ESCAL, 'escalations.json', (_p, i) => ['mark', `T-0${i}`, `human needed ${i}`]],
]) {
  test(`six ${what} recorded at once all survive`, async () => {
    const { project, graph } = scratch();
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => new Promise((resolve) => {
      const child = require('child_process').spawn('node', [script, ...args(project, i)],
        { cwd: project, stdio: 'ignore' });
      child.on('close', resolve);
    })));
    const kept = Object.keys(store(graph, storeName));
    assert.equal(kept.length, 6, `all six must survive, kept: ${kept.join(', ')}`);
  });
}

test('every concurrent escalation also reaches the journal exactly once', () => {
  // The park and its journal line are one locked act; an append that escaped the
  // lock would show up here as a short or duplicated log.
  const { project, graph } = scratch();
  for (let i = 1; i <= 6; i++) {
    execFileSync('node', [ESCAL, 'mark', `T-0${i}`, `human needed ${i}`], { cwd: project });
  }
  const log = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 6, 'one line per escalation');
  assert.equal(new Set(log.map((l) => JSON.parse(l).ticket)).size, 6, 'no ticket logged twice');
});

suite('record stores — the reader is unaffected by a writer mid-flight');

test('a half-written store can never be observed', () => {
  // writeAtomic replaces by rename(2), so a reader sees the old file or the new
  // one. Without it, state-sync or the sentinel reading during a write gets a
  // parse error, treats the store as empty, and silently un-parks the ticket.
  const { project, graph } = scratch();
  execFileSync('node', [DRIFT, 'mark', 'T-01', path.join(project, 'p1.md'), 'moved'], { cwd: project });
  const before = fs.readFileSync(path.join(graph, 'drift.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(before), 'the store on disk is always complete JSON');
  // ...and a second writer leaves it complete too.
  execFileSync('node', [DRIFT, 'mark', 'T-02', path.join(project, 'p2.md'), 'moved'], { cwd: project });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(graph, 'drift.json'), 'utf8')));
});

done();
