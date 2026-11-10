'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
