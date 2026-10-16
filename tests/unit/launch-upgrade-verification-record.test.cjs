'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RECORD = path.join(__dirname, '..', '..', 'docs', 'audits', 'phase50', 'launch-upgrade-verification.md');

const OBLIGATIONS = Object.freeze([
  { heading: 'Pin-reader audit', pendingOwners: ['T-50-27'] },
  { heading: 'catalogue.lock under pid reuse', pendingOwners: ['T-50-08'] },
  { heading: 'Legacy schema marker and version', pendingOwners: ['T-50-04'] },
  { heading: 'Run-store and lease ordering during adoption', pendingOwners: ['T-50-09'] },
  { heading: 'Claude launch without CLAUDE and SHIPYARD variables', pendingOwners: ['T-50-23'] },
  { heading: '.git/info/exclude writer and fresh clone', pendingOwners: ['T-50-24'] },
  { heading: 'Reusable GSD preflight', pendingOwners: [] },
  { heading: 'Upgrade, downgrade, upgrade', pendingOwners: ['T-50-27'] },
  { heading: 'Snapshot staleness reporting', pendingOwners: ['T-50-12'] },
  { heading: 'UI-smoke driver check', pendingOwners: ['T-50-25', 'T-50-27'] },
]);
const GSD_HEADING = 'Reusable GSD preflight';
const STATUS = /^Status: (closed|limitation|pending \((T-50-\d\d)\))\s*$/;

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

test('every L-11 obligation has a section with Status and Evidence', () => {
  const found = sections();
  for (const { heading, pendingOwners } of OBLIGATIONS) {
    const section = found.get(heading);
    assert.ok(section, 'missing section: ' + heading);
    const statuses = section.lines.filter((l) => l.startsWith('Status:'));
    assert.strictEqual(statuses.length, 1, heading + ': exactly one Status line');
    const match = STATUS.exec(statuses[0]);
    assert.ok(match, heading + ': bad Status line: ' + statuses[0]);
    if (match[2]) {
      assert.ok(pendingOwners.includes(match[2]), heading + ': pending owner ' + match[2] + ' not allowed');
    }
    assert.ok(section.lines.some((l) => /^Evidence: \S/.test(l)), heading + ': missing Evidence line');
  }
});

test('reusable GSD preflight carries a Candidate roots contract line', () => {
  const section = sections().get(GSD_HEADING);
  assert.ok(section, 'missing section: ' + GSD_HEADING);
  const roots = section.lines.filter((l) => l.startsWith('Candidate roots:'));
  assert.strictEqual(roots.length, 1, 'exactly one Candidate roots line');
  const entries = roots[0].slice('Candidate roots:'.length).split(';').map((s) => s.trim()).filter(Boolean);
  assert.ok(entries.length >= 1, 'Candidate roots needs at least one entry');
});
