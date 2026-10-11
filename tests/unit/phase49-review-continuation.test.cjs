'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value, function(_key, child) {
  return child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child;
});
const session = '11111111-1111-4111-8111-111111111111';
const childSession = '33333333-3333-4333-8333-333333333333';
const selection = { model: 'gpt-6.1-sol', effort: 'high', sandbox_mode: 'read-only' };
const serialize = records => records.map(record => JSON.stringify(record) + '\n').join('');
const fixtureRoot = path.resolve(__dirname, '../..');
const registry = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'tests/fixtures/captured/boundaries/codex-agent-stream.json')));
function captured(name) {
  const file = registry.fixtures.find(file => file.endsWith('/codex-agent-stream-' + name + '.jsonl'));
  assert.ok(file, 'native record templates must come from the registered boundary');
  return fs.readFileSync(path.join(fixtureRoot, file), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(record => !record.shipyard_fixture);
}
const cliRecords = captured('exec');
const parentRecords = captured('parent');
const childRecords = captured('child');
function template(records, match) {
  const record = records.find(match);
  assert.ok(record, 'registered native record template is required');
  return structuredClone(record);
}
function event(type, turn, extra = {}) {
  const record = template(childRecords, record => record.type === 'event_msg'
    && record.payload.type === (type === 'task_aborted' ? 'task_started' : type));
  Object.assign(record.payload, { type, turn_id: turn, ...extra });
  if (record.payload.root_turn_id) record.payload.root_turn_id = turn;
  return record;
}
function response(type, turn, fields, records = childRecords) {
  const record = template(records, record => record.type === 'response_item' && record.payload.type === type
    && (!fields.role || record.payload.role === fields.role)
    && (!fields.phase || record.payload.phase === fields.phase));
  Object.assign(record.payload, fields);
  record.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  return record;
}
function message(role, turn, text) {
  const record = response('message', turn, { role, ...(role === 'assistant' ? { phase: 'final_answer' } : {}) });
  record.payload.content = [{ ...record.payload.content[0], text }];
  return record;
}
function nativeMetadata(id, worktree, typed = false) {
  const record = template(typed ? childRecords : parentRecords, record => record.type === 'session_meta');
  Object.assign(record.payload, { id, session_id: id, cwd: worktree, runtime_workspace_roots: [worktree] });
  if (typed) {
    Object.assign(record.payload, { parent_thread_id: session, agent_role: 'shipyard-arch-review', agent_path: '/root/gsd_task' });
    Object.assign(record.payload.source.subagent.thread_spawn, {
      parent_thread_id: session, agent_role: 'shipyard-arch-review', agent_path: '/root/gsd_task',
    });
  }
  return record;
}
function nativeContext(turn, worktree) {
  const record = template(childRecords, record => record.type === 'turn_context');
  Object.assign(record.payload, { turn_id: turn, root_turn_id: turn, model: selection.model,
    effort: selection.effort, cwd: worktree, workspace_roots: [worktree] });
  record.payload.sandbox_policy.type = selection.sandbox_mode;
  Object.assign(record.payload.collaboration_mode.settings, { model: selection.model, reasoning_effort: selection.effort });
  return record;
}
function cliThread(id) {
  const record = template(cliRecords, record => record.type === 'thread.started');
  record.thread_id = id;
  return record;
}
function cliCompletion(text) {
  const records = ['turn.started', 'item.completed', 'turn.completed']
    .map(type => template(cliRecords, record => record.type === type));
  records[1].item.text = text;
  for (const key of Object.keys(records[2].usage)) records[2].usage[key] = 0;
  Object.assign(records[2].usage, { input_tokens: 1, output_tokens: 1 });
  return records;
}

function readRecords(input) {
  const checked = collector.verifyFileInput(input);
  if (input.manifest.transport?.schema === 'shipyard.native-reader-transport.v3') {
    return input.manifest.batches.map(batch => ({ command: collector.batchCommand(input.input_bundle, batch.index),
      output: execFileSync('node', [input.manifest.transport.module_path, '--read-batch', input.input_bundle.manifest_path,
        String(batch.index), input.manifest.transport.profile_sha256], { encoding: 'utf8', maxBuffer: 252 * 1024 }) }));
  }

  return [{ path: input.input_bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))]
    .flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / input.input_bundle.chunk_bytes) }, (_, index) => ({
      command: "dd if='" + asset.path.replaceAll("'", "'\\''") + "' bs=" + input.input_bundle.chunk_bytes
        + ' skip=' + index + ' count=1 2>/dev/null | base64',
      output: asset.bytes.subarray(index * input.input_bundle.chunk_bytes, (index + 1) * input.input_bundle.chunk_bytes).toString('base64'),
    })));
}

function nativeReads(reads, turn, offset = 0) {
  return reads.flatMap((read, index) => {
    const call_id = turn + '-' + (index + offset);
    const call = response('custom_tool_call', turn, { name: 'exec', call_id,
      input: 'text(await tools.exec_command(' + JSON.stringify({ cmd: read.command, max_output_tokens: 10000 }) + '));' });
    const output = response('custom_tool_call_output', turn, { call_id });
    output.payload.output[0].text = 'Script completed\nWall time 0.1 seconds\nOutput:\n';
    output.payload.output[1].text = JSON.stringify({ exit_code: 0, output: read.output });
    return [call, output];
  });
}

function finish(turn, result) {
  return [message('assistant', turn, result),
  event('task_complete', turn, { last_agent_message: result })];
}


async function recordedBatchApplication(verified, input, root, cliRaw, separateProbe = false, mutateAssociation) {
  const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const receiptStore = path.join(root, 'measurement-receipts');
  const recorder = boundaryModule.createDurableRecorder(receiptStore);
  const cliFile = path.join(root, 'measurement-cli.jsonl');
  fs.writeFileSync(cliFile, cliRaw, { mode: 0o600 });
  const candidate = input.manifest.transport.candidate;
  const dispatchId = separateProbe ? 'capacity-probe-' + crypto.randomUUID() : input.manifest.dispatch_id;
  const manifest = input.manifest;
  const association = separateProbe ? {
    schema: 'shipyard.reader-capacity-association.v1', probe_dispatch_id: dispatchId,
    review_dispatch_id: manifest.dispatch_id, manifest_sha256: input.input_bundle.manifest_sha256,
    profile_sha256: manifest.transport.profile_sha256,
    binding_sha256: sha(stable([manifest.snapshot, manifest.run_id, manifest.ticket, manifest.phase, manifest.role,
      manifest.dispatch_id, manifest.binding, manifest.accounting.generated_instruction_bytes || 0,
      manifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256])])),
  } : null;
  if (mutateAssociation) mutateAssociation(association);
  const args = ['exec', '--json', '--model', candidate.model,
    '--config', 'model_reasoning_effort="' + candidate.effort + '"'];
  const content = "developer_instructions = '''\nReview all required material.\n'''";
  const evidence = {
    schema: 'shipyard.codex-runtime-evidence.v1', version: 1, runtime: 'codex', provider: 'openai',
    run_id: input.manifest.run_id, ticket: input.manifest.ticket, phase: input.manifest.phase,
    worktree: input.manifest.snapshot.worktree, dispatch_id: dispatchId,
    ...(association ? { reader_capacity_probe: association } : {}),
    session_id: verified.native_session_evidence.session_id, process_id: process.pid,
    selection_source: 'codex-native-session-transcript', command: { executable: 'codex', args },
    command_digest: sha(JSON.stringify(args)), native_session_evidence: verified.native_session_evidence,
    input_transport: 'host-files', input_bundle: input.input_bundle,
    input_consumption: { manifest_sha256: input.input_bundle.manifest_sha256 },
    transcript: { path: cliFile, bytes: Buffer.byteLength(cliRaw), sha256: sha(cliRaw) },
  };
  const adapter = {
    validateGeneratedAgent(resolution) {
      return { valid: true, exists: true, content_verified: true, policy_hash: resolution.policy_hash,
        agent_file: resolution.agent_file, agent_file_digest: sha(content), agent_file_content: content };
    },
    launchStatic(resolution) {
      return { receipt_type: 'adr-014.application', runtime: 'codex', role: resolution.role,
        dispatch_id: resolution.dispatch_id, launch_id: 'codex-' + evidence.session_id,
        requested_model: resolution.requested_model, requested_effort: resolution.requested_effort,
        applied_model: candidate.model, applied_effort: candidate.effort,
        observed_model: candidate.model, observed_effort: candidate.effort, policy_hash: policy.POLICY_HASH,
        agent_file: resolution.agent_file, agent_file_digest: resolution.agent_file_digest,
        runtime_evidence: evidence };
    },
  };
  const result = await boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder })
    .dispatch({ runtime: 'codex', role: input.manifest.role, signals: {}, dispatch_id: dispatchId },
      { ticket: input.manifest.ticket });
  assert.deepEqual(recorder.getVerifiedRecord(dispatchId).receipt, result.receipt);
  return { recorder, receipt: result.receipt };
}

