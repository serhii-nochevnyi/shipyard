'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publicIntegrationFixture, assertCompactOriginalRefused, git, agent, delivery, collector, roleArtifact, hash, stable, MiB, partitionSegments, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactAggregatePayload, compactProfile, partitionUnitPayload, renderPartitionInput, partitionPlanRecord, assertPartitionInputBound, partitionResult, endpoints, prepare, originalCompactFixtureAnswer, addCompactPressure, expandCompactIdentity, independentTables, independentEdges, substantiveFixtureNarrative } = require('./helpers/integration-impact-fixtures.cjs');

const root = '../../plugins/delivery-pipeline/scripts/';
for (const runtime of ['codex']) test(runtime + ' authentic scan crosses generic bound with deduplicated unchanged paths', async () => {
  await publicIntegrationFixture(async f => {
    const sources = { 'scan/a.cjs': ' '.repeat(9 * MiB), 'scan/b.cjs': '\n' + ' '.repeat(9 * MiB), 'scan/alias.cjs': ' '.repeat(9 * MiB), 'scan/alias-2.cjs': ' '.repeat(9 * MiB) };
    endpoints(f, sources);
    assert.ok(Object.values(sources).reduce((sum, content) => sum + Buffer.byteLength(content), 0) > 32 * MiB);
    const review = prepare(f, runtime);
    const objects = new Map();
    for (const inventory of Object.values(review.coverage.source_inventories)) {
      for (const name of Object.keys(sources)) assert.ok(inventory.some(item => item.path === name));
      for (const entry of inventory) if (entry.mode === '100644' && /\.cjs$/.test(entry.path))
        objects.set(entry.object, Number(git(f.worktree, 'cat-file', '-s', entry.object)));
    }
    const total = [...objects.values()].reduce((a, b) => a + b, 0);
    assert.ok(total > 16 * MiB && total < 32 * MiB);
    assert.ok(Buffer.byteLength(JSON.stringify(review.coverage)) < MiB);
    assert.ok(collector.verifyFileInput(review.input).manifest.accounting.material_bytes < 16 * MiB);
    assert.equal(review.coverage.semantic_credit, false);
    const partitions = roleArtifact.prepareIntegrationPartitions({ review });
    assert.equal(partitions.plan.runtime, runtime);
    assert.ok(Object.isFrozen(partitions.plan));
    const reopened = roleArtifact.prepareIntegrationPartitions({ review, plan_sha256: partitions.plan.plan_sha256 });
    assert.deepEqual(reopened.plan, partitions.plan);
    assert.ok(Object.isFrozen(reopened.plan));
    assert.equal(review.coverage.semantic_credit, false);
  });
});
for (const [name, sources, provider, message] of [
  ['aggregate', { 'scan/a.cjs': ' '.repeat(12 * MiB), 'scan/b.cjs': '\n' + ' '.repeat(12 * MiB), 'scan/c.cjs': '\t' + ' '.repeat(12 * MiB) }, undefined, /complete impact sources exceed their bound/],
  ['individual', { 'scan/a.cjs': ' '.repeat(16 * MiB + 1) }, undefined, /complete impact sources exceed their bound/],
  ['serialization', { 'assets/escaped.json': '\\'.repeat(16 * MiB - 1) }, "require('../assets/escaped.json');\n", /complete impact packet exceeds its bound/],
]) test('authenticated integration refuses excessive ' + name, async () => {
  await publicIntegrationFixture(async f => {
    const sizes = Object.values(sources).map(content => Buffer.byteLength(content));
    if (name === 'aggregate') {
      assert.ok(sizes.every(size => size < 16 * MiB));
      assert.ok(sizes.reduce((sum, size) => sum + size, 0) > 32 * MiB);
    } else if (name === 'individual') assert.ok(sizes[0] > 16 * MiB);
    else {
      assert.ok(sizes[0] < 16 * MiB);
      assert.ok(Buffer.byteLength(JSON.stringify(Object.values(sources)[0])) > 32 * MiB - 2);
    }
    endpoints(f, sources, provider);
    assert.throws(() => prepare(f, 'codex'), error => error.code === 'CONTEXT_OVER_BOUND' && message.test(error.message));
  });
});
function compactStructuralPlan(count = 183) {
  const units = Array.from({ length: count }, (_, i) => ({ unit_id: 'u' + String(i + 1).padStart(6, '0'),
    primary_segments: [], support_segments: [], primary_obligation_ids: [], support_obligation_ids: [], governing_ids: [], seam_ids: [] }));
  const plan = { schema: 'shipyard.integration-partition-plan.v3', version: 3, format: 'compact-domain.v1',
    plan_sha256: 'a'.repeat(64), runtime: 'codex', identity: { head: 'head', phase: 52, ticket_set: ['T-52-39'] },
    units, material: [], obligations: [], governing: [], seams: [], capacity: compactProfile() };
  plan.interaction_domain = compactInteractionDomain(plan);
  return plan;
}
test('compact domain retains all 16653 ordered pairs with exact independent legacy facts', () => {
  const plan = compactStructuralPlan();
  const expected = [];
  for (let i = 0; i < plan.units.length; i++) for (let j = i + 1; j < plan.units.length; j++) {
    const from = plan.units[i].unit_id, to = plan.units[j].unit_id;
    expected.push({ id: 'e-' + hash(from + ':' + to), from, to, obligation_ids: [],
      rationale: 'Cross-unit dependency or acceptance interaction is not statically disproven', required_context: [], uncertain: true });
  }
  assert.equal(expected.length, 16653);
  assert.deepEqual(expected.map((_, rank) => compactPair(plan, rank)), expected);
  const stable = require(root + 'model-policy-internal.cjs').stableStringify;
  assert.equal(plan.interaction_domain.sha256, hash(stable(expected)));
  assert.throws(() => compactPair(plan, expected.length));
  assert.throws(() => compactPair(plan, -1));
  const content = 'Original Ω governing value keeps whitespace and cancellation ownership.\n'.repeat(1200);
  const source = { source_id: 's-' + hash(content), path: 'governing.md', kind: 'required-context',
    bytes: Buffer.byteLength(content), sha256: hash(content), aliases: [], content };
  const obligation = { id: 'o-original-value', source_id: source.source_id, value: content, mandatory: true };
  const rangedPlan = { ...plan, material: [source], obligations: [obligation] };
  const ranges = partitionSegments(source, rangedPlan.capacity.segment_bytes);
  const unit = { unit_id: 'u000001', primary_segments: ranges, support_segments: [],
    primary_obligation_ids: [obligation.id], support_obligation_ids: [], governing_ids: [], seam_ids: [] };
  const cold = compactStaticTables(rangedPlan, [unit]);
  assert.deepEqual(compactStaticTables(rangedPlan, [unit]), cold);
  independentTables(rangedPlan, cold, [unit], () => true);
  assert.ok(cold.values.some(value => value.content_ranges?.length > 1));
  const partial = { ...unit, primary_segments: ranges.slice(0, 1) };
  const partialTables = compactStaticTables(rangedPlan, [partial]);
  independentTables(rangedPlan, partialTables, [partial], () => true);
  assert.deepEqual(partialTables.values, [{ literal: content }]);
  const reverseObjects = value => Array.isArray(value) ? value.map(reverseObjects)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseObjects(value[key])])) : value;
  const identity = { ...plan.identity, nested: { z: 'last', a: { y: false, b: null },
    array: ['repeat', 7, 'repeat', { z: 'last', a: true }, [null, false, 7]] },
    scalars: Object.fromEntries(Array.from({ length: 24 }, (_, i) => ['key' + i, 'value' + i])) };
  const renderingPlan = { ...rangedPlan, runtime: 'claude', subject: 'phase',
    reconstruction: 'shipyard.integration-partition-render.v2', identity, units: [unit], instruction_pins: [] };
  renderingPlan.interaction_domain = compactInteractionDomain(renderingPlan);
  const original = { unit_id: unit.unit_id, completeness: 'complete', outcome: 'passed', blocking_count: 0,
    conclusions: ['Original complete source conclusion', 'Original complete source conclusion'], findings: [],
    limitations: [], seams: [], required_context: [], evidence_markdown: 'Original exact source evidence' };
  const verified = { units: [{ result: original, reference: { unit_id: unit.unit_id, artifact_sha256: hash(stable(original)) } }],
    index: { entries: [{ unit_id: unit.unit_id, receipt_sha256: hash('original receipt') }] } };
  const exactPayloads = candidate => [partitionUnitPayload(candidate, candidate.units[0]), compactAggregatePayload({ plan: candidate }, verified)];
  const baseline = exactPayloads(renderingPlan);
  const baselineInputs = baseline.map(payload => renderPartitionInput(renderingPlan, payload));
  for (const candidate of [renderingPlan, { ...renderingPlan, identity: reverseObjects(identity) },
    JSON.parse(stable(renderingPlan)), JSON.parse(stable({ ...renderingPlan, identity: reverseObjects(identity) }))]) {
    for (let pass = 0; pass < 2; pass++) {
      const payloads = exactPayloads(candidate);
      assert.deepEqual(payloads, baseline);
      payloads.forEach((payload, index) => {
        assert.deepEqual(expandCompactIdentity(payload.identity), identity);
        assert.equal(renderPartitionInput(candidate, payload), baselineInputs[index]);
        assert.equal(hash(renderPartitionInput(candidate, payload)), hash(baselineInputs[index]));
        independentTables(candidate, payload.tables, candidate.units, () => payload.kind === 'unit');
      });
      for (const [field, index] of Object.entries(payloads[1].unit_results[0].fields))
        assert.deepEqual(payloads[1].semantic_values[index], original[field]);
    }
  }
  source.content = content.replace('Original', 'Changed!');
  source.bytes = Buffer.byteLength(source.content);
  source.sha256 = hash(source.content);
  source.source_id = 's-' + source.sha256;
  obligation.source_id = source.source_id;
  obligation.value = source.content;
  unit.primary_segments = partitionSegments(source, rangedPlan.capacity.segment_bytes);
  const changed = compactStaticTables(rangedPlan, [unit]);
  independentTables(rangedPlan, changed, [unit], () => true);
  assert.notDeepEqual(changed.contents, cold.contents);
});

