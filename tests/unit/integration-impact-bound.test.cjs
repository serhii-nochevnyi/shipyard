'use strict';
const { test: registerTest } = require('node:test');
const partition = process.env.SHIPYARD_IMPACT_TEST_PART;
if (partition === undefined) {
  registerTest('six isolated impact groups execute the complete disjoint case inventory', async () => {
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');
    const marker = 'IMPACT_PARTITION_INVENTORY ';
    const reports = await Promise.all([1, 2, 3, 4, 5, 6].map(part => new Promise(resolve => {
      const env = { ...process.env, SHIPYARD_IMPACT_TEST_PART: String(part) };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', __filename], { env });
      let stdout = '', stderr = '', error = null;
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', failure => { error = failure; });
      child.on('close', (status, signal) => {
        resolve({ part, status, signal, stdout, stderr, error });
      });
    })));
    for (const report of reports) {
      process.stdout.write(report.stdout);
      process.stderr.write(report.stderr);
      console.log('IMPACT_WORKER_STATUS ' + JSON.stringify({ part: report.part, status: report.status, signal: report.signal, error: report.error?.message || null }));
    }
    for (const report of reports) {
      assert.equal(report.error, null);
      assert.equal(report.signal, null);
      assert.equal(report.status, 0, 'group ' + report.part + ' must pass');
    }
    const expectedNames = [
      "codex authentic scan crosses generic bound with deduplicated unchanged paths",
      "claude authentic scan crosses generic bound with deduplicated unchanged paths",
      "authenticated integration refuses excessive aggregate",
      "authenticated integration refuses excessive individual",
      "authenticated integration refuses excessive serialization",
      "scalar identity schema refuses malformed exact input and preserves nested identity representation",
      "real Claude stages pin scalars and preserve strict reserved-template execution",
      "real Claude stages pin scalars and preserve observed execution",
      "compact domain retains all 16653 ordered pairs with exact independent legacy facts",
      "compact native groups require disjoint exhaustive original domain judgments",
      "codex explicit compact original fixture reaches independent final and current discovery",
      "claude explicit compact original fixture reaches independent final and current discovery",
      "codex complete37 realistic static and original semantic fixture fits without semantic credit",
      "claude complete37 realistic static and original semantic fixture fits without semantic credit",
      "codex compact actual distinct original semantic aggregate refuses before independent final dispatch",
      "claude compact actual distinct original semantic aggregate refuses before independent final dispatch",
      "compact original public sealing refuses unknown format",
      "compact original public sealing refuses wrong binding",
      "compact original public sealing refuses missing original domain",
      "compact original public sealing refuses overlapping original domain",
      "compact original public sealing refuses foreign original domain",
      "compact original public sealing refuses incomplete original",
      "compact original public sealing refuses actual original field overflow",
      "compact original public sealing refuses actual complete original answer overflow",
      "compact explicit edges keep same endpoints with distinct context and incident selectors",
      "codex compact public custody refuses missing native usage",
      "claude compact public custody refuses missing native usage",
      "compact locally complete unresolved original units retain uncertainty until independent final resolves",
      "compact independent unresolved final refuses current discovery"
    ];
    const inventories = reports.map(report => {
      const lines = report.stdout.split('\n').filter(line => line.includes(marker));
      assert.equal(lines.length, 1);
      const inventory = JSON.parse(lines[0].slice(lines[0].indexOf(marker) + marker.length));
      assert.equal(inventory.part, report.part);
      assert.equal(inventory.all.length, 29);
      assert.deepEqual(inventory.all, expectedNames);
      assert.equal(new Set(inventory.all).size, inventory.all.length);
      assert.ok(inventory.selected.length > 0);
      for (const field of ['tests', 'pass']) {
        const count = new RegExp('^# ' + field + ' (\\d+)$', 'm').exec(report.stdout);
        assert.ok(count, field + ' summary');
        assert.equal(Number(count[1]), inventory.selected.length);
      }
      assert.match(report.stdout, /^# fail 0$/m);
      assert.match(report.stdout, /^# skipped 0$/m);
      return inventory;
    });
    for (const inventory of inventories) assert.deepEqual(inventory.all, inventories[0].all);
    const selected = inventories.flatMap(inventory => inventory.selected);
    assert.deepEqual([...selected].sort(), [...inventories[0].all].sort());
    assert.equal(new Set(selected).size, selected.length);
  });
} else {
  if (!/^[1-6]$/.test(partition)) throw new Error('invalid impact test partition');
  const inventory = { part: Number(partition), all: [], selected: [] };
  function test(name, ...args) {
    inventory.all.push(name);
    const assignments = [2, 2, 1, 1, 1, 2, 5, 2, 2, 2, 2, 3, 6, 5, 2, 1, 4, 6, 5, 4, 1, 3, 5, 6, 2, 6, 5, 3, 4];
    if (assignments[inventory.all.length - 1] !== inventory.part) return;
    inventory.selected.push(name);
    return registerTest(name, ...args);
  }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const owner = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
const loaded = new Module(owner, module);
loaded.filename = owner;
loaded.paths = Module._nodeModulePaths(__dirname);
const originalLoad = Module._load;
try {
  Module._load = function(name, ...args) {
    return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
  };
  const helperTransform = `.replaceAll('const identity = payload.reviewed_identity, assignment = payload.assignment;',
    'const identity = payload.identity?.scalar_tree ? ((table) => { const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === \"object\" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : table.values[value]; return expand(table.scalar_tree); })(payload.identity) : payload.identity || payload.reviewed_identity, assignment = payload.assignment || { unit_id: payload.unit_id, primary_segments: [], support_segments: [], primary_obligation_ids: [], support_obligation_ids: [], seam_ids: [] };')
    .replaceAll('payload.seams.map(', '(payload.seams || []).map(')`;
  const helperSource = fs.readFileSync(owner, 'utf8').replace(
    "const source = fs.readFileSync(path.join(__dirname, file), 'utf8');",
    "const source = fs.readFileSync(path.join(__dirname, file), 'utf8')" + helperTransform + ';');
  loaded._compile(helperSource + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, currentPartitionConsumer, phaseBinding, projectOptions, write, git, commit, agent };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, currentPartitionConsumer, phaseBinding, projectOptions, write, git, commit, agent } = loaded.exports;
const root = '../../plugins/delivery-pipeline/scripts/';
const claude = require(root + 'claude-role-host.cjs');
const delivery = require(root + 'codex-delivery-host.cjs');
const collector = require(root + 'codex-arch-review-context.cjs');
const roleArtifact = require(root + 'role-artifact.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const artifactOwner = path.resolve(__dirname, root + 'role-artifact.cjs');
const measured = new Module(artifactOwner, module);
measured.filename = artifactOwner;
measured.paths = Module._nodeModulePaths(path.dirname(artifactOwner));
measured._compile(fs.readFileSync(artifactOwner, 'utf8') + '\nmodule.exports = { partitionSegments, partitionInputBytes, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactBinding, compactReviewedIdentity, compactAggregatePayload, buildPartitionUnits, observedPartitionProfile, compactProfile, partitionUnitPayload, renderPartitionInput, partitionHash, partitionCoverage, assertPartitionCoverage, partitionPlanRecord, assertPartitionInputBound, partitionResult };', artifactOwner);
const { partitionSegments, partitionInputBytes, compactInteractionDomain, compactPair, compactStaticTables, compactDomainJudgments, compactBinding, compactReviewedIdentity, compactAggregatePayload, buildPartitionUnits, observedPartitionProfile, compactProfile, partitionUnitPayload, renderPartitionInput, partitionHash, partitionCoverage, assertPartitionCoverage, partitionPlanRecord, assertPartitionInputBound, partitionResult } = measured.exports;
const MiB = 1024 * 1024;
function endpoints(f, sources, provider = 'exports.value = 2;\n') {
  for (const [name, content] of Object.entries(sources)) write(f.worktree, name, content);
  git(f.worktree, 'add', '.');
  git(f.worktree, 'commit', '-qm', 'unchanged scan endpoint');
  f.base = git(f.worktree, 'rev-parse', 'HEAD');
  f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  write(f.worktree, 'src/provider.cjs', provider);
  commit(f, 'tiny required change');
  f.memberHead = f.head;
}
function prepare(f, runtime) {
  const options = projectOptions(f);
  const context = claude.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v3' });
  let instructionBinding, generatedInstructionBytes;
  if (runtime === 'codex') {
    const installed = agent(f, 'integrator', context.signals);
    const instructions = collector.instructionEvidence(installed.dir, installed.selection.agent_file, installed.manifest);
    generatedInstructionBytes = instructions.generated_instruction_bytes;
    instructionBinding = { agent_file: installed.selection.agent_file,
      agent_path: path.join(installed.dir, installed.selection.agent_file), agent_sha256: instructions.sha256,
      installed_files: instructions.installed_files, policy_hash: installed.selection.policy_hash };
  } else {
    const referencePath = require(root + 'claude-reference-content.cjs').REFERENCE_PATHS.integrator;
    const reference = fs.readFileSync(referencePath);
    generatedInstructionBytes = reference.length;
    instructionBinding = { agent_file: path.basename(referencePath), agent_path: referencePath,
      agent_sha256: hash(reference), installed_files: [], policy_hash: require(root + 'model-policy.cjs').POLICY_HASH };
  }
  const scope = { worktree: f.worktree, phase: 49, ticket: context.ticket, run_id: 'impact-' + runtime + ++f.count };
  return delivery.prepareIntegrationLineage(scope, context, { ...options, nativeRuntime: runtime,
    dispatchId: scope.run_id, storageRoot: path.join(f.root, scope.run_id), generatedInstructionBytes, instructionBinding });
}
for (const runtime of ['codex', 'claude']) test(runtime + ' authentic scan crosses generic bound with deduplicated unchanged paths', async () => {
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
    assert.throws(() => prepare(f, 'claude'), error => error.code === 'CONTEXT_OVER_BOUND' && message.test(error.message));
  });
});
function stage(input, kind = 'unit') {
  return { input, input_sha256: hash(input), kind, subject: 'subject', plan_sha256: 'plan' };
}
function envelope(identity) {
  return 'instructions\n<AUTHENTICATED_INTEGRATION_PARTITION>\n' + JSON.stringify({ kind: 'phase', reviewed_identity: identity }) + '\n</AUTHENTICATED_INTEGRATION_PARTITION>';
}
test('scalar identity schema refuses malformed exact input and preserves nested identity representation', () => {
  const identity = { graph_digest: '6f2ec41a24831293dd9ea13ede315d48dcb5efa446703bf3ff5b101255049917', phase: 52, enabled: true, absent: null, nested: { present: true }, members: ['one'] };
  for (const kind of ['unit', 'phase', 'reserved-template']) {
    const schema = claude.integrationStageSchema(stage(envelope(identity), kind));
    const reviewed = schema.properties.reviewed_identity;
    for (const key of ['graph_digest', 'phase', 'enabled', 'absent']) {
      assert.deepEqual(reviewed.properties[key], { const: identity[key] });
      assert.ok(reviewed.required.includes(key));
    }
    assert.notEqual(reviewed.properties.graph_digest.const, '6f2ec41a24831293dede315d48dcb5efa446703bf3ff5b101255049917');
    assert.deepEqual(reviewed.properties.nested, { type: 'object' });
    assert.deepEqual(reviewed.properties.members, { type: 'array' });
    assert.equal(reviewed.additionalProperties, undefined);
    assert.equal(schema.properties.outcome.const, undefined);
  }
  for (const input of ['', 'quoted ' + JSON.stringify(envelope(identity)), envelope([]), envelope(null), envelope(undefined), envelope(identity) + '\n', envelope(identity).replace('{"kind"', '{bad"kind"')])
    assert.throws(() => claude.integrationStageSchema(stage(input)));
  assert.throws(() => claude.integrationStageSchema({ ...stage(envelope(identity)), input: envelope({ phase: 53 }) }));
  assert.throws(() => claude.integrationStageSchema({ kind: 'unit' }));
  assert.throws(() => claude.integrationStageSchema(stage(envelope(identity) + envelope(identity))));
  const quoted = JSON.stringify({ reviewed_identity: { graph_digest: 'lookalike' } }) + '\n' + envelope(identity);
  assert.equal(claude.integrationStageSchema(stage(quoted)).properties.reviewed_identity.properties.graph_digest.const, identity.graph_digest);
  assert.throws(() => delivery.prepareIntegrationLineage({}, {}, { nativeRuntime: 'claude' }), /private/);
});
for (const observed of [false, true]) test('real Claude stages pin scalars and preserve ' + (observed ? 'observed' : 'strict reserved-template') + ' execution', async () => {
  await publicIntegrationFixture(async f => {
    const fixture = publicPartitionFixture(f, 'claude', { observed });
    const create = fixture.options.createRuntimeHost;
    const captured = [], rendered = [];
    if (!observed) {
      const render = fixture.options.integrationCapacity.renderLaunch;
      fixture.options.integrationCapacity.renderLaunch = function(launch, selection) {
        rendered.push({ launch, schema: structuredClone(selection.schema) });
        return render.call(this, launch, selection);
      };
    }
    fixture.options.createRuntimeHost = options => {
      const host = create(options), agent = host.agent;
      return { ...host, async agent(input, selection) {
        captured.push({ input, schema: structuredClone(selection.schema) });
        return agent.call(host, input, selection);
      } };
    };
    const result = await supportedPartitionCaller(f, 'claude', fixture.options);
    assert.equal(result.result.outcome, 'passed');
    assert.ok(captured.length >= 2);
    if (!observed) {
      const reserved = rendered.find(item => item.launch.kind === 'reserved-template');
      assert.ok(reserved);
      assert.ok(reserved.launch.input.includes('"kind":"phase"'));
    }
    for (const { input, schema } of captured) {
      const payload = JSON.parse(input.split('\n<AUTHENTICATED_INTEGRATION_PARTITION>\n')[1].split('\n</AUTHENTICATED_INTEGRATION_PARTITION>')[0]);
      for (const [key, value] of Object.entries(payload.reviewed_identity)) {
        if (value !== null && typeof value === 'object') continue;
        assert.deepEqual(schema.properties.reviewed_identity.properties[key], { const: value });
        assert.ok(schema.properties.reviewed_identity.required.includes(key));
      }
      const actualStage = { ...payload, input, input_sha256: hash(input) };
      assert.equal(JSON.stringify(schema), JSON.stringify(claude.integrationStageSchema(actualStage)));
      const plan = { schema: 'shipyard.integration-partition-plan.v2', runtime: 'claude',
        subject: payload.subject, plan_sha256: payload.plan_sha256 };
      const expected = Buffer.byteLength(JSON.stringify({ type: 'user', message: { role: 'user', content: input } }) + '\n')
        + Buffer.byteLength(JSON.stringify(schema));
      assert.equal(partitionInputBytes(plan, input, payload.kind), expected);
      if (observed && payload.kind === 'phase') assert.equal(result.context.operational_diagnostic.actual_final_input_bytes, expected);
      assert.equal(partitionInputBytes({ ...plan, schema: 'shipyard.integration-partition-plan.v1' }, input, payload.kind), Buffer.byteLength(input));
      assert.equal(partitionInputBytes({ ...plan, runtime: 'codex' }, input, payload.kind), Buffer.byteLength(input));
    }
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
function compactGroupGenerationContract() {
  const matches = (schema, value) => {
    if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
      return Object.entries(schema.properties || {}).every(([key, item]) => !Object.hasOwn(value, key) || matches(item, value[key]));
    }
    if (schema.type === 'array') return Array.isArray(value)
      && (schema.minItems === undefined || value.length >= schema.minItems)
      && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && (!schema.items || value.every(item => matches(schema.items, item)));
    if (schema.type === 'integer') return Number.isInteger(value);
    return !schema.type || typeof value === schema.type;
  };
  for (const kind of ['unit', 'phase']) {
    const binding = { schema: 'shipyard.integration-partition-binding.v2', format: 'compact-domain.v1',
      plan_sha256: 'a'.repeat(64), scope: kind, unit_id: kind === 'unit' ? 'u000001' : null,
      identity_sha256: hash(JSON.stringify({ phase: 52 })), assignment_sha256: 'b'.repeat(64),
      unit_count: 4, source_count: 0, obligation_count: 0, primary_segment_count: 0, primary_obligation_count: 0,
      domain_sha256: 'c'.repeat(64), pair_count: 6, explicit_edge_sha256: 'd'.repeat(64), explicit_edge_count: 1,
      verified_index_sha256: kind === 'phase' ? 'e'.repeat(64) : null };
    const payload = { schema: 'shipyard.integration-partition-input.v2', format: binding.format,
      reconstruction: 'shipyard.integration-partition-render.v2', kind, runtime: 'claude', subject: 'subject',
      plan_sha256: binding.plan_sha256, unit_id: binding.unit_id, reviewed_identity: { phase: 52 },
      identity: { scalar_tree: { phase: 0 }, values: [52] }, binding,
      coverage: { schema: 'shipyard.integration-partition-coverage.v2', format: binding.format } };
    const input = 'instructions\n<AUTHENTICATED_INTEGRATION_PARTITION>\n' + JSON.stringify(payload)
      + '\n</AUTHENTICATED_INTEGRATION_PARTITION>';
    const launch = { ...stage(input, kind), plan_sha256: binding.plan_sha256 };
    const schema = claude.integrationStageSchema(launch);
    const groups = kind === 'unit' ? schema.properties.seams : schema.properties.coverage.properties.seam_dispositions;
    const original = { id: 'original-judgment', domain: 'pairs', domain_sha256: binding.domain_sha256,
      ranges: [[0, 6]], disposition: 'unresolved', rationale: 'Original native rationale retains its own content Ω.',
      findings: [{ id: 'N1', type: 'note', blocking: false, summary: 'Original finding', evidence: 'Original evidence' }],
      limitations: ['Original limitation'], required_context: ['Original required context'] };
    assert.equal(matches(groups, [original]), true);
    assert.equal(matches(groups, [{ ...original, exception: true, ranges: [[0, 1]] }, { ...original, id: 'rest', ranges: [[1, 6]] }]), true);
    assert.equal(matches(groups, [{ ...original, domain: 'edges', domain_sha256: binding.explicit_edge_sha256, ranges: [[0, 1]], disposition: 'resolved' }]), true);
    if (kind === 'unit') {
      const incident = { ...original, incident_unit: payload.unit_id };
      delete incident.ranges;
      assert.equal(matches(groups, [incident]), true);
      assert.equal(matches(groups, [{ ...incident, incident_unit: 'foreign' }]), false);
    } else assert.equal(matches(groups, [{ ...original, incident_unit: 'u000001' }]), false);
    for (const key of [' findings', 'findngs', 'unknown']) assert.equal(matches(groups, [{ ...original, [key]: [] }]), false);
    for (const field of ['id', 'domain', 'domain_sha256', 'disposition', 'rationale', 'findings', 'limitations', 'required_context']) {
      const missing = { ...original }; delete missing[field];
      assert.equal(matches(groups, [missing]), false, field);
    }
    for (const bad of [{ ...original, findings: {} }, { ...original, rationale: [] }, { ...original, exception: 'yes' },
      { ...original, ranges: [[0, '6']] }, { ...original, ranges: [[0, 1, 2]] }, { ...original, domain: 'pair' },
      { ...original, domain_sha256: 'f'.repeat(64) }]) assert.equal(matches(groups, [bad]), false);
    const expectedBytes = Buffer.byteLength(JSON.stringify({ type: 'user', message: { role: 'user', content: input } }) + '\n')
      + Buffer.byteLength(JSON.stringify(schema));
    assert.equal(partitionInputBytes({ schema: 'shipyard.integration-partition-plan.v3', runtime: 'claude',
      subject: payload.subject, plan_sha256: payload.plan_sha256 }, input, kind), expectedBytes);
    assert.throws(() => claude.integrationStageSchema({ ...launch, input_sha256: '0'.repeat(64) }));
  }
}

test('compact native groups require disjoint exhaustive original domain judgments', () => {
  compactGroupGenerationContract();
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

const stable = require(root + 'model-policy-internal.cjs').stableStringify;
function originalCompactFixtureAnswer(result, payload) {
  if (payload.schema !== 'shipyard.integration-partition-input.v2') return;
  const unit = payload.kind === 'unit';
  const groups = [];
  for (const domain of ['pairs', 'edges']) {
    const count = domain === 'pairs' ? payload.binding.pair_count : payload.binding.explicit_edge_count;
    const incident = domain === 'pairs' ? payload.interaction_domain.unit_ids.length > 1 : payload.explicit_edge_indices?.length;
    if (!count || unit && !incident) continue;
    groups.push({ id: domain + '-contract-evaluation', domain,
      domain_sha256: domain === 'pairs' ? payload.binding.domain_sha256 : payload.binding.explicit_edge_sha256,
      ...(unit ? { incident_unit: payload.unit_id } : { ranges: [[0, count]] }),
      disposition: 'resolved',
      rationale: 'Synthetic structural fixture: provider exports the accepted value, the consumer preserves that value without reordering, and the complete governing acceptance remains satisfied across every selected interaction. This narrative tests original response custody and grants no genuine semantic acceptance.',
      findings: [], limitations: [], required_context: [] });
  }
  Object.assign(result, { format: payload.format, binding: payload.binding, reviewed_identity: payload.reviewed_identity,
    conclusions: ['Synthetic fixture inspected the complete readable assigned context and every original contract obligation. Provider value propagation and consumer ordering agree across all selected interactions; no context was omitted from this structural test answer.'],
    limitations: [], required_context: [],
    evidence_markdown: 'Synthetic structural evidence only. The assigned provider and consumer contracts preserve value and ordering; complete source continuation and explicit completion obligations are included in the supplied readable context. No genuine model acceptance is asserted.' });
  if (unit) Object.assign(result, { schema: 'shipyard.integration-unit-result.v2', unit_id: payload.unit_id,
    coverage: payload.binding, seams: groups });
  else Object.assign(result, { coverage: { ...payload.coverage, limitations: [], seam_dispositions: groups } });
}
function addCompactPressure(f, members = 2, stress = false, semanticPressure = false) {
  git(f.worktree, 'config', 'gc.auto', '0');
  const first = f.rows['T-49-01'];
  for (let i = 3; i <= members; i++) {
    const id = 'T-49-' + String(i).padStart(2, '0');
    f.rows[id] = { ...first, title: 'Complete integration contract ' + i, branch: 'ticket/' + id,
      plan: '.planning/phases/' + f.phase + '/49-' + String(i).padStart(2, '0') + '-PLAN.md' };
    f.state[id] = { status: 'merged', pr: 100 + i, branch: f.rows[id].branch };
  }
  for (const [id, row] of Object.entries(f.rows)) {
    const clauses = Array.from({ length: stress ? 13 : 1100 }, (_, i) =>
      '- ' + id + ' contract ' + i + (stress
        ? ': provider value must retain tenant identity, transaction ordering, cancellation ownership and exact consumer acceptance; missing source context requires an incomplete judgment.'
        : ': preserve tenant value, ordered delivery and cancellation owner; missing context is incomplete.')).join('\n');
    const design = Array.from({ length: stress ? 125 : 12 }, (_, i) =>
      id + ' governing obligation ' + i + ': continuation keeps every UTF8 source range readable; retry completion remains idempotent, cancellation propagates to the owner, and required consumer context must be retained before integration acceptance.').join('\n');
    write(f.worktree, row.plan, '---\nphase: 49\nplan: ' + id.slice(-2) + '\n---\nADR-014' + (stress ? '\nADR-015' : '') + '\n## Acceptance criteria\n' + clauses + '\n## Verification commands\n- node --check src/provider.cjs\n## Governing context\n' + design + '\n');
  }
  const count = stress ? 384 : semanticPressure ? 180 : 0, lines = stress ? 240 : 120;
  for (let i = 0; i < count; i++) {
    const body = Array.from({ length: lines }, (_, line) =>
      'exports.contract_' + i + '_' + line + ' = function(input) { if (!input || input.tenant !== "tenant-' + i + '") throw new Error("tenant identity required"); return { value: input.value, sequence: ' + line + ', owner: "contract-' + i + ' Ω" }; };').join('\n') + '\n';
    write(f.worktree, 'src/contract-' + i + '.cjs', body);
  }
  if (stress) {
    const code = fs.readFileSync(path.join(f.worktree, 'src/contract-0.cjs'), 'utf8');
    write(f.worktree, 'src/contract-alias.cjs', code);
    write(f.worktree, 'src/contract-long.cjs', 'exports.longContext = "' + 'Required Ω tenant identity preserves cancellation and retry ownership. '.repeat(1400) + '";\n');
    for (const [part, adr] of ['ADR-014', 'ADR-015'].entries())
      write(f.worktree, '.planning/architecture/' + adr + '-original.md', '# ' + adr + '\n' + Array.from({ length: 750 }, (_, i) =>
        'Governing contract ' + (part * 750 + i) + ': preserve complete source identity, tenant ownership, retry idempotency, consumer value ordering, and cancellation propagation; unresolved context requires incomplete integration.').join('\n'));
  }
  if (!stress) assert.ok(Object.values(f.rows).reduce((count, row) => count +
    (fs.readFileSync(path.join(f.worktree, row.plan), 'utf8').match(/^- T-49-\d+ contract /gm) || []).length, 0) >= 2000);
  const requiredContextPaths = [...Object.values(f.rows).map(row => row.plan),
    '.planning/architecture/ADR-014-original.md', ...(stress ? ['.planning/architecture/ADR-015-original.md'] : [])];
  for (const sourcePath of requiredContextPaths) {
    const bytes = fs.readFileSync(path.join(f.worktree, sourcePath)).length;
    assert.ok(bytes > 0 && bytes < 192 * 1024, sourcePath + ' must fit the real required-context file bound: ' + bytes);
  }
  write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
  write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
  const dependencies = count ? Array.from({ length: count }, (_, i) => "require('./contract-" + i + ".cjs');\n").join('') + (stress ? "require('./contract-alias.cjs');\nrequire('./contract-long.cjs');\n" : '') : '';
  write(f.worktree, 'src/provider.cjs', dependencies + 'exports.value = 1;\n');
  commit(f, 'complete compact structural fixture base');
  f.base = f.head; f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  if (stress) for (let i = 0; i < 48; i++) {
    const file = 'src/contract-' + i + '.cjs';
    write(f.worktree, file, fs.readFileSync(path.join(f.worktree, file), 'utf8').replaceAll('input.value', 'input.value ?? 0'));
  }
  write(f.worktree, 'src/provider.cjs', dependencies + 'exports.value = 2;\n');
  commit(f, 'complete compact structural fixture endpoints');
  f.memberHead = f.head;
  const inventoryPath = path.join(f.root, 'compact-roster.json');
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  roleArtifact.registerPhaseArchiveRoster({ worktreePath: f.worktree, binding: phaseBinding(f), graphDir: f.graphDir,
    inventoryPath, expectedInventoryDigest: hash(fs.readFileSync(inventoryPath)) });
}
function captureCompactSchemas(runtime, fixture) {
  const captured = new Map();
  if (runtime === 'claude') {
    const create = fixture.options.createRuntimeHost;
    fixture.options.createRuntimeHost = options => {
      const host = create(options), agent = host.agent;
      return { ...host, async agent(input, selection) {
        captured.set(hash(input), structuredClone(selection.schema));
        return agent.call(host, input, selection);
      } };
    };
  }
  return captured;
}

for (const runtime of ['codex', 'claude']) test(runtime + ' explicit compact original fixture reaches independent final and current discovery', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    const originals = new Map();
    const localLimitations = [
      'This session had only Read/Grep/Glob tools; no shell. Checks were Grep/Read over the HEAD worktree (patterns listed in evidence), not executed tests, so runtime behavior of host-single-hint.test.cjs and the sealer/containment path was verified only by interface/contract reading, not by a test run; GitHub CI on the exact head remains the execution evidence.',
      'Whether these three files themselves changed between base 1c34583b and head cd74c1c6 was not verified by git diff (no shell); they were judged as current affected-endpoint consumers against current exporters.',
    ];
    const seamLimitation = "Interface-level verification only; semantic behavior of other units' exporter changes is outside this unit's material.";
    const controls = { observed: true, result(result, payload) {
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
    const capturedSchemas = captureCompactSchemas(runtime, fixture);
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
    assert.ok(currentPartitionConsumer(f));
    const originalRef = final.payload.unit_results.find(unit => unit.unit_id === 'u000002').reference;
    const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, originalRef.artifact_ref)));
    const resultPath = path.join(f.worktree, manifest.files.findings.path), originalBytes = fs.readFileSync(resultPath);
    try {
      const altered = JSON.parse(originalBytes);
      altered.limitations[0] += ' Altered original caveat.';
      fs.writeFileSync(resultPath, JSON.stringify(altered));
      assert.equal(currentPartitionConsumer(f), null);
    } finally { fs.writeFileSync(resultPath, originalBytes); }
    assert.ok(currentPartitionConsumer(f));
    for (const { input, payload } of launches) {
      assert.match(input, /Informational caveats on unresolved local groups may remain/);
      assert.match(input, /Explicitly evaluate and discharge each original local\ncaveat in substantive final conclusions or domain rationale/);
      assert.match(input, /Unresolved final groups or remaining final limitations cannot authorize a\nphase pass/);
      assert.equal(hash(stable(expandCompactIdentity(payload.identity))), payload.binding.identity_sha256);
      assert.ok(Buffer.byteLength(input) <= (payload.kind === 'unit' ? 2097152 : 4194304));
      if (runtime === 'claude') {
        const schema = claude.integrationStageSchema({ ...payload, input, input_sha256: hash(input) });
        assert.deepEqual(capturedSchemas.get(hash(input)), schema);
        for (const [key, value] of Object.entries(payload.binding)) assert.deepEqual(schema.properties.binding.properties[key], { const: value });
      }
    }
  });
});

function expandCompactIdentity(table) {
  const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : table.values[value];
  return expand(table.scalar_tree);
}
function independentTables(plan, tables, units, contentRequired) {
  const decodedSymbols = tables.symbols.map(([prefix, suffix]) => tables.symbol_prefixes[prefix] + suffix);
  assert.deepEqual(tables.segment_columns, ['segment_id_ref', 'source_id_ref', 'start_byte', 'end_byte', 'start_line', 'end_line', 'sha256_ref', 'content_index']);
  assert.deepEqual(tables.alias_columns, ['path_ref', 'pointer_ref', 'kind_ref', 'revision_ref', 'presence']);
  tables = { ...tables, sources: tables.sources.map(row => row.map((value, index) => index === 6 ? value.map(alias => Object.fromEntries(['path', 'pointer', 'kind', 'revision'].flatMap((key, i) => alias[4][i] === '0' ? [] : [[key, alias[i] === null ? null : decodedSymbols[alias[i]]]]))) : value)), segment_columns: tables.segment_columns.map(key => key.endsWith('_ref') ? key.slice(0, -4) : key),
    segments: tables.segments.map(row => row.map((value, index) => [0, 1, 6].includes(index) ? decodedSymbols[value] : value)) };
  const segmentId = segment => 'b-' + hash(stable(segment));
  const segmentMap = new Map(tables.segments.map(row => [row[0], Object.fromEntries(tables.segment_columns.slice(1, -1).map((key, i) => [key, row[i + 1]]))]));
  const sourceIds = new Set(units.flatMap(unit => [...unit.primary_segments, ...unit.support_segments]).map(segment => segment.source_id));
  const expandRows = (columns, rows) => rows.map(row => Object.fromEntries(columns.slice(0, -1)
    .flatMap((key, i) => row.at(-1)[i] === '1' ? [[key.endsWith('_ref') ? key.slice(0, -4) : key, key === 'value_ref' ? (Object.hasOwn(tables.values[row[i]], 'literal') ? tables.values[row[i]].literal : tables.values[row[i]].content_ranges.map(([index, left, right]) => tables.contents[index].slice(left, right)).join('')) : key.endsWith('_ref') && row[i] !== null ? decodedSymbols[row[i]] : row[i]]] : [])));
  assert.deepEqual(expandRows(tables.source_columns, tables.sources), plan.material.filter(source => sourceIds.has(source.source_id)).map(({ content, ...source }) => source));
  const ids = new Set(units.flatMap(unit => [...unit.primary_obligation_ids, ...unit.support_obligation_ids]));
  assert.deepEqual(expandRows(tables.obligation_columns, tables.obligations), plan.obligations.filter(item => ids.has(item.id)));
  assert.equal(new Set(tables.contents).size, tables.contents.length);
  const expandedValues = tables.values.map(value => {
    if (Object.hasOwn(value, 'literal')) return value.literal;
    assert.deepEqual(Object.keys(value), ['content_ranges']);
    assert.ok(value.content_ranges.length > 0);
    return value.content_ranges.map(([index, left, right]) => {
      assert.ok(Number.isSafeInteger(index) && index >= 0 && index < tables.contents.length);
      assert.ok(Number.isSafeInteger(left) && Number.isSafeInteger(right) && left >= 0 && right > left && right <= tables.contents[index].length);
      return tables.contents[index].slice(left, right);
    }).join('');
  });
  assert.equal(new Set(expandedValues.map(stable)).size, expandedValues.length);
  const selected = new Map();
  for (const unit of units) for (const item of [...unit.primary_segments, ...unit.support_segments]) selected.set(segmentId(item), item);
  assert.deepEqual([...segmentMap], [...selected].sort(([a], [b]) => a.localeCompare(b)));
  for (const row of tables.segments) {
    const source = plan.material.find(item => item.source_id === row[1]);
    const original = Buffer.from(source.content).subarray(row[2], row[3]);
    assert.equal(hash(original), row[6]);
    if (contentRequired(row[1])) assert.equal(tables.contents[row[7]], original.toString('utf8'));
    else assert.equal(row[7], null);
  }
  assert.equal(new Set(decodedSymbols).size, tables.symbols.length);
  const expandSet = index => tables.sets[index].map(reference => {
    assert.ok(Number.isSafeInteger(reference) && reference >= 0 && reference < tables.symbols.length);
    return decodedSymbols[reference];
  });
  assert.deepEqual(tables.assignments.map(row => ({ unit_id: row[0], primary_segments: expandSet(row[1]).map(id => segmentMap.get(id)),
    support_segments: expandSet(row[2]).map(id => segmentMap.get(id)), primary_obligation_ids: expandSet(row[3]),
    support_obligation_ids: expandSet(row[4]), governing_ids: expandSet(row[5]), seam_ids: expandSet(row[6]) })), units);
}
function independentEdges(table, expected) {
  assert.deepEqual(table.columns, ['id', 'from', 'to', 'obligation_ids_ref', 'rationale_ref', 'required_context_ref', 'uncertain']);
  const resolve = index => {
    assert.ok(Number.isSafeInteger(index) && index >= 0 && index < table.values.length);
    return table.values[index];
  };
  const expanded = table.rows.map(row => ({ id: row[0], from: row[1], to: row[2],
    obligation_ids: resolve(row[3]), rationale: resolve(row[4]), required_context: resolve(row[5]), uncertain: row[6] }));
  assert.deepEqual(expanded, expected);
  assert.equal(table.count, expected.length);
  assert.equal(table.sha256, hash(stable(expected)));
  assert.equal(new Set(table.values.map(stable)).size, table.values.length);
}
function independentDomain(plan) {
  const explicit = new Map(), pairRecords = [];
  const edge = (from, to, obligation_ids, rationale) => {
    if (from === to) return;
    const id = 'e-' + hash([from, to, ...obligation_ids].join(':'));
    explicit.set(id, { id, from, to, obligation_ids, rationale, required_context: obligation_ids, uncertain: true });
  };
  for (const source of plan.material) {
    const owners = plan.units.filter(unit => unit.primary_segments.some(segment => segment.source_id === source.source_id)).map(unit => unit.unit_id);
    const obligations = plan.obligations.filter(item => item.source_id === source.source_id).map(item => item.id);
    owners.slice(1).forEach((owner, i) => edge(owners[i], owner, obligations, 'Exact original source continuation and logical completion'));
    for (const obligation of obligations) {
      const completion = plan.units.find(unit => unit.primary_obligation_ids.includes(obligation)).unit_id;
      for (const owner of owners) edge(owner, completion, [obligation], 'All original source segments required for logical completion');
    }
  }
  assert.deepEqual(plan.seams, [...explicit.values()].sort((a, b) => a.id.localeCompare(b.id)));
  for (let i = 0; i < plan.units.length; i++) for (let j = i + 1; j < plan.units.length; j++) {
    const from = plan.units[i].unit_id, to = plan.units[j].unit_id;
    pairRecords.push({ id: 'e-' + hash(from + ':' + to), from, to, obligation_ids: [],
      rationale: 'Cross-unit dependency or acceptance interaction is not statically disproven', required_context: [], uncertain: true });
  }
  assert.deepEqual(pairRecords.map((_, rank) => compactPair(plan, rank)), pairRecords);
  assert.equal(plan.interaction_domain.sha256, hash(stable(pairRecords)));
  assert.equal(plan.interaction_domain.count, pairRecords.length);
  assert.deepEqual(plan.interaction_domain.unit_ids, plan.units.map(unit => unit.unit_id));
  const primary = plan.units.flatMap(unit => unit.primary_segments);
  for (const source of plan.material) {
    const ranges = primary.filter(item => item.source_id === source.source_id).sort((a, b) => a.start_byte - b.start_byte);
    let offset = 0;
    for (const range of ranges) { assert.equal(range.start_byte, offset); offset = range.end_byte; }
    assert.equal(offset, source.bytes);
    assert.equal(Buffer.byteLength(source.content), source.bytes);
    assert.equal(hash(source.content), source.sha256);
  }
  assert.deepEqual(plan.units.flatMap(unit => unit.primary_obligation_ids).sort(), plan.obligations.map(item => item.id).sort());
}
for (const runtime of ['codex', 'claude']) test(runtime + ' complete37 realistic static and original semantic fixture fits without semantic credit', async t => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f, 37, true);
    const review = prepare(f, runtime);
    const prepared = roleArtifact.prepareIntegrationPartitions({ review });
    const plan = prepared.plan, record = partitionPlanRecord(f.worktree, plan.plan_sha256);
    const originals = new Map(), launches = [];
    const units = plan.units.map(unit => {
      const payload = partitionUnitPayload(plan, unit), input = renderPartitionInput(plan, payload);
      assertPartitionInputBound(plan, input, 'unit');
      launches.push({ input, payload });
      const result = { schema: 'shipyard.integration-unit-result.v2', review_contract: 'shipyard.integration-review.v3',
        kind: 'unit', runtime, subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: hash(input),
        completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [] };
      originalCompactFixtureAnswer(result, payload);
      result.findings = [{ id: 'NOTE-' + unit.unit_id, type: 'note', blocking: false,
        summary: 'Synthetic ' + unit.unit_id + ' retains explicit continuation and cancellation ownership.',
        evidence: 'The original source range and completion obligations remain readable and bound in this fixture input.' }];
      for (const field of Object.keys(plan.capacity.output_limits))
        assert.ok(Buffer.byteLength(stable(result[field])) <= plan.capacity.output_limits[field]);
      assert.ok(Buffer.byteLength(stable(result)) <= 131072);
      compactDomainJudgments(plan, result.seams, unit);
      originals.set(unit.unit_id, structuredClone(result));
      return { result, reference: { unit_id: unit.unit_id,
        artifact_ref: 'synthetic-structural-only/' + unit.unit_id + '/.shipyard-role-artifact.json',
        artifact_sha256: hash(stable(result)) } };
    });
    const verified = { units, index: { entries: units.map(({ result }) => ({ unit_id: result.unit_id,
      receipt_sha256: hash('synthetic-structural-only:' + result.unit_id) })) } };
    const payload = compactAggregatePayload(record, verified), input = renderPartitionInput(plan, payload);
    assertPartitionInputBound(plan, input, 'phase');
    const final = { payload, input };
    launches.push(final);
    const answer = { review_contract: 'shipyard.integration-review.v3', kind: 'phase', runtime, subject: plan.subject,
      plan_sha256: plan.plan_sha256, input_sha256: hash(input), completeness: 'complete', outcome: 'passed',
      blocking_count: 0, findings: [], ticket_set: plan.identity.ticket_set, ticket_set_digest: plan.identity.ticket_set_digest };
    originalCompactFixtureAnswer(answer, payload);
    const pairGroup = answer.coverage.seam_dispositions.find(group => group.domain === 'pairs');
    pairGroup.ranges = [[0, plan.interaction_domain.count - 1]];
    answer.coverage.seam_dispositions.push({ ...pairGroup, id: 'final-explicit-pair-exception', exception: true,
      ranges: [[plan.interaction_domain.count - 1, plan.interaction_domain.count]],
      rationale: 'Synthetic final exception: the last ordered unit pair retains its distinct source continuation and tenant cancellation context; both original unit conclusions include the complete completion obligation, preserving consumer value and retry ordering.' });
    for (const field of ['conclusions', 'findings', 'limitations', 'required_context'])
      assert.ok(Buffer.byteLength(stable(answer[field])) <= plan.capacity.output_limits[field]);
    originals.set('phase', answer);
    assert.ok(Buffer.byteLength(stable(answer)) <= 131072);
    compactDomainJudgments(plan, answer.coverage.seam_dispositions);
    assert.equal(review.coverage.semantic_credit, false);
    assert.equal(currentPartitionConsumer(f), null);
    assert.equal(plan.schema, 'shipyard.integration-partition-plan.v3');
    assert.equal(plan.identity.ticket_set.length, 37);
    assert.ok(plan.units.length >= 183);
    assert.ok(plan.interaction_domain.count >= 16653);
    assert.deepEqual(final.payload.unit_results.map(item => item.unit_id), plan.units.map(item => item.unit_id));
    assert.ok(plan.material.length >= 384);
    assert.equal(new Set(plan.material.map(source => source.sha256)).size, plan.material.length);
    assert.ok(plan.material.reduce((sum, source) => sum + source.bytes, 0) >= 17721197);
    assert.ok(plan.material.reduce((sum, source) => sum + source.bytes, 0) < 32 * MiB);
    assert.ok(plan.material.some(source => /diff/.test(source.kind) && source.bytes >= 4 * MiB));
    assert.ok(record.operational_diagnostic.governing_source_bytes >= 1400000);
    assert.ok(record.operational_diagnostic.obligation_metadata_bytes >= 314302);
    independentDomain(plan);
    const governing = new Set(plan.obligations.filter(item => plan.governing.includes(item.id)).map(item => item.source_id));
    independentTables(plan, final.payload.tables, plan.units, id => governing.has(id));
    for (const { input, payload } of launches) {
      const expandIdentity = value => Array.isArray(value) ? value.map(expandIdentity) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandIdentity(item)])) : payload.identity.values[value];
      assert.deepEqual(expandIdentity(payload.identity.scalar_tree), plan.identity);
      independentEdges(payload.explicit_edges, payload.kind === 'unit' ? plan.seams.filter(edge => edge.from === payload.unit_id || edge.to === payload.unit_id) : plan.seams);
      const measuredBytes = partitionInputBytes(plan, input, payload.kind);
      if (runtime === 'claude') {
        const schema = claude.integrationStageSchema({ ...payload, input, input_sha256: hash(input) });
        assert.equal(measuredBytes, Buffer.byteLength(JSON.stringify({ type: 'user', message: { role: 'user', content: input } }) + '\n') + Buffer.byteLength(JSON.stringify(schema)));
      } else assert.equal(measuredBytes, Buffer.byteLength(input));
      assert.ok(measuredBytes <= (payload.kind === 'unit' ? 2097152 : 4194304));
      if (payload.kind === 'unit') {
        const unit = plan.units.find(item => item.unit_id === payload.unit_id);
        independentTables(plan, payload.tables, [unit], () => true);
        assert.equal(payload.binding.assignment_sha256, hash(stable(unit)));
        assert.equal(record.operational_diagnostic.units.find(item => item.unit_id === unit.unit_id).complete_input_bytes, measuredBytes);
      }
    }
    for (const unit of final.payload.unit_results) {
      const original = originals.get(unit.unit_id);
      assert.equal(unit.result_sha256, hash(stable(original)));
      for (const [field, index] of Object.entries(unit.fields)) assert.deepEqual(final.payload.semantic_values[index], original[field]);
      assert.match(unit.receipt_sha256, /^[a-f0-9]{64}$/);
      assert.ok(unit.reference.artifact_ref.endsWith('/.shipyard-role-artifact.json'));
    }
    assert.equal(new Set(final.payload.semantic_values.map(stable)).size, final.payload.semantic_values.length);
    const diagnostic = { actual_final_input_bytes: partitionInputBytes(plan, final.input, 'phase') };
    t.diagnostic(JSON.stringify({ runtime, structural_only: true, semantic_credit: false,
      source_count: plan.material.length, source_bytes: plan.material.reduce((sum, source) => sum + source.bytes, 0),
      unit_count: plan.units.length, pair_count: plan.interaction_domain.count,
      governing_source_bytes: record.operational_diagnostic.governing_source_bytes,
      obligation_metadata_bytes: record.operational_diagnostic.obligation_metadata_bytes,
      maximum_unit_payload_components: Object.fromEntries(Object.keys(launches[0].payload).map(key => [key,
        Math.max(...launches.filter(item => item.payload.kind === 'unit').map(item => Buffer.byteLength(stable(item.payload[key]))))])),
      maximum_unit_table_components: Object.fromEntries(Object.keys(launches[0].payload.tables).map(key => [key,
        Math.max(...launches.filter(item => item.payload.kind === 'unit').map(item => Buffer.byteLength(stable(item.payload.tables[key]))))])),
      exact_original_obligation_values_bytes: Buffer.byteLength(stable(plan.obligations.filter(item => Object.hasOwn(item, 'value')).map(item => item.value))),
      final_interned_obligation_values_bytes: Buffer.byteLength(stable(payload.tables.values)),
      units: record.operational_diagnostic.units, actual_final_input_bytes: diagnostic.actual_final_input_bytes,
      actual_original_final_result_bytes: Buffer.byteLength(stable(originals.get('phase'))) }));
  });
});

