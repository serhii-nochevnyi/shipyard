'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const serialize = records => records.map(record => JSON.stringify(record) + '\n').join('');
const captureRoot = path.resolve(__dirname, '../fixtures/captured');
const registry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/codex-agent-stream.json')));
function captured(name) {
  const relative = registry.fixtures.find(file => file.endsWith('/codex-agent-stream-' + name + '.jsonl'));
  assert.ok(relative, 'original native shapes must be registered');
  return fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
}
const cli = captured('exec');
const parent = captured('parent');
const child = captured('child');
function template(records, predicate) {
  const original = records.find(predicate);
  assert.ok(original, 'registered native template is required');
  return structuredClone(original);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}
function write(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function commit(f, message) {
  git(f.worktree, 'add', 'src', '.planning'); git(f.worktree, 'commit', '-qm', message);
  f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
}

test('independent original role successes survive a later repair with complete contributor impact', async () => {
  await fixture(async f => {
    const integration = await successfulReview(f, 'integrator');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'another contributor');
    const architecture = await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/consumer.cjs', "module.exports = require('./provider.cjs').value + 1;\n");
    commit(f, 'coordinator repair');
    const i = currentInput(f, 'integrator');
    const a = currentInput(f, 'arch-review');
    const ib = authority.selectReviewBaseline({ currentInput: i });
    const ab = authority.selectReviewBaseline({ currentInput: a });
    assert.equal(ib.mode, 'incremental', JSON.stringify(ib));
    assert.equal(ab.mode, 'incremental', JSON.stringify(ab));
    assert.equal(ib.baseline.head, integration.head);
    assert.equal(ab.baseline.head, architecture.head);
    assert.notEqual(ib.baseline.head, ab.baseline.head);
    const ip = collector.buildReviewImpactPacket(i, ib);
    const ap = collector.buildReviewImpactPacket(a, ab);
    assert.deepEqual(ip.endpoint_delta.map(entry => entry.path), ['src/consumer.cjs', 'src/provider.cjs']);
    assert.deepEqual(ap.endpoint_delta.map(entry => entry.path), ['src/consumer.cjs']);
    assert.ok(ip.impact.paths.includes('src/consumer.cjs'));
    assert.ok(ip.impact.paths.includes('src/provider.cjs'));
    assert.ok(ip.inherited.length > 0);
    assert.ok(ip.current_logical_obligations.some(obligation => obligation.coverage === 'inherited'));
    assert.ok(ip.newly_reviewed.some(ref => ref.path === 'src/provider.cjs'));
    assert.deepEqual(ip.current.ticket_set, ['T-49-01', 'T-49-02']);
    assert.equal(ip.semantic_credit, false);
    assert.equal(authority.isAuthenticatedReviewBaseline({ ...ib.baseline }), false);
    assert.throws(() => collector.buildReviewImpactPacket(i, { ...ib, baseline: { ...ib.baseline } }), /authenticated/);
    assert.deepEqual(fs.readFileSync(integration.artifact), integration.original);
    assert.deepEqual(fs.readFileSync(architecture.artifact), architecture.original);
    assert.equal(authority.currentArchitectureVerdict({ worktreePath: f.worktree, pr: f.pr.number, head: f.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName }), null);
  });
});