test('compact native groups require disjoint exhaustive original domain judgments', () => {
  const plan = compactStructuralPlan(4);
  const group = (id, start, end) => ({ id, domain: 'pairs', domain_sha256: plan.interaction_domain.sha256,
    ranges: [[start, end]], disposition: 'resolved', rationale: 'Provider and consumer contracts retain the same value and ordering across these interactions.',
    findings: [], limitations: [], required_context: [] });
  compactDomainJudgments(plan, [group('normal', 0, 5), group('exception', 5, 6)]);
  for (const groups of [[group('gap', 0, 5)], [group('a', 0, 6), group('b', 5, 6)],
    [group('foreign', 0, 7)], [group('same', 0, 3), group('same', 3, 6)],
    [{ ...group('wrong', 0, 6), domain_sha256: 'b'.repeat(64) }]])
    assert.throws(() => compactDomainJudgments(plan, groups));
});

const sealingMutations = {
  'unknown format': result => { result.format = 'compact-domain.v2'; },
  'wrong binding': result => { result.binding = { ...result.binding, source_count: result.binding.source_count + 1 }; },
  'missing original domain': result => { result.seams = []; },
  'overlapping original domain': result => { result.seams.push({ ...result.seams[0], id: 'overlap' }); },
  'foreign original domain': result => { result.seams[0].domain_sha256 = 'b'.repeat(64); },
  'actual original field overflow': result => { result.conclusions = [substantiveFixtureNarrative(result.unit_id, 18000)]; },
};
const sealingRefusals = {
  'unknown format': /exact coverage differs/, 'wrong binding': /exact coverage differs/,
  'missing original domain': /domain judgment gap/, 'overlapping original domain': /overlapping or foreign domain judgment/,
  'foreign original domain': /original substantive domain judgment or domain identity is missing/,
  'actual original field overflow': /complete unit detail exceeds frozen final-template ceiling/,
};
test('compact original sealing refuses invalid originals at the sealing boundary', async t => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    const { plan } = roleArtifact.prepareIntegrationPartitions({ review: prepare(f, 'codex') });
    const record = partitionPlanRecord(f.worktree, plan.plan_sha256);
    const unit = plan.units[0], payload = partitionUnitPayload(plan, unit), input = renderPartitionInput(plan, payload);
    const launch = { unit_id: unit.unit_id, input_sha256: hash(input) };
    const answer = () => {
      const result = { schema: 'shipyard.integration-unit-result.v2', review_contract: 'shipyard.integration-review.v3', kind: 'unit',
        runtime: 'codex', subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: launch.input_sha256,
        completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [] };
      originalCompactFixtureAnswer(result, payload);
      return result;
    };
    const accepted = answer();
    assert.equal(partitionResult(accepted, record, launch), accepted);
    for (const [name, mutate] of Object.entries(sealingMutations)) await t.test('refuses ' + name, () => {
      const invalid = answer(); mutate(invalid);
      assert.throws(() => partitionResult(invalid, record, launch), error => sealingRefusals[name].test(error.message)
        && error.code === (name === 'actual original field overflow' ? 'INTEGRATION_INPUT_OVER_BOUND' : 'INTEGRATION_PARTITION_INVALID'));
    });
    await t.test('refuses incomplete original variants', () => {
      const blocker = { id: 'B1', type: 'violation', blocking: true, summary: 'Consumer contract is broken.', evidence: 'Original consumer source.' };
      for (const mutate of [
        invalid => { invalid.required_context = ['Missing complete consumer context.']; },
        invalid => { invalid.findings = [blocker]; invalid.blocking_count = 1; },
        invalid => { invalid.seams[0].disposition = 'unresolved'; invalid.seams[0].required_context = ['Missing exporter context.']; },
        invalid => { invalid.seams[0].disposition = 'unresolved'; invalid.seams[0].findings = [blocker]; },
        invalid => { invalid.seams[0].limitations = ['Claimed resolution still lacks consumer behavior evidence.']; },
      ]) {
        const invalid = answer(); mutate(invalid);
        assert.throws(() => partitionResult(invalid, record, launch), error => error.code === 'INTEGRATION_PARTITION_INVALID'
          && /blocking context|context-blocked compact original domain/.test(error.message));
      }
    });
  });
});
test('compact original public sealing refuses wrong binding', () =>
  assertCompactOriginalRefused('codex', sealingMutations['wrong binding'],
    error => error.code === 'INTEGRATION_PARTITION_INVALID' && /exact coverage differs/.test(error.message)));
