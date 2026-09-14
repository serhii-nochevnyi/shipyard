'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

function stagePendingOverride(graph, beforeStore, afterStore, eventLine, journalBytes, journalSuffix = eventLine, operation) {
  const journal = path.join(graph, 'delivery-log.jsonl');
  const beforeJournal = journalBytes || Buffer.alloc(0);
  fs.writeFileSync(path.join(graph, 'tracker.json'), beforeStore);
  fs.writeFileSync(journal, Buffer.concat([beforeJournal, Buffer.from(journalSuffix)]));
  const marker = {
    version: 1,
    store_exists: true,
    store_file: true,
    before_store: beforeStore.toString('base64'),
    after_store: afterStore.toString('base64'),
    journal_exists: beforeJournal.length > 0,
    journal_file: true,
    journal_offset: beforeJournal.length,
    journal_digest: crypto.createHash('sha256').update(beforeJournal).digest('hex'),
    event_line: eventLine.toString(),
  };
  if (operation) marker.operation = operation;
  fs.writeFileSync(path.join(graph, '.tracker-override.pending.json'), JSON.stringify(marker) + '\n');
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

test('unknown observations preserve an error value that starts like an option', () => {
  const { project, graph } = scratch(3);
  const r = spawnSync('node', [
    RECORD, 'unknown', 'T-01', 'MYD-1', '--reason', '--retry-after 30', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stored(graph).tickets['T-01'].reason, '--retry-after 30');
});

test('an opaque reason may equal --graph before an explicit graph selector', () => {
  const { project, graph } = scratch(3);
  const r = spawnSync('node', [
    RECORD, 'unknown', 'T-01', 'MYD-1', '--reason', '--graph', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stored(graph).tickets['T-01'].reason, '--graph');
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
    assignee_observed: record.assignee_observed,
    observed_at: record.observed_at,
    override_reason: 'operator named this ticket explicitly',
    generation: 4,
  }]);
});

test('a retry after completed override recovery is exactly once', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, Buffer.alloc(0));

  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.strictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'), eventLine.toString());
  assert.strictEqual(stored(graph).tickets['T-01'].override_reason, 'operator choice');
});

test('a retry with changed tracker inputs is a new override operation', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const observedAt = '2026-09-14T10:00:00.000Z';
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--status', 'Backlog', '--assignee', 'user-5',
    '--observed-at', observedAt, '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const operation = {
    event: 'tracker_override',
    ticket: 'T-01',
    jira_key: 'MYD-1',
    override_reason: 'operator choice',
    status_provided: true,
    status: 'Backlog',
    assignee_provided: true,
    assignee: 'user-5',
    observed_at_provided: true,
    observed_at: observedAt,
  };
  stagePendingOverride(graph, beforeStore, beforeStore, eventLine, Buffer.alloc(0), eventLine, operation);

  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--status', 'Backlog', '--assignee', 'user-6',
    '--observed-at', observedAt, '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const events = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(events.length, 2, 'changed tracker facts must not reuse the old recovery');
  assert.strictEqual(stored(graph).tickets['T-01'].assignee, 'user-6');
});

test('an override cannot replace the tracker reason through a CLI alias', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice',
    '--observation-reason', 'invented tracker explanation', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /unknown option --observation-reason/);
  assert.strictEqual(stored(graph).tickets['T-01'].reason,
    'tracker status "To Do" is configured and the ticket is unassigned');
  assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')));
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

test('an override without a current observation is refused', () => {
  const { project, graph } = scratch();
  const r = spawnSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'urgent named ticket', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /requires a current-generation tracker observation/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
  assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')));
});

test('an override cannot invent tracker facts without a current observation', () => {
  const { project, graph } = scratch();
  const r = spawnSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--status', 'Backlog', '--assignee', 'user-5',
    '--reason', 'urgent named ticket', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /requires a current-generation tracker observation/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
  assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')));
});

