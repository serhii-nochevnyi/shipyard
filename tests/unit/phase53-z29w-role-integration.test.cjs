'use strict';

const { createRoleArtifactFixture, createRoleArtifactLifecycle } = require('./helpers/phase53-role-artifact-fixture.cjs');

function registerRoleArtifacts(test, context) {
  const {
    require, module, unitDir: __dirname, assert, suite, fs, path, os, execFileSync, spawnSync,
    testAuthorityArgs, targetBin, createDispatchBoundary, createDurableRecorder, ROLE_ARTIFACT, roleArtifact,
    git, fixture,
  } = context;

suite('original protected planning containment');

test('compact authentic integration proves native authority and scoped codec/rebuild policy separately from large capacity', async () => {
  const Module = require('node:module');
  const file = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return load.call(this, name, ...args);
  };
  try {
    loaded._compile(fs.readFileSync(file, 'utf8')
      + '\nmodule.exports = { fixture, runIntegration, prepareCurrentIntegration, successfulReview };\n', file);
  } finally { Module._load = load; }
  const helper = loaded.exports;
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const decode = packets.decodeUniqueContent;
  const observed = [];
  const observedPackets = { ...packets, decodeUniqueContent: function(value, maximumBytes) {
    const stack = new Error().stack;
    const result = decode.apply(this, arguments);
    if (stack.includes('/role-artifact.cjs:')) observed.push({ maximumBytes, caller: stack.split('\n')[2] });
    return result;
  } };
  Module._load = function(name, ...args) {
    const result = load.call(this, name, ...args);
    return result === packets ? observedPackets : result;
  };
  try {
    await helper.fixture(async f => {
      const completed = await helper.runIntegration(f);
      const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
      const checked = collector.verifyFileInput(completed.input);
      assert.ok(checked.material[0].length < 16 * 1024 * 1024);
      const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));
      const source = collector.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });
      const original = packets.decodeUniqueContent(JSON.parse(source.material[0]));
      assert.deepEqual(packet.required_refs, original.required_refs);
      assert.equal(packet.role_context.review_coverage.digest, completed.coverage.digest);
      const sealed = completed.result.artifact;
      const validation = { worktreePath: f.worktree, role: 'integrator', phase: f.phase,
        ticket: completed.scope.ticket, base: 'origin/main', recorder: completed.recorder,
        ticketSet: completed.input.manifest.binding.preflight.ticket_set,
        ticketSetDigest: completed.input.manifest.binding.preflight.ticket_set_digest,
        dispatchId: completed.request.dispatch_id, artifactPath: sealed.artifact_path,
        artifactDigest: sealed.artifact_digest };
      const validated = roleArtifact.validateJudgmentManifest(validation);
      const read = roleArtifact.read(validation);
      assert.equal(validated.manifest.current_review.lineage_digest, completed.coverage.digest);
      assert.deepEqual(read.manifest.current_review, validated.manifest.current_review);
      assert.equal(read.findings.coverage.lineage_digest, completed.coverage.digest);
      assert.equal(validated.manifest.current_review.original_manifest_sha256,
        checked.manifest.binding.original_input_bundle.manifest_sha256);
      assert.equal(validated.manifest.current_review.current_manifest_sha256, completed.input.input_bundle.manifest_sha256);
      assert.ok(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
        baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName })?.authenticated);
      assert.throws(() => collector.verifyFileInput(JSON.parse(JSON.stringify(completed.input))), /private producer/);
      assert.throws(() => roleArtifact.validateJudgmentManifest({ ...validation,
        artifactDigest: '0'.repeat(64) }), /digest|SHA/i);
      fs.unlinkSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md'));
      const unsupported = helper.prepareCurrentIntegration(f);
      assert.equal(unsupported.coverage.mode, 'full');
      const baseline = await helper.successfulReview(f, 'integrator');
      const fresh = helper.prepareCurrentIntegration(f);
      assert.equal(fresh.coverage.mode, 'incremental', JSON.stringify(fresh.coverage.limitations));
      assert.equal(fresh.coverage.baseline.dispatch_id, baseline.dispatched.dispatch_id);
      assert.equal(fresh.coverage.baseline.packet_digest, baseline.input.manifest.binding.packet_digest);
      assert.equal(fresh.coverage.baseline.head, f.head);
    });
  } finally { Module._load = load; }
  for (const consumer of ['authenticateCurrentCoverage', 'rebuildReviewImpactPacket', 'selectReviewBaseline']) {
    const calls = observed.filter(call => call.caller.includes('at ' + consumer + ' '));
    assert.ok(calls.length > 0, consumer + ' must execute its original bounded decoder');
    assert.ok(calls.some(call => call.maximumBytes === 33554432), consumer + ' must select the approved bound');
  }
  assert.ok(observed.some(call => call.maximumBytes === 16777216), 'legacy authority keeps its default bound');
});

function partitionFixtureHelpers() {
  const Module = require('node:module');
  const filename = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename; fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return load.call(this, name, ...args);
  };
  try {
    fixtureModule._compile(fs.readFileSync(filename, 'utf8')
      + '\nmodule.exports = { fixture, projectOptions, agent, commit, write, successfulReview, template, parent, child, cli, serialize };\n', filename);
  } finally { Module._load = load; }
  return fixtureModule.exports;
}

function partitionTestCapacity(changes = {}) {
  return { max_input_bytes: 8 * 1024 * 1024, unit_input_bytes: 256 * 1024, segment_bytes: 16 * 1024,
    output_reserve_tokens: 32000, tool_reserve_tokens: 10000,
    output_limits: { conclusions: 1024, findings: 2048, limitations: 1024, required_context: 1024, seams: 16384 },
    recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'native-exact' }, ...changes };
}

function partitionTestReview(f, helper, runtimeName = 'codex') {
  const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const complete = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
    .prepareNativeIntegratorContext(helper.projectOptions(f), { worktree: f.worktree, phase: '49' });
  const a = helper.agent(f, 'integrator', complete.signals);
  const instructions = collector.instructionEvidence(a.dir, a.selection.agent_file, a.manifest);
  const scope = { worktree: f.worktree, repository: complete.canonical.commonPath, phase: 49,
    ticket: complete.ticket, run_id: 'partition-original-' + ++f.count };
  const review = delivery.prepareIntegrationLineage(scope, complete, { ...helper.projectOptions(f), nativeRuntime: runtimeName,
    dispatchId: scope.run_id, storageRoot: path.join(f.root, 'partition-inputs'),
    generatedInstructionBytes: instructions.generated_instruction_bytes,
    instructionBinding: { agent_file: a.selection.agent_file, agent_path: path.join(a.dir, a.selection.agent_file),
      agent_sha256: instructions.sha256, installed_files: instructions.installed_files,
      policy_hash: a.selection.policy_hash } });
  return { review, a, scope };
}

async function partitionNativeFixture(f, helper, original, stage, result, dispatchId, mutateNative) {
  partitionAssertFixture(original, stage);
  if (stage.runtime === 'claude') return partitionClaudeNativeFixture(f, original, stage, result, dispatchId);
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const { a } = original;
  const prefix = runtime.generatedInstructions(a.text) + '\n\n';
  assert.ok(stage.input.startsWith(prefix), 'frozen input includes the actual static native instruction prefix');
  const scope = { ...original.scope, run_id: dispatchId };
  const session = crypto.randomUUID(), text = JSON.stringify(result);
  const pick = predicate => helper.template(helper.parent, predicate);
  const meta = pick(row => row.type === 'session_meta');
  Object.assign(meta.payload, { id: session, session_id: session, cwd: scope.worktree, runtime_workspace_roots: [scope.worktree] });
  const context = pick(row => row.type === 'turn_context');
  Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort, cwd: scope.worktree, workspace_roots: [scope.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
  const start = pick(row => row.payload?.type === 'task_started'), turn = start.payload.turn_id;
  context.payload.turn_id = turn;
  const developer = pick(row => row.type === 'response_item' && row.payload?.role === 'developer');
  developer.payload.content = [{ type: 'input_text', text: runtime.generatedInstructions(a.text) }];
  const user = pick(row => row.type === 'response_item' && row.payload?.role === 'user');
  user.payload.content = [{ type: 'input_text', text: stage.input }];
  const count = pick(row => row.payload?.type === 'token_count');
  const final = pick(row => row.type === 'response_item' && row.payload?.phase === 'final_answer');
  final.payload.content.forEach(block => { block.text = text; });
  final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  const completion = pick(row => row.payload?.type === 'task_complete');
  Object.assign(completion.payload, { turn_id: turn, last_agent_message: text });
  const native = [meta, context, start, developer, user, count, final, completion];
  mutateNative?.(native);
  const now = new Date(), directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const nativeFile = path.join(directory, session + '.jsonl');
  fs.writeFileSync(nativeFile, helper.serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
    .map(type => helper.template(helper.cli, row => row.type === type));
  records[0].thread_id = session; records[2].item.text = text;
  f.partitionRecorder ||= createDurableRecorder(path.join(f.root, 'partition-receipts'));
  const recorder = f.partitionRecorder;
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'partition-transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
      let nativeInput = '';
      child.stdin = { write(value) { nativeInput += value; }, end() {
        assert.equal(nativeInput, stage.input, 'captured user input is the exact standard runtime stdin');
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(helper.serialize(records))); child.emit('close', 0);
        });
      } };
      return child;
    } });
  f.partitionModelLaunches = (f.partitionModelLaunches || 0) + 1;
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort,
    sandbox_mode: 'read-only', agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
  { dispatch_id: dispatchId, prompt: stage.input.slice(prefix.length) });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched }, capabilities: a.capabilities });
  const dispatched = createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch({ runtime: 'codex', role: 'integrator',
    dispatch_id: dispatchId, signals: original.review.prepared.signals }, { ticket: scope.ticket });
  return { recorder, dispatched, nativeFile, result };
}

async function partitionClaudeNativeFixture(f, original, stage, result, dispatchId) {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { createClaudeRuntimeHost } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { createClaudeDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
  const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered original Claude stream is required');
  const templates = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(row => !row.shipyard_fixture);
  const template = predicate => structuredClone(templates.find(predicate));
  const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const session = crypto.randomUUID(), transcriptDir = path.join(f.root, 'partition-claude', dispatchId);
  const recorder = f.partitionRecorder;
  const runtime = createClaudeRuntimeHost({ scope: { ...original.scope, run_id: dispatchId }, recorder,
    transcriptDir, uuid: () => session, startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
    sessionTranscriptRoot: path.join(f.root, 'partition-claude-native'),
    probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
      capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
    spawn(_file, args) {
      f.partitionModelLaunches = (f.partitionModelLaunches || 0) + 1;
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let framed = '';
      child.stdin = { write(raw) { framed += raw; }, end() { process.nextTick(() => {
        try {
          const user = JSON.parse(framed.trim());
          assert.equal(user.message.content, stage.input);
          const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
          const init = template(row => row.type === 'system' && row.subtype === 'init');
          Object.assign(init, { session_id: session, model, cwd: f.worktree });
          const assistant = template(row => row.type === 'assistant'); assistant.session_id = session;
          assistant.message.model = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
          assistant.message.content[0].input = result;
          const final = template(row => row.type === 'result');
          Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
          const file = path.join(f.root, 'partition-claude-native/project', session + '.jsonl');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, serialize([{ ...user, sessionId: session }, { ...structuredClone(assistant), sessionId: session, effort }]));
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
          const hook = settings.hooks.SessionStart[0].hooks[0].args;
          const value = name => hook[hook.indexOf(name) + 1];
          capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: session, transcript_path: file, cwd: f.worktree },
            { evidenceFile: value('--evidence-file'), expectedSession: value('--expected-session') });
          child.stdout.emit('data', Buffer.from(serialize([init, assistant, final]))); child.emit('close', 0, null);
        } catch (error) { child.emit('error', error); }
      }); } };
      return child;
    } });
  const adapter = createClaudeDispatchAdapter({ capabilities: runtime.capabilities, host: {
    async launch(selection) { return runtime.applicationEvidence({ result: await runtime.agent(stage.input, selection) }); },
  } });
  const dispatched = await createDispatchBoundary({ adapters: { claude: adapter }, recorder }).dispatch({
    runtime: 'claude', role: 'integrator', dispatch_id: dispatchId, signals: original.review.prepared.signals }, { ticket: stage.subject });
  assert.equal(dispatched.receipt.compliance, 'verified');
  return { recorder, dispatched, result };
}

