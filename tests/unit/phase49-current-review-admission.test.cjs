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
  git(f.worktree, 'update-ref', 'refs/remotes/origin/' + f.pr.headRefName, f.head);
}

const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
const secondRuntime = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');

test('focused original inline judgment reaches finish, archive lookup and the existing live gate without reads', async () => {
  await fixture(async f => {
    const reviewed = await runFocusedArchitecture(f);
    assert.equal(reviewed.receipt.runtime_evidence.input_consumption, undefined);
    assert.equal(reviewed.receipt.runtime_evidence.focused_review.review_contract, collector.FOCUSED_CONTRACT);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'tree-equal moved focused head');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const completeness of ['complete', 'incomplete']) test('direct ticket original ' + completeness + ' architecture reaches actual sentinel duty and live merge', async () => {
  await fixture(async f => {
    f.directTicket = 'T-49-01';
    git(f.worktree, 'switch', '-qc', f.rows[f.directTicket].branch);
    f.pr.headRefName = f.rows[f.directTicket].branch;
    f.rows[f.directTicket].human_checkpoint = false;
    f.rows[f.directTicket].risk = 'medium';
    f.state[f.directTicket] = { status: 'pr-open', pr: f.pr.number, branch: f.pr.headRefName };
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    commit(f, 'direct ticket review subject');
    const sentinel = require.resolve('../../plugins/delivery-pipeline/scripts/sentinel.cjs');
    const preload = path.join(f.root, 'fixture-home.cjs');
    fs.writeFileSync(preload, "require('node:os').homedir = () => " + JSON.stringify(f.root) + ';');
    const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
    const live = path.join(f.root, 'live-pr.json');
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\n' +
      "const args = process.argv.slice(2); if (args[0] === 'pr' && args[1] === 'view') " +
      "process.stdout.write(require('fs').readFileSync(" + JSON.stringify(live) + ")); " +
      "else if (args[0] === 'repo') console.log('main'); else process.exit(1);\n", { mode: 0o755 });
    const invoke = args => JSON.parse(execFileSync(process.execPath, [sentinel, ...args, '--json'], {
      cwd: f.worktree, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        NODE_OPTIONS: '--require=' + preload } }));
    const project = (worktree = f.worktree) => {
      fs.writeFileSync(live, JSON.stringify(f.pr));
      const admitted = require('../../plugins/delivery-pipeline/scripts/state-sync.cjs').currentReviewAdmission({ ...currentSubject(f),
        worktreePath: worktree, graphDir: path.join(worktree, '.planning/graph') });
      const entry = { ...f.state[f.directTicket], draft: false, merge_scope: 'integration',
        epic: f.rows[f.directTicket].epic, pr_base: f.pr.baseRefName, integration_branch: 'main',
        head_sha: f.pr.headRefOid, pr_base_sha: f.pr.baseRefOid,
        checks: { total: 3, failing: 0, pending: 0, none_reported: false },
        authenticated_architecture: admitted?.architecture.verdict || null,
        authenticated_integration: admitted?.integration || null };
      assert.equal(entry.authenticated_integration, null);
      write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify({ ...f.state, [f.directTicket]: entry }));
      return invoke(['duty', '--scope', f.directTicket]);
    };
    const assertOwed = duty => {
      assert.equal(duty.items[0].action, 'arch-review'); assert.equal(duty.actionable_count, 1);
      assert.equal(duty.human_count, 0); assert.equal(duty.clear, false);
    };
    assertOwed(project());
    for (const dry of [[], ['--dry-run']]) {
      const row = invoke(['merge', f.directTicket, ...dry]).results[0];
      assert.equal(row.merged, false); assert.equal(row.would_merge, undefined);
      assert.match(row.blockers.join('; '), /fresh authenticated architecture/);
    }
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    await runFocusedArchitecture(f, result => {
      if (completeness === 'incomplete') {
        result.review_completeness = 'incomplete'; result.limitations = ['Unresolved consumer'];
        result.unresolved_sources = ['src/consumer.cjs'];
      }
    });
    const duty = project();
    if (completeness === 'incomplete') { assertOwed(duty); return; }
    assert.equal(duty.items[0].action, 'human-merge'); assert.equal(duty.human_count, 1);
    assert.equal(duty.actionable_count, 0); assert.equal(duty.waiting_count, 0); assert.equal(duty.clear, true);
    for (const dry of [[], ['--dry-run']]) {
      const row = invoke(['merge', f.directTicket, ...dry]).results[0];
      assert.equal(row.merged, false); assert.equal(row.would_merge, undefined);
      assert.match(row.blockers.join('; '), /integration branch.*human/);
    }
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head);
    f.pr.baseRefOid = f.head;
    assertOwed(project());
    const movedBase = invoke(['merge', f.directTicket, '--dry-run']).results[0];
    assert.equal(movedBase.merged, false); assert.equal(movedBase.would_merge, undefined);
    assert.match(movedBase.blockers.join('; '), /fresh authenticated architecture/);
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
    f.pr.baseRefOid = f.base;
    const foreign = path.join(f.root, 'foreign-repository');
    git(f.root, 'clone', '--quiet', '--no-hardlinks', f.worktree, foreign);
    assert.notEqual(git(foreign, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    assertOwed(project(foreign));
    assert.equal(project().items[0].action, 'human-merge');
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'tree-equal moved direct head');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    assertOwed(project());
    const stale = invoke(['merge', f.directTicket, '--dry-run']).results[0];
    assert.equal(stale.merged, false); assert.equal(stale.would_merge, undefined);
    assert.match(stale.blockers.join('; '), /fresh authenticated architecture/);
  });
});

