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

test('actual integration preparation, native adapter and original sealer issue a fresh repair judgment', async () => {
  await fixture(async f => {
    const prior = await successfulReview(f, 'integrator');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'another contributor repair');
    const fresh = await runIntegration(f);
    assert.equal(fresh.coverage.mode, 'incremental', JSON.stringify(fresh.coverage.limitations));
    assert.equal(fresh.coverage.baseline.head, prior.head);
    assert.ok(fresh.coverage.endpoint_delta.some(item => item.path === 'src/provider.cjs'));
    assert.ok(fresh.coverage.impact.paths.includes('src/consumer.cjs'));
    assert.ok(fresh.coverage.inherited.length > 0);
    assert.equal(fresh.result.result.head, f.head);
    assert.equal(fresh.result.result.reviewed_identity.base, f.base);
    assert.equal(fresh.result.result.reviewed_identity.merge_base, git(f.worktree, 'merge-base', f.base, f.head));
    assert.deepEqual(fresh.result.result.ticket_set.map(item => item.id), ['T-49-01', 'T-49-02']);
    assert.notEqual(fresh.result.receipt.dispatch_id, prior.dispatched.dispatch_id);
    assert.notEqual(fresh.result.artifact.artifact_path, prior.artifact);
    assert.deepEqual(fs.readFileSync(prior.artifact), prior.original);
    assert.equal(collector.reviewProgressIdentity(fresh.input).head, f.head);
  });
});

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

function prepareCurrentIntegration(f) {
  const context = secondRuntime.prepareIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' });
  const a = agent(f, 'integrator', context.signals);
  const scope = { worktree: f.worktree, repository: context.canonical.commonPath, phase: 49,
    ticket: context.ticket, run_id: 'fresh-integrator-' + ++f.count };
  const request = { role: 'integrator', dispatch_id: scope.run_id, signals: {},
    context: { review_contract: 'shipyard.integration-review.v2' } };
  const options = { ...projectOptions(f), scope, capabilities: a.capabilities,
    agentDir: a.dir, agentManifest: a.manifest, storageRoot: path.join(f.root, 'delivery-state'), env: { CODEX_HOME: process.env.CODEX_HOME } };
  const input = delivery.prepareIntegratorInput(scope, request, options);
  const packet = packets.decodeUniqueContent(JSON.parse(collector.verifyFileInput(input).material[0]));
  return { input, scope, request, options, coverage: packet.role_context.review_coverage, a };
}

function coveredResult(prepared) {
  const { input, coverage } = prepared;
  const checked = collector.verifyFileInput(input);
  return { outcome: 'passed', phase: coverage.reviewed_identity.phase,
    head: coverage.reviewed_identity.head, head_tree: coverage.reviewed_identity.head_tree,
    base: 'origin/main', base_tree: coverage.reviewed_identity.base_tree,
    ticket_set: coverage.current_membership.ticket_set, ticket_set_digest: coverage.current.ticket_set_digest,
    reviewed_identity: coverage.reviewed_identity,
    coverage: coverageResult(coverage),
    context_digest: input.manifest.binding.packet_digest, input_manifest_sha256: input.input_bundle.manifest_sha256,
    input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
    input_chunk_reads: checked.chunk_reads, blocking_count: 0, findings: [],
    summary: 'Fresh complete current integration fixture', evidence_markdown: 'Fresh integration evidence with inherited/new/impact/limitations coverage.' };
}

function coverageResult(coverage) {
  return { schema: 'shipyard.integration-coverage-result.v1', mode: coverage.mode, lineage_digest: coverage.digest,
    inherited_obligations: coverage.current_logical_obligations.filter(item => item.coverage === 'inherited').map(item => item.identity),
    newly_reviewed_obligations: coverage.current_logical_obligations.filter(item => item.coverage !== 'inherited').map(item => item.identity),
    impact_paths: coverage.impact.paths, limitations: coverage.limitations };
}

