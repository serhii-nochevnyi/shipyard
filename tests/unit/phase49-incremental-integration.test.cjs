'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
let authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
let collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
let runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
let boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
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

test('large real integration proves bounded preparation and reconstruction without native semantic credit', async () => {
  await fixture(async f => {
    const legacy = 16 * 1024 * 1024, approved = 32 * 1024 * 1024;
    const contents = boundedCapacitySources(f);
    const sourceBytes = [...contents.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    assert.ok(sourceBytes < legacy);
    const prepared = prepareCurrentIntegration(f, { automaticReader: true });
    const checked = collector.verifyFileInput(prepared.input);
    const original = collector.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });
    assert.equal(checked.manifest.transport.schema, 'shipyard.native-reader-transport.v3');
    assert.equal(checked.manifest.transport.output_budget_bytes, 252 * 1024);
    assert.equal(checked.manifest.transport.output_tokens, 10000);
    assert.equal(checked.schedule.semantic_credit, false);
    assert.ok(checked.schedule.range_count > 2064 && checked.schedule.range_count <= 4160);
    assert.throws(() => collector.requireReaderBatchCapacity(prepared.input), /capacity|measurement/);

    const encoded = JSON.parse(checked.material[0]);
    const packet = packets.decodeUniqueContent(encoded, approved);
    const originalPacket = packets.decodeUniqueContent(JSON.parse(original.material[0]), approved);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) > legacy);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= approved);
    const { digest: lineageDigest, reviewed_identity: _reviewed, original_input: _input,
      complete_preflight: _preflight, ...lineage } = prepared.coverage;
    const rawLineage = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs')
      .stableStringify({ ...lineage, original_packet: JSON.parse(original.material[0]) });
    assert.ok(Buffer.byteLength(rawLineage) > legacy && Buffer.byteLength(rawLineage) <= approved);
    assert.equal(hash(rawLineage), lineageDigest);

    assert.ok(checked.material[0].length > legacy && checked.material[0].length <= approved);
    assert.equal(checked.manifest.accounting.material_bytes, checked.material[0].length);
    assert.equal(prepared.input.input_bundle.total_bytes, checked.material[0].length);
    for (const verified of [original, checked]) {
      assert.equal(verified.manifest.role, 'integrator');
      assert.equal(verified.manifest.binding.review_contract, 'shipyard.integration-review.v2');
      assert.equal(verified.manifest.max_chunk_reads, 4160);
      assert.equal(verified.chunk_reads, Math.ceil(verified.manifest_bytes.length / 8192)
        + verified.manifest.assets.reduce((sum, asset) => sum + Math.ceil(asset.bytes / 8192), 0));
      for (const [index, asset] of verified.manifest.assets.entries()) {
        assert.equal(asset.bytes, verified.material[index].length);
        assert.equal(asset.sha256, hash(verified.material[index]));
      }
    }
    assert.deepEqual(packet.role_context.combined_diff, originalPacket.role_context.combined_diff);
    assert.deepEqual(packet.required_refs, originalPacket.required_refs);
    assert.deepEqual(prepared.coverage.current_membership.ticket_set, packet.role_context.ticket_set);
    assert.equal(prepared.coverage.semantic_credit, false);
    for (const [name, content] of contents) {
      assert.ok(prepared.coverage.source_inventories.current.some(entry => entry.path === name));
      assert.ok(prepared.coverage.source_inventories.baseline.some(entry => entry.path === name));
      assert.equal(prepared.coverage.endpoint_delta.find(entry => entry.path === name).status, 'M');
      assert.ok(prepared.coverage.endpoint_delta.some(entry => entry.path === name));
      assert.ok(prepared.coverage.impact.paths.includes(name));
      const affected = prepared.coverage.newly_reviewed.find(entry => entry.path === name);
      assert.equal(affected.content, content);
      assert.equal(affected.bytes, Buffer.byteLength(content));
      assert.equal(affected.sha256, hash(content));
      assert.ok(packet.role_context.combined_diff.content.includes('diff --git a/' + name));
    }
    assert.equal(encoded.accounting.logical_obligations, encoded.obligations.length);
    assert.equal(encoded.accounting.logical_content_bytes, encoded.obligations.reduce((sum, item) =>
      sum + encoded.dictionary.find(entry => entry.sha256 === item.content_sha256).bytes, 0));
    assert.equal(encoded.dictionary_sha256, hash(JSON.stringify(encoded.dictionary)));
    assert.equal(encoded.obligations_sha256, hash(JSON.stringify(encoded.obligations)));
    assert.throws(() => packets.decodeUniqueContent(encoded), /exceeds its bound/);
    assert.throws(() => collector.verifyFileInput(JSON.parse(JSON.stringify(prepared.input))), /private producer/);
    assert.throws(() => delivery.prepareIntegratorInput(prepared.scope, {
      ...prepared.request, context: { ...prepared.request.context } }, {
      ...prepared.options, fileInputContext: { ...prepared.input } }), /private producer/);
    assert.deepEqual(JSON.parse(JSON.stringify(packets.encodeUniqueContent(packet, approved))), encoded);
    assert.deepEqual(JSON.parse(JSON.stringify(packets.encodeUniqueContent(originalPacket, approved))), JSON.parse(original.material[0]));
    assert.throws(() => packets.encodeUniqueContent(packet), /exceeds its bound/);
    const tampered = structuredClone(encoded);
    tampered.dictionary[0].content += 'changed';
    assert.throws(() => packets.decodeUniqueContent(tampered, approved), /hash|bytes|digest|content/i);
    assert.throws(() => collector.restoreCompletedSourceInput({ input: prepared.input }), /protected custody/);
    assert.equal(authority.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName }), null);

  });
});

test('genuine integration refuses transient lineage over 32 MiB while source stages fit 16 MiB', async () => {
  await fixture(async f => {
    const contents = boundedCapacitySources(f, true);
    const sourceBytes = [...contents.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    assert.ok(sourceBytes < 16 * 1024 * 1024);
    const producer = secondRuntime.prepareNativeIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' });
    const rawBytes = Buffer.byteLength(JSON.stringify(producer.packet));
    assert.ok(rawBytes <= 32 * 1024 * 1024);
    assert.ok(Buffer.byteLength(producer.packet.role_context.combined_diff.content) < 6 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(producer.packet))
      + Buffer.byteLength(JSON.stringify([...contents.values()])) > 32 * 1024 * 1024);
    assert.throws(() => prepareCurrentIntegration(f), error => error.code === 'CONTEXT_OVER_BOUND'
      && /complete impact packet exceeds its bound/.test(error.message)
      && Number(error.message.match(/observed (\d+)/)?.[1]) > 32 * 1024 * 1024);

  });
});

