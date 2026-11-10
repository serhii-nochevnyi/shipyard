'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.equal(report.base_source, 'remote-oid');
  assert.equal(report.totals.protected_comment_lines, 1);
});