async function fixture(action) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-lineage-')));
  const originalHome = os.homedir, originalCodex = process.env.CODEX_HOME;
  os.homedir = () => root; process.env.CODEX_HOME = path.join(root, '.codex');
  try {
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    git(worktree, 'init', '-qb', 'main');
    const phase = '49-lineage';
    const graphDir = path.join(worktree, '.planning/graph');
    const rows = Object.fromEntries(['T-49-01', 'T-49-02'].map(id => [id, {
      phase: '49', title: 'Original review fixture', plan: '.planning/phases/' + phase + '/49-' + id.slice(-2) + '-PLAN.md',
      branch: 'ticket/' + id, epic: 'epic/' + phase, pr_base: 'main', repo: null, wave: 1,
      depends_on: [], files: ['src/provider.cjs', 'src/consumer.cjs'], risk: 'high', human_checkpoint: true,
    }]));
    const state = Object.fromEntries(Object.keys(rows).map((id, index) => [id, { status: 'merged', pr: 101 + index, branch: rows[id].branch }]));
    write(worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: rows }));
    write(worktree, '.planning/graph/delivery-state.json', JSON.stringify(state));
    write(worktree, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' } }));
    for (const row of Object.values(rows)) write(worktree, row.plan, '---\nphase: 49\nplan: 01\n---\nADR-014\n');
    write(worktree, '.planning/architecture/ADR-014-original.md', '# ADR-014\nOriginal complete governing material.\n' + 'a'.repeat(250000));
    write(worktree, 'src/provider.cjs', 'exports.value = 0;\n');
    write(worktree, 'src/consumer.cjs', "module.exports = require('./provider.cjs').value;\n");
    write(worktree, 'src/unchanged.cjs', 'exports.untouched = true;\n');
    git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'original base');
    const base = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'update-ref', 'refs/remotes/origin/main', base);
    git(worktree, 'switch', '-qc', 'epic/' + phase);
    write(worktree, 'src/provider.cjs', 'exports.value = 1;\n');
    const f = { root, worktree, base, graphDir, phase, rows, state, count: 0, agents: {}, reviews: [] };
    f.pr = { number: 301, state: 'OPEN', isDraft: false, headRefName: 'epic/' + phase, headRefOid: '',
      baseRefName: 'main', baseRefOid: base, reviewDecision: 'REVIEW_REQUIRED' };
    commit(f, 'original implementation');
    const binding = phaseBinding(f);
    const inventoryPath = path.join(root, 'original-phase-roster.json');
    fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
    authority.registerPhaseArchiveRoster({ worktreePath: worktree, binding, graphDir, inventoryPath,
      expectedInventoryDigest: hash(fs.readFileSync(inventoryPath)) });
    await action(f);
  } finally {
    os.homedir = originalHome;
    if (originalCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodex;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function phaseBinding(f) {
  return target.phaseBinding({ graph: { tickets: f.rows }, state: f.state, phase: 49,
    repository: git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    branch: f.pr.headRefName, pr: f.pr.number, head: f.head, base: f.pr.baseRefOid });
}

function agent(f, role, signals) {
  if (f.agents[role]) return f.agents[role];
  const selection = policy.resolveDispatch({ runtime: 'codex', role, signals });
  const dir = path.join(f.root, role + '-agents'); fs.mkdirSync(dir);
  const text = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + selection.policy_version + '"',
    '# shipyard-policy-hash = "' + selection.policy_hash + '"', '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "' + role + '"', '# shipyard-policy-rung = "' + selection.rung + '"',
    'name = "' + selection.agent_file.replace(/\.toml$/, '') + '"', 'model = "' + selection.model + '"',
    'model_reasoning_effort = "' + selection.effort + '"', 'sandbox_mode = "read-only"',
    "developer_instructions = '''", 'Read complete original material.' + (role === 'arch-review' ? 'a'.repeat(900000) : ''), "'''", '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, selection.agent_file), text);
  const manifest = path.join(dir, '.shipyard-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: selection.policy_version,
    policy_hash: policy.POLICY_HASH, agent_files: [selection.agent_file], agent_digests: { [selection.agent_file]: hash(text) } }));
  return f.agents[role] = { dir, manifest, text, selection,
    capabilities: { supportedModels: [selection.model], supportedEfforts: [selection.effort] } };
}