function boundedCapacitySources(f, escaped = false) {
  const contents = new Map();
  for (let index = 0; index < 3; index++) {
    const name = 'src/capacity-' + index + '.txt';
    const body = ('complete ' + index + ' ' + (escaped ? '\\' : 'x').repeat(108) + '\n').repeat(42000);
    write(f.worktree, name, body + 'before\n');
    const changed = index === 0
      ? body.split('\n').map((line, lineIndex) => lineIndex < 11500
        ? line.replaceAll(escaped ? '\\' : 'x', escaped ? '"' : 'y') : line).join('\n') : body;
    contents.set(name, changed + 'after\n');
  }
  commit(f, 'retain complete capacity sources in base');
  f.base = f.head; f.pr.baseRefOid = f.base;
  git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  for (const [name, content] of contents) write(f.worktree, name, content);
  write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n');
  commit(f, 'bounded endpoint changes over retained sources');
  const rawDiff = execFileSync('git', ['-C', f.worktree, 'diff', '--no-ext-diff', '--no-textconv',
    '--unified=50', f.base, f.head], { encoding: 'utf8', maxBuffer: 6 * 1024 * 1024 });
  assert.ok(Buffer.byteLength(rawDiff) < 6 * 1024 * 1024);
  assert.equal(contents.size, 3);
  const sourceBytes = [...contents.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  assert.ok(sourceBytes < 16 * 1024 * 1024);
  const scanned = new Map();
  for (const revision of [f.base, f.head]) for (const file of ['src/provider.cjs', 'src/consumer.cjs', 'src/unchanged.cjs']) {
    const object = git(f.worktree, 'rev-parse', revision + ':' + file);
    scanned.set(object, Number(git(f.worktree, 'cat-file', '-s', object)));
  }
  const scanBytes = [...scanned.values()].reduce((sum, bytes) => sum + bytes, 0);
  assert.ok(scanBytes > 0 && scanBytes < 16 * 1024 * 1024);
  const retainedBytes = sourceBytes + ['src/provider.cjs', 'src/consumer.cjs'].reduce((sum, file) =>
    sum + Number(git(f.worktree, 'cat-file', '-s', f.head + ':' + file)), 0);
  assert.ok(retainedBytes > sourceBytes && retainedBytes < 16 * 1024 * 1024);
  return contents;
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

function prepareCurrentIntegration(f, extraOptions = {}) {
  const context = secondRuntime.prepareNativeIntegratorContext(projectOptions(f), { worktree: f.worktree, phase: '49' });
  const a = agent(f, 'integrator', context.signals);
  const scope = { worktree: f.worktree, repository: context.canonical.commonPath, phase: 49,
    ticket: context.ticket, run_id: 'fresh-integrator-' + ++f.count };
  const request = { role: 'integrator', dispatch_id: scope.run_id, signals: {},
    context: { review_contract: 'shipyard.integration-review.v2' } };
  const options = { ...projectOptions(f), ...extraOptions, scope, capabilities: a.capabilities,
    agentDir: a.dir, agentManifest: a.manifest, storageRoot: path.join(f.root, 'delivery-state'), env: { CODEX_HOME: process.env.CODEX_HOME } };
  const input = delivery.prepareIntegratorInput(scope, request, options);
  const packet = packets.decodeUniqueContent(JSON.parse(collector.verifyFileInput(input).material[0]), 32 * 1024 * 1024);
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
  const prepared = edit.prepared || prepareCurrentIntegration(f);
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
  return { ...prepared, recorder, result: dispatched };
}

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
    let launched = 0, suppliedUserInput;
    const options = { ...projectOptions(f), storageRoot: path.join(f.root, 'second-adapter'), controller: false,
      createRuntimeHost({ scope, recorderDir, transcriptDir }) {
        return claudeRuntime.createClaudeRuntimeHost({ scope, recorderDir, transcriptDir,
          startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
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
                suppliedUserInput = userInput;
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
                const observedModel = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
                const init = template(stream, record => record.type === 'system' && record.subtype === 'init');
                Object.assign(init, { session_id: session, model, cwd: f.worktree });
                const assistant = template(stream, record => record.type === 'assistant');
                assistant.session_id = session; assistant.message.model = observedModel;
                assistant.message.content[0].input = result;
                const final = template(stream, record => record.type === 'result');
                Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
                const nativeFile = path.join(f.root, 'second-native/project', session + '.jsonl');
                fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
                const nativeAssistant = structuredClone(assistant);
                Object.assign(nativeAssistant, { sessionId: session, effort });
                fs.writeFileSync(nativeFile, serialize([{ ...userInput, sessionId: session }, nativeAssistant]));
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
    const receipt = fresh.dispatch.receipt;
    const native = fs.readFileSync(path.join(path.dirname(receipt.transcript.path), 'projects', receipt.selection_evidence.transcript.path));
    assert.equal(native.length, receipt.selection_evidence.transcript.bytes);
    assert.equal(hash(native), receipt.selection_evidence.transcript.sha256);
    const users = native.toString('utf8').trim().split('\n').map(JSON.parse)
      .filter(row => row.type === 'user' && row.sessionId === receipt.session_id);
    assert.equal(users.length, 1);
    assert.deepEqual(users[0].message, suppliedUserInput.message);
    assert.ok(fs.existsSync(fresh.artifact.ref));
  });
});

function partitionFixtureFunctions(file, names, bindings = {}) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const declarations = names.map(name => {
    const start = source.indexOf('\nfunction ' + name + '(');
    assert.ok(start >= 0, 'existing runtime fixture declaration: ' + name);
    const ends = ['\nfunction ', '\ntest(', '\nfor ('].map(marker => source.indexOf(marker, start + 1))
      .filter(index => index > start);
    return source.slice(start, Math.min(...ends));
  }).join('\n');
  return new Function('require', '__dirname', 'fs', 'path', 'crypto', 'assert', 'EventEmitter', ...Object.keys(bindings),
    declarations + '\nreturn { ' + names.join(', ') + ' };')(
    require, __dirname, fs, path, crypto, assert, EventEmitter, ...Object.values(bindings));
}

function publicPartitionFixture(f, nativeRuntime, controls = {}) {
  const remote = path.join(f.root, 'origin.git');
  git(f.worktree, 'clone', '--bare', '--quiet', f.worktree, remote);
  git(f.worktree, 'remote', 'add', 'origin', remote);
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const live = projectOptions(f);
  const prs = Object.values(f.rows).flatMap(row => live.listPullRequests({ branch: row.branch }));
  fs.writeFileSync(path.join(bin, 'gh'), '#!' + process.execPath + '\n' + `
const prs = ${JSON.stringify(prs)};
const args = process.argv.slice(2);
if (args[0] !== 'pr') process.exit(2);
if (args[1] === 'list' && args.includes('--head')) {
  process.stdout.write(JSON.stringify(prs.filter(pr => pr.headRefName === args[args.indexOf('--head') + 1])));
} else if (args[1] === 'view') {
  const pr = prs.find(pr => pr.number === Number(args[2]));
  if (!pr) process.exit(2);
  process.stdout.write(JSON.stringify(pr));
} else process.exit(2);
`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  let recorder = boundary.createDurableRecorder(path.join(f.root, nativeRuntime + '-public-receipts'));
  let options;
  if (nativeRuntime === 'codex') {
    const { codexPartitionFixture } = partitionFixtureFunctions('codex-delivery-host.test.cjs', ['codexPartitionFixture']);
    ({ options } = codexPartitionFixture(f,
      { projectOptions, agent, template, parent, cli, serialize }, controls));
    options.recorder = recorder;
  } else {
    const { fakeRuntimeFactory, claudePartitionCapacity } = partitionFixtureFunctions('claude-role-host.test.cjs',
      ['fakeRuntimeFactory', 'claudePartitionCapacity'], {
        stable: require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify,
        livePr: () => f.pr, createDurableRecorder: boundary.createDurableRecorder,
      });
    const original = { root: f.worktree, kind: 'integrator', storageRoot: path.join(f.root, 'claude-public') };
    options = { ...projectOptions(f), storageRoot: original.storageRoot,
      integrationCapacity: claudePartitionCapacity(original, controls),
      createRuntimeHost: fakeRuntimeFactory(original, { originalStream: true,
        observedTelemetry: controls.observed === true,
        mutateObservation: (rows, stream, final) => controls.observation?.(rows, stream, final),
        onLaunch(input) {
          const payload = JSON.parse(input.match(/<AUTHENTICATED_INTEGRATION_PARTITION>\s*([\s\S]*?)\s*<\/AUTHENTICATED_INTEGRATION_PARTITION>/)[1]);
          (controls.launches ||= []).push({ input, payload });
          controls.onLaunch?.(input, payload);
        }, mutateResult: (result, payload) => controls.result?.(result, payload) }) };
    const createRuntimeHost = options.createRuntimeHost;
    options.createRuntimeHost = input => {
      const host = createRuntimeHost(input);
      recorder = host.recorder;
      return host;
    };
    options.integrationCapacity.recorder = recorder;
  }
  options.integrationCapacity.capacity.unit_input_bytes = 128 * 1024;
  if (controls.observed) delete options.integrationCapacity;
  return { options, get recorder() { return recorder; }, controls };
}

async function publicIntegrationFixture(action) {
  const previousPath = process.env.PATH, previousGraph = process.env.SHIPYARD_GRAPH_DIR;
  try {
    delete process.env.SHIPYARD_GRAPH_DIR;
    await fixture(action);
  } finally {
    process.env.PATH = previousPath;
    if (previousGraph === undefined) delete process.env.SHIPYARD_GRAPH_DIR; else process.env.SHIPYARD_GRAPH_DIR = previousGraph;
  }
}

async function supportedPartitionCaller(f, nativeRuntime, options) {
  const command = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/commands/deliver.md'), 'utf8');
  const section = command.slice(command.indexOf('**Fresh final integration contract.**'));
  const snippet = section.match(/```javascript\n([\s\S]*?)\n\s*```/)[1];
  let preliminary = 0;
  const supportedRequire = file => file.endsWith('/claude-role-host.cjs') ? { ...secondRuntime,
    prepareIntegratorContext() { assert.fail('preliminary legacy full-inline formatting is forbidden'); },
    prepareNativeIntegratorContext(...args) {
      preliminary++;
      const prepared = secondRuntime.prepareNativeIntegratorContext(...args);
      assert.equal(prepared.prompt, undefined, 'native preliminary collection must not format a full inline prompt');
      return prepared;
    } } : require(file);
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require', 'CLAUDE_PLUGIN_ROOT', 'options', 'worktree', 'phase', 'run_id', 'dispatch_id', 'runtime',
    snippet + '\nreturn result;');
  const result = await run(supportedRequire, path.resolve(__dirname, '../../plugins/delivery-pipeline'),
    options, f.worktree, 49, 'supported-v3-' + ++f.count, 'supported-v3-' + f.count, nativeRuntime);
  assert.equal(preliminary, 1, 'execute the actual documented caller on each supported branch');
  return result;
}

function currentPartitionConsumer(f) {
  const input = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
    graphDir: f.graphDir, headBranch: f.pr.headRefName };
  const current = authority.currentIntegrationVerdict(input);
  const gate = require('../../plugins/delivery-pipeline/scripts/gate-trailer.cjs').verifyCurrentReviews({
    ...input, pr: f.pr.number, getPullRequest: () => ({ ...f.pr }) });
  assert.deepEqual(gate.integration, current, 'normal gate must consume the same authenticated current final');
  assert.equal(gate.architecture.ready, false, 'integration fixtures cannot satisfy fresh architecture');
  return current;
}