function partitionFixtureRequest(helper, original, launch) {
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const { a } = original;
  const meta = helper.template(helper.parent, row => row.type === 'session_meta');
  const context = helper.template(helper.parent, row => row.type === 'turn_context');
  Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort,
    cwd: launch.worktree, workspace_roots: [launch.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
  const { turn_id, ...framing } = context.payload;
  const frame = launch.runtime === 'codex' ? {
    developers: [{ role: 'developer', content: [{ type: 'input_text', text: runtime.generatedInstructions(a.text) }] }],
    other_users: [], base_instructions: meta.payload.base_instructions || null, contexts: [framing],
  } : { developers: [], other_users: [], base_instructions: null, contexts: [] };
  return { schema: 'shipyard.integration-native-request.v1', runtime: launch.runtime, model: launch.model,
    effort: launch.effort, input: launch.input, instruction_sha256: launch.instruction_sha256,
    recipe_sha256: hash(stable(original.partitionRecipes.get(launch.plan_sha256))), frame, tools: [],
    native_payload: stable({ frame, tools: [], input: launch.input }) };
}

function partitionFixtureHost(f, helper, original, partitions, mutateEvidence) {
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  original.partitionRecipes ||= new Map();
  original.partitionRecipes.set(partitions.plan.plan_sha256, partitions.plan.capacity.recipe);
  f.partitionRecorder ||= createDurableRecorder(path.join(f.root, 'partition-receipts'));
  const source = 'behavior-only-fixture-' + partitions.plan.runtime;
  const directory = path.join(f.root, 'behavior-only-counter'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retain = payload => {
    const raw = stable(payload), file = path.join(directory, hash(raw) + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, raw, { mode: 0o600 });
    const pin = { path: file, bytes: Buffer.byteLength(raw), sha256: hash(raw) };
    (f.partitionCounterPins ||= []).push(pin);
    return pin;
  };
  const host = roleArtifact.createIntegrationCapacityHost({ partitions, runtime: partitions.plan.runtime, recorder: f.partitionRecorder,
    counterSource: source + '-counter', windowSource: source + '-window',
    renderLaunch: launch => {
      const request = partitionFixtureRequest(helper, original, launch);
      mutateEvidence?.(request, 'request');
      return request;
    },
    readWindow: identity => {
      const captured = helper.template(helper.parent, row => row.payload?.type === 'token_count').payload.info;
      const evidence = { schema: 'shipyard.integration-runtime-window.v1', ...identity, source: source + '-window',
        evidence_id: source + '-window', window_tokens: captured.model_context_window, behavior_only: true };
      mutateEvidence?.(evidence, 'window');
      return retain(evidence);
    },
    measureInput: (request, identity) => {
      f.partitionCounterCalls = (f.partitionCounterCalls || 0) + 1;
      const captured = helper.template(helper.parent, row => row.payload?.type === 'token_count').payload.info;
      const evidence = { schema: 'shipyard.integration-input-measurement.v1', ...identity,
        runtime: request.runtime, model: request.model, source: source + '-counter',
        evidence_id: source + '-counter-' + identity.launch_sha256,
        input_tokens_upper_bound: captured.last_token_usage.input_tokens, behavior_only: true };
      mutateEvidence?.(evidence, 'measurement');
      return retain(evidence);
    } });
  if (!mutateEvidence) {
    original.partitionHosts ||= new Map();
    original.partitionHosts.set(partitions.plan.plan_sha256, host);
  }
  return host;
}

async function partitionAdmitFixture(f, helper, original, stage, mutateEvidence, partitions = original.partitions) {
  const host = !mutateEvidence && original.partitionHosts?.get(stage.plan_sha256)
    || partitionFixtureHost(f, helper, original, partitions, mutateEvidence);
  return roleArtifact.admitIntegrationCapacity({ prepared: stage, host });
}

function partitionAssertFixture(original, prepared, launch = prepared) {
  return roleArtifact.assertIntegrationAdmission({ prepared, launch, host: original.partitionHosts.get(prepared.plan_sha256) });
}

function partitionUnitFixtureResult(stage) {
  const { payload } = stage, unit = payload.assignment;
  return { schema: 'shipyard.integration-unit-result.v1', review_contract: roleArtifact.INTEGRATION_REVIEW_V3,
    kind: 'unit', runtime: payload.runtime, subject: payload.subject, plan_sha256: payload.plan_sha256,
    unit_id: unit.unit_id, input_sha256: stage.input_sha256, reviewed_identity: payload.reviewed_identity,
    completeness: 'complete', outcome: 'passed', blocking_count: 0,
    coverage: { primary_segments: unit.primary_segments, primary_obligation_ids: unit.primary_obligation_ids,
      support_segments: unit.support_segments, support_obligation_ids: unit.support_obligation_ids },
    conclusions: ['Every assigned primary range and logical obligation reviewed in this fixture.'], findings: [], limitations: [],
    seams: unit.seam_ids.map(id => ({ id, disposition: 'unresolved', rationale: 'Independent final must judge this cross-unit interaction.' })),
    required_context: [], evidence_markdown: 'Original fixture unit evidence; no phase authority.' };
}

function partitionPhaseFixtureResult(f, original, partitions, aggregate) {
  const { plan } = partitions, { review } = original;
  return { review_contract: roleArtifact.INTEGRATION_REVIEW_V3, kind: 'phase', runtime: plan.runtime,
    subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: aggregate.input_sha256,
    reviewed_identity: plan.identity, completeness: 'complete', outcome: 'passed', summary: 'Independent final fixture seam and acceptance judgment.',
    phase: f.phase, head: f.head, head_tree: plan.identity.head_tree, base: 'origin/main', base_tree: plan.identity.base_tree,
    ticket_set: review.prepared.ticketSet, ticket_set_digest: plan.identity.ticket_set_digest, findings: [], blocking_count: 0,
    coverage: { ...aggregate.payload.coverage, seam_dispositions: plan.seams.map(seam => ({ id: seam.id,
      disposition: 'resolved', rationale: 'Independent final fixture evaluates complete acceptance and both sides of this seam.' })), limitations: [] },
    evidence_markdown: 'Separate original fixture final judgment over complete acceptance, verification and seams.' };
}

test('D-32 frozen full inventory, protected unit custody, restart and independent phase authority', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const crypto = require('node:crypto');
    const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });
    const oldReceipt = prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt;
    const longSource = '// ' + 'é😀'.repeat(52000) + '\n// final exact tail Ω\n';
    helper.write(f.worktree, 'src/consumer.cjs', longSource);
    helper.commit(f, 'oversized UTF8 line and exact diff tail');
    const original = partitionTestReview(f, helper), { review } = original;
    const capacity = partitionTestCapacity();
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review: { ...review }, capacity }), /private/);
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review, capacity: {} }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review, capacity });
    const { plan } = partitions;
    assert.ok(plan.units.length > 1, 'complete rendered input budgets determine the unit count');
    assert.deepEqual(plan.units.map(unit => unit.unit_id), plan.units.map((_, index) => 'u' + String(index + 1).padStart(6, '0')));
    const authorityRoot = roleArtifact.archiveAuthorityDirectory(f.worktree);
    const planFile = path.join(authorityRoot, 'integration-plan-' + plan.plan_sha256 + '.json');
    const indexFile = path.join(authorityRoot, 'integration-units-' + plan.plan_sha256 + '.json');
    const originalPlanBytes = fs.readFileSync(planFile);
    assert.equal(fs.statSync(planFile).mode & 0o777, 0o600);
    const fields = ['schema', 'version', 'review_contract', 'runtime', 'subject', 'identity', 'original_packet_sha256',
      'material', 'obligations', 'units', 'seams', 'governing', 'producer_pins', 'instruction_pins', 'capacity'];
    const domain = Object.fromEntries(fields.map(field => [field, plan[field]]));
    assert.equal(hash(stable(domain)), plan.plan_sha256);
    const arrival = structuredClone(plan);
    arrival.capacity.admissions = [{ input_sha256: '1'.repeat(64) }];
    arrival.identity.receipts = [{ outcome: 'passed' }];
    arrival.units[0].unit_index_entries = [{ result: 'future' }];
    arrival.final_result = { outcome: 'passed' };
    assert.equal(roleArtifact.integrationPartitionPlanHash(arrival), plan.plan_sha256);
    const staticSource = structuredClone(plan); staticSource.producer_pins[0].sha256 = '0'.repeat(64);
    assert.notEqual(roleArtifact.integrationPartitionPlanHash(staticSource), plan.plan_sha256);
    const sources = plan.material.filter(source => source.content === longSource);
    assert.equal(sources.length, 1, 'equal complete source content is deduplicated');
    assert.ok(plan.material.some(source => source.content.includes('diff --git') && source.content.includes('final exact tail')));
    for (const source of plan.material) {
      const assigned = plan.units.flatMap(unit => unit.primary_segments).filter(segment => segment.source_id === source.source_id)
        .sort((a, b) => a.start_byte - b.start_byte);
      let cursor = 0;
      for (const segment of assigned) {
        assert.equal(segment.start_byte, cursor);
        const raw = Buffer.from(source.content).subarray(segment.start_byte, segment.end_byte);
        assert.equal(hash(raw), segment.sha256);
        assert.equal(Buffer.from(raw.toString('utf8')).compare(raw), 0);
        cursor = segment.end_byte;
      }
      assert.equal(cursor, source.bytes);
    }
    const ids = plan.units.flatMap(unit => unit.primary_obligation_ids);
    assert.equal(new Set(ids).size, plan.obligations.length);
    assert.deepEqual([...ids].sort(), plan.obligations.map(item => item.id).sort());
    const acceptance = plan.obligations.filter(item => /\/phase_contracts\/\d+\/acceptance\/\d+$/.test(item.pointer));
    const verification = plan.obligations.filter(item => /\/phase_contracts\/\d+\/verification\/\d+$/.test(item.pointer));
    assert.ok(acceptance.length >= 2 && verification.length >= 2);
    assert.equal(new Set(acceptance.map(item => item.id)).size, acceptance.length);
    assert.ok(acceptance.some((item, index) => acceptance.some((other, otherIndex) => index !== otherIndex && item.value === other.value)),
      'identical acceptance text at separate logical pointers stays separate');
    assert.ok(plan.units.every(unit => unit.governing_ids.length && unit.support_segments.length));
    assert.ok(plan.seams.some(seam => seam.uncertain && seam.rationale.includes('continuation')));
    assert.throws(() => roleArtifact.prepareIntegrationUnit({ partitions: JSON.parse(JSON.stringify(partitions)), unit_id: plan.units[0].unit_id, dispatch_id: 'copied' }), /private/);
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'premature-final' }), /all exact frozen units/);
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: partitions.reserved_template }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    const admittedPlanHash = plan.plan_sha256;
    const unitSessions = [];
    const stages = plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'partition-unit-' + ++f.count }));
    const host = original.partitionHosts.get(plan.plan_sha256);
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stages[0], launch: stages[0], host }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await partitionAdmitFixture(f, helper, original, stages[0]);
    assert.throws(() => partitionAssertFixture(original, stages[0]), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    for (const stage of stages.slice(1)) await partitionAdmitFixture(f, helper, original, stage);
    for (const [field, value] of [['dispatch_id', 'foreign-dispatch'], ['unit_id', 'u999999'], ['kind', 'phase'],
      ['plan_sha256', '0'.repeat(64)], ['verified_index_sha256', '0'.repeat(64)]]) {
      assert.throws(() => partitionAssertFixture(original, stages[0], { ...stages[0], [field]: value }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    }
    assert.equal(f.partitionModelLaunches || 0, 0, 'all exact units and reserved final are admitted without any model launch');
    for (const [index, unit] of plan.units.entries()) {
      const stage = stages[index];
      partitionAssertFixture(original, stage);
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: { ...stage, input: stage.input + 'altered' } }), /private/);
      const result = partitionUnitFixtureResult(stage);
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      const sealArgs = { prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result };
      if (index === 0) {
        const sourcePlan = path.join(f.worktree, f.rows['T-49-01'].plan), savedPlan = fs.readFileSync(sourcePlan);
        fs.appendFileSync(sourcePlan, '\n- Changed acceptance after the original unit launch.\n');
        assert.throws(() => roleArtifact.sealIntegrationUnit(sealArgs), /pin|changed|digest|stale/i);
        fs.writeFileSync(sourcePlan, savedPlan);
      }
      const altered = structuredClone(result);
      if (altered.coverage.primary_segments.length) altered.coverage.primary_segments.at(-1).end_byte--;
      else altered.coverage.primary_obligation_ids.pop();
      assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: altered }), /coverage|identity/);
      assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: { ...result,
        conclusions: ['x'.repeat(capacity.output_limits.conclusions + 1)] } }), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
      for (const change of [
        value => { value.unit_id = 'u999999'; },
        value => { value.plan_sha256 = '0'.repeat(64); },
        value => { value.runtime = 'claude'; },
        value => { value.coverage.primary_obligation_ids.push(value.coverage.primary_obligation_ids[0] || 'foreign'); },
        value => { value.coverage.support_segments = []; },
        value => { value.required_context = ['Missing governing support']; },
      ]) {
        const swapped = structuredClone(result); change(swapped);
        assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: swapped }), /identity|coverage|context/);
      }
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: { ...stage, input: stage.input + 'stale' } }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
      const sealed = roleArtifact.sealIntegrationUnit(sealArgs);
      unitSessions.push({ stage, native, sealed });
      assert.equal(sealed.artifact_kind, 'integration-unit');
      assert.ok(!fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')));
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: unit.unit_id }).reference.artifact_sha256, sealed.artifact_digest);
      assert.throws(() => roleArtifact.sealIntegrationUnit(sealArgs), /cannot be overwritten/);
      assert.throws(() => roleArtifact.sealJudgment({ worktreePath: f.worktree, role: 'integrator', phase: f.phase,
        ticket: review.prepared.ticket, base: 'origin/main', recorder: native.recorder, dispatchId: stage.dispatch_id,
        result, ticketSet: review.prepared.ticketSet }), /unit results/);
      roleArtifact.assertArchiveInventory(f.worktree, review.archivePins, { partitions });
      assert.throws(() => roleArtifact.assertArchiveInventory(f.worktree, review.archivePins), /membership/);
      const recovered = roleArtifact.prepareIntegrationPartitions({ review, plan_sha256: plan.plan_sha256, capacity });
      assert.equal(recovered.plan.plan_sha256, admittedPlanHash);
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recovered, unit_id: unit.unit_id }).reference.artifact_sha256, sealed.artifact_digest);
      if (unit.unit_id === plan.units[0].unit_id) {
        const restarted = partitionTestReview(f, helper);
        const recoveredFromFreshProducer = roleArtifact.prepareIntegrationPartitions({ review: restarted.review, plan_sha256: plan.plan_sha256, capacity });
        assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recoveredFromFreshProducer, unit_id: unit.unit_id }).reference.artifact_sha256,
          sealed.artifact_digest, 'new private preparation reuses only the protected original same-plan unit');
      }
      assert.deepEqual(fs.readFileSync(planFile), originalPlanBytes, 'admissions/index/results never move frozen hash/bytes');
    }
    const first = unitSessions[0];
    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, oldReceipt);
    assert.deepEqual(fs.readFileSync(prior.artifact), prior.original);
    for (const file of [indexFile, planFile]) {
      const saved = fs.readFileSync(file), envelope = JSON.parse(saved);
      if (file === indexFile) envelope.payload.entries.reverse(); else envelope.payload.plan.units[0].primary_obligation_ids.pop();
      envelope.mac = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
      assert.throws(() => roleArtifact.validateIntegrationUnit({ partitions, unit_id: first.stage.unit_id }), /HMAC|coverage|primary/);
      fs.writeFileSync(file, saved);
    }
    const firstBytes = fs.readFileSync(first.sealed.artifact_ref);
    fs.appendFileSync(first.sealed.artifact_ref, ' ');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'tampered-parts' }), /archive|bytes|digest|pin/i);
    fs.writeFileSync(first.sealed.artifact_ref, firstBytes);
    const outputPin = first.native.dispatched.receipt.runtime_evidence.transcript;
    const savedOutput = fs.readFileSync(outputPin.path);
    fs.appendFileSync(outputPin.path, ' ');
    assert.throws(() => roleArtifact.validateIntegrationUnit({ partitions, unit_id: first.stage.unit_id }), /stream|native|changed|bound/i);
    fs.writeFileSync(outputPin.path, savedOutput);
    const extra = path.join(path.dirname(first.sealed.artifact_ref), 'uncatalogued.md');
    fs.writeFileSync(extra, 'unrelated archive addition');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'unindexed-addition' }), /membership/);
    fs.unlinkSync(extra);
    const priorBytes = fs.readFileSync(prior.artifact); fs.appendFileSync(prior.artifact, ' ');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'changed-history' }), /archive|bytes|digest|pin/i);
    fs.writeFileSync(prior.artifact, priorBytes);
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: review }), null, 'indexed units cannot become a current phase verdict');
    const aggregate = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'partition-final-' + ++f.count });
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: aggregate }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.ok(!aggregate.input.includes(longSource), 'final carries bounded conclusions and governing/acceptance, not whole raw product sources');
    assert.deepEqual(aggregate.payload.governing.filter(item => acceptance.some(accepted => accepted.id === item.id)), acceptance);
    await partitionAdmitFixture(f, helper, original, aggregate);
    partitionAssertFixture(original, aggregate);
    const phaseResult = partitionPhaseFixtureResult(f, original, partitions, aggregate);
    const unresolvedStage = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'unresolved-final-' + ++f.count });
    await partitionAdmitFixture(f, helper, original, unresolvedStage);
    const unresolvedResult = structuredClone(phaseResult); unresolvedResult.input_sha256 = unresolvedStage.input_sha256;
    unresolvedResult.coverage.seam_dispositions[0].disposition = 'unresolved';
    const unresolvedNative = await partitionNativeFixture(f, helper, original, unresolvedStage, unresolvedResult, unresolvedStage.dispatch_id);
    const failedEvidence = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(failedEvidence, unresolvedResult.evidence_markdown);
    const { evidence_markdown: failedMarkdown, ...unresolvedSealedResult } = unresolvedResult;
    assert.throws(() => roleArtifact.sealJudgment({ worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: plan.subject,
      base: 'origin/main', recorder: unresolvedNative.recorder, dispatchId: unresolvedStage.dispatch_id, result: unresolvedSealedResult,
      ticketSet: review.prepared.ticketSet, ticketSetDigest: plan.identity.ticket_set_digest, evidencePath: failedEvidence, integrationReview: review }), /unresolved seams/);
    const finalSession = await partitionNativeFixture(f, helper, original, aggregate, phaseResult, aggregate.dispatch_id);
    assert.ok(unitSessions.every(unit => unit.native.dispatched.receipt.runtime_evidence.session_id !== finalSession.dispatched.receipt.runtime_evidence.session_id));
    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(evidencePath, phaseResult.evidence_markdown);
    const { evidence_markdown: markdown, ...finalResult } = phaseResult;
    const finalArgs = { worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: plan.subject,
      base: 'origin/main', recorder: finalSession.recorder, dispatchId: aggregate.dispatch_id, result: finalResult,
      ticketSet: review.prepared.ticketSet, ticketSetDigest: plan.identity.ticket_set_digest, evidencePath, integrationReview: review };
    assert.throws(() => roleArtifact.sealJudgment({ ...finalArgs, recorder: first.native.recorder, dispatchId: first.stage.dispatch_id }),
      /unrelated final|fresh actual final|independent final/);
    const sealedFinal = roleArtifact.sealJudgment(finalArgs);
    const validated = roleArtifact.validateJudgmentManifest({ ...finalArgs, artifactPath: sealedFinal.artifact_ref, artifactDigest: sealedFinal.artifact_digest });
    assert.equal(validated.manifest.integration_partition.kind, 'phase');
    const currentArgs = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: review };
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs)?.authenticated, true);
    const installed = path.join(original.a.dir, original.a.selection.agent_file), installedBytes = fs.readFileSync(installed);
    fs.appendFileSync(installed, '\n# changed after final\n');
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(installed, installedBytes);
    const planPath = path.join(f.worktree, f.rows['T-49-01'].plan), acceptedBytes = fs.readFileSync(planPath);
    fs.appendFileSync(planPath, '\n- Changed acceptance without moving source HEAD.\n');
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(planPath, acceptedBytes);
    const graphFile = path.join(f.graphDir, 'tickets.json'), graphBytes = fs.readFileSync(graphFile);
    const movedGraph = JSON.parse(graphBytes); delete movedGraph.tickets['T-49-02'];
    fs.writeFileSync(graphFile, JSON.stringify(movedGraph));
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(graphFile, graphBytes);
    git(f.worktree, ['update-ref', 'refs/remotes/origin/main', f.head]);
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    git(f.worktree, ['update-ref', 'refs/remotes/origin/main', f.base]);
    assert.deepEqual(fs.readFileSync(planFile), originalPlanBytes);
  });
});