test('compact explicit edges keep same endpoints with distinct context and incident selectors', () => {
  const plan = compactStructuralPlan(4);
  plan.seams = ['provider-context', 'consumer-context'].map(context => ({ id: 'e-' + hash(context),
    from: plan.units[0].unit_id, to: plan.units[1].unit_id, rationale: 'Exact ' + context,
    obligation_ids: [context], required_context: [context], uncertain: true }));
  plan.units[0].seam_ids = plan.seams.map(edge => edge.id);
  independentEdges(partitionUnitPayload(plan, plan.units[0]).explicit_edges, plan.seams);
  const group = domain => ({ id: domain, domain, domain_sha256: domain === 'pairs' ? plan.interaction_domain.sha256 : hash(stable(plan.seams)),
    incident_unit: plan.units[0].unit_id, disposition: 'resolved',
    rationale: 'Synthetic incident-domain judgment retains both distinct provider and consumer context obligations without combining their identities.',
    findings: [], limitations: [], required_context: [] });
  const groups = [group('pairs'), group('edges')];
  compactDomainJudgments(plan, groups, plan.units[0]);
  assert.throws(() => compactDomainJudgments(plan, [groups[0]], plan.units[0]));
  assert.throws(() => compactDomainJudgments(plan, groups.map(item => ({ ...item, incident_unit: plan.units[2].unit_id })), plan.units[0]));
  assert.throws(() => compactDomainJudgments(plan, groups));
});