test('focused incomplete original review retains limitations and findings but cannot grant current conformance', async () => {
  await fixture(async f => {
    const reviewed = await runFocusedArchitecture(f, result => {
      result.review_completeness = 'incomplete'; result.unresolved_sources = ['src/consumer.cjs'];
      result.limitations = ['Consumer boundary remains unresolved'];
    });
    assert.equal(reviewed.result.review_completeness, 'incomplete');
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.review_completeness, 'incomplete');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const producer of ['codex', 'claude']) test(producer + ' focused overflow reaches original finish, archive and live gate without read proof', async () => {
  await claudeFixture(async f => {
    write(f.worktree, 'src/provider.cjs', Array.from({ length: 24000 }, (_, index) =>
      'exports.field' + index + ' = "complete current producer and consumer boundary";').join('\n') + '\n');
    commit(f, 'focused overflow source');
    const reviewed = producer === 'codex' ? await runFocusedArchitecture(f) : await runClaudeCurrentReview(f, 'arch-review');
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.contract, collector.FOCUSED_CONTRACT);
    assert.equal(manifest.current_review.review_completeness, 'complete');
    if (producer === 'codex') {
      assert.equal(reviewed.receipt.runtime_evidence.input_transport, 'host-files');
      assert.equal(reviewed.receipt.runtime_evidence.input_consumption, undefined);
      const checked = collector.verifyFileInput(reviewed.receipt.runtime_evidence.input_bundle, { sealed: true });
      assert.ok(checked.manifest.assets.some(asset => asset.source_partition?.source === 'current-pr.diff'));
    } else assert.match(f.lastClaudeUserInput.message.content, /AUTHENTICATED_FOCUSED_INPUT/);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
  });
});

for (const [name, edit] of [
  ['forged contract', result => { result.review_contract = 'forged'; }],
  ['wrong repository', result => { result.repository += '-foreign'; }],
  ['wrong membership', result => { result.ticket_set_digest = '0'.repeat(64); }],
  ['wrong base', result => { result.base_commit = '0'.repeat(40); }],
  ['wrong launch', result => { result.launch_digest = '0'.repeat(64); }],
  ['malformed completeness', result => { result.review_completeness = 'maybe'; }],
  ['contradictory complete', result => { result.unresolved_sources = ['current-pr.diff:partition-2']; }],
]) test('focused original completion refuses ' + name, async () => {
  await fixture(async f => {
    await assert.rejects(runFocusedArchitecture(f, edit));
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

test('Claude original incomplete focused judgment is archived without granting conformance', async () => {
  await claudeFixture(async f => {
    const reviewed = await runClaudeCurrentReview(f, 'arch-review', { originalResult(result) {
      result.review_completeness = 'incomplete'; result.limitations = ['Consumer boundary unresolved'];
      result.unresolved_sources = ['src/consumer.cjs'];
    } });
    const manifest = JSON.parse(fs.readFileSync(reviewed.artifact.ref));
    assert.equal(manifest.current_review.review_completeness, 'incomplete');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

async function runFocusedArchitecture(f, edit = () => {}) {
  const dispatchId = 'focused-original-' + ++f.count;
  const auxiliary = currentInput(f, 'arch-review', dispatchId);
  const prepared = f.lastArchitecture;
  const scope = { worktree: f.worktree, ticket: prepared.prepared.ticket, phase: 49, run_id: dispatchId };
  const prompt = collector.admittedPrompt(prepared);
  const binding = collector.authenticateFocusedLaunch(prepared, prompt, { ...scope, dispatch_id: dispatchId });
  const result = { ...binding, ticket_set: prepared.prepared.binding?.ticketSet || [prepared.prepared.ticket],
    verdict: 'conform', blocking_count: 0, findings: [], summary: 'Independent focused judgment',
    review_completeness: 'complete', limitations: [], unresolved_sources: [],
    evidence_markdown: 'Complete independent review of the current diff and selected governing ADR.' };
  edit(result);
  const a = f.agents['arch-review'], session = crypto.randomUUID(), text = JSON.stringify(result);
  const native = nativeRecords(scope, auxiliary, session, a.selection, text, true, prompt);
  const now = new Date(), dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, session + '.jsonl'), serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed'].map(type => template(cli, r => r.type === type));
  records[0].thread_id = session; records[2].item.text = text;
  const recorder = boundary.createDurableRecorder(path.join(f.root, 'focused-receipts'));
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'focused-transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const processFixture = new EventEmitter(); processFixture.stdout = new EventEmitter(); processFixture.stderr = new EventEmitter(); processFixture.pid = process.pid;
      processFixture.stdin = { write() {}, end() { process.nextTick(() => {
        processFixture.stdout.emit('data', Buffer.from(serialize(records))); processFixture.emit('close', 0);
      }); } }; return processFixture;
    } });
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort, sandbox_mode: 'read-only',
    agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
    { dispatch_id: dispatchId, prompt, focused_prepared: prepared,
      ...(collector.admittedFileInput(prepared) ? { input_transport: 'host-files', input_bundle: collector.admittedFileInput(prepared).input_bundle, input_prepared: collector.admittedFileInput(prepared) } : {}) });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched } });
  const dispatched = boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch(
    { runtime: 'codex', role: 'arch-review', dispatch_id: dispatchId, signals: prepared.launch.signals },
    { ticket: scope.ticket, ...(prepared.prepared.binding ? { subject_kind: 'phase' } : {}) });
  write(f.worktree, '.shipyard-arch-review-evidence.md', result.evidence_markdown);
  return collector.finish(prepared, dispatched, recorder);
}

test('fresh native architecture delta reaches sealer, exact-current lookup and all consumers', async () => {
  await fixture(async f => {
    const prior = await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'another contributor repair');
    const fresh = await runArchitecture(f);
    assert.equal(fresh.coverage.mode, 'incremental');
    assert.equal(fresh.coverage.baseline.head, prior.head);
    assert.ok(fresh.coverage.impact.paths.includes('src/consumer.cjs'));
    assert.ok(fresh.coverage.inherited.length);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    assert.deepEqual(fs.readFileSync(prior.artifact), prior.original);
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'tree-equal moved head');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

function currentSubject(f) {
  return { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number,
    getPullRequest: () => f.pr };
}
function admissionDiagnostic(f, consumer) {
  const refusals = [];
  try {
    authority.currentArchitectureVerdict({ worktreePath: f.worktree, graphDir: f.graphDir,
      pr: f.pr.number, head: f.head, headBranch: f.pr.headRefName,
      baseName: f.pr.baseRefName, baseCommit: f.pr.baseRefOid,
      onCandidateRefusal: refusal => refusals.push(refusal) });
  } catch (error) { refusals.push({ code: error.code, message: error.message }); }
  return JSON.stringify({ admission: consumer(currentSubject(f)), refusals });
}
const gate = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs');
const consumers = [gate.verifyCurrentReviews,
  require('../../plugins/delivery-pipeline/scripts/sentinel.cjs').currentReviewAdmission,
  require('../../plugins/delivery-pipeline/scripts/state-sync.cjs').currentReviewAdmission];

async function runArchitecture(f, edit = {}) {
  const dispatchId = 'fresh-architecture-' + ++f.count;
  const original = currentInput(f, 'arch-review', dispatchId, { legacy: true });
  const input = authority.prepareCurrentReviewInput({ currentInput: original, storageRoot: path.join(f.root, 'architecture-delta') });
  const checked = collector.verifyFileInput(input);
  const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));
  const coverage = packet.review_coverage;
  const result = structuredClone({ id: packet.ticket, pr: f.pr.number, verdict: 'conform',
    head: f.head, head_tree: git(f.worktree, 'rev-parse', 'HEAD^{tree}'),
    base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
    ticket_set: f.lastArchitecture.prepared.binding.ticketSet, ticket_set_digest: coverage.current.ticket_set_digest,
    reviewed_identity: coverage.reviewed_identity, coverage: { ...coverageResult(coverage), schema: 'shipyard.architecture-coverage-result.v1' },
    context_digest: input.manifest.binding.packet_digest, input_manifest_sha256: input.input_bundle.manifest_sha256,
    input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
    input_chunk_reads: checked.chunk_reads, blocking_count: 0, findings: [], summary: 'Fresh current architecture',
    evidence_markdown: 'Complete architecture baseline, current delta and expanded boundaries.' });
  edit.result?.(result);
  const a = f.agents['arch-review'], scope = { worktree: f.worktree, phase: 49, ticket: packet.ticket, run_id: dispatchId };
  const session = crypto.randomUUID(), text = JSON.stringify(result);
  const native = nativeRecords(scope, input, session, a.selection, text); edit.native?.(native);
  const now = new Date(), dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, session + '.jsonl'), serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed'].map(type => template(cli, r => r.type === type));
  records[0].thread_id = session; records[2].item.text = text;
  const recorder = boundary.createDurableRecorder(path.join(f.root, 'receipts'));
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = process.pid;
      p.stdin = { write() {}, end() { process.nextTick(() => { p.stdout.emit('data', Buffer.from(serialize(records))); p.emit('close', 0); }); } }; return p;
    } });
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort, sandbox_mode: 'read-only',
    agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
    { dispatch_id: dispatchId, prompt: input.prompt, input_transport: 'host-files', input_bundle: input.input_bundle, input_prepared: input });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched } });
  const dispatched = boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch(
    { runtime: 'codex', role: 'arch-review', dispatch_id: dispatchId, signals: f.lastArchitecture.launch.signals },
    { ticket: scope.ticket, subject_kind: 'phase' });
  const { evidence_markdown, ...judgment } = result;
  write(f.worktree, '.shipyard-arch-review-evidence.md', evidence_markdown);
  const artifact = authority.sealJudgment({ worktreePath: f.worktree, role: 'arch-review', phase: f.phase,
    pr: f.pr.number, base: 'origin/main', recorder, dispatchId, result: judgment,
    ticketSet: edit.inputTicketSet || result.ticket_set, ticketSetDigest: result.ticket_set_digest });
  return { input, artifact, dispatched, coverage };
}