test('D-32 capacity refuses unknown and over-bound evidence before granting stage admission', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper);
    const capacity = partitionTestCapacity();
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity });
    const stage = roleArtifact.prepareIntegrationUnit({ partitions, unit_id: partitions.plan.units[0].unit_id, dispatch_id: 'capacity-unit' });
    await assert.rejects(partitionAdmitFixture(f, helper, original, stage, (evidence, kind) => {
      if (kind === 'window') delete evidence.window_tokens;
    }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.throws(() => roleArtifact.createIntegrationCapacityHost({ partitions, runtime: 'codex', recorder: f.partitionRecorder }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stage, host: {},
      measurement: { method: 'native-exact', input_tokens_upper_bound: 1 }, window_tokens: 999999999 }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const negatives = [
      ['window', evidence => { evidence.runtime = 'claude'; }],
      ['window', evidence => { evidence.model = 'foreign'; }],
      ['window', evidence => { evidence.source = 'model-echo'; }],
      ['window', evidence => { evidence.window_tokens = 0; }],
      ['measurement', evidence => { evidence.runtime = 'claude'; }],
      ['measurement', evidence => { evidence.model = 'foreign'; }],
      ['measurement', evidence => { evidence.source = 'public-certificate'; }],
      ['measurement', evidence => { evidence.request_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.recipe_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.launch_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.plan_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.method = 'certified-upper-bound'; }],
      ['measurement', evidence => { evidence.input_tokens_upper_bound = 0; }],
      ['request', evidence => { evidence.input += 'not the original input'; }],
      ['request', evidence => { delete evidence.native_payload; }],
      ['request', evidence => { delete evidence.tools; }],
    ];
    for (const [target, mutate] of negatives) {
      await assert.rejects(partitionAdmitFixture(f, helper, original, stage, (evidence, kind) => {
        if (kind === target) mutate(evidence);
      }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN', target);
    }
    let changed = null;
    const owned = partitionFixtureHost(f, helper, original, partitions, (evidence, kind) => {
      if (kind === 'request') {
        if (changed === 'tools') evidence.tools.push({ name: 'unmeasured-tool' });
        if (changed === 'frame') evidence.frame.base_instructions = 'changed installed framing';
        if (changed === 'payload') evidence.native_payload += 'changed full payload';
      }
    });
    const admission = await roleArtifact.admitIntegrationCapacity({ prepared: stage, host: owned });
    for (const field of ['tools', 'frame', 'payload']) {
      changed = field;
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: stage, host: owned }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    }
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stage, host: structuredClone(owned) }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const windowFile = admission.window_evidence_pin.path, windowBytes = fs.readFileSync(windowFile);
    fs.appendFileSync(windowFile, ' ');
    changed = null;
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: stage, host: owned }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    fs.writeFileSync(windowFile, windowBytes);
    assert.equal(f.partitionModelLaunches || 0, 0, 'unknown, foreign, stale and public evidence launches zero models');
    const over = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ output_reserve_tokens: 300000 }) });
    assert.notEqual(over.plan.plan_sha256, partitions.plan.plan_sha256, 'static reserve changes freeze a different plan');
    await assert.rejects(partitionAdmitFixture(f, helper, original, over.reserved_template, undefined, over), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
    const stale = structuredClone(stage); stale.input_sha256 = '0'.repeat(64);
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stale }), /private/);
    const changedRecipe = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'certified-upper-bound' } }) });
    assert.notEqual(changedRecipe.plan.plan_sha256, partitions.plan.plan_sha256);
    const bounded = await partitionAdmitFixture(f, helper, original, changedRecipe.reserved_template, undefined, changedRecipe);
    assert.equal(bounded.measurement.method, 'certified-upper-bound');
    assert.match(bounded.sources.counter, /behavior-only-fixture-codex-counter/);
    assert.equal(f.partitionModelLaunches || 0, 0, 'behavior-only counter transport never launches a measurement model');
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ unit_input_bytes: 1, segment_bytes: 1 }) }), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
  });
});

test('D-32 Claude admits independent behavior-only non-model evidence and retains native unit/final custody', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper, 'claude');
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity: partitionTestCapacity() });
    const codex = partitionTestReview(f, helper, 'codex');
    const codexPartitions = codex.partitions = roleArtifact.prepareIntegrationPartitions({ review: codex.review, capacity: partitionTestCapacity() });
    const codexHost = partitionFixtureHost(f, helper, codex, codexPartitions);
    const stages = partitions.plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'claude-partition-' + ++f.count }));
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stages[0], host: codexHost }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    for (const target of ['window', 'measurement']) await assert.rejects(partitionAdmitFixture(f, helper, original, stages[0], (evidence, kind) => {
      if (kind === target) evidence.runtime = 'codex';
    }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const bounded = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'certified-upper-bound' } }) });
    const boundAdmission = await partitionAdmitFixture(f, helper, original, bounded.reserved_template, undefined, bounded);
    assert.equal(boundAdmission.runtime, 'claude'); assert.equal(boundAdmission.measurement.method, 'certified-upper-bound');
    const template = await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    assert.equal(template.runtime, 'claude'); assert.match(template.sources.window, /behavior-only-fixture-claude-window/);
    for (const stage of stages) await partitionAdmitFixture(f, helper, original, stage);
    assert.equal(f.partitionModelLaunches || 0, 0, 'Claude prelaunch measurement launches no native model session');
    const sessions = [];
    for (const stage of stages) {
      const result = partitionUnitFixtureResult(stage);
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      roleArtifact.sealIntegrationUnit({ prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result });
      sessions.push(native.dispatched.receipt.session_id);
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: stage.unit_id }).result.runtime, 'claude');
      const recovered = roleArtifact.prepareIntegrationPartitions({ review: original.review, plan_sha256: partitions.plan.plan_sha256 });
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recovered, unit_id: stage.unit_id }).result.runtime, 'claude');
      roleArtifact.assertArchiveInventory(f.worktree, original.review.archivePins, { partitions });
    }
    const aggregate = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'claude-partition-final' });
    assert.throws(() => partitionAssertFixture(original, aggregate), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const actual = await partitionAdmitFixture(f, helper, original, aggregate);
    assert.equal(actual.verified_index_sha256, aggregate.payload.verified_index_sha256);
    assert.notEqual(actual.request_sha256, template.request_sha256, 'actual verified results require fresh final evidence');
    const result = partitionPhaseFixtureResult(f, original, partitions, aggregate);
    const native = await partitionNativeFixture(f, helper, original, aggregate, result, aggregate.dispatch_id);
    assert.ok(!sessions.includes(native.dispatched.receipt.session_id));
    assert.equal(f.partitionModelLaunches, stages.length + 1, 'exactly one native session per unit and one independent final');
    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(evidencePath, result.evidence_markdown);
    const { evidence_markdown, ...sealedResult } = result;
    const args = { worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: partitions.plan.subject,
      base: 'origin/main', recorder: native.recorder, dispatchId: aggregate.dispatch_id, result: sealedResult,
      ticketSet: original.review.prepared.ticketSet, ticketSetDigest: partitions.plan.identity.ticket_set_digest,
      evidencePath, integrationReview: original.review };
    const sealed = roleArtifact.sealJudgment(args);
    assert.equal(roleArtifact.validateJudgmentManifest({ ...args, artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest }).manifest.integration_partition.kind, 'phase');
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: original.review })?.authenticated, true);
  });
});

for (const mode of ['incomplete', 'needs-fix']) test('D-32 authentic ' + mode + ' unit cannot supply aggregate authority', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper);
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity: partitionTestCapacity() });
    await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    const stages = partitions.plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'nonpassing-' + ++f.count }));
    for (const stage of stages) await partitionAdmitFixture(f, helper, original, stage);
    for (const stage of stages) {
      const result = partitionUnitFixtureResult(stage);
      if (mode === 'incomplete') {
        result.completeness = 'incomplete'; result.outcome = 'human-review-required'; result.required_context = ['Required context unavailable.'];
      } else {
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        result.findings = [{ id: 'original-blocker', type: 'violation', blocking: true,
          summary: 'Fixture behavior violates acceptance.', evidence: 'Original assigned fixture source.' }];
      }
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      roleArtifact.sealIntegrationUnit({ prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result });
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: stage.unit_id }).result.outcome, result.outcome);
    }
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'invalid-pass' }), /incomplete, failing or context-blocked/);
  });
});
}

module.exports = { registerRoleArtifacts };

if (require.main === module) {
  const { test, after } = require('node:test');
  const lifecycle = createRoleArtifactLifecycle();
  lifecycle.start();
  try {
    const context = createRoleArtifactFixture({ unitDir: __dirname,
      scriptsDir: require('node:path').resolve(__dirname, '../../plugins/delivery-pipeline/scripts'),
      require, module, assert: require('node:assert'), suite() {}, lifecycle });
    registerRoleArtifacts((name, callback) => test(name, { timeout: 180000, concurrency: 2 },
      () => lifecycle.run(callback)), context);
    registerLayoutChecks((name, callback) => test(name, { timeout: 180000, concurrency: 2 },
      () => lifecycle.run(callback)), context);
    after(async () => { await lifecycle.settle(); lifecycle.cleanup(); });
  } catch (error) { lifecycle.cleanup(); throw error; }
}

