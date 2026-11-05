'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureHelpers, installInstructions, initialization, orderedFixture, mutations }
  = require('../fixtures/phase53/codex-preamble-helpers.cjs');

for (const label of ['changed exact input', 'duplicate exact input', 'extra user before input', 'extra user after input',
  'initialization after input', 'global substitution', 'project substitution', 'wrong native cwd', 'wrong native roots',
  'wrong native model', 'wrong native effort', 'wrong task completion']) test('ordinary independent final refuses ' + label, async () => {
  const h = fixtureHelpers();
  await h.publicIntegrationFixture(async f => {
    installInstructions(f);
    const prepared = h.semanticFixture(f, { native(rows, payload) {
      const inputIndex = rows.findIndex(row => row.payload?.role === 'user');
      rows.splice(inputIndex, 0, initialization(f.worktree));
      if (payload.stage !== 'final') return;
      const fixture = orderedFixture().rows;
      const actual = [rows.find(row => row.type === 'session_meta'), rows.find(row => row.type === 'turn_context'),
        rows.find(row => row.payload?.type === 'task_started'), rows[inputIndex], rows[inputIndex + 1], fixture[5], fixture[6],
        rows.find(row => row.payload?.phase === 'final_answer'), rows.find(row => row.payload?.type === 'task_complete')];
      mutations[label](actual);
      rows.splice(0, rows.length, ...actual);
    } });
    await assert.rejects(h.supportedPartitionCaller(f, 'codex', prepared.options));
    assert.equal(prepared.launches.at(-1).payload.stage, 'final');
    assert.equal(h.captureOriginals(f, prepared).length, 2);
    assert.equal(h.coldCurrent(f), null);
  });
});