function currentInput(f, role, dispatchId = 'current-' + role + '-' + ++f.count) {
  const binding = phaseBinding(f);
  const storage = path.join(f.root, 'inputs');
  if (role === 'arch-review') {
    const scope = { worktree: f.worktree, phase: 49, ticket: binding.subject, run_id: dispatchId };
    const value = collector.prepare(scope, { role, context: {}, signals: {} }, { graphDir: f.graphDir,
      refreshGit: false, getPullRequest: () => f.pr, inflightDispatchId: dispatchId, storageRoot: storage });
    const a = agent(f, role, value.launch.signals);
    collector.admitInstalledLaunch(value, { agentDir: a.dir, agentFile: a.selection.agent_file,
      agentManifest: a.manifest, capabilities: a.capabilities });
    f.lastArchitecture = value;
    return collector.admittedFileInput(value);
  }
  const ticketSet = binding.ticketSet;
  const subject = 'phase=' + f.phase + ';repository=' + git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    + ';tickets=' + binding.membership;
  const a = agent(f, role, {});
  const packet = packets.buildContextPacket({ root: f.worktree, role, subject, sourceRevision: f.head,
    policy: policy.POLICY,
    policyHash: policy.POLICY_HASH, scope: { files_modified: ['src/provider.cjs', 'src/consumer.cjs'] },
    requiredRefs: [...git(f.worktree, 'ls-tree', '-r', '--name-only', f.head, '--', 'src').split('\n').filter(Boolean),
      '.planning/architecture/ADR-014-original.md'],
    roleContext: { phase_contracts: ['ADR-014'], combined_diff: git(f.worktree, 'diff', f.base, f.head),
      ticket_set: ticketSet, ticket_set_digest: binding.membership } });
  const encoded = packets.encodeUniqueContent(packet);
  return collector.prepareFileInput({ worktree: f.worktree, phase: 49, ticket: subject, run_id: dispatchId },
    JSON.stringify(encoded), { role, dispatchId, storageRoot: storage,
      generatedInstructionBytes: Buffer.byteLength(runtime.generatedInstructions(a.text)) + 2,
      binding: { base: f.pr.baseRefOid, base_ref: 'refs/remotes/origin/main', merge_base: git(f.worktree, 'merge-base', f.pr.baseRefOid, f.head),
        ticket_set: ticketSet.map(record => record.id), ticket_set_digest: binding.membership,
        packet_digest: hash(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(encoded)),
        agent_sha256: hash(a.text), agent_path: path.join(a.dir, a.selection.agent_file),
        installed_files: [{ root: a.dir, path: a.selection.agent_file, sha256: hash(a.text) }] } });
}

