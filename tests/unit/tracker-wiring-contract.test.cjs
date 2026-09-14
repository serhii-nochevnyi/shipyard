'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'delivery-pipeline');
const DELIVER = path.join(PLUGIN, 'commands', 'deliver.md');
const STATE_SYNC = path.join(PLUGIN, 'scripts', 'state-sync.cjs');
const FRONT = path.join(PLUGIN, 'scripts', 'front.cjs');
const DISPATCH = path.join(PLUGIN, 'scripts', 'dispatch-record.cjs');

const source = (file) => fs.readFileSync(file, 'utf8');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return text.slice(from, to);
};

suite('tracker wiring — the orchestrator reads once and the writers consume the cache');

test('deliver documents one issue read per pending ticket and fail-closed recording', () => {
  const doc = source(DELIVER);
  const section = between(doc, '### Tracker eligibility read (only when `jira_todo_statuses` is non-empty)', '## Step 2 — Drift-gate');
  assert.match(section, /each pending ticket being considered exactly once/);
  assert.strictEqual((section.match(/getJiraIssue/g) || []).length, 1);
  assert.match(section, /status\.name/);
  assert.match(section, /fields\.status/);
  assert.match(section, /fields\.assignee/);
  assert.match(section, /changelog\/worklog history/);
  assert.match(section, /tracker-record\.cjs mark "\$ticket_id" "\$jira_key"/);
  assert.match(section, /tracker-record\.cjs unknown "\$ticket_id" "\$jira_key"/);
  assert.match(section, /values returned by MCP are data, never shell source/);
  assert.match(section, /--status "\$status_name" --assignee "\$assignee_id"/);
  assert.match(section, /--reason "\$tracker_error"/);
  assert.match(section, /unknown\/incomplete record remains blocked/);
  assert.match(section, /preserve the\s+tracker's error words/);
  assert.match(section, /recompute the front before dispatching/);
  assert.match(section, /set scope never does/);
  const loop = between(doc, '**Loop-back to the fixpoint (after each round/merge — mandatory).**', '## Step 5');
  assert.match(loop, /Repeat the tracker eligibility pass/);
  assert.match(loop, /one\s+issue read per pending candidate per loop-back round\/generation/);
  assert.match(loop, /prior generation's\s+observation as fresh permission/);
});

test('state-sync passes the active tracker records without tracker I/O', () => {
  const doc = source(STATE_SYNC);
  assert.match(doc, /require\(path\.join\(__dirname, 'tracker-record\.cjs'\)\)/);
  const publish = between(doc, "const published = withLock(lockDirFor(ROOT), 'tracker-record'", 'const front = published.front');
  assert.match(publish, /withLock\(lockDirFor\(ROOT\), 'state'/);
  assert.match(publish, /activeTrackersForPublishLocked\(GRAPH_DIR, cfg\.jira_todo_statuses\)/);
  assert.match(publish, /activeTrackersForPublishLocked/);
  assert.match(publish, /previousGenerationIdentity/);
  assert.match(publish, /generationIdentity/);
  assert.match(publish, /previous_generation_identity/);
  const call = between(doc, 'const front = computeFront', 'writeAtomic\(STATE');
  assert.match(call, /trackerStatuses:\s*cfg\.jira_todo_statuses/);
  assert.match(call, /trackerRecords/);
  assert.doesNotMatch(doc, /getJiraIssue|searchJiraIssuesUsingJql|changelog|worklog/);
});

test('front CLI passes the config and coherent tracker snapshot to computeFront', () => {
  const doc = source(FRONT);
  const cli = between(doc, '// ── CLI: read the state files this project already has and print the verdict ──', 'process.exit(0);');
  assert.match(cli, /activeTrackerSnapshotLocked/);
  assert.match(cli, /trackerStatuses:\s*config\.jira_todo_statuses/);
  assert.match(cli, /activeTrackerSnapshotLocked\(dir, config\.jira_todo_statuses\)/);
  assert.match(cli, /withLock\(lockDirFor\(root\), 'tracker-record'/);
  assert.match(cli, /withLock\(\s*lockDirFor\(root\),\s*'state'/);
  const lockBody = between(cli, "withLock(lockDirFor(root), 'tracker-record'", '  } catch (e)');
  assert.match(lockBody, /const trackerRecords = activeTrackerSnapshotLocked\(dir, config\.jira_todo_statuses\)/);
  assert.match(lockBody, /return computeFront\(tickets, state/);
});

test('dispatch refresh uses the same config and coherent tracker snapshot', () => {
  const doc = source(DISPATCH);
  const refresh = between(doc, 'function refreshFront(cwd)', 'module.exports = {');
  assert.match(refresh, /loadConfig\(cwd\)/);
  assert.match(refresh, /activeTrackerSnapshotLocked\(dir, config\.jira_todo_statuses\)/);
  assert.match(refresh, /withLock\(lockDirFor\(cwd\), 'tracker-record'/);
  assert.match(refresh, /withLock\(lockDirFor\(cwd\), 'state'/);
  assert.match(refresh, /trackerStatuses:\s*config\.jira_todo_statuses/);
  assert.match(refresh, /trackerRecords:\s*trackerRecordsForFront\(\)/);
});

test('all front writers leave tracker reads outside the GitHub state lock', () => {
  const sync = source(STATE_SYNC);
  const lockBody = between(sync, "withLock(lockDirFor(ROOT), 'state', () => {", '}, { label: \'state-sync\' })');
  assert.doesNotMatch(lockBody, /getJiraIssue|searchJiraIssuesUsingJql|mcp__/);
  assert.doesNotMatch(source(FRONT), /getJiraIssue|searchJiraIssuesUsingJql|mcp__/);
  assert.doesNotMatch(source(DISPATCH), /getJiraIssue|searchJiraIssuesUsingJql|mcp__/);
});

done();
