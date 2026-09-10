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

suite('record stores — one --graph spelling means one --graph parser');

// drift-record.cjs and log-event.cjs share ONE `--graph` spelling, so they are
// pinned by ONE table: a divergence between the two parsers is the defect this
// suite exists to catch. Three sibling scripts (escalation-record,
// failure-signature, attempt-history) each grew the guard on the PR where a
// reviewer happened to hit it; these two were never on such a PR, and swallowed
// the following flag as the flag's value.
//
// Every malformed case below runs from the PROJECT cwd — which HAS a ticket
// graph — so the "no ticket graph" refusal cannot fire. A non-zero exit there can
// only be the flag guard, and a test that passed because the script failed for
// the other reason would be no test at all.
const LOGEVENT = path.join(SCRIPTS, 'log-event.cjs');

// SHIPYARD_GRAPH_DIR is the other explicit channel; a value inherited from the
// runner would decide these cases instead of the flag.
const run = (script, args, cwd) => spawnSync('node', [script, ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, SHIPYARD_GRAPH_DIR: '' },
});

const logged = (graph) => {
  try {
    return fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

const PARSERS = [
  {
    what: 'drift-record',
    script: DRIFT,
    cmd: (project) => ['mark', 'T-01', path.join(project, 'p1.md'), 'moved'],
    landed: (graph) => !!store(graph, 'drift.json')['T-01'],
    // Where the unguarded parser used to put the record: `path.resolve('--json')`
    // is a directory literally called "--json" beside the cwd, and the old
    // `|| ''` fallback made a value-less `--graph` resolve to the cwd itself.
    strays: (project) => [path.join(project, '--json'), path.join(project, 'drift.json')],
  },
  {
    what: 'log-event',
    script: LOGEVENT,
    cmd: () => ['attempt', 'ticket=T-01'],
    landed: (graph) => logged(graph).some((e) => e.event === 'attempt' && e.ticket === 'T-01'),
    strays: (project) => [path.join(project, '--json')],
  },
];

for (const p of PARSERS) {
  test(`${p.what} refuses a flag-shaped --graph value instead of resolving it`, () => {
    const { project, graph } = scratch();
    const r = run(p.script, [...p.cmd(project), '--graph', '--json'], project);
    assert.equal(r.status, 1, `must refuse (stderr: ${r.stderr})`);
    // The one message check in this suite, and it is a discriminator rather than
    // a wording assertion: the no-ticket-graph refusal names `--graph` too, so
    // only the quoted VALUE tells the two failures apart.
    assert.ok(/"--json"/.test(r.stderr), `must name the token it refused (stderr: ${r.stderr})`);
    assert.ok(!p.landed(graph), 'a refusal, not a silent redirect into the project store');
    for (const stray of p.strays(project)) {
      assert.ok(!fs.existsSync(stray), `nothing is written to ${stray}`);
    }
  });

  test(`${p.what} refuses --graph with no value at all`, () => {
    // The end-of-argv twin. It used to resolve to the cwd and still count as
    // EXPLICIT, so the refusal that exists for exactly this was skipped and the
    // caller got the default the flag was passed to override.
    const { project, graph } = scratch();
    const r = run(p.script, [...p.cmd(project), '--graph'], project);
    assert.equal(r.status, 1, `must refuse (stderr: ${r.stderr})`);
    assert.ok(!p.landed(graph), 'and does not fall back to the cwd graph');
    for (const stray of p.strays(project)) {
      assert.ok(!fs.existsSync(stray), `nothing is written to ${stray}`);
    }
  });

  test(`${p.what} still takes a real --graph in either position`, () => {
    // The guard must reject flag-shaped values only. A flag tolerated at one end
    // of the argv is a trap for the caller who puts it at the other.
    const first = scratch();
    const rf = run(p.script, ['--graph', first.graph, ...p.cmd(first.project)], first.worktree);
    assert.equal(rf.status, 0, `flag first must succeed (${rf.stderr})`);
    assert.ok(p.landed(first.graph), 'recorded in the PROJECT graph, from a foreign cwd');

    const last = scratch();
    const rl = run(p.script, [...p.cmd(last.project), '--graph', last.graph], last.worktree);
    assert.equal(rl.status, 0, `flag last must succeed (${rl.stderr})`);
    assert.ok(p.landed(last.graph), 'recorded in the PROJECT graph, from a foreign cwd');
  });

  test(`${p.what} with no --graph at all does not eat the first positional`, () => {
    // The `-1` trap, pinned: `i !== flagAt + 1` with no flag present reads as
    // `i !== 0` and strips argv[0] — the subcommand for one script, the event
    // name for the other. Guarding the flag's VALUE must not reintroduce it.
    const { project, graph } = scratch();
    const r = run(p.script, p.cmd(project), project);
    assert.equal(r.status, 0, `must succeed (${r.stderr})`);
    assert.ok(p.landed(graph), 'the first positional survived the flag stripping');
  });
}

suite('record stores — the projection watermark: exactly once, and only forwards');

// The fifth store (ADR-008 D1). It is the same discipline as the four above —
// `--graph` in any position, a refusal when the resolved dir has no ticket
// graph, one lock around the whole read-modify-write, an atomic replace — plus
// the rule that is only ITS: a projection never moves backwards, because a
// reopened PR produces a real `merged` → `pr-open` change and honouring it would
// drag somebody's board back onto a status the conveyor does not treat as a
// regression.
//
// Every write below goes through a HELPER script rather than a CLI verb: this
// ticket ships the store half only, so `markProjected` is a library call and the
// verbs an agent runs (`plan`, `record`) do not exist yet. The helper is the
// smallest possible caller — it reads the module's own stripped ARGV, so the
// real `--graph` parser is what these cases exercise.
const JIRA = path.join(SCRIPTS, 'jira-project.cjs');
const jiraStore = (graph) => store(graph, 'jira-projection.json');

// Written into the temp ROOT, beside the project and the worktree: a helper
// inside either one would be a stray file in exactly the checkout the
// "nothing was written here" assertions inspect.
function marker(project) {
  const file = path.join(path.dirname(project), 'mark.cjs');
  fs.writeFileSync(file, [
    `const P = require(${JSON.stringify(JIRA)});`,
    'const [ticket, to, key, status, tid] = P.ARGV;',
    'try {',
    '  const r = P.markProjected(ticket, to, { key, status, transition_id: tid });',
    '  if (!r.written) { process.stderr.write(`refused: ${r.reason}\\n`); process.exit(3); }',
    '  process.stdout.write(`projected ${ticket} -> ${to}\\n`);',
    '} catch (e) { process.stderr.write(`${e && e.message}\\n`); process.exit(1); }',
    '',
  ].join('\n'));
  return file;
}

test('jira-project honours --graph from a foreign cwd', () => {
  const { project, worktree, graph } = scratch();
  const r = run(marker(project), ['T-01', 'pr-open', 'MYD-1', 'In Progress', '31', '--graph', graph], worktree);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  const rec = jiraStore(graph)['T-01'];
  assert.ok(rec, 'the watermark is in the PROJECT store');
  assert.equal(rec.projected_to, 'pr-open');
  assert.equal(rec.key, 'MYD-1', 'the flag must not be swallowed into a field');
  assert.equal(rec.transition_id, '31', 'the id the agent actually used is recorded');
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')),
    'and no stray .planning appears in the borrowed checkout');
});

test('jira-project takes --graph before the positional arguments too', () => {
  const { project, worktree, graph } = scratch();
  const r = run(marker(project), ['--graph', graph, 'T-02', 'merged'], worktree);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(jiraStore(graph)['T-02'].projected_to, 'merged');
});

test('jira-project refuses a cwd with no ticket graph instead of writing into the void', () => {
  // A watermark written in a worktree is invisible to the next round, which then
  // re-projects the same change: the tracker is transitioned twice, which is the
  // one thing this store exists to prevent.
  const { project, worktree } = scratch();
  const r = run(marker(project), ['T-01', 'pr-open'], worktree);
  assert.equal(r.status, 1, 'must refuse');
  assert.ok(/--graph/.test(r.stderr), 'and name the flag that fixes it');
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')), 'nothing is written');
});

test('jira-project from a plain project cwd works with no flag at all', () => {
  // The `-1` trap again: `i !== flagAt + 1` with no flag present reads as
  // `i !== 0` and eats the first positional — here, the ticket id.
  const { project, graph } = scratch();
  const r = run(marker(project), ['T-03', 'branched'], project);
  assert.equal(r.status, 0, `must succeed (${r.stderr})`);
  assert.equal(jiraStore(graph)['T-03'].projected_to, 'branched', 'the first positional survived');
});

// TWELVE, where the four sibling stores use six — and the number was measured,
// not chosen. With the lock removed, six concurrent marks lost a record in 3 of
// 5 standalone rounds (5/6, the same signature drift-record recorded) but never
// once from inside THIS file: the other cases here spawn children of their own,
// which staggers six starts far enough apart to miss each other. Twelve collide
// through that stagger — 9/12 and 11/12 on the first two mutated runs. An
// assertion nobody has seen fail is not a guard, so the guard is sized to the
// place it actually runs.
const CONCURRENT_MARKS = 12;

test(`${CONCURRENT_MARKS} concurrent projections recorded at once all survive`, async () => {
  const { project, graph } = scratch();
  const mark = marker(project);
  const ids = Array.from({ length: CONCURRENT_MARKS }, (_, k) => `T-${String(k + 1).padStart(2, '0')}`);
  await Promise.all(ids.map((id) => new Promise((resolve) => {
    const child = require('child_process').spawn('node', [mark, id, 'pr-open'],
      { cwd: project, stdio: 'ignore', env: { ...process.env, SHIPYARD_GRAPH_DIR: '' } });
    child.on('close', resolve);
  })));
  const kept = Object.keys(jiraStore(graph));
  assert.equal(kept.length, CONCURRENT_MARKS,
    `all ${CONCURRENT_MARKS} must survive, kept ${kept.length}: ${kept.join(', ')}`);
});

test('a half-written watermark store can never be observed', () => {
  const { project, graph } = scratch();
  const mark = marker(project);
  execFileSync('node', [mark, 'T-01', 'pr-open'], { cwd: project });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(graph, 'jira-projection.json'), 'utf8')),
    'the store on disk is always complete JSON');
  execFileSync('node', [mark, 'T-02', 'merged'], { cwd: project });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(graph, 'jira-projection.json'), 'utf8')));
});