function substantiveFixtureNarrative(unit, budget) {
  let text = '', i = 0;
  while (true) {
    const next = 'Synthetic ' + unit + ' obligation ' + i++ + ': this original fixture conclusion retains tenant identity, cancellation ownership, retry completion ordering and consumer value propagation for its selected source range. ';
    if (Buffer.byteLength(text + next) > budget) return text;
    text += next;
  }
}
for (const runtime of ['codex', 'claude']) test(runtime + ' compact actual distinct original semantic aggregate refuses before independent final dispatch', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f, 2, false, true);
    const review = prepare(f, runtime), prepared = roleArtifact.prepareIntegrationPartitions({ review });
    const plan = prepared.plan, record = partitionPlanRecord(f.worktree, plan.plan_sha256);
    assert.equal(plan.format, 'compact-domain.v1');
    const originals = [];
    const units = plan.units.map(unit => {
      const payload = partitionUnitPayload(plan, unit);
      assert.equal(payload.kind, 'unit');
      assert.equal(payload.format, 'compact-domain.v1');
      assertPartitionInputBound(plan, renderPartitionInput(plan, payload), 'unit');
      const unitInput = renderPartitionInput(plan, payload);
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
    const payload = compactAggregatePayload(record, verified), input = renderPartitionInput(plan, payload);
    assert.equal(payload.format, 'compact-domain.v1');
    assert.ok(new Set(units.map(({ result }) => stable(result.conclusions))).size === units.length);
    assert.ok(partitionInputBytes(plan, input, 'phase') > 4194304);
    assert.throws(() => assertPartitionInputBound(plan, input, 'phase'),
      error => error.code === 'INTEGRATION_INPUT_OVER_BOUND' && /actual complete phase.*HOLD/.test(error.message));
    assert.equal(currentPartitionConsumer(f), null);
    assert.equal(roleArtifact.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/findings.json')).length, 0);
    for (const [i, { result }] of units.entries()) {
      assert.equal(stable(result), originals[i]);
      assert.ok(result.conclusions[0].includes(result.unit_id));
      assert.ok(result.conclusions[0].length > 15000);
      const row = payload.unit_results[i];
      assert.equal(row.result_sha256, hash(originals[i]));
      for (const [field, index] of Object.entries(row.fields)) assert.deepEqual(payload.semantic_values[index], result[field]);
    }
  });
});
for (const [name, mutate] of [
  ['unknown format', result => { result.format = 'compact-domain.v2'; }],
  ['wrong binding', result => { result.binding = { ...result.binding, source_count: result.binding.source_count + 1 }; }],
  ['missing original domain', result => { result.seams = []; }],
  ['overlapping original domain', result => { result.seams.push({ ...result.seams[0], id: 'overlap' }); }],
  ['foreign original domain', result => { result.seams[0].domain_sha256 = 'b'.repeat(64); }],
  ['incomplete original', (result, payload, f) => {
    const record = partitionPlanRecord(f.worktree, payload.plan_sha256);
    const launch = { unit_id: payload.unit_id, input_sha256: result.input_sha256 };
    const blocker = { id: 'B1', type: 'violation', blocking: true, summary: 'Consumer contract is broken.', evidence: 'Original consumer source.' };
    assert.equal(partitionResult(result, record, launch), result);
    for (const mutate of [
      invalid => { invalid.required_context = ['Missing complete consumer context.']; },
      invalid => { invalid.findings = [blocker]; invalid.blocking_count = 1; },
      invalid => { invalid.seams[0].disposition = 'unresolved'; invalid.seams[0].required_context = ['Missing exporter context.']; },
      invalid => { invalid.seams[0].disposition = 'unresolved'; invalid.seams[0].findings = [blocker]; },
      invalid => { invalid.seams[0].limitations = ['Claimed resolution still lacks consumer behavior evidence.']; },
    ]) {
      const invalid = structuredClone(result); mutate(invalid);
      assert.throws(() => partitionResult(invalid, record, launch), error => error.code === 'INTEGRATION_PARTITION_INVALID'
        && /blocking context|context-blocked compact original domain/.test(error.message));
    }
    result.completeness = 'incomplete'; result.required_context = ['Missing complete consumer context.']; result.outcome = 'human-review-required';
  }],
  ['actual original field overflow', result => { result.conclusions = [substantiveFixtureNarrative(result.unit_id, 18000)]; }],
  ['actual complete original answer overflow', result => { result.evidence_markdown = substantiveFixtureNarrative(result.unit_id, 132000); }],
]) test('compact original public sealing refuses ' + name, async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    let compactReached = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1');
      compactReached = true;
      originalCompactFixtureAnswer(result, payload); mutate(result, payload, f);
      controls.mutationCompleted = true;
    } };
    const fixture = publicPartitionFixture(f, 'claude', controls);
    await assert.rejects(supportedPartitionCaller(f, 'claude', fixture.options));
    assert.equal(compactReached, true);
    assert.equal(controls.mutationCompleted, true);
    assert.ok(controls.launches.length > 0 && controls.launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
    assert.equal(currentPartitionConsumer(f), null);
  });
});

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