function projectOptions(f) {
  const live = branch => {
    const id = Object.keys(f.rows).find(id => f.rows[id].branch === branch);
    return { number: f.state[id].pr, state: 'MERGED', mergedAt: '2026-10-09T12:00:00Z',
      headRefName: branch, headRefOid: f.memberHead, baseRefName: f.pr.headRefName,
      mergeCommit: { oid: f.memberHead }, isDraft: false, title: id, body: id };
  };
  return { graphDir: f.graphDir, defaultBranch: 'main', refreshGit: false,
    listPullRequests: ({ branch }) => [live(branch)],
    getPullRequest: ({ pr }) => live(Object.keys(f.rows).map(id => f.rows[id].branch)
      .find(branch => live(branch).number === pr)),
    execFileSync(file, args, options) {
      if (file === 'git' && args.includes('fetch')) return '';
      return execFileSync(file, args, options);
    } };
}

function coverageResult(coverage) {
  return { schema: 'shipyard.integration-coverage-result.v1', mode: coverage.mode, lineage_digest: coverage.digest,
    inherited_obligations: coverage.current_logical_obligations.filter(item => item.coverage === 'inherited').map(item => item.identity),
    newly_reviewed_obligations: coverage.current_logical_obligations.filter(item => item.coverage !== 'inherited').map(item => item.identity),
    impact_paths: coverage.impact.paths, limitations: coverage.limitations };
}

const resultMutations = [
  ['unsupported coverage version', value => { value.coverage.schema = 'shipyard.architecture-coverage-result.v9'; }],
  ['forged lineage digest', value => { value.coverage.lineage_digest = 'f'.repeat(64); }],
  ['missing inherited coverage', value => { value.coverage.inherited_obligations = []; }],
  ['missing new coverage', value => { value.coverage.newly_reviewed_obligations = []; }],
  ['hidden interaction boundary', value => { value.coverage.impact_paths = []; }],
  ['invented limitations', value => { value.coverage.limitations.push({ reason: 'caller authority' }); }],
  ['mixed-role coverage', value => { value.coverage.schema = 'shipyard.integration-coverage-result.v1'; }],
  ['moved reviewed head', value => { value.reviewed_identity.head = 'f'.repeat(40); }],
  ['moved reviewed base', value => { value.reviewed_identity.base = 'f'.repeat(40); }],
  ['changed native policy', value => { value.reviewed_identity.policy_hash = 'f'.repeat(64); }],
  ['partial current member set', value => { value.ticket_set.pop(); }],
  ['extra unsupported envelope field', value => { value.coverage.accepted = true; }],
];
for (const [name, mutation] of resultMutations) test('architecture publication refuses ' + name, async () => {
  await fixture(async f => {
    await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'current repair');
    await assert.rejects(runArchitecture(f, { result: mutation }), error =>
      ['REVIEW_COVERAGE_INVALID', 'JUDGMENT_IDENTITY_MISMATCH', 'JUDGMENT_DIGEST_MISMATCH'].includes(error.code));
  });
});