function partitionManifests(f) {
  return authority.authenticatedArchivePins(f.worktree).filter(pin => pin.path.endsWith('/.shipyard-role-artifact.json'))
    .map(pin => JSON.parse(fs.readFileSync(path.join(f.worktree, pin.path))));
}

function originalPartitionSessions(f, nativeRuntime, recorder, controls) {
  const manifests = partitionManifests(f), sessions = [];
  assert.equal(manifests.length, controls.launches.length);
  for (const manifest of manifests) {
    const receipt = recorder.getVerifiedRecord(manifest.dispatch_id).receipt;
    assert.equal(receipt.runtime, nativeRuntime);
    assert.equal(receipt.compliance, 'verified');
    assert.equal(receipt.launch_id, manifest.producer_launch);
    let pin, session;
    if (nativeRuntime === 'codex') {
      const native = receipt.runtime_evidence.native_session_evidence;
      session = native.session_id;
      const files = runtime.nativeSessionCandidates(path.join(process.env.CODEX_HOME, 'sessions'), session);
      assert.equal(files.length, 1);
      pin = { ...native, path: files[0] };
    } else {
      session = receipt.session_id;
      pin = { ...receipt.selection_evidence.transcript,
        path: path.join(path.dirname(receipt.transcript.path), 'projects', receipt.selection_evidence.transcript.path) };
    }
    const raw = fs.readFileSync(pin.path);
    assert.equal(raw.length, pin.bytes); assert.equal(hash(raw), pin.sha256);
    const rows = raw.toString('utf8').trim().split('\n').map(JSON.parse);
    const users = nativeRuntime === 'codex'
      ? rows.filter(row => row.type === 'response_item' && row.payload?.role === 'user')
        .map(row => row.payload.content.map(block => block.text || '').join(''))
      : rows.filter(row => row.type === 'user' && row.sessionId === session).map(row => row.message.content);
    const inputs = users.filter(input => input.includes('<AUTHENTICATED_INTEGRATION_PARTITION>'));
    assert.equal(inputs.length, 1);
    const launch = controls.launches.find(item => hash(item.input) === manifest.input_sha256
      || item.payload.kind === 'phase' && manifest.integration_partition?.kind === 'phase');
    assert.ok(launch, 'original native input must be one actual host stage');
    assert.equal(inputs[0], launch.input, 'preserve actual stdin/native capture; never replace its generated prefix');
    if (nativeRuntime === 'codex') {
      const a = f.agents.integrator;
      const prefix = runtime.generatedInstructions(a.text) + '\n\n';
      assert.ok(inputs[0].startsWith(prefix));
      assert.equal(inputs[0].indexOf(prefix, prefix.length), -1, 'static runtime restores exactly one prefix');
    }
    const nativeResult = nativeRuntime === 'codex'
      ? JSON.parse(rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text)
      : rows.find(row => row.type === 'assistant').message.content[0].input;
    assert.equal(nativeResult.input_sha256, hash(inputs[0]));
    assert.equal(nativeResult.kind, launch.payload.kind);
    assert.equal(nativeResult.plan_sha256, launch.payload.plan_sha256);
    sessions.push({ session, receipt, pin, result: nativeResult, manifest, launch });
  }
  assert.equal(new Set(sessions.map(item => item.session)).size, sessions.length, 'one original session per unit plus distinct final');
  return sessions;
}

