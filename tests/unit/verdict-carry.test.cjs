'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const CARRY = path.join(ROOT, 'plugins/delivery-pipeline/scripts/gate-trailer.cjs');
const BASE_MERGE = path.join(ROOT, 'plugins/delivery-pipeline/scripts/base-merge.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-carry-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.CARRY_STATUS_DIR;
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(fs.readFileSync(process.env.CARRY_PR_VIEW));
} else if (args[0] === 'api' && args[1].includes('/commits/')) {
  const sha = args[1].split('/commits/')[1].split('/')[0];
  process.stdout.write(fs.existsSync(dir + '/' + sha + '.json') ? fs.readFileSync(dir + '/' + sha + '.json') : '[]');
} else if (args[0] === 'api' && args[1].includes('/statuses/')) {
  const sha = args[1].split('/statuses/')[1];
  const fields = Object.fromEntries(args.filter((x) => x.includes('=')).map((x) => x.split(/=(.*)/s).slice(0, 2)));
  fs.writeFileSync(dir + '/' + sha + '.json', JSON.stringify([{ state: fields.state, context: fields.context, description: fields.description }]));
  fs.appendFileSync(dir + '/posts', sha + '\\n');
  process.stdout.write('{}');
} else process.exit(2);
`);
fs.chmodSync(path.join(bin, 'gh'), 0o755);

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixture({ sibling = 'unowned', adapt = false, duplicate = false, extra = false, treeEqual = false, deferMerge = false } = {}) {
  const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const graph = path.join(repo, 'graph');
  const statuses = path.join(repo, 'statuses');
  fs.mkdirSync(graph);
  fs.mkdirSync(statuses);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'owned.js'), 'function own() { return call(); }\n');
  fs.writeFileSync(path.join(repo, 'owned-other.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'sibling.js'), 'function call() { return 1; }\n');
  git(repo, 'add', 'owned.js', 'owned-other.js', 'sibling.js');
  git(repo, 'commit', '-qm', 'base');
  const judgedBase = git(repo, 'rev-parse', 'HEAD');
  const judgedBaseTree = git(repo, 'rev-parse', 'HEAD^{tree}');
  git(repo, 'branch', 'base');
  git(repo, 'checkout', '-qb', 'ticket');
  fs.appendFileSync(path.join(repo, 'owned.js'), 'function ticket() { return own(); }\n');
  git(repo, 'commit', '-qam', 'ticket patch');
  const from = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'base');
  if (!treeEqual) {
    if (sibling === 'owned') fs.appendFileSync(path.join(repo, 'owned.js'), 'function sibling() { return 2; }\n');
    else if (sibling === 'other-owned') fs.writeFileSync(path.join(repo, 'owned-other.js'), 'module.exports = 2;\n');
    else if (sibling === 'delete-call') fs.writeFileSync(path.join(repo, 'sibling.js'), '// removed call\n');
    else fs.appendFileSync(path.join(repo, 'sibling.js'), 'function sibling() { return 2; }\n');
    git(repo, 'commit', '-qam', 'sibling squash');
  }
  const newBase = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'ticket');
  if (!deferMerge && treeEqual) git(repo, 'commit', '-q', '--allow-empty', '-m', 'empty base merge');
  else if (!deferMerge && sibling === 'owned') {
    const merged = 'function own() { return call(); }\nfunction sibling() { return 2; }\nfunction ticket() { return own(); }\n';
    const merge = spawnSync('git', ['-C', repo, 'merge', '--no-commit', '--no-ff', 'base'], { encoding: 'utf8' });
    assert.strictEqual(merge.status, 1, `expected an owned conflict: ${merge.stdout} ${merge.stderr}`);
    fs.writeFileSync(path.join(repo, 'owned.js'), merged);
    git(repo, 'add', 'owned.js');
    git(repo, 'commit', '-qm', 'resolve owned conflict');
  } else if (!deferMerge) git(repo, 'merge', '-q', '--no-edit', 'base');
  if (!deferMerge && (adapt || duplicate)) {
    fs.appendFileSync(path.join(repo, 'owned.js'), duplicate
      ? 'function ticket() { return own(); }\n' : 'function adapted() { return 3; }\n');
    git(repo, 'commit', '-qam', 'merge adaptation');
  }
  if (extra) {
    fs.writeFileSync(path.join(repo, 'extra.js'), 'module.exports = 1;\n');
    git(repo, 'add', 'extra.js');
    git(repo, 'commit', '-qm', 'non-owned merge adaptation');
  }
  const to = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-01-01': { files: ['owned.js', 'owned-other.js'] } } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-01-01': { pr: 9 } }));
  const prView = path.join(repo, 'view.json');
  fs.writeFileSync(prView, JSON.stringify({ number: 9, headRefOid: from, baseRefName: 'base',
    body: `gate_status: arch-review=conform, drift-check=skipped, degenerate-green=skipped, base_tree=${judgedBaseTree}, head=${from}` }));
  return { repo, graph, statuses, prView, from, to, judgedBase, judgedBaseTree, newBase };
}

function carry(fx, { badBase = false, viaMerge = false } = {}) {
  if (badBase) {
    const view = JSON.parse(fs.readFileSync(fx.prView));
    view.body = view.body.replace(fx.judgedBaseTree, '0'.repeat(40));
    fs.writeFileSync(fx.prView, JSON.stringify(view));
  }
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CARRY_STATUS_DIR: fx.statuses, CARRY_PR_VIEW: fx.prView };
  const args = viaMerge
    ? [BASE_MERGE, 'T-01-01', '--worktree', fx.repo, '--base', 'base', '--graph', fx.graph, '--no-fetch', '--json']
    : [CARRY, 'carry', 'T-01-01', '--pr', '9', '--from', fx.from, '--to', fx.to,
      '--from-base', fx.judgedBase, '--to-base', fx.newBase, '--graph', fx.graph,
      '--worktree', fx.repo, '--json'];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  const posted = fs.existsSync(path.join(fx.statuses, 'posts'))
    ? fs.readFileSync(path.join(fx.statuses, 'posts'), 'utf8').trim().split('\n') : [];
  return { ...r, data: JSON.parse(r.stdout), posted };
}

suite('carry a conform verdict across a sibling base merge');
test('identical own patch carries with patch-id and posts merge-gate', () => {
  const fx = fixture();
  const before = fs.readFileSync(fx.prView, 'utf8');
  const r = carry(fx);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.data.carry, 'patch-id');
  assert.deepStrictEqual(r.posted, [fx.to]);
  const status = JSON.parse(fs.readFileSync(path.join(fx.statuses, fx.to + '.json')))[0];
  assert.strictEqual(status.context, 'merge-gate');
  assert.match(status.description, /carried=patch-id/);
  assert.match(status.description, /degenerate-green=skipped/);
  assert.ok(status.description.length <= 140);
  assert.strictEqual(fs.readFileSync(fx.prView, 'utf8'), before, 'carry must not edit the PR body');
});
test('duplicated block in an owned file re-owes', () => {
  const r = carry(fixture({ duplicate: true }));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.data.carry, 're-owed');
  assert.match(r.data.reason, /owned blob|patch-id/);
  assert.deepStrictEqual(r.posted, []);
});
test('sibling deletion of a called function carries while an owned adaptation re-owes', () => {
  assert.strictEqual(carry(fixture({ sibling: 'delete-call' })).data.carry, 'patch-id');
  const adapted = carry(fixture({ sibling: 'delete-call', adapt: true }));
  assert.strictEqual(adapted.data.carry, 're-owed');
  assert.deepStrictEqual(adapted.posted, []);
});
test('sibling change to an owned path re-owes', () => {
  const r = carry(fixture({ sibling: 'owned' }));
  assert.strictEqual(r.data.carry, 're-owed');
  assert.deepStrictEqual(r.posted, []);
});
test('a sibling-only change to a second declared owned path re-owes', () => {
  const r = carry(fixture({ sibling: 'other-owned' }));
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.data.carry, 're-owed');
  assert.match(r.data.reason, /owned blob.*owned-other\.js/);
  assert.deepStrictEqual(r.posted, []);
});
test('a non-owned path differing from the new base re-owes', () => {
  const r = carry(fixture({ extra: true }));
  assert.strictEqual(r.data.carry, 're-owed');
  assert.match(r.data.reason, /non-owned path extra\.js/);
  assert.deepStrictEqual(r.posted, []);
});
test('unreadable judged base re-owes', () => {
  const r = carry(fixture(), { badBase: true });
  assert.strictEqual(r.data.carry, 're-owed');
  assert.deepStrictEqual(r.posted, []);
});
test('tree-equal path still carries', () => {
  const r = carry(fixture({ treeEqual: true }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.data.carry, 'tree-equal');
});
test('base-merge passes both base refs and reports the patch-id carry', () => {
  const fx = fixture({ deferMerge: true });
  const r = carry(fx, { viaMerge: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.data.carry.carry, 'patch-id');
  assert.strictEqual(r.data.carry.carried, true);
  assert.deepStrictEqual(r.posted, [git(fx.repo, 'rev-parse', 'HEAD')]);
});

done();