const archiveMutations = [
  ['baseline artifact bytes', (f, prior) => { fs.appendFileSync(prior.artifact, 'altered'); }],
  ['baseline original native bytes', (f, prior) => { fs.appendFileSync(prior.nativeFile, '\n'); }],
  ['missing original role baseline authority', (f, prior) => { fs.unlinkSync(prior.artifact); }],
  ['forged protected catalogue signature', f => {
    const file = path.join(authority.archiveAuthorityDirectory(f.worktree), 'catalogue.json');
    const value = JSON.parse(fs.readFileSync(file)); value.mac = 'f'.repeat(64); fs.writeFileSync(file, JSON.stringify(value));
  }],
  ['moved whole phase membership', f => {
    const rows = structuredClone(f.rows); rows['T-49-02'].files.push('src/unchanged.cjs');
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: rows }));
  }],
  ['changed whole member evidence', f => {
    const state = structuredClone(f.state); state['T-49-02'].head_sha = 'f'.repeat(40);
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(state));
  }],
  ['changed governing source', f => { write(f.worktree, '.planning/architecture/ADR-014-original.md', '# ADR-014\nChanged contract.\n'); }],
  ['hidden working tree source', f => { write(f.worktree, 'src/unchanged.cjs', 'exports.hidden = true;\n'); }],
  ['moved base reference', f => { git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head); }],
];
for (const [name, mutation] of archiveMutations) test('all current consumers refuse ' + name, async () => {
  await fixture(async f => {
    const prior = await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'current repair');
    await runArchitecture(f);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    mutation(f, prior);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

test('original fresh v1 full reviews remain current and tree-equal stale reviews do not', async () => {
  await fixture(async f => {
    await successfulReview(f, 'arch-review');
    const integration = await successfulReview(f, 'integrator');
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      assert.equal(admitted.architecture.ready, true);
      assert.equal(admitted.integration.authenticated, true);
    }
    git(f.worktree, 'commit', '--allow-empty', '-qm', 'new identity with identical tree');
    f.head = git(f.worktree, 'rev-parse', 'HEAD'); f.pr.headRefOid = f.head;
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      assert.equal(admitted.architecture.ready, false); assert.equal(admitted.integration, null);
    }
    assert.deepEqual(fs.readFileSync(integration.artifact), integration.original);
  });
});

test('last-moment live PR or membership drift re-owes both roles', async () => {
  await fixture(async f => {
    await successfulReview(f, 'arch-review');
    await successfulReview(f, 'integrator');
    for (const [field, changed] of [['headRefOid', 'f'.repeat(40)], ['baseRefOid', 'f'.repeat(40)],
      ['baseRefName', 'another-target'], ['headRefName', 'another-branch']]) {
      for (const consumer of consumers) {
        let calls = 0;
        const admitted = consumer({ ...currentSubject(f), getPullRequest: () => ++calls === 1 ? f.pr : { ...f.pr, [field]: changed } });
        assert.equal(calls, 2); assert.equal(admitted.architecture.ready, false); assert.equal(admitted.integration, null);
      }
    }
    let calls = 0;
    const admitted = gate.verifyCurrentReviews({ ...currentSubject(f), getPullRequest: () => {
      if (++calls === 2) write(f.worktree, '.planning/graph/delivery-state.json', '{}'); return f.pr;
    } });
    assert.equal(admitted.architecture.ready, false); assert.equal(admitted.integration, null);
  });
});

test('ticket and stacked targets preserve skipped-by-target architecture policy', async () => {
  await fixture(async f => {
    for (const base of ['ticket/T-49-01', 'epic/49-parent']) for (const consumer of consumers) {
      const admitted = consumer({ ...currentSubject(f), getPullRequest: () => ({ ...f.pr, baseRefName: base }) });
      assert.equal(admitted.architecture.status, 'skipped-by-target');
      assert.equal(admitted.architecture.ready, true); assert.equal(admitted.integration, null);
    }
  });
});

test('missing independent architecture baseline selects a fresh full current contract', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    const fresh = await runArchitecture(f);
    assert.equal(fresh.coverage.mode, 'full'); assert.equal(fresh.coverage.baseline, null);
    assert.deepEqual(fresh.coverage.inherited, []);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
  });
});

test('current architecture cannot reinterpret the fresh signed native response after publication', async () => {
  await fixture(async f => {
    await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'current repair');
    const fresh = await runArchitecture(f);
    const original = fresh.dispatched.receipt.runtime_evidence.transcript.path;
    const bytes = fs.readFileSync(original); fs.appendFileSync(original, '\n');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
    assert.deepEqual(fs.readFileSync(original).subarray(0, bytes.length), bytes);
  });
});

test('canonicalized Codex architecture membership retains the original complete input digest at current consumers', async () => {
  await fixture(async f => {
    await successfulReview(f, 'arch-review');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'current input representation repair');
    const original = phaseBinding(f).ticketSet;
    const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
    const fresh = await runArchitecture(f, { inputTicketSet: original,
      result: result => { result.ticket_set = sorted(result.ticket_set); } });
    const checked = collector.verifyFileInput(fresh.input);
    const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));
    assert.equal(packet.refs.some(ref => ref.path === '.planning/graph/tickets.json'), false);
    assert.equal(packet.graph.path, '.planning/graph/tickets.json');
    assert.equal(packet.graph.sha256, hash(fs.readFileSync(path.join(f.graphDir, 'tickets.json'))));
    const manifest = JSON.parse(fs.readFileSync(fresh.artifact.artifact_path));
    const file = path.join(f.worktree, manifest.files.findings.path), bytes = fs.readFileSync(file);
    assert.notEqual(hash(JSON.stringify(JSON.parse(bytes).ticket_set)), manifest.ticket_set_digest);
    assert.equal(hash(JSON.stringify(original)), manifest.ticket_set_digest);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    assert.deepEqual(fs.readFileSync(file), bytes);
    const graphFile = path.join(f.graphDir, 'tickets.json');
    fs.appendFileSync(graphFile, '\n');
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
});

