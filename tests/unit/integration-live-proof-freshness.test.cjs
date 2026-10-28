'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadOwner } = require('./helpers/integration-owner.cjs');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, write, commit } = loadOwner([
  'publicIntegrationFixture', 'publicPartitionFixture', 'supportedPartitionCaller', 'write', 'commit']);

for (const [outcome, runtime] of [['failed', 'codex'], ['incomplete', 'claude'], ['context', 'codex']]) test('behavior ' + runtime + ' late ' + outcome + ' prevents final', async () => {
  await publicIntegrationFixture(async f => {
    write(f.worktree, 'src/unchanged.cjs', 'exports.primary = "complete source continuation";\n'.repeat(6500));
    commit(f, 'multiple original units for late failure');
    let units = 0;
    const prepared = publicPartitionFixture(f, runtime, { observed: true, result(result, payload) {
      if (payload.kind !== 'unit' || ++units !== 2) return;
      if (outcome === 'failed') result.outcome = 'failed';
      if (outcome === 'incomplete') result.completeness = 'incomplete';
      if (outcome === 'context') result.required_context = ['missing context'];
    } });
    await assert.rejects(supportedPartitionCaller(f, runtime, prepared.options));
    assert.equal(units, 2);
    assert.equal(prepared.controls.launches.some(launch => launch.payload.kind === 'phase'), false);
  });
});

for (const runtime of ['codex', 'claude']) {
  for (const boundary of ['source', 'graph', 'PLAN', 'metadata', 'head']) test('behavior ' + runtime + ' fresh post-unit ' + boundary + ' drift refuses final', async () => {
    await publicIntegrationFixture(async f => {
      const prepared = publicPartitionFixture(f, runtime, { observed: true });
      let changed = false;
      prepared.controls.onLaunch = (_input, payload) => {
        if (payload.kind !== 'unit' || changed) return;
        changed = true;
        if (boundary === 'source') fs.appendFileSync(path.join(f.worktree, 'src/provider.cjs'), '\nexports.drift = true;\n');
        if (boundary === 'graph') fs.appendFileSync(path.join(f.graphDir, 'tickets.json'), '\n');
        if (boundary === 'PLAN') fs.appendFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), '\nChanged current PLAN.\n');
        if (boundary === 'metadata') f.memberHead = f.base;
        if (boundary === 'head') {
          write(f.worktree, 'src/provider.cjs', 'exports.drift = true;\n');
          commit(f, 'fixture head changed during actual unit');
        }
      };
      await assert.rejects(supportedPartitionCaller(f, runtime, prepared.options));
      assert.equal(changed, true);
      assert.equal(prepared.controls.launches.some(launch => launch.payload.kind === 'phase'), false);
    });
  });
}
