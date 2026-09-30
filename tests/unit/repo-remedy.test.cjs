'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { computeSignature } = require('../../plugins/delivery-pipeline/scripts/failure-signature.cjs');
const coverage = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');

const SCRIPT = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/repo-remedy.cjs');
const TICKET = 'T-43-18';
const REPO = 'owner/repo';
const LOG = 'FAIL tests/screenshot.test.js\nAssertionError: screenshot differs\n';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-remedy-'));
  const graph = path.join(root, '.planning', 'graph');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(graph, { recursive: true });
  fs.mkdirSync(bin);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Remedy Test');
  git('config', 'user.email', 'remedy@example.test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'file'), 'initial\n');
  git('add', 'file'); git('commit', '-qm', 'initial');
  git('checkout', '-qb', 'ticket/T-43-18');
  const head = git('rev-parse', 'HEAD');
  const signatureFile = path.join(root, 'failure.log');
  fs.writeFileSync(signatureFile, LOG);
  const signature = computeSignature(LOG).signature;
  const evidenceFile = path.join(root, 'failure-evidence.json');
  const writeEvidence = (value = { signature, head }) => fs.writeFileSync(evidenceFile, JSON.stringify(value));
  writeEvidence();
  const writeConfig = (entries = [{ signature, workflow: 'repair.yml', inputs: { z: 'last', a: 'first' } }], max = 2) => {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ pipeline: {
      max_attempts: max, repo_remedies: { [REPO]: entries },
    } }));
  };
  writeConfig();
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {
    [TICKET]: { repo: REPO, branch: 'ticket/T-43-18' },
  } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ [TICKET]: {
    repo: REPO, branch: 'ticket/T-43-18', pr: 43,
  } }));
  const stateFile = path.join(root, 'gh-state.json');
  const callsFile = path.join(root, 'gh-calls.jsonl');
  const state = { pr: { number: 43, headRefName: 'ticket/T-43-18', headRefOid: head,
    headRepository: { nameWithOwner: REPO } }, run: null, list: null, commit: null };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
if (args[0] === 'workflow' && args[1] === 'run') process.exit(state.failWorkflow ? 1 : 0);
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(state.pr));
else if (args[0] === 'api' && /actions\\/runs\\/\\d+$/.test(args[1])) console.log(JSON.stringify(state.run));
else if (args[0] === 'api' && args[1].includes('actions/runs?')) console.log(JSON.stringify(state.list));
else if (args[0] === 'api' && args[1].includes('/commits/')) console.log(JSON.stringify(state.commit));
else process.exit(1);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    GH_STATE: stateFile, GH_CALLS: callsFile, SHIPYARD_COVERAGE_ROOT: path.join(root, 'coverage') };
  const invoke = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--graph', graph, '--json'],
    { cwd: root, env, encoding: 'utf8' });
  const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const events = () => fs.existsSync(path.join(graph, 'delivery-log.jsonl'))
    ? fs.readFileSync(path.join(graph, 'delivery-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, graph, git, head, signature, signatureFile, evidenceFile, writeEvidence,
    state, save, writeConfig, invoke, calls, events, env };
}

test('only the declared signature matches; dispatch uses exact argv and journals one charged event', () => {
  const f = fixture();
  const matched = f.invoke('match', '--repo', REPO, '--signature-file', f.signatureFile);
  assert.equal(matched.status, 0, matched.stderr);
  assert.equal(JSON.parse(matched.stdout).match.entry_index, 0);
  fs.writeFileSync(f.signatureFile, f.signature + '\n');
  assert.equal(JSON.parse(f.invoke('match', '--repo', REPO, '--signature-file', f.signatureFile).stdout).match.entry_index, 0);
  const dispatched = f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0', '--signature-file', f.evidenceFile);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.deepEqual(f.calls().filter((args) => args[0] === 'workflow'), [
    ['workflow', 'run', 'repair.yml', '--repo', REPO, '--ref', 'ticket/T-43-18', '-f', 'a=first', '-f', 'z=last'],
  ]);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0].event, 'remedy_dispatch');
  assert.equal(f.events()[0].head, f.head);
  assert.equal(f.events()[0].inputs, undefined);
  assert.match(f.events()[0].inputs_digest, /^[0-9a-f]{64}$/);
});