async function runIntegration(f, edit = {}) {
  const prepared = prepareCurrentIntegration(f);
  const { input, scope, request, options, a } = prepared;
  const result = structuredClone(coveredResult(prepared));
  edit.result?.(result);
  const resultText = JSON.stringify(result), session = crypto.randomUUID();
  const native = nativeRecords(scope, input, session, a.selection, resultText);
  edit.native?.(native);
  const now = new Date();
  const directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, session + '.jsonl'), serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
    .map(type => template(cli, record => record.type === type));
  records[0].thread_id = session; records[2].item.text = resultText;
  const recorder = boundary.createDurableRecorder(path.join(f.root, 'receipts'));
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: options.env, transcriptDir: path.join(f.root, 'transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const processFixture = new EventEmitter();
      processFixture.stdout = new EventEmitter(); processFixture.stderr = new EventEmitter(); processFixture.pid = process.pid;
      processFixture.stdin = { write() {}, end() { process.nextTick(() => {
        processFixture.stdout.emit('data', Buffer.from(serialize(records))); processFixture.emit('close', 0);
      }); } };
      return processFixture;
    } });
  edit.beforeLaunch?.(prepared);
  const dispatched = await delivery.createCodexDeliveryHost({ ...options, host, fileInputContext: input }).run(request);
  return { ...prepared, result: dispatched };
}

test('missing integration lineage remains full while independently eligible architecture lineage exists', async () => {
  await fixture(async f => {
    const architecture = await successfulReview(f, 'arch-review');
    const selected = authority.selectReviewBaseline({ currentInput: currentInput(f, 'arch-review') });
    assert.equal(selected.mode, 'incremental', JSON.stringify(selected));
    assert.equal(selected.baseline.dispatch_id, architecture.dispatched.dispatch_id);
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'independent contributor repair');
    const fresh = await runIntegration(f);
    assert.equal(fresh.coverage.mode, 'full');
    assert.equal(fresh.coverage.baseline, null);
    assert.deepEqual(fresh.coverage.inherited, []);
    assert.ok(fresh.coverage.limitations.some(item => item.reason === 'complete-current-packet-required'));
    assert.ok(fresh.coverage.current_logical_obligations.every(item => item.coverage !== 'inherited'));
    assert.deepEqual(fs.readFileSync(architecture.artifact), architecture.original);
  });
});

test('legacy original integration cannot silently supply incremental authority', async () => {
  await fixture(async f => {
    const legacy = await successfulReview(f, 'integrator', { legacy: true });
    const fresh = await runIntegration(f);
    assert.equal(fresh.coverage.mode, 'full');
    assert.equal(fresh.coverage.baseline, null);
    assert.deepEqual(fs.readFileSync(legacy.artifact), legacy.original);
  });
});

test('a shared contract change conservatively requires complete integration reading', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    write(f.worktree, 'src/contract.json', '{"version":2}\n'); commit(f, 'shared contract repair');
    const fresh = await runIntegration(f);
    assert.equal(fresh.coverage.mode, 'full');
    assert.ok(fresh.coverage.limitations.some(item => item.reason === 'governing-or-contract-change'));
    assert.deepEqual(fresh.coverage.inherited, []);
    assert.ok(fresh.coverage.newly_reviewed.some(item => item.path === 'src/contract.json'));
  });
});

test('changed base and complete current member set invalidate inheritance independently', async () => {
  await fixture(async f => {
    await successfulReview(f, 'integrator');
    const originalBase = f.base;
    git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head);
    f.base = f.head;
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'repair after changed integration base');
    const changedBase = await runIntegration(f);
    assert.equal(changedBase.coverage.mode, 'full');
    assert.notEqual(changedBase.result.result.reviewed_identity.base, originalBase);
    const id = 'T-49-03';
    f.rows[id] = { ...f.rows['T-49-02'], branch: 'ticket/' + id,
      plan: '.planning/phases/' + f.phase + '/49-03-PLAN.md' };
    f.state[id] = { status: 'merged', pr: 103, branch: f.rows[id].branch };
    write(f.worktree, f.rows[id].plan, fs.readFileSync(path.join(f.worktree, f.rows['T-49-02'].plan), 'utf8').replace('plan: 02', 'plan: 03'));
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: f.rows }));
    write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
    commit(f, 'another contributor membership');
    const changedSet = await runIntegration(f);
    assert.equal(changedSet.coverage.mode, 'full');
    assert.deepEqual(changedSet.result.result.ticket_set.map(item => item.id), ['T-49-01', 'T-49-02', 'T-49-03']);
  });
});

