'use strict';
const { test } = require('node:test');
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
  loaded._compile(fs.readFileSync(owner, 'utf8') + '\nmodule.exports = { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, projectOptions, write, git, commit, agent };', owner);
} finally { Module._load = originalLoad; }
const { publicIntegrationFixture, publicPartitionFixture, supportedPartitionCaller, projectOptions, write, git, commit, agent } = loaded.exports;
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
measured._compile(fs.readFileSync(artifactOwner, 'utf8') + '\nmodule.exports = { partitionInputBytes };', artifactOwner);
const { partitionInputBytes } = measured.exports;
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
  const context = claude.prepareNativeIntegratorContext(options, { worktree: f.worktree, phase: '49' });
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
