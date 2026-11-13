'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./rc55-fixture.cjs');
const validator = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/validate-graph.cjs');

function plan(f, phaseDir, id, jira) {
  const [, phase, number] = id.split('-');
  f.write(`.planning/phases/${phaseDir}/${phase}-${number}-PLAN.md`, `---
phase: ${phase}
plan: "${number}"
title: "Add widget ${id}"
type: implementation
wave: 1
depends_on: []
files_modified: [src/${id}.js]
requirements: [REQ-1]
delivery:
  ticket: ${id}
  risk: low
  human_checkpoint: false
${jira ? `  jira: ${jira}\n` : ''}---
## Goal
Build.
`);
}

function validate(f) {
  const result = spawnSync(process.execPath, [validator], { cwd: f.root, env: f.env, encoding: 'utf8' });
  const graph = result.status === 0
    ? JSON.parse(fs.readFileSync(path.join(f.root, '.planning/graph/tickets.json'), 'utf8')) : null;
  return { result, graph, output: result.stdout + result.stderr };
}

function setup(t, epicJira) {
  const f = fixture(t);
  plan(f, '01-widgets', 'T-01-01', 'APP-11');
  plan(f, '02-gadgets', 'T-02-01', null);
  if (epicJira !== undefined) f.write('.planning/config.json', JSON.stringify({ delivery_pipeline: { epic_jira: epicJira } }));
  return f;
}

test('without epic_jira the epic key is still the first ticket key and names the branch', t => {
  const { result, graph, output } = validate(setup(t));
  assert.equal(result.status, 0, output);
  assert.equal(graph.epics['1'].jira, 'APP-11');
  assert.equal(graph.epics['1'].branch, 'feat/APP-11-widgets');
  assert.equal(graph.epics['2'].jira, null);
  assert.equal(graph.epics['2'].branch, 'feat/gadgets');
});

test('a configured epic key wins for the epic record and branch, by padded phase or directory name', t => {
  const { result, graph, output } = validate(setup(t, { '01': 'APP-100', '02-gadgets': 'APP-200' }));
  assert.equal(result.status, 0, output);
  assert.equal(graph.epics['1'].jira, 'APP-100');
  assert.equal(graph.epics['1'].branch, 'feat/APP-100-widgets');
  assert.equal(graph.epics['2'].jira, 'APP-200');
  assert.equal(graph.epics['2'].branch, 'feat/APP-200-gadgets');
  assert.equal(graph.tickets['T-01-01'].jira, 'APP-11');
  assert.equal(graph.tickets['T-01-01'].epic, 'feat/APP-100-widgets');
});

test('an invalid epic key is skipped with a warning and the default derivation stays', t => {
  const { result, graph, output } = validate(setup(t, { '1': 'not-a-key' }));
  assert.equal(result.status, 0, output);
  assert.match(output, /warning: delivery_pipeline\.epic_jira\."1".*not a Jira key/);
  assert.equal(graph.epics['1'].jira, 'APP-11');
});

test('an epic_jira entry matching no phase is reported', t => {
  const { result, output } = validate(setup(t, { '9': 'APP-900' }));
  assert.equal(result.status, 0, output);
  assert.match(output, /epic_jira\."9" matches no phase in the graph/);
});
