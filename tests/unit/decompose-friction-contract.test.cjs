'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const DECOMPOSE = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'decompose.md');

const doc = () => fs.readFileSync(DECOMPOSE, 'utf8');
const normalized = (text) => text.replace(/\s+/g, ' ').toLowerCase();
const has = (text, phrase) => normalized(text).includes(normalized(phrase));
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker after ${start}: ${end}`);
  return text.slice(from, to);
};

suite('decompose friction contract');

test('Step 0 bootstraps a missing GSD project before the Step 0.5 tuning preflight', () => {
  const source = doc();
  const step0 = between(source, '## Step 0 — Find the input', '## Step 0.5 — Mandatory GSD runtime dispatch');
  assert.ok(has(step0, 'adr-bootstrap.cjs --adr <accepted ADR> [--phase <N>] --json'));
  assert.ok(has(step0, 'from the project root'));
  assert.ok(has(step0, 'creates only missing files'));
  assert.ok(has(step0, 'exit 1 means the ADR has no decisions'));
  assert.ok(has(step0, 'never invented'));
  assert.ok(has(step0, 'gsd-tune --apply'));
  assert.ok(has(step0, 'do not apply tuning automatically'));

  const bootstrapAt = source.indexOf('adr-bootstrap.cjs --adr');
  const tuneCheckAt = source.indexOf('gsd-tune.cjs --check');
  assert.ok(bootstrapAt >= 0, 'decompose.md must invoke adr-bootstrap.cjs --adr');
  assert.ok(tuneCheckAt > bootstrapAt, 'the Step 0.5 gsd-tune.cjs --check line must follow Step 0 bootstrap');
});

test('Step 0 warns once on untracked .planning and never blocks on it', () => {
  const step0 = between(doc(), '## Step 0 — Find the input', '## Step 0.5 — Mandatory GSD runtime dispatch');
  assert.ok(has(step0, 'git ls-files --error-unmatch .planning'));
  assert.ok(has(step0, 'never block'));
  assert.ok(has(step0, 'delivery worktrees are created from git'));
  assert.ok(has(step0, 'graph-dir.cjs'));
  assert.ok(has(step0, 'commit `.planning/`'));
  assert.ok(has(step0, 'pass the graph dir explicitly'));
});

test('the host hint relay explains the code in the user language and forbids a bypass', () => {
  const boundary = between(
    doc(),
    '## Step 0.5 — Mandatory GSD runtime dispatch',
    '## Step 1 — Clarify the mode and the ticket size'
  );
  assert.ok(has(boundary, 'hint[<CODE>]'));
  assert.ok(has(boundary, "user's language"));
  assert.ok(has(boundary, 'never propose bypassing'));
});

test('Step 2 keeps the pinned ingest literal and gates --skip-ui on the ADR UI marker', () => {
  const source = doc();
  assert.ok(
    source.includes('/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md'),
    'the pinned ingest invocation must stay byte-identical'
  );
  const step2 = between(source, '## Step 2 — GSD chain', '## Step 3 — Delivery frontmatter extension');
  const literalAt = step2.indexOf('/gsd-plan-phase <N> --ingest .planning/.adr-ingest/*.ingest.md');
  const skipUiAt = step2.indexOf('--skip-ui', literalAt);
  assert.ok(literalAt >= 0 && skipUiAt > literalAt, '--skip-ui must be documented alongside the pinned invocation');
  assert.ok(has(step2, 'UI design:** none'));
  assert.ok(has(step2, 'case-insensitive on `none`'));
});

test('Step 3 treats an ordering-only relation as distinct from a real depends_on', () => {
  const step3 = between(doc(), '## Step 3 — Delivery frontmatter extension', '## Step 4 — Gate 2');
  assert.ok(has(step3, 'ordering without a code dependency is not a `depends_on`'));
  assert.ok(has(step3, "needs every parent's code at once"));
  assert.ok(has(step3, 'shares no files_modified'));
  assert.ok(has(step3, 'real import dependency'));
});

test('Step 5 exports Jira by running and verbatim-executing the script-built plan', () => {
  const step5 = between(doc(), '## Step 5 — Export tickets to Jira (English)', '## Phase 34 experiment intake');
  assert.ok(has(step5, 'jira-export.cjs plan --repo'));
  assert.ok(has(step5, '--project <KEY>'));
  assert.ok(has(step5, 'jira-export.cjs record <T-NN-MM> <KEY>'));
  assert.ok(has(step5, 'is blocked by'));
  assert.ok(has(step5, 'execute each step'));
  assert.ok(has(step5, 'verbatim'));
  assert.ok(has(step5, 're-run `validate-graph.cjs`'));
  assert.ok(has(step5, 'never blocks or fails decomposition'));
});

done();
