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
      'T-01': { title: 'first' },
      'T-02': { title: 'second' },
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
    observed_at: record.observed_at,
    generation: 7,
  });
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
  assert.strictEqual(record.generation, 3);
});

test('an exact-ticket override preserves the observation and journals one atomic event', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator named this ticket explicitly', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.override, true);
  assert.strictEqual(record.override_reason, 'operator named this ticket explicitly');
  assert.strictEqual(record.verdict, 'ineligible');
  assert.strictEqual(record.assignee, 'user-5');
  assert.strictEqual(record.generation, 4);
  const events = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepStrictEqual(events, [{
    ts: events[0].ts,
    event: 'tracker_override',
    by: 'tracker-record.cjs override',
    ticket: 'T-01',
    jira_key: 'MYD-1',
    status: 'To Do',
    assignee: 'user-5',
    verdict: 'ineligible',
    observation_reason: record.reason,
    observed_at: record.observed_at,
    override_reason: 'operator named this ticket explicitly',
    generation: 4,
  }]);
});

test('an override that supplies one tracker fact recomputes the complete observation', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--assignee', 'user-5', '--reason', 'operator named this ticket explicitly', '--graph', graph,
  ], { cwd: project });
  const record = stored(graph).tickets['T-01'];
  assert.strictEqual(record.status, 'To Do');
  assert.strictEqual(record.assignee, 'user-5');
  assert.strictEqual(record.verdict, 'ineligible');
  assert.strictEqual(record.eligible, false);
});

test('an override without a current observation stays unknown instead of fabricating eligibility', () => {
  const { project, graph } = scratch();
  execFileSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'urgent named ticket', '--graph', graph,
  ], { cwd: project });
  const record = stored(graph).tickets['T-02'];
  assert.strictEqual(record.override, true);
  assert.strictEqual(record.verdict, 'unknown');
  assert.strictEqual(record.eligible, null);
  assert.strictEqual(record.status, null);
  assert.strictEqual(record.assignee, null);
  assert.match(record.reason, /no current tracker observation/);
});

test('an override expires with its delivery generation', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('an override rolls back the cache when its journal cannot be appended', () => {
  const { project, graph } = scratch();
  fs.mkdirSync(path.join(graph, 'delivery-log.jsonl'));
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'the failed journal append must refuse the operation');
  assert.match(r.stderr, /rolled back/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')), 'a cache without its audit line is not durable');
  assert.ok(fs.statSync(path.join(graph, 'delivery-log.jsonl')).isDirectory());
});

test('activeRecords omits a record after the delivery generation advances', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('a malformed metadata file never falls back to the advisory front generation', () => {
  const { project, graph } = scratch(7);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  fs.writeFileSync(path.join(graph, 'delivery-front.json'), JSON.stringify({ generation: 7 }));
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), '{not-json');
  assert.strictEqual(require(RECORD).currentGeneration(graph), null);
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

test('the eligibility cache does not touch the outbound Jira projection', () => {
  const { project, graph } = scratch();
  const projection = path.join(graph, 'jira-projection.json');
  fs.writeFileSync(projection, JSON.stringify({ marker: 'outbound', tickets: { 'T-01': { key: 'MYD-1' } } }));
  const before = fs.readFileSync(projection, 'utf8');
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.strictEqual(fs.readFileSync(projection, 'utf8'), before);
  assert.ok(stored(graph).tickets['T-01']);
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
