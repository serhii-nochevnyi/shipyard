'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, git, roleArtifact, hash, stable, originalCompactFixtureAnswer, addCompactPressure, expandCompactIdentity } = require('./helpers/integration-impact-fixtures.cjs');


for (const runtime of ['codex']) test(runtime + ' explicit compact original fixture reaches independent final and current discovery', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    const originals = new Map();
    const localLimitations = [
      'This session had only Read/Grep/Glob tools; no shell. Checks were Grep/Read over the HEAD worktree (patterns listed in evidence), not executed tests, so runtime behavior of host-single-hint.test.cjs and the sealer/containment path was verified only by interface/contract reading, not by a test run; GitHub CI on the exact head remains the execution evidence.',
      'Whether these three files themselves changed between base 1c34583b and head cd74c1c6 was not verified by git diff (no shell); they were judged as current affected-endpoint consumers against current exporters.',
    ];
    const seamLimitation = "Interface-level verification only; semantic behavior of other units' exporter changes is outside this unit's material.";
    const launched = [];
    const controls = { observed: true, onLaunch(_input, payload) {
      launched.push(payload);
      if (payload.kind !== 'unit') return;
      const directory = roleArtifact.archiveAuthorityDirectory(f.worktree);
      const envelopes = fs.readdirSync(directory).filter(file => file.startsWith('integration-launch-'))
        .map(file => JSON.parse(fs.readFileSync(path.join(directory, file))).payload).filter(launch => launch.kind === 'unit');
      assert.deepEqual(envelopes.map(launch => launch.unit_id).sort(),
        launched.filter(launch => launch.kind === 'unit').map(launch => launch.unit_id).sort());
    }, result(result, payload) {
      originalCompactFixtureAnswer(result, payload);
      if (payload.kind === 'unit') {
        if (payload.unit_id === 'u000002') {
          result.limitations = [...localLimitations];
          for (const group of result.seams) {
            group.disposition = 'unresolved';
            group.rationale = 'Synthetic local consumer review establishes interface compatibility only. Other units own the exporter semantics, so the independent final must jointly resolve this incident domain using every original conclusion; no local primary context is missing.';
            group.limitations = [seamLimitation];
          }
        }
        originals.set(payload.unit_id, structuredClone(result));
      } else {
        assert.equal(payload.unit_results.length, originals.size);
        for (const unit of payload.unit_results) {
          const original = originals.get(unit.unit_id);
          assert.ok(original);
          assert.equal(unit.result_sha256, hash(stable(original)));
          for (const [field, index] of Object.entries(unit.fields)) assert.deepEqual(payload.semantic_values[index], original[field]);
        }
        const local = payload.unit_results.find(unit => unit.unit_id === 'u000002');
        assert.ok(local);
        assert.equal(local.completeness, 'complete');
        assert.equal(local.outcome, 'passed');
        assert.equal(local.blocking_count, 0);
        assert.deepEqual(payload.semantic_values[local.fields.required_context], []);
        assert.deepEqual(payload.semantic_values[local.fields.limitations], localLimitations);
        assert.ok(payload.semantic_values[local.fields.seams].every(group => group.disposition === 'unresolved'
          && stable(group.limitations) === stable([seamLimitation])));
        assert.equal(require(path.join(f.worktree, 'src/consumer.cjs')), 2);
        const diff = git(f.worktree, 'diff', '--no-ext-diff', f.base, f.head, '--', 'src/provider.cjs', 'src/consumer.cjs');
        assert.match(diff, /^-exports.value = 1;/m);
        assert.match(diff, /^\+exports.value = 2;/m);
        result.conclusions = [
          'Synthetic independent final evaluates the original execution caveat: ' + localLimitations[0] + ' For this structural fixture, direct execution of src/consumer.cjs returns 2 from the current provider, supplying runtime evidence beyond the local interface read. This asserts no real host-single-hint, containment, CI or native semantic acceptance.',
          'Synthetic independent final evaluates the original diff caveat: ' + localLimitations[1] + ' The fixture base/head diff changes exports.value from 1 to 2; the unchanged consumer directly forwards that value. The fresh diff and execution establish compatibility across this fixture change.',
          'Synthetic independent final evaluates the incident-domain caveat: ' + seamLimitation + ' Joint review of every original exporter and consumer conclusion with the governing contract, fixture diff and consumer execution establishes value propagation across the exhaustive pair and explicit-edge domains. The local scope boundary no longer limits this structural judgment; no real phase authority is asserted.',
        ];
        for (const group of result.coverage.seam_dispositions) group.rationale += ' ' + result.conclusions[2];
      }
    } };
    const fixture = publicPartitionFixture(f, runtime, controls);
    const result = await supportedPartitionCaller(f, runtime, fixture.options);
    const launches = controls.launches;
    assert.ok(launches.length > 2);
    assert.ok(launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
    const final = launches.find(({ payload }) => payload.kind === 'phase');
    assert.ok(final);
    assert.equal(final.payload.binding.verified_index_sha256, final.payload.verified_index_sha256);
    assert.equal(result.result.outcome, 'passed');
    assert.deepEqual(result.result.limitations, []);
    assert.deepEqual(result.result.required_context, []);
    assert.deepEqual(result.result.coverage.limitations, []);
    assert.ok(result.result.coverage.seam_dispositions.every(group => group.disposition === 'resolved' && !group.limitations.length));
    for (const { input, payload } of launches) {
      assert.match(input, /Informational caveats on unresolved local groups may remain/);
      assert.match(input, /Explicitly evaluate and discharge each original local\ncaveat in substantive final conclusions or domain rationale/);
      assert.match(input, /Unresolved final groups or remaining final limitations cannot authorize a\nphase pass/);
      assert.equal(hash(stable(expandCompactIdentity(payload.identity))), payload.binding.identity_sha256);
      assert.ok(Buffer.byteLength(input) <= (payload.kind === 'unit' ? 2097152 : 4194304));
    }
  });
});