test('run refuses absent, nonmatching, and head-stale signature evidence', () => {
  const f = fixture();
  const base = ['run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0'];
  assert.notEqual(f.invoke(...base).status, 0, 'signature evidence is mandatory');
  assert.notEqual(f.invoke(...base, '--signature-file', f.signatureFile).status, 0,
    'a raw log has no failure head');
  f.writeEvidence({ signature: 'a'.repeat(16), head: f.head });
  assert.notEqual(f.invoke(...base, '--signature-file', f.evidenceFile).status, 0,
    'the selected declaration must match the current signature');
  f.writeEvidence({ signature: f.signature, head: 'b'.repeat(40) });
  assert.notEqual(f.invoke(...base, '--signature-file', f.evidenceFile).status, 0,
    'evidence for an earlier head is stale');
  f.writeEvidence();
  f.state.pr.headRefOid = 'c'.repeat(40); f.save();
  assert.notEqual(f.invoke(...base, '--signature-file', f.evidenceFile).status, 0,
    'a PR head change makes the evidence stale');
  assert.equal(f.calls().some((args) => args[0] === 'workflow'), false);
  assert.equal(f.events().length, 0);
});

test('one validated config snapshot supplies both declaration and attempt budget', () => {
  const f = fixture();
  f.writeConfig(undefined, 1);
  fs.writeFileSync(path.join(f.graph, 'delivery-log.jsonl'), JSON.stringify({ ticket: TICKET,
    event: 'remedy_dispatch', ts: new Date().toISOString(), pr: 43, repo: REPO,
    entry_index: 0, signature: f.signature, workflow: 'repair.yml', ref: 'ticket/T-43-18',
    bot: 'github-actions[bot]', inputs_digest: 'b'.repeat(64), head: f.head }) + '\n');
  const program = `const fs = require('node:fs');
const config = require(process.argv[1]);
const original = config.loadConfig;
let reads = 0;
config.loadConfig = (...args) => {
  const loaded = original(...args);
  if (++reads === 1) fs.writeFileSync(process.argv[3], '{invalid');
  return loaded;
};
const remedy = require(process.argv[2]);
try { remedy.run({ticket: 'T-43-18', repo: 'owner/repo', pr: 43, index: 0,
    signatureFile: process.argv[5], graph: process.argv[4]});
  process.exitCode = 2;
} catch (error) { console.error(error.message); }`;
  const result = spawnSync(process.execPath, ['-e', program,
    path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/pipeline-config.cjs'), SCRIPT,
    path.join(f.root, '.planning', 'config.json'), f.graph, f.evidenceFile],
  { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /attempt budget exhausted/);
  assert.equal(f.calls().some((args) => args[0] === 'workflow'), false);
  assert.equal(f.events().length, 1);
});

test('undeclared, malformed and exhausted entries never dispatch', () => {
  const f = fixture();
  fs.writeFileSync(f.signatureFile, 'TypeError: a different failure');
  assert.equal(JSON.parse(f.invoke('match', '--repo', REPO, '--signature-file', f.signatureFile).stdout).match, null);
  for (const entry of ['-1', '1', 'nope']) {
    assert.notEqual(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', entry,
      '--signature-file', f.evidenceFile).status, 0);
  }
  f.writeConfig([{ signature: f.signature, workflow: '../unsafe.yml' }]);
  assert.notEqual(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0',
    '--signature-file', f.evidenceFile).status, 0);
  f.writeConfig(undefined, 1);
  fs.writeFileSync(path.join(f.graph, 'delivery-log.jsonl'), JSON.stringify({ ticket: TICKET,
    event: 'remedy_dispatch', ts: new Date().toISOString(), pr: 43, repo: REPO,
    entry_index: 0, signature: f.signature, workflow: 'repair.yml', ref: 'ticket/T-43-18',
    bot: 'github-actions[bot]', inputs_digest: 'b'.repeat(64), head: f.head }) + '\n');
  assert.notEqual(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0',
    '--signature-file', f.evidenceFile).status, 0);
  assert.equal(f.calls().some((args) => args[0] === 'workflow'), false);
});

