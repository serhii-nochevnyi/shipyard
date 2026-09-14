'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const RECORD = path.join(SCRIPTS, 'tracker-record.cjs');
const PROJECTION = path.join(SCRIPTS, 'jira-project.cjs');

function scratch(generation = 7) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-tracker-'));
  const project = path.join(root, 'project');
  const worktree = path.join(root, 'worktree');
  const graph = path.join(project, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({
    tickets: {
      'T-01': { title: 'first', jira: 'MYD-1' },
      'T-02': { title: 'second', jira: 'MYD-2' },
    },
  }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({
    'T-01': { status: 'pending' },
    'T-02': { status: 'pending' },
  }));
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation }));
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({
    pipeline: { jira_todo_statuses: 'To Do,Backlog' },
  }));
  return { project, worktree, graph };
}

function stored(graph) {
  return JSON.parse(fs.readFileSync(path.join(graph, 'tracker.json'), 'utf8'));
}

const markArgs = (graph, ticket, key, assignee = 'none') => [
  RECORD, 'mark', ticket, key, '--status', 'To Do', '--assignee', assignee, '--graph', graph,
];

suite('tracker-record — generation-bound project cache');

test('a complete eligible observation is stored with the tracker facts and generation', () => {
  const { project, graph } = scratch(7);
  const r = spawnSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const record = stored(graph).tickets['T-01'];
  assert.deepStrictEqual(record, {
    ticket: 'T-01',
    jira_key: 'MYD-1',
    status: 'To Do',
    assignee: null,
    verdict: 'eligible',
    eligible: true,
    reason: 'tracker status "To Do" is configured and the ticket is unassigned',
    assignee_observed: true,
    observed_at: record.observed_at,
    generation: 7,
    generation_identity: record.generation_identity,
  });
  assert.match(record.generation_identity, /^\d+:\d+:/);
  assert.ok(/T-01/.test(r.stdout));
});

test('an assigned observation is durable and ineligible', () => {
  const { project, graph } = scratch();
  const r = spawnSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stored(graph).tickets['T-01'].verdict, 'ineligible');
  assert.strictEqual(stored(graph).tickets['T-01'].assignee, 'user-5');
});

test('unknown observations preserve tracker error words and remain unknown', () => {
  const { project, graph } = scratch(3);
  const r = spawnSync('node', [
    RECORD, 'unknown', 'T-01', 'MYD-1', '--reason', 'Jira API timed out', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.verdict, 'unknown');
  assert.strictEqual(record.eligible, null);
  assert.strictEqual(record.reason, 'Jira API timed out');
  assert.strictEqual(record.assignee_observed, false);
  assert.strictEqual(record.generation, 3);
  assert.match(record.generation_identity, /^\d+:\d+:/);
});

test('activeRecords omits a record after the delivery generation advances', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('a malformed or missing metadata file never falls back to the advisory front generation', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  fs.writeFileSync(path.join(graph, 'delivery-front.json'), JSON.stringify({ generation: 7 }));
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), '{not-json');
  assert.strictEqual(require(RECORD).currentGeneration(graph), null);
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
  fs.rmSync(path.join(graph, 'delivery-state-meta.json'));
  assert.strictEqual(require(RECORD).currentGeneration(graph), 0);
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('recreating metadata at the same numeric generation invalidates the old epoch', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  const meta = path.join(graph, 'delivery-state-meta.json');
  const saved = fs.readFileSync(meta);
  fs.rmSync(meta);
  fs.writeFileSync(meta, saved);
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
});

test('a reset metadata epoch lets a lower new generation replace the old record', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const meta = path.join(graph, 'delivery-state-meta.json');
  fs.rmSync(meta);
  fs.writeFileSync(meta, JSON.stringify({ generation: 1 }));
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  assert.strictEqual(require(RECORD).activeRecords(graph)['T-01'].generation, 1);
  assert.strictEqual(require(RECORD).activeRecords(graph)['T-01'].assignee, 'user-5');
});

