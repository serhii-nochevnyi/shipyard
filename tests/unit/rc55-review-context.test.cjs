'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gate = require('../../plugins/delivery-pipeline/scripts/publish-gate.cjs');
const { fixture } = require('./rc55-fixture.cjs');

test('managed publication uses the open PR base instead of origin HEAD', (t) => {
  const f = fixture(t);
  f.git('branch', 'epic', f.base);
  f.git('update-ref', 'refs/remotes/origin/epic', f.base);
  f.git('checkout', '-qb', 'feat/PDF-14187-fix');
  const result = gate.baseFor(f.root, null, { managed: true, branch: 'feat/PDF-14187-fix',
    lookupPr: () => ({ baseRefName: 'epic', headRefName: 'feat/PDF-14187-fix' }) });
  assert.equal(result.base, 'origin/epic');
  assert.equal(result.base_source, 'pull-request');
});

test('recorded graph branch resolves a Jira-style feature name without ticket prefix guessing', (t) => {
  const f = fixture(t);
  f.git('branch', 'epic', f.base);
  f.git('update-ref', 'refs/remotes/origin/epic', f.base);
  f.write('.planning/graph/tickets.json', JSON.stringify({ tickets: {
    'T-11-37': { branch: 'feat/PDF-14187-fix', pr_base: 'epic', repo: 'acme/app' },
  } }));
  f.write('.planning/graph/delivery-state.json', JSON.stringify({ 'T-11-37': {
    branch: 'feat/PDF-14187-fix', base: 'epic',
  } }));
  const result = gate.baseFor(f.root, null, { managed: true, branch: 'feat/PDF-14187-fix',
    projectRoot: f.root, lookupPr: () => null });
  assert.equal(result.base, 'origin/epic');
  assert.equal(result.ticket, 'T-11-37');
});

test('ambiguous repository-qualified branch records refuse instead of choosing default', (t) => {
  const f = fixture(t);
  f.write('.planning/graph/tickets.json', JSON.stringify({ tickets: {
    'T-11-37': { branch: 'feat/fix', pr_base: 'main', repo: 'acme/app' },
    'T-11-38': { branch: 'feat/fix', pr_base: 'main', repo: 'acme/app' },
  } }));
  assert.throws(() => gate.baseFor(f.root, null, { managed: true, branch: 'feat/fix',
    projectRoot: f.root, lookupPr: () => null }), /ambiguous.*branch/i);
});

test('an own-remote upstream is not accepted as an integration base', (t) => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feat/fix');
  f.git('update-ref', 'refs/remotes/origin/feat/fix', f.base);
  f.git('config', 'branch.feat/fix.remote', 'origin');
  f.git('config', 'branch.feat/fix.merge', 'refs/heads/feat/fix');
  assert.throws(() => gate.baseFor(f.root, null, { managed: true, branch: 'feat/fix',
    lookupPr: () => null }), /base|configure/i);
});

for (const explicitGraph of [true, false]) test('remote update preserves graph-derived repository annotation rules: explicit=' + explicitGraph, (t) => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  f.write('.planning/config.json', JSON.stringify({ pipeline: {
    comment_docblocks: { 'acme/app': { tags: ['@var'], public_methods: false } },
  } }));
  f.write('.planning/graph/tickets.json', JSON.stringify({ tickets: {
    'T-11-37': { branch: 'feature', pr_base: 'main', repo: 'acme/app' },
  } }));
  f.write('Example.php', '<?php\n/** @var ClassProxy $proxy */\n');
  const head = f.commit('allowed repository documentation');
  delete f.env.SHIPYARD_GRAPH_DIR;
  delete f.env.SHIPYARD_PROJECT_ROOT;
  const argv = [path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/publish-gate.cjs'),
    '--managed', '--worktree', f.root, '--branch', 'feature', '--head', head, '--push-base', f.base, '--json'];
  if (explicitGraph) argv.push('--graph', path.join(f.root, '.planning/graph'));
  const result = spawnSync(process.execPath, argv, { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ticket, 'T-11-37');
  assert.equal(report.base_source, 'recorded');
  assert.equal(report.push_base, f.base);
  assert.equal(report.totals.protected_comment_lines, 1);
});