async function fixture(action, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-continuation-')));
  const oldHome = os.homedir;
  os.homedir = () => root;
  try {
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, 'source.txt'), 'fixture');
    for (const args of [['init', '-q'], ['add', 'source.txt'], ['commit', '-qm', 'fixture']])
      execFileSync('git', ['-C', worktree, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'pipe' });
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', worktree, 'update-ref', 'refs/heads/review-base', head]);
    const scope = { worktree, phase: 49, ticket: 'T-49-05', run_id: 'isolated-review' };
    const content = "developer_instructions = '''\nReview all required material.\n'''";
    const typedInstructions = 'Review all required material.\n';
    const instructions = options.typed ? typedInstructions : runtime.generatedInstructions(content);
    const profile = options.batch ? collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 2,
      candidate: { source_sha256: sha(fs.readFileSync(require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
        instructions_sha256: sha(instructions), model: selection.model, effort: selection.effort, provider: 'openai' } }) : null;
    let input = collector.prepareFileInput(scope, options.batch ? 'x'.repeat(8191) + '€' + 'é'.repeat(9000) + 'short €' : 'required material\n'.repeat(2000), {
      ...(profile ? { readerProfile: profile } : {}),
      role: options.role || 'arch-review', dispatchId: 'original-review', storageRoot: path.join(root, 'inputs'),
      generatedInstructionBytes: Buffer.byteLength(options.typed ? typedInstructions : runtime.generatedInstructions(content)) + 2,
      binding: { base: head, base_ref: 'refs/heads/review-base', merge_base: head, ticket_set: ['T-49-05'], ticket_set_digest: sha(JSON.stringify(['T-49-05'])) },
    });
    const reads = readRecords(input);
    const home = path.join(root, 'codex');
    let capacity;
    if (options.typed) {
      fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(home, 'agents/shipyard-arch-review.toml'),
        'name = "shipyard-arch-review"\ndescription = "Architecture reviewer"\nsandbox_mode = "read-only"\n' + content + '\n');
    }
    const reviewerSession = options.typed ? childSession : session;
    const date = new Date();
    const directory = path.join(home, 'sessions', String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(directory, { recursive: true });
    const native = path.join(directory, reviewerSession + '.jsonl');
    const parent = path.join(directory, session + '.jsonl');
    const result = JSON.stringify({ verdict: 'conform', input_manifest_sha256: input.input_bundle.manifest_sha256,
      input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
      input_chunk_reads: collector.verifyFileInput(input).chunk_reads,
      ...(options.batch ? { input_batch_reads: reads.length, input_profile_sha256: input.manifest.transport.profile_sha256 } : {}) });
    if (options.batch) {
      const probeHome = path.join(root, 'capacity-native');
      const probeDirectory = path.join(probeHome, 'sessions', String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
      fs.mkdirSync(probeDirectory, { recursive: true });
      const probe = path.join(probeDirectory, session + '.jsonl');
      fs.writeFileSync(probe, serialize([nativeMetadata(session, worktree), nativeContext('capacity-turn', worktree),
        message('developer', 'capacity-turn', instructions), message('user', 'capacity-turn', input.prompt),
        event('task_started', 'capacity-turn'), ...nativeReads(reads, 'capacity-turn'), ...finish('capacity-turn', result)]));
      fs.chmodSync(probe, 0o600);
      const verified = await runtime.verifyCompletedNativeLaunch({ session_id: session, selection,
        env: { CODEX_HOME: probeHome }, resultText: result });
      assert.throws(() => runtime.measureReaderCapacity(verified, input), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      const application = await recordedBatchApplication(verified, input, root,
        serialize([cliThread(session), ...cliCompletion(result)]), options.separateProbe, options.mutateProbeAssociation);
      assert.throws(() => runtime.measureReaderCapacity(verified, input,
        { recorder: {}, receipt: JSON.parse(JSON.stringify(application.receipt)) }),
      error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      capacity = runtime.measureReaderCapacity(verified, input, application);
      assert.throws(() => collector.admitReaderBatchInput(input, JSON.parse(JSON.stringify(capacity))),
        error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      input = collector.admitReaderBatchInput(input, capacity);
    }
    const metadata = nativeMetadata(reviewerSession, worktree, options.typed);
    const context = nativeContext('original-turn', worktree);
    let progress, attempts = 0, resumedCommands = [], firstRaw, closed = false, liveCredit = false;
    const originalCount = options.noOutput ? 0 : options.originalCount || 1;
    const references = []; const stdin = []; const completions = [];
    const calls = [];
    const hostOptions = { scope, recorder: () => true, transcriptDir: path.join(root, 'transcripts'),
      env: { CODEX_HOME: home }, probe: { status: 'available', runtime_version: 'fixture', executable: 'codex',
        capabilities: { supportedModels: [selection.model], supportedEfforts: [selection.effort] } },
      spawn(executable, args) {
        calls.push(args); attempts++;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.pid = process.pid; child.kill = () => {};
        child.stdin = { write(value) { stdin.push(value); }, end() { process.nextTick(() => {
          if (attempts === 1) {
            const typedRecords = [];
            if (options.typed) {
              const sent = stdin.at(-1);
              const taskPath = /^TASK_FILE=(.*)$/m.exec(sent)[1];
              const taskDigest = /^TASK_SHA256=(.*)$/m.exec(sent)[1];
              fs.writeFileSync(parent, serialize([
                nativeMetadata(session, worktree), nativeContext('parent-turn', worktree),
                event('task_started', 'parent-turn'),
                response('function_call', 'parent-turn', { name: 'spawn_agent', call_id: 'spawn',
                  arguments: JSON.stringify({ agent_type: 'shipyard-arch-review', model: selection.model,
                    reasoning_effort: selection.effort, fork_turns: 'none', task_name: 'gsd_task' }) }, parentRecords),
                response('function_call_output', 'parent-turn', { call_id: 'spawn',
                  output: JSON.stringify({ task_name: '/root/gsd_task' }) }, parentRecords),
              ]));
              const taskOutput = response('custom_tool_call_output', 'original-turn', { call_id: 'task-read' });
              taskOutput.payload.output = [{ ...taskOutput.payload.output[1],
                text: 'TASK_SHA256=' + taskDigest + '\n' + fs.readFileSync(taskPath, 'utf8') }];
              typedRecords.push(message('developer', 'original-turn', typedInstructions),
                message('user', 'original-turn', 'TASK_FILE=' + taskPath + '\nTASK_SHA256=' + taskDigest),
                response('custom_tool_call', 'original-turn', { name: 'exec', call_id: 'task-read',
                  input: 'text(await tools.exec_command(' + JSON.stringify({ cmd: 'cat ' + taskPath, max_output_tokens: 10000 }) + '));' }),
                taskOutput);
            }
            const prefix = [metadata, context, ...typedRecords, event('task_started', 'original-turn'),
              ...nativeReads(reads.slice(0, originalCount), 'original-turn'),
              ...(options.pendingBatch ? nativeReads(reads.slice(originalCount, originalCount + 1), 'original-turn', originalCount).slice(0, 1) : []),
              ...((options.groupedBatch || options.groupedPendingBatch) ? (() => {
                const nested = nativeReads(reads.slice(originalCount, originalCount + 2), 'original-turn', originalCount);
                const call = nested[0], output = nested[1];
                call.payload.call_id = 'original-turn-grouped'; output.payload.call_id = call.payload.call_id;
                call.payload.input += '\n' + nested[2].payload.input;
                if (options.groupedPendingBatch) {
                  const pending = JSON.parse(nested[3].payload.output[1].text);
                  delete pending.exit_code; pending.session_id = 123;
                  nested[3].payload.output[1].text = JSON.stringify(pending);
                }
                output.payload.output.push(nested[3].payload.output[1]);
                return [call, output];
              })() : []),
              ...(options.incompleteBatch ? (() => {
                const interrupted = nativeReads(reads.slice(originalCount, originalCount + 1), 'original-turn', originalCount);
                const envelope = JSON.parse(interrupted[1].payload.output[1].text);
                envelope.output = envelope.output.split('\n').slice(0, -2).join('\n') + '\n';
                interrupted[1].payload.output[1].text = JSON.stringify(envelope);
                return interrupted;
              })() : []),
              ...(options.typed ? [event('task_aborted', 'original-turn')] : [])];
            firstRaw = serialize(options.tamperOriginal ? options.tamperOriginal(prefix) : prefix);
            fs.writeFileSync(native, options.live ? serialize(prefix.slice(0, 3)) : firstRaw);
            child.stdout.emit('data', Buffer.from(serialize([cliThread(session)])));
            if (options.premature) {
              fs.appendFileSync(native, serialize(finish('original-turn', 'premature')));
              child.stdout.emit('data', Buffer.from(serialize(cliCompletion('premature'))));
            }
            if (options.live) {
              setTimeout(() => fs.writeFileSync(native, firstRaw), 30);
              setTimeout(() => { closed = true; child.emit('close', 1); }, 400);
            } else { closed = true; child.emit('close', options.premature ? 0 : 1); }
          } else {
            resumedCommands = reads.slice(originalCount).map(read => read.command);
            let remaining = nativeReads(reads.slice(originalCount), 'resumed-turn', 1);
            if (options.tamperResume) remaining = options.tamperResume(remaining, reads);
            fs.appendFileSync(native, serialize([nativeContext('resumed-turn', worktree), event('task_started', 'resumed-turn'), ...remaining,
              ...finish('resumed-turn', options.resumedResult || result)]));
            child.stdout.emit('data', Buffer.from(serialize([cliThread(reviewerSession), ...cliCompletion(options.resumedResult || result)])));
            child.emit('close', 0);
          }
        }); } };
        return child;
      } };
    const createHost = () => runtime.createCodexRuntimeHost(hostOptions);
    const host = createHost();
    const launch = { dispatch_id: 'original-review', input_transport: 'host-files', input_bundle: input.input_bundle,
      input_prepared: input, prompt: input.prompt, review_progress: true,
      ...(options.typed ? { gsd_role: 'shipyard-arch-review', gsd_launch_mechanism: 'typed-gsd-callback' } : {}),
      onReviewProgress: reference => { progress = reference; references.push(reference); liveCredit ||= !closed; } };
    const staticSelection = options.typed ? { ...selection }
      : { ...selection, agent_file_content: content, agent_file_digest: sha(content) };
    const restore = options.beforeLaunch?.({ root, worktree });
    try { await assert.rejects(host.launchStatic(staticSelection, launch)); } finally { restore?.(); }
    await action({ root, worktree, input, host, progress, calls, native, parent, reviewerSession, firstRaw, reads, result,
      selection: staticSelection, capacity, createHost, scope, stdin, references, completions,
      liveCredit, launch, get resumedCommands() { return resumedCommands; } });
  } finally { os.homedir = oldHome; fs.rmSync(root, { recursive: true, force: true }); }
}

test('interrupted observed prefix rehydrates and resumes the exact session with fresh final evidence', async () => {
  await fixture(async f => {
    assert.ok(f.progress, 'complete live output must commit protected progress before process failure');
    const recovered = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.equal(recovered.schema, 'shipyard.review-progress.v1');
    assert.equal(recovered.completed_ranges, 1);
    assert.equal(recovered.state.original_exit.code, 1);
    assert.equal(recovered.original_launch.process_id, process.pid);
    assert.throws(() => collector.restoreReviewInput(JSON.parse(JSON.stringify(recovered)), 'new-review'));
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'new-review',
      onCompleted: evidence => f.completions.push(evidence) });
    assert.equal(f.completions.length, 1);
    assert.equal(f.completions[0].last_agent_message, f.result);
    assert.deepEqual(f.calls[1].slice(0, 2), ['exec', 'resume']);
    assert.ok(f.calls[1].includes(session));
    assert.ok(!f.calls[1].includes('--last'));
    assert.equal(f.resumedCommands.length, f.reads.length - 1);
    assert.equal(completed.runtime_evidence.dispatch_id, 'new-review');
    assert.equal(completed.runtime_evidence.review_continuation.original_dispatch_id, 'original-review');
    assert.equal(completed.runtime_evidence.input_consumption.chunk_reads, f.reads.length);
    assert.equal(completed.runtime_evidence.review_continuation.semantic_context, 'exact-native-session');
    assert.equal(authority.validateReviewContinuationEvidence(completed.runtime_evidence).identity.head,
      f.input.manifest.snapshot.head);
    assert.equal(completed.runtime_evidence.review_continuation.inherited_ranges, 1);
    assert.ok(f.stdin[1].includes('Do not reread those ranges'));
    assert.ok(f.calls[1].some(value => value === 'model_reasoning_effort="high"'));
    assert.ok(f.calls[1].some(value => value.includes('permissions.shipyard-runtime.filesystem')));
    assert.ok(!f.calls[1].includes('--cd'));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'another-review' }));
  });
});

test('live native observer persists output before an interrupted process closes without a second stdout event', async () => {
  await fixture(async f => {
    assert.ok(f.progress);
    assert.equal(f.liveCredit, true);
    assert.equal(f.references.length, 1);
  }, { live: true });
});

test('typed reviewer resumes its authenticated semantic child UUID and preserves original parent and role attestation', async () => {
  await fixture(async f => {
    assert.ok(f.progress);
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.equal(progress.session_id, childSession);
    assert.equal(progress.parent_session_id, session);
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'typed-resume' });
    assert.ok(f.calls[1].includes(childSession));
    assert.ok(!f.calls[1].includes(session));
    assert.equal(completed.runtime_evidence.session_id, childSession);
    assert.equal(completed.runtime_evidence.native_child_evidence.parent_thread_id, session);
    assert.equal(completed.runtime_evidence.native_child_evidence.agent_role, 'shipyard-arch-review');
    assert.equal(completed.runtime_evidence.review_continuation.original_launch.gsd_role, 'shipyard-arch-review');
    assert.equal(completed.runtime_evidence.input_consumption.chunk_reads, f.reads.length);
    assert.equal(authority.validateReviewContinuationEvidence(completed.runtime_evidence).session_id, childSession);
  }, { typed: true });
});

test('typed parent evidence drift cannot authorize the semantic child continuation', async () => {
  await fixture(async f => {
    assert.ok(f.progress);
    fs.writeFileSync(f.parent, fs.readFileSync(f.parent, 'utf8').replace('shipyard-arch-review', 'shipyard-integrator'));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'foreign-parent' }));
    assert.equal(f.calls.length, 1);
  }, { typed: true });
});

test('an older original UUID resumes through its protected path without recent-session lookup', async () => {
  await fixture(async f => {
    const OriginalDate = global.Date;
    global.Date = class extends OriginalDate {
      constructor(...args) {
        super(...args);
        if (!args.length) this.setDate(this.getDate() + 10);
      }
    };
    try {
      const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'durable-resume' });
      assert.equal(completed.runtime_evidence.session_id, session);
      assert.equal(completed.runtime_evidence.review_continuation.original_dispatch_id, 'original-review');
    } finally { global.Date = OriginalDate; }
  });
});