for (const nativeRuntime of ['codex', 'claude']) {
  test('supported ' + nativeRuntime + ' v3 caller reaches normal final consumer with linked canonical planning', async () => {
    await publicIntegrationFixture(async f => {
      write(f.worktree, 'src/unchanged.cjs', '// complete current context Ω\n'.repeat(3000));
      commit(f, 'current bounded caller fixture');
      const planning = path.join(f.root, 'coordinator');
      git(f.worktree, 'worktree', 'add', '-qb', 'coordinator', planning, 'HEAD');
      f.graphDir = path.join(planning, '.planning/graph');
      const prepared = publicPartitionFixture(f, nativeRuntime);
      prepared.controls.onLaunch = (_input, payload) => {
        assert.equal(currentPartitionConsumer(f), null, 'even all passing units cannot open the current gate before final');
        assert.equal(fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')), false);
        assert.equal(payload.reviewed_identity.planning_root, planning);
      };
      const result = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
      assert.equal(result.result.kind, 'phase'); assert.equal(result.result.outcome, 'passed');
      const current = currentPartitionConsumer(f);
      assert.equal(current?.authenticated, true);
      assert.equal(current.contract, authority.INTEGRATION_REVIEW_V3);
      const sessions = originalPartitionSessions(f, nativeRuntime, prepared.recorder, prepared.controls);
      const units = sessions.filter(item => item.result.kind === 'unit');
      const finals = sessions.filter(item => item.result.kind === 'phase');
      assert.ok(units.length > 1); assert.equal(finals.length, 1);
      assert.equal(current.dispatch_id, finals[0].receipt.dispatch_id);
      assert.equal(finals[0].launch.payload.primary_segments, undefined);
      assert.equal(finals[0].launch.input.includes(fs.readFileSync(path.join(f.worktree, 'src/unchanged.cjs'), 'utf8')), false,
        'actual final receives bounded conclusions and acceptance rather than the full raw unit sources');
      assert.deepEqual(finals[0].launch.payload.unit_artifacts.map(item => item.dispatch_id).sort(),
        units.map(item => item.receipt.dispatch_id).sort());
      assert.ok(finals[0].launch.payload.unit_results.every(item => item.seams.every(seam => seam.disposition === 'unresolved')));
      assert.ok(finals[0].result.coverage.seam_dispositions.every(seam => seam.disposition === 'resolved'));
      assert.equal(prepared.controls.measured.at(-1).kind, 'phase');
      assert.notEqual(prepared.controls.measured.at(-1).verified_index_sha256, '0'.repeat(64));

      const canonicalPlan = path.join(planning, f.rows['T-49-01'].plan);
      const unit = units[0], memberFile = path.join(f.graphDir, 'tickets.json');
      const mutations = [
        [canonicalPlan, bytes => bytes.replace('## Verification commands',
          '- New canonical acceptance at unchanged source HEAD.\n## Verification commands')],
        [path.join(planning, '.planning/architecture/ADR-014-original.md'), bytes => bytes + '\nChanged governing obligation.\n'],
        [memberFile, bytes => { const graph = JSON.parse(bytes); delete graph.tickets['T-49-02']; return JSON.stringify(graph); }],
        [path.join(f.worktree, 'src/provider.cjs'), bytes => bytes + '\nexports.changedAfterFinal = true;\n'],
        [path.join(f.worktree, unit.manifest.files.findings.path), bytes => bytes + ' '],
        [path.join(f.worktree, unit.manifest.files.findings.path), bytes => {
          const foreign = JSON.parse(bytes); foreign.runtime = nativeRuntime === 'codex' ? 'claude' : 'codex'; return JSON.stringify(foreign);
        }],
        [path.join(f.worktree, unit.manifest.files.findings.path), () =>
          fs.readFileSync(path.join(f.worktree, units[1].manifest.files.findings.path))],
        [unit.pin.path, bytes => bytes + ' '],
      ];
      if (nativeRuntime === 'codex') mutations.push([path.join(f.agents.integrator.dir, f.agents.integrator.selection.agent_file),
        bytes => bytes + '\n# installed producer instructions changed after final\n']);
      for (const [file, mutate] of mutations) {
        const saved = fs.readFileSync(file);
        try {
          fs.writeFileSync(file, mutate(saved.toString('utf8')));
          assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.head);
          assert.equal(currentPartitionConsumer(f), null, 'changed current canonical/producer/member/source/original evidence refuses: ' + file);
        } finally { fs.writeFileSync(file, saved); }
        assert.equal(currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
      }
      const artifact = path.join(f.worktree, unit.manifest.files.findings.path), saved = fs.readFileSync(artifact);
      try {
        fs.unlinkSync(artifact);
        assert.equal(currentPartitionConsumer(f), null, 'missing original unit cannot authorize final');
      } finally { fs.writeFileSync(artifact, saved); }
      git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.head);
      assert.equal(currentPartitionConsumer(f), null, 'live default base moved');
      git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
      assert.equal(currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
      git(f.worktree, 'update-ref', 'refs/heads/' + f.pr.headRefName, f.base);
      assert.equal(currentPartitionConsumer(f), null, 'current source HEAD moved');
      git(f.worktree, 'update-ref', 'refs/heads/' + f.pr.headRefName, f.head);
      assert.equal(currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
      assert.equal(fs.readFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), 'utf8').includes('New canonical acceptance'), false);
    });
  });

  for (const disposition of ['needs-fix', 'contradictory-pass', 'incomplete'])
    test('supported ' + nativeRuntime + ' final preserves planted cross-unit mismatch: ' + disposition, async () => {
      await publicIntegrationFixture(async f => {
        write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n' + '// producer context Ω\n'.repeat(3000));
        write(f.worktree, 'src/consumer.cjs', 'const { value } = require("./provider.cjs");\nif (value !== 1) throw new Error("planted fixture mismatch");\n');
        for (const row of Object.values(f.rows)) {
          const file = path.join(f.worktree, row.plan);
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Verification commands',
            '- Consumer must accept the provider value without throwing.\n## Verification commands'));
        }
        commit(f, 'plant independent producer consumer acceptance mismatch');
        const producerConclusion = 'Producer exports value 2.', consumerConclusion = 'Consumer requires value 1 and throws otherwise.';
        const controls = { result(result, payload) {
          if (payload.kind === 'unit') {
            const primary = payload.primary_segments.map(segment => segment.content).join('\n');
            result.conclusions = [];
            if (primary.includes('exports.value = 2;')) result.conclusions.push(producerConclusion);
            if (primary.includes('planted fixture mismatch')) result.conclusions.push(consumerConclusion);
            if (!result.conclusions.length) result.conclusions.push('Other exact assigned fixture material evaluated.');
            return;
          }
          const producer = payload.unit_results.filter(unit => unit.conclusions.includes(producerConclusion));
          const consumer = payload.unit_results.filter(unit => unit.conclusions.includes(consumerConclusion));
          assert.ok(producer.some(left => consumer.some(right => right.unit_id !== left.unit_id)), 'planted producer and consumer evidence spans distinct primary units');
          const seam = payload.seams.find(item => producer.some(left => consumer.some(right =>
            item.from === left.unit_id && item.to === right.unit_id || item.to === left.unit_id && item.from === right.unit_id)));
          assert.ok(seam, 'final receives the unresolved cross-unit acceptance interaction');
          assert.ok(payload.governing.some(item => item.pointer.includes('/acceptance/')
            && typeof item.value === 'string' && item.value.includes('Consumer must accept')));
          result.coverage.seam_dispositions.find(item => item.id === seam.id).disposition = 'unresolved';
          result.coverage.seam_dispositions.find(item => item.id === seam.id).rationale = 'Provider emits 2; consumer accepts only 1. Current acceptance fails.';
          result.summary = 'Planted producer/consumer mismatch remains unresolved.';
          result.evidence_markdown = 'Behavior-only fixture: provider emits 2; consumer requires 1. Acceptance unresolved.';
          if (disposition === 'incomplete') result.completeness = 'incomplete';
          else if (disposition === 'needs-fix') {
            result.outcome = 'needs-fix'; result.blocking_count = 1;
            result.findings = [{ id: 'F1', type: 'fix-ticket', blocking: true, ticket: null,
              summary: 'Provider emits 2 but consumer accepts only 1.',
              fix_ticket: { title: 'Align producer and consumer', scope: 'Repair the planted acceptance mismatch.',
                files: ['src/provider.cjs', 'src/consumer.cjs'], depends_on: [] } }];
          }
        } };
        const prepared = publicPartitionFixture(f, nativeRuntime, controls);
        if (disposition === 'needs-fix') {
          const result = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
          assert.equal(result.result.outcome, 'needs-fix');
          assert.equal(nativeRuntime === 'codex' ? result.artifact.envelope.outcome : result.artifact.outcome, 'needs-fix');
          const sessions = originalPartitionSessions(f, nativeRuntime, prepared.recorder, controls);
          const final = sessions.find(item => item.result.kind === 'phase');
          assert.equal(final.result.outcome, 'needs-fix');
          assert.equal(final.result.blocking_count, 1);
          assert.ok(final.result.coverage.seam_dispositions.some(seam => seam.disposition === 'unresolved'));
        } else {
          await assert.rejects(supportedPartitionCaller(f, nativeRuntime, prepared.options),
            error => error.code === 'INTEGRATION_PARTITION_INVALID');
          assert.equal(partitionManifests(f).filter(item => item.artifact_kind === 'judgment').length, 0,
            'contradictory or incomplete original final cannot be projected as passing authority');
        }
        assert.equal(controls.launches.filter(item => item.payload.kind === 'phase').length, 1);
        assert.equal(currentPartitionConsumer(f), null);
      });
    });
}

test('actual final caller and reviewer reference require trusted preparation and fresh complete coverage', () => {
  const command = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/commands/deliver.md'), 'utf8');
  const reference = fs.readFileSync(path.resolve(__dirname, '../../plugins/delivery-pipeline/references/integrator.md'), 'utf8');
  for (const text of [command, reference]) {
    assert.match(text, /shipyard\.integration-review\.v[23]/);
    assert.match(text, /shipyard\.integration-coverage-result\.v1/);
    assert.match(text, /reviewed_identity/);
    assert.match(text, /fresh native/);
    assert.match(text, /failed.*(?:history|rejected)/s);
  }
  assert.match(command, /selectReviewBaseline\(\{currentInput\}\)/);
  assert.match(command, /buildReviewImpactPacket\(currentInput, selection\)/);
  assert.match(command, /createCodexDeliveryHost[\s\S]*review_contract: 'shipyard\.integration-review\.v3'/);
  assert.match(command, /createClaudeRoleHost\(options\)\.run/);
  assert.match(reference, /inherited_obligations/);
  assert.match(reference, /newly_reviewed_obligations/);
  assert.match(reference, /input_manifest_sha256/);
});
async function fixture(action) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-lineage-')));
  const originalHome = os.homedir, originalCodex = process.env.CODEX_HOME;
  os.homedir = () => root; process.env.CODEX_HOME = path.join(root, '.codex');
  let f;
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
    write(worktree, '.planning/config.json', JSON.stringify({ git: { base_branch: 'main' }, delivery_pipeline: { code_review: 'report' } }));
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
    f = { root, worktree, base, graphDir, phase, rows, state, count: 0, agents: {}, reviews: [] };
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
    for (const storage of f?.focusedStorages || []) fs.rmSync(storage, { recursive: true, force: true });
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
  if (role === 'arch-review' && collector.FOCUSED_CONTRACT) {
    const helper = require('./helpers/codex-arch-review-fixtures.cjs');
    const source = { root: f.worktree, ticket: phaseBinding(f).subject, phase: 49, phaseName: f.phase, pr: f.pr };
    const original = await helper.unitJudgment(source);
    f.focusedStorages ??= [];
    f.focusedStorages.push(source.storage);
    const artifact = original.result.artifact.ref;
    const review = { head: f.head, artifact, original: fs.readFileSync(artifact),
      dispatched: original.result, recorder: original.recorder, role, value: original.value };
    assert.equal(original.result.result.review_contract, collector.FOCUSED_CONTRACT);
    assert.equal(original.result.receipt.runtime_evidence.input_consumption, undefined);
    f.reviews.push(review);
    return review;
  }
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