test('ticket/PR mismatches and a failed gh dispatch write no attempt', () => {
  const f = fixture();
  for (const args of [
    ['T-43-99', '--repo', REPO, '--pr', '43'],
    [TICKET, '--repo', 'other/repo', '--pr', '43'],
    [TICKET, '--repo', REPO, '--pr', '99'],
  ]) {
    assert.notEqual(f.invoke('run', ...args, '--entry', '0', '--signature-file', f.evidenceFile).status, 0);
  }
  f.state.failWorkflow = true; f.save();
  assert.notEqual(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0',
    '--signature-file', f.evidenceFile).status, 0);
  assert.equal(f.events().length, 0);
});

test('the project repository is resolved from origin when the graph repo is null', () => {
  const f = fixture();
  f.git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  fs.writeFileSync(path.join(f.graph, 'tickets.json'), JSON.stringify({ tickets: {
    [TICKET]: { repo: null, branch: 'ticket/T-43-18' },
  } }));
  assert.equal(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0',
    '--signature-file', f.evidenceFile).status, 0);
});

test('run attribution requires unique matching workflow metadata, parent and bot', () => {
  const f = fixture();
  assert.equal(f.invoke('run', TICKET, '--repo', REPO, '--pr', '43', '--entry', '0',
    '--signature-file', f.evidenceFile).status, 0);
  fs.writeFileSync(path.join(f.root, 'file'), 'remedied\n');
  f.git('add', 'file'); f.git('commit', '-qm', 'remedy');
  const next = f.git('rev-parse', 'HEAD');
  const dispatch = f.events()[0];
  f.state.pr.headRefOid = next;
  f.state.run = { id: 72, repository: { full_name: REPO }, path: '.github/workflows/repair.yml',
    event: 'workflow_dispatch', head_branch: dispatch.ref, head_sha: f.head,
    created_at: new Date(Date.parse(dispatch.ts) + 1000).toISOString(), status: 'completed', conclusion: 'success' };
  f.state.list = { total_count: 1, workflow_runs: [f.state.run] };
  f.state.commit = { sha: next, author: { login: 'github-actions[bot]' }, parents: [{ sha: f.head }] };
  const check = () => f.invoke('attribute', TICKET, '--repo', REPO, '--run', '72');
  for (const [field, bad] of [['path', '.github/workflows/other.yml'], ['head_branch', 'other'],
    ['head_sha', next], ['created_at', new Date(Date.parse(dispatch.ts) - 1000).toISOString()],
    ['repository', { full_name: 'other/repo' }], ['id', 73]]) {
    const original = f.state.run[field];
    f.state.run[field] = bad; f.save();
    assert.equal(JSON.parse(check().stdout).result, 'unattributed', field);
    f.state.run[field] = original;
  }
  f.state.list.workflow_runs = [f.state.run, { ...f.state.run, id: 73 }]; f.save();
  assert.equal(JSON.parse(check().stdout).result, 'unattributed');
  f.state.list.workflow_runs = [{ ...f.state.run, id: 73 }]; f.save();
  assert.equal(JSON.parse(check().stdout).result, 'unattributed');
  f.state.list.workflow_runs = [f.state.run];
  f.state.commit.parents = [{ sha: next }]; f.save();
  assert.equal(JSON.parse(check().stdout).result, 'unattributed');
  f.state.commit.parents = [{ sha: f.head }]; f.state.commit.author.login = 'other[bot]'; f.save();
  assert.equal(JSON.parse(check().stdout).result, 'unattributed');
  f.state.commit.author.login = 'github-actions[bot]'; f.save();
  f.writeConfig([{ signature: f.signature, workflow: 'repair.yml', inputs: { a: 'changed' } }]);
  assert.equal(JSON.parse(check().stdout).result, 'unattributed');
  f.writeConfig();
  assert.equal(coverage.verify({ commit: next, repo: REPO, worktree: f.root,
    root: path.join(f.root, 'coverage') }).covered, false);
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, 'attributed');
  assert.equal(coverage.verify({ commit: next, repo: REPO, worktree: f.root,
    root: path.join(f.root, 'coverage') }).covered, true);
});