test('protected multi-range predecessor chain survives a new host and loss of private prepared-input memory', async () => {
  await fixture(async f => {
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.equal(progress.completed_ranges, 2);
    assert.equal(progress.chain.length, 2);
    assert.throws(() => authority.readReviewProgress({ worktree: f.worktree, reference: progress.chain[1].predecessor }));
    assert.equal(progress.chain[1].predecessor.sha256, sha(stable(progress.chain[0])));
    const modulePath = require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
    const saved = require.cache[modulePath];
    delete require.cache[modulePath];
    try {
      assert.equal(require(modulePath).isPreparedFileInput(f.input), false);
      const completed = await f.createHost().resumeReview(f.selection, { progress: f.progress, dispatch_id: 'cold-resume' });
      assert.equal(completed.runtime_evidence.review_continuation.inherited_ranges, 2);
      assert.equal(f.resumedCommands.length, f.reads.length - 2);
    } finally { require.cache[modulePath] = saved; }
  }, { originalCount: 2 });
});

test('premature original final stays rejected while a fresh resumed final covers the remaining material', async () => {
  await fixture(async f => {
    assert.ok(fs.readFileSync(f.native, 'utf8').includes('premature'));
    assert.throws(() => runtime.verifyFileConsumption(f.input, fs.readFileSync(f.native, 'utf8'), 'original-review', 'premature'));
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'fresh-final' });
    assert.equal(completed.runtime_evidence.review_continuation.fresh_turn_id, 'resumed-turn');
    assert.ok(fs.readFileSync(f.native, 'utf8').includes('premature'));
    await assert.rejects(runtime.verifyCompletedNativeLaunch({ session_id: session,
      env: { CODEX_HOME: path.join(f.root, 'codex') }, selection: f.selection, resultText: f.result, waitMs: 0 }));
  }, { premature: true });
});

test('crash before any native output grants no durable credit', async () => {
  await fixture(async f => {
    assert.equal(f.progress, undefined);
    await assert.rejects(f.host.resumeReview(f.selection, { progress: { completed_ranges: 1 }, dispatch_id: 'forged' }));
    assert.equal(f.calls.length, 1);
  }, { noOutput: true });
});

test('crash after complete output but before atomic tip publication permits a full reread without credited bytes', async () => {
  await fixture(async f => {
    assert.equal(f.progress, undefined);
    const directory = authority.archiveAuthorityDirectory(f.worktree);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('review-tip-')), false);
    const raw = serialize([nativeMetadata(session, f.worktree), nativeContext('reread', f.worktree),
      event('task_started', 'reread'), ...nativeReads(f.reads, 'reread'), ...finish('reread', f.result)]);
    assert.equal(runtime.verifyFileConsumption(f.input, raw, 'original-review', f.result).chunk_reads, f.reads.length);
  }, { beforeLaunch({ root }) {
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target.startsWith(root) && path.basename(target).startsWith('review-tip-')) throw new Error('fixture crash before tip');
      return rename(source, target);
    };
    return () => { fs.renameSync = rename; };
  } });
});

for (const [name, mutate] of [
  ['signature', envelope => { envelope.mac = '0'.repeat(64); }],
  ['predecessor', envelope => { envelope.payload.predecessor = { reference: 'review-progress-' + 'a'.repeat(64) + '.json', sha256: 'a'.repeat(64) }; }],
  ['session', envelope => { envelope.payload.session_id = '22222222-2222-4222-8222-222222222222'; }],
  ['subject', envelope => { envelope.payload.identity.head = 'a'.repeat(40); }],
  ['role', envelope => { envelope.payload.identity.role = 'integrator'; }],
  ['ordered range', envelope => { envelope.payload.range.ordinal++; }],
  ['cursor regression', envelope => { envelope.payload.completed_ranges = 0; }],
  ['semantic context', envelope => { envelope.payload.semantic_context = null; }],
  ['unknown version', envelope => { envelope.payload.schema = 'shipyard.review-progress.v99'; }],
]) {
  test('refuses forged protected ' + name, async () => {
    await fixture(async f => {
      const file = path.join(authority.archiveAuthorityDirectory(f.worktree), f.progress.reference);
      const envelope = JSON.parse(fs.readFileSync(file)); mutate(envelope);
      fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
      await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'tampered' }));
      assert.equal(f.calls.length, 1);
    });
  });
}

test('stale authority key and caller-supplied transcript cannot recover original progress', async () => {
  await fixture(async f => {
    const cached = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    const file = path.join(authority.archiveAuthorityDirectory(f.worktree), 'hmac.key');
    fs.writeFileSync(file, crypto.randomBytes(32));
    assert.throws(() => collector.restoreReviewInput(cached));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress,
      dispatch_id: 'stale-key' }));
    assert.equal(f.calls.length, 1);
  });
});

for (const [name, mutate] of [
  ['changed worktree source', f => fs.writeFileSync(path.join(f.worktree, 'source.txt'), 'changed')],
  ['changed immutable manifest', f => { fs.chmodSync(f.input.input_bundle.manifest_path, 0o600);
    fs.appendFileSync(f.input.input_bundle.manifest_path, ' '); }],
  ['changed dictionary material', f => { const file = f.input.manifest.assets[0].path;
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'altered material'); }],
  ['unrelated transcript', f => fs.writeFileSync(f.native, f.firstRaw.replaceAll(session, '22222222-2222-4222-8222-222222222222'))],
  ['missing semantic context', f => fs.unlinkSync(f.native)],
  ['truncated native prefix', f => fs.writeFileSync(f.native, f.firstRaw.slice(0, -80))],
  ['symlink native transcript', f => { const moved = f.native + '.original'; fs.renameSync(f.native, moved); fs.symlinkSync(moved, f.native); }],
  ['changed interrupted CLI history', f => { const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    fs.appendFileSync(progress.state.original_exit.transcript.path, 'altered historical output'); }],
]) {
  test(name + ' requires full review before another process can start', async () => {
    await fixture(async f => {
      mutate(f);
      await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'changed' }));
      assert.equal(f.calls.length, 1);
    });
  });
}

for (const changes of [{ model: 'gpt-6-sol' }, { effort: 'low' }, { sandbox_mode: 'workspace-write' },
  { agent_file_digest: 'a'.repeat(64) }]) {
  test('changed reviewer selection cannot claim continuation ' + JSON.stringify(changes), async () => {
    await fixture(async f => {
      await assert.rejects(f.host.resumeReview({ ...f.selection, ...changes }, { progress: f.progress, dispatch_id: 'changed-selection' }));
      assert.equal(f.calls.length, 1);
    });
  });
}

for (const [name, tamperResume] of [
  ['duplicate inherited credit', (records, reads) => [...nativeReads(reads.slice(0, 1), 'resumed-turn', 500), ...records]],
  ['missing remaining range', records => records.slice(2)],
  ['overlapping range', records => [records[0], records[1], ...records]],
  ['reordered remaining range', records => [...records.slice(2, 4), ...records.slice(0, 2), ...records.slice(4)]],
  ['foreign output turn', records => { records[1].payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign'; return records; }],
  ['incomplete native output', records => { records[1].payload.output[1].text = JSON.stringify({ exit_code: 0, output: 'truncated' }); return records; }],
  ['unsuccessful native output', records => { const result = JSON.parse(records[1].payload.output[1].text); result.exit_code = 1;
    records[1].payload.output[1].text = JSON.stringify(result); return records; }],
]) {
  test('fresh final refuses ' + name + ' and leaves its protected dispatch unaccepted', async () => {
    await fixture(async f => {
      await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'bad-final' }));
      const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
      assert.equal(progress.state.resume.status, 'claimed');
      await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'replay' }));
      assert.equal(f.calls.length, 2);
    }, { tamperResume });
  });
}

test('wrong final identity echo never receives protected completed admission', async () => {
  await fixture(async f => {
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'wrong-echo' }));
    assert.equal(authority.readReviewProgress({ worktree: f.worktree, reference: f.progress }).state.resume.status, 'claimed');
  }, { resumedResult: JSON.stringify({ verdict: 'conform', input_manifest_sha256: 'a'.repeat(64) }) });
});

test('changed base reference invalidates identical packet and HEAD before resume', async () => {
  await fixture(async f => {
    const next = execFileSync('git', ['-C', f.worktree, '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD'],
    { input: 'fixture base change\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', f.worktree, 'update-ref', 'refs/heads/review-base', next]);
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'base-drift' }));
    assert.equal(f.calls.length, 1);
  });
});

test('unverified semantic compaction or a different role requires full review', async () => {
  await fixture(async f => {
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'role-drift', role: 'integrator' }));
    fs.appendFileSync(f.native, serialize([{ type: 'compacted', payload: { message: 'unverified semantic summary' } }]));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'context-drift' }));
    assert.equal(f.calls.length, 1);
  });
});

test('serialized cursor extensions and forged claims cannot bypass host progress methods', async () => {
  await fixture(async f => {
    await assert.rejects(f.host.resumeReview(f.selection, { progress: { ...f.progress, completed_ranges: 99 }, dispatch_id: 'cursor' }));
    assert.throws(() => authority.claimReviewContinuation({ worktree: f.worktree, reference: f.progress, nativeRaw: f.firstRaw }));
    assert.throws(() => authority.completeReviewContinuation({ worktree: f.worktree, reference: f.progress, verdict: 'conform' }));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'caller-transcript', nativeRaw: f.firstRaw }));
    assert.equal(f.calls.length, 1);
  });
});

test('an intervening unrelated native turn cannot supply semantic continuation', async () => {
  await fixture(async f => {
    fs.appendFileSync(f.native, serialize([event('task_started', 'unrelated-review'), ...finish('unrelated-review', 'unrelated conclusion')]));
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.throws(() => collector.restoreReviewInput(progress));
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'mixed-history' }));
    assert.equal(f.calls.length, 1);
  });
});

test('integrator role uses its own protected subject and fresh final', async () => {
  await fixture(async f => {
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'integration-resume', role: 'integrator' });
    assert.equal(authority.validateReviewContinuationEvidence(completed.runtime_evidence).identity.role, 'integrator');
    assert.equal(completed.runtime_evidence.input_consumption.chunk_reads, f.reads.length);
  }, { role: 'integrator' });
});

test('a bare serialized descriptor or observation cannot publish protected authority', async () => {
  await fixture(async f => {
    assert.throws(() => collector.verifyFileInput(JSON.parse(JSON.stringify(f.input))));
    assert.throws(() => authority.persistReviewProgress({ nativeRaw: f.firstRaw, input: f.input, completed_ranges: 1 }));
    const other = collector.prepareFileInput({ ...f.scope, run_id: 'another-packet' }, 'unrelated material', {
      role: 'arch-review', dispatchId: 'unrelated', storageRoot: path.join(f.root, 'other-inputs') });
    assert.throws(() => collector.restoreReviewInput({ ...other, ...JSON.parse(JSON.stringify(
      authority.readReviewProgress({ worktree: f.worktree, reference: f.progress }))) }));
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'legitimate' });
    assert.throws(() => authority.validateReviewContinuationEvidence({ ...completed.runtime_evidence, dispatch_id: 'relabelled' }));
    assert.throws(() => authority.validateReviewContinuationEvidence({ ...completed.runtime_evidence,
      review_continuation: { ...completed.runtime_evidence.review_continuation, inherited_ranges: 999 } }));
  });
});

test('legacy one-turn full read succeeds and unrelated extra turns remain refused', async () => {
  await fixture(async f => {
    const raw = serialize([nativeMetadata(session, f.worktree), nativeContext('legacy', f.worktree),
      event('task_started', 'legacy'), ...nativeReads(f.reads, 'legacy'), ...finish('legacy', f.result)]);
    assert.equal(runtime.verifyFileConsumption(f.input, raw, 'original-review', f.result).chunk_reads, f.reads.length);
    assert.throws(() => runtime.verifyFileConsumption(f.input, raw + serialize([event('task_started', 'foreign'),
      ...finish('foreign', f.result)]), 'original-review', f.result));
  });
});