function mergedMain(f) {
  f.git('checkout', '-qb', 'feature');
  f.write('docs/notes.md', '# Notes\n');
  const remoteHead = f.commit('feature docs');
  f.git('checkout', '-q', 'main');
  f.write('lib.js', 'const lib = 1;\n// inherited main commentary\n');
  const main = f.commit('main commentary');
  f.git('update-ref', 'refs/remotes/origin/main', main);
  f.git('checkout', '-q', 'feature');
  f.git('merge', '-q', '--no-edit', 'main');
  return { remoteHead, main, head: f.git('rev-parse', 'HEAD') };
}

const openPr = (baseRefName, headRefName = 'feature') => () => ({ number: 7, baseRefName, headRefName });

test('a fast-forward push with an open PR reviews the PR diff and keeps the remote commit', (t) => {
  const f = fixture(t);
  const { remoteHead, main, head } = mergedMain(f);
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head,
    lookupPr: openPr('main') });
  assert.equal(context.base, 'origin/main');
  assert.equal(context.base_source, 'pull-request');
  assert.equal(context.base_commit, main);
  assert.equal(context.push_base, remoteHead);
});

test('a recorded board base is trusted for a push without an open PR', (t) => {
  const f = fixture(t);
  const { remoteHead, main, head } = mergedMain(f);
  const graph = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-graph-'));
  t.after(() => fs.rmSync(graph, { recursive: true, force: true }));
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-1': { branch: 'feature', pr_base: 'main' } } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-1': { branch: 'feature', base: 'main' } }));
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head,
    graphDir: graph, lookupPr: () => null });
  assert.equal(context.base_source, 'recorded');
  assert.equal(context.base_commit, main);
});

for (const [name, options] of [
  ['an explicit flag base', { requestedBase: 'main', lookupPr: () => null }],
  ['a configured fallback base', { configuredBase: 'main', lookupPr: () => null }],
  ['a PR for another head', { lookupPr: openPr('main', 'other') }],
  ['a PR base without an origin branch', { lookupPr: openPr('missing') }],
  ['a PR that targets the source branch', { lookupPr: openPr('feature') }],
  ['a missing pinned head', { lookupPr: openPr('main'), head: null }],
]) test('a push keeps the remote range for ' + name, (t) => {
  const f = fixture(t);
  const { remoteHead, head } = mergedMain(f);
  f.git('update-ref', 'refs/remotes/origin/feature', remoteHead);
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head, ...options });
  assert.equal(context.base, remoteHead);
  assert.equal(context.base_source, 'remote-oid');
  assert.equal(context.base_commit, undefined);
});

test('a push keeps the remote range when the trusted base already contains the head', (t) => {
  const f = fixture(t);
  const { remoteHead, head } = mergedMain(f);
  f.git('update-ref', 'refs/remotes/origin/main', head);
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head,
    lookupPr: openPr('main') });
  assert.equal(context.base_source, 'remote-oid');
});

test('a push keeps the remote range for an unrelated trusted base', (t) => {
  const f = fixture(t);
  const { remoteHead, head } = mergedMain(f);
  f.git('checkout', '-q', '--orphan', 'orphan');
  f.git('update-ref', 'refs/remotes/origin/orphan', f.commit('orphan'));
  f.git('checkout', '-q', 'feature');
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head,
    lookupPr: openPr('orphan') });
  assert.equal(context.base_source, 'remote-oid');
});

test('a push keeps the remote range when the remote commit is not an ancestor of the head', (t) => {
  const f = fixture(t);
  const { head } = mergedMain(f);
  f.git('checkout', '-qb', 'rewritten', f.base);
  f.write('app.js', 'const value = 9;\n');
  const other = f.commit('rewritten remote');
  f.git('checkout', '-q', 'feature');
  const context = gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: other, head,
    lookupPr: openPr('main') });
  assert.equal(context.base, other);
  assert.equal(context.base_source, 'remote-oid');
});

test('push-mode identity checks before base resolution still refuse', (t) => {
  const f = fixture(t);
  const { remoteHead, head } = mergedMain(f);
  const graph = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-graph-'));
  t.after(() => fs.rmSync(graph, { recursive: true, force: true }));
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: { 'T-1': { branch: 'feature', pr_base: 'main' } } }));
  fs.writeFileSync(path.join(graph, 'delivery-state.json'), JSON.stringify({ 'T-1': { branch: 'other', base: 'main' } }));
  assert.throws(() => gate.baseFor(f.root, null, { managed: true, branch: 'feature', pushBase: remoteHead, head,
    graphDir: graph, lookupPr: openPr('main') }), /board branch differs/);
});