test('genuine finalized Claude receipts admit full architecture at all current consumers', async () => {
  for (const role of ['arch-review']) await claudeFixture(async f => {
    const scratch = require('../../plugins/delivery-pipeline/scripts/conveyor-scratch.cjs');
    const before = scratch.statusIgnoringScratch(f.worktree, { forJudge: false });
    assert.equal(before.ok, true);
    assert.deepEqual(before.entries, []);
    const fresh = await runClaudeCurrentReview(f, role);
    const receipt = fresh.dispatch.receipt;
    assert.equal(receipt.runtime, 'claude');
    assert.equal(receipt.runtime_evidence, undefined);
    assert.ok(receipt.session_id);
    assert.notEqual(receipt.transcript.path, claudeNativePin(receipt).path);
    for (const pin of [receipt.transcript, claudeNativePin(receipt)]) {
      const original = fs.readFileSync(pin.path);
      assert.equal(original.length, pin.bytes);
      assert.equal(hash(original), pin.sha256);
    }
    const native = fs.readFileSync(claudeNativePin(receipt).path, 'utf8');
    const userRecords = native.trim().split('\n').map(JSON.parse).filter(row => row.type === 'user');
    assert.equal(userRecords.length, 1);
    assert.equal(userRecords[0].sessionId, receipt.session_id);
    assert.deepEqual(userRecords[0].message, f.lastClaudeUserInput.message);
    if (role === 'arch-review') {
      const manifest = JSON.parse(fs.readFileSync(fresh.artifact.ref));
      const findings = JSON.parse(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path)));
      assert.notEqual(hash(JSON.stringify(findings.ticket_set)), manifest.ticket_set_digest);
      assert.equal(hash(JSON.stringify(phaseBinding(f).ticketSet)), manifest.ticket_set_digest);
      assert.deepEqual(findings.ticket_set, f.lastClaudePacket.role_context.ticket_set);
      assert.equal(f.lastClaudePacket.required_refs.some(ref => ref.path === '.planning/graph/tickets.json'), false);
      const stateRef = f.lastClaudePacket.required_refs.find(ref => ref.path === '.planning/graph/delivery-state.json');
      assert.ok(stateRef, JSON.stringify({ contract: f.lastClaudePacket.role_context.review_contract,
        required_refs: f.lastClaudePacket.required_refs.map(ref => ref.path), dispatch_id: receipt.dispatch_id }));
      assert.equal(hash(stateRef.content), stateRef.sha256);
      assert.equal(Buffer.byteLength(stateRef.content), stateRef.bytes);
      const originalState = JSON.parse(stateRef.content);
      const currentGraph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
      const originalBinding = target.phaseBinding({ graph: currentGraph, state: originalState.tickets || originalState,
        phase: 49, repository: git(f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        branch: f.pr.headRefName, pr: f.pr.number, head: f.head, base: f.pr.baseRefOid });
      assert.equal(originalBinding.subject, manifest.boundary_subject);
      assert.equal(originalBinding.membership, manifest.ticket_set_digest);
      assert.equal(hash(JSON.stringify(originalBinding.ticketSet)), manifest.ticket_set_digest);
      assert.deepEqual(originalBinding.ticketSet, findings.ticket_set);
    }
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      if (role === 'arch-review') {
        assert.equal(admitted.architecture.ready, true, admissionDiagnostic(f, consumer));
        assert.equal(admitted.integration, null);
      } else {
        assert.equal(admitted.integration.authenticated, true);
        assert.equal(admitted.architecture.ready, false);
      }
    }
    if (role === 'arch-review') {
      const dirty = scratch.statusIgnoringScratch(f.worktree, { forJudge: false });
      assert.equal(dirty.ok, true);
      for (const relative of ['.planning/graph/dispatches.json',
        '.planning/graph/provenance/' + receipt.dispatch_id + '.json']) {
        assert.ok(dirty.entries.some(entry => entry.status === '??' && entry.path === relative), relative);
      }
    }
  });
});

test('explicit legacy Claude original input retains its native receipt and current architecture admission', async () => {
  await claudeFixture(async f => {
    const reviewed = await runClaudeCurrentReview(f, 'arch-review', { legacy: true });
    assert.equal(reviewed.result.review_contract, undefined);
    assert.equal(JSON.parse(fs.readFileSync(reviewed.artifact.ref)).current_review, undefined);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true,
      admissionDiagnostic(f, consumer));
  });
});

for (const [name, mutate, valid] of [
  ['reordered', refs => refs.reverse(), true],
  ['missing', refs => refs.pop(), false],
  ['additional', refs => refs.push({ ...refs[0], path: 'extra.md' }), false],
  ['duplicate', refs => refs.push({ ...refs[0] }), false],
  ['changed hash', refs => { refs[0].sha256 = '0'.repeat(64); }, false],
  ['changed bytes', refs => { refs[0].bytes++; }, false],
  ['changed identity', refs => { refs[0].path += '.changed'; }, false],
]) test('legacy selected reference inventory ' + name, async () => {
  await claudeFixture(async f => {
    const run = () => runClaudeCurrentReview(f, 'arch-review', { legacy: true, selectedRefs: mutate });
    if (valid) {
      await run();
      for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true,
        admissionDiagnostic(f, consumer));
    } else {
      await run();
      for (const consumer of consumers) {
        assert.equal(consumer(currentSubject(f)).architecture.ready, false);
        const { refusals } = JSON.parse(admissionDiagnostic(f, consumer));
        assert.ok(refusals.some(refusal => refusal.message === 'selected references differ from original native input'));
      }
    }
  });
});

for (const [name, edit] of [
  ['absent original user packet', rows => rows.shift()],
  ['duplicate original user packet', rows => rows.unshift(structuredClone(rows[0]))],
  ['foreign original user session', rows => { rows[0].sessionId = crypto.randomUUID(); }],
  ['changed complete original membership with unchanged digest', rows => {
    const text = rows[0].message.content;
    const match = /<AUTHENTICATED_CONTEXT_PACKET>\s*([\s\S]*?)\s*<\/AUTHENTICATED_CONTEXT_PACKET>/.exec(text);
    const packet = packets.decodeUniqueContent(JSON.parse(match[1]));
    packet.role_context.ticket_set[0].row.title = 'Altered original membership';
    rows[0].message.content = text.replace(match[1], JSON.stringify(packets.encodeUniqueContent(packet)));
  }],
  ['altered original governing source with repinned semantic content', rows => {
    const text = rows[0].message.content;
    const match = /<AUTHENTICATED_CONTEXT_PACKET>\s*([\s\S]*?)\s*<\/AUTHENTICATED_CONTEXT_PACKET>/.exec(text);
    const packet = packets.decodeUniqueContent(JSON.parse(match[1]));
    const ref = packet.required_refs.find(item => item.path.endsWith('ADR-014-original.md'));
    assert.ok(ref, 'the original legacy packet carries its governing decision');
    ref.content += '\nAltered original governing boundary.\n';
    ref.sha256 = ref.digest = hash(ref.content); ref.bytes = ref.content_bytes = Buffer.byteLength(ref.content);
    for (const item of packet.logical_source_obligations.filter(item => item.path === ref.path)) {
      item.sha256 = ref.sha256; item.bytes = ref.bytes;
    }
    rows[0].message.content = text.replace(match[1], JSON.stringify(packets.encodeUniqueContent(packet)));
  }],
]) test('Claude architecture archive reconstruction refuses ' + name, async () => {
  await claudeFixture(async f => {
    const fresh = await runClaudeCurrentReview(f, 'arch-review', { legacy: true, native: edit });
    const manifest = JSON.parse(fs.readFileSync(fresh.artifact.ref));
    assert.notEqual(hash(JSON.stringify(JSON.parse(fs.readFileSync(path.join(f.worktree,
      manifest.files.findings.path))).ticket_set)), manifest.ticket_set_digest);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
  });
});