test('complete focused architecture success cannot supply missing current integration lineage', async () => {
  await fixture(async f => {
    const helper = require('./helpers/codex-arch-review-fixtures.cjs');
    const reviewFixture = { root: f.worktree, ticket: phaseBinding(f).subject, phase: 49, phaseName: f.phase, pr: f.pr };
    try {
      const architecture = await helper.unitJudgment(reviewFixture);
      assert.equal(architecture.result.result.review_contract, collector.FOCUSED_CONTRACT);
      assert.equal(architecture.result.result.review_completeness, 'complete');
      assert.equal(architecture.result.receipt.runtime_evidence.input_consumption, undefined);
      assert.match(architecture.value.prepared.packet.diff.content, /exports.value = 1/);
      assert.ok(architecture.value.prepared.packet.adr_selection.some(ref => ref.selected));
      const current = { worktreePath: f.worktree, graphDir: f.graphDir, pr: f.pr.number, head: f.head,
        headBranch: f.pr.headRefName, baseName: 'main', baseCommit: f.base };
      assert.equal(authority.currentArchitectureVerdict(current).authenticated, true);
      write(f.worktree, 'src/provider.cjs', 'exports.value = 2;\n'); commit(f, 'independent repair after focused review');
      assert.equal(authority.currentArchitectureVerdict({ ...current, head: f.head }), null);
      const fresh = await runIntegration(f);
      assert.equal(fresh.coverage.mode, 'full');
      assert.equal(fresh.coverage.baseline, null);
      assert.deepEqual(fresh.coverage.inherited, []);
      assert.ok(fresh.coverage.current_logical_obligations.every(item => item.coverage !== 'inherited'));
    } finally {
      if (reviewFixture.originalCodexHome) {
        if (reviewFixture.originalCodexHome.value === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = reviewFixture.originalCodexHome.value;
      }
      if (reviewFixture.storage) fs.rmSync(reviewFixture.storage, { recursive: true, force: true });
    }
  });
});

function d36NativeMutation(runtimeName, mutate) {
  return runtimeName === 'codex' ? { native(rows) { mutate(rows, null, null); } }
    : { observation(rows, stream, final) { mutate(rows, stream, final); } };
}

function d36Telemetry(runtimeName, rows, stream) {
  return runtimeName === 'codex' ? rows.find(row => row.type === 'event_msg' && row.payload?.type === 'token_count').payload.info
    : (stream || rows).find(row => row.type === 'assistant').message.usage;
}

for (const nativeRuntime of ['codex', 'claude']) {
  test('D36 ' + nativeRuntime + ' positive observed caller authenticates complete originals and cold current authority', async () => {
    await publicIntegrationFixture(async f => {
      write(f.worktree, 'src/unchanged.cjs', 'exports.primary = "complete source continuation Ω";\n'.repeat(6500));
      commit(f, 'observed complete source inventory');
      const prepared = publicPartitionFixture(f, nativeRuntime, { observed: true });
      assert.equal(Object.hasOwn(prepared.options, 'integrationCapacity'), false);
      prepared.controls.onLaunch = (_input, payload) => {
        assert.equal(currentPartitionConsumer(f), null);
        if (payload.kind === 'unit') {
          assert.ok(payload.assignment.primary_segments.length <= 3);
          assert.ok(payload.assignment.primary_segments.every(part => part.end_byte - part.start_byte <= 65536));
          assert.ok(Buffer.byteLength(_input) <= 2097152);
        } else {
          assert.ok(payload.obligations.length > 0);
          assert.equal(payload.assignments.length, payload.unit_artifacts.length);
          assert.ok(Buffer.byteLength(_input) <= 4194304);
        }
      };
      const result = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
      assert.equal(result.result.outcome, 'passed');
      const sessions = originalPartitionSessions(f, nativeRuntime, prepared.recorder, prepared.controls);
      assert.ok(sessions.filter(item => item.result.kind === 'unit').length > 1);
      assert.equal(sessions.filter(item => item.result.kind === 'phase').length, 1);
      const current = currentPartitionConsumer(f);
      assert.equal(current?.authenticated, true);
      const protectedDirectory = authority.archiveAuthorityDirectory(f.worktree);
      for (const name of fs.readdirSync(protectedDirectory).filter(name => /^integration-(?:plan|observation|capacity)-/.test(name))) {
        const file = path.join(protectedDirectory, name), saved = fs.readFileSync(file);
        try {
          const envelope = JSON.parse(saved);
          if (name.startsWith('integration-plan-')) envelope.payload.plan.capacity.unit_input_bytes++;
          else if (name.startsWith('integration-observation-')) delete envelope.payload.samples;
          else envelope.payload.schema = 'shipyard.integration-partition-capacity.v1';
          fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
          assert.equal(currentPartitionConsumer(f), null, 'protected mode/budget/observation swaps refuse');
        } finally { fs.writeFileSync(file, saved, { mode: 0o600 }); }
      }
      const modulePath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
      delete require.cache[modulePath];
      authority = require(modulePath);
      assert.equal(currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
      for (const session of [sessions.find(item => item.result.kind === 'unit'), sessions.find(item => item.result.kind === 'phase')]) {
        const saved = fs.readFileSync(session.pin.path);
        try {
          const rows = saved.toString('utf8').trim().split('\n').map(JSON.parse);
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.type === 'token_count').payload.info.model_context_window = 0;
          else delete rows.find(row => row.type === 'assistant').message.usage;
          fs.writeFileSync(session.pin.path, serialize(rows));
          delete require.cache[modulePath]; authority = require(modulePath);
          assert.equal(currentPartitionConsumer(f), null, 'changed original telemetry refuses cold current authority');
        } finally { fs.writeFileSync(session.pin.path, saved); }
        assert.equal(currentPartitionConsumer(f)?.dispatch_id, current.dispatch_id);
      }
    });
  });

  test('D36 ' + nativeRuntime + ' positive cumulative accounting above a window preserves fitting per-request samples', async () => {
    await publicIntegrationFixture(async f => {
      const controls = { observed: true, ...d36NativeMutation(nativeRuntime, (rows, stream, final) => {
        if (nativeRuntime === 'codex') {
          const info = d36Telemetry(nativeRuntime, rows);
          info.last_token_usage = { input_tokens: 900, cached_input_tokens: 850, output_tokens: 100, reasoning_output_tokens: 80, total_tokens: 1000 };
          info.model_context_window = 1100;
          info.total_token_usage = { input_tokens: 900000, cached_input_tokens: 850000, output_tokens: 100000, reasoning_output_tokens: 80000, total_tokens: 1000000 };
          const update = structuredClone(rows.find(row => row.payload?.type === 'token_count'));
          rows.splice(rows.indexOf(rows.find(row => row.payload?.phase === 'final_answer')), 0, update);
        } else {
          const assistant = rows.find(row => row.type === 'assistant');
          assistant.message.usage = { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 100, output_tokens: 100 };
          const earlier = structuredClone(assistant); earlier.message.stop_reason = null; earlier.message.usage.output_tokens = 1;
          rows.splice(1, 0, earlier);
          stream.splice(1, stream.length - 2, ...rows.filter(row => row.type === 'assistant').map(row => structuredClone(row)));
          Object.values(final.modelUsage)[0].contextWindow = 1100;
          Object.values(final.modelUsage)[0].inputTokens = 999999;
          final.usage.input_tokens = 999999;
        }
      }) };
      const prepared = publicPartitionFixture(f, nativeRuntime, controls);
      const result = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
      assert.equal(result.result.outcome, 'passed');
      assert.equal(currentPartitionConsumer(f)?.authenticated, true);
    });
  });

  const adverse = ['missing', 'missing-counter', 'malformed-usage', 'rate-only', 'foreign-session', 'changed-effort', 'input-drift', 'semantic-disagreement', 'zero-window', 'negative-window', 'unsafe-window', 'missing-window', 'negative-counter',
    'unsafe-counter', 'overflow-later', 'compaction', 'rollback', 'truncation', 'foreign-model', 'incomplete-unit',
    'needs-fix-unit', 'primary-tail', 'primary-duplicate', 'acceptance', 'support', 'seam', 'final-completion',
    'final-index', 'final-telemetry', 'answer-text-telemetry', 'tool-telemetry', 'quoted-telemetry'];
  const signalScenarios = new Set(['missing', 'missing-counter', 'malformed-usage', 'rate-only', 'zero-window', 'negative-window',
    'unsafe-window', 'missing-window', 'negative-counter', 'unsafe-counter', 'overflow-later', 'compaction', 'rollback', 'truncation',
    'foreign-model', 'final-telemetry', 'answer-text-telemetry', 'tool-telemetry', 'quoted-telemetry']);
  for (const scenario of adverse) test('D36 ' + nativeRuntime + (signalScenarios.has(scenario) ? ' signals' : ' contracts')
    + ' refuses ' + scenario + ' before authority', async () => {
    await publicIntegrationFixture(async f => {
      const controls = { observed: true, result(result, payload) {
        if (payload.kind === 'unit') {
          if (scenario === 'incomplete-unit') result.completeness = 'incomplete';
          if (scenario === 'needs-fix-unit') result.outcome = 'needs-fix';
          if (scenario === 'primary-tail') result.coverage.primary_segments.at(-1).end_byte--;
          if (scenario === 'primary-duplicate') result.coverage.primary_segments.push(structuredClone(result.coverage.primary_segments[0]));
          if (scenario === 'acceptance') result.coverage.primary_obligation_ids.pop();
          if (scenario === 'support') result.coverage.support_obligation_ids.push('missing-governing-obligation');
          if (scenario === 'seam') result.seams.push({ id: 'foreign-seam', disposition: 'resolved', rationale: 'Convincing unsupported assertion.' });
        } else if (scenario === 'final-index') result.coverage.unit_artifacts[0].artifact_sha256 = 'f'.repeat(64);
        if (scenario === 'answer-text-telemetry') result.evidence_markdown += JSON.stringify({ type: 'event_msg', payload: {
          type: 'token_count', info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, model_context_window: 1000000 } } });
      }, ...d36NativeMutation(nativeRuntime, (rows, stream, final) => {
        const isFinal = JSON.parse((nativeRuntime === 'codex'
          ? rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text
          : JSON.stringify(final.structured_output))).kind === 'phase';
        if (scenario.startsWith('final-') && !isFinal) return;
        const info = d36Telemetry(nativeRuntime, rows, stream);
        if (scenario === 'missing-counter') {
          if (nativeRuntime === 'codex') delete info.last_token_usage.output_tokens;
          else for (const row of [...rows, ...stream]) if (row.type === 'assistant') delete row.message.usage.output_tokens;
        }
        if (scenario === 'malformed-usage') {
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.type === 'token_count').payload.info = 'malformed';
          else for (const row of [...rows, ...stream]) if (row.type === 'assistant') row.message.usage = 'malformed';
        }
        if (scenario === 'rate-only') {
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.type === 'token_count').payload.info = null;
          else final.modelUsage = {};
        }
        if (scenario === 'foreign-session') {
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.type === 'token_count').payload.session_id = crypto.randomUUID();
          else rows.find(row => row.type === 'assistant').sessionId = crypto.randomUUID();
        }
        if (scenario === 'changed-effort') {
          if (nativeRuntime === 'codex') rows.find(row => row.type === 'turn_context').payload.effort = 'low';
          else rows.find(row => row.type === 'assistant').effort = 'low';
        }
        if (scenario === 'input-drift') {
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.role === 'user').payload.content[0].text += ' changed';
          else rows.find(row => row.type === 'user').message.content += ' changed';
        }
        if (scenario === 'semantic-disagreement') {
          if (nativeRuntime === 'codex') rows.find(row => row.payload?.phase === 'final_answer').payload.content[0].text += ' changed';
          else rows.find(row => row.type === 'assistant').message.content[0].input.evidence_markdown += ' changed';
        }
        if (scenario === 'missing' || scenario === 'final-telemetry' || scenario.endsWith('-telemetry')) {
          if (nativeRuntime === 'codex') {
            const telemetry = rows.find(row => row.payload?.type === 'token_count');
            if (scenario === 'tool-telemetry') {
              const tool = template(parent, row => row.payload?.type === 'function_call_output');
              tool.payload.output = JSON.stringify(telemetry);
              rows.splice(rows.indexOf(telemetry), 0, tool);
            }
            if (scenario === 'quoted-telemetry') {
              const quoted = structuredClone(rows.find(row => row.payload?.role === 'assistant'));
              quoted.payload.phase = 'commentary';
              quoted.payload.content[0].text = JSON.stringify(telemetry);
              rows.splice(rows.indexOf(telemetry), 0, quoted);
            }
            rows.splice(rows.indexOf(telemetry), 1);
          } else {
            if (scenario === 'tool-telemetry' || scenario === 'quoted-telemetry') {
              const telemetry = structuredClone(rows.find(row => row.type === 'assistant'));
              rows.push({ type: 'user', sessionId: telemetry.sessionId, message: { role: 'user', content: [
                { type: 'tool_result', content: JSON.stringify(telemetry) }] } });
            }
            for (const row of [...rows, ...stream]) if (row.type === 'assistant') delete row.message.usage;
          }
        }
        const windowKey = nativeRuntime === 'codex' ? 'model_context_window' : 'contextWindow';
        const window = nativeRuntime === 'codex' ? info : Object.values(final.modelUsage)[0];
        if (scenario === 'zero-window') window[windowKey] = 0;
        if (scenario === 'negative-window') window[windowKey] = -1;
        if (scenario === 'unsafe-window') window[windowKey] = Number.MAX_SAFE_INTEGER + 1;
        if (scenario === 'missing-window') delete window[windowKey];
        if (scenario === 'negative-counter' || scenario === 'unsafe-counter') {
          if (nativeRuntime === 'codex') info.last_token_usage.input_tokens = scenario === 'negative-counter' ? -1 : Number.MAX_SAFE_INTEGER + 1;
          else for (const row of [...rows, ...stream]) if (row.type === 'assistant') row.message.usage.input_tokens = scenario === 'negative-counter' ? -1 : Number.MAX_SAFE_INTEGER + 1;
        }
        if (scenario === 'overflow-later') {
          if (nativeRuntime === 'codex') {
            const later = structuredClone(rows.find(row => row.payload?.type === 'token_count'));
            later.payload.info.model_context_window = 1;
            later.payload.info.total_token_usage.total_tokens++;
            rows.splice(rows.length - 2, 0, later);
          } else {
            const later = structuredClone(rows.find(row => row.type === 'assistant'));
            later.message.id += '-later'; later.message.usage.input_tokens = Object.values(final.modelUsage)[0].contextWindow;
            rows.push(later); stream.splice(stream.length - 1, 0, structuredClone(later));
          }
        }
        if (scenario === 'compaction' || scenario === 'rollback') {
          const event = nativeRuntime === 'codex'
            ? { type: 'event_msg', payload: { type: scenario === 'compaction' ? 'context_compacted' : 'thread_rolled_back' } }
            : { type: 'system', subtype: 'compact_boundary' };
          rows.splice(1, 0, event);
        }
        if (scenario === 'truncation') {
          if (nativeRuntime === 'codex') rows.splice(1, 0, { type: 'event_msg', payload: { type: 'output_truncated' } });
          else for (const row of [...rows, ...stream]) if (row.type === 'assistant') row.message.stop_reason = 'max_tokens';
        }
        if (scenario === 'foreign-model') {
          if (nativeRuntime === 'codex') rows.find(row => row.type === 'turn_context').payload.model = 'foreign-model';
          else final.modelUsage = { 'foreign-model': Object.values(final.modelUsage)[0] };
        }
        if (scenario === 'final-completion') {
          if (nativeRuntime === 'codex') rows.splice(rows.findIndex(row => row.payload?.type === 'task_complete'), 1);
          else final.subtype = 'error_max_turns';
        }
      }) };
      const prepared = publicPartitionFixture(f, nativeRuntime, controls);
      await assert.rejects(supportedPartitionCaller(f, nativeRuntime, prepared.options));
      assert.ok(controls.launches.length > 0, 'refusal follows an ordinary original native attempt');
      assert.equal(currentPartitionConsumer(f), null);
      if (scenario.startsWith('final-')) assert.ok(partitionManifests(f).some(manifest => manifest.artifact_kind === 'integration-unit'));
    });
  });
}