for (const [name, edit] of [
  ['old HEAD', result => { result.reviewed_identity.head = '0'.repeat(40); }],
  ['old base', result => { result.reviewed_identity.base = '0'.repeat(40); }],
  ['incomplete membership', result => { result.ticket_set.pop(); }],
  ['uncovered obligation', result => { result.coverage.newly_reviewed_obligations.pop(); }],
  ['forged lineage', result => { result.coverage.lineage_digest = '0'.repeat(64); }],
  ['unknown coverage version', result => { result.coverage.schema = 'shipyard.integration-coverage-result.v9'; }],
  ['omitted impact boundary', result => { result.coverage.impact_paths.pop(); }],
  ['omitted limitations', result => { result.coverage.limitations = []; }],
  ['missing original evidence', result => { delete result.evidence_markdown; }],
]) test('fresh integration refuses ' + name, async () => {
  await fixture(async f => {
    await assert.rejects(runIntegration(f, { result: edit }), error => ['ARTIFACT_IDENTITY_MISMATCH', 'INVALID_RESULT'].includes(error.code));
  });
});

test('native incomplete reads cannot produce a sealed fresh integration verdict', async () => {
  await fixture(async f => {
    await assert.rejects(runIntegration(f, { native(records) {
      const index = records.findLastIndex(item => item.payload?.type === 'custom_tool_call_output');
      records.splice(index - 1, 2);
    } }), error => ['RUNTIME_EVIDENCE_MISMATCH', 'REVIEW_INCOMPLETE'].includes(error.code));
  });
});

test('movement after preparation refuses the original current-subject launch', async () => {
  await fixture(async f => {
    await assert.rejects(runIntegration(f, { beforeLaunch() {
      write(f.worktree, 'src/provider.cjs', 'exports.value = 5;\n'); commit(f, 'hidden contributor movement');
    } }), error => ['STALE_CONTEXT', 'REVIEW_RESTART_REQUIRED', 'PREFLIGHT_REFUSED'].includes(error.code));
  });
});

for (const [name, move] of [
  ['base', f => git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head)],
  ['membership', f => {
    const rows = { ...f.rows }; delete rows['T-49-02'];
    write(f.worktree, '.planning/graph/tickets.json', JSON.stringify({ tickets: rows }));
  }],
]) test('live ' + name + ' movement refuses before native integration launch', async () => {
  await fixture(async f => {
    await assert.rejects(runIntegration(f, { beforeLaunch() { move(f); } }),
      error => ['STALE_CONTEXT', 'REVIEW_RESTART_REQUIRED', 'PREFLIGHT_REFUSED'].includes(error.code));
  });
});