test('an override cannot turn an unknown assignee into a complete observation', () => {
  const { project, graph } = scratch();
  execFileSync('node', [
    RECORD, 'unknown', 'T-02', 'MYD-2', '--status', 'To Do', '--reason', 'assignee lookup timed out', '--graph', graph,
  ], { cwd: project });
  const r = spawnSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--status', 'Backlog', '--reason', 'operator named this ticket explicitly', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /only after a complete current-generation tracker observation/);
  const record = stored(graph).tickets['T-02'];
  assert.strictEqual(record.verdict, 'unknown');
  assert.strictEqual(record.eligible, null);
  assert.strictEqual(record.assignee_observed, false);
  assert.match(record.reason, /assignee lookup timed out/);
});

test('a plain override preserves an unknown observation and its knownness', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', [
    RECORD, 'unknown', 'T-02', 'MYD-2', '--status', 'To Do',
    '--reason', 'assignee lookup timed out', '--graph', graph,
  ], { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'operator named this ticket explicitly', '--graph', graph,
  ], { cwd: project });
  const record = stored(graph).tickets['T-02'];
  assert.strictEqual(record.verdict, 'unknown');
  assert.strictEqual(record.eligible, null);
  assert.strictEqual(record.status, 'To Do');
  assert.strictEqual(record.assignee, null);
  assert.strictEqual(record.assignee_observed, false);
  assert.strictEqual(record.reason, 'assignee lookup timed out');
});

test('an override cannot replace tracker facts on an existing override', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--status', 'Backlog',
    '--reason', 'second operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /cannot be replaced on an existing exact-ticket override/);
  assert.strictEqual(stored(graph).tickets['T-01'].status, 'To Do');
});

test('an override refuses a malformed delivery generation', () => {
  const { project, graph } = scratch();
  fs.writeFileSync(path.join(graph, 'delivery-front.json'), JSON.stringify({ generation: 7 }));
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), '{not-json');
  const r = spawnSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'urgent named ticket', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'a corrupt generation cannot authorize an override');
  assert.match(r.stderr, /delivery-state generation is unreadable/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('an override refuses an invalid observed timestamp before opening its transaction', () => {
  const { project, graph } = scratch();
  const r = spawnSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'urgent named ticket',
    '--observed-at', 'not-a-date', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /observed-at must be a valid date\/time string/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
});

test('an override rejects observed-at without a replacement tracker fact', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice',
    '--observed-at', '2026-09-14T10:00:00.000Z', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--observed-at requires --status or --assignee/);
  assert.strictEqual(stored(graph).tickets['T-01'].override, undefined);
  assert.ok(!fs.existsSync(path.join(graph, 'delivery-log.jsonl')));
});

test('an override expires with its delivery generation', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('an override rolls back the cache when its journal cannot be appended', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  fs.mkdirSync(path.join(graph, 'delivery-log.jsonl'));
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'the failed journal append must refuse the operation');
  assert.match(r.stderr, /transaction is pending and remains recoverable/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore,
    'a failed override must leave the prior cache record unchanged');
  assert.ok(fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.ok(fs.statSync(path.join(graph, 'delivery-log.jsonl')).isDirectory());
  fs.rmSync(path.join(graph, 'delivery-log.jsonl'), { recursive: true });
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')), 'the next writer must recover the failed transaction');
});

test('recovery finds a completed override after an intervening journal append', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'оператор явно вибрав', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const intervening = Buffer.from('{"event":"status_change","ticket":"T-02"}\n');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, intervening);
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {}, 'readers fail closed while recovery is pending');
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  assert.strictEqual(stored(graph).tickets['T-01'].override, true);
  assert.ok(stored(graph).tickets['T-02']);
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.strictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'),
    intervening.toString() + eventLine.toString());
});

test('recovery validates a completed marker before replacing the cache', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  stagePendingOverride(graph, beforeStore, Buffer.from('{not-json'), eventLine, Buffer.alloc(0));
  const r = spawnSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /completed marker payload is corrupt/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore);
  assert.ok(fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl')), eventLine);
});