test('v3 one physical output atomically credits two frames and resumes the original UUID', async () => {
  await fixture(async f => {
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.equal(progress.schema, 'shipyard.review-progress.v3');
    assert.equal(progress.completed_ranges, 2);
    assert.equal(progress.chain[0].range.call_id, progress.chain[1].range.call_id);
    assert.equal(progress.chain[0].range.native_bytes, progress.chain[1].range.native_bytes);
    assert.equal(progress.chain[0].range.native_sha256, progress.chain[1].range.native_sha256);
    assert.equal(progress.chain[1].range.frame_index, 1);
    assert.throws(() => authority.readReviewProgress({ worktree: f.worktree, reference: progress.chain[1].predecessor }));
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'batch-resume' });
    assert.equal(completed.runtime_evidence.session_id, session);
    assert.equal(completed.runtime_evidence.review_continuation.inherited_ranges, 2);
    assert.equal(completed.runtime_evidence.input_consumption.chunk_reads, collector.verifyFileInput(f.input).chunk_reads);
    assert.equal(f.resumedCommands.length, f.reads.length - 1);
    assert.ok(!f.resumedCommands.includes(f.reads[0].command));
    assert.ok(f.stdin[1].includes(f.reads[1].command));
  }, { batch: true });
});

test('v3 uncredited truncated batch remains in original history and is retried without rereading durable frames', async () => {
  await fixture(async f => {
    assert.equal(authority.readReviewProgress({ worktree: f.worktree, reference: f.progress }).completed_ranges, 2);
    const failed = fs.readFileSync(f.native, 'utf8');
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'batch-retry' });
    assert.ok(fs.readFileSync(f.native, 'utf8').startsWith(failed));
    assert.equal(completed.runtime_evidence.review_continuation.inherited_ranges, 2);
    assert.equal(f.resumedCommands[0], f.reads[1].command);
  }, { batch: true, incompleteBatch: true });
});

for (const mutation of ['missing receipt', 'changed receipt', 'changed CLI transcript']) {
  test('v3 protected resume refuses ' + mutation + ' before claiming or spawning', async () => {
    await fixture(async f => {
      const contract = f.capacity.contract;
      const receiptFile = path.join(contract.application_receipt_store,
        'record-' + sha(contract.application_dispatch_id) + '.json');
      const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      const before = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
      const calls = f.calls.length;
      if (mutation === 'missing receipt') fs.unlinkSync(receiptFile);
      else if (mutation === 'changed receipt') {
        record.payload.receipt.observed_model = 'gpt-6-luna';
        fs.writeFileSync(receiptFile, JSON.stringify(record));
      } else fs.appendFileSync(record.payload.receipt.runtime_evidence.transcript.path, '{}\n');
      await assert.rejects(f.createHost().resumeReview(f.selection,
        { progress: f.progress, dispatch_id: 'receipt-refusal' }));
      assert.equal(f.calls.length, calls);
      const after = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
      assert.deepEqual(after, before);
    }, { batch: true });
  });
}

const batchMutations = [
  ['nested truncation', output => { output[1].text = output[1].text.slice(0, -2); }],
  ['outer truncation', output => { output[0].text = 'Warning: truncated output\n'; }],
  ['pending shell', output => { const result = JSON.parse(output[1].text); result.session_id = 123; output[1].text = JSON.stringify(result); }],
  ['surplus nested operation', output => { output.push(structuredClone(output[1])); }],
  ['omitted terminal', output => { const result = JSON.parse(output[1].text); result.output = result.output.split('\n').slice(0, -2).join('\n') + '\n'; output[1].text = JSON.stringify(result); }],
  ['wrong profile', output => { const result = JSON.parse(output[1].text); result.output = result.output.replace(/"profile_sha256":"[a-f0-9]+"/, '"profile_sha256":"' + '0'.repeat(64) + '"'); output[1].text = JSON.stringify(result); }],
  ['duplicate frame', output => { const result = JSON.parse(output[1].text); const lines = result.output.split('\n'); lines.splice(2, 0, lines[1]); result.output = lines.join('\n'); output[1].text = JSON.stringify(result); }],
  ['reordered frames', output => { const result = JSON.parse(output[1].text); const lines = result.output.split('\n'); [lines[1], lines[2]] = [lines[2], lines[1]]; result.output = lines.join('\n'); output[1].text = JSON.stringify(result); }],
  ['overlapping range', output => { const result = JSON.parse(output[1].text); const lines = result.output.split('\n'); const frame = JSON.parse(lines[1]); frame.offset++; lines[1] = JSON.stringify(frame); result.output = lines.join('\n'); output[1].text = JSON.stringify(result); }],
  ['trailer digest', output => { const result = JSON.parse(output[1].text); result.output = result.output.replace(/"frames_sha256":"[a-f0-9]+"/, '"frames_sha256":"' + '0'.repeat(64) + '"'); output[1].text = JSON.stringify(result); }],
];
for (const [name, mutate] of batchMutations) test('v3 ' + name + ' grants zero batch credit', async () => {
  await fixture(async f => {
    assert.equal(f.progress, undefined);
    const whole = [nativeMetadata(session, f.worktree), nativeContext('whole', f.worktree), event('task_started', 'whole'),
      ...nativeReads(f.reads, 'whole'), ...finish('whole', f.result)];
    const output = whole.find(record => record.payload?.type === 'custom_tool_call_output');
    mutate(output.payload.output);
    assert.throws(() => runtime.verifyFileConsumption(f.input, serialize(whole), 'original-review', f.result));
  }, { batch: true, tamperOriginal(records) {
    mutate(records.find(record => record.payload?.type === 'custom_tool_call_output').payload.output);
    return records;
  } });
});

for (const crash of ['between records', 'before tip']) test('v3 crash ' + crash + ' cannot publish partial batch credit', async () => {
  await fixture(async f => {
    assert.equal(f.progress, undefined);
    const directory = authority.archiveAuthorityDirectory(f.worktree);
    assert.ok(fs.readdirSync(directory).some(name => name.startsWith('review-progress-')));
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('review-tip-')), false);
    const whole = serialize([nativeMetadata(session, f.worktree), nativeContext('reread', f.worktree),
      event('task_started', 'reread'), ...nativeReads(f.reads, 'reread'), ...finish('reread', f.result)]);
    const checked = runtime.verifyFileConsumption(f.input, whole, 'original-review', f.result);
    assert.equal(checked.chunk_reads, collector.verifyFileInput(f.input).chunk_reads);
    assert.equal(checked.physical_calls, f.reads.length);
  }, { batch: true, beforeLaunch({ root }) {
    const link = fs.linkSync, rename = fs.renameSync;
    let writes = 0;
    fs.linkSync = (source, target) => {
      if (crash === 'between records' && target.startsWith(root) && path.basename(target).startsWith('review-progress-') && ++writes === 2)
        throw new Error('fixture crash between immutable frames');
      return link(source, target);
    };
    fs.renameSync = (source, target) => {
      if (crash === 'before tip' && target.startsWith(root) && path.basename(target).startsWith('review-tip-')) throw new Error('fixture crash before atomic tip');
      return rename(source, target);
    };
    return () => { fs.linkSync = link; fs.renameSync = rename; };
  } });
});

test('v3 logical bytes survive short terminal ranges and multibyte splits with distinct physical counts', async () => {
  await fixture(async f => {
    const checked = collector.verifyFileInput(f.input);
    const frames = f.reads.flatMap(read => read.output.trim().split('\n').map(JSON.parse).filter(frame => frame.type === 'range'));
    assert.equal(frames.length, checked.chunk_reads);
    assert.ok(frames.length > f.reads.length);
    assert.deepEqual(Buffer.concat(frames.filter(frame => frame.asset === 0).map(frame => Buffer.from(frame.base64, 'base64'))), checked.material[0]);
    assert.ok(frames.some(frame => frame.bytes < 8192));
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(frames.find(frame => frame.asset === 0).base64, 'base64')));
    const restored = collector.restoreReviewInput(authority.readReviewProgress({ worktree: f.worktree, reference: f.progress }));
    assert.equal(restored.input_bundle.transport.profile_sha256, f.input.input_bundle.transport.profile_sha256);
  }, { batch: true });
});

for (const [name, tamperResume] of [
  ['inherited batch reread', (records, reads) => [...nativeReads(reads.slice(0, 1), 'resumed-turn', 500), ...records]],
  ['replayed original call identity', records => { records[0].payload.call_id = 'original-turn-0'; records[1].payload.call_id = 'original-turn-0'; return records; }],
  ['duplicated fresh call identity', records => { records[2].payload.call_id = records[0].payload.call_id; records[3].payload.call_id = records[0].payload.call_id; return records; }],
  ['foreign output turn', records => { records[1].payload.internal_chat_message_metadata_passthrough.turn_id = 'foreign'; return records; }],
  ['wrong exact batch command', records => { const args = JSON.parse(/^text\(await tools.exec_command\((.*)\)\);$/.exec(records[0].payload.input)[1]); args.cmd += ' --eval'; records[0].payload.input = 'text(await tools.exec_command(' + JSON.stringify(args) + '));'; return records; }],
  ['late output', records => { records.push(records.splice(1, 1)[0]); return records; }],
]) test('v3 fresh final refuses ' + name, async () => {
  await fixture(async f => {
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'bad-batch-final' }));
    assert.equal(authority.readReviewProgress({ worktree: f.worktree, reference: f.progress }).state.resume.status, 'claimed');
  }, { batch: true, tamperResume });
});

for (const [name, mutate] of [
  ['changed subject HEAD', f => fs.writeFileSync(path.join(f.worktree, 'source.txt'), 'changed current source')],
  ['changed original capacity output', f => fs.appendFileSync(f.input.input_bundle.reader_capacity.native_file, '\n')],
  ['changed material', f => { const asset = f.input.manifest.assets[0]; fs.chmodSync(asset.path, 0o600); fs.writeFileSync(asset.path, 'foreign'); }],
  ['changed governing config', f => { fs.mkdirSync(path.join(f.worktree, '.planning')); fs.writeFileSync(path.join(f.worktree, '.planning/config.json'), '{}'); }],
]) test('v3 ' + name + ' invalidates restoration before a new process starts', async () => {
  await fixture(async f => {
    mutate(f);
    await assert.rejects(f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'batch-drift' }));
    assert.equal(f.calls.length, 1);
  }, { batch: true });
});

test('v3 premature historical final remains rejected after a fresh current judgment', async () => {
  await fixture(async f => {
    const rejected = fs.readFileSync(f.native, 'utf8');
    assert.ok(rejected.includes('premature'));
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'fresh-batch-final' });
    assert.equal(completed.runtime_evidence.review_continuation.fresh_turn_id, 'resumed-turn');
    assert.ok(fs.readFileSync(f.native, 'utf8').startsWith(rejected));
  }, { batch: true, premature: true });
});


for (const [name, change] of [
  ['role', options => { options.role = 'integrator'; }],
  ['base', options => { options.binding.base = 'a'.repeat(40); }],
  ['merge base', options => { options.binding.merge_base = 'b'.repeat(40); }],
  ['full ticket membership', options => {
    options.binding.ticket_set.push('T-49-16');
    options.binding.ticket_set_digest = sha(JSON.stringify(options.binding.ticket_set));
  }],
  ['candidate profile', options => { options.ranges_per_batch = 3; }],
]) test('v3 original capacity cannot be borrowed by another ' + name, async () => {
  await fixture(async f => {
    const options = { role: f.input.manifest.role, binding: structuredClone(f.input.manifest.binding), ranges_per_batch: 2 };
    change(options);
    const profile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: options.ranges_per_batch,
      candidate: f.input.manifest.transport.candidate });
    const other = collector.prepareFileInput(f.scope, collector.verifyFileInput(f.input).material, {
      role: options.role, binding: options.binding, readerProfile: profile, dispatchId: 'borrowed-capacity',
      storageRoot: path.join(f.root, 'other-inputs'), generatedInstructionBytes: f.input.manifest.accounting.generated_instruction_bytes,
    });
    assert.throws(() => collector.admitReaderBatchInput(other, f.capacity), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
    assert.throws(() => collector.requireReaderBatchCapacity(other), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
    assert.equal(f.calls.length, 1);
  }, { batch: true });
});