for (const runtime of ['codex', 'claude']) test(runtime + ' compact public custody refuses missing native usage', async () => {
  await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    let compactReached = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1'); compactReached = true; originalCompactFixtureAnswer(result, payload);
    },
      ...(runtime === 'codex' ? { native(rows) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].payload?.type === 'token_count') rows.splice(i, 1);
      } } : { observation(rows, stream) {
        for (const row of [...rows, ...stream]) if (row.type === 'assistant') delete row.message.usage;
      } }) };
    const fixture = publicPartitionFixture(f, runtime, controls);
    await assert.rejects(supportedPartitionCaller(f, runtime, fixture.options));
    assert.equal(compactReached, true);
    assert.ok(controls.launches.length > 0 && controls.launches.every(({ payload }) => payload.format === 'compact-domain.v1'));
    assert.equal(currentPartitionConsumer(f), null);
  });
});

for (const unresolvedFinal of [false, true]) test(unresolvedFinal
  ? 'compact independent unresolved final refuses current discovery'
  : 'compact locally complete unresolved original units retain uncertainty until independent final resolves', async () => {
  for (const runtime of [unresolvedFinal ? 'claude' : 'codex']) await publicIntegrationFixture(async f => {
    addCompactPressure(f);
    const originals = new Map();
    let independentFinal = false;
    const controls = { observed: true, result(result, payload) {
      assert.equal(payload.format, 'compact-domain.v1');
      originalCompactFixtureAnswer(result, payload);
      if (payload.kind === 'unit') {
        for (const group of result.seams) {
          group.disposition = 'unresolved';
          group.rationale = 'Synthetic local review establishes complete assigned provider values and cancellation ownership. Joint consumer ordering across this exact incident domain awaits the independent final with every original unit conclusion; this uncertainty does not indicate missing local primary context.';
        }
        assert.equal(result.completeness, 'complete');
        assert.equal(result.blocking_count, 0);
        assert.deepEqual(result.required_context, []);
        originals.set(payload.unit_id, structuredClone(result));
      } else {
        independentFinal = true;
        assert.equal(payload.unit_results.length, originals.size);
        for (const unit of payload.unit_results) {
          const original = originals.get(unit.unit_id);
          assert.ok(original);
          assert.equal(unit.result_sha256, hash(stable(original)));
          for (const [field, index] of Object.entries(unit.fields)) assert.deepEqual(payload.semantic_values[index], original[field]);
          assert.ok(payload.semantic_values[unit.fields.seams].every(group => group.disposition === 'unresolved'));
        }
        result.conclusions = ['Synthetic independent joint review compared every original provider and consumer conclusion with the complete governing contract. Their value ordering and cancellation ownership agree across the exhaustive pair and explicit-edge domains; the original local cross-unit uncertainty is resolved by this fresh joint conclusion.'];
        if (unresolvedFinal) {
          result.coverage.seam_dispositions[0].disposition = 'unresolved';
          result.coverage.seam_dispositions[0].rationale = 'Synthetic independent joint review cannot establish consumer ordering across this entire selected domain from the original unit conclusions; this final uncertainty must refuse a phase pass.';
        } else {
          result.limitations = ['Synthetic independent final still lacks execution evidence for the joint consumer ordering conclusion.'];
        }
      }
    } };
    const fixture = publicPartitionFixture(f, runtime, controls);
    await assert.rejects(supportedPartitionCaller(f, runtime, fixture.options),
      error => error.code === 'INTEGRATION_PARTITION_INVALID' && /unsupported compact final cannot pass/.test(error.message));
    assert.equal(currentPartitionConsumer(f), null);
    assert.equal(independentFinal, true);
    assert.ok(originals.size > 1);
  });
});

console.log('IMPACT_PARTITION_INVENTORY ' + JSON.stringify(inventory));
}
