'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SCRATCH_FILES, SCRATCH_DIRS, isScratch, statusIgnoringScratch } =
  require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');

function repository(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-scratch-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('only the declared root files and the non-judge archive directory are scratch', () => {
  assert.deepEqual(SCRATCH_FILES, [
    '.shipyard-role-artifact.json', '.shipyard-pr-body.md', '.shipyard-evidence.md',
    '.shipyard-repair-evidence.md', '.shipyard-drift-evidence.md',
    '.shipyard-arch-review-evidence.md', '.shipyard-sentinel-evidence.md',
  ]);
  assert.deepEqual(SCRATCH_DIRS, ['.shipyard-role-artifacts']);
  for (const name of SCRATCH_FILES) assert.equal(isScratch(name, { forJudge: true }), true);
  assert.equal(isScratch('.shipyard-x.js', { forJudge: true }), false);
  assert.equal(isScratch('nested/.shipyard-pr-body.md', { forJudge: true }), false);
  assert.equal(isScratch('.shipyard-role-artifacts/evidence.md', { forJudge: true }), false);
  assert.equal(isScratch('.shipyard-role-artifacts/evidence.md', { forJudge: false }), true);
});

test('status filters only untracked scratch and preserves tracked changes', () => repository((root) => {
  fs.writeFileSync(path.join(root, '.shipyard-pr-body.md'), 'body');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'note');
  const status = statusIgnoringScratch(root, { untracked: 'all' });
  assert.equal(status.ok, true);
  assert.deepEqual(status.entries.map((entry) => entry.path), ['notes.txt']);
  assert.deepEqual(statusIgnoringScratch(root, { untracked: 'no' }).entries, []);
}));

test('judge status keeps archive content and tracked scratch edits visible', () => repository((root) => {
  const archive = path.join(root, '.shipyard-role-artifacts');
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, 'agent.txt'), 'agent');
  assert.deepEqual(statusIgnoringScratch(root, { untracked: 'all' }).entries.map((entry) => entry.path),
    ['.shipyard-role-artifacts/agent.txt']);
  assert.deepEqual(statusIgnoringScratch(root, { untracked: 'all', forJudge: false }).entries, []);
  fs.writeFileSync(path.join(root, '.shipyard-pr-body.md'), 'base');
  execFileSync('git', ['-C', root, 'add', '.shipyard-pr-body.md'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, '.shipyard-pr-body.md'), 'changed');
  assert.equal(statusIgnoringScratch(root, { untracked: 'all' }).entries[0].path, '.shipyard-pr-body.md');
}));

test('oversized status reports a named refusal', () => repository((root) => {
  fs.writeFileSync(path.join(root, 'notes.txt'), 'note');
  assert.deepEqual(statusIgnoringScratch(root, { untracked: 'all', maxBuffer: 1 }),
    { ok: false, code: 'STATUS_TOO_LARGE' });
}));