test('v3 typed reviewer resumes the original child UUID with its installed instruction identity', async () => {
  await fixture(async f => {
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    assert.equal(progress.schema, 'shipyard.review-progress.v3');
    assert.equal(progress.session_id, childSession);
    assert.equal(progress.parent_session_id, session);
    const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: 'typed-batch-final' });
    assert.ok(f.calls[1].includes(childSession));
    assert.equal(completed.runtime_evidence.input_consumption.schema, 'shipyard.native-file-consumption.v3');
    assert.equal(completed.runtime_evidence.input_consumption.physical_calls, f.reads.length);
    assert.equal(completed.runtime_evidence.input_consumption.logical_ranges, collector.verifyFileInput(f.input).chunk_reads);
    assert.equal(completed.runtime_evidence.native_child_evidence.parent_thread_id, session);
    assert.equal(authority.validateReviewContinuationEvidence(completed.runtime_evidence).session_id, childSession);
  }, { batch: true, typed: true });
});

for (const role of ['arch-review', 'integrator']) test('v3 protected ' + role + ' continuation reauthenticates the separate probe association', async () => {
  await fixture(async f => {
    const capacity = f.input.input_bundle.reader_capacity;
    assert.notEqual(capacity.application_dispatch_id, f.input.manifest.dispatch_id);
    assert.equal(capacity.probe_association.review_dispatch_id, f.input.manifest.dispatch_id);
    const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
    const restored = collector.restoreReviewInput(progress);
    assert.deepEqual(restored.input_bundle.reader_capacity, capacity);
    const completed = await f.createHost().resumeReview(f.selection, { progress: f.progress, dispatch_id: 'separate-probe-final' });
    assert.equal(completed.runtime_evidence.session_id, f.reviewerSession);
    assert.equal(completed.runtime_evidence.review_continuation.inherited_ranges, 2);
    assert.ok(!f.resumedCommands.includes(f.reads[0].command));
    assert.equal(authority.validateReviewContinuationEvidence(completed.runtime_evidence).identity.role, role);
  }, { batch: true, role, separateProbe: true });
});

for (const [name, mutate] of [
  ['final dispatch', association => { association.review_dispatch_id = 'foreign-final'; }],
  ['probe dispatch', association => { association.probe_dispatch_id = 'capacity-probe-00000000-0000-4000-8000-000000000000'; }],
  ['same dispatch', association => { association.probe_dispatch_id = association.review_dispatch_id; }],
  ['manifest', association => { association.manifest_sha256 = '0'.repeat(64); }],
  ['profile', association => { association.profile_sha256 = '0'.repeat(64); }],
  ['subject', association => { association.binding_sha256 = '0'.repeat(64); }],
  ['surplus', association => { association.cached = true; }],
]) test('v3 original protected probe refuses changed ' + name + ' association', async () => {
  await assert.rejects(fixture(() => assert.fail('changed probe must not admit review'), {
    batch: true, separateProbe: true, mutateProbeAssociation: mutate,
  }), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
});

async function completedSourceFixture(role, cold, mutation, action, failFirst = false, claimRace = false, failedEnvelope = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-review-source-')));
  const previousHome = os.homedir;
  os.homedir = () => root;
  try {
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, 'source.txt'), 'current original source\n');
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'original source']])
      execFileSync('git', ['-C', worktree, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', ...args]);
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', worktree, 'update-ref', 'refs/heads/review-base', head]);
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const adapterModule = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
    const scope = { repository: 'fixture/repository', worktree, phase: 49, ticket: 'T-49-18', run_id: 'original-completed-source', runtime: 'codex', provider: 'openai' };
    const dispatchId = 'fresh-final-' + crypto.randomUUID();
    const selected = policy.resolveDispatch({ runtime: 'codex', role, signals: {}, dispatch_id: dispatchId });
    const home = path.join(root, 'codex'), agents = path.join(home, 'agents'); fs.mkdirSync(agents, { recursive: true });
    const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"',
      '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"', '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
      '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "' + role + '"', '# shipyard-policy-rung = "' + selected.rung + '"',
      'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"', 'model = "' + selected.model + '"',
      'model_reasoning_effort = "' + selected.effort + '"', 'sandbox_mode = "read-only"',
      "developer_instructions = '''", 'Review all required material.', "'''", ''].join('\n');
    fs.writeFileSync(path.join(agents, selected.agent_file), content);
    const agentManifest = path.join(agents, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
      policy_hash: policy.POLICY_HASH, agent_files: [selected.agent_file], agent_digests: { [selected.agent_file]: sha(content) } }));
    const instructions = runtime.generatedInstructions(content);
    const profile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 8,
      candidate: { source_sha256: sha(fs.readFileSync(require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
        instructions_sha256: sha(instructions), model: selected.model, effort: selected.effort, provider: 'openai' } });
    let input = collector.prepareFileInput(scope, 'Complete current source, including multibyte € material.\n'.repeat(1500), {
      role, dispatchId, readerProfile: profile, storageRoot: path.join(root, 'inputs'),
      generatedInstructionBytes: Buffer.byteLength(instructions) + 2,
      binding: { base: head, base_ref: 'refs/heads/review-base', merge_base: head, ticket_set: ['T-49-18'],
        ticket_set_digest: sha(JSON.stringify(['T-49-18'])), agent_file: selected.agent_file,
        agent_path: path.join(agents, selected.agent_file), agent_sha256: sha(content), policy_hash: policy.POLICY_HASH } });
    const manifestBytes = fs.readFileSync(input.input_bundle.manifest_path);
    const manifestIdentity = stable(input.manifest);
    const recorder = boundaryModule.createDurableRecorder(path.join(root, 'receipts'));
    const date = new Date(), directory = path.join(home, 'sessions', String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(directory, { recursive: true });
    const native = path.join(directory, session + '.jsonl');
    let launches = 0, probeCallbacks = 0, finalCallbacks = 0, finalPrompt;
    const concurrentClaims = [];
    const echo = () => ({ input_manifest_sha256: input.input_bundle.manifest_sha256,
      input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
      input_chunk_reads: input.manifest.ranges.length, input_batch_reads: input.manifest.batches.length,
      input_profile_sha256: input.manifest.transport.profile_sha256 });
    const spawn = (_program, args) => {
      const launchIndex = ++launches, failure = failFirst && launchIndex === 1;
      const index = args.includes('resume') ? 2 : 1, turn = failure ? 'failed-complete-probe' : index === 1 ? 'original-complete-probe' : 'new-current-final';
      assert.equal(args[args.indexOf('--model') + 1], selected.model);
      if (index === 2) { assert.ok(args.includes('resume')); assert.ok(args.includes(session)); }
      const child = new EventEmitter(); child.pid = 45200 + index;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let stdin = '';
      child.stdin = { write(bytes) { stdin += String(bytes); }, end() {
        const prompt = index === 1 ? input.prompt : stdin.trim();
        if (index === 2) finalPrompt = prompt;
        const context = nativeContext(turn, worktree);
        Object.assign(context.payload, { model: selected.model, effort: selected.effort });
        Object.assign(context.payload.collaboration_mode.settings, { model: selected.model, reasoning_effort: selected.effort });
        const result = JSON.stringify({ ...echo(), judgment: index === 1 ? 'obsolete probe conclusion' : 'independent current judgment' });
        if (index === 2 && claimRace) concurrentClaims.push(assert.rejects(() => host.resumeCompletedSource({ ...selected,
          sandbox_mode: 'read-only', agent_file_content: content, agent_file_digest: sha(content) }, {
          source, dispatch_id: dispatchId, role }), { code: 'REVIEW_SOURCE_CLAIMED' }));
        if (failure) {
          const failedFile = path.join(directory, childSession + '.jsonl');
          const failedReads = nativeReads(readRecords(input).slice(0, 1), turn);
          if (failedEnvelope) {
            const output = failedReads.find(row => row.payload.type === 'custom_tool_call_output');
            const nested = JSON.parse(output.payload.output[1].text);
            nested.output = nested.output.slice(0, -128); nested.truncated = true;
            output.payload.output[1].text = JSON.stringify(nested);
          }
          const failed = [nativeMetadata(childSession, worktree), context, message('developer', turn, instructions),
            message('user', turn, prompt), event('task_started', turn), ...failedReads,
            event('task_aborted', turn)];
          process.nextTick(() => {
            fs.writeFileSync(failedFile, serialize(failed), { mode: 0o600 });
            child.stdout.emit('data', Buffer.from(serialize([cliThread(childSession),
              cliCompletion('')[0], { type: 'turn.failed', error: { message: 'Original actual interrupted probe' } }])));
            child.emit('close', 1, null);
          });
          return;
        }
        const records = index === 1 ? [nativeMetadata(session, worktree), context,
          message('developer', turn, instructions), message('user', turn, prompt), event('task_started', turn),
          ...nativeReads(readRecords(input), turn), ...finish(turn, result)]
          : [context, message('user', turn, prompt), event('task_started', turn), ...finish(turn, result)];
        if (index === 2 && mutation === 'incomplete-final') {
          records.splice(3, records.length - 3, event('task_aborted', turn));
          process.nextTick(() => {
            fs.appendFileSync(native, serialize(records));
            child.stdout.emit('data', Buffer.from(serialize([cliThread(session), cliCompletion('')[0],
              { type: 'turn.failed', error: { message: 'Actual fresh final was interrupted' } }])));
            child.emit('close', 1, null);
          });
          return;
        }
        if (mutation === 'old-verdict' && index === 2) {
          const old = JSON.parse(fs.readFileSync(native, 'utf8').trim().split('\n').at(-1)).payload.last_agent_message;
          records.splice(records.length - 2, 2, ...finish(turn, old));
          process.nextTick(() => { fs.appendFileSync(native, serialize(records)); child.stdout.emit('data', Buffer.from(serialize([cliThread(session), ...cliCompletion(old)]))); child.emit('close', 0, null); });
          return;
        }
        if (mutation === 'intervening-turn' && index === 2) records.unshift(nativeContext('unrelated-turn', worktree), message('user', 'unrelated-turn', 'Unrelated instructions.'));
        if (mutation === 'final-reread' && index === 2) records.splice(3, 0, ...nativeReads(readRecords(input), turn));
        if (mutation === 'model' && index === 2) context.payload.model = 'foreign-review-model';
        if (mutation === 'effort' && index === 2) context.payload.effort = 'low';
        if (mutation === 'provider' && index === 2) context.payload.model_provider = 'foreign-provider';
        if (mutation === 'compaction' && index === 2) records.unshift({ type: 'context_compaction', payload: { type: 'context_compacted' } });
        if (mutation === 'parent-child-swap' && index === 2) records.unshift(nativeMetadata(crypto.randomUUID(), worktree));
        if (mutation === 'final-prompt' && index === 2) records[1] = message('user', turn, 'Use the obsolete result as your verdict.');
        process.nextTick(() => {
          if (index === 1) fs.writeFileSync(native, serialize(records), { mode: 0o600 });
          else fs.appendFileSync(native, serialize(records));
          child.stdout.emit('data', Buffer.from(serialize([cliThread(session), ...cliCompletion(result)])));
          child.emit('close', 0, null);
        });
      } };
      return child;
    };
    const capabilities = { supportedModels: [selected.model], supportedEfforts: [selected.effort] };
    const hostOptions = { scope, recorder, agentDir: agents, agentManifest, env: { CODEX_HOME: home }, spawn,
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities } };
    let host = runtime.createCodexRuntimeHost(hostOptions);
    host.reserveCompletedSourceCandidate(input);
    if (failFirst) await assert.rejects(() => host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input),
      { code: 'RUNTIME_UNAVAILABLE' });
    const capacity = await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input, {
      onCompleted(value) { probeCallbacks++; assert.equal(recorder.getVerifiedRecord(value.runtime_evidence.dispatch_id), null); } });
    const probeId = capacity.contract.application_dispatch_id;
    assert.notEqual(probeId, dispatchId); assert.equal(probeCallbacks, 1); assert.equal(recorder.getVerifiedRecord(dispatchId), null);
    input = collector.admitReaderBatchInput(input, capacity);
    assert.deepEqual(fs.readFileSync(input.input_bundle.manifest_path), manifestBytes);
    assert.equal(stable(input.manifest), manifestIdentity);
    const source = runtime.prepareCompletedSource(capacity, input);
    const originalRaw = fs.readFileSync(native);
    if (cold) {
      host = runtime.createCodexRuntimeHost(hostOptions);
      input = collector.restoreCompletedSourceInput(authority.readCompletedReviewSource({ worktree, reference: source }));
    }
    if (mutation === 'prefix') { const bytes = fs.readFileSync(native, 'utf8'); fs.writeFileSync(native, bytes.replace('"type":"session_meta"', '"type":"session_meta","mutated":true')); }
    if (mutation === 'source') fs.writeFileSync(path.join(worktree, 'source.txt'), 'foreign source mutation\n');
    if (mutation === 'agent') fs.appendFileSync(path.join(agents, selected.agent_file), '\n# replaced\n');
    if (['profile', 'roster', 'subject'].includes(mutation)) {
      const manifestPath = input.input_bundle.manifest_path;
      const originalMode = fs.statSync(manifestPath).mode & 0o777;
      const bytes = JSON.parse(fs.readFileSync(manifestPath));
      if (mutation === 'profile') bytes.transport.profile_sha256 = 'f'.repeat(64);
      if (mutation === 'roster') bytes.binding.ticket_set.push('T-49-99');
      if (mutation === 'subject') bytes.ticket = 'T-49-99';
      fs.chmodSync(manifestPath, 0o600);
      fs.writeFileSync(manifestPath, JSON.stringify(bytes));
      fs.chmodSync(manifestPath, originalMode);
    }
    if (mutation === 'base') execFileSync('git', ['-C', worktree, 'update-ref', '-d', 'refs/heads/review-base']);

    const adapter = adapterModule.createCodexDispatchAdapter({ agentsDir: agents, agentManifest, capabilities,
      host: { requireRuntimeEvidence: true, launchStatic(applied, context) {
        return host.resumeCompletedSource(applied, { source, dispatch_id: context.dispatch_id,
          ...(cold ? {} : { input_prepared: input }), role,
          ...(mutation === 'subject-kind' ? { subject_kind: 'phase' } : {}),
          onCompleted(value) { finalCallbacks++; assert.equal(recorder.getVerifiedRecord(dispatchId), null); assert.equal(value.session_id, session); } });
      } } });
    const boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
    const launch = async () => boundary.dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: dispatchId }, { ticket: scope.ticket });
    if (mutation) {
      if (mutation === 'subject-kind') {
        await assert.rejects(launch, { code: 'REVIEW_SOURCE_INVALID' });
        assert.equal(launches, 1, 'subject substitution refuses before a final native launch');
        assert.equal(finalCallbacks, 0);
        assert.ok(recorder.getVerifiedRecord(probeId));
      } else await assert.rejects(launch, error => ['REVIEW_SOURCE_INVALID', 'REVIEW_RESTART_REQUIRED', 'STALE_CONTEXT', 'STALE_GENERATED_AGENT', 'RUNTIME_EVIDENCE_MISMATCH', 'RUNTIME_EVIDENCE_INVALID', 'RUNTIME_UNAVAILABLE', 'INPUT_BUNDLE_INVALID', 'INPUT_BUNDLE_CHANGED'].includes(error.code) || /changed|manifest|profile|base|git.*failed/i.test(error.message));
      assert.equal(recorder.getVerifiedRecord(dispatchId), null);
      if (mutation === 'incomplete-final') {
        const failed = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.equal(failed.state.resume.status, 'incomplete');
        assert.equal(failed.state.resume.native_status, 'interrupted');
        assert.equal(failed.probe_evidence.dispatch_id, probeId);
        assert.ok(recorder.getVerifiedRecord(probeId), 'original completed probe retains its original durable receipt');
        assert.deepEqual(authority.readReviewSourceAttempts(failed).map(attempt => attempt.status), ['completed', 'failed']);
        assert.ok(failed.state.resume.physical_snapshot.bytes > failed.snapshot.bytes, 'actual failed final has a nonempty distinct append');
        assert.deepEqual(fs.readFileSync(native).subarray(0, originalRaw.length), originalRaw);
        assert.throws(() => runtime.verifyCompletedReviewConsumption({ worktree, source, receipt_store: recorder.storeDir, dispatch_id: dispatchId }));
      }
      return;
    }
    const final = await launch();
    await Promise.all(concurrentClaims);
    assert.equal(launches, failFirst ? 3 : 2); assert.equal(finalCallbacks, 1);
    assert.equal(final.receipt.role, role); assert.equal(final.receipt.compliance, 'verified');
    assert.equal(final.receipt.runtime_evidence.session_id, session);
    assert.equal(final.receipt.runtime_evidence.completed_source.original_dispatch_id, probeId);
    assert.equal(final.receipt.runtime_evidence.completed_source.semantic_credit, false);
    assert.equal(final.receipt.runtime_evidence.completed_source.new_physical_calls, 0);
    assert.ok(finalPrompt.includes('Issue a genuinely fresh current judgment'));
    assert.ok(!finalPrompt.includes('obsolete probe conclusion'));
    assert.deepEqual(fs.readFileSync(native).subarray(0, originalRaw.length), originalRaw);
    assert.equal(stable(input.manifest), manifestIdentity);
    authority.validateCompletedSourceEvidence(final.receipt.runtime_evidence);
    const accounting = runtime.verifyCompletedReviewConsumption({ worktree, source, receipt_store: recorder.storeDir, dispatch_id: dispatchId });
    assert.deepEqual(accounting.attempts.map(attempt => attempt.status), failFirst ? ['failed', 'completed', 'completed'] : ['completed', 'completed']);
    assert.equal(accounting.all_attempt_denominator, failFirst ? 3 : 2);
    assert.equal(accounting.successful_physical_calls, input.manifest.batches.length);
    assert.equal(accounting.attempts.at(-2).successful_calls, input.manifest.batches.length);
    assert.equal(accounting.attempts.at(-1).successful_calls, 0);
    if (failFirst) {
      assert.equal(accounting.attempts[0].native_status, 'interrupted');
      assert.equal(accounting.attempts[0].successful_calls, failedEnvelope ? 0 : 1, 'failed physical outputs never invent source credit');
      if (failedEnvelope) {
        assert.equal(accounting.attempts[0].failed_calls, 1);
        assert.equal(accounting.attempts[0].delivered_raw_bytes, null);
        assert.ok(accounting.attempts[0].unavailable_reasons.delivered_raw_bytes);
        assert.ok(accounting.attempts[0].observed_partial_outer_bytes > 0);
      } else assert.ok(accounting.attempts[0].delivered_raw_bytes > 0);
    }
    if (failedEnvelope) {
      assert.equal(accounting.physical_bytes.raw, null, 'unknown failed source bytes do not become a zero-cost denominator');
      assert.ok(accounting.successful_source_bytes.raw >= input.input_bundle.total_bytes);
    } else assert.ok(accounting.physical_bytes.raw >= input.input_bundle.total_bytes);
    const originalFinalReceipt = stable(recorder.getVerifiedRecord(dispatchId).receipt);
    await assert.rejects(launch, { code: 'RECOVERY_ALREADY_RECORDED' });
    assert.equal(launches, failFirst ? 3 : 2, 'replay cannot start another native turn');
    assert.equal(finalCallbacks, 1, 'replay cannot issue another completion');
    assert.equal(stable(recorder.getVerifiedRecord(dispatchId).receipt), originalFinalReceipt,
      'replay preserves the original final receipt');
    if (action) await action({ input, capacity, source, final, accounting, recorder, host, root, native });
  } finally { os.homedir = previousHome; fs.rmSync(root, { recursive: true, force: true }); }
}