function nativeRecords(scope, input, session, selection, resultText, legacy = false) {
  const meta = template(parent, record => record.type === 'session_meta');
  Object.assign(meta.payload, { id: session, session_id: session, cwd: scope.worktree, runtime_workspace_roots: [scope.worktree] });
  const context = template(parent, record => record.type === 'turn_context');
  Object.assign(context.payload, { model: selection.model, effort: selection.effort, cwd: scope.worktree, workspace_roots: [scope.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: selection.model, reasoning_effort: selection.effort });
  const start = template(parent, record => record.payload?.type === 'task_started');
  const turn = start.payload.turn_id;
  context.payload.turn_id = turn;
  const wrap = (type, fields) => {
    const record = template(child, record => record.type === 'response_item' && record.payload.type === type);
    Object.assign(record.payload, fields); record.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
    return record;
  };
  const checked = collector.verifyFileInput(input);
  const assets = legacy ? [] : [{ path: input.input_bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
  const reads = [];
  for (const asset of assets) for (let index = 0; index < Math.ceil(asset.bytes.length / input.input_bundle.chunk_bytes); index++) {
    const callId = 'original-' + reads.length;
    const cmd = "dd if='" + asset.path.replaceAll("'", "'\\''") + "' bs=" + input.input_bundle.chunk_bytes
      + ' skip=' + index + ' count=1 2>/dev/null | base64';
    const output = wrap('custom_tool_call_output', { call_id: callId });
    output.payload.output[0].text = 'Script completed\nWall time 0.1 seconds\nOutput:\n';
    output.payload.output[1].text = JSON.stringify({ exit_code: 0,
      output: asset.bytes.subarray(index * input.input_bundle.chunk_bytes, (index + 1) * input.input_bundle.chunk_bytes).toString('base64') });
    reads.push(wrap('custom_tool_call', { name: 'exec', call_id: callId,
      input: 'text(await tools.exec_command(' + JSON.stringify({ cmd, max_output_tokens: 10000 }) + '));' }), output);
  }
  const final = template(parent, record => record.type === 'response_item' && record.payload.phase === 'final_answer');
  final.payload.content.forEach(block => { block.text = resultText; });
  final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  const completion = template(parent, record => record.payload?.type === 'task_complete');
  Object.assign(completion.payload, { turn_id: turn, last_agent_message: resultText });
  return [meta, context, start, ...reads, final, completion];
}

async function successfulReview(f, role, options = {}) {
  const dispatchId = 'original-' + role + '-' + ++f.count;
  const input = currentInput(f, role, dispatchId);
  const value = role === 'arch-review' ? f.lastArchitecture : null;
  const a = f.agents[role];
  const checked = collector.verifyFileInput(input);
  const ticketSet = phaseBinding(f).ticketSet;
  const scope = { worktree: f.worktree, phase: 49, ticket: input.manifest.ticket, run_id: dispatchId };
  const result = { head: f.head, base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
    ...(role === 'arch-review' ? { id: scope.ticket, pr: f.pr.number, verdict: 'conform' }
      : { phase: f.phase, outcome: 'passed', base: 'refs/remotes/origin/main' }),
    summary: 'Original complete fixture review', findings: [], blocking_count: 0,
    ticket_set: ticketSet, ticket_set_digest: input.manifest.binding.ticket_set_digest,
    context_digest: input.manifest.binding.packet_digest,
    ...(value ? { launch_digest: collector.admittedPrompt(value).match(/launch_digest=([a-f0-9]{64})/)[1] } : {}),
    input_manifest_sha256: input.input_bundle.manifest_sha256, input_material_bytes: input.input_bundle.total_bytes,
    input_asset_count: input.input_bundle.asset_count, input_chunk_reads: checked.chunk_reads,
    evidence_markdown: 'Complete original role review.', ...options.result };
  if (options.legacy) for (const field of ['input_manifest_sha256', 'input_material_bytes', 'input_asset_count', 'input_chunk_reads']) delete result[field];
  const resultText = JSON.stringify(result), session = crypto.randomUUID();
  const native = nativeRecords(scope, input, session, a.selection, resultText, options.legacy);
  if (options.nativeMutation) options.nativeMutation(native);
  const now = new Date();
  const nativeDir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativeFile = path.join(nativeDir, session + '.jsonl');
  fs.writeFileSync(nativeFile, serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
    .map(type => template(cli, record => record.type === type));
  records[0].thread_id = session; records[2].item.text = resultText;
  const recorder = boundary.createDurableRecorder(path.join(f.root, 'receipts'));
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const processFixture = new EventEmitter();
      processFixture.stdout = new EventEmitter(); processFixture.stderr = new EventEmitter(); processFixture.pid = process.pid;
      processFixture.stdin = { write() {}, end() { process.nextTick(() => {
        processFixture.stdout.emit('data', Buffer.from(serialize(records))); processFixture.emit('close', 0);
      }); } };
      return processFixture;
    } });
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort,
    sandbox_mode: 'read-only', agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
  { dispatch_id: dispatchId, prompt: options.legacy ? checked.material[0].toString('utf8') : value ? collector.admittedPrompt(value) : input.prompt,
    ...(options.legacy ? {} : { input_transport: 'host-files', input_bundle: input.input_bundle, input_prepared: input }) });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched }, capabilities: a.capabilities });
  const dispatched = boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch(
    { runtime: 'codex', role, dispatch_id: dispatchId, signals: value?.launch.signals || {} },
    { ticket: scope.ticket, ...(role === 'arch-review' ? { subject_kind: 'phase' } : {}) });
  let sealed;
  if (value) {
    write(f.worktree, '.shipyard-arch-review-evidence.md', result.evidence_markdown);
    sealed = collector.finish(value, dispatched, recorder).artifact;
  }
  else {
    const { evidence_markdown: _markdown, ...judgment } = result;
    const evidencePath = path.join(f.worktree, '.planning/phases/' + f.phase + '/INTEGRATION.md');
    fs.writeFileSync(evidencePath, result.evidence_markdown);
    const artifact = authority.sealJudgment({ worktreePath: f.worktree, role, phase: f.phase,
      ticket: scope.ticket, base: 'refs/remotes/origin/main', recorder, dispatchId,
      result: judgment, ticketSet, ticketSetDigest: input.manifest.binding.ticket_set_digest, evidencePath });
    sealed = { ref: artifact.artifact_path }; fs.unlinkSync(evidencePath);
  }
  const review = { head: f.head, artifact: sealed.ref, original: fs.readFileSync(sealed.ref),
    dispatched, nativeFile, input, recorder, role };
  f.reviews.push(review); return review;
}

