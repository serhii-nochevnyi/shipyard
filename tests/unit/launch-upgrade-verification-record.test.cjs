'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RECORD = path.join(__dirname, '..', '..', 'docs', 'audits', 'phase50', 'launch-upgrade-verification.md');

const OBLIGATIONS = Object.freeze([
  'Pin-reader audit',
  'catalogue.lock under pid reuse',
  'Legacy schema marker and version',
  'Run-store and lease ordering during adoption',
  'Claude launch without CLAUDE and SHIPYARD variables',
  '.git/info/exclude writer and fresh clone',
  'Reusable GSD preflight',
  'Upgrade, downgrade, upgrade',
  'Snapshot staleness reporting',
  'UI-smoke driver check',
]);
const CHECKLIST = Object.freeze([
  'Release checklist: package regeneration',
  'Release checklist: digest-pin conclusion',
  'Release checklist: live receipts on both runtimes',
  'Release checklist: assumption A3',
  'Release checklist: Discrepancy D-1',
]);
const GSD_HEADING = 'Reusable GSD preflight';
const UI_HEADING = 'UI-smoke driver check';
const STATUS = /^Status: (closed|limitation)\s*$/;
const CHECKLIST_STATUS = /^Status: checklist\s*$/;
const DRIVER_STATUSES = ['found', 'absent', 'unreadable', 'not-installed'];

function sections() {
  assert.ok(fs.existsSync(RECORD), 'record missing: ' + RECORD);
  const lines = fs.readFileSync(RECORD, 'utf8').split('\n');
  const found = new Map();
  let current = null;
  for (const line of lines) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) { current = { title: heading[1], lines: [] }; found.set(heading[1], current); continue; }
    if (current) current.lines.push(line);
  }
  return found;
}

function statusLine(section, heading) {
  const statuses = section.lines.filter((l) => l.startsWith('Status:'));
  assert.strictEqual(statuses.length, 1, heading + ': exactly one Status line');
  return statuses[0];
}

test('every L-11 obligation is closed or a limitation, with Evidence', () => {
  const found = sections();
  for (const heading of OBLIGATIONS) {
    const section = found.get(heading);
    assert.ok(section, 'missing section: ' + heading);
    const line = statusLine(section, heading);
    assert.ok(!/pending/i.test(line), heading + ': pending is not allowed: ' + line);
    assert.ok(STATUS.test(line), heading + ': bad Status line: ' + line);
    assert.ok(section.lines.some((l) => /^Evidence: \S/.test(l)), heading + ': missing Evidence line');
  }
});

test('no pending marker survives anywhere in the record', () => {
  assert.ok(!/\bpending \(T-50-\d\d\)/.test(fs.readFileSync(RECORD, 'utf8')));
});

test('the release checklist sections exist with commands and conclusions', () => {
  const found = sections();
  for (const heading of CHECKLIST) {
    const section = found.get(heading);
    assert.ok(section, 'missing checklist section: ' + heading);
    assert.ok(CHECKLIST_STATUS.test(statusLine(section, heading)), heading + ': Status must be checklist');
    assert.ok(section.lines.some((l) => /^Evidence: \S/.test(l)), heading + ': missing Evidence line');
  }
  const body = (heading) => found.get(heading).lines.join('\n');
  assert.ok(body(CHECKLIST[0]).includes('make package-shipyard-codex'));
  assert.ok(body(CHECKLIST[1]).includes('tests/unit/runtime-file-digests.json'));
  assert.ok(body(CHECKLIST[2]).includes('make test-live') && /claude/.test(body(CHECKLIST[2])) && /codex/.test(body(CHECKLIST[2])));
  assert.ok(/A3/.test(body(CHECKLIST[3])));
  assert.ok(/D-1/.test(body(CHECKLIST[4])));
});

test('reusable GSD preflight carries a Candidate roots contract line', () => {
  const section = sections().get(GSD_HEADING);
  assert.ok(section, 'missing section: ' + GSD_HEADING);
  const roots = section.lines.filter((l) => l.startsWith('Candidate roots:'));
  assert.strictEqual(roots.length, 1, 'exactly one Candidate roots line');
  const entries = roots[0].slice('Candidate roots:'.length).split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(entries.length >= 1, 'Candidate roots needs at least one entry');
});

test('UI-smoke driver check quotes its driver_check status and the producing environment', () => {
  const section = sections().get(UI_HEADING);
  assert.ok(section, 'missing section: ' + UI_HEADING);
  const text = section.lines.join('\n');
  assert.ok(/"driver_check":\{"status":"(found|absent|unreadable|not-installed)"/.test(text), 'driver_check status must be quoted');
  const quoted = /"driver_check":\{"status":"([a-z-]+)"/.exec(text)[1];
  assert.ok(DRIVER_STATUSES.includes(quoted), 'unknown driver_check status ' + quoted);
  assert.ok(/Environment that produced the record:/.test(text), 'the producing environment must be named');
  const status = /^Status: (\S+)/m.exec(text)[1];
  assert.strictEqual(status, quoted === 'found' ? 'closed' : 'limitation', 'status must follow the driver check');
});