for (const [name, mutate] of [
  ['complete live row mutation', f => {
    const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
    graph.tickets['T-49-02'].files.push('src/unchanged.cjs');
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  }],
  ['semantically equal live row with a different original digest', f => {
    const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json')));
    const row = graph.tickets['T-49-02'];
    graph.tickets['T-49-02'] = Object.fromEntries(Object.keys(row).reverse().map(key => [key, row[key]]));
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  }],
  ['complete live member evidence mutation', f => {
    const state = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json')));
    state['T-49-02'].head_sha = 'f'.repeat(40);
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(state));
  }],
  ['semantically equal original state with changed physical source bytes', f => {
    const state = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'delivery-state.json')));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(state, null, 2));
  }],
]) test('Claude architecture current binding refuses ' + name, async () => {
  await claudeFixture(async f => {
    const fresh = await runClaudeCurrentReview(f, 'arch-review');
    const manifestBytes = fs.readFileSync(fresh.artifact.ref);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, true, admissionDiagnostic(f, consumer));
    mutate(f);
    for (const consumer of consumers) assert.equal(consumer(currentSubject(f)).architecture.ready, false);
    assert.deepEqual(fs.readFileSync(fresh.artifact.ref), manifestBytes);
  });
});

for (const role of ['arch-review']) for (const [name, mutate] of [
  ['missing physical stream', pin => fs.unlinkSync(pin.path)],
  ['changed original final JSON', pin => {
    const rows = fs.readFileSync(pin.path, 'utf8').trim().split('\n').map(JSON.parse);
    rows.at(-1).structured_output.summary = 'Altered original output';
    fs.writeFileSync(pin.path, serialize(rows));
  }],
  ['truncated original stream', pin => {
    const raw = fs.readFileSync(pin.path); fs.writeFileSync(pin.path, raw.subarray(0, raw.length - 1));
  }],
  ['missing physical semantic transcript', (_pin, native) => fs.unlinkSync(native.path)],
  ['changed original semantic transcript', (_pin, native) => fs.appendFileSync(native.path, '\n')],
]) test('Claude ' + role + ' current consumers refuse ' + name, async () => {
  await claudeFixture(async f => {
    const fresh = await runClaudeCurrentReview(f, role);
    const receipt = fresh.dispatch.receipt;
    mutate(receipt.transcript, claudeNativePin(receipt));
    for (const consumer of consumers) {
      const admitted = consumer(currentSubject(f));
      if (role === 'arch-review') assert.equal(admitted.architecture.ready, false);
      else assert.equal(admitted.integration, null);
    }
  });
});

async function claudeFixture(action) {
  await fixture(async f => {
    const originalConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(f.root, '.claude');
    try { await action(f); }
    finally {
      if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    }
  });
}

function claudeNativePin(receipt) {
  const pin = receipt.selection_evidence.transcript;
  return { ...pin, path: path.join(path.dirname(receipt.transcript.path), 'projects', pin.path) };
}