test('unknown integration and dictionary versions fail closed while v1 full input stays supported', async () => {
  await fixture(async f => {
    assert.throws(() => delivery.requestValue({ role: 'integrator', context: { review_contract: 'shipyard.integration-review.v9' } }), /unsupported/);
    assert.throws(() => secondRuntime.parseRequest({ schema: secondRuntime.REQUEST_SCHEMA, role: 'integrator',
      worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v9' }), /unsupported/);
    const request = { role: 'integrator', signals: {}, dispatch_id: 'legacy-full', context: {
      review_contract: 'shipyard.integration-review.v1', prompt: 'Complete legacy integration review.' } };
    const full = secondRuntime.prepareIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' });
    const a = agent(f, 'integrator', {});
    assert.equal(delivery.prepareIntegratorInput({ worktree: f.worktree, ticket: full.ticket, phase: 49, run_id: 'legacy-full' },
      request, { agentDir: a.dir, agentManifest: a.manifest, capabilities: a.capabilities, graphDir: f.graphDir }), null);
    assert.throws(() => collector.preflightReviewMaterial({ schema: 'shipyard.semantic-content.v9' }), /unsupported/);
    const encoded = packets.encodeUniqueContent(full.packet);
    const changed = structuredClone(encoded);
    changed.dictionary[0].content += 'altered bytes';
    assert.throws(() => packets.decodeUniqueContent(changed), /invalid unique content entry/);
  });
});

test('second runtime producer retains complete inline full review and cannot borrow Codex authority', async () => {
  await fixture(async f => {
    const prior = await successfulReview(f, 'integrator');
    write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'another contributor adapter parity repair');
    const v1 = secondRuntime.prepareIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' });
    const v2 = secondRuntime.prepareIntegratorContext({ ...projectOptions(f), storageRoot: path.join(f.root, 'inline-storage') },
      { worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v2' });
    const encoded = JSON.parse(v2.prompt.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0]);
    const packet = packets.decodeUniqueContent(encoded);
    const coverage = packet.role_context.review_coverage;
    assert.equal(coverage.mode, 'full');
    assert.equal(coverage.baseline, null);
    assert.ok(coverage.limitations.some(item => item.reason === 'unsupported-original-runtime-authority'));
    assert.deepEqual(packet.role_context.ticket_set, v1.packet.role_context.ticket_set);
    assert.deepEqual(packet.required_refs, packets.decodeUniqueContent(packets.encodeUniqueContent(v1.packet)).required_refs);
    assert.equal(packet.role_context.combined_diff.content, v1.packet.role_context.combined_diff.content);
    assert.ok(coverage.impact.paths.includes('src/consumer.cjs'));
    assert.deepEqual(coverage.complete_preflight.ticket_set, v2.ticketSet);
    assert.equal(coverage.reviewed_identity.head, f.head);
    assert.equal(v2.signals.inputTokens, Math.ceil(Buffer.byteLength(v2.prompt) / 4));
    assert.deepEqual(fs.readFileSync(prior.artifact), prior.original);
    assert.throws(() => delivery.prepareIntegrationLineage({ worktree: f.worktree }, { ...v1 }, {}), /private/);
    assert.throws(() => delivery.recheckIntegrationReview({ input: v2.integrationReview.input }), /private/);
    assert.throws(() => delivery.validateIntegrationCoverage({ ...v2.integrationReview }, {}), /private/);
  });
});

test('second runtime adapter fixture seals a fresh full current judgment without a provider process', async () => {
  await fixture(async f => {
    const claudeRuntime = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
    const captureStart = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs').capture;
    const streamRegistry = JSON.parse(fs.readFileSync(path.join(captureRoot, 'boundaries/claude-stream.json')));
    const streamPath = streamRegistry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
    assert.ok(streamPath, 'the second adapter must use registered original templates');
    const stream = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
      .map(JSON.parse).filter(record => !record.shipyard_fixture);
    const session = crypto.randomUUID();
    let launched = 0;
    const options = { ...projectOptions(f), storageRoot: path.join(f.root, 'second-adapter'), controller: false,
      createRuntimeHost({ scope, recorderDir, transcriptDir }) {
        return claudeRuntime.createClaudeRuntimeHost({ scope, recorderDir, transcriptDir,
          uuid: () => session, sessionTranscriptRoot: path.join(f.root, 'second-native'),
          probe: { status: 'available', executable: 'claude-fixture', runtime_version: streamRegistry.cli_version,
            capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
          spawn(_file, args) {
            const processFixture = new EventEmitter(); processFixture.pid = process.pid;
            processFixture.stdout = new EventEmitter(); processFixture.stderr = new EventEmitter();
            let framedInput = '';
            processFixture.stdin = { write(value) { framedInput += value; }, end() {
              process.nextTick(() => {
                launched++;
                assert.ok(framedInput.endsWith('\n'));
                const userInput = JSON.parse(framedInput.slice(0, -1));
                assert.equal(userInput.type, 'user');
                assert.equal(userInput.message.role, 'user');
                const prompt = userInput.message.content;
                const encoded = JSON.parse(prompt.split('<AUTHENTICATED_CONTEXT_PACKET>')[1].split('</AUTHENTICATED_CONTEXT_PACKET>')[0]);
                const packet = packets.decodeUniqueContent(encoded), context = packet.role_context;
                const coverage = context.review_coverage;
                assert.equal(coverage.mode, 'full');
                const result = { outcome: 'passed', phase: context.phase,
                  head: context.combined_diff.head, head_tree: context.combined_diff.head_tree,
                  base: context.integration_base.ref, base_tree: context.integration_base.tree,
                  ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
                  reviewed_identity: coverage.reviewed_identity, coverage: coverageResult(coverage),
                  blocking_count: 0, summary: 'Fresh full adapter fixture judgment', findings: [] };
                write(f.worktree, '.planning/phases/' + f.phase + '/INTEGRATION.md', 'Complete fresh inline adapter fixture evidence.\n');
                const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
                const init = template(stream, record => record.type === 'system' && record.subtype === 'init');
                Object.assign(init, { session_id: session, model, cwd: f.worktree });
                const assistant = template(stream, record => record.type === 'assistant');
                assistant.session_id = session; assistant.message.model = model;
                const final = template(stream, record => record.type === 'result');
                Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
                const nativeFile = path.join(f.root, 'second-native/project', session + '.jsonl');
                fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
                const nativeAssistant = structuredClone(assistant);
                Object.assign(nativeAssistant, { sessionId: session, effort });
                fs.writeFileSync(nativeFile, serialize([nativeAssistant]));
                const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
                const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
                const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
                captureStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
                  transcript_path: nativeFile, cwd: f.worktree }, {
                  evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
                processFixture.stdout.emit('data', Buffer.from(serialize([init, assistant, final])));
                processFixture.emit('close', 0, null);
              });
            } };
            return processFixture;
          } });
      } };
    const fresh = await secondRuntime.createClaudeRoleHost(options).run({ schema: secondRuntime.REQUEST_SCHEMA,
      role: 'integrator', worktree: f.worktree, phase: '49', review_contract: 'shipyard.integration-review.v2' });
    assert.equal(launched, 1);
    assert.equal(fresh.result.head, f.head);
    assert.equal(fresh.result.coverage.mode, 'full');
    assert.deepEqual(fresh.result.ticket_set.map(item => item.id), ['T-49-01', 'T-49-02']);
    assert.equal(fresh.dispatch.receipt.compliance, 'verified');
    assert.ok(fs.existsSync(fresh.artifact.ref));
  });
});

test('actual final caller and reviewer reference require trusted preparation and fresh complete coverage', () => {
  const command = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/commands/deliver.md'), 'utf8');
  const reference = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/references/integrator.md'), 'utf8');
  for (const text of [command, reference]) {
    assert.match(text, /shipyard\.integration-review\.v2/);
    assert.match(text, /shipyard\.integration-coverage-result\.v1/);
    assert.match(text, /reviewed_identity/);
    assert.match(text, /fresh native/);
    assert.match(text, /failed.*(?:history|rejected)/s);
  }
  assert.match(command, /selectReviewBaseline\(\{currentInput\}\)/);
  assert.match(command, /buildReviewImpactPacket\(currentInput, selection\)/);
  assert.match(command, /createCodexDeliveryHost[\s\S]*review_contract: 'shipyard\.integration-review\.v2'/);
  assert.match(command, /createClaudeRoleHost\(options\)\.run/);
  assert.match(reference, /inherited_obligations/);
  assert.match(reference, /newly_reviewed_obligations/);
  assert.match(reference, /input_manifest_sha256/);
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
    for (const row of Object.values(rows)) write(worktree, row.plan, '---\nphase: 49\nplan: ' + row.plan.match(/49-(\d+)-PLAN/)[1] + '\n---\nADR-014\n## Acceptance criteria\n- Complete merged behavior.\n## Verification commands\n- `node --test tests/unit/phase49-incremental-integration.test.cjs`\n');
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
    const admitted = collector.admittedFileInput(value);
    if (admitted) return admitted;
    const instructions = collector.instructionEvidence(a.dir, a.selection.agent_file, a.manifest);
    return collector.prepareFileInput(scope, JSON.stringify(packets.encodeUniqueContent(value.prepared.packet)), {
      role, dispatchId, storageRoot: storage, graphDir: f.graphDir, architecturePacket: value.prepared.packet,
      generatedInstructionBytes: instructions.generated_instruction_bytes,
      relayPrefix: collector.admittedPrompt(value).split('<AUTHENTICATED_CONTEXT_PACKET>')[0],
      binding: { packet_digest: value.prepared.packet.digest, base: f.base, base_ref: 'refs/remotes/origin/main',
        merge_base: value.prepared.packet.diff.merge_base,
        ticket_set: binding.ticketSet.map(item => item.id), ticket_set_digest: binding.membership,
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
  const producerPins = ['claude-role-host.cjs', 'phase-integrator-preflight.cjs'].map(name => {
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