test('authenticated baseline authority cannot be borrowed by another role', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    await successfulReview(f, 'arch-review');
    const i = currentInput(f, 'integrator'), a = currentInput(f, 'arch-review');
    const ib = authority.selectReviewBaseline({ currentInput: i });
    const ab = authority.selectReviewBaseline({ currentInput: a });
    assert.equal(ib.mode, 'incremental', JSON.stringify(ib));
    assert.equal(ab.mode, 'incremental', JSON.stringify(ab));
    assert.throws(() => collector.buildReviewImpactPacket(a, { ...ab, baseline: ib.baseline }),
      /baseline.*role.*subject/);
    assert.throws(() => collector.buildReviewImpactPacket(i, { ...ib, baseline: ab.baseline }),
      /baseline.*role.*subject/);
  });
});

test('changed complete membership records invalidate inheritance even when ticket IDs are unchanged', async () => {
  await fixture(async f => {
    const original = await successfulReview(f, 'integrator');
    f.rows['T-49-02'].title = 'Changed contributor contract';
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    commit(f, 'same IDs with changed complete membership');
    const input = currentInput(f, 'integrator');
    const selected = authority.selectReviewBaseline({ currentInput: input });
    assert.equal(selected.mode, 'full', JSON.stringify(selected));
    assert.ok(selected.rejected.some(entry => entry.code === 'REVIEW_BASELINE_STALE'));
    assert.deepEqual(collector.buildReviewImpactPacket(input, selected).inherited, []);
    assert.deepEqual(fs.readFileSync(original.artifact), original.original);
  });
});

test('latest authenticated success is role-specific and later unresolved findings retain rejected history', async () => {
  await fixture(async f => {
    const first = await successfulReview(f, 'integrator');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'second independent integration endpoint');
    const second = await successfulReview(f, 'integrator');
    const beforeFailure = authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') });
    assert.equal(beforeFailure.mode, 'incremental', JSON.stringify(beforeFailure));
    assert.equal(beforeFailure.baseline.dispatch_id, second.dispatched.dispatch_id);
    assert.notEqual(beforeFailure.baseline.dispatch_id, first.dispatched.dispatch_id);
    const rejected = await successfulReview(f, 'integrator', { result: { outcome: 'needs-fix', blocking_count: 1,
      findings: [{ id: 'unresolved', type: 'human-question', question: 'Resolve the affected boundary',
        evidence: 'src/provider.cjs', summary: 'Still unresolved' }] } });
    const input = currentInput(f, 'integrator');
    const selected = authority.selectReviewBaseline({ currentInput: input });
    assert.equal(selected.mode, 'full', JSON.stringify(selected));
    assert.equal(selected.reason, 'unresolved-later-role-findings');
    assert.deepEqual(collector.buildReviewImpactPacket(input, selected).inherited, []);
    assert.ok(selected.rejected.some(item => item.dispatch_id === rejected.dispatched.dispatch_id));
    assert.deepEqual(fs.readFileSync(rejected.artifact), rejected.original);
    write(f.worktree, 'src/provider.cjs', 'exports.value = 3;\n'); commit(f, 'resolve the rejected boundary');
    const repaired = await successfulReview(f, 'integrator');
    const fresh = authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') });
    assert.equal(fresh.mode, 'incremental', JSON.stringify(fresh));
    assert.equal(fresh.baseline.dispatch_id, repaired.dispatched.dispatch_id);
    assert.deepEqual(fs.readFileSync(rejected.artifact), rejected.original);
    const architecture = authority.selectReviewBaseline({ currentInput: currentInput(f, 'arch-review') });
    assert.equal(architecture.mode, 'full'); assert.equal(architecture.baseline, null);
  });
});