test('a tracker record is invalidated when the ticket graph changes its Jira key', () => {
  const { project, graph } = scratch();
  const ticketsFile = path.join(graph, 'tickets.json');
  const tickets = JSON.parse(fs.readFileSync(ticketsFile, 'utf8'));
  tickets.tickets['T-01'].jira = 'MYD-1';
  fs.writeFileSync(ticketsFile, JSON.stringify(tickets));
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  tickets.tickets['T-01'].jira = 'MYD-2';
  fs.writeFileSync(ticketsFile, JSON.stringify(tickets));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('a new observation at the new generation becomes active', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.strictEqual(require(RECORD).activeRecords(graph)['T-01'].generation, 2);
});

test('normal observation refuses missing status or missing explicit assignee', () => {
  const { project, graph } = scratch();
  for (const args of [
    [RECORD, 'mark', 'T-01', 'MYD-1', '--assignee', 'none', '--graph', graph],
    [RECORD, 'mark', 'T-01', 'MYD-1', '--status', 'To Do', '--graph', graph],
  ]) {
    const r = spawnSync('node', args, { cwd: project, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, r.stderr);
  }
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('normal and unknown observations refuse before a published generation exists', () => {
  const { project, graph } = scratch(1);
  fs.rmSync(path.join(graph, 'delivery-state-meta.json'));
  for (const args of [
    markArgs(graph, 'T-01', 'MYD-1'),
    [RECORD, 'unknown', 'T-02', 'MYD-2', '--reason', 'tracker unavailable', '--graph', graph],
  ]) {
    const r = spawnSync('node', args, { cwd: project, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /delivery-state generation is unreadable/);
  }
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 0 }));
  const zero = spawnSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(zero.status, 0);
  assert.match(zero.stderr, /delivery-state generation is unreadable/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('a newer record in the same metadata epoch cannot be overwritten by an older generation', () => {
  const { project, graph } = scratch(8);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const file = path.join(graph, 'tracker.json');
  const store = stored(graph);
  store.tickets['T-01'].generation = 9;
  store.tickets['T-01'].status = 'Backlog';
  store.tickets['T-01'].verdict = 'eligible';
  store.tickets['T-01'].eligible = true;
  fs.writeFileSync(file, JSON.stringify(store));
  const late = spawnSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project, encoding: 'utf8' });
  assert.strictEqual(late.status, 0, late.stderr);
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.generation, 9);
  assert.strictEqual(record.status, 'Backlog');
});

test('normal and unknown observations refuse an invalid observed timestamp', () => {
  const { project, graph } = scratch();
  for (const args of [
    markArgs(graph, 'T-01', 'MYD-1').concat(['--observed-at', 'not-a-date']),
    [RECORD, 'unknown', 'T-02', 'MYD-2', '--reason', 'tracker unavailable', '--observed-at', 'not-a-date', '--graph', graph],
  ]) {
    const r = spawnSync('node', args, { cwd: project, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /observed-at must be a valid date\/time string/);
  }
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('missing graph selection is refused without creating a stray store', () => {
  const { project, worktree } = scratch();
  const r = spawnSync('node', [RECORD, 'mark', 'T-01', 'MYD-1', '--status', 'To Do', '--assignee', 'none'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 0);
  assert.ok(/no ticket graph|--graph/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')));
  assert.ok(fs.existsSync(path.join(project, '.planning', 'graph', 'tickets.json')));
});

test('the cache writes beside the project graph from a foreign cwd', () => {
  const { project, worktree, graph } = scratch();
  const r = spawnSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: worktree, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(graph, 'tracker.json')));
  assert.ok(!fs.existsSync(path.join(worktree, '.planning')));
});

test('a malformed ticket id or key is refused', () => {
  const { project, graph } = scratch();
  for (const args of [
    [RECORD, 'mark', 'T-99', 'MYD-1', '--status', 'To Do', '--assignee', 'none', '--graph', graph],
    [RECORD, 'mark', 'T-01', '', '--status', 'To Do', '--assignee', 'none', '--graph', graph],
  ]) {
    const r = spawnSync('node', args, { cwd: project, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, r.stderr);
  }
});

test('a tracker observation cannot use a Jira key different from the ticket graph', () => {
  const { project, graph } = scratch();
  const tickets = JSON.parse(fs.readFileSync(path.join(graph, 'tickets.json'), 'utf8'));
  tickets.tickets['T-01'].jira = 'MYD-1';
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify(tickets));
  const r = spawnSync('node', markArgs(graph, 'T-01', 'OTHER-1'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /does not match ticket T-01/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('the eligibility cache does not touch the outbound Jira projection', () => {
  const { project, graph } = scratch();
  const projection = path.join(graph, 'jira-projection.json');
  fs.writeFileSync(projection, JSON.stringify({ marker: 'outbound', tickets: { 'T-01': { key: 'MYD-1' } } }));
  const before = fs.readFileSync(projection, 'utf8');
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.strictEqual(fs.readFileSync(projection, 'utf8'), before);
  assert.ok(stored(graph).tickets['T-01']);
});

test('a policy change invalidates a cached verdict until the tracker is read again', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({
    pipeline: { jira_todo_statuses: 'Backlog' },
  }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('an older observation cannot overwrite a newer result after the lock', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', [...markArgs(graph, 'T-01', 'MYD-1'), '--observed-at', '2026-09-14T10:00:00.000Z'], { cwd: project });
  const olderArgs = markArgs(graph, 'T-01', 'MYD-1');
  olderArgs[olderArgs.indexOf('--status') + 1] = 'Backlog';
  olderArgs.push('--observed-at', '2026-09-14T09:00:00.000Z');
  execFileSync('node', olderArgs, { cwd: project });
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.status, 'To Do');
  assert.strictEqual(record.observed_at, '2026-09-14T10:00:00.000Z');
});

test('generation ordering beats observation time when writes arrive out of order', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', [...markArgs(graph, 'T-01', 'MYD-1'), '--observed-at', '2026-09-14T10:00:00.000Z'], { cwd: project });
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 8 }));
  const newerArgs = markArgs(graph, 'T-01', 'MYD-1');
  newerArgs[newerArgs.indexOf('--status') + 1] = 'Backlog';
  newerArgs.push('--observed-at', '2026-09-14T09:00:00.000Z');
  execFileSync('node', newerArgs, { cwd: project });
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.generation, 8);
  assert.strictEqual(record.status, 'Backlog');
});

test('an explicit missing-assignee observation cannot become complete from a copied assignee field', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const file = path.join(graph, 'tracker.json');
  const store = stored(graph);
  store.tickets['T-01'].assignee_observed = false;
  fs.writeFileSync(file, JSON.stringify(store));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
  delete store.tickets['T-01'].assignee_observed;
  fs.writeFileSync(file, JSON.stringify(store));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('concurrent observations for different tickets do not lose records', async () => {
  const { project, graph } = scratch();
  await Promise.all(['T-01', 'T-02'].map((ticket, i) => new Promise((resolve) => {
    const child = require('child_process').spawn('node', markArgs(graph, ticket, `MYD-${i + 1}`), {
      cwd: project,
      stdio: 'ignore',
    });
    child.on('close', resolve);
  })));
  assert.deepStrictEqual(Object.keys(stored(graph).tickets).sort(), ['T-01', 'T-02']);
});

done();