function codexIngressGeometry(f) {
  const governing = 'Required complete plan context: every assigned range preserves this material.\n'.repeat(2250);
  for (const row of Object.values(f.rows))
    fs.appendFileSync(path.join(f.worktree, row.plan), '\n## Required governing context\n' + governing);
  for (const id of ['015', '016', '017', '018']) {
    const relative = '.planning/architecture/ADR-' + id + '-governing.md';
    write(f.worktree, relative, '# ADR-' + id + '\n' + governing);
    fs.appendFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), '\n' + relative + '\n');
  }
  write(f.worktree, 'src/unchanged.cjs', 'exports.context = "complete primary ASCII";\n'.repeat(7000));
  commit(f, 'actual ASCII Codex ingress geometry');
}

async function withCodexIngressHost(intercept, action) {
  const runtimePath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const deliveryPath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const authorityPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const originalRuntime = require.cache[runtimePath].exports, originalDelivery = require.cache[deliveryPath];
  const originalAuthority = require.cache[authorityPath], originalReader = authority;
  try {
    require.cache[runtimePath].exports = { ...originalRuntime,
      createCodexRuntimeHost: options => intercept(options, originalRuntime.createCodexRuntimeHost) };
    delete require.cache[deliveryPath];
    require(deliveryPath);
    require.cache[runtimePath].exports = originalRuntime;
    await action();
  } finally {
    require.cache[runtimePath].exports = originalRuntime;
    require.cache[deliveryPath] = originalDelivery;
    require.cache[authorityPath] = originalAuthority;
    authority = originalReader;
  }
}