for (const [name, edit] of [
  ['native transcript', review => fs.appendFileSync(review.nativeFile, '\n')],
  ['archived findings', review => {
    const manifest = JSON.parse(fs.readFileSync(review.artifact));
    fs.appendFileSync(path.join(review.input.manifest.snapshot.worktree, manifest.files.findings.path), '\n');
  }],
  ['durable original receipt', review => {
    const file = path.join(review.recorder.storeDir, 'record-' + hash(review.dispatched.dispatch_id) + '.json');
    const stored = JSON.parse(fs.readFileSync(file)); stored.payload.receipt.policy_hash = 'f'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(stored));
  }],
  ['protected catalogue', review => {
    const file = path.join(authority.archiveAuthorityDirectory(review.input.manifest.snapshot.worktree), 'catalogue.json');
    const catalogue = JSON.parse(fs.readFileSync(file));
    catalogue.payload.records[review.dispatched.dispatch_id].review_baseline.finalized_at = '9999-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(catalogue), { mode: 0o600 });
  }],
]) test('tampered ' + name + ' cannot supply inherited role coverage', async () => {
  await fixture(async f => {
    const review = await successfulReview(f, 'integrator');
    edit(review);
    const selected = authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') });
    assert.equal(selected.mode, 'full'); assert.equal(selected.baseline, null);
    const packet = collector.buildReviewImpactPacket(currentInput(f, 'integrator'));
    assert.equal(packet.mode, 'full'); assert.deepEqual(packet.inherited, []);
  });
});

test('changed instructions, base and phase membership independently force full review', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    const a = f.agents.integrator, original = a.text;
    a.text = original.replace('Read complete original material.', 'Read all current material.');
    fs.writeFileSync(path.join(a.dir, a.selection.agent_file), a.text);
    assert.equal(authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') }).mode, 'full');
    a.text = original; fs.writeFileSync(path.join(a.dir, a.selection.agent_file), original);
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head); f.pr.baseRefOid = f.head;
    assert.equal(authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') }).mode, 'full');
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base); f.pr.baseRefOid = f.base;
    f.rows['T-49-03'] = { ...f.rows['T-49-02'], plan: '.planning/phases/' + f.phase + '/49-03-PLAN.md', branch: 'ticket/T-49-03' };
    f.state['T-49-03'] = { status: 'merged', pr: 103 };
    write(f.worktree, f.rows['T-49-03'].plan, 'ADR-014\n');
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state)); commit(f, 'new contributor membership');
    assert.equal(authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') }).mode, 'full');
  });
});

test('contracts, configuration and uncertain dynamic imports expand to complete current review', async () => {
  for (const [name, content, reason] of [
    ['src/contracts/shared.json', '{"new_contract":true}', 'governing-or-contract-change'],
    ['runtime.config.json', '{"changed":true}', 'governing-or-contract-change'],
    ['src/dynamic.cjs', 'module.exports = require(process.env.DYNAMIC_SOURCE);\n', 'uncertain-dependency-closure'],
  ]) await fixture(async f => {
    await successfulReview(f, 'integrator');
    write(f.worktree, name, content);
    git(f.worktree, 'add', name); commit(f, 'affected shared boundary');
    const packet = collector.buildReviewImpactPacket(currentInput(f, 'integrator'));
    assert.equal(packet.mode, 'full'); assert.deepEqual(packet.inherited, []);
    assert.ok(packet.endpoint_delta.some(entry => entry.path === name));
    assert.ok(packet.limitations.some(entry => entry.reason === reason));
    assert.ok(packet.original_packet.dictionary.length > 0);
    assert.ok(packet.current_logical_obligations.every(entry => entry.coverage === 'newly-reviewed-current-packet'));
  });
});