for (const runtime of ['codex']) test(runtime + ' compact actual distinct original semantic aggregate refuses before independent final dispatch', () => {
  const plan = compactStructuralPlan(128), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-agent-')));
  try {
    Object.assign(plan, { runtime, subject: 'phase', plan_sha256: 'a'.repeat(64),
      reconstruction: 'shipyard.integration-partition-render.v2', instruction_pins: [] });
    if (runtime === 'codex') {
      const text = "developer_instructions = '''\nRead complete original material.\n'''\n";
      fs.writeFileSync(path.join(directory, 'agent.toml'), text);
      plan.identity.agent_sha256 = hash(text);
      plan.instruction_pins = [{ root: directory, path: 'agent.toml', bytes: Buffer.byteLength(text), sha256: hash(text) }];
    }
    const originals = [];
    const units = plan.units.map(unit => {
      const payload = partitionUnitPayload(plan, unit);
      assert.equal(payload.kind, 'unit');
      assert.equal(payload.format, 'compact-domain.v1');
      const unitInput = renderPartitionInput(plan, payload);
      assertPartitionInputBound(plan, unitInput, 'unit');
      const result = { schema: 'shipyard.integration-unit-result.v2', review_contract: 'shipyard.integration-review.v3',
        kind: 'unit', runtime, subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: hash(unitInput),
        completeness: 'complete', outcome: 'passed', blocking_count: 0 };
      originalCompactFixtureAnswer(result, payload);
      result.conclusions = [substantiveFixtureNarrative(payload.unit_id, 16000)];
      result.findings = [{ id: 'NOTE-' + payload.unit_id, type: 'note', blocking: false,
        summary: substantiveFixtureNarrative(payload.unit_id + '-finding', 32000), evidence: 'Complete original selected fixture context.' }];
      const used = Buffer.byteLength(stable(result.seams));
      if (result.seams.length) result.seams[0].rationale += substantiveFixtureNarrative(payload.unit_id + '-seam', 32600 - used);
      for (const field of Object.keys(plan.capacity.output_limits))
        assert.ok(Buffer.byteLength(stable(result[field])) <= plan.capacity.output_limits[field]);
      compactDomainJudgments(plan, result.seams, unit);
      assert.ok(Buffer.byteLength(stable(result)) <= 131072);
      originals.push(stable(result));
      return { result, reference: { unit_id: unit.unit_id, artifact_ref: 'synthetic-structural-only/' + unit.unit_id,
        artifact_sha256: hash(stable(result)) } };
    });
    const verified = { units, index: { entries: units.map(({ result }) => ({ unit_id: result.unit_id,
      receipt_sha256: hash('synthetic-structural-only:' + result.unit_id) })) } };
    const payload = compactAggregatePayload({ plan }, verified), input = renderPartitionInput(plan, payload);
    assert.equal(payload.format, 'compact-domain.v1');
    assert.ok(new Set(units.map(({ result }) => stable(result.conclusions))).size === units.length);
    assert.ok(Buffer.byteLength(input) > 4194304);
    assert.throws(() => assertPartitionInputBound(plan, input, 'phase'),
      error => error.code === 'INTEGRATION_INPUT_OVER_BOUND' && /actual complete phase.*HOLD/.test(error.message));
    for (const [i, { result }] of units.entries()) {
      assert.equal(stable(result), originals[i]);
      assert.ok(result.conclusions[0].includes(result.unit_id));
      assert.ok(result.conclusions[0].length > 15000);
      const row = payload.unit_results[i];
      assert.equal(row.result_sha256, hash(originals[i]));
      for (const [field, index] of Object.entries(row.fields)) assert.deepEqual(payload.semantic_values[index], result[field]);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