const ORIGINAL_SOURCE = Object.freeze({
  commit: 'b2f752233446f6569ffee4bd1720c8f383127fd1',
  path: 'tests/unit/role-artifact.test.cjs',
  bytes: 344091,
  sha256: 'f3579315c0e2e5ed2de65372e39c24b182b77307610aadeb07c2fd2481d79c8a',
});
const ORIGINAL_DECLARATIONS = Object.freeze([
  {"line":290,"start":11769,"end":13425,"owner":"role-artifact.test.cjs","sha256":"e7a94598b5c190232efa0bbbb7b3389e012d0915f27d8dbef00f7fb6332f22d8"},
  {"line":321,"start":13427,"end":15231,"owner":"role-artifact.test.cjs","sha256":"aaedb149c8d1b02735b757385e7650ab508b934d3508e37cb803614d1eb744e2"},
  {"line":353,"start":15286,"end":15755,"owner":"role-artifact.test.cjs","sha256":"cda938ff7b83c9dfd728c8312283289fbab32d73904351aaf436bf3973a2b79b"},
  {"line":362,"start":15757,"end":18147,"owner":"role-artifact.test.cjs","sha256":"c99d3ebba27a5871e942f4515652de8b69405bd6813341f515eb43bf68f82e3f"},
  {"line":417,"start":18149,"end":21838,"owner":"role-artifact.test.cjs","sha256":"ecd8f3e79cbd7f46cd40b83c439daecafe8803c88bcde5be17762505fdf28ccc"},
  {"line":487,"start":21840,"end":22769,"owner":"role-artifact.test.cjs","sha256":"940e7d180a20493672ee879b1d746dba98b744b442815b61c89bccb58e72652a"},
  {"line":516,"start":22771,"end":24791,"owner":"role-artifact.test.cjs","sha256":"9fceabdd4e5a047f35d9b5c4708b55a2c1b6ac655901dac969f994e07493670d"},
  {"line":554,"start":24793,"end":25313,"owner":"role-artifact.test.cjs","sha256":"b040b528eb90123d8af1e316c4f1de69566d563f348cc1ff492c4fd877a2905a"},
  {"line":567,"start":25315,"end":27787,"owner":"role-artifact.test.cjs","sha256":"e3136e8a7857cdecba020c4dba8dbe55b704c509a797a5351e3e18e534b575ab"},
  {"line":612,"start":27865,"end":28524,"owner":"role-artifact.test.cjs","sha256":"002bc8987d9ed98a22da6bf78132057e11bfd70f6deac7a75035a19981309c0b"},
  {"line":627,"start":28526,"end":28881,"owner":"role-artifact.test.cjs","sha256":"3ab07b0dfe282ee56cf003fdb193d8c1422a3f15af3bf917522270a2f3943cea"},
  {"line":639,"start":28883,"end":29560,"owner":"role-artifact.test.cjs","sha256":"9ce0fb556ef71fe7bd69f599f9d65191e08a8ed41e006affe19d26bcc2e52931"},
  {"line":654,"start":29562,"end":29955,"owner":"role-artifact.test.cjs","sha256":"fbd16e36eb363d2ade44090e35f064ea8377b3ec5003ccf8db8013e192c556c1"},
  {"line":668,"start":30019,"end":31477,"owner":"role-artifact.test.cjs","sha256":"2c1ed6a62ba8b96e955926881116222dce4cfe67f8bae18cb59a9770d55a8b5c"},
  {"line":705,"start":31479,"end":32744,"owner":"role-artifact.test.cjs","sha256":"46aefaf7550df2c51ff76d6daf07ff92051a2689105d5e0ffd54954a9cde20a9"},
  {"line":743,"start":32746,"end":33958,"owner":"role-artifact.test.cjs","sha256":"9eae3d86a8921818fdfd52693214b0a3f324eb0b131e8994c637b2edfae67ead"},
  {"line":781,"start":33960,"end":34483,"owner":"role-artifact.test.cjs","sha256":"6af57b6a7a2d25d7af431ad5f5b64865d3e7b650fc804ac05c06a0bec06f62bd"},
  {"line":797,"start":34485,"end":34656,"owner":"role-artifact.test.cjs","sha256":"c94e18dcb77aff048a517839abd1d410c028c7361144f999cffd8571567ec3a1"},
  {"line":805,"start":34803,"end":37776,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"de69aa18ebef6e680401905d014ee2cfb3c913c7cddacad84a38c86d78313a3c"},
  {"line":850,"start":37778,"end":39429,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"af5be973c7f30f744c3ff1bbc380f095cdd74c2dfe9a1ef59ada36da08554972"},
  {"line":878,"start":39431,"end":40969,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"1e18b13bb103b2e36fa79bdcb7f1d04ab6bfc84bcbce83cf89bb375a3b216fd1"},
  {"line":906,"start":40972,"end":42004,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"8c8f97ea1c37de14b748e862dc595800d6f0a280037cded485e7cb490d9557f3"},
  {"line":931,"start":42006,"end":45439,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"7d10de085aa926e549788b5e05e6d71e662f56e69fe15fa83e9252bd7e01a455"},
  {"line":979,"start":45442,"end":46363,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"74073f39c73fd2f3d1d4a3e0adda2f26fcb1830ed78dbd0592a766d0f2ab2509"},
  {"line":1004,"start":46420,"end":47511,"owner":"role-artifact.test.cjs","sha256":"5c81f6f7334d6a4efecec5fd717a94ea9eacd8e5d7ae400deada3df6519d89f5"},
  {"line":1022,"start":47513,"end":47991,"owner":"role-artifact.test.cjs","sha256":"550d977cc41db43cbbe1ea05113377e3e828d99bb1eaf413d5ed786210ce5f75"},
  {"line":1032,"start":47993,"end":49419,"owner":"role-artifact.test.cjs","sha256":"a7264fc79cc09bf58615ea69e79cae6335572f438e803dc75fb77789068f1c21"},
  {"line":1057,"start":49421,"end":51564,"owner":"role-artifact.test.cjs","sha256":"8a50d5718c197bf5fad61c9bd879019d84da0910c57d5f0aad39a27ec721872c"},
  {"line":1089,"start":51566,"end":54104,"owner":"role-artifact.test.cjs","sha256":"f94658adc7bd9690f320cdd1a123f1817ff0c357c81091a48cea91d256068061"},
  {"line":1121,"start":54106,"end":55796,"owner":"role-artifact.test.cjs","sha256":"8bcbbfbcf22bfc52906bf5b9cdcec9252bfb999a5a3c1276ceb10dd32d9e4943"},
  {"line":1150,"start":55798,"end":57659,"owner":"role-artifact.test.cjs","sha256":"20034b69160965c6adb108bed59a0c0e8ba78530b6f39fdccdc87ddeb82a9e97"},
  {"line":1184,"start":57661,"end":59656,"owner":"role-artifact.test.cjs","sha256":"68ccf2f7788b7a2851c5adf1f2a286434309908b90b60c50fb2dd52651ff51a9"},
  {"line":1266,"start":62804,"end":64460,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"cd2a5407d40f947b72e6b8c7ac9fa0079119a858fd01f9b33489aa8abcec0832"},
  {"line":1304,"start":65248,"end":69070,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"9ea89a1a0046699b2e91f2f5177157fa83c3dfb9c1aed6ed518cf2a288d79043"},
  {"line":1361,"start":69723,"end":71544,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"21272f8be16482f3c13e3a6a702634c16302c01b2b21719548d493d6fe69cb3c"},
  {"line":1541,"start":81614,"end":85740,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"12f40ee03ca58c288ff6ccce1c57f12ddbc9e0c4ea1abc12cee5140ad185da98"},
  {"line":1605,"start":85742,"end":86600,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"79204ed334f7c3a671d6219a498b11f1211e1866d78935b185b17626a979c5bf"},
  {"line":1623,"start":86602,"end":87800,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"b1f8cdbc84860518697ee2bb8347f868cf7de385ee2764c2869ad5472d3e7b16"},
  {"line":1649,"start":87802,"end":88736,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"5daa02277eeb98aa621f8504ce375ebef8de40a42664d537fb80b79c2eb7834e"},
  {"line":1668,"start":88738,"end":91344,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"89ff779ab253aa466b787542d332b5bbc99313b9c8243ed98a2076bf5f8e5eca"},
  {"line":1711,"start":91346,"end":91699,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"177a7c292115766dc8e5c404de28e3ca827e5cecb72198bbd4f6c9f2d2b55d91"},
  {"line":1720,"start":91701,"end":92739,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"6c1fbd180b9d9ec3489db97ac7ddbcec9dc6c169a0ba806d58e5251ca6413355"},
  {"line":1736,"start":92741,"end":94156,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"8269f83be9c4e0bcda365785cce32dfdc3c58a315938bf9c56eef8af9e4516e7"},
  {"line":1757,"start":94158,"end":95509,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"af0e826d2007701c5dcf7db4177509011517638a8e2a0a80f517b8a8bb5d7653"},
  {"line":1800,"start":97386,"end":98732,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"7eb3ad9fe5b4e8e7e8152fb6bb0f33ac0bbf56863ff2bc47646a7c6b8fd8bbfc"},
  {"line":1823,"start":98734,"end":100594,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"008fb7929285ce930de97fa1c130310eea32506531d5b2458f768417213ebd43"},
  {"line":1858,"start":100596,"end":102059,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"0e8ce4e5ca93fc6d0e3299bc1a2d7c9a09932dd592e07c0bc284e3e73ce1e02b"},
  {"line":1882,"start":102061,"end":103492,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"d45bd890863fdc9f74545dc290f388d298be7e53d7c57dab29977d26356865b4"},
  {"line":1905,"start":103494,"end":104481,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"5d6c54479eff829544fa70fd099c96af7017ad1d357fa05d2b25ee62cb08189b"},
  {"line":1928,"start":104483,"end":106350,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"29beba201dc416388bed43e9c1ef7b4aed8b2c2e389a1662d3e0126578833873"},
  {"line":1961,"start":106352,"end":106959,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"54725ab3eb5f66c538ce281cc12b4a0000d5748d0e1d614454ec33dc82c6d0e3"},
  {"line":1973,"start":106961,"end":107881,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"8b4db4cebfd4260ae3bf4b49b0ab67c3cc99a0a29b3737ac05b60524ee35b018"},
  {"line":1989,"start":107883,"end":109651,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"d7d56d24b97780dcca4f8a8dc24912ac5e9e2829fd7e4e9802f480bd1aef4529"},
  {"line":2011,"start":109653,"end":110932,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"9af9281e63778e17e66fbb2d30c574e3568138a4b5539d0ce0d42cb2b08fe28f"},
  {"line":2038,"start":110934,"end":112121,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"67a3e5caa7bb27a49480ec991b59fdb1c2e3c3e402954a7bf2011a9495fca902"},
  {"line":2061,"start":112123,"end":113496,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"1b1f3ebc81473c83bb39a481d237b256a3f9844e5be950e5183f465892e90615"},
  {"line":2081,"start":113498,"end":114650,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"e4c77308a28acb16dc837a4c4802eb302586c6036deb3c6848128a280916ebf6"},
  {"line":2098,"start":114653,"end":117651,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"0647bc6b92d5f8ecb01cd839cd3bc83b28af571784a151ba57c433f95ddce36f"},
  {"line":2137,"start":117653,"end":120556,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"3dc11e14d64ad51233a7317edb8e19cd38975aa966da39b85d9d14f7492964a8"},
  {"line":2175,"start":120558,"end":121427,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"913f316fa689599a0beb80c78c7c671dde07838f5a2f5229dfcac919b455cadb"},
  {"line":2190,"start":121429,"end":124044,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"816512bda8f5d6069b7fb45f0b02809491a6055ba136df176d12a063d35d5b62"},
  {"line":2232,"start":124048,"end":125258,"owner":"phase53-z29u-role-containment.test.cjs","sha256":"a5c68b77394e16d199130bae8e8a57ab63a99c1ca7294f710c40a839a4d8449b"},
  {"line":2248,"start":125261,"end":126320,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"f4eef67bb308de759f8696247e6bb1d102c710bb28a6f4d0ac9bdc5f735f4fde"},
  {"line":2267,"start":126322,"end":129989,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"916e2c1d20ebf4ffb331fc60a45558e03b90e13d100ba32a1832dacbeadcad60"},
  {"line":2337,"start":130390,"end":133322,"owner":"role-artifact.test.cjs","sha256":"241a1eb16c1c0ae11a88cd0a2ba3606d857f879623e80977402ccdd8469158cf"},
  {"line":2381,"start":133324,"end":134698,"owner":"role-artifact.test.cjs","sha256":"ccd4ed403bd932f810146baa2d277f6f2add530ef23aa3b83894dd1b60dd7595"},
  {"line":2404,"start":134700,"end":136006,"owner":"role-artifact.test.cjs","sha256":"adf72431228bb0707bcc78055f5d6f6eab3d4bcb2ec3a5b16d00c1c09d0e06c8"},
  {"line":2420,"start":136008,"end":137524,"owner":"role-artifact.test.cjs","sha256":"003b7fdbb214635f7cfd94a5758b382e74f5a0472de3f1dc848fb44c66e546e6"},
  {"line":2458,"start":138142,"end":141318,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"ee0bca5d31f9cb4b0090740ad6fd807a4d5700f6d856f6dee683839553b2e09a"},
  {"line":2511,"start":141320,"end":142714,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"b0d14d7e5a93ec15f2e072ccc588f0c968c6a16c2898d62c4f9888ba3fac1b70"},
  {"line":2534,"start":142716,"end":145078,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"b101dc38b5f82a8a4304b5779cbe3d7b98a158a66b4b804ce0ec16b93f61cbc5"},
  {"line":2572,"start":145080,"end":146455,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"9d0aac1b6cb234ad8b3ae3c136168483a5c27ba2a7db3466abb7633cf53f4fa4"},
  {"line":2593,"start":146457,"end":151528,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"6b373c520582f29602fcf3ea90fddb162b22d02ff96872353e1ce4cf00382700"},
  {"line":2642,"start":151530,"end":155569,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"e7ec90b5882341090fbb89b00dcfaff1cb797fe76ddbf652674ce4c452f224da"},
  {"line":2703,"start":155571,"end":157672,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"ce6708b14bf868d6b11dc89947e3553d172128ceef6633322631eaf0373b7013"},
  {"line":2730,"start":157675,"end":159401,"owner":"phase53-z29t-role-architecture-archives.test.cjs","sha256":"d64d1d2759b7d8616471744c40aab7c15224fca5a1a528098f43de6b7cab2a7e"},
  {"line":2787,"start":161637,"end":274802,"owner":"role-artifact.test.cjs","sha256":"2d92b2d71ec8ff5ee1ac95296d346d9ef0ce75cf601d4f774e3174d49618544c"},
  {"line":2835,"start":274804,"end":277499,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"1247a50e866179283addcc469eb94e1a78feba290f280b154197ccc6a3071292"},
  {"line":2880,"start":277502,"end":279142,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"da854b4e0a8dabf7dfa14c40571f9702de87e99f7e29fe013f2ff40f02deb853"},
  {"line":2906,"start":279144,"end":284291,"owner":"phase53-z29w-role-integration.test.cjs","sha256":"b626cadae302cacbffaa9b174bd57a63aa04d10c02524367255432f3f1ce4b12"},
  {"line":2985,"start":284294,"end":292928,"owner":"phase53-z29v-role-code-review.test.cjs","sha256":"7d5a544ab43d7c0f7d7c97211642f8971156d7c375622b3c8ea2d8dab03d4462"},
  {"line":3372,"start":312282,"end":330787,"owner":"phase53-z29w-role-integration.test.cjs","sha256":"53518d0faafc529b0b37ad276587a65be6346e67c989cb59dcced8fbf26b4e47"},
  {"line":3591,"start":330789,"end":336737,"owner":"phase53-z29w-role-integration.test.cjs","sha256":"e11cdd738415bcad7326071e9ac33da1c6384bf40417d5a3f16621db1514451e"},
  {"line":3671,"start":336739,"end":341960,"owner":"phase53-z29w-role-integration.test.cjs","sha256":"563dd491fc2bea9482e9e50e19af42a62eeaed67e61cd0e09b36129b1bdd65aa"},
  {"line":3729,"start":341962,"end":343822,"owner":"phase53-z29w-role-integration.test.cjs","sha256":"771fea35cc5b08e3e1b92db81c2a59d551eb026a77b2b7ea3bb9add6fee7d4d8"},
]);
const ORIGINAL_CASES = Object.freeze([
  {"name":"judgment evidence bound parity role/runtime descriptor thresholds","body_sha256":"fd09f421abda5eb97a17202a975ad12c2919b3fdc16e003cc2492cf4d4f89991","original_line":290,"owner":"role-artifact.test.cjs"},
  {"name":"judgment evidence bound parity Claude complete bytes 98304","body_sha256":"7dea6d4088315a68a97d6a00c466b014f4e2196774f2ef1a4a622839971d9f38","original_line":322,"owner":"role-artifact.test.cjs"},
  {"name":"judgment evidence bound parity Claude complete bytes 98305","body_sha256":"7dea6d4088315a68a97d6a00c466b014f4e2196774f2ef1a4a622839971d9f38","original_line":322,"owner":"role-artifact.test.cjs"},
  {"name":"judgment evidence bound parity Claude complete bytes 4194304","body_sha256":"7dea6d4088315a68a97d6a00c466b014f4e2196774f2ef1a4a622839971d9f38","original_line":322,"owner":"role-artifact.test.cjs"},
  {"name":"judgment evidence bound parity Claude complete bytes 4194305","body_sha256":"7dea6d4088315a68a97d6a00c466b014f4e2196774f2ef1a4a622839971d9f38","original_line":322,"owner":"role-artifact.test.cjs"},
  {"name":"exposes the trusted seal, validate, and read boundary","body_sha256":"6100f92cf35d4b62c4ee15d0d3894d4e582464d60b6a37bdf1af5b624c5c4a00","original_line":353,"owner":"role-artifact.test.cjs"},
  {"name":"registered executor host returns only a bounded envelope and validated references","body_sha256":"3869199480dac793bd46f061e7c6569497e7e747204121cb438f28f28a18da60","original_line":362,"owner":"role-artifact.test.cjs"},
  {"name":"rejects wrong dispatch, stale head, digest mutation, escaped paths, missing files, and symlinks","body_sha256":"f0e5ba153552e20020045623ad2cec68268f1df52f26b7c7a548f77a25c17996","original_line":417,"owner":"role-artifact.test.cjs"},
  {"name":"does not accept an agent-forged receipt or an unauthenticated store","body_sha256":"a9719072b597134c6af81eec48911a560f57b7f820ef5e3903a5612c88d3921c","original_line":487,"owner":"role-artifact.test.cjs"},
  {"name":"caps summaries and overflows actionable data to complete evidence","body_sha256":"9b48fb5a4db5f0a4bfdbf541f624c386e5fb8d6e6fcaf6720ea8aa83760795f3","original_line":516,"owner":"role-artifact.test.cjs"},
  {"name":"blocked executor outcomes stay explicit and do not receive a publishable artifact","body_sha256":"4e3728989379e4c8d3533b874f56c9a3f3ed745fa5e787ed8165f978553e5bfe","original_line":554,"owner":"role-artifact.test.cjs"},
  {"name":"CLI validate/read use the canonical helper and return the verified byte snapshot","body_sha256":"38ce2b8409eefada0d3ed1ca1a8afd779dc6484fbfe3e2bbc01d158402c3251b","original_line":567,"owner":"role-artifact.test.cjs"},
  {"name":"an exempt project still accepts the ticket marker as the first line","body_sha256":"8c2d486b487d94a585ecaac9b94473b2af007590993ed4b776fc63a9ed3bbefd","original_line":612,"owner":"role-artifact.test.cjs"},
  {"name":"a target project rejects a PR body starting with the ticket marker","body_sha256":"c8fdf659fe1e3c263019cd55bdd1c3be9a0efadfda004d578108487dd6013c45","original_line":627,"owner":"role-artifact.test.cjs"},
  {"name":"a target project accepts a neutral PR body and validates it","body_sha256":"6fae33c3be90132034bc7b6b12e4735e31ef1a68721c2c32df328f1490174f10","original_line":639,"owner":"role-artifact.test.cjs"},
  {"name":"an uncommitted worktree shipyard manifest does not grant the exemption","body_sha256":"cd35b111e4a62529ea373afd78a628b975a7e724c1f6d83f77923c205b383130","original_line":654,"owner":"role-artifact.test.cjs"},
  {"name":"keeps an unknown arch-review type as an informational note beside a blocker","body_sha256":"f13f78ef70155eb692c5529cc968c44b5a0b58444c1fdefd29b52c41ba907989","original_line":668,"owner":"role-artifact.test.cjs"},
  {"name":"keeps an unknown arch-review note under a conform verdict","body_sha256":"d32183bf5be19ce439f89fb2bddca12c143c634f522886ee95da8962250068f3","original_line":705,"owner":"role-artifact.test.cjs"},
  {"name":"an incomplete violation still fails and unknown notes require summary and non-blocking status","body_sha256":"b9632acdc2249a9a4a9c8d6381d8cd348bd2805fdec0d4489218b6e7c7afeb53","original_line":743,"owner":"role-artifact.test.cjs"},
  {"name":"blocking_count is checked after an omitted unknown-note blocking value becomes false","body_sha256":"bd6813a5db004c7f5777f8bd24008c93843b830af500e06e2ed5ccba02183755","original_line":781,"owner":"role-artifact.test.cjs"},
  {"name":"unknown arch-review normalization keeps the role artifact schema string","body_sha256":"508a7332f90f93c4a53751a03f54a3af3d384147bc57f3ac15505fd2026d55bb","original_line":797,"owner":"role-artifact.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: progress","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: duplicate-contract","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: duplicate-item","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: corrupt-terminal","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: failed-turn","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: incomplete-turn","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"original focused CLI retains progress and rejects invalid terminal results: foreign-session","body_sha256":"f77afb4eff997ec7b4c9115beb767e5a896a7556f72979e4c908d9a27980e497","original_line":806,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"fresh Codex architecture artifact remains valid after CLI inflight cleanup","body_sha256":"dd71e1c76494fa8c59508b8e586ded5c488140586191b493b7a749209f6c0c95","original_line":850,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed ADR content","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed draft lifecycle","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed live head","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed live base","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed plan authority","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed graph authority","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed corpus membership","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed original transcript","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses post-seal changed complete evidence","body_sha256":"a5c99a32835eede4e7dfda6f519e2c3f6e3a9d093a31a3031082a8c2cff7e69b","original_line":895,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses atomic source replacement while its original descriptor is open","body_sha256":"8a61d9101f620d093d1554327304c7893e2e18f89d0d4544ad2fd3a6c7e2a82c","original_line":906,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"public sealer cannot rebind an original native receipt to another canonical context","body_sha256":"f279ab7798210858d488f12ce0fba20f4ae14dbe5889496a53218021e8aea3d5","original_line":931,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"shared consumer refuses corpus membership added during recursive inventory","body_sha256":"18461893c7ef521d6aee99cbf380d96fd6dd1c694e19eb22266ea53129a689e8","original_line":979,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"Claude archives retain authenticated history and stale catalogue locks recover","body_sha256":"cbfeb562e67f560ad8c9b12b7a561a8b33d9ad25f2a6fa4b5e7701691d95d8e0","original_line":1004,"owner":"role-artifact.test.cjs"},
  {"name":"oversized findings fail before any archive directory or member is published","body_sha256":"16a0ac6e35982af18bee6d3e37e5228dec52f3957cde42f8774cb2dc298421f7","original_line":1022,"owner":"role-artifact.test.cjs"},
  {"name":"failed late validation rolls back only this attempt and preserves retained history","body_sha256":"ddf67faaea81affba7bc9d0e524d443576563ca2be804876215a319e3716df37","original_line":1032,"owner":"role-artifact.test.cjs"},
  {"name":"trusted bookkeeping updates remain mutable while changed bytes and unknown provenance are refused","body_sha256":"cbbea4fde6f379711435995be13057909540d84794fd82225c931e004bfe270c","original_line":1057,"owner":"role-artifact.test.cjs"},
  {"name":"complete multi-archive Claude legacy admission is atomic and rejects unknown physical members","body_sha256":"14bf7ee726eb4ad2e7bdf4a6cd4e10dc59299d4613679c05988b0f673e5fea44","original_line":1089,"owner":"role-artifact.test.cjs"},
  {"name":"live catalogue lock timeout never invokes a writer or changes retained bytes","body_sha256":"3917fb45804f96e1ac82a9c81b5bbf44355c0441cd24dc95abd6510e6de5ea3a","original_line":1121,"owner":"role-artifact.test.cjs"},
  {"name":"lost catalogue owner before publication refuses new archive bytes and preserves successor lock","body_sha256":"e73606c8282b387204cb5f41afdf18ffb97666e4b3e10920e4c42f3eb3d905cd","original_line":1150,"owner":"role-artifact.test.cjs"},
  {"name":"lost catalogue owner before rollback leaves successor-owned archive files untouched","body_sha256":"e3d95e9ff78a9d3223759d60c20770aacd85d75af91a90d9ab85826b933b8ea9","original_line":1184,"owner":"role-artifact.test.cjs"},
  {"name":"phase-local archive scope: two original current tickets and older source receipts remain complete","body_sha256":"d41b2949b325b8ed26579c6f3ab562e2a8cb8693843df5b8061581c738198814","original_line":1266,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected manifest refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected evidence refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected findings refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: removed entire selected family refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed selected bytes refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed selected mode refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: extra selected member refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: nonregular selected member refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: removed protected selected record refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed protected original receipt refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed protected original pin refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected catalogue refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing protected roster refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: tampered protected roster refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing original recorder record refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: relabelled manifest and removed authority before discovery refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: forged current family refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed actual membership refuses against independent retained membership in review worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected manifest refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected evidence refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected findings refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: removed entire selected family refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed selected bytes refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed selected mode refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: extra selected member refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: nonregular selected member refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: removed protected selected record refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed protected original receipt refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed protected original pin refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing selected catalogue refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing protected roster refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: tampered protected roster refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: missing original recorder record refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: relabelled manifest and removed authority before discovery refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: forged current family refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed actual membership refuses against independent retained membership in another registered worktree","body_sha256":"f5826982f6c8e903a6629c8b870c8945726534f968b8f4be2a4f5e6fc23b607f","original_line":1337,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: foreign volume and unselected families do not affect literal selection in review worktree","body_sha256":"afea111f730ff70037f72bd9f9fcf8282414dae13a9fa036b793f5bb570d2864","original_line":1362,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: foreign volume and unselected families do not affect literal selection in another registered worktree","body_sha256":"afea111f730ff70037f72bd9f9fcf8282414dae13a9fa036b793f5bb570d2864","original_line":1362,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: batch catalogue aggregate identities discover current verdict","body_sha256":"3ff92785a8151782d159ac570aa31a55d0e8a8b2ea866604ce03797c05859042","original_line":1542,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: batch catalogue aggregate identities ticket","body_sha256":"3ff92785a8151782d159ac570aa31a55d0e8a8b2ea866604ce03797c05859042","original_line":1542,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: batch catalogue aggregate identities receipt.ticket","body_sha256":"3ff92785a8151782d159ac570aa31a55d0e8a8b2ea866604ce03797c05859042","original_line":1542,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: batch catalogue aggregate identities runtime_evidence.ticket","body_sha256":"3ff92785a8151782d159ac570aa31a55d0e8a8b2ea866604ce03797c05859042","original_line":1542,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: unselected missing producer is not opened in review worktree","body_sha256":"8915cbdf722311a82711d5486a241a681e42955e1d6e8dcd555cdd35b6adf4ea","original_line":1606,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: unselected missing producer is not opened in another registered worktree","body_sha256":"8915cbdf722311a82711d5486a241a681e42955e1d6e8dcd555cdd35b6adf4ea","original_line":1606,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed catalogue.json during selection refuses in review worktree","body_sha256":"31458c90ffc0d8fca4caf70962d6595c0ec82d17a4303ea4698e9c9f5148b092","original_line":1625,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed hmac.key during selection refuses in review worktree","body_sha256":"31458c90ffc0d8fca4caf70962d6595c0ec82d17a4303ea4698e9c9f5148b092","original_line":1625,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed catalogue.json during selection refuses in another registered worktree","body_sha256":"31458c90ffc0d8fca4caf70962d6595c0ec82d17a4303ea4698e9c9f5148b092","original_line":1625,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: changed hmac.key during selection refuses in another registered worktree","body_sha256":"31458c90ffc0d8fca4caf70962d6595c0ec82d17a4303ea4698e9c9f5148b092","original_line":1625,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: total selected judgment bound precedes all candidate manifests","body_sha256":"d1764ab28f8ae8ce51efdff722b69c38956977a6014674f44df0ae5029a26e34","original_line":1649,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: 10000 registered foreign worktree hints never open archive bodies or authority","body_sha256":"5a57235345d8b3c1c54adf214e8c9dafe4fba227c8cfd829ba5e293a339ac0ec","original_line":1668,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: authenticated empty history differs from missing history","body_sha256":"85f1ce017deecfd17467e2eddddc69729eb41d491261f0e2f60cc8ad1b6ea019","original_line":1711,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: retained inventory cannot invent receipts, pins or roster replacements","body_sha256":"afeaf361ebd65b84696732db4a003fdc5300abed4df7a2b6d5199acd965520cd","original_line":1720,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: independent inventory and authenticated roster retain their 1000 limits","body_sha256":"45f839bbbd2271996ee05f1b962c0c319e38f3ed9df69c4860074aab54b28502","original_line":1736,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase-local archive scope: independently authenticated original record with conflicting receipt ticket refuses","body_sha256":"eeb7b3af05760abee0431ab6b6ca012565023281c5a125fb3e60605abab54637","original_line":1757,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"phase47 original containment recovery preserves a pre-existing deleted tracked parent directory","body_sha256":"03db3d685314bfc9c82487aafe02d79a8497cdd2fa2bc99a49de7fe54dc95721","original_line":1800,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery deleted tracked parent inspection ENOTDIR","body_sha256":"5fb3f6855f012f549dbaf36b23df409ab434c508870f508f373f211e15a362ae","original_line":1824,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery deleted tracked parent inspection EACCES","body_sha256":"5fb3f6855f012f549dbaf36b23df409ab434c508870f508f373f211e15a362ae","original_line":1824,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery deleted tracked parent inspection symlink","body_sha256":"5fb3f6855f012f549dbaf36b23df409ab434c508870f508f373f211e15a362ae","original_line":1824,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery deleted tracked parent inspection file","body_sha256":"5fb3f6855f012f549dbaf36b23df409ab434c508870f508f373f211e15a362ae","original_line":1824,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery deleted tracked parent inspection movement","body_sha256":"5fb3f6855f012f549dbaf36b23df409ab434c508870f508f373f211e15a362ae","original_line":1824,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery preserves an unchanged untracked nested repository directory","body_sha256":"ae407bb510670b553281c8b7e56ab41afe39f3ca00568eac10fb606327967ac4","original_line":1858,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery refuses authenticated legacy directory-only restoration","body_sha256":"c654f08784c878d8de93ca3efeab0db51907a8fc0c046a8d8a5481751957486f","original_line":1882,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery refuses movement during directory inspection","body_sha256":"be0eca9e5f410e0492b4c6bb1f1cd9e7ef73b80e5be956477f7afed817acec5e","original_line":1905,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory symlink","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory unsupported","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory depth","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory entries","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory bytes","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery bounds rooted directory gitPointer","body_sha256":"ae73e59b35663f4df06487d3e6ec2a897e6a971f707110f2688225a08fa3cd75","original_line":1929,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON truncated","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON emptyObject","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON null","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON missingPayload","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON nullPayload","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects malformed protected JSON malformedMac","body_sha256":"6483bc49719f57bc38c7aae453d0c92964ccb5bb9b04154dde534db7abe158fa","original_line":1964,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates initial epoch zero and requires its exact successor","body_sha256":"569be3014b59993f50725875c42598c36c9f4667f275f667c19a2b9cef87ebfe","original_line":1973,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery private token persistence is immutable and restores only authenticated authority","body_sha256":"ea2ee120aed8af4ed2590bb42fc1cdf4b4ec1c89c2a06ca2314df2bc5c275c5f","original_line":1989,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects duplicate serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects escaped serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects absolute serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects repeatedSlash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects interiorSlash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects traversalSlash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects dotSlash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects absoluteSlash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects backslash serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects unsorted serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects missing serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects legacyDirectory serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects badIdentity serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects badStatus serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects wrongHead serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects wrongRoot serialized map","body_sha256":"1d829341a6ab998bff94a519479f8020625efb3bb545bea715574d6f266d1766","original_line":2028,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch run binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch ticket binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch phase binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch dispatch binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch request binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch policy binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch generatedSelection binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch source binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch lease binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch leaseIdentity binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch leaseFile binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch tree binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch launchTime binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery rejects cross-launch reservation binding","body_sha256":"ee1bb2ca53d29856e06227fe3fd9b8447770e703acaf38663dc9604020c04db1","original_line":2053,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected payload","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected mac","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected digest","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected reference","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected missing","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected symlink","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected oversized","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected publicSnapshot","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery authenticates protected otherWorktree","body_sha256":"933d5d61cd2db1e183eeac893f7a4d96ac0a5d759894564043a842872f78fcc3","original_line":2062,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery retains missing original key with baseline only","body_sha256":"817da500b68fbc602b7cf9ed18398d2df4ef80ed90210f48a3b96625307de8d4","original_line":2081,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"phase47 original containment recovery retains missing original key with archive/source records","body_sha256":"817da500b68fbc602b7cf9ed18398d2df4ef80ed90210f48a3b96625307de8d4","original_line":2081,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: missingAuthority","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: missingStore","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: missingKey","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: invalidKey","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: foreignKey","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: symlinkKey","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: symlinkStore","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: symlinkRecord","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: broadKey","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: oversizedRecord","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: tamper","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 readonly original receipt authority refuses without mutation: legacy","body_sha256":"76b5aeaa8fbe8a7ed424d22ccfe1763052ccfc47dd9376cf98bcd33f3d18d732","original_line":2099,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"F2 original durable receipt parity and genuine fresh-process DIRECT Codex validate/read","body_sha256":"2f8b29a7c6e7e324abdb29dcecc56c29e5dd8a7a13f3436f78ab85c885590a36","original_line":2137,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"mixed repository archive scope retains exact selected evidence: null","body_sha256":"bc56a0e075d54d390a4660d9ce1981206d3b47957b6de8ec3cdfe4b371a44a65","original_line":2175,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"mixed repository archive scope retains exact selected evidence: acme/selected","body_sha256":"bc56a0e075d54d390a4660d9ce1981206d3b47957b6de8ec3cdfe4b371a44a65","original_line":2175,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"completed reference authentication rejects caller authority with no filesystem mutation","body_sha256":"98a9be3930dd242fbc27ffd044ca7358674ea77be7f7ba5cacfc2850892e90fc","original_line":2190,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"focused completeness and subject declarations fail closed without consumption inference","body_sha256":"ab053fcacc7828e4b76a9b552918afa04b545a9ecbf0ae347bbfcc5da6e34085","original_line":2232,"owner":"phase53-z29u-role-containment.test.cjs"},
  {"name":"current integration excludes foreign catalogue before authority reads: false","body_sha256":"d2a493c1a2e7a3aa9c8c2a2c764902af3f5b1078091c3d308d1e3c30d030a21a","original_line":2248,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"current integration excludes foreign catalogue before authority reads: true","body_sha256":"d2a493c1a2e7a3aa9c8c2a2c764902af3f5b1078091c3d308d1e3c30d030a21a","original_line":2248,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"aggregate original subject reconciles retained and legacy codex","body_sha256":"3e074c5824116658fc2cf73aa56766deb0f06a37ee21215cde71e8ed2065f094","original_line":2267,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"aggregate original subject reconciles retained and legacy claude","body_sha256":"3e074c5824116658fc2cf73aa56766deb0f06a37ee21215cde71e8ed2065f094","original_line":2267,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"integrator subject round-trips through the producer and every consumer for every repository form","body_sha256":"b0f3a3a3baa4620a6ea9badab947391497b7e493f6b54ad207a32626b933aa65","original_line":2337,"owner":"role-artifact.test.cjs"},
  {"name":"phase subject consumers accept the shared repository class and refuse a semicolon or control character","body_sha256":"d0196c6eec7f00d4635a9290149d50f441bad76b3eeb1627ce92b314a69c98e7","original_line":2381,"owner":"role-artifact.test.cjs"},
  {"name":"role-artifact holds no private subject grammar or home expression","body_sha256":"81d54f2375aad6fa45004c1989a7ff927d18de36511d235fb5cd46d6026e1e5c","original_line":2404,"owner":"role-artifact.test.cjs"},
  {"name":"the Claude semantic transcript falls back through the shared Claude home","body_sha256":"4e0827597744ac2cc64094117a0de7c0ef04a755aa5c498be91bb39e1e467d2e","original_line":2420,"owner":"role-artifact.test.cjs"},
  {"name":"legacy reordered code-review membership reads publicly: incomplete=false","body_sha256":"71fdefdb0cdd962d1f34a69c561d8722db4a783165a8f17b9d031ebc8fddc5c8","original_line":2458,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"legacy reordered code-review membership reads publicly: incomplete=true","body_sha256":"71fdefdb0cdd962d1f34a69c561d8722db4a783165a8f17b9d031ebc8fddc5c8","original_line":2458,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"legacy reordered membership preserves supported result digest form: omitted","body_sha256":"e893bf5a17df5398a3cc17de38340e49fc359fa93fcae29c8875eeb6c6211a65","original_line":2512,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"legacy reordered membership preserves supported result digest form: alias","body_sha256":"e893bf5a17df5398a3cc17de38340e49fc359fa93fcae29c8875eeb6c6211a65","original_line":2512,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: manifest","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: file-index","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: mac","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: receipt","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: digest","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: subject","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"public legacy code-review consumers reject authentic archive tampering: nested-evidence","body_sha256":"d68e62b080642fc175fd608bf1818e8b878a2b055d03803849495876d8c477bb","original_line":2535,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: added","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: deleted","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: member-order","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: row","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: evidence","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: array-order","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: digest","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"fresh code-review sealing rejects changed membership: subject","body_sha256":"7cd1e3f1d165d4ea8dd3996cd8baaf535046c9e5c733ab355bd2f3867c80f3e9","original_line":2573,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"code-review lineage survives real fix-ticket membership changes and keeps reuse exact","body_sha256":"73e7876bab856b7e814d3022b506a552587466131bfbed0339ba0c6a1405d88f","original_line":2593,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed disagreements retain their original target through three rounds and twin ordinal shifts","body_sha256":"2b81f496fdcb8e8b04d37ed17aa80425823efde110a25d1362b3cb200c78ca91","original_line":2642,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"code-review reuse refuses a moved base or reference contract and ticket-form subject","body_sha256":"dfa3e450f59a7d72f989bfa3292a4860152696e465aa871ed0cc4dd6dc31e750","original_line":2703,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"original native architecture authority reads coordinator-only planning on the reviewed epic","body_sha256":"5ab010b9ca12b6c2d2cf2c997909c2ac748484e71ea915fdd93a1ab1f88c3707","original_line":2730,"owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"name":"existing-format sealed foreign pass remains historical without original planning custody","body_sha256":"8e6377297ee670e2c98599694a0d2f16c7dbf1bbe17a3fa2332d7a279596027d","original_line":2787,"owner":"role-artifact.test.cjs"},
  {"name":"sealed foreign current authority refuses config mapping","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses epic membership","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses graph symlink","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses source","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses untracked source","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses head","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses base","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses manifest","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses index","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses receipt","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"sealed foreign current authority refuses mac","body_sha256":"c328423beb717c9a41b44e1fc0b6bdf779bac957d346c16230d2ace0d8869227","original_line":2836,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=false, plan","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=false, config","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=false, transcript","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=true, plan","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=true, config","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"existing-format foreign native input retains original planning pins: partitions=true, transcript","body_sha256":"f44e2b052a322e65891056c76c860b2e00a57ee5e418e354580a5f43376318ed","original_line":2881,"owner":"phase53-z29v-role-code-review.test.cjs"},
  {"name":"compact authentic integration proves native authority and scoped codec/rebuild policy separately from large capacity","body_sha256":"96ba29743010fd2d41acabec218e59d07e786c3cc8cc936662302338be350288","original_line":2906,"owner":"phase53-z29w-role-integration.test.cjs"},
  {"name":"code-review carrier freshness authentic canonical lifecycle on both runtimes and transports","body_sha256":"d42c97a65476282020fbb2ca0470e497d1cdd448249343bb2e1e241e48da8110","original_line":2985,"owner":"phase53-z29v-role-code-review.test.cjs","physical_body_sha256":"c50f8a3a4f529ddea1d3b266e5e9703b9241238507c3e5d4249e6ba46cacb0b6"},
  {"name":"D-32 frozen full inventory, protected unit custody, restart and independent phase authority","body_sha256":"d24a5cad66f7562e55a849d00be1798875131bcc3327f0df0d881dfe01803070","original_line":3372,"owner":"phase53-z29w-role-integration.test.cjs"},
  {"name":"D-32 capacity refuses unknown and over-bound evidence before granting stage admission","body_sha256":"f167cece23e97253a44f2546d833f50335fa7db6c5721a22948e55c26c245a3c","original_line":3591,"owner":"phase53-z29w-role-integration.test.cjs"},
  {"name":"D-32 Claude admits independent behavior-only non-model evidence and retains native unit/final custody","body_sha256":"646d01f26cd33546548b6f2d5042cb4e757535c3a0e4054627dc9bec665b66ac","original_line":3671,"owner":"phase53-z29w-role-integration.test.cjs"},
  {"name":"D-32 authentic incomplete unit cannot supply aggregate authority","body_sha256":"a9a12852651b567242f80045378aebb01bc342b4ea68ff9c8a829a523872fd69","original_line":3729,"owner":"phase53-z29w-role-integration.test.cjs"},
  {"name":"D-32 authentic needs-fix unit cannot supply aggregate authority","body_sha256":"a9a12852651b567242f80045378aebb01bc342b4ea68ff9c8a829a523872fd69","original_line":3729,"owner":"phase53-z29w-role-integration.test.cjs"},
]);
const CARRIER_LOADING_SUBSTITUTION = Object.freeze({
  original_start_line: 2987,
  original_end_line: 2988,
  original_sha256: '181abe51b0ebd20bd3f4d04ad665c937937c3018211a5406b94ec8beb8e3d958',
  physical_sha256: "f472ab19f89bb65ae11a436c7d753905511a32f2ec0aef45a4332dd2985267dd",
});

function originalRoleOwners() {
  return [
    ['role-artifact.test.cjs', require('./role-artifact.test.cjs')],
    ['phase53-z29t-role-architecture-archives.test.cjs', require('./phase53-z29t-role-architecture-archives.test.cjs')],
    ['phase53-z29u-role-containment.test.cjs', require('./phase53-z29u-role-containment.test.cjs')],
    ['phase53-z29v-role-code-review.test.cjs', require('./phase53-z29v-role-code-review.test.cjs')],
    ['phase53-z29w-role-integration.test.cjs', module.exports],
  ];
}

function collectOriginalRoleCases(context) {
  const rows = [];
  for (const [owner, physical] of originalRoleOwners())
    physical.registerRoleArtifacts((name, callback) => rows.push({ owner, name, callback }), context);
  return rows;
}

function verifyOriginalRoleUnion(original, sources, cases, helperSource = require('node:fs').readFileSync(
  require('node:path').join(__dirname, 'helpers/phase53-role-artifact-fixture.cjs'), 'utf8')) {
  const assert = require('node:assert/strict');
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  assert.equal(Buffer.byteLength(original), ORIGINAL_SOURCE.bytes);
  assert.equal(hash(original), ORIGINAL_SOURCE.sha256);
  assert.equal(hash(original.slice(0, 3833)), 'bd3996d556dbf1f59e5b4e8f496e8d0bebaec297f1335322f81e757f64f8511c');
  assert.equal(hash(original.slice(343822)), '3a8b2ed598e035fa33640409d948ba2de19401cab0f223f531f0ff077b5e80a9');
  const ranges = [...ORIGINAL_DECLARATIONS, ...ORIGINAL_DEFINITIONS, ...ORIGINAL_SUITES]
    .sort((a, b) => a.start - b.start);
  let cursor = 3833;
  for (const row of ranges) {
    assert.ok(row.start >= cursor, 'overlapping original source identity');
    assert.equal(original.slice(cursor, row.start).trim(), '', 'unaccounted executable original source');
    assert.equal(hash(original.slice(row.start, row.end)), row.sha256);
    cursor = row.end;
  }
  assert.equal(cursor, 343822, 'complete original source inventory boundary');
  const owners = originalRoleOwners().map(([owner]) => owner);
  assert.deepEqual(Object.keys(sources).sort(), [...owners].sort());
  const definitions = { ...sources, 'helpers/phase53-role-artifact-fixture.cjs': helperSource };
  for (const row of ORIGINAL_DEFINITIONS) {
    let declaration = original.slice(row.start, row.end);
    assert.equal(hash(declaration), row.sha256, 'immutable definition at ' + row.line);
    if (row.line === 76) {
      declaration = 'const ROLE_ARTIFACT = ' + "path.join(scriptsDir, 'role-artifact.cjs');";
      assert.equal(hash(declaration), row.physical_sha256);
    }
    for (const [owner, text] of Object.entries(definitions))
      assert.equal(text.split(declaration).length - 1, Number(owner === row.owner),
        owner + ' original definition at ' + row.line);
  }
  for (const row of ORIGINAL_DECLARATIONS) {
    let declaration = original.slice(row.start, row.end);
    assert.equal(hash(declaration), row.sha256, 'immutable declaration at ' + row.line);
    if (row.line === 2985) {
      const prior = original.split('\n').slice(CARRIER_LOADING_SUBSTITUTION.original_start_line - 1,
        CARRIER_LOADING_SUBSTITUTION.original_end_line).join('\n');
      const source = sources[row.owner];
      const start = source.indexOf('    const child = spawnSync(');
      assert.ok(start >= 0);
      assert.equal(source.indexOf('    const child = spawnSync(', start + 1), -1);
      const end = source.indexOf('      env: { ...process.env, SHIPYARD_CARRIER_FRESHNESS_CHILD:', start);
      assert.ok(end > start);
      const bridge = source.slice(start, end - 1);
      assert.equal(hash(prior), CARRIER_LOADING_SUBSTITUTION.original_sha256);
      assert.equal(hash(bridge), CARRIER_LOADING_SUBSTITUTION.physical_sha256);
      declaration = declaration.replace(prior, bridge);
    }
    for (const owner of owners)
      assert.equal(sources[owner].split(declaration).length - 1, Number(owner === row.owner),
        owner + ' whole original declaration at ' + row.line);
  }
  assert.equal(cases.length, ORIGINAL_CASES.length);
  assert.equal(new Set(cases.map(row => row.name)).size, cases.length, 'duplicate expanded original');
  for (const owner of owners) assert.ok(cases.some(row => row.owner === owner), 'empty physical owner: ' + owner);
  for (const expected of ORIGINAL_CASES) {
    const row = cases.find(row => row.name === expected.name);
    assert.ok(row, 'missing expanded original: ' + expected.name);
    assert.equal(row.owner, expected.owner, 'foreign original allocation: ' + expected.name);
    assert.equal(hash(row.callback.toString()), expected.physical_body_sha256 || expected.body_sha256,
      'original assertion body: ' + expected.name);
  }
}

function registerLayoutChecks(test, context) {
  const { assert, fs, path, os, execFileSync } = context;
  const root = path.resolve(context.unitDir, '../..');
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');

  test('role physical union authenticates immutable original declarations, parameters and expanded assertion bodies', () => {
    const original = execFileSync('git', ['show', ORIGINAL_SOURCE.commit + ':' + ORIGINAL_SOURCE.path],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const sources = Object.fromEntries(originalRoleOwners().map(([owner]) =>
      [owner, fs.readFileSync(path.join(context.unitDir, owner), 'utf8')]));
    const cases = collectOriginalRoleCases(context);
    verifyOriginalRoleUnion(original, sources, cases);
    const helperSource = fs.readFileSync(path.join(context.unitDir, 'helpers/phase53-role-artifact-fixture.cjs'), 'utf8');
    assert.throws(() => verifyOriginalRoleUnion(original, sources, cases,
      helperSource.replace('return testTranscriptEvidence(value);', 'return value;')));
    for (const altered of [cases.slice(1), [...cases, cases[0]],
      cases.map((row, index) => index ? row : { ...row, name: 'foreign original' }),
      cases.map((row, index) => index ? row : { ...row, callback() {} }),
      cases.filter(row => row.owner !== 'phase53-z29u-role-containment.test.cjs')])
      assert.throws(() => verifyOriginalRoleUnion(original, sources, altered));
    const architecture = 'phase53-z29t-role-architecture-archives.test.cjs';
    for (const [before, after] of [
      ["['codex', 'claude']", "['codex']"],
      ["assert.equal(value.prepared.packet.planning_reference.root, f.root);", 'assert.ok(true);'],
    ]) {
      assert.ok(sources[architecture].includes(before));
      assert.throws(() => verifyOriginalRoleUnion(original,
        { ...sources, [architecture]: sources[architecture].replace(before, after) }, cases));
    }
  });

  test('role imports and explicit registrations are inert with original unit and script roots', () => {
    const Module = require('node:module');
    const files = [path.join(context.unitDir, 'helpers/phase53-role-artifact-fixture.cjs'),
      ...originalRoleOwners().map(([owner]) => path.join(context.unitDir, owner))];
    const cached = files.map(file => [file, require.cache[file]]);
    const saved = { homedir: os.homedir, env: { ...process.env }, load: Module._load,
      exit: process.listeners('exit'), beforeExit: process.listeners('beforeExit') };
    const calls = [];
    const patches = [
      [fs, 'mkdtempSync'], [fs, 'mkdirSync'], [fs, 'writeFileSync'], [fs, 'rmSync'],
      [require('node:child_process'), 'execFileSync'], [require('node:child_process'), 'spawnSync'],
    ].map(([object, key]) => [object, key, object[key]]);
    try {
      for (const [object, key] of patches) object[key] = () => { calls.push(key); throw new Error('inert import invoked ' + key); };
      for (const file of files) delete require.cache[file];
      const fixture = require(files[0]);
      assert.equal(typeof fixture.createRoleArtifactFixture, 'function');
      for (const file of files.slice(1)) {
        const physical = require(file);
        const names = [];
        physical.registerRoleArtifacts(name => names.push(name), context);
        assert.ok(names.length > 0);
      }
      assert.deepEqual(calls, []);
      assert.equal(Module._load, saved.load);
      assert.equal(os.homedir, saved.homedir);
      assert.deepEqual({ ...process.env }, saved.env);
      assert.deepEqual(process.listeners('exit'), saved.exit);
      assert.deepEqual(process.listeners('beforeExit'), saved.beforeExit);
    } finally {
      for (const [object, key, value] of patches) object[key] = value;
      for (const [file, value] of cached) { if (value) require.cache[file] = value; else delete require.cache[file]; }
    }
    assert.equal(context.ROLE_ARTIFACT, path.join(context.scriptsDir, 'role-artifact.cjs'));
    assert.equal(context.unitDir, __dirname);
    assert.throws(() => createRoleArtifactFixture({ ...context, scriptsDir: path.join(os.tmpdir(), 'foreign-scripts') }),
      /explicit unit root/);
  });

  test('role runner queue preserves rejection and restores only its owned nested resources', async () => {
    const Module = require('node:module');
    const events = require('node:events');
    const marker = 'SHIPYARD_ROLE_LAYOUT_ABSENT';
    const present = 'SHIPYARD_ROLE_LAYOUT_PRESENT';
    const before = { env: { ...process.env }, homedir: os.homedir, load: Module._load,
      read: fs.readFileSync, emit: events.EventEmitter.prototype.emit, exit: process.listeners('exit') };
    const first = createRoleArtifactLifecycle(), second = createRoleArtifactLifecycle();
    const idle = { env: { ...process.env }, homedir: os.homedir, exit: process.listeners('exit') };
    assert.deepEqual({ ...process.env }, idle.env);
    assert.equal(os.homedir, idle.homedir);
    assert.deepEqual(process.listeners('exit'), idle.exit);
    let firstHome, firstBin, secondHome, secondBin;
    const order = [], failure = new Error('original queue failure');
    try {
      delete process.env[marker]; process.env[present] = 'present';
      first.start(); firstHome = os.homedir(); firstBin = first.targetBin;
      const firstPath = process.env.PATH;
      second.start(); secondHome = os.homedir(); secondBin = second.targetBin;
      assert.notEqual(firstHome, secondHome); assert.notEqual(firstBin, secondBin);
      assert.throws(() => second.start(), /already started/);
      const rejected = second.run(async () => {
        order.push('start'); await Promise.resolve(); order.push('reject');
        process.env[marker] = 'new'; delete process.env[present];
        Module._load = function(...args) { return before.load.apply(this, args); };
        fs.readFileSync = function(...args) { return before.read.apply(this, args); };
        events.EventEmitter.prototype.emit = function(...args) { return before.emit.apply(this, args); };
        os.homedir = () => '/foreign-patch';
        throw failure;
      });
      const next = second.run(() => {
        order.push('next');
        assert.equal(os.homedir(), secondHome);
        assert.equal(process.env[present], 'present');
        assert.equal(Object.hasOwn(process.env, marker), false);
        assert.equal(Module._load, before.load); assert.equal(fs.readFileSync, before.read);
        assert.equal(events.EventEmitter.prototype.emit, before.emit);
        return 42;
      });
      await assert.rejects(rejected, error => error === failure);
      assert.equal(await next, 42); await second.settle();
      assert.deepEqual(order, ['start', 'reject', 'next']);
      second.cleanup(); second.cleanup();
      assert.equal(os.homedir(), firstHome); assert.equal(process.env.PATH, firstPath);
      assert.equal(process.env[present], 'present'); assert.equal(Object.hasOwn(process.env, marker), false);
      assert.equal(Module._load, before.load); assert.equal(fs.readFileSync, before.read);
      assert.equal(events.EventEmitter.prototype.emit, before.emit);
      assert.ok(fs.existsSync(firstHome)); assert.ok(fs.existsSync(firstBin));
      assert.equal(fs.existsSync(secondHome), false); assert.equal(fs.existsSync(secondBin), false);
      first.cleanup();
      assert.equal(fs.existsSync(firstHome), false); assert.equal(fs.existsSync(firstBin), false);
    } finally {
      second.cleanup(); first.cleanup();
      for (const key of Object.keys(process.env)) if (!Object.hasOwn(before.env, key)) delete process.env[key];
      Object.assign(process.env, before.env);
    }
    assert.equal(os.homedir, before.homedir); assert.equal(Module._load, before.load);
    assert.deepEqual(process.listeners('exit'), before.exit);
    assert.deepEqual({ ...process.env }, before.env);
  });

  registerDiscoveryCheck(test, context);
  registerPackageCheck(test, context);
}

const ROLE_FILES = Object.freeze([
  'phase53-z29t-role-architecture-archives.test.cjs',
  'phase53-z29u-role-containment.test.cjs',
  'phase53-z29v-role-code-review.test.cjs',
  'phase53-z29w-role-integration.test.cjs',
]);
const FUTURE_FILES = Object.freeze([
  ['phase53-z29a-fixer-original-custody.test.cjs', 'phase53-z29b-fixer-source-history.test.cjs',
    'phase53-z29c-historical-direct.test.cjs', 'phase53-z29d-historical-admitted.test.cjs',
    'phase53-z29e-historical-pending.test.cjs', 'phase53-z29f-historical-action-repeat.test.cjs',
    'phase53-z29g-historical-action-covered.test.cjs'],
  ['phase53-z29h-publication-unsent-recovery.test.cjs', 'phase53-z29i-recorded-integration-compatibility.test.cjs'],
  ['phase53-z29x-native-ci-fix-contract.test.cjs', 'phase53-z29y-native-ci-fix-recovery.test.cjs',
    'phase53-z29z-generated-base-merge.test.cjs'],
  ['phase53-z30-semantic-material-retention.test.cjs', 'phase53-z30b-semantic-material-retention.test.cjs',
    'phase53-z30c-semantic-material-retention.test.cjs', 'phase53-z30d-semantic-material-retention.test.cjs',
    'phase53-z30e-semantic-material-retention.test.cjs', 'phase53-z30f-semantic-material-retention.test.cjs'],
]);

function registerDiscoveryCheck(test, context) {
  test('role physical discovery preserves manifest16 and full current and future selector rosters', () => {
    const { assert, fs, path, os, execFileSync } = context;
    const root = path.resolve(context.unitDir, '../..');
    const discovery = require('./shard-files.cjs');
    const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
    const readOriginal = relative => execFileSync('git', ['show', ORIGINAL_SOURCE.commit + ':' + relative], { cwd: root });
    const bytes = readOriginal('tests/unit/shard-manifest.json');
    assert.equal(hash(bytes), '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
    assert.deepEqual(fs.readFileSync(path.join(context.unitDir, 'shard-manifest.json')), bytes);
    const manifest = discovery.readManifest();
    assert.equal(manifest.shards.length, 16);
    const originalFiles = execFileSync('git', ['ls-tree', '--name-only', ORIGINAL_SOURCE.commit + ':tests/unit'],
      { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(name => name.endsWith('.test.cjs')).sort();
    const original = discovery.appendShard(manifest, discovery.unitTasks(originalFiles));
    assert.equal(original.shards.length, 51);
    assert.equal(hash(JSON.stringify(original.shards.slice(0, 50))),
      'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
    assert.equal(hash(JSON.stringify(original.shards)), '60c650ac485c9878df28211048eb8b938d8bccf0539858b0f7c25c5dc85fa7f3');
    assert.deepEqual(original.shards[50], ['phase53-z29-semantic-final-catalog-duplication.test.cjs']);
    const roleRoster = { ...original, shards: [...original.shards, ...ROLE_FILES.map(file => [file])] };
    const currentFiles = discovery.unitFiles();
    const inserted = currentFiles.filter(file => !originalFiles.includes(file) && !ROLE_FILES.includes(file));
    assert.ok(inserted.every(file => FUTURE_FILES.flat().includes(file)), 'foreign physical insertion');
    for (const group of FUTURE_FILES)
      assert.ok(group.every(file => inserted.includes(file)) || group.every(file => !inserted.includes(file)),
        'partial future physical owner group');
    const actual = discovery.appendShard(manifest, discovery.unitTasks(currentFiles));
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.deepEqual([...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([a-z][a-z-]+):$/gm)].map(match => match[1]),
      ['shards', 'unit', 'rest', 'test-fast']);
    assert.deepEqual(currentFiles, [...originalFiles, ...ROLE_FILES, ...inserted].sort());
    assert.deepEqual(actual.shards, [...original.shards,
      ...[...ROLE_FILES, ...inserted].sort().map(file => [file])]);
    assert.deepEqual(actual.shards.filter(row => !inserted.includes(row[0])), roleRoster.shards);
    assert.equal(actual.shards.length, 55 + inserted.length);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'role-discovery-'));
    try {
      function exercise(files, expected, unitCount, ciCount) {
        const directory = path.join(temporary, String(unitCount)); fs.mkdirSync(directory);
        for (const name of files) fs.writeFileSync(path.join(directory, name), '');
        const tasks = discovery.unitTasks(discovery.unitFiles(directory));
        const observed = discovery.appendShard(manifest, tasks);
        assert.deepEqual(observed.shards, expected.shards);
        assert.equal(observed.shards.length, unitCount);
        assert.equal(observed.shards.length + 3, ciCount);
        const selected = [];
        for (let index = 1; index <= unitCount; index++) {
          const row = discovery.selectTaskShard(index + '/' + unitCount, directory, manifest);
          assert.deepEqual(row, expected.shards[index - 1]); selected.push(...row);
        }
        assert.deepEqual(selected.sort(), [...tasks].sort());
        assert.equal(new Set(selected).size, tasks.length);
        const next = 'zz-phase53-next.test.cjs'; fs.writeFileSync(path.join(directory, next), '');
        const extended = discovery.appendShard(manifest, discovery.unitTasks(discovery.unitFiles(directory)));
        assert.deepEqual(extended.shards, [...expected.shards, [next]]);
        for (let index = 1; index <= unitCount + 1; index++)
          assert.deepEqual(discovery.selectTaskShard(index + '/' + (unitCount + 1), directory, manifest),
            extended.shards[index - 1]);
        assert.throws(() => discovery.selectTaskShard('1/' + unitCount, directory, manifest), /shard count/);
      }
      const counts = [[55, 58], [62, 65], [64, 67], [67, 70], [73, 76]];
      let additions = [...ROLE_FILES];
      for (let stage = 0; stage < counts.length; stage++) {
        if (stage) additions.push(...FUTURE_FILES[stage - 1]);
        const expected = { ...original, shards: [...original.shards, ...[...additions].sort().map(file => [file])] };
        assert.deepEqual(expected.shards.slice(0, 51), original.shards);
        if (stage >= 1) assert.deepEqual(expected.shards.slice(51, 58), FUTURE_FILES[0].map(file => [file]));
        if (stage >= 2) assert.deepEqual(expected.shards.slice(51, 60), [...FUTURE_FILES[0], ...FUTURE_FILES[1]].map(file => [file]));
        const positions = additions.map(file => [file, expected.shards.findIndex(row => row[0] === file)]);
        for (const [file, position] of positions) {
          if (file.startsWith('phase53-z29x') || file.startsWith('phase53-z30'))
            assert.ok(position > expected.shards.findIndex(row => row[0] === ROLE_FILES[3]));
        }
        exercise([...originalFiles, ...additions], expected, ...counts[stage]);
      }
      for (let index = 1; index <= actual.shards.length; index++)
        assert.deepEqual(discovery.selectTaskShard(index + '/' + actual.shards.length), actual.shards[index - 1]);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}

function registerPackageCheck(test, context) {
  test('role layout excludes all seven owners from complete immutable-source package and cold consumers', async () => {
    const { assert, fs, path, os, execFileSync, spawnSync } = context;
    const crypto = require('node:crypto');
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const root = path.resolve(context.unitDir, '../..');
    const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-package-parity-')));
    const baselineRoot = path.join(temporary, 'source');
    function inventory(directory, prefix = '') {
      return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
          const relative = prefix + entry.name, filename = path.join(directory, relative);
          const stat = fs.lstatSync(filename);
          assert.equal(stat.isSymbolicLink(), false, relative);
          const row = { path: relative, type: entry.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777 };
          return entry.isDirectory() ? [row, ...inventory(directory, relative + '/')]
            : [{ ...row, bytes: stat.size, sha256: hash(fs.readFileSync(filename)) }];
        });
    }
    let native;
    try {
      const builderPath = 'scripts/package-shipyard-codex.cjs';
      const builderBytes = execFileSync('git', ['show', ORIGINAL_SOURCE.commit + ':' + builderPath], { cwd: root });
      assert.deepEqual(fs.readFileSync(path.join(root, builderPath)), builderBytes);
      const scriptList = /const scripts = \[([\s\S]*?)\];/.exec(builderBytes.toString());
      assert.ok(scriptList);
      const scripts = JSON.parse('[' + scriptList[1].replace(/'/g, '"') + ']');
      const roots = ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'];
      const supported = [builderPath, ...scripts.map(file => 'scripts/' + file), ...roots];
      const tree = execFileSync('git', ['ls-tree', '-rz', '--full-tree', ORIGINAL_SOURCE.commit, '--', ...supported],
        { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
        .filter(row => !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(row));
      const entries = tree.map(row => {
        const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(row);
        assert.ok(match, 'non-file original package input: ' + row);
        return { mode: parseInt(match[1], 8) & 0o777, oid: match[2], path: match[3] };
      });
      const blobStream = execFileSync('git', ['cat-file', '--batch'], { cwd: root,
        input: entries.map(row => row.oid).join('\n') + '\n', maxBuffer: 8 * 1024 * 1024 });
      let cursor = 0;
      for (const row of entries) {
        const end = blobStream.indexOf(10, cursor);
        const header = blobStream.subarray(cursor, end).toString().split(' ');
        assert.equal(header[0], row.oid); assert.equal(header[1], 'blob');
        const size = Number(header[2]), bytes = blobStream.subarray(end + 1, end + 1 + size);
        const filename = path.join(baselineRoot, row.path);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, bytes, { mode: row.mode }); fs.chmodSync(filename, row.mode);
        cursor = end + 1 + size + 1;
      }
      assert.equal(cursor, blobStream.length);
      const sourceInventory = directory => [builderPath, ...scripts.map(file => 'scripts/' + file)]
        .map(relative => {
          const file = path.join(directory, relative), stat = fs.lstatSync(file);
          assert.ok(stat.isFile());
          return { path: relative, type: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: hash(fs.readFileSync(file)) };
        }).concat(...roots.map(relative => inventory(path.join(directory, relative))
          .filter(row => !/\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(row.path))
          .map(row => ({ ...row, path: relative + '/' + row.path }))))
        .sort((a, b) => a.path.localeCompare(b.path));
      const originalInputs = sourceInventory(baselineRoot);
      assert.deepEqual(sourceInventory(root), originalInputs, 'complete supported package inputs changed');
      const owners = ['tests/unit/role-artifact.test.cjs', 'tests/unit/helpers/phase53-role-artifact-fixture.cjs',
        ...ROLE_FILES.map(file => 'tests/unit/' + file), 'tests/unit/phase49-package-publication.test.cjs'];
      assert.equal(owners.length, 7);
      for (const owner of owners) assert.equal(originalInputs.some(row => row.path === owner), false);
      const expectedRoot = require(path.join(baselineRoot, builderPath)).build(path.join(temporary, 'baseline'));
      const candidate = require('../../scripts/package-shipyard-codex.cjs').build(path.join(temporary, 'candidate'));
      const expected = inventory(expectedRoot);
      assert.deepEqual(inventory(candidate), expected, 'whole package paths/types/modes/bytes differ');
      const manifestBytes = fs.readFileSync(path.join(expectedRoot, '.codex-plugin/plugin.json'));
      const manifest = JSON.parse(manifestBytes);
      const metadata = JSON.parse(fs.readFileSync(path.join(expectedRoot, 'package-build.json')));
      const payload = crypto.createHash('sha256');
      for (const row of expected.filter(row => row.type === 'file' &&
        !['.codex-plugin/plugin.json', 'package-build.json'].includes(row.path))) {
        payload.update(row.path + '\0'); payload.update(fs.readFileSync(path.join(expectedRoot, row.path)));
      }
      const sourceDigest = payload.digest('hex');
      const version = JSON.parse(fs.readFileSync(path.join(baselineRoot,
        'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version;
      assert.equal(manifest.version, version + '+codex.' + sourceDigest.slice(0, 16));
      assert.equal(metadata.version, manifest.version);
      assert.equal(metadata.digest, hash(Buffer.concat([Buffer.from(sourceDigest + '\0'), manifestBytes])));
      for (const identity of ['.codex-plugin/plugin.json', 'package-build.json'])
        assert.deepEqual(fs.readFileSync(path.join(candidate, identity)), fs.readFileSync(path.join(expectedRoot, identity)));
      const binding = { outputs: expected.filter(row => row.type === 'file').map(row => ({
        path: row.path, bytes: row.bytes, sha256: row.sha256, publication_mode: row.mode })),
        source_content_sha256: sourceDigest, package_sha256: metadata.digest, version: metadata.version };
      const fixtureAPI = context.codexJudgmentFixtures;
      native = fixtureAPI.fixture();
      const sealed = await fixtureAPI.unitJudgment(native);
      const input = { ...sealed.validationInput, recorder: undefined, io: undefined,
        store: path.join(native.storage, 'receipts'), fixturePr: native.pr, binding,
        source: baselineRoot, inputs: originalInputs.filter(row => row.type === 'file'),
        package: candidate, acceptance: path.join(root, 'tests/smoke/phase47-runtime-acceptance.cjs') };
      const inputFile = path.join(temporary, 'cold-input.json'); fs.writeFileSync(inputFile, JSON.stringify(input));
      const cold = `
        const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
        const crypto = require('node:crypto'), cp = require('node:child_process');
        const input = JSON.parse(fs.readFileSync(process.argv[1]));
        for (const row of input.inputs) {
          const file = path.join(input.source, row.path), stat = fs.lstatSync(file);
          assert.ok(stat.isFile()); assert.equal(stat.mode & 0o777, row.mode);
          const bytes = fs.readFileSync(file); assert.equal(bytes.length, row.bytes);
          assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256);
        }
        require(input.acceptance).comparePackage(input.package, input.binding);
        const scripts = path.join(input.package, 'host/plugins/delivery-pipeline/scripts');
        input.recorder = require(path.join(scripts, 'dispatch-boundary.cjs')).createDurableRecorder(input.store);
        input.io = { execFileSync(executable, args, options) {
          if (executable === 'gh') return JSON.stringify(input.fixturePr);
          if (executable === 'git' && args.includes('fetch')) return '';
          return cp.execFileSync(executable, args, options);
        } };
        const role = require(path.join(scripts, 'role-artifact.cjs'));
        assert.equal(role.validateJudgmentManifest(input).envelope.verdict, 'conform');
        assert.equal(role.read(input).envelope.verdict, 'conform');
        assert.equal(role.currentArchitectureVerdict({ worktreePath: input.worktreePath,
          pr: input.fixturePr.number, head: input.fixturePr.headRefOid, baseName: input.fixturePr.baseRefName,
          baseCommit: input.fixturePr.baseRefOid, headBranch: input.fixturePr.headRefName,
          graphDir: path.join(input.worktreePath, '.planning/graph'), io: input.io })?.dispatch_id, input.dispatchId);
        process.stdout.write('role-cold-package-pass');
      `;
      const runCold = () => spawnSync(process.execPath, [...context.testAuthorityArgs, '-e', cold, inputFile],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      const passing = () => {
        const observed = runCold(); assert.equal(observed.status, 0, observed.stdout + observed.stderr);
        assert.equal(observed.stdout, 'role-cold-package-pass');
      };
      passing();
      for (const file of [path.join(baselineRoot, 'plugins/delivery-pipeline/scripts/role-artifact.cjs'),
        path.join(candidate, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs'),
        path.join(candidate, '.codex-plugin/plugin.json'), path.join(candidate, 'package-build.json')]) {
        const bytes = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
        try {
          fs.appendFileSync(file, '\n');
          const observed = runCold(); assert.equal(observed.status, 1, observed.stdout + observed.stderr);
          assert.match(observed.stderr, /AssertionError|mismatch/);
        } finally { fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); }
        assert.deepEqual(fs.readFileSync(file), bytes); passing();
      }
      assert.deepEqual(inventory(candidate), expected);
      assert.deepEqual(sourceInventory(baselineRoot), originalInputs);
      assert.deepEqual(sourceInventory(root), originalInputs);
    } finally {
      if (native) context.codexJudgmentFixtures.cleanupJudgment(native);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

module.exports.verifyOriginalRoleUnion = verifyOriginalRoleUnion;
module.exports.collectOriginalRoleCases = collectOriginalRoleCases;

const ORIGINAL_DEFINITIONS = Object.freeze([
  {"line":61,"start":3833,"end":3926,"sha256":"e54a6dff2d323fd5ca6edf20febec8ee4ca3e27b3659661877b7f6ae8479a564","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":62,"start":3927,"end":4042,"sha256":"4bc74497fc2462167494e4b53ae153378b99b46683a5f136c46fa72d288c05dd","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":65,"start":4043,"end":4179,"sha256":"ee275f9c565e4dd9cc5a961e413dd5814f4659d67c139496ae81156402b7ae2e","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":69,"start":4180,"end":4298,"sha256":"8c8283acc6b83309c7b019d0b3e50ba214b23e97c2c04a45f9e274e0d776d880","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":72,"start":4299,"end":4402,"sha256":"938e08c0dfdaab5db3e4f2a6a4e5e14269c41ace3255faf44df74a22c5860e0e","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":76,"start":4404,"end":4515,"sha256":"a7c0a7fc59ac9a6887d72526b9b7353e6b35666cd62917355e83cef907a04be0","physical_sha256":"ca1876f3454025ecbae545c389ef3393d5dcb023bcfa4a34490b7ff7e2854ea5","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":80,"start":4516,"end":4560,"sha256":"0138a62604f7068d4c06c4bbd92baab584e6cb837118921eda15dacdfed6c108","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":82,"start":4562,"end":4731,"sha256":"854357e95e4513db0711f2eee982b7bfe21b5c137a5742c7dcbdbae07f078fcb","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":89,"start":4733,"end":4811,"sha256":"ae343237a610cc4285040009e6883981891a5c8cab8cffc221d6b1c5536a1079","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":93,"start":4813,"end":4923,"sha256":"b3ab770556ec6976aea82fe47154431a3e31f6936f3a5aed1a3eaa6e9f7a74dd","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":97,"start":4925,"end":5015,"sha256":"42d98eb9fe52be28844c6f1535be0c430306a59d3f6015f09a8038884071bf78","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":99,"start":5017,"end":5252,"sha256":"8b79373ae44cf2017ca702ea249a5c1ea8e7cef25c0d6bb54ed0aab442e77b8f","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":105,"start":5254,"end":8183,"sha256":"36d51fdf9a4faf32805a7ecec50dd0658fd9c0f6635de6d5a5b0d33c0dba55da","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":182,"start":8185,"end":8447,"sha256":"a7bb4108d46b6935a8c5fdf87fc870fdae9fce5c8feb966c2bc8c710b122f7a9","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":193,"start":8449,"end":8533,"sha256":"15a9812d04636f523be85281dd6fb8c30d339ac201e88ee03ae925cfbadddd29","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":197,"start":8535,"end":9360,"sha256":"b70962a76fc2fba21bd02e9d6966653b5e9a41e9820671af12a95c6487f9945d","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":223,"start":9362,"end":10605,"sha256":"0b209cd193df759768d5ac3f828ad3bacb2e8272f3b85ab45f49d3f06d0d40a4","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":250,"start":10607,"end":11064,"sha256":"a031661f730583350ea44bd5ae2b643da287995c99530f7e0f9a6cea9b07a195","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":267,"start":11066,"end":11591,"sha256":"fe91fa10360fd44da13c9575d3e5a02cf7ffca8884d9ff7845e1e7d743e64616","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":284,"start":11593,"end":11709,"sha256":"c3d78444ab3c134f2b5621e31dc5685bd2d50787c27dcf4930a9c4b1b2214814","owner":"role-artifact.test.cjs"},
  {"line":803,"start":34719,"end":34801,"sha256":"e971f37f399c1c1834fa7603b2120e3522d2eab64c7fb5556c3a57fd78b83e82","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":1219,"start":59658,"end":62670,"sha256":"da4a701a3984da07efd288da4b0511f448c4d2525f73a885ae761f7b2a4f04bd","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":1261,"start":62672,"end":62802,"sha256":"a8c09a84b1523923afb33ece661de52853c4636d4703639b36e991f2a5496ba3","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":1289,"start":64462,"end":64945,"sha256":"d9a4f3e1a21902d2156faad542f59bf2f7599e34bedff1695364d6db1594b2ad","owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"line":1298,"start":64947,"end":65246,"sha256":"f334d616ec218893aa2c3bc94da41468be343495f5cde816ba434dae2b56a4fc","owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"line":1347,"start":69072,"end":69721,"sha256":"9028812580bb33f995b08aaa23ea17e7cf991542c8e5fa0a5ba35c2cd3c366f4","owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"line":1395,"start":71546,"end":73539,"sha256":"8624954326bd762db43a753007c76cadae8444f488182b6e0c38e38357a35857","owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"line":1426,"start":73541,"end":81612,"sha256":"a1c78d99d2d9ad75ec39e0ff46243246758114a28e1a269151363600eecfe744","owner":"phase53-z29t-role-architecture-archives.test.cjs"},
  {"line":1776,"start":95511,"end":97333,"sha256":"ea0b20070a35c42de30ec98f1f964393418c963b0dbef2b31f424c0ea7f0c932","owner":"phase53-z29u-role-containment.test.cjs"},
  {"line":2328,"start":129991,"end":130388,"sha256":"5ba4b6a337842ef7d5434750cbd7f11f322e0950320e48fe88fcf04c3d856e6d","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":2441,"start":137526,"end":137720,"sha256":"9f719353f335ded1167935f4ebe60e32dfa0ea31b7900ccef5080fa0e64bf7f9","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":2445,"start":137722,"end":137860,"sha256":"e1cf61d0c57a0f336c4ebf49b20695426c0f63a206dbbabddd7b76e6e5d9895c","owner":"phase53-z29v-role-code-review.test.cjs"},
  {"line":2451,"start":137862,"end":138140,"sha256":"9d7d81306f0164a916aaa7d8df861070393ac4b5846cd365fd04a64c8cf5a2d3","owner":"phase53-z29v-role-code-review.test.cjs"},
  {"line":2757,"start":159403,"end":161635,"sha256":"53ddddf9ae0e50bc874099c8576e075b0afd49b2736b14594f2bd8e464cf7f40","owner":"helpers/phase53-role-artifact-fixture.cjs"},
  {"line":3108,"start":292930,"end":293719,"sha256":"cdb21ce0ea2d2cfdc33703ca12684c19219564aaddd6ee9e53898240811eddc2","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3124,"start":293720,"end":294160,"sha256":"b6c971df4c124b61a9811af0e3416790d3b0ff7e2419fff343ad6515350d51d1","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3130,"start":294161,"end":295510,"sha256":"2a1b2d5694041758b61788e0d49ee8903283aa5dcfbb99d637786469d326fc16","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3147,"start":295511,"end":300611,"sha256":"849fd155ec4250880dc95634748502c426a5385f87bddde5f05ebe50b3066789","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3215,"start":300612,"end":305155,"sha256":"d3f3c45039114a770cde6644be6caed3433067e06ffbe61860a3b2ea94c7a04b","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3273,"start":305156,"end":306830,"sha256":"a582fe7e18170640653c3c3670c5c68aa5fce33945cd48ad6fbf54aa7732686c","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3294,"start":306831,"end":309526,"sha256":"cf276254164d44c7614754b82004cfc1dc8fee47079368ea1cc77bbeb0d26649","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3339,"start":309527,"end":309880,"sha256":"ce78621fbfd3dc1b362e7cd3ee956abf7241cdb6c52d08918526ad6fd8049b7b","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3344,"start":309881,"end":310084,"sha256":"463b384fb5262393246d0ec7a57e26f114c958068867ba7443d8c0d07ff686c2","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3347,"start":310085,"end":311167,"sha256":"99218ba3bc87d6ac6f954c0c8770a022e095f85c9b467afee53071d51733b0a9","owner":"phase53-z29w-role-integration.test.cjs"},
  {"line":3360,"start":311169,"end":312280,"sha256":"28606d743d3daf7155227515d733872fdf6b9ebd9dfde6d0d7fe3025984b2fd9","owner":"phase53-z29w-role-integration.test.cjs"},
]);

const ORIGINAL_SUITES = Object.freeze([
  { start: 11711, end: 11767, sha256: '12bfc7fcbfcafc9158fa5fe2f1400c3fff59807ec481983460ad09123e27c6f1' },
  { start: 15233, end: 15284, sha256: 'f4b9bae1e6990813b615f2e86ebc3c363a7c169aec2fa894cb0c4a5836f7af0b' },
  { start: 27789, end: 27863, sha256: '1fa496482e7477eb1977030bedee64a7211eaaeffa6325e6adb6e14a8018ba99' },
  { start: 29957, end: 30017, sha256: '301fe210e97cceed2018d503dbeb0d41c0f974a0d63a4721877e9a76246a065d' },
  { start: 34658, end: 34717, sha256: '309c71d948ff6cac494b971077b91de9a3d03712b5cf0915a237515fecdfa688' },
  { start: 46365, end: 46418, sha256: '1409dc6e1b3d093b47efab78d908de150b93a1ffa2504b03920fcf70c0e1541c' },
  { start: 97335, end: 97384, sha256: '5059c851fc9a797c70af932ee42d2e14f4ec7b5b7568e942dcd9a0e12ec57244' },
]);