test('renames, deletions, generated consumers and development context remain in complete endpoint impact', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    git(f.worktree, 'mv', 'src/unchanged.cjs', 'src/renamed.cjs');
    fs.unlinkSync(path.join(f.worktree, 'src/consumer.cjs'));
    write(f.worktree, 'src/generated/mirror.cjs', 'exports.generated = true;\n');
    write(f.worktree, '.planning/phases/' + f.phase + '/NOTES.md', 'Execution context changes.\n');
    commit(f, 'all endpoint obligations');
    const packet = collector.buildReviewImpactPacket(currentInput(f, 'integrator'));
    assert.ok(packet.endpoint_delta.some(entry => entry.previous_path === 'src/unchanged.cjs' && entry.path === 'src/renamed.cjs'));
    assert.ok(packet.endpoint_delta.some(entry => entry.status === 'D' && entry.path === 'src/consumer.cjs'));
    assert.ok(packet.endpoint_delta.some(entry => entry.path === 'src/generated/mirror.cjs'));
    assert.ok(packet.endpoint_delta.some(entry => entry.path.endsWith('/NOTES.md') && entry.development_context));
    assert.ok(packet.newly_reviewed.some(entry => entry.path === 'src/consumer.cjs' && entry.deleted));
  });
});

test('legacy successful full review remains original history and supplies no unsupported inheritance', async () => {
  await fixture(async f => {
    const legacy = await successfulReview(f, 'integrator', { legacy: true });
    const packet = collector.buildReviewImpactPacket(currentInput(f, 'integrator'));
    assert.equal(packet.mode, 'full'); assert.equal(packet.baseline, null); assert.deepEqual(packet.inherited, []);
    assert.ok(packet.limitations.some(item => item.reason === 'no-eligible-original-role-success'));
    assert.deepEqual(fs.readFileSync(legacy.artifact), legacy.original);
  });
});

test('incomplete original native output cannot create an eligible success or erase an earlier baseline', async () => {
  await fixture(async f => {
    const original = await successfulReview(f, 'integrator');
    await assert.rejects(successfulReview(f, 'integrator', { nativeMutation(records) {
      const at = records.findIndex(record => record.payload?.type === 'custom_tool_call_output');
      assert.ok(at > 0); records.splice(at, 1);
    } }), /read|output|complete|pending/i);
    const selected = authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') });
    assert.equal(selected.baseline.dispatch_id, original.dispatched.dispatch_id);
    assert.deepEqual(fs.readFileSync(original.artifact), original.original);
  });
});

test('unknown input extension versions refuse before baseline reuse', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    const input = currentInput(f, 'integrator');
    const manifest = JSON.parse(fs.readFileSync(input.input_bundle.manifest_path));
    manifest.schema = 'shipyard.host-file-input.v999';
    fs.chmodSync(input.input_bundle.manifest_path, 0o600);
    fs.writeFileSync(input.input_bundle.manifest_path, JSON.stringify(manifest));
    fs.chmodSync(input.input_bundle.manifest_path, 0o400);
    assert.throws(() => authority.selectReviewBaseline({ currentInput: input }), /manifest|changed/);
  });
});

test('uncommitted required product bytes cannot inherit a commit-bound conclusion', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 99;\n');
    const packet = collector.buildReviewImpactPacket(currentInput(f, 'integrator'));
    assert.equal(packet.mode, 'full');
    assert.deepEqual(packet.inherited, []);
    assert.ok(packet.limitations.some(item => item.reason === 'current-product-source-differs-from-head'));
  });
});

test('unparsed semantic assumptions and explicit limitations force the independent full-review fallback', async () => {
  for (const result of [{ assumptions: [{ contract: 'unsupported-assumption.v999' }] }, { limitations: ['Unresolved boundary'] }])
    await fixture(async f => {
      const original = await successfulReview(f, 'integrator', { result });
      const selected = authority.selectReviewBaseline({ currentInput: currentInput(f, 'integrator') });
      assert.equal(selected.mode, 'full'); assert.equal(selected.baseline, null);
      assert.ok(selected.rejected.some(entry => entry.code === 'REVIEW_BASELINE_UNSUPPORTED'));
      assert.deepEqual(fs.readFileSync(original.artifact), original.original);
    });
});