test('a projection at merged is never walked back to pr-open', () => {
  // The reopened-PR case, end to end through the store: `merged` is recorded,
  // the replayed `pr-open` is REFUSED (an ordinary outcome, exit 3, not an
  // error), and the watermark is left where it was.
  const { project, graph } = scratch();
  const mark = marker(project);
  const fwd = run(mark, ['T-01', 'merged', 'MYD-1', 'Done', '41'], project);
  assert.equal(fwd.status, 0, `the forward move lands (${fwd.stderr})`);

  const back = run(mark, ['T-01', 'pr-open', 'MYD-1', 'In Progress', '31'], project);
  assert.equal(back.status, 3, `the backwards move is refused (stdout: ${back.stdout})`);
  assert.ok(/already projected/.test(back.stderr), `and says why (stderr: ${back.stderr})`);
  assert.equal(jiraStore(graph)['T-01'].projected_to, 'merged', 'the watermark did not move');
  assert.equal(jiraStore(graph)['T-01'].transition_id, '41', 'nor was the record overwritten');

  // The same status twice — a replayed journal — is the same skip.
  const again = run(mark, ['T-01', 'merged'], project);
  assert.equal(again.status, 3, 'projecting the same change twice is refused');
});

test('the order is total, and one exported comparator spells it', () => {
  const P = require(JIRA);
  const ORDER = ['pending', 'branched', 'pr-open', 'merged'];
  assert.deepEqual(P.TICKET_STATUSES, ORDER, 'the order is state-sync\'s four statuses');
  for (let i = 0; i < ORDER.length; i++) {
    for (let j = 0; j < ORDER.length; j++) {
      const c = P.compareStatus(ORDER[i], ORDER[j]);
      assert.equal(Math.sign(c), Math.sign(i - j), `${ORDER[i]} vs ${ORDER[j]}`);
    }
  }
  // hasProjected reads that comparator and nothing else: at-or-past is a skip.
  const at = (s) => ({ tickets: { 'T-01': { projected_to: s } } });
  assert.equal(P.hasProjected('T-01', 'pr-open', at('merged')), true, 'past → skip');
  assert.equal(P.hasProjected('T-01', 'merged', at('merged')), true, 'at → skip');
  assert.equal(P.hasProjected('T-01', 'merged', at('pr-open')), false, 'behind → project');
  assert.equal(P.hasProjected('T-01', 'pending', { tickets: {} }), false, 'unrecorded → project');
});