async function runClaudeCurrentReview(f, role, edit = {}) {
  const claudeRuntime = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const captureStart = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs').capture;
  const streamRegistry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/claude-stream.json')));
  const streamPath = streamRegistry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered second-runtime originals are required');
  const stream = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
  const session = crypto.randomUUID();
  const options = { ...projectOptions(f), getPullRequest: () => f.pr, controller: false,
    storageRoot: path.join(f.root, 'claude-' + role),
    createRuntimeHost({ scope, recorderDir, transcriptDir }) {
      const originalHost = claudeRuntime.createClaudeRuntimeHost({ scope, recorderDir, transcriptDir,
        startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
        uuid: () => session, sessionTranscriptRoot: path.join(f.root, 'claude-native'),
        probe: { status: 'available', executable: 'claude-fixture', runtime_version: streamRegistry.cli_version,
          capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
        spawn(_file, args) {
          const childProcess = new EventEmitter(); childProcess.pid = process.pid;
          childProcess.stdout = new EventEmitter(); childProcess.stderr = new EventEmitter();
          let framedInput = '';
          childProcess.stdin = { write(value) { framedInput += value; }, end() {
            process.nextTick(() => {
              assert.ok(framedInput.endsWith('\n'));
              const userInput = JSON.parse(framedInput.slice(0, -1));
              f.lastClaudeUserInput = structuredClone(userInput);
              const prompt = userInput.message.content;
              const fileMatch = /<AUTHENTICATED_FOCUSED_INPUT>\s*([\s\S]*?)\s*<\/AUTHENTICATED_FOCUSED_INPUT>/.exec(prompt);
              const encoded = fileMatch ? JSON.parse(collector.verifyFileInput(JSON.parse(fileMatch[1]), { sealed: true }).material[0])
                : JSON.parse(prompt.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0]);
              const packet = packets.decodeUniqueContent(encoded), context = packet.role_context;
              f.lastClaudePacket = structuredClone(packet);
              let result;
              if (role === 'arch-review' && !context.focused) {
                result = { id: packet.subject, pr: f.pr.number, head: f.head,
                  base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
                  ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
                  verdict: 'conform', blocking_count: 0, summary: 'Complete original legacy architecture fixture', findings: [] };
                write(f.worktree, '.shipyard-arch-review-evidence.md', 'Complete original architecture fixture evidence.\n');
              } else if (role === 'arch-review') {
                const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
                  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
                    : JSON.stringify(value);
                const contextDigest = hash(stable(packet));
                const echoed = JSON.parse(/Echo these focused subject fields: ([^\n]+)/.exec(prompt)[1]);
                assert.equal(echoed.context_digest, contextDigest);
                assert.equal(echoed.launch_digest, hash(stable({ packet_digest: contextDigest,
                  reference_digest: context.reference_digest })));
                result = { ...context.focused, context_digest: contextDigest,
                  launch_digest: hash(stable({ packet_digest: contextDigest, reference_digest: context.reference_digest })),
                  review_completeness: 'complete', limitations: [], unresolved_sources: [],
                  evidence_markdown: 'Complete original architecture fixture evidence.\n',
                  id: packet.subject, pr: f.pr.number, head: f.head,
                  base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
                  ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
                  verdict: 'conform', blocking_count: 0, summary: 'Complete original architecture fixture', findings: [] };
                write(f.worktree, '.shipyard-arch-review-evidence.md', 'Complete original architecture fixture evidence.\n');
              }
              edit.originalResult?.(result);
              const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
              const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
              const init = template(stream, row => row.type === 'system' && row.subtype === 'init');
              Object.assign(init, { session_id: session, model, cwd: f.worktree });
              const assistant = template(stream, row => row.type === 'assistant');
              assistant.session_id = session; assistant.message.model = observedModel;
              assistant.message.content[0].input = result;
              const final = template(stream, row => row.type === 'result');
              Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
              const nativeFile = path.join(f.root, 'claude-native/project', session + '.jsonl');
              fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
              const nativeAssistant = structuredClone(assistant);
              Object.assign(nativeAssistant, { sessionId: session, effort });
              const native = [{ ...userInput, sessionId: session }, nativeAssistant];
              edit.native?.(native);
              fs.writeFileSync(nativeFile, serialize(native));
              const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
              const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
              const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
              captureStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
                transcript_path: nativeFile, cwd: f.worktree }, {
                evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
              let raw = serialize([init, assistant, final]);
              if (edit.stream) raw = edit.stream(raw);
              childProcess.stdout.emit('data', Buffer.from(raw)); childProcess.emit('close', 0, null);
            });
          } };
          return childProcess;
        } });
      if (!edit.result) return originalHost;
      const originals = new WeakMap();
      return { ...originalHost, async agent(...args) {
        const original = await originalHost.agent(...args);
        const output = structuredClone(original.output); edit.result(output);
        const changed = { ...original, output }; originals.set(changed, original); return changed;
      }, applicationEvidence({ result }) {
        return originalHost.applicationEvidence({ result: originals.get(result) });
      } };
    } };
  if (edit.legacy) {
    assert.equal(role, 'arch-review');
    const dispatchId = 'legacy-claude-original-' + ++f.count;
    currentInput(f, role, dispatchId, { legacy: true });
    const prepared = f.lastArchitecture.prepared;
    const reference = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs').loadClaudeReferenceContent(role);
    const packet = packets.buildContextPacket({ root: f.worktree, role, subject: prepared.ticket,
      sourceRevision: f.head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
      scope: { files_modified: prepared.binding.rows.flatMap(item => item.row.files) },
      acceptance: [], verification: [], requiredRefs: prepared.packet.refs.map(ref => ref.path),
      selectedBacklogIds: [], backlogInventory: 'selected',
      roleContext: { ticket_set: prepared.binding.ticketSet, ticket_set_digest: prepared.binding.membership,
        pr: prepared.packet.pr, exact_diff: prepared.packet.diff,
        adr_refs: prepared.packet.refs.filter(ref => ref.path.startsWith('.planning/architecture/')),
        integration_base: { ref: prepared.base, commit: prepared.baseCommit, tree: prepared.mergeBaseTree },
        reference_digest: { sha256: hash(reference), bytes: Buffer.byteLength(reference) } } });
    const prompt = '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet))
      + '\n</AUTHENTICATED_CONTEXT_PACKET>';
    const host = options.createRuntimeHost({ scope: { worktree: f.worktree, ticket: prepared.ticket,
      phase: 49, run_id: dispatchId }, recorderDir: path.join(f.root, dispatchId, 'receipts'),
      transcriptDir: path.join(f.root, dispatchId, 'transcripts') });
    let launched;
    const adapter = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs').createClaudeDispatchAdapter({
      capabilities: host.capabilities, host: { async launch(selection) {
        launched = await host.agent(prompt, { model: selection.model, effort: selection.effort });
        return host.applicationEvidence({ result: launched });
      } } });
    const dispatch = await boundary.createDispatchBoundary({ adapters: { claude: adapter }, recorder: host.recorder }).dispatch(
      { runtime: 'claude', role, dispatch_id: dispatchId, signals: prepared.signals },
      { ticket: prepared.ticket, subject_kind: 'phase' });
    const result = { ...launched.output, host_context: { graph_dir: f.graphDir, source_root: f.worktree,
      phase_repo: prepared.binding.repo, phase_archive_selection: prepared.packet.phase_archive_selection,
      phase_evidence_digest: prepared.packet.retained_history_digest,
      selected_refs: packet.required_refs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) } };
    edit.selectedRefs?.(result.host_context.selected_refs);
    const artifact = authority.sealJudgment({ worktreePath: f.worktree, role, ticket: prepared.ticket,
      phase: f.phase, pr: f.pr.number, base: prepared.base, recorder: host.recorder, dispatchId,
      ticketSet: prepared.binding.ticketSet, ticketSetDigest: prepared.binding.membership, result,
      evidencePath: path.join(f.worktree, '.shipyard-arch-review-evidence.md') });
    fs.unlinkSync(path.join(f.worktree, '.shipyard-arch-review-evidence.md'));
    return { dispatch, artifact: { ref: artifact.artifact_path }, result };
  }
  return secondRuntime.createClaudeRoleHost(options).run({ schema: secondRuntime.REQUEST_SCHEMA,
    role, worktree: f.worktree, phase: f.phase, pr: f.pr.number });
}

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
    for (const row of Object.values(rows)) write(worktree, row.plan, '---\nphase: 49\nplan: ' + row.plan.match(/49-(\d+)-PLAN/)[1] + '\n---\nADR-014\n## Acceptance criteria\n- Complete merged behavior.\n## Verification commands\n- `node --test tests/unit/phase49-current-review-admission.test.cjs`\n');
    write(worktree, '.planning/architecture/ADR-014-original.md', '# ADR-014\nOriginal complete governing material.\n');
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
    commit(f, 'original implementation'); f.memberHead = f.head;
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
    "developer_instructions = '''", 'Read complete original material.', "'''", '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, selection.agent_file), text);
  const manifest = path.join(dir, '.shipyard-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: selection.policy_version,
    policy_hash: policy.POLICY_HASH, agent_files: [selection.agent_file], agent_digests: { [selection.agent_file]: hash(text) } }));
  return f.agents[role] = { dir, manifest, text, selection,
    capabilities: { supportedModels: [selection.model], supportedEfforts: [selection.effort] } };
}

