'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const INVESTIGATE = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'investigate.md');
const DOCS = path.join(ROOT, 'docs', 'gsd_multilevel_delivery_pipeline.md');

const readInvestigate = () => fs.readFileSync(INVESTIGATE, 'utf8');
const readDocs = () => fs.readFileSync(DOCS, 'utf8');

const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return text.slice(from, to);
};

suite('investigate friction contract');

test('Step 1 needs only .planning/investigations/ and never requires /gsd-new-project', () => {
  const source = readInvestigate();
  const step1 = between(source, '## Step 1 — Start a new INV', '## Step 2 — Iterative dialogue');
  assert.ok(step1.includes('.planning/investigations/` is created if missing'));
  assert.ok(step1.includes('no GSD project is'));
  assert.ok(step1.includes('decompose bootstraps it from the accepted ADR'));
  assert.ok(!source.includes('/gsd-new-project'), 'investigate.md must not require /gsd-new-project');
});

test('the host hint relay names the code, the user language, and forbids a bypass', () => {
  const runtime = between(readInvestigate(), '## Runtime and host selection', '## Step 0 — Determine the mode');
  assert.ok(runtime.includes('hint[<CODE>]'));
  assert.ok(runtime.includes("user's language"));
  assert.ok(runtime.includes('never'));
  assert.ok(runtime.includes('propose bypassing'));
  assert.ok(runtime.includes('switching runtime'));
});

test('Gate 1 builds the ADR from the shipped template and gates the close on adr-ingest --check', () => {
  const source = readInvestigate();
  const gate1 = between(source, '## Step 3 — Closing (Gate 1)', '## Rules');
  assert.ok(gate1.includes('${CLAUDE_PLUGIN_ROOT}/templates/adr/ADR.md'), 'Gate 1 must name the shipped ADR template');
  assert.ok(gate1.includes('adr-ingest.cjs --check --input <ADR path>'), 'Gate 1 must name the check invocation');
  assert.ok(gate1.includes('must exit 0'));

  const checkAt = gate1.indexOf('adr-ingest.cjs');
  const closeAt = gate1.indexOf('status: closed');
  assert.ok(checkAt >= 0 && closeAt > checkAt, 'the adr-ingest.cjs --check step must precede the close step');

  // Pinned literals (tests/unit/source-contract.test.cjs) stay byte-identical.
  assert.ok(source.includes('each locked decision is one bullet under `## Decision`'));
  assert.ok(source.includes('scope fences use\n     `## Out of scope`'));
});

test('docs drop /gsd-new-project as the investigate precondition and mark it optional in the flow', () => {
  const docs = readDocs();
  assert.ok(!docs.includes('.planning/ is initialized (/gsd-new-project)'));
  const precondition = between(docs, '**What starting a new INV does:**', '2. Creates .planning/investigations');
  assert.ok(precondition.includes('.planning/investigations/ is created if missing'));
  assert.ok(precondition.includes('no GSD'));
  assert.ok(precondition.includes('decompose bootstraps it from the accepted ADR'));

  const flow = between(docs, '## 9. Full operational flow', '# 1. Deep investigation');
  const gsdNewProjectAt = flow.indexOf('/gsd-new-project');
  assert.ok(gsdNewProjectAt >= 0, 'the operational flow must still list /gsd-new-project');
  assert.ok(flow.slice(gsdNewProjectAt, gsdNewProjectAt + 80).includes('optional'), '/gsd-new-project must be marked optional');
});

done();
