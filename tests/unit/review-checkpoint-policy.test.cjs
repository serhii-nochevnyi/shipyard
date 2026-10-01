'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { needsHuman } = require('../../plugins/delivery-pipeline/scripts/front.cjs');

const scripts = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const id = 'T-43-20';
const repo = 'foreign/target';
const head = 'b'.repeat(40);
const branch = `ticket/${id}`;
const epic = 'epic/43-target';
const reviews = [
  { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED',
    commit_id: 'old-head', submitted_at: '2026-09-28T00:00:00Z' },
  { user: { login: 'alice', type: 'User' }, state: 'APPROVED',
    commit_id: head, submitted_at: '2026-09-29T00:00:00Z' },
];
const pr = { number: 20, state: 'OPEN', isDraft: false, headRefName: branch,
  headRefOid: head, baseRefName: epic, author: { login: 'author' },
  title: `${id}: checkpoint`, body: `gate_status: arch-review=conform, head=${head}, checks=green`,
  createdAt: '2026-09-27T00:00:00Z', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
  url: 'https://example.test/pull/20' };

const gh = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CHECKPOINT_GH_CALLS, JSON.stringify(args) + '\\n');
const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const fixture = JSON.parse(fs.readFileSync(process.env.CHECKPOINT_GH_FIXTURE, 'utf8'));
const flag = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
if (args[0] === 'repo' && args[1] === 'view') emit(flag('--json') === 'owner,name'
  ? { owner: { login: 'checkout' }, name: 'source' } : 'main\\n');
else if (args[0] === 'pr' && args[1] === 'list') emit(flag('--repo') === 'foreign/target' ? [fixture.pr] : []);
else if (args[0] === 'pr' && args[1] === 'view') emit(fixture.pr);
else if (args[0] === 'pr' && args[1] === 'checks') emit([{ name: 'test-fast', state: 'SUCCESS', bucket: 'pass' }]);
else if (args[0] === 'api' && /\\/pulls\\/20\\/reviews$/.test(args[1])) emit(fixture.reviews);
else if (args[0] === 'api' && args[1].endsWith('/branches')) emit('main\\n');
else if (args[0] === 'api' && args[1].includes('/compare/')) emit('0\\n');
else if (args[0] === 'api' && args[1].includes('/rules/branches/')) {
  process.stderr.write('rules unavailable\\n'); process.exit(1);
} else if (args[0] === 'api' && args[1].includes('/branches/')) emit({ protected: false });
else if (args[0] === 'api' && args[1] === 'graphql') emit({ data: { repository: { pullRequest: {
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
} } } });
else { process.stderr.write('unexpected gh: ' + args.join(' ') + '\\n'); process.exit(2); }
`;

function setup(reviewRows = reviews) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-checkpoint-policy-'));
  fs.mkdirSync(path.join(root, '.planning', 'graph'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  const ticket = { phase: '43', branch, epic, repo, title: 'checkpoint', depends_on: [],
    risk: 'high', human_checkpoint: true, checkpoint: 'review' };
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({
    git: { base_branch: 'main' }, pipeline: { repos: { [repo]: path.join(root, 'missing-checkout') },
      reviewer_bots: { 'checkout/source': ['alice'], [repo]: [] } },
    delivery_pipeline: { integration_mode: 'epic-stacked', gsd_sync: false },
  }));
  fs.writeFileSync(path.join(root, '.planning', 'graph', 'tickets.json'), JSON.stringify({
    epics: { '43': { branch: epic, base: 'main', repos: [repo] } }, tickets: { [id]: ticket },
  }));
  const fixturePath = path.join(root, 'fixture.json');
  const callsPath = path.join(root, 'calls.jsonl');
  fs.writeFileSync(fixturePath, JSON.stringify({ pr, reviews: reviewRows }));
  fs.writeFileSync(path.join(root, 'bin', 'gh'), gh, { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
    CHECKPOINT_GH_FIXTURE: fixturePath, CHECKPOINT_GH_CALLS: callsPath };
  for (const key of Object.keys(env)) if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_|GH_|GITHUB_)/.test(key)) delete env[key];
  env.HOME = path.join(root, 'home');
  fs.mkdirSync(env.HOME);
  return { root, env, callsPath, ticket };
}

function run(f, script, args = []) {
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 60000,
  });
}

suite('review checkpoint board and live guard share target-repository bot freshness');

test('stale built-in bot plus current human approval clears both decisions despite unknown rules', () => {
  const f = setup();
  try {
    const sync = run(f, 'state-sync.cjs');
    assert.strictEqual(sync.status, 0, `${sync.signal}: ${sync.stderr} ${sync.stdout}`);
    const row = JSON.parse(fs.readFileSync(path.join(f.root, '.planning', 'graph', 'delivery-state.json')))[id];
    assert.deepStrictEqual(row.reviewer_bots, []);
    assert.strictEqual(row.review_fresh, true, JSON.stringify(row));
    assert.strictEqual(needsHuman(f.ticket, row), false);
    const duty = run(f, 'sentinel.cjs', ['duty', '--json']);
    assert.strictEqual(duty.status, 0, duty.stderr);
    const item = JSON.parse(duty.stdout).items.find((entry) => entry.ticket === id);
    assert.strictEqual(item.action, 'merge', JSON.stringify(item));
    const calls = fs.readFileSync(f.callsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.filter((args) => args[0] === 'api' && /\/pulls\/20\/reviews$/.test(args[1])).length >= 2);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('foreign unreadable rules cannot waive a stale-bot-only checkpoint', () => {
  const f = setup([reviews[0]]);
  try {
    const sync = run(f, 'state-sync.cjs');
    assert.strictEqual(sync.status, 0, sync.stderr);
    const row = JSON.parse(fs.readFileSync(path.join(f.root, '.planning', 'graph', 'delivery-state.json')))[id];
    assert.strictEqual(row.review_fresh, false);
    assert.strictEqual(needsHuman(f.ticket, row), true);
    const duty = run(f, 'sentinel.cjs', ['duty', '--json']);
    assert.strictEqual(duty.status, 0, duty.stderr);
    assert.strictEqual(JSON.parse(duty.stdout).items.find((entry) => entry.ticket === id).action, 'human');
    const calls = fs.readFileSync(f.callsPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.some((args) => args[0] === 'api'
      && args[1].startsWith(`repos/${repo}/rules/branches/`)));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

done();