function currentInput(f, role, dispatchId = 'current-' + role + '-' + ++f.count, options = {}) {
  const binding = f.directTicket ? null : phaseBinding(f);
  const storage = path.join(f.root, 'inputs');
  if (role === 'arch-review') {
    const scope = { worktree: f.worktree, phase: 49, ticket: f.directTicket || binding.subject, run_id: dispatchId };
    const value = collector.prepare(scope, { role, context: {}, signals: {} }, { graphDir: f.graphDir,
      refreshGit: false, getPullRequest: () => f.pr, inflightDispatchId: dispatchId, storageRoot: storage,
      ...(options.legacy ? { readerProfile: collector.createReaderBatchProfile({
        chunk_bytes: 8192, ranges_per_batch: 3,
        candidate: { source_sha256: hash(fs.readFileSync(require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
          instructions_sha256: '0'.repeat(64), model: 'gpt-6.1-sol', effort: 'low', provider: 'openai' },
      }) } : {}) });
    const a = agent(f, role, value.launch.signals);
    collector.admitInstalledLaunch(value, { agentDir: a.dir, agentFile: a.selection.agent_file,
      agentManifest: a.manifest, capabilities: a.capabilities });
    f.lastArchitecture = value;
    const admitted = collector.admittedFileInput(value);
    if (admitted) return admitted;
    const instructions = collector.instructionEvidence(a.dir, a.selection.agent_file, a.manifest);
    return collector.prepareFileInput(scope, JSON.stringify(packets.encodeUniqueContent(value.prepared.packet)), {
      role, dispatchId, storageRoot: storage, graphDir: f.graphDir, architecturePacket: value.prepared.packet,
      generatedInstructionBytes: instructions.generated_instruction_bytes,
      relayPrefix: collector.admittedPrompt(value).split('<AUTHENTICATED_CONTEXT_PACKET>')[0],
      binding: { packet_digest: value.prepared.packet.digest, base: f.base, base_ref: 'refs/remotes/origin/main',
        merge_base: value.prepared.packet.diff.merge_base,
        ticket_set: f.directTicket ? [f.directTicket] : binding.ticketSet.map(item => item.id),
        ticket_set_digest: f.directTicket ? hash(JSON.stringify([f.directTicket])) : binding.membership,
        agent_sha256: instructions.sha256, agent_path: path.join(a.dir, a.selection.agent_file),
        installed_files: instructions.installed_files } });
  }
  const complete = secondRuntime.prepareIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: String(49) });
  f.lastIntegrator = complete;
  const a = agent(f, role, complete.signals);
  const instructions = collector.instructionEvidence(a.dir, a.selection.agent_file, a.manifest);
  const encoded = packets.encodeUniqueContent(complete.packet);
  const referencePath = require('../../plugins/delivery-pipeline/scripts/claude-reference-content.cjs').REFERENCE_PATHS.integrator;
  const reference = fs.readFileSync(referencePath);
  const producerRoot = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
  const producerPins = ['claude-role-host.cjs'].map(name => {
    const bytes = fs.readFileSync(path.join(producerRoot, name));
    return { root: producerRoot, path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  return collector.prepareFileInput({ worktree: f.worktree, phase: 49, ticket: complete.ticket, run_id: dispatchId },
    JSON.stringify(encoded), { role, dispatchId, storageRoot: storage, graphDir: f.graphDir,
      generatedInstructionBytes: instructions.generated_instruction_bytes,
      binding: { base: complete.baseCommit, base_ref: 'refs/remotes/origin/main', merge_base: complete.mergeBase,
        ticket_set: complete.ticketSet.map(record => record.id), ticket_set_digest: complete.ticketSetDigest,
        packet_digest: hash(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(encoded)),
        agent_sha256: instructions.sha256, agent_path: path.join(a.dir, a.selection.agent_file),
        installed_files: [...instructions.installed_files, { root: path.dirname(referencePath),
          path: path.basename(referencePath), bytes: reference.length, sha256: hash(reference) }, ...producerPins] } });
}

function nativeRecords(scope, input, session, selection, resultText, legacy = false, prompt) {
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
  const user = prompt === undefined ? [] : [template(parent,
    record => record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user')];
  if (user.length) {
    user[0].payload.content = [{ type: 'input_text', text: prompt }];
    user[0].payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  }
  return [meta, context, start, ...user, ...reads, final, completion];
}

async function successfulReview(f, role, options = {}) {
  const dispatchId = 'original-' + role + '-' + ++f.count;
  const input = currentInput(f, role, dispatchId, { legacy: role === 'arch-review' });
  const value = role === 'arch-review' ? f.lastArchitecture : null;
  const a = f.agents[role];
  const checked = collector.verifyFileInput(input);
  const ticketSet = value ? value.prepared.binding.ticketSet : f.lastIntegrator.ticketSet;
  assert.equal(hash(JSON.stringify(ticketSet)), input.manifest.binding.ticket_set_digest);
  const scope = { worktree: f.worktree, phase: 49, ticket: input.manifest.ticket, run_id: dispatchId };
  const result = { head: f.head, base_tree: git(f.worktree, 'rev-parse', f.base + '^{tree}'),
    ...(role === 'arch-review' ? { id: scope.ticket, pr: f.pr.number, verdict: 'conform' }
      : { phase: f.phase, outcome: 'passed', base: 'origin/main' }),
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
  { dispatch_id: dispatchId, prompt: options.legacy ? checked.material[0].toString('utf8') : input.prompt,
    ...(options.legacy ? {} : { input_transport: 'host-files', input_bundle: input.input_bundle, input_prepared: input }) });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched }, capabilities: a.capabilities });
  const dispatched = boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch(
    { runtime: 'codex', role, dispatch_id: dispatchId, signals: value?.launch.signals
      || secondRuntime.prepareIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' }).signals },
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
      ticket: scope.ticket, base: 'origin/main', recorder, dispatchId,
      result: judgment, ticketSet, ticketSetDigest: input.manifest.binding.ticket_set_digest, evidencePath });
    sealed = { ref: artifact.artifact_path }; fs.unlinkSync(evidencePath);
  }
  const review = { head: f.head, artifact: sealed.ref, original: fs.readFileSync(sealed.ref),
    dispatched, nativeFile, input, recorder, role };
  f.reviews.push(review); return review;
}
