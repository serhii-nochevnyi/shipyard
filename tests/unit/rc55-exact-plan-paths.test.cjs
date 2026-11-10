'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./rc55-fixture.cjs');
const validator = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/validate-graph.cjs');

test('Gate 2 refuses wrong tracked directory spelling, including a new child path', t => {
  const f = fixture(t);
  f.write('tests/main_unit/package/Existing.php', '<?php\n');
  f.commit('tracked paths');
  const plan = file => f.write('.planning/phases/01-fix/01-01-PLAN.md', `---
phase: 01-fix
plan: "01"
title: "Repair path spelling"
type: implementation
wave: 1
depends_on: []
files_modified: [${file}]
requirements: [REQ-1]
delivery:
  ticket: T-01-01
  risk: low
  human_checkpoint: false
---
## Goal
Repair.
`);
  const check = () => spawnSync(process.execPath, [validator], { cwd: f.root, env: f.env, encoding: 'utf8' });
  for (const file of ['tests/main_unit/Package/Existing.php', 'tests/main_unit/Package/New.php']) {
    plan(file);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /tracked spelling.*tests\/main_unit\/package/);
  }
  plan('tests/main_unit/package/New.php');
  const result = check();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const target = fixture(t);
  target.git('remote', 'set-url', 'origin', 'git@github.com:acme/target.git');
  target.write('lib/lower/One.php', '<?php\n'); target.commit('target spelling');
  f.write('.planning/config.json', JSON.stringify({ pipeline: { repos: { 'acme/target': target.root } } }));
  plan('lib/Lower/New.php');
  const file = path.join(f.root, '.planning/phases/01-fix/01-01-PLAN.md');
  const fs = require('node:fs');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('delivery:\n', 'delivery:\n  repo: acme/target\n'));
  const foreign = check();
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stdout + foreign.stderr, /tracked spelling.*lib\/lower/);
});