test('recovery refuses a corrupt before-store payload before replacing the cache', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  stagePendingOverride(graph, beforeStore, beforeStore, eventLine, Buffer.alloc(0), Buffer.alloc(0));
  const markerFile = path.join(graph, '.tracker-override.pending.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.before_store = Buffer.from('{not-json').toString('base64');
  fs.writeFileSync(markerFile, JSON.stringify(marker) + '\n');

  const r = spawnSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /before_store payload is corrupt/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore);
  assert.ok(fs.existsSync(markerFile), 'the corrupt marker remains for operator recovery');
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl')), Buffer.alloc(0));
});

test('recovery refuses an override appended after a torn journal prefix', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const tornPrefix = Buffer.from('{"event":"interrupted"');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, tornPrefix);
  const journal = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const r = spawnSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /journal prefix ends with an incomplete JSONL line/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore);
  assert.ok(fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl')), journal);
});

test('recovery refuses a complete override after an unrelated torn journal prefix', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const tornPrefix = Buffer.from('{"event":"interrupted"');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, Buffer.alloc(0),
    Buffer.concat([tornPrefix, eventLine]));
  const journal = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));

  const r = spawnSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /incomplete line before the completed override/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore);
  assert.ok(fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl')), journal);
});

test('recovery refuses a completed override followed by a torn journal tail', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const tornTail = Buffer.from('{"event":"interrupted"');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, Buffer.alloc(0),
    Buffer.concat([eventLine, tornTail]));
  const journal = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));

  const r = spawnSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /around the completed override contains an incomplete JSONL line/);
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'tracker.json')), beforeStore);
  assert.ok(fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl')), journal);
});

test('completed recovery is not reused after the delivery generation advances', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, Buffer.alloc(0), eventLine);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));

  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /requires a current-generation tracker observation/);
  assert.strictEqual(stored(graph).tickets['T-01'].generation, 1);
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('recovery of another ticket does not reopen an existing exact-ticket override', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'keep T-01 override', '--graph', graph,
  ], { cwd: project });
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });

  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const journalBefore = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  execFileSync('node', [
    RECORD, 'override', 'T-02', 'MYD-2', '--reason', 'pending T-02 override', '--graph', graph,
  ], { cwd: project });
  const fullJournal = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const eventLine = fullJournal.subarray(journalBefore.length);
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, journalBefore, eventLine);

  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'must read again',
    '--status', 'Backlog', '--assignee', 'none', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /cannot be replaced on an existing exact-ticket override/);
  assert.strictEqual(stored(graph).tickets['T-01'].override, true);
  assert.strictEqual(stored(graph).tickets['T-01'].status, 'To Do');
  assert.strictEqual(stored(graph).tickets['T-02'].override, true);
});

test('recovery truncates only a partial UTF-8 override append', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'оператор явно вибрав', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const eventBytes = Buffer.from(eventLine);
  const cut = eventBytes.indexOf(Buffer.from('оператор')) + 1;
  const partial = eventBytes.subarray(0, cut);
  const intervening = Buffer.from('{"event":"status_change","ticket":"T-02"}\n');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, intervening, partial);
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  assert.strictEqual(stored(graph).tickets['T-01'].override, undefined);
  assert.ok(stored(graph).tickets['T-02']);
  assert.strictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'), intervening.toString());
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
});

test('recovery removes a partial override prefix before an intervening complete append', () => {
  const { project, graph } = scratch();
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  const beforeStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'оператор явно вибрав', '--graph', graph,
  ], { cwd: project });
  const afterStore = fs.readFileSync(path.join(graph, 'tracker.json'));
  const eventLine = fs.readFileSync(path.join(graph, 'delivery-log.jsonl'));
  const eventBytes = Buffer.from(eventLine);
  const cut = eventBytes.indexOf(Buffer.from('оператор')) + 1;
  const partial = eventBytes.subarray(0, cut);
  const intervening = Buffer.from('{"event":"status_change","ticket":"T-02"}\n');
  stagePendingOverride(graph, beforeStore, afterStore, eventLine, Buffer.alloc(0),
    Buffer.concat([partial, intervening]));
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  assert.strictEqual(stored(graph).tickets['T-01'].override, undefined);
  assert.ok(stored(graph).tickets['T-02']);
  assert.strictEqual(fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8'),
    intervening.toString());
  assert.ok(!fs.existsSync(path.join(graph, '.tracker-override.pending.json')));
});