for (const role of ['arch-review', 'integrator']) {
  test('completed ' + role + ' source rejects a concurrent claimant before a second native launch',
    () => completedSourceFixture(role, false, null, null, false, true));
  test('completed ' + role + ' probe stays completed when its cold fresh final is genuinely interrupted',
    () => completedSourceFixture(role, true, 'incomplete-final'));
  for (const cold of [false, true]) test('completed ' + role + ' source is claimed once for a new original final ' + (cold ? 'after cold restoration' : 'live'),
    () => completedSourceFixture(role, cold));
  for (const cold of [false, true]) test('completed ' + role + ' source refuses subject-kind substitution ' + (cold ? 'cold' : 'live'),
    () => completedSourceFixture(role, cold, 'subject-kind'));
  for (const mutation of ['prefix', 'source', 'agent', 'old-verdict', 'intervening-turn', 'final-reread', 'model', 'effort', 'provider', 'compaction', 'parent-child-swap', 'final-prompt', 'profile', 'roster', 'subject', 'base'])
    test('completed ' + role + ' source refuses ' + mutation, () => completedSourceFixture(role, false, mutation));
}

for (const role of ['arch-review', 'integrator']) {
  test('completed ' + role + ' accounting retains failed probe costs without interrupted-probe credit',
    () => completedSourceFixture(role, true, null, null, true));
  test('completed ' + role + ' accounting keeps truncated failed output costs unknown in the full denominator',
    () => completedSourceFixture(role, true, null, null, true, false, true));
  test('completed ' + role + ' accounting refuses a missing original all-attempt ledger',
    () => completedSourceFixture(role, false, null, ({ source, input, recorder }) => {
      const sealed = authority.readCompletedReviewSource({ worktree: input.manifest.snapshot.worktree, reference: source });
      const directory = path.dirname(sealed.snapshot.path);
      const ledger = fs.readdirSync(directory).filter(file => /^review-tip-/.test(file)).find(file => {
        try { return JSON.parse(fs.readFileSync(path.join(directory, file))).payload.schema === 'shipyard.review-source-attempts.v1'; } catch { return false; }
      });
      assert.ok(ledger); fs.unlinkSync(path.join(directory, ledger));
      assert.throws(() => runtime.verifyCompletedReviewConsumption({ worktree: sealed.identity.worktree, source,
        receipt_store: recorder.storeDir, dispatch_id: sealed.identity.dispatch_id }));
    }));
}