test('D36 codex ingress actual ASCII unit and fresh final retain original producer across cold readers', async () => {
  await publicIntegrationFixture(async f => {
    codexIngressGeometry(f);
    const prepared = publicPartitionFixture(f, 'codex', { observed: true });
    const producerPath = require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
    let resources = 0;
    await withCodexIngressHost((options, createHost) => {
      if (options.integrationIngress) {
        const authorize = options.integrationIngress;
        options = { ...options, integrationIngress(input) { resources++; return authorize(input); } };
        delete require.cache[producerPath];
        authority = require(producerPath);
      }
      return createHost(options);
    }, async () => {
      prepared.controls.onLaunch = (input, payload) => {
        const prefix = runtime.generatedInstructions(f.agents.integrator.text) + '\n\n';
        const base = input.slice(prefix.length);
        assert.ok(base.length > 1048576, 'stripped actual ASCII input exceeds the legacy character guard');
        assert.equal(input, prefix + base);
        assert.ok(Buffer.byteLength(input) <= (payload.kind === 'unit' ? 2097152 : 4194304));
        assert.equal(currentPartitionConsumer(f), null);
        if (payload.kind !== 'unit') return;
        assert.ok(payload.assignment.primary_segments.length <= 3);
        for (const relative of [ ...Object.values(f.rows).map(row => row.plan),
          ...['015', '016', '017', '018'].map(id => '.planning/architecture/ADR-' + id + '-governing.md') ]) {
          const segments = [...payload.primary_segments, ...payload.support_segments].filter(segment =>
            segment.aliases.some(alias => alias.path === relative)).sort((a, b) => a.start_byte - b.start_byte);
          const complete = segments.map(segment => segment.content).join('');
          assert.equal(complete, fs.readFileSync(path.join(f.worktree, relative), 'utf8'));
          assert.ok(/^[\x00-\x7f]*$/.test(complete), 'complete governing references stay ASCII');
          assert.equal(complete.split('Required complete plan context: every assigned range preserves this material.\n').length - 1, 2250);
        }
      };
      const result = await supportedPartitionCaller(f, 'codex', prepared.options);
      assert.equal(result.result.outcome, 'passed');
      const sessions = originalPartitionSessions(f, 'codex', prepared.recorder, prepared.controls);
      assert.equal(resources, sessions.length, 'only oversized actual native stages consult the resource');
      assert.ok(sessions.filter(item => item.result.kind === 'unit').length > 1);
      assert.equal(sessions.filter(item => item.result.kind === 'phase').length, 1);
      assert.equal(currentPartitionConsumer(f)?.authenticated, true);
      assert.ok(result.operational_diagnostic.actual_final_input_bytes <= 4194304);
    });
  });
});

test('D36 codex ingress actual public stage rejects changed or unowned oversized launches before any process', async () => {
  await publicIntegrationFixture(async f => {
    codexIngressGeometry(f);
    const prepared = publicPartitionFixture(f, 'codex', { observed: true });
    const foreignWorktree = path.join(f.root, 'foreign-worktree');
    fs.mkdirSync(foreignWorktree);
    let processes = 0, checked = false;
    const stop = new Error('ingress negative controls complete');
    const spawn = prepared.options.spawn;
    prepared.options.spawn = (...args) => { processes++; return spawn(...args); };
    await withCodexIngressHost((options, createHost) => {
      const host = createHost(options);
      if (!options.integrationIngress) return host;
      return { ...host, async launchStatic(selection, context) {
        assert.equal(checked, false);
        checked = true;
        const deny = async (name, creator = {}, handoff = {}, input = {}) => {
          const candidate = createHost({ ...options, controller: undefined, ...creator });
          await assert.rejects(candidate.launchStatic({ ...selection, ...handoff }, { ...context, ...input }),
            error => ['INVALID_INPUT', 'RUNTIME_UNAVAILABLE', 'INTEGRATION_CAPACITY_UNPROVEN', 'INTEGRATION_PARTITION_INVALID',
              'ARCHIVE_AUTHORITY_INVALID', 'STALE_GENERATED_AGENT', 'RUNTIME_CAPABILITY_MISSING'].includes(error.code), name);
          assert.equal(processes, 0, name + ' must launch zero processes');
        };
        await deny('missing private resource', { integrationIngress: undefined });
        await deny('JSON copied resource', { integrationIngress: JSON.parse(JSON.stringify({ mode: 'native-observed', input_byte_ceiling: 4194304 })) });
        for (const contract of ['shipyard.integration-review.v1', 'shipyard.integration-review.v2', 'shipyard.integration-review.v3'])
          await deny('serialized flags ' + contract, { integrationIngress: undefined }, {}, {
            review_contract: contract, mode: 'native-observed', input_byte_ceiling: 4194304, integrationIngress: true });
        for (const [key, value] of [['ticket', 'foreign-phase-subject'], ['phase', 50], ['worktree', foreignWorktree], ['run_id', 'foreign-run'], ['repository', 'foreign-repository']])
          await deny('changed scope ' + key, { scope: { ...options.scope, [key]: value } });
        await deny('changed dispatch', {}, {}, { dispatch_id: context.dispatch_id + '-foreign' });
        await deny('changed complete input', {}, {}, { prompt: context.prompt + 'changed' });
        await deny('wrong static role', {}, { agent_file: 'shipyard-research.toml' });
        await deny('missing static handoff', {}, { agent_file: undefined, agent_file_content: undefined, agent_file_digest: undefined });
        const changed = selection.agent_file_content.replace('Read', 'Changed');
        assert.notEqual(changed, selection.agent_file_content);
        await deny('changed pinned instructions', {}, { agent_file_content: changed, agent_file_digest: hash(changed) });
        await deny('changed sandbox', {}, { sandbox_mode: 'workspace-write' });
        await deny('changed model', {}, { model: 'unselected-model' });
        await deny('changed effort', {}, { reasoning_effort: selection.reasoning_effort === 'low' ? 'high' : 'low' });
        for (const bound of [undefined, NaN, Infinity, 8388608, -1])
          await deny('malformed resource bound ' + bound, { integrationIngress: () => bound });
        let consulted = 0;
        await deny('finite complete UTF8 ceiling', { integrationIngress() { consulted++; return Infinity; } }, {},
          { prompt: 'x'.repeat(4194305) });
        await deny('finite multibyte complete UTF8 ceiling', { integrationIngress() { consulted++; return 4194304; } }, {},
          { prompt: '\u20ac'.repeat(1500000) });
        assert.equal(consulted, 0, 'absolute ceiling precedes even a malformed host resource');
        await deny('independent unit UTF8 ceiling', { integrationIngress: () => 2097152 }, {},
          { prompt: 'x'.repeat(2097153) });
        const directory = authority.archiveAuthorityDirectory(f.worktree);
        const launch = fs.readdirSync(directory).filter(name => name.startsWith('integration-launch-'))
          .map(name => JSON.parse(fs.readFileSync(path.join(directory, name))).payload)
          .find(value => value.dispatch_id === context.dispatch_id);
        assert.ok(launch);
        for (const stage of [launch, { ...launch, mode: 'strict' }, { ...launch, kind: 'phase' }]) {
          assert.throws(() => authority.createCodexIntegrationIngress({ prepared: stage, host: {}, scope: options.scope }), /private/);
          await deny('nonprivate copied stage', { integrationIngress: request =>
            authority.createCodexIntegrationIngress({ prepared: stage, host: {}, scope: options.scope })(request) });
        }
        const admissionPath = path.join(directory, 'integration-capacity-' + hash(require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify(launch)) + '.json');
        const saved = fs.readFileSync(admissionPath);
        try {
          fs.unlinkSync(admissionPath);
          await deny('missing local protected admission');
          const envelope = JSON.parse(saved); envelope.payload.profile_sha256 = '0'.repeat(64);
          fs.writeFileSync(admissionPath, JSON.stringify(envelope), { mode: 0o600 });
          await deny('changed local protected admission');
        } finally { fs.writeFileSync(admissionPath, saved, { mode: 0o600 }); }
        assert.equal(currentPartitionConsumer(f), null);
        let ordinarySpawns = 0, ordinaryResourceCalls = 0;
        const ordinary = createHost({ ...options, controller: undefined,
          integrationIngress() { ordinaryResourceCalls++; throw new Error('ordinary resource must stay lazy'); },
          spawn() { ordinarySpawns++; throw new Error('ordinary input reached controlled spawn'); } });
        await assert.rejects(ordinary.launchStatic(selection, { ...context, prompt: 'Complete ordinary static review.' }),
          error => error.code === 'RUNTIME_UNAVAILABLE' && /ordinary input reached controlled spawn/.test(error.message));
        assert.equal(ordinarySpawns, 1);
        assert.equal(ordinaryResourceCalls, 0);
        throw stop;
      } };
    }, async () => {
      await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options), error => error === stop);
    });
    assert.equal(checked, true);
    assert.equal(processes, 0);
  });
});

