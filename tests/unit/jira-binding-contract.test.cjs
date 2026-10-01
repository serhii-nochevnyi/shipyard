'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, 'plugins', 'delivery-pipeline', 'commands', 'decompose.md');
const EXPORT_SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'jira-export.cjs');
const text = fs.readFileSync(DOC, 'utf8');
const normalized = text.replace(/\s+/g, ' ');

suite('decompose Jira binding contract');

test('proposes a ticket-to-issue mapping from investigation Jira input and records approved keys', () => {
  assert.match(normalized, /PROBLEM\.md.*intake|intake.*PROBLEM\.md/i);
  assert.match(normalized, /ticket → existing Jira issue mapping/i);
  assert.match(normalized, /jira-export\.cjs record/);
});

test('shows the Jira mapping beside the ticket set for Gate 2 approval', () => {
  assert.match(normalized, /mapping.{0,100}beside the ticket set|beside the ticket set.{0,100}mapping/i);
  assert.match(normalized, /Gate 2/);
});

test('documents key lookup, no-create refusal, and unlabelled transition-comment behavior', () => {
  assert.match(normalized, /recorded key.{0,100}looked up by key/i);
  assert.match(normalized, /recorded key.{0,160}never created|never create.{0,100}recorded key/i);
  assert.match(normalized, /unknown key.{0,100}(stop|refus)/i);
  assert.match(normalized, /unlabelled.{0,120}(transitioned and commented|transition and comment)/i);
});

test('the documented record and plan commands resolve to the export script API', () => {
  assert.ok(fs.statSync(EXPORT_SCRIPT).isFile());
  const exporter = require(EXPORT_SCRIPT);
  assert.equal(typeof exporter.recordKey, 'function');
  assert.equal(typeof exporter.planExport, 'function');
  assert.match(normalized, /jira-export\.cjs plan/);
  assert.match(normalized, /jira-export\.cjs record/);
});

done();