test('tracker-record rejects extra positional arguments instead of ignoring them', () => {
  const { project, graph } = scratch();
  const r = spawnSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', 'unexpected', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /usage: tracker-record\.cjs/);
  assert.ok(!fs.existsSync(path.join(graph, 'tracker.json')));
});

test('activeRecords omits a record after the delivery generation advances', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  assert.ok(require(RECORD).activeRecords(graph)['T-01']);
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({ generation: 2 }));
  assert.deepStrictEqual(require(RECORD).activeRecords(graph), {});
});

test('the previous-generation reader is derived internally and cannot be caller-selected', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const previousIdentity = stored(graph).tickets['T-01'].generation_identity;
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({
    generation: 2,
    previous_generation_identity: previousIdentity,
  }));
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  const record = require(RECORD);
  assert.deepStrictEqual(Object.keys(record.activePreviousTrackers(graph)), ['T-01']);
  assert.deepStrictEqual(Object.keys(record.activeRecords(graph)), ['T-02']);
  assert.deepStrictEqual(record.activeRecords(graph, 1), record.activeRecords(graph));
});

test('the front snapshot combines only the current and publisher-backed predecessor', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const previousIdentity = stored(graph).tickets['T-01'].generation_identity;
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({
    generation: 2,
    previous_generation_identity: previousIdentity,
  }));
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  const record = require(RECORD);
  assert.deepStrictEqual(Object.keys(record.activeTrackerSnapshot(graph)), ['T-01', 'T-02']);
  const isolated = scratch(1);
  execFileSync('node', markArgs(isolated.graph, 'T-01', 'MYD-1'), { cwd: isolated.project });
  fs.writeFileSync(path.join(isolated.graph, 'delivery-state-meta.json'), JSON.stringify({
    generation: 2,
    previous_generation_identity: 'different-publication-epoch',
  }));
  assert.deepStrictEqual(Object.keys(record.activeTrackerSnapshot(isolated.graph)), []);
});

test('the predecessor bridge does not carry a direct override into the next generation', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const previousIdentity = stored(graph).tickets['T-01'].generation_identity;
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({
    generation: 2,
    previous_generation_identity: previousIdentity,
  }));
  execFileSync('node', markArgs(graph, 'T-02', 'MYD-2'), { cwd: project });
  const record = require(RECORD);
  assert.deepStrictEqual(Object.keys(record.activePreviousTrackers(graph)), []);
  assert.deepStrictEqual(Object.keys(record.activeTrackerSnapshot(graph)), ['T-02']);
});

test('the state-sync publish reader excludes a current-generation override', () => {
  const { project, graph } = scratch(4);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1', 'user-5'), { cwd: project });
  execFileSync('node', [
    RECORD, 'override', 'T-01', 'MYD-1', '--reason', 'operator choice', '--graph', graph,
  ], { cwd: project });
  const record = require(RECORD);
  assert.ok(record.activeRecords(graph)['T-01'], 'the ordinary reader honors the current override');
  assert.deepStrictEqual(
    record.activeTrackersForPublish(graph),
    {},
    'the next published snapshot must not extend the override by one generation'
  );
});

test('an invalid current-generation record fences the predecessor fallback', () => {
  const { project, graph } = scratch(1);
  execFileSync('node', markArgs(graph, 'T-01', 'MYD-1'), { cwd: project });
  const previousIdentity = stored(graph).tickets['T-01'].generation_identity;
  fs.writeFileSync(path.join(graph, 'delivery-state-meta.json'), JSON.stringify({
    generation: 2,
    previous_generation_identity: previousIdentity,
  }));
  const current = markArgs(graph, 'T-01', 'MYD-1');
  current[current.indexOf('--status') + 1] = 'Backlog';
  execFileSync('node', current, { cwd: project });
  fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({
    pipeline: { jira_todo_statuses: 'To Do' },
  }));
  const record = require(RECORD);
  assert.deepStrictEqual(record.activeTrackerSnapshot(graph), {});
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
