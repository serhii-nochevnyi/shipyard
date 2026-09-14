'use strict';

// Delivery cannot turn tracker prose into an executable plan. External tickets
// are intake evidence, while investigation and decomposition are the stages
// that establish the repository and plan contracts the conveyor can execute.

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const DELIVER = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'deliver.md');

function coldStartSection() {
  const source = fs.readFileSync(DELIVER, 'utf8');
  const start = source.indexOf('**The "decomposition not materialized" case**');
  assert.ok(start >= 0, 'deliver.md must retain the unmaterialized-decomposition diagnostic');
  const endMarker = 'NEVER construct tickets.json by hand, bypassing validate-graph.';
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, 'deliver.md cold-start branch must retain its Gate 2 boundary');
  return source.slice(start, end + endMarker.length);
}

suite('delivery cold-start contract');

test('external tickets enter through investigation and decomposition', () => {
  const section = coldStartSection();
  const investigation = section.indexOf('/shipyard:investigate');
  const decomposition = section.indexOf('/shipyard:decompose');
  const gate = section.indexOf('Gate 2 (`validate-graph.cjs`)');

  assert.ok(investigation >= 0, 'external tracker evidence must route to investigation');
  assert.ok(decomposition > investigation, 'decomposition must follow investigation');
  assert.ok(gate > decomposition, 'the explicit Gate 2 instruction must follow decomposition');
  assert.match(section, /external Jira\/GitHub tickets/);
  assert.match(section, /intake evidence only/);
  assert.match(section, /accepted design/);
  assert.match(section, /return[\s\S]+deliver|handoff, not a delivery step/i);
});

test('the delivery cold-start branch has no import or tracker-prose derivation shortcut', () => {
  const section = coldStartSection();
  assert.doesNotMatch(section, /\boffer an import\b/i);
  assert.doesNotMatch(section, /\bimport\b/i);
  assert.doesNotMatch(section, /reads each external ticket and materializes/i);
  assert.doesNotMatch(section, /(?:depends_on|files_modified)[\s\S]{0,120}derive[\s\S]{0,120}from/i);
  assert.doesNotMatch(section, /direct execution/i);
});

done();