test('D36 codex ingress supplied strict public caller retains the legacy static prompt guard', async () => {
  await publicIntegrationFixture(async f => {
    codexIngressGeometry(f);
    const prepared = publicPartitionFixture(f, 'codex');
    prepared.options.integrationCapacity.capacity.unit_input_bytes = 2097152;
    let processes = 0, stages = 0;
    prepared.options.spawn = () => { processes++; throw new Error('strict oversized launch must not spawn'); };
    await withCodexIngressHost((options, createHost) => {
      const host = createHost(options);
      if (!options.scope.run_id.startsWith('integration-')) return host;
      assert.equal(options.integrationIngress, undefined);
      return { ...host, launchStatic(selection, context) {
        stages++;
        assert.ok(context.prompt.trim().length > 1048576);
        return host.launchStatic(selection, context);
      } };
    }, async () => {
      await assert.rejects(supportedPartitionCaller(f, 'codex', prepared.options),
        error => error.code === 'RUNTIME_UNAVAILABLE' && /Codex process input failed:.*prompt exceeds 1048576 characters/.test(error.message));
    });
    assert.equal(stages, 1);
    assert.equal(processes, 0);
    assert.equal(currentPartitionConsumer(f), null);
  });
});

for (const nativeRuntime of ['codex', 'claude'])
test('D36 ' + nativeRuntime + ' geometry phase-shaped complete governing floor fits with at most three primary segments', async () => {
  await publicIntegrationFixture(async f => {
    const governing = 'Required complete plan context: every assigned range preserves this material.\n'.repeat(2250);
    for (const row of Object.values(f.rows))
      fs.appendFileSync(path.join(f.worktree, row.plan), '\n## Required governing context\n' + governing);
    for (const id of ['015', '016', '017', '018']) {
      const relative = '.planning/architecture/ADR-' + id + '-governing.md';
      write(f.worktree, relative, '# ADR-' + id + '\n' + governing);
      fs.appendFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), '\n' + relative + '\n');
    }
    write(f.worktree, 'src/unchanged.cjs', 'exports.context = "complete primary Ω";\n'.repeat(7000));
    commit(f, 'phase-shaped governing and primary geometry');
    const prepared = publicPartitionFixture(f, nativeRuntime, { observed: true });
    prepared.controls.onLaunch = (input, payload) => {
      if (payload.kind !== 'unit') return;
      assert.ok(payload.assignment.primary_segments.length <= 3);
      const union = [...payload.primary_segments, ...payload.support_segments].filter(segment =>
        segment.aliases.some(alias => alias.path === f.rows['T-49-01'].plan)).sort((a, b) => a.start_byte - b.start_byte);
      assert.equal(union.map(segment => segment.content).join(''), fs.readFileSync(path.join(f.worktree, f.rows['T-49-01'].plan), 'utf8'));
      assert.ok(Buffer.byteLength(input) > 965386);
      assert.ok(Buffer.byteLength(input) <= 2097152);
    };
    const result = await supportedPartitionCaller(f, nativeRuntime, prepared.options);
    assert.equal(result.result.outcome, 'passed');
    const diagnostic = result.operational_diagnostic || result.context.operational_diagnostic;
    assert.equal(diagnostic.authoritative, false);
    assert.ok(diagnostic.units.every(unit => unit.primary_bytes <= 196608 && unit.complete_input_bytes <= 2097152));
    assert.equal(diagnostic.unit_count, diagnostic.units.length);
    assert.ok(diagnostic.actual_final_input_bytes <= 4194304);
    const allMaximaTemplateBytes = diagnostic.unit_count * 6 * (8192 + 4096 + 98304);
    assert.ok(allMaximaTemplateBytes > 4194304, 'strict hypothetical reservation would refuse before this fitting actual final');
    assert.equal(currentPartitionConsumer(f)?.authenticated, true);
  });
});

for (const nativeRuntime of ['codex', 'claude'])
test('D36 ' + nativeRuntime + ' aggregate refuses the complete actual final over bound and preserves accepted originals', async () => {
  await publicIntegrationFixture(async f => {
    for (let index = 0; index < 120; index++)
      write(f.worktree, 'src/complete-unit-' + String(index).padStart(3, '0') + '.cjs',
        'exports.value = "complete original source ' + index + '";\n');
    commit(f, 'actual aggregate bound requires complete unit conclusions');
    const prepared = publicPartitionFixture(f, nativeRuntime, { observed: true, result(result, payload) {
      assert.equal(payload.kind, 'unit', 'oversized actual final must never dispatch');
      result.conclusions = ['c'.repeat(16370)];
      result.limitations = ['l'.repeat(8180)];
      result.findings = [{ id: 'N1', type: 'note', blocking: false, evidence: 'Complete assigned source.', summary: 'f'.repeat(32500) }];
      if (result.seams.length) {
        const current = Buffer.byteLength(JSON.stringify(result.seams));
        result.seams[0].rationale += 's'.repeat(Math.max(0, 32750 - current));
      }
    } });
    await assert.rejects(supportedPartitionCaller(f, nativeRuntime, prepared.options), error =>
      error.code === 'INTEGRATION_INPUT_OVER_BOUND' && /actual complete phase.*HOLD/.test(error.message));
    assert.ok(prepared.controls.launches.length > 40);
    assert.ok(prepared.controls.launches.every(launch => launch.payload.kind === 'unit'));
    const manifests = partitionManifests(f);
    assert.equal(manifests.length, prepared.controls.launches.length);
    assert.ok(manifests.every(manifest => manifest.artifact_kind === 'integration-unit'));
    assert.equal(currentPartitionConsumer(f), null);
    for (const manifest of manifests) {
      const original = JSON.parse(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path)));
      assert.equal(original.conclusions[0].length, 16370);
      assert.equal(original.findings[0].summary.length, 32500);
      assert.equal(original.limitations[0].length, 8180);
    }
  });
});