test('an unrecognised status on either side is skipped, never guessed', () => {
  // A value outside the four can only come from a hand-edited store or a caller
  // that invented a status. Neither is evidence that the move is forwards, and
  // an unproven write into someone else\'s tracker is the thing this store
  // refuses. The safe direction is SKIP.
  const P = require(JIRA);
  assert.equal(P.statusRank('finalize'), -1, 'a front BUCKET is not a status');
  assert.equal(P.hasProjected('T-01', 'merged', { tickets: { 'T-01': { projected_to: 'whatever' } } }), true);
  assert.equal(P.hasProjected('T-01', 'finalize', { tickets: { 'T-01': { projected_to: 'pending' } } }), true);
});

test('an unorderable status is refused on the way IN, not only on the way out', () => {
  // The asymmetry that makes the read-side rule insufficient on its own: an
  // UNRECORDED ticket has nothing to compare against, so `hasProjected` answers
  // false and the unorderable value would land — after which every real status
  // for that ticket reads as "already projected" and is skipped forever. A
  // poisoned record that never lifts is worse than the refusal.
  const { project, graph } = scratch();
  const r = run(marker(project), ['T-99', 'finalize'], project);
  assert.equal(r.status, 1, `must refuse (stdout: ${r.stdout})`);
  assert.ok(/not a ticket status/.test(r.stderr), `and say why (stderr: ${r.stderr})`);
  assert.equal(jiraStore(graph)['T-99'], undefined, 'nothing is recorded');
});


done();