async function automaticCompletedReviewFixture(role, cold, ordinary = false, moveBase = false) {
  const helper = require('./helpers/codex-arch-review-fixtures.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const f = helper.fixture();
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-completed-review-')));
  const previousHome = os.homedir; os.homedir = () => store;
  try {
    const ticket = 'T-38-01', branch = 'ticket/' + ticket;
    const graphDir = path.join(f.root, '.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
    const epic = 'epic/38-codex-arch-review';
    const base = role === 'integrator' && !ordinary ? epic : 'main';
    graph.tickets[ticket] = { ...graph.tickets[helper.TICKET], branch, epic, pr_base: base };
    const governingSources = new Map(), productSources = new Map(), previousProductSources = new Map();
    if (role === 'integrator' && !ordinary) {
      // @contract: complete governing records and product modules retain the existing per-file and diff bounds.
      for (const [name, document] of [
        ['ADR-014-host-bound-review.md', 'docs/gsd_multilevel_delivery_pipeline.md'],
        ['ADR-014-DISPATCH.md', 'docs/dispatch-record.md'],
      ]) {
        const relative = '.planning/architecture/' + name;
        const content = (name === 'ADR-014-host-bound-review.md' ? helper.ADR + '\n' : '')
          + fs.readFileSync(path.join(fixtureRoot, document), 'utf8');
        assert.ok(Buffer.byteLength(content) < 192 * 1024, 'complete bounded governing record');
        governingSources.set(relative, content); helper.write(f.root, relative, content);
      }
      for (const name of ['role-artifact', 'codex-runtime-host', 'codex-delivery-host', 'codex-arch-review-context', 'context-packet']) {
        const relative = 'src/' + name + '.cjs';
        const canonical = path.join(fixtureRoot, 'plugins/delivery-pipeline/scripts', name + '.cjs');
        const previous = fs.readFileSync(canonical, 'utf8');
        previousProductSources.set(relative, previous); helper.write(f.root, relative, previous);
        const content = "'use strict';\n// Delegate to the canonical implementation instead of retaining a divergent copy.\n"
          + 'module.exports = require(' + JSON.stringify(canonical) + ');\n';
        productSources.set(relative, content);
      }
      graph.tickets[ticket].files = ['src/reviewed.txt', ...productSources.keys()];
      const planPath = helper.planPath();
      const plan = fs.readFileSync(path.join(f.root, planPath), 'utf8')
        .replace('- Follows ADR-014.', '- Follows ADR-014 and its complete governing companions:\n'
          + [...governingSources.keys()].map(relative => '- ' + relative).join('\n'))
        .replace('- Review the authenticated PR diff against ADR-014.',
          '- Review the complete product custody, runtime, delivery, reader and packet modules against ADR-014 and the dispatch contract.');
      helper.write(f.root, planPath, plan);
      governingSources.set(planPath, plan);
      // @contract: the full previous modules and current delegating exports remain distinct review obligations.
      helper.git(f.root, ['add', '.planning', 'src']); helper.git(f.root, ['commit', '-m', 'Seed legacy product module copies and governing contracts']);
      f.base = helper.git(f.root, ['rev-parse', 'HEAD']);
      helper.git(f.root, ['update-ref', 'refs/heads/main', f.base]);
      helper.git(f.root, ['update-ref', 'refs/remotes/origin/main', f.base]);
      for (const [relative, content] of productSources) {
        helper.write(f.root, relative, content);
        const name = path.basename(relative);
        assert.equal(require(path.join(f.root, relative)), require(path.join(fixtureRoot, 'plugins/delivery-pipeline/scripts', name)),
          'refactored facade retains the canonical public exports');
      }
    } else if (role === 'arch-review') {
      helper.write(f.root, '.planning/architecture/ADR-014-host-bound-review.md', helper.ADR + 'Complete preserved architectural obligation.\n'.repeat(27000));
    }
    delete graph.tickets[helper.TICKET];
    fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify(graph));
    fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), JSON.stringify({ [ticket]: {
      status: role === 'integrator' ? 'merged' : 'pr-open', pr: 301, branch, base, epic,
      ...(role === 'integrator' ? { merged_into: epic } : {}) } }));
    helper.git(f.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    helper.git(f.root, ['branch', '-m', branch]);
    helper.git(f.root, ['add', '.planning', 'src']); helper.git(f.root, ['commit', '-m', 'Canonical complete large review subject']);
    f.head = helper.git(f.root, ['rev-parse', 'HEAD']);
    Object.assign(f.pr, { headRefName: branch, headRefOid: f.head, title: 'feat(' + ticket + '): source', body: ticket });
    if (role === 'integrator') {
      helper.git(f.root, ['checkout', '-b', epic]);
      helper.git(f.root, ['update-ref', 'refs/remotes/origin/' + epic, f.head]);
      Object.assign(f.pr, { state: 'MERGED', baseRefName: base, baseRefOid: f.base,
        mergedAt: new Date().toISOString(), mergeCommit: { oid: f.head } });
    }
    const gh = (program, args, options) => {
      if (program === 'git' && args.includes('fetch')) return '';
      if (program === 'gh') return JSON.stringify(f.pr);
      return execFileSync(program, args, options);
    };
    const canonicalOptions = { graphDir, refreshGit: false, getPullRequest: () => f.pr,
      listPullRequests: () => [f.pr], execFileSync: gh };
    const ordinaryMaterial = 'Complete ordinary integration input, including € source obligations.\n'.repeat(20000);
    const integration = role === 'integrator' && !ordinary ? require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
      .prepareIntegratorContext(canonicalOptions, { worktree: f.root, phase: '38' }) : null;
    const subject = integration ? integration.ticket : ticket;
    if (integration) {
      assert.ok([...governingSources].filter(([relative]) => relative.startsWith('.planning/architecture/'))
        .reduce((bytes, [, content]) => bytes + Buffer.byteLength(content), 0) < 768 * 1024,
      'complete governing corpus retains the existing aggregate limit');
      assert.ok(Buffer.byteLength(integration.packet.role_context.combined_diff.content) > 850 * 1024,
        'meaningful complete product diff remains large');
      assert.ok(Buffer.byteLength(integration.packet.role_context.combined_diff.content) < 1024 * 1024);
      assert.ok(Buffer.byteLength(integration.prompt) > 1000000, 'complete canonical aggregate remains over one megabyte');
      assert.ok(Buffer.byteLength(integration.prompt) <= 1500000, 'unchanged legacy preparation launch bound');
      assert.ok(integration.packet.accounting.overflow === false, 'unchanged integration packet token bound');
    }
    const scope = { repository: f.root, worktree: f.root, phase: 38, ticket: subject, run_id: 'automatic-' + role, runtime: 'codex', provider: 'openai' };
    const home = path.join(store, 'codex'), agents = path.join(home, 'agents'); fs.mkdirSync(agents, { recursive: true });
    const selectedFiles = [policy.resolveDispatch({ runtime: 'codex', role, signals: {} }),
      policy.resolveDispatch({ runtime: 'codex', role, signals: { critical: true } })];
    const contents = new Map();
    for (const selected of selectedFiles) {
      const content = ['# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"', '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
        '# shipyard-policy-runtime = "codex"', '# shipyard-policy-role = "' + role + '"', '# shipyard-policy-rung = "' + selected.rung + '"',
        'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"', 'model = "' + selected.model + '"',
        'model_reasoning_effort = "' + selected.effort + '"', 'sandbox_mode = "read-only"',
        "developer_instructions = '''", 'Judge all required current source material.', "'''", ''].join('\n');
      fs.writeFileSync(path.join(agents, selected.agent_file), content); contents.set(selected.agent_file, content);
    }
    const agentManifest = path.join(agents, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION,
      policy_hash: policy.POLICY_HASH, agent_files: [...contents.keys()], agent_digests: Object.fromEntries([...contents].map(([file, content]) => [file, sha(content)])) }));
    const recorder = boundary.createDurableRecorder(path.join(store, 'receipts'));
    const date = new Date(), directory = path.join(home, 'sessions', String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(directory, { recursive: true });
    const native = path.join(directory, session + '.jsonl');
    let launches = 0, originalManifest, originalBaseRef, originalPacket, originalProbeCompletion, physicalReads = 0;
    const spawn = (_program, args) => {
      const index = ++launches, turn = index === 1 ? 'automatic-probe' : 'automatic-new-final';
      assert.ok(index <= 2, 'one original probe and one genuinely new final');
      if (index === 2) {
        assert.ok(args.includes('resume')); assert.ok(args.includes(session));
        assert.ok(originalProbeCompletion, 'probe actually completed before the new final starts');
        const record = recorder.getVerifiedRecord(originalProbeCompletion.runtime_evidence.dispatch_id);
        assert.ok(record, 'original durable probe record precedes capacity and final launch');
        assert.equal(record.receipt.launch_id, originalProbeCompletion.launch_id);
      }
      const model = args[args.indexOf('--model') + 1];
      const effort = args.find(arg => arg.startsWith('model_reasoning_effort=')).match(/"(.*)"/)[1];
      const selected = selectedFiles.find(value => value.model === model && value.effort === effort);
      assert.ok(selected, 'original static policy selection');
      const content = contents.get(selected.agent_file), instructions = runtime.generatedInstructions(content);
      const child = new EventEmitter(); child.pid = 45300 + index;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); let stdin = '';
      child.stdin = { write(bytes) { stdin += String(bytes); }, end() {
        const prompt = index === 1 ? stdin.slice(instructions.length + 2).trim() : stdin.trim();
        if (index === 2) assert.ok(!prompt.includes('Obsolete measurement output.'), 'old probe verdict supplies no final semantic input');
        const manifestPath = prompt.match(/INPUT_MANIFEST=([^\n]+)/)[1];
        const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
        assert.equal(manifest.transport.schema, 'shipyard.native-reader-transport.v3');
        assert.ok(manifest.accounting.material_bytes > 1024 * 1024, 'whole large file-reader candidate');
        assert.match(manifest.binding.base_ref, new RegExp('^refs/(?:heads|remotes)/'));
        assert.equal(helper.git(f.root, ['rev-parse', manifest.binding.base_ref + '^{commit}']), manifest.binding.base);
        assert.equal(helper.git(f.root, ['merge-base', manifest.binding.base, f.head]), manifest.binding.merge_base);
        if (ordinary) {
          assert.match(manifest.binding.base_ref, /^refs\/(?:heads\/main|remotes\/origin\/main)$/,
            'canonical main resolves to its actual qualified local or tracking ref');
          assert.equal(manifest.binding.base, f.base, 'the resolved baseline commit remains exact');
          assert.equal(manifest.binding.merge_base, f.base, 'the original baseline remains an ancestor of this source');
          assert.notEqual(manifest.binding.base, f.head, 'the ordinary positive path reviews an actual changed subject');
        }
        if (index === 1) {
          originalManifest = manifestBytes;
          originalBaseRef = manifest.binding.base_ref;
          if (ordinary) assert.deepEqual(Buffer.concat(manifest.assets.map(asset => fs.readFileSync(asset.path))), Buffer.from(ordinaryMaterial));
          else originalPacket = packets.decodeUniqueContent(JSON.parse(fs.readFileSync(manifest.assets[0].path)));
          if (integration) {
            assert.equal(originalPacket.role_context.combined_diff.content, integration.packet.role_context.combined_diff.content,
              'entire meaningful product diff reaches original physical source input');
            assert.deepEqual(originalPacket.immutable_scope.files_modified, integration.packet.immutable_scope.files_modified);
            for (const [relative, content] of governingSources) {
              const reference = originalPacket.required_refs.find(item => item.path === relative);
              assert.ok(reference, 'required source purpose remains: ' + relative);
              assert.equal(reference.content, content, 'complete governing bytes: ' + relative);
              assert.equal(reference.sha256, sha(content));
              assert.equal(reference.bytes, Buffer.byteLength(content));
            }
            for (const [relative, content] of productSources) {
              assert.equal(fs.readFileSync(path.join(f.root, relative), 'utf8'), content);
              const patch = originalPacket.role_context.combined_diff.content.split('diff --git a/' + relative + ' b/' + relative + '\n')[1]
                ?.split('\ndiff --git ')[0];
              assert.ok(patch, 'complete product module has its own diff purpose');
              const hunk = patch.slice(patch.indexOf('@@')).split('\n').filter(line => /^[ +\-]/.test(line));
              const added = hunk.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
              assert.equal(added, content, 'every exact current module byte reaches review: ' + relative);
              const removed = hunk.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
              assert.equal(removed, previousProductSources.get(relative), 'every exact previous module byte reaches review: ' + relative);
            }
          }
        } else {
          assert.deepEqual(manifestBytes, originalManifest, 'finalized candidate remains byte-identical');
          assert.equal(manifest.binding.base_ref, originalBaseRef, 'fresh final preserves the exact selected canonical ref');
        }
        const echo = { input_manifest_sha256: sha(manifestBytes), input_material_bytes: manifest.accounting.material_bytes,
          input_asset_count: manifest.assets.length, input_chunk_reads: manifest.ranges.length,
          input_batch_reads: manifest.batches.length, input_profile_sha256: manifest.transport.profile_sha256 };
        let result = { ...echo, probe_only: true, summary: 'Obsolete measurement output.' };
        if (index === 2 && role === 'arch-review') {
          result = { ...echo, id: ticket, pr: f.pr.number, head: f.head,
            base_tree: originalPacket.diff.merge_base_tree, verdict: 'conform', findings: [], blocking_count: 0,
            summary: 'Fresh full current architectural judgment.', context_digest: originalPacket.digest,
            launch_digest: prompt.match(/launch_digest=([a-f0-9]{64})/)[1], evidence_markdown: 'Complete freshly evaluated current source evidence.' };
          result.context_digest = manifest.binding.packet_digest;
        }
        if (index === 2 && ordinary) result = { ...echo, judgment: 'Fresh complete ordinary integration judgment.' };
        if (index === 2 && role === 'integrator' && !ordinary) {
          const context = originalPacket.role_context, coverage = context.review_coverage;
          result = { ...echo, id: subject, phase: context.phase, outcome: 'passed', findings: [], blocking_count: 0,
            summary: 'Fresh complete current integration judgment.', head: f.head,
            head_tree: helper.git(f.root, ['rev-parse', 'HEAD^{tree}']), base: context.integration_base.ref,
            base_tree: context.integration_base.tree, ticket_set: context.ticket_set, ticket_set_digest: context.ticket_set_digest,
            context_digest: manifest.binding.packet_digest, reviewed_identity: coverage.reviewed_identity,
            coverage: { schema: 'shipyard.integration-coverage-result.v1', mode: coverage.mode, lineage_digest: coverage.digest,
              inherited_obligations: coverage.current_logical_obligations.filter(item => item.coverage === 'inherited').map(item => item.identity),
              newly_reviewed_obligations: coverage.current_logical_obligations.filter(item => item.coverage !== 'inherited').map(item => item.identity),
              impact_paths: coverage.impact.paths, limitations: coverage.limitations },
            evidence_markdown: 'Complete fresh integration evidence and all membership/ancestry obligations.' };
        }
        const text = JSON.stringify(result), context = nativeContext(turn, f.root);
        Object.assign(context.payload, { model, effort }); Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
        const reads = index === 1 ? manifest.batches.map(batch => {
          physicalReads++;
          const bundle = { manifest_path: manifestPath, transport: manifest.transport };
          return { command: collector.batchCommand(bundle, batch.index), output: execFileSync(process.execPath,
            [manifest.transport.module_path, '--read-batch', manifestPath, String(batch.index), manifest.transport.profile_sha256],
            { encoding: 'utf8', maxBuffer: 252 * 1024 }) };
        }) : [];
        const records = index === 1 ? [nativeMetadata(session, f.root), context, message('developer', turn, instructions),
          message('user', turn, prompt), event('task_started', turn), ...nativeReads(reads, turn), ...finish(turn, text)]
          : [context, message('user', turn, prompt), event('task_started', turn), ...finish(turn, text)];
        process.nextTick(() => {
          if (index === 1) fs.writeFileSync(native, serialize(records), { mode: 0o600 }); else fs.appendFileSync(native, serialize(records));
          child.stdout.emit('data', Buffer.from(serialize([cliThread(session), ...cliCompletion(text)]))); child.emit('close', 0, null);
        });
      } };
      return child;
    };
    const capabilities = { supportedModels: [...new Set(selectedFiles.map(value => value.model))], supportedEfforts: [...new Set(selectedFiles.map(value => value.effort))] };
    const hostOptions = { scope, agentDir: agents, agentManifest, recorder, env: { CODEX_HOME: home }, spawn,
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities } };
    const nativeHost = runtime.createCodexRuntimeHost(hostOptions);
    let probeCallbacks = 0, finalCallbacks = 0;
    const host = { ...nativeHost,
      async measureBatchReaderCapacity(applied, input) {
        const capacity = await nativeHost.measureBatchReaderCapacity(applied, input, { onCompleted(completion) {
          probeCallbacks++; originalProbeCompletion = completion;
        } });
        if (moveBase) {
          assert.ok(originalBaseRef, 'the completed probe observed the actual sealed canonical ref');
          assert.equal(helper.git(f.root, ['rev-parse', originalBaseRef + '^{commit}']), f.base);
          helper.git(f.root, ['update-ref', originalBaseRef, f.head]);
          assert.equal(helper.git(f.root, ['rev-parse', originalBaseRef + '^{commit}']), f.head,
            'move the exact production-selected ref, preserving the alternate main ref');
          const alternate = originalBaseRef === 'refs/heads/main' ? 'refs/remotes/origin/main' : 'refs/heads/main';
          assert.equal(helper.git(f.root, ['rev-parse', alternate + '^{commit}']), f.base,
            'an unchanged alternate ref cannot replace the sealed baseline');
        }
        return capacity;
      },
      resumeCompletedSource(applied, context) {
        assert.ok(!Object.prototype.hasOwnProperty.call(context, 'review_contract'),
          'the preparation selector does not become runtime resume authority');
        if (integration) assert.equal(context.input_prepared.manifest.binding.review_contract, 'shipyard.integration-review.v2',
          'the private finalized candidate retains the complete integration contract');
        const originalCompleted = context.onCompleted;
        const observed = { ...context, onCompleted(completion) {
          finalCallbacks++;
          return originalCompleted?.(completion);
        } };
        if (!cold) return nativeHost.resumeCompletedSource(applied, observed);
        const { input_prepared: _privateInput, ...selectors } = observed;
        return runtime.createCodexRuntimeHost(hostOptions).resumeCompletedSource(applied, selectors);
      },
    };
    const options = { ...canonicalOptions, scope, storageRoot: store, host, agentDir: agents, agentManifest,
      env: { CODEX_HOME: home } };
    let request = { role, context: ordinary ? { prompt: ordinaryMaterial } : { review_contract: 'shipyard.integration-review.v2' }, signals: {}, dispatch_id: 'automatic-final-' + crypto.randomUUID() };
    if (role === 'arch-review') {
      const preparation = collector.prepare(scope, { role, context: {}, signals: {} }, {
        ...canonicalOptions, inflightDispatchId: request.dispatch_id, storageRoot: path.join(store, 'inputs') });
      options.archReviewContext = preparation;
      request = { ...preparation.launch, signals: { ...preparation.launch.signals }, context: { ...preparation.launch.context }, dispatch_id: request.dispatch_id };
    }
    const run = () => delivery.createCodexDeliveryHost(options).run(request);
    if (moveBase) {
      await assert.rejects(run, error => ['REVIEW_RESTART_REQUIRED', 'BASE_MISMATCH', 'STALE_CONTEXT'].includes(error.code)
        && /base/i.test(error.message));
      assert.equal(launches, 1, 'a moved canonical baseline refuses before the fresh final native turn');
      assert.equal(probeCallbacks, 1);
      assert.equal(finalCallbacks, 0);
      assert.ok(recorder.getVerifiedRecord(originalProbeCompletion.runtime_evidence.dispatch_id),
        'base movement preserves the original actually completed probe record');
      assert.equal(recorder.getVerifiedRecord(request.dispatch_id), null, 'no final authority is fabricated');
      return;
    }
    const final = await run();
    assert.equal(launches, 2);
    assert.equal(probeCallbacks, 1, 'one original probe completion');
    assert.equal(finalCallbacks, 1, 'one original fresh final completion');
    assert.equal(final.receipt.compliance, 'verified');
    assert.equal(final.receipt.role, role);
    assert.equal(final.receipt.runtime_evidence.session_id, session);
    assert.equal(final.receipt.runtime_evidence.completed_source.new_physical_calls, 0);
    assert.notEqual(final.receipt.dispatch_id, final.receipt.runtime_evidence.completed_source.original_dispatch_id);
    const probe = recorder.getVerifiedRecord(final.receipt.runtime_evidence.completed_source.original_dispatch_id);
    const recordedFinal = recorder.getVerifiedRecord(final.receipt.dispatch_id);
    assert.ok(probe && recordedFinal, 'both distinct original durable records remain authenticated');
    assert.equal(probe.role, role); assert.equal(probe.receipt.compliance, 'verified');
    assert.equal(probe.receipt.runtime_evidence.reader_capacity_probe.review_dispatch_id, final.receipt.dispatch_id);
    assert.equal(probe.receipt.runtime_evidence.session_id, session);
    assert.notEqual(probe.receipt.launch_id, final.receipt.launch_id, 'fresh turn has its own native launch');
    assert.notEqual(probe.receipt.runtime_evidence.transcript.sha256, final.receipt.runtime_evidence.transcript.sha256);
    assert.equal(probe.receipt.runtime_evidence.input_bundle.manifest_sha256, final.receipt.runtime_evidence.input_bundle.manifest_sha256);
    assert.equal(stable(recordedFinal.receipt), stable(final.receipt), 'consumer receives the original fresh receipt');
    for (const field of ['role', 'requested_model', 'applied_model', 'observed_model', 'requested_effort', 'applied_effort', 'observed_effort', 'agent_file', 'agent_file_digest', 'policy_hash'])
      assert.equal(probe.receipt[field], final.receipt[field], 'unchanged original policy/selection identity: ' + field);
    if (ordinary) {
      authority.validateCompletedSourceEvidence(final.receipt.runtime_evidence);
      const consumed = collector.verifyFileInput(final.receipt.runtime_evidence.input_bundle, { sealed: true, historical: true });
      assert.deepEqual(Buffer.concat(consumed.material), Buffer.from(ordinaryMaterial));
    } else {
      assert.ok(final.artifact, 'unchanged final semantic/artifact consumer admitted current judgment');
      assert.equal(role === 'arch-review' ? final.artifact.outcome : final.artifact.envelope.outcome, role === 'arch-review' ? 'conform' : 'passed');
      if (role === 'arch-review') assert.equal(fs.readFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'), 'utf8'),
        'Complete freshly evaluated current source evidence.', 'host materializes the original fresh evidence without a model tool call');
      if (integration && cold) {
        const selectors = { worktreePath: f.root, role, phase: integration.phase,
          ticket: integration.ticket, base: integration.base, ticketSet: integration.ticketSet,
          ticketSetDigest: integration.ticketSetDigest, boundaryStore: recorder.storeDir,
          dispatchId: final.dispatch_id, artifactPath: final.artifact.artifact_path,
          artifactDigest: final.artifact.artifact_digest };
        const script = `
          const fs = require('node:fs'), path = require('node:path');
          require('node:os').homedir = () => process.argv[2];
          const authority = require(path.join(process.argv[1], 'plugins/delivery-pipeline/scripts/role-artifact.cjs'));
          const input = JSON.parse(fs.readFileSync(0, 'utf8'));
          const checked = authority.validateJudgmentManifest(input);
          process.stdout.write(JSON.stringify({ role: checked.role, digest: checked.artifact_digest }));
        `;
        const restored = JSON.parse(execFileSync(process.execPath, ['-e', script, fixtureRoot, store],
          { input: JSON.stringify(selectors), encoding: 'utf8' }));
        assert.equal(restored.role, role);
        assert.equal(restored.digest, final.artifact.artifact_digest,
          'cold standalone consumer retains the exact sealed original current judgment');
      }
    }
    const accounting = runtime.verifyCompletedReviewConsumption({ worktree: f.root, source: final.receipt.runtime_evidence.completed_source.source,
      receipt_store: recorder.storeDir, dispatch_id: final.receipt.dispatch_id });
    assert.equal(accounting.successful_physical_calls, physicalReads);
    assert.equal(accounting.all_attempt_denominator, 2, 'both complete original launches stay in the cost denominator');
    assert.deepEqual(accounting.attempts.map(attempt => attempt.status), ['completed', 'completed']);
    assert.equal(accounting.attempts[0].successful_calls, physicalReads, 'every original manifest and source batch remains charged');
    assert.equal(accounting.attempts[1].successful_calls, 0);
    assert.ok(accounting.successful_source_bytes.raw >= final.receipt.runtime_evidence.input_bundle.total_bytes,
      'zero fresh reads retain the full original material cost');
  } finally { os.homedir = previousHome; fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}

for (const role of ['arch-review', 'integrator']) for (const cold of [false, true])
  test('whole automatic ' + role + ' measurement and genuinely fresh ' + (cold ? 'cold' : 'live') + ' final reaches unchanged consumer',
    () => automaticCompletedReviewFixture(role, cold));

for (const cold of [false, true]) test('large ordinary canonical integration preserves whole input through automatic ' + (cold ? 'cold' : 'live') + ' final',
  () => automaticCompletedReviewFixture('integrator', cold, true));

for (const cold of [false, true]) test('automatic ordinary integration refuses canonical base movement after its original probe ' + (cold ? 'cold' : 'live'),
  () => automaticCompletedReviewFixture('integrator', cold, true, true));
