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
const completedSourceBaselines = new Map();
function copyCompletedSourceRepository(worktree, completed = true) {
  let baseline = completedSourceBaselines.get(completed);
  if (!baseline) {
    baseline = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-source-baseline-')));
    process.on('exit', () => fs.rmSync(baseline, { recursive: true, force: true }));
    fs.writeFileSync(path.join(baseline, 'source.txt'), completed ? 'current original source\n' : 'fixture');
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', completed ? 'original source' : 'fixture']])
      execFileSync('git', ['-C', baseline, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', ...args]);
    const head = execFileSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', baseline, 'update-ref', 'refs/heads/review-base', head]);
    completedSourceBaselines.set(completed, baseline);
  }
  if (worktree) fs.cpSync(baseline, worktree, { recursive: true });
  return baseline;
}
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
    return input.manifest.batches.map(batch => {
      const args = ['--read-batch', input.input_bundle.manifest_path,
        String(batch.index), input.manifest.transport.profile_sha256];
      const output = collector.readBatchCli(args);
      assert.ok(Buffer.byteLength(output) <= 252 * 1024);
      assert.equal(output, collector.batchOutput(input.manifest, checked.manifest_bytes, checked.material, batch.index));
      if (batch.index === 0 || batch.index === input.manifest.batches.length - 1)
        assert.equal(output, execFileSync('node', [input.manifest.transport.module_path, ...args],
          { encoding: 'utf8', maxBuffer: 252 * 1024 }));
      return { command: collector.batchCommand(input.input_bundle, batch.index), output };
    });
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
    copyCompletedSourceRepository(worktree, false);
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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


async function completedSourceFixture(role, cold, mutation, action, failFirst = false, claimRace = false, failedEnvelope = false, progressMessages = false, receiptFault = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-review-source-')));
  const previousHome = os.homedir;
  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  const originalWrite = fs.writeFileSync;
  const originalOpen = fs.openSync;
  const originalLink = fs.linkSync;
  os.homedir = () => root;
  try {
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree);
    copyCompletedSourceRepository(worktree);
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
    let input = collector.prepareFileInput(scope, 'Complete current source, including multibyte € material.\n'
      .repeat(mutation?.startsWith('prelaunch-') || mutation?.startsWith('seal-') || mutation === 'started-host-exit' || mutation?.startsWith('unmeasured-') ? 20 : 1500), {
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
    let nativeCallbacks = 0, transcriptCallbacks = 0, recoveryStarted = false;
    const recovery = mutation?.startsWith('recover-');
    const blockedRecord = path.join(recorder.storeDir, 'record-' + sha(dispatchId) + '.json');
    const concurrentClaims = [];
    let persistenceFaults = 0;
    const echo = () => ({ input_manifest_sha256: input.input_bundle.manifest_sha256,
      input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
      input_chunk_reads: input.manifest.ranges.length, input_batch_reads: input.manifest.batches.length,
      input_profile_sha256: input.manifest.transport.profile_sha256 });
    const spawn = (_program, args) => {
      const launchIndex = ++launches, failure = failFirst && launchIndex === 1;
      if (mutation === 'concurrent-probe' && launchIndex === 1) concurrentClaims.push(assert.rejects(() =>
        host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input), { code: 'REVIEW_SOURCE_INVALID' }));
      if (mutation === 'unmeasured-pending') {
        fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, dispatchId, role, capabilities,
          native, manifestBytes: manifestBytes.toString('base64'), producer_pid: process.pid }));
        process.exit(0);
      }
      const index = args.includes('resume') ? 2 : 1, turn = failure ? 'failed-complete-probe' : index === 1 ? 'original-complete-probe' : 'new-current-final';
      if (index === 2 && mutation === 'started-host-exit') {
        fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role, capabilities }));
        process.exit(0);
      }
      if (index === 2 && mutation === 'spawn-throw') throw new Error('Original spawn setup failed');
      if (index === 2 && mutation === 'invalid-child') return null;
      assert.equal(args[args.indexOf('--model') + 1], selected.model);
      if (index === 2) { assert.ok(args.includes('resume')); assert.ok(args.includes(session)); }
      const child = new EventEmitter(); child.pid = 45200 + index;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let stdin = '';
      child.stdin = { write(bytes) {
        if (index === 2 && mutation === 'stdin-throw') throw new Error('Original stdin setup failed');
        stdin += String(bytes);
      }, end() {
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
        if (index === 2 && ['incomplete-final', 'failed-prefix', 'failed-truncated'].includes(mutation)) {
          records.splice(3, records.length - 3, event('task_aborted', turn));
          process.nextTick(() => {
            fs.appendFileSync(native, serialize(records));
            if (mutation === 'failed-prefix') fs.writeFileSync(native, fs.readFileSync(native, 'utf8').replace('session_meta', 'foreign_meta'));
            if (mutation === 'failed-truncated') fs.writeFileSync(native, '{}\n');
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
          child.stdout.emit('data', Buffer.from(serialize([cliThread(session),
            ...(progressMessages ? [cliCompletion(result)[0],
              cliCompletion('Review in progress.')[1],
              ...cliCompletion(result).slice(1)] : cliCompletion(result))])));
          child.emit('close', 0, null);
        });
      } };
      return child;
    };
    const capabilities = { supportedModels: [selected.model], supportedEfforts: [selected.effort] };
    const hostOptions = { scope, recorder, agentDir: agents, agentManifest, env: { CODEX_HOME: home }, spawn,
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities } };
    let host = runtime.createCodexRuntimeHost(hostOptions);
    if (mutation === 'orphan-reservation') {
      assert.equal(recorder.reserve(dispatchId).reserved, true);
      const originalReservation = stable(recorder.getReservation(dispatchId));
      assert.throws(() => host.reserveCompletedSourceCandidate(input), {
        code: 'REVIEW_SOURCE_INVALID', message: /lacks authenticated original candidate custody/ });
      assert.equal(stable(recorder.getReservation(dispatchId)), originalReservation);
      assert.equal(launches, 0);
      assert.equal(recorder.getVerifiedRecord(dispatchId), null);
      return;
    }
    host.reserveCompletedSourceCandidate(input);
    if (failFirst) await assert.rejects(() => host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input),
      { code: 'RUNTIME_UNAVAILABLE' });
    if (mutation?.startsWith('unmeasured-') && mutation !== 'unmeasured-pending') {
      fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, dispatchId, role, capabilities,
        native, manifestBytes: manifestBytes.toString('base64'), producer_pid: process.pid }));
      process.exit(0);
    }
    let capacity = await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input, {
      onCompleted(value) { probeCallbacks++; assert.equal(recorder.getVerifiedRecord(value.runtime_evidence.dispatch_id), null); } });
    if (mutation === 'concurrent-probe') { await Promise.all(concurrentClaims); mutation = null; }
    const probeId = capacity.contract.application_dispatch_id;
    assert.notEqual(probeId, dispatchId); assert.equal(probeCallbacks, 1); assert.equal(recorder.getVerifiedRecord(dispatchId), null);
    input = collector.admitReaderBatchInput(input, capacity);
    assert.deepEqual(fs.readFileSync(input.input_bundle.manifest_path), manifestBytes);
    assert.equal(stable(input.manifest), manifestIdentity);
    let source;
    if (mutation?.startsWith('seal-')) {
      const probeRecord = stable(recorder.getVerifiedRecord(probeId));
      const reservation = stable(recorder.getReservation(dispatchId));
      const raw = fs.readFileSync(native);
      const cli = fs.readFileSync(capacity.contract.application_receipt_store
        && recorder.getVerifiedRecord(probeId).receipt.runtime_evidence.transcript.path);
      const contract = stable(capacity.contract);
      const fault = mutation.replace('seal-', '').replace('-host-exit', '');
      const descriptors = new Map();
      let linked = null;
      const target = file => typeof file === 'string' && path.basename(file).startsWith(
        fault.startsWith('envelope-') ? 'review-progress-' : 'review-tip-');
      const fail = () => { persistenceFaults++; throw new Error('Original post-measure source sealing failed'); };
      fs.openSync = (file, ...args) => {
        const fd = originalOpen(file, ...args); descriptors.set(fd, file); return fd;
      };
      fs.writeFileSync = (file, ...args) => {
        if (fault.endsWith('-write') && target(descriptors.get(file))) fail();
        return originalWrite(file, ...args);
      };
      fs.linkSync = (from, to) => {
        if (target(to) && fault.endsWith('-link')) fail();
        const result = originalLink(from, to);
        if (target(to)) linked = to;
        return result;
      };
      fs.fsyncSync = fd => {
        if (fault.endsWith('-file-fsync') && target(descriptors.get(fd))) fail();
        if (fault.endsWith('-directory-fsync') && linked && fs.fstatSync(fd).isDirectory()) fail();
        return originalFsync(fd);
      };
      assert.throws(() => runtime.prepareCompletedSource(capacity, input), /Original post-measure/);
      assert.equal(persistenceFaults, 1, 'the actual source envelope or tip persistence fault was reached');
      fs.openSync = originalOpen; fs.linkSync = originalLink; fs.fsyncSync = originalFsync; fs.writeFileSync = originalWrite;
      assert.equal(launches, 1); assert.equal(probeCallbacks, 1); assert.equal(finalCallbacks, 0);
      assert.equal(stable(recorder.getVerifiedRecord(probeId)), probeRecord);
      assert.equal(stable(recorder.getReservation(dispatchId)), reservation);
      assert.deepEqual(fs.readFileSync(native), raw);
      if (mutation.endsWith('-host-exit')) {
        fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, dispatchId, role, capabilities,
          probeId, native, contract, manifestBytes: manifestBytes.toString('base64'), producer_pid: process.pid }));
        process.exit(0);
      }
      if (cold) host = runtime.createCodexRuntimeHost(hostOptions);
      input = host.reserveCompletedSourceCandidate(input);
      capacity = await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input, {
        onCompleted() { assert.fail('successful probe recovery cannot issue another completion'); } });
      assert.equal(stable(capacity.contract), contract);
      input = collector.admitReaderBatchInput(input, capacity);
      source = runtime.prepareCompletedSource(capacity, input);
      assert.equal(launches, 1); assert.equal(probeCallbacks, 1);
      assert.equal(stable(recorder.getVerifiedRecord(probeId)), probeRecord);
      assert.equal(stable(recorder.getReservation(dispatchId)), reservation);
      assert.deepEqual(fs.readFileSync(native), raw);
      assert.deepEqual(fs.readFileSync(recorder.getVerifiedRecord(probeId).receipt.runtime_evidence.transcript.path), cli);
      assert.deepEqual(authority.readReviewSourceAttempts(authority.readCompletedReviewSource({ worktree, reference: source }))
        .map(attempt => attempt.status), ['completed']);
      mutation = null;
    } else source = runtime.prepareCompletedSource(capacity, input);
    const originalRaw = fs.readFileSync(native);
    if (cold) {
      host = runtime.createCodexRuntimeHost(hostOptions);
      input = collector.restoreCompletedSourceInput(authority.readCompletedReviewSource({ worktree, reference: source }));
    }
    if (mutation === 'prefix') {
      const records = fs.readFileSync(native, 'utf8').trim().split('\n').map(JSON.parse);
      const metadata = records.find(row => row.type === 'session_meta');
      assert.ok(metadata, 'original registered metadata is present before the prefix mutation');
      metadata.mutated = true;
      fs.writeFileSync(native, serialize(records));
    }
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
      host: { requireRuntimeEvidence: true, async launchStatic(applied, context) {
        if (mutation?.startsWith('prelaunch-') && !recoveryStarted) {
          const fault = mutation.replace(/-repeat$/, '');
          if (fault.endsWith('file-fsync')) fs.writeFileSync = (file, bytes, ...args) => {
            originalWrite(file, bytes, ...args);
            if (typeof file !== 'number') return;
            let payload;
            try { payload = JSON.parse(String(bytes)).payload; } catch { return; }
            if (!payload) return;
            const ledger = payload.schema === 'shipyard.review-source-attempts.v1'
              && payload.attempts.some(attempt => attempt.kind === 'final' && attempt.status === 'pending');
            const tip = payload.schema === 'shipyard.completed-review-source-tip.v1' && payload.resume?.launch_started;
            if (fault.includes('ledger') ? ledger : tip) {
              fs.writeFileSync = originalWrite; fs.renameSync = originalRename; persistenceFaults++;
              fs.fsyncSync = fd => {
                assert.ok(fs.fstatSync(fd).isFile(), 'fault occurs at the actual prelaunch temporary file fsync');
                fs.fsyncSync = originalFsync;
                throw new Error('Original prelaunch file fsync failed');
              };
            }
          };
          fs.renameSync = (from, to) => {
            if (fault.endsWith('file-fsync')) return originalRename(from, to);
            if (path.dirname(to) !== authority.archiveAuthorityDirectory(worktree)) return originalRename(from, to);
            const payload = JSON.parse(fs.readFileSync(from)).payload;
            const ledger = payload.schema === 'shipyard.review-source-attempts.v1'
              && payload.attempts.some(attempt => attempt.kind === 'final' && attempt.status === 'pending');
            const tip = payload.schema === 'shipyard.completed-review-source-tip.v1' && payload.resume?.launch_started;
            if ((fault.includes('ledger') ? ledger : tip)) {
              fs.renameSync = originalRename; persistenceFaults++;
              if (!fault.endsWith('before-write')) originalRename(from, to);
              if (fault.endsWith('fsync') || fault === 'prelaunch-host-exit') {
                fs.fsyncSync = fd => {
                  assert.ok(fs.fstatSync(fd).isDirectory(), 'fault occurs after the actual prelaunch rename');
                  fs.fsyncSync = originalFsync;
                  throw new Error('Original prelaunch directory fsync failed');
                };
                return;
              }
              throw new Error('Original prelaunch write failed');
            }
            return originalRename(from, to);
          };
        }
        if (mutation === 'base-after-claim') fs.renameSync = (from, to) => {
          originalRename(from, to);
          if (path.basename(to).startsWith('review-tip-')) {
            const tip = JSON.parse(fs.readFileSync(to)).payload;
            if (tip.schema === 'shipyard.completed-review-source-tip.v1' && tip.resume?.status === 'claimed' && !tip.resume.launch_started) {
              fs.renameSync = originalRename;
              execFileSync('git', ['-C', worktree, 'update-ref', '-d', 'refs/heads/review-base']);
            }
          }
        };
        if (['recover-tip-before-write', 'recover-tip-after-write', 'recover-ledger-after-write', 'recover-tip-fsync', 'recover-ledger-fsync'].includes(mutation) && !recoveryStarted) {
          fs.renameSync = (from, to) => {
            if (path.dirname(to) !== authority.archiveAuthorityDirectory(worktree)
                || !path.basename(to).startsWith('review-tip-')) return originalRename(from, to);
            const payload = JSON.parse(fs.readFileSync(from)).payload;
            const terminalTip = payload.schema === 'shipyard.completed-review-source-tip.v1' && payload.resume?.status === 'completed';
            const terminalLedger = payload.schema === 'shipyard.review-source-attempts.v1'
              && payload.attempts.some(attempt => attempt.kind === 'final' && attempt.status === 'completed');
            if ((terminalTip && !['recover-ledger-after-write', 'recover-ledger-fsync'].includes(mutation))
                || (terminalLedger && ['recover-ledger-after-write', 'recover-ledger-fsync'].includes(mutation))) {
              fs.renameSync = originalRename;
              persistenceFaults++;
              if (mutation !== 'recover-tip-before-write') originalRename(from, to);
              if (mutation.endsWith('-fsync')) {
                fs.fsyncSync = fd => {
                  assert.ok(fs.fstatSync(fd).isDirectory(), 'fault occurs at terminal directory fsync');
                  fs.fsyncSync = originalFsync;
                  throw new Error('Original terminal directory fsync failed');
                };
                return;
              }
              throw new Error('Original terminal state persistence failed');
            }
            return originalRename(from, to);
          };
        }
        const application = await host.resumeCompletedSource(applied, { source, dispatch_id: context.dispatch_id,
          ...(cold ? {} : { input_prepared: input }), role,
          ...(mutation === 'subject-kind' ? { subject_kind: 'phase' } : {}),
          ...(mutation === 'process-hook-throw' ? { onProcessSpawned() { throw new Error('Original process hook failed'); } } : {}),
          onNativeCompleted() {
            nativeCallbacks++;
            if (mutation === 'recover-inflight') concurrentClaims.push(assert.rejects(() => host.resumeCompletedSource(applied, {
              source, dispatch_id: dispatchId, role, input_prepared: input }), { code: 'REVIEW_SOURCE_CLAIMED' }));
            if (mutation === 'recover-host-exit') {
              fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role, capabilities }));
              process.exit(0);
            }
            if (recovery && !recoveryStarted && mutation === 'recover-native-callback') throw new Error('Original native completion callback failed');
          },
          onTranscriptWritten() {
            transcriptCallbacks++;
            if (recovery && !recoveryStarted && mutation === 'recover-transcript-callback') throw new Error('Original transcript callback failed');
          },
          onCompleted(value) {
            finalCallbacks++; assert.equal(recorder.getVerifiedRecord(dispatchId), null); assert.equal(value.session_id, session);
            if (recovery && !recoveryStarted && !['recover-record-gap', 'recover-record-repeat'].includes(mutation)
                && !['recover-tip-before-write', 'recover-tip-after-write', 'recover-ledger-after-write', 'recover-tip-fsync', 'recover-ledger-fsync'].includes(mutation)) throw new Error('Original final completion callback failed');
          } });
        if (mutation === 'recover-reconciliation-host-exit' && recoveryStarted) {
          fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role, capabilities }));
          process.exit(0);
        }
        if (mutation === 'recover-inflight' && recoveryStarted) {
          const active = authority.readCompletedReviewSource({ worktree, reference: source });
          assert.equal(active.state.resume.reconciliations.at(-1).status, 'pending');
          assert.throws(() => host.retainCompletedSourceRecordingFailure(source,
            { code: 'REVIEW_SOURCE_CLAIMED', message: 'Concurrent claimant refused' }), { code: 'REVIEW_SOURCE_CLAIMED' });
          assert.equal(stable(authority.readCompletedReviewSource({ worktree, reference: source }).state), stable(active.state));
          concurrentClaims.push(assert.rejects(() => host.resumeCompletedSource(applied, {
            source, dispatch_id: dispatchId, role, input_prepared: input }), { code: 'REVIEW_SOURCE_CLAIMED' }));
        }
        if (['recover-record-gap', 'recover-record-repeat'].includes(mutation) && !recoveryStarted) fs.mkdirSync(blockedRecord);
        return application;
      } } });
    let boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
    const launch = async () => {
      try {
        const result = await boundary.dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: dispatchId }, { ticket: scope.ticket });
        host.completeCompletedSourceRecording(source);
        return result;
      } catch (error) {
        if (error.code === 'RECORD_FAILED' && !receiptFault?.initial && !fs.existsSync(blockedRecord))
          host.retainCompletedSourceRecordingFailure(source, error);
        throw error;
      }
    };
    if (mutation?.startsWith('prelaunch-')) {
      await assert.rejects(launch, /Original prelaunch/);
      assert.equal(persistenceFaults, 1);
      assert.equal(launches, 1, 'the prelaunch failure never attempts a final spawn');
      assert.equal(finalCallbacks, 0); assert.equal(recorder.getVerifiedRecord(dispatchId), null);
      assert.deepEqual(fs.readFileSync(native), originalRaw);
      if (mutation === 'prelaunch-host-exit') {
        fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role, capabilities }));
        process.exit(0);
      }
      const retained = authority.readCompletedReviewSource({ worktree, reference: source });
      assert.equal(retained.state.resume.status, 'claimed');
      assert.equal(retained.state.resume.launch_started, undefined);
      assert.equal(retained.state.resume.prelaunch_failure.spawn_attempted, false);
      assert.deepEqual(authority.readReviewSourceAttempts(retained).map(attempt => attempt.status), ['completed', 'pending']);
      assert.equal(authority.readReviewSourceAttempts(retained).at(-1).prelaunch_failures.length, 1);
      assert.ok(recorder.getReservation(dispatchId)); assert.ok(recorder.getVerifiedRecord(probeId));
      if (mutation.endsWith('-repeat')) {
        const originalFailure = stable(retained.state.resume.prelaunch_failure);
        boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
        await assert.rejects(launch, /Original prelaunch/);
        const retried = authority.readCompletedReviewSource({ worktree, reference: source });
        const failures = authority.readReviewSourceAttempts(retried).at(-1).prelaunch_failures;
        assert.equal(failures.length, 2); assert.equal(persistenceFaults, 2);
        assert.equal(stable(failures[0]), originalFailure);
        assert.notEqual(failures[0].launch_started_id, failures[1].launch_started_id);
        assert.equal(retried.state.resume.launch_started, undefined);
        assert.equal(launches, 1); assert.equal(finalCallbacks, 0);
        assert.deepEqual(fs.readFileSync(native), originalRaw);
      }
      recoveryStarted = true;
      if (cold) host = runtime.createCodexRuntimeHost(hostOptions);
      boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
      mutation = null;
    }
    if (receiptFault?.initial) {
      let recordLinks = 0;
      fs.linkSync = (from, to) => {
        const value = originalLink(from, to);
        if (to === blockedRecord) {
          recordLinks++;
          if (receiptFault.fault.endsWith('link-response')) throw new Error('Original initial receipt acknowledgement lost');
          fs.fsyncSync = fd => {
            assert.ok(fs.fstatSync(fd).isDirectory()); fs.fsyncSync = originalFsync;
            throw new Error('Original initial receipt directory fsync failed');
          };
        }
        return value;
      };
      await assert.rejects(launch, { code: 'RECORD_FAILED' });
      fs.linkSync = originalLink; fs.fsyncSync = originalFsync;
      assert.equal(recordLinks, 1); assert.equal(launches, 2); assert.equal(finalCallbacks, 1);
      const pending = authority.readCompletedReviewSource({ worktree, reference: source });
      assert.equal(pending.state.resume.status, 'completed');
      assert.equal(pending.state.resume.delivery_pending, true);
      assert.equal(pending.state.resume.completion_failures, undefined);
      assert.equal(pending.state.resume.reconciliations, undefined);
      assert.ok(recorder.getVerifiedRecord(dispatchId));
      if (receiptFault.exit) {
        fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role,
          capabilities, producer_pid: process.pid, record_links: recordLinks }));
        process.exit(0);
      }
      const recordBytes = fs.readFileSync(blockedRecord), raw = fs.readFileSync(native);
      host.retainCompletedSourceRecordingFailure(source, { code: 'RECORD_FAILED', message: 'Original initial receipt acknowledgement lost' });
      const applied = { ...selected, sandbox_mode: 'read-only', agent_file_content: content, agent_file_digest: sha(content) };
      const recovered = await host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role });
      host.completeCompletedSourceDelivery(source);
      assert.equal(recovered.receipt.launch_id, pending.state.resume.completion.application.launch_id);
      assert.deepEqual(fs.readFileSync(blockedRecord), recordBytes); assert.deepEqual(fs.readFileSync(native), raw);
      assert.equal(launches, 2); assert.equal(finalCallbacks, 1);
      await assert.rejects(() => host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role }),
        { code: 'REVIEW_SOURCE_CLAIMED' });
      return;
    }
    if (recovery) {
      await assert.rejects(launch, { code: ['recover-record-gap', 'recover-record-repeat'].includes(mutation) ? 'RECORD_FAILED' : 'RUNTIME_EVIDENCE_INVALID' });
      if (mutation.includes('-write') || mutation.endsWith('-fsync')) {
        assert.equal(persistenceFaults, 1, 'the original terminal write fault was actually reached');
        assert.equal(launches, 2, 'the fresh native turn completed before the persistence fault');
      }
      if (['recover-record-gap', 'recover-record-repeat'].includes(mutation)) {
        fs.rmdirSync(blockedRecord);
        host.retainCompletedSourceRecordingFailure(source, { code: 'RECORD_FAILED', message: 'Original durable final receipt write failed' });
      }
      assert.equal(recorder.getVerifiedRecord(dispatchId), null);
      const retained = authority.readCompletedReviewSource({ worktree, reference: source });
      assert.equal(retained.state.resume.status, 'completed');
      assert.equal(retained.state.resume.launch_started, true);
      await Promise.all(concurrentClaims);
      assert.deepEqual(authority.readReviewSourceAttempts(retained).map(attempt => attempt.status), ['completed', 'completed']);
      const originalApplication = retained.state.resume.completion.application;
      const originalCosts = stable(authority.readReviewSourceAttempts(retained));
      const callbackCounts = [nativeCallbacks, transcriptCallbacks, finalCallbacks];
      const completeNative = fs.readFileSync(native);
      const cli = retained.state.resume.completion.application.runtime_evidence.transcript;
      if (mutation === 'recover-prefix') fs.writeFileSync(native, '{}\n');
      if (mutation === 'recover-truncated') {
        const truncated = completeNative.subarray(0, completeNative.length - 10);
        assert.ok(originalRaw.length > 0 && truncated.length > originalRaw.length);
        assert.deepEqual(truncated.subarray(0, originalRaw.length), originalRaw,
          'truncation preserves the complete genuine measured source prefix');
        fs.writeFileSync(native, truncated);
      }
      if (mutation === 'recover-missing-cli') fs.unlinkSync(cli.path);
      if (mutation === 'recover-foreign-cli') fs.writeFileSync(cli.path, '{}\n');
      if (mutation === 'recover-base') execFileSync('git', ['-C', worktree, 'update-ref', '-d', 'refs/heads/review-base']);
      if (mutation === 'recover-source') fs.writeFileSync(path.join(worktree, 'source.txt'), 'foreign recovery source\n');
      if (mutation === 'recover-agent') fs.appendFileSync(path.join(agents, selected.agent_file), '\n# foreign recovery instructions\n');
      if (mutation === 'recover-missing-custody') fs.unlinkSync(retained.state.resume.completion.cli_snapshot.path);
      recoveryStarted = true;
      if (cold) host = runtime.createCodexRuntimeHost(hostOptions);
      boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
      const negative = ['recover-prefix', 'recover-truncated', 'recover-missing-cli', 'recover-foreign-cli', 'recover-base', 'recover-source', 'recover-agent', 'recover-missing-custody'].includes(mutation);
      if (negative) {
        if (mutation === 'recover-truncated' && !cold) {
          await assert.rejects(launch, { code: 'RUNTIME_EVIDENCE_INVALID',
            message: /^codex-runtime-host: Codex native transcript contains invalid JSON: / });
          assert.deepEqual(fs.readFileSync(native), completeNative.subarray(0, completeNative.length - 10));
          const unchanged = authority.readCompletedReviewSource({ worktree, reference: source });
          assert.equal(stable(unchanged.state), stable(retained.state), 'parser refusal preserves original completed source state');
          assert.equal(stable(authority.readReviewSourceAttempts(unchanged)), originalCosts);
        } else await assert.rejects(launch, error => ['REVIEW_SOURCE_INVALID', 'REVIEW_RESTART_REQUIRED', 'INPUT_BUNDLE_CHANGED', 'STALE_CONTEXT', 'STALE_GENERATED_AGENT', 'ENOENT'].includes(error.code)
          || /changed|truncated|base|git.*failed/i.test(error.message));
        assert.equal(recorder.getVerifiedRecord(dispatchId), null);
        assert.equal(launches, 2);
        assert.deepEqual([nativeCallbacks, transcriptCallbacks, finalCallbacks], callbackCounts);
        return;
      }
      if (mutation === 'recover-record-repeat') {
        let failures = 0;
        fs.linkSync = (from, to) => {
          if (to === blockedRecord) { failures++; throw new Error('Repeated original durable recording failed'); }
          return originalLink(from, to);
        };
        for (let index = 0; index < 2; index++) {
          boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
          await assert.rejects(launch, { code: 'RECORD_FAILED' });
          const failed = authority.readCompletedReviewSource({ worktree, reference: source });
          assert.equal(failed.state.resume.reconciliations.length, index + 1);
          assert.equal(failed.state.resume.reconciliations.at(-1).status, 'failed');
          assert.equal(failed.state.resume.reconciliations.at(-1).owner_pid, process.pid);
          assert.equal(stable(failed.state.resume.completion.application), stable(originalApplication));
          assert.equal(stable(authority.readReviewSourceAttempts(failed)), originalCosts);
          assert.deepEqual(fs.readFileSync(native), completeNative);
          assert.equal(recorder.getVerifiedRecord(dispatchId), null);
          assert.equal(launches, 2);
        }
        assert.equal(failures, 2, 'both failures occur at the actual original recorder');
        fs.linkSync = originalLink;
        boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
      }
      if (receiptFault) {
        let faults = 0, recordLinks = 0;
        const descriptors = new Map();
        const fail = () => { faults++; throw new Error('Original receipt outcome fault: ' + receiptFault.fault); };
        const outcome = bytes => {
          try {
            const payload = JSON.parse(String(bytes)).payload;
            return payload?.schema === 'shipyard.completed-review-source-tip.v1'
              && payload.resume?.reconciliations?.at(-1)?.status === 'recorded';
          } catch { return false; }
        };
        fs.openSync = (file, ...args) => {
          const fd = originalOpen(file, ...args); descriptors.set(fd, file); return fd;
        };
        fs.linkSync = (from, to) => {
          const value = originalLink(from, to);
          if (to === blockedRecord) {
            recordLinks++;
            if (receiptFault.fault === 'record-link-response') fail();
            if (receiptFault.fault === 'record-directory-fsync') fs.fsyncSync = fd => {
              assert.ok(fs.fstatSync(fd).isDirectory()); fs.fsyncSync = originalFsync; fail();
            };
          }
          return value;
        };
        fs.writeFileSync = (file, bytes, ...args) => {
          if (typeof file === 'number' && outcome(bytes)) {
            if (receiptFault.fault === 'outcome-write') fail();
            if (receiptFault.fault === 'outcome-file-fsync') fs.fsyncSync = fd => {
              assert.ok(fs.fstatSync(fd).isFile()); fs.fsyncSync = originalFsync; fail();
            };
          }
          return originalWrite(file, bytes, ...args);
        };
        fs.renameSync = (from, to) => {
          const targeted = path.dirname(to) === authority.archiveAuthorityDirectory(worktree)
            && outcome(fs.readFileSync(from));
          const value = originalRename(from, to);
          if (targeted && receiptFault.fault === 'outcome-rename-response') fail();
          if (targeted && receiptFault.fault === 'outcome-directory-fsync') fs.fsyncSync = fd => {
            assert.ok(fs.fstatSync(fd).isDirectory()); fs.fsyncSync = originalFsync; fail();
          };
          return value;
        };
        await assert.rejects(launch, /Original receipt outcome fault/);
        fs.openSync = originalOpen; fs.linkSync = originalLink; fs.fsyncSync = originalFsync;
        fs.writeFileSync = originalWrite; fs.renameSync = originalRename;
        assert.equal(faults, 1); assert.equal(recordLinks, 1);
        const recordBytes = fs.readFileSync(blockedRecord);
        const durable = recorder.getVerifiedRecord(dispatchId);
        assert.ok(durable, 'the actual original final receipt exists before outcome recovery');
        assert.equal(stable(durable.receipt.runtime_evidence), stable(originalApplication.runtime_evidence));
        assert.deepEqual(fs.readFileSync(native), completeNative);
        assert.equal(launches, 2);
        if (receiptFault.exit) {
          fs.writeFileSync(1, JSON.stringify({ root, worktree, scope, home, agents, agentManifest, source, dispatchId, role,
            capabilities, producer_pid: process.pid }));
          process.exit(0);
        }
        const pending = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.ok(['pending', 'recorded'].includes(pending.state.resume.reconciliations.at(-1).status));
        const applied = { ...selected, sandbox_mode: 'read-only', agent_file_content: content, agent_file_digest: sha(content) };
        await assert.rejects(() => runtime.createCodexRuntimeHost(hostOptions).recoverCompletedSourceRecording(applied,
          { source, dispatch_id: dispatchId, role, input_prepared: input }), { code: 'REVIEW_SOURCE_CLAIMED' });
        assert.equal(stable(authority.readCompletedReviewSource({ worktree, reference: source }).state), stable(pending.state));
        let recoveredLinks = 0;
        fs.linkSync = (from, to) => { if (to === blockedRecord) recoveredLinks++; return originalLink(from, to); };
        const recovering = host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role, input_prepared: input });
        await assert.rejects(() => host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role }),
          { code: 'REVIEW_SOURCE_CLAIMED' });
        await assert.rejects(() => host.resumeCompletedSource(applied, { source, dispatch_id: dispatchId, role }),
          { code: 'REVIEW_SOURCE_CLAIMED' });
        const recovered = await recovering;
        await assert.rejects(() => host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role }),
          { code: 'REVIEW_SOURCE_CLAIMED' });
        host.completeCompletedSourceDelivery(source);
        fs.linkSync = originalLink;
        assert.equal(recoveredLinks, 0, 'receipt recovery cannot record twice');
        assert.deepEqual(fs.readFileSync(blockedRecord), recordBytes);
        assert.deepEqual(fs.readFileSync(native), completeNative);
        assert.equal(stable(recovered), stable(durable), 'recovery returns the verified original record');
        const finalized = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.equal(finalized.state.resume.reconciliations.at(-1).status, 'recorded');
        assert.equal(finalized.state.resume.delivered, true);
        assert.equal(stable(authority.readReviewSourceAttempts(finalized)), originalCosts);
        assert.deepEqual([nativeCallbacks, transcriptCallbacks, finalCallbacks], callbackCounts);
        assert.equal(launches, 2);
        await assert.rejects(() => host.recoverCompletedSourceRecording(applied, { source, dispatch_id: dispatchId, role }),
          { code: 'REVIEW_SOURCE_CLAIMED' });
        assert.deepEqual(fs.readFileSync(blockedRecord), recordBytes);
        return;
      }
      const recovered = await launch();
      assert.equal(authority.readCompletedReviewSource({ worktree, reference: source }).state.resume.reconciliations.at(-1).status, 'recorded');
      await Promise.all(concurrentClaims);
      assert.equal(stable(recovered.receipt.runtime_evidence), stable(originalApplication.runtime_evidence));
      assert.equal(recovered.receipt.launch_id, originalApplication.launch_id);
      assert.equal(recovered.receipt.agent_file_digest, originalApplication.agent_file_digest);
      assert.equal(stable(authority.readReviewSourceAttempts(authority.readCompletedReviewSource({ worktree, reference: source }))), originalCosts);
      assert.deepEqual([nativeCallbacks, transcriptCallbacks, finalCallbacks], callbackCounts, 'reconciliation never replays native callbacks');
      assert.deepEqual(fs.readFileSync(native), completeNative, 'reconciliation never creates another model turn');
      assert.equal(launches, 2);
      assert.equal(recovered.receipt.runtime_evidence.completed_source.fresh_turn_id, retained.state.resume.turn_id);
      const accounting = runtime.verifyCompletedReviewConsumption({ worktree, source, receipt_store: recorder.storeDir, dispatch_id: dispatchId });
      assert.equal(accounting.all_attempt_denominator, 2);
      assert.equal(accounting.successful_physical_calls, input.manifest.batches.length);
      assert.equal(accounting.attempts.at(-1).successful_calls, 0);
      boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true });
      await assert.rejects(launch, { code: 'RECOVERY_ALREADY_RECORDED' });
      assert.equal(launches, 2);
      return;
    }
    if (mutation) {
      if (mutation === 'subject-kind') {
        await assert.rejects(launch, { code: 'REVIEW_SOURCE_INVALID' });
        assert.equal(launches, 1, 'subject substitution refuses before a final native launch');
        assert.equal(finalCallbacks, 0);
        assert.ok(recorder.getVerifiedRecord(probeId));
      } else await assert.rejects(launch, error => ['REVIEW_SOURCE_INVALID', 'REVIEW_RESTART_REQUIRED', 'STALE_CONTEXT', 'STALE_GENERATED_AGENT', 'RUNTIME_EVIDENCE_MISMATCH', 'RUNTIME_EVIDENCE_INVALID', 'RUNTIME_UNAVAILABLE', 'INPUT_BUNDLE_INVALID', 'INPUT_BUNDLE_CHANGED'].includes(error.code) || /changed|manifest|profile|base|git.*failed|Original process hook failed/i.test(error.message));
      assert.equal(recorder.getVerifiedRecord(dispatchId), null);
      if (mutation === 'base') {
        assert.equal(launches, 1, 'moved base refuses before a final native launch');
        assert.equal(finalCallbacks, 0);
        assert.equal(authority.readCompletedReviewSource({ worktree, reference: source }).state.resume, null,
          'moved base refuses before claiming the final source');
      }
      if (mutation === 'base-after-claim') {
        assert.equal(launches, 1, 'base movement after claim refuses immediately before native launch');
        assert.equal(finalCallbacks, 0);
        const claimed = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.equal(claimed.state.resume.status, 'claimed', 'the genuine original claim is retained');
        assert.equal(claimed.state.resume.launch_started, undefined);
        assert.deepEqual(authority.readReviewSourceAttempts(claimed).map(attempt => attempt.status), ['completed']);
      }
      if (['spawn-throw', 'invalid-child', 'stdin-throw', 'process-hook-throw'].includes(mutation)) {
        const failed = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.equal(failed.state.resume.status, 'failed');
        assert.deepEqual(authority.readReviewSourceAttempts(failed).map(attempt => attempt.status), ['completed', 'failed']);
        assert.equal(failed.state.resume.physical_snapshot.bytes, failed.snapshot.bytes);
        const attempt = authority.readReviewSourceAttempts(failed).at(-1);
        assert.equal(attempt.physical.native_snapshot, undefined);
        assert.match(attempt.physical.reason, /unknown/);
        assert.equal(attempt.setup_costs.value, null);
        assert.ok(attempt.ended_at_ms >= attempt.started_at_ms);
        assert.deepEqual(fs.readFileSync(native), originalRaw);
      }
      if (['failed-prefix', 'failed-truncated'].includes(mutation)) {
        const failed = authority.readCompletedReviewSource({ worktree, reference: source });
        assert.equal(failed.state.resume.status, 'claimed');
        assert.deepEqual(authority.readReviewSourceAttempts(failed).map(attempt => attempt.status), ['completed', 'pending']);
      }
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
    for (const fields of [{ schema: 'foreign' }, { semantic_credit: true }, { new_physical_calls: 1 },
      { semantic_credit: undefined }, { new_physical_calls: undefined }]) {
      const invalid = structuredClone(final.receipt.runtime_evidence);
      Object.assign(invalid.completed_source, fields);
      assert.throws(() => authority.validateCompletedSourceEvidence(invalid), {
        code: 'REVIEW_SOURCE_INVALID', message: /exact schema and zero new credit contract/ });
    }

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
  } finally { fs.renameSync = originalRename; fs.fsyncSync = originalFsync; fs.writeFileSync = originalWrite;
    fs.openSync = originalOpen; fs.linkSync = originalLink;
    os.homedir = previousHome; fs.rmSync(root, { recursive: true, force: true }); }
}

async function coldMeasuredSourceFixture(role, fault, mutation = null) {
  const header = fs.readFileSync(__filename, 'utf8').split('async function recordedBatchApplication')[0];
  const script = header + '\ncompletedSourceBaselines.set(true, ' + JSON.stringify(copyCompletedSourceRepository()) + ');\n'
    + completedSourceFixture.toString()
    + '\ncompletedSourceFixture(' + JSON.stringify(role) + ', false, '
    + JSON.stringify(fault.startsWith('unmeasured-') ? fault : 'seal-' + fault + '-host-exit')
    + ', undefined, ' + String(fault === 'unmeasured-failed') + ').catch(error => { console.error(error); process.exitCode = 1; });';
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(__filename), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const previousHome = os.homedir; os.homedir = () => origin.root;
  try {
    assert.throws(() => process.kill(origin.producer_pid, 0), { code: 'ESRCH' });
    const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const adapterModule = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const recorder = boundary.createDurableRecorder(path.join(origin.root, 'receipts'));
    const unmeasured = fault.startsWith('unmeasured-');
    const originalRecord = origin.probeId ? stable(recorder.getVerifiedRecord(origin.probeId)) : null;
    const originalAttempts = (fs.existsSync(authority.archiveAuthorityDirectory(origin.worktree)) ? fs.readdirSync(authority.archiveAuthorityDirectory(origin.worktree)) : []).filter(name => name.startsWith('review-tip-'))
      .map(name => ({ file: path.join(authority.archiveAuthorityDirectory(origin.worktree), name) }))
      .map(pin => ({ ...pin, bytes: fs.readFileSync(pin.file) }));
    const reservation = stable(recorder.getReservation(origin.dispatchId));
    const originalRaw = fs.existsSync(origin.native) ? fs.readFileSync(origin.native) : null;
    const selected = policy.resolveDispatch({ runtime: 'codex', role, signals: {} });
    const content = fs.readFileSync(path.join(origin.agents, selected.agent_file), 'utf8');
    const instructions = runtime.generatedInstructions(content);
    const head = execFileSync('git', ['-C', origin.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const profile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: mutation === 'profile' ? 9 : 8,
      candidate: { source_sha256: sha(fs.readFileSync(require.resolve('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
        instructions_sha256: sha(instructions), model: selected.model, effort: selected.effort, provider: 'openai' } });
    let input = collector.prepareFileInput({ ...origin.scope, ...(mutation === 'subject' ? { ticket: 'T-49-19' } : {}) },
      'Complete current source, including multibyte € material.\n'.repeat(20) + (mutation === 'material' ? 'Changed obligation.' : ''), {
      role: mutation === 'role' ? (role === 'integrator' ? 'arch-review' : 'integrator') : role, dispatchId: origin.dispatchId, readerProfile: profile, storageRoot: path.join(origin.root, 'inputs'),
      generatedInstructionBytes: Buffer.byteLength(instructions) + 2,
      binding: { base: head, base_ref: 'refs/heads/review-base', merge_base: head, ticket_set: mutation === 'roster' ? ['T-49-19'] : ['T-49-18'],
        ticket_set_digest: sha(JSON.stringify(mutation === 'roster' ? ['T-49-19'] : ['T-49-18'])), agent_file: selected.agent_file,
        agent_path: path.join(origin.agents, selected.agent_file), agent_sha256: sha(content), policy_hash: policy.POLICY_HASH } });
    let source, spawns = 0, callbacks = 0;
    const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, agentDir: origin.agents,
      agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home },
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities },
      spawn(_program, args) {
        spawns++;
        const probing = !args.includes('resume');
        if (probing) assert.ok(unmeasured && spawns === 1, 'only an authentically unmeasured candidate launches a new probe');
        else assert.ok(args.includes(source.session_id));
        const child = new EventEmitter(); child.pid = 45678;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        let prompt = '';
        child.stdin = { write(bytes) { prompt += String(bytes); }, end() {
          const turn = probing ? 'original-cold-replacement-probe' : 'fresh-cold-measured-final';
          const result = JSON.stringify({ input_manifest_sha256: input.input_bundle.manifest_sha256,
            input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
            input_chunk_reads: input.manifest.ranges.length, input_batch_reads: input.manifest.batches.length,
            input_profile_sha256: input.manifest.transport.profile_sha256, judgment: probing ? 'obsolete cold probe' : 'fresh current judgment' });
          const context = nativeContext(turn, origin.worktree);
          Object.assign(context.payload, { model: selected.model, effort: selected.effort });
          Object.assign(context.payload.collaboration_mode.settings, { model: selected.model, reasoning_effort: selected.effort });
          process.nextTick(() => {
            if (probing) fs.writeFileSync(origin.native, serialize([nativeMetadata(session, origin.worktree), context,
              message('developer', turn, instructions), message('user', turn, input.prompt), event('task_started', turn),
              ...nativeReads(readRecords(input), turn), ...finish(turn, result)]), { mode: 0o600 });
            else fs.appendFileSync(source.native_file, serialize([context, message('user', turn, prompt.trim()), event('task_started', turn),
              message('assistant', turn, result), event('task_complete', turn, { last_agent_message: result })]));
            child.stdout.emit('data', Buffer.from(serialize([cliThread(probing ? session : source.session_id), ...cliCompletion(result)])));
            child.emit('close', 0, null);
          });
        } };
        return child;
      } });
    if (mutation) {
      const receipt = origin.probeId ? recorder.getVerifiedRecord(origin.probeId).receipt : null;
      if (mutation === 'native') fs.writeFileSync(origin.native, '{}\n');
      if (mutation === 'truncated') fs.writeFileSync(origin.native, originalRaw.subarray(0, originalRaw.length - 10));
      if (mutation === 'cli') fs.writeFileSync(receipt.runtime_evidence.transcript.path, '{}\n');
      if (mutation === 'receipt') fs.writeFileSync(path.join(recorder.storeDir, 'record-' + sha(origin.probeId) + '.json'), '{}\n');
      if (mutation === 'source') fs.writeFileSync(path.join(origin.worktree, 'source.txt'), 'Changed source.\n');
      if (mutation === 'plan') {
        const directory = path.join(origin.worktree, '.planning/phases/49-fixture'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, '49-18-PLAN.md'), 'Changed current plan.\n');
      }
      if (mutation === 'base') execFileSync('git', ['-C', origin.worktree, 'update-ref', '-d', 'refs/heads/review-base']);
      if (mutation === 'ancestry') {
        const tree = execFileSync('git', ['-C', origin.worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
        const unrelated = execFileSync('git', ['-C', origin.worktree, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
          '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'Unrelated original ancestry'], { encoding: 'utf8' }).trim();
        execFileSync('git', ['-C', origin.worktree, 'update-ref', 'refs/heads/review-base', unrelated]);
      }
      if (['forged-measurement', 'stale-measurement'].includes(mutation)) {
        const directory = authority.archiveAuthorityDirectory(origin.worktree);
        const file = fs.readdirSync(directory).map(name => path.join(directory, name)).find(file => {
          if (!path.basename(file).startsWith('review-tip-')) return false;
          return JSON.parse(fs.readFileSync(file)).payload.schema === 'shipyard.review-source-attempts.v1';
        });
        assert.ok(file, 'the original authenticated measurement ledger is actually present');
        const envelope = JSON.parse(fs.readFileSync(file));
        if (mutation === 'forged-measurement') envelope.mac = '0'.repeat(64);
        else envelope.payload.attempts.at(-1).capacity_contract.logical_ranges++;
        fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
      }
      if (mutation === 'missing-ledger') {
        const pin = originalAttempts.find(pin => JSON.parse(pin.bytes).payload.schema === 'shipyard.review-source-attempts.v1');
        assert.ok(pin); fs.unlinkSync(pin.file);
      }
      if (mutation === 'candidate-custody') {
        const file = originalAttempts.find(pin => JSON.parse(pin.bytes).payload.schema === 'shipyard.review-source-candidate.v1').file;
        const envelope = JSON.parse(fs.readFileSync(file)); envelope.payload.input.input_bytes++;
        fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
      }
      if (mutation === 'agent') fs.appendFileSync(path.join(origin.agents, selected.agent_file), '\nChanged instructions.\n');
      if (mutation === 'subject') {
        assert.equal(input.manifest.ticket, 'T-49-19');
        assert.equal(origin.scope.ticket, 'T-49-18');
        assert.equal(collector.isPreparedFileInput(input), true);
        assert.equal(boundary.isDurableRecorder(recorder), true);
        assert.equal(input.manifest.transport.schema, 'shipyard.native-reader-transport.v3');
        const identity = collector.reviewProgressIdentity(input);
        for (const key of ['worktree', 'run_id', 'phase']) assert.equal(identity[key], origin.scope[key]);
      }
      await assert.rejects(async () => {
        input = host.reserveCompletedSourceCandidate(input);
        await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input);
      }, mutation === 'subject' ? { code: 'REVIEW_SOURCE_REQUIRED',
        message: 'codex-runtime-host: source candidate requires original private preparation and recorder' }
        : error => ['REVIEW_SOURCE_INVALID', 'REVIEW_RESTART_REQUIRED', 'READER_CAPACITY_UNSUPPORTED', 'RUNTIME_EVIDENCE_INVALID',
        'RUNTIME_EVIDENCE_MISSING', 'RUNTIME_EVIDENCE_MISMATCH', 'REVIEW_PROGRESS_INVALID', 'STALE_CONTEXT', 'RECORD_FAILED', 'ENOENT'].includes(error.code)
        || /base|git.*failed/i.test(error.message));
      assert.equal(spawns, 0); assert.equal(callbacks, 0, 'refusal grants no fresh turn, read or semantic credit');
      assert.equal(recorder.getVerifiedRecord(origin.dispatchId), null);
      assert.equal(stable(recorder.getReservation(origin.dispatchId)), reservation);
      if (origin.probeId && mutation !== 'receipt') assert.equal(stable(recorder.getVerifiedRecord(origin.probeId)), originalRecord);
      if (originalRaw && !['native', 'truncated'].includes(mutation)) assert.deepEqual(fs.readFileSync(origin.native), originalRaw);
      return;
    }
    input = host.reserveCompletedSourceCandidate(input);
    const capacity = await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input, {
      onCompleted() { assert.ok(unmeasured, 'cold successful measurement cannot issue another probe completion'); } });
    if (!unmeasured) assert.equal(stable(capacity.contract), origin.contract);
    assert.equal(spawns, unmeasured ? 1 : 0);
    if (!unmeasured) assert.equal(stable(recorder.getVerifiedRecord(origin.probeId)), originalRecord);
    assert.equal(stable(recorder.getReservation(origin.dispatchId)), reservation);
    if (originalRaw) assert.deepEqual(fs.readFileSync(origin.native), originalRaw);
    const probeBytes = fs.readFileSync(origin.native);
    const failedOriginal = originalAttempts.flatMap(pin => JSON.parse(pin.bytes).payload.attempts || []);
    input = collector.admitReaderBatchInput(input, capacity);
    const reference = runtime.prepareCompletedSource(capacity, input);
    source = authority.readCompletedReviewSource({ worktree: origin.worktree, reference });
    assert.deepEqual(fs.readFileSync(input.input_bundle.manifest_path), Buffer.from(origin.manifestBytes, 'base64'));
    const adapter = adapterModule.createCodexDispatchAdapter({ agentsDir: origin.agents, agentManifest: origin.agentManifest,
      capabilities: origin.capabilities, host: { requireRuntimeEvidence: true, launchStatic(applied, context) {
        return host.resumeCompletedSource(applied, { source: reference, dispatch_id: context.dispatch_id, role,
          onCompleted() { callbacks++; } });
      } } });
    const result = await boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true })
      .dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: origin.dispatchId }, { ticket: origin.scope.ticket });
    host.completeCompletedSourceRecording(reference);
    assert.equal(spawns, unmeasured ? 2 : 1); assert.equal(callbacks, 1);
    assert.equal(result.receipt.runtime_evidence.completed_source.original_dispatch_id, capacity.contract.application_dispatch_id);
    if (!unmeasured) assert.equal(stable(recorder.getVerifiedRecord(origin.probeId)), originalRecord);
    assert.deepEqual(fs.readFileSync(source.native_file).subarray(0, probeBytes.length), probeBytes);
    const ledger = authority.readReviewSourceAttempts(authority.readCompletedReviewSource({ worktree: origin.worktree, reference }));
    for (const attempt of failedOriginal) assert.equal(stable(ledger.find(entry => entry.dispatch_id === attempt.dispatch_id)), stable(attempt));
    const accounting = runtime.verifyCompletedReviewConsumption({ worktree: origin.worktree, source: reference,
      receipt_store: recorder.storeDir, dispatch_id: origin.dispatchId });
    assert.deepEqual(accounting.attempts.map(attempt => attempt.status), fault === 'unmeasured-failed' ? ['failed', 'completed', 'completed'] : ['completed', 'completed']);
    assert.equal(accounting.all_attempt_denominator, fault === 'unmeasured-failed' ? 3 : 2);
    assert.equal(accounting.attempts.at(-1).successful_calls, 0);
  } finally { os.homedir = previousHome; fs.rmSync(origin.root, { recursive: true, force: true }); }
}

async function coldPrelaunchFixture(role, unknownStarted = false) {
  const header = fs.readFileSync(__filename, 'utf8').split('async function recordedBatchApplication')[0];
  const script = header + '\ncompletedSourceBaselines.set(true, ' + JSON.stringify(copyCompletedSourceRepository()) + ');\n'
    + completedSourceFixture.toString()
    + '\ncompletedSourceFixture(' + JSON.stringify(role) + ', false, '
    + JSON.stringify(unknownStarted ? 'started-host-exit' : 'prelaunch-host-exit')
    + ').catch(error => { console.error(error); process.exitCode = 1; });';
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(__filename), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const previousHome = os.homedir; os.homedir = () => origin.root;
  try {
    const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const adapterModule = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
    const recorder = boundaryModule.createDurableRecorder(path.join(origin.root, 'receipts'));
    if (unknownStarted) {
      const source = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
      assert.throws(() => process.kill(source.state.resume.owner_pid, 0), { code: 'ESRCH' });
      assert.equal(source.state.resume.launch_started, true);
      assert.equal(source.state.resume.prelaunch_failure, undefined);
      assert.deepEqual(authority.readReviewSourceAttempts(source).map(attempt => attempt.status), ['completed', 'pending']);
      const native = fs.readFileSync(source.native_file), state = stable(source.state);
      assert.deepEqual(native, fs.readFileSync(source.snapshot.path));
      const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, agentDir: origin.agents,
        agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home },
        spawn() { assert.fail('unknown started launch cannot be replayed'); },
        probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities } });
      const selected = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs').resolveDispatch({
        runtime: 'codex', role, signals: {}, dispatch_id: origin.dispatchId });
      await assert.rejects(() => host.resumeCompletedSource({ ...selected, sandbox_mode: 'read-only' }, {
        source: origin.source, dispatch_id: origin.dispatchId, role }), { code: 'REVIEW_SOURCE_CLAIMED' });
      assert.equal(stable(authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source }).state), state);
      assert.deepEqual(fs.readFileSync(source.native_file), native);
      assert.equal(recorder.getVerifiedRecord(origin.dispatchId), null);
      assert.ok(recorder.getVerifiedRecord(source.probe_dispatch_id));
      return;
    }
    const sealedFiles = fs.readdirSync(authority.archiveAuthorityDirectory(origin.worktree))
      .filter(file => file.startsWith('review-tip-')).map(file => JSON.parse(fs.readFileSync(path.join(authority.archiveAuthorityDirectory(origin.worktree), file))).payload);
    assert.ok(sealedFiles.some(payload => payload.schema === 'shipyard.completed-review-source-tip.v1'
      && payload.resume.status === 'claimed' && (payload.resume.launch_started || payload.resume.prelaunch_failure?.spawn_attempted === false)));
    assert.ok(sealedFiles.some(payload => payload.schema === 'shipyard.review-source-attempts.v1'
      && payload.attempts.at(-1).status === 'pending' && !payload.attempts.at(-1).source_resume));
    const source = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    assert.throws(() => process.kill(source.state.resume.owner_pid, 0), { code: 'ESRCH' });
    assert.equal(source.state.resume.launch_started, undefined);
    assert.equal(source.state.resume.prelaunch_failure.spawn_attempted, false);
    const originalNative = fs.readFileSync(source.native_file), originalProbe = stable(recorder.getVerifiedRecord(source.probe_dispatch_id));
    const reservation = recorder.getReservation(origin.dispatchId);
    let spawns = 0, completions = 0;
    const input = collector.restoreCompletedSourceInput(source);
    const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, agentDir: origin.agents,
      agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home },
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities },
      spawn(_program, args) {
        spawns++; assert.ok(args.includes('resume')); assert.ok(args.includes(source.session_id));
        const child = new EventEmitter(); child.pid = 45678;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        let prompt = '';
        child.stdin = { write(bytes) { prompt += String(bytes); }, end() {
          const turn = 'fresh-cold-prelaunch-final';
          const result = JSON.stringify({ input_manifest_sha256: input.input_bundle.manifest_sha256,
            input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
            input_chunk_reads: input.manifest.ranges.length, input_batch_reads: input.manifest.batches.length,
            input_profile_sha256: input.manifest.transport.profile_sha256, judgment: 'fresh current judgment' });
          const context = nativeContext(turn, origin.worktree);
          Object.assign(context.payload, { model: source.original_launch.model, effort: source.original_launch.effort });
          Object.assign(context.payload.collaboration_mode.settings, { model: source.original_launch.model,
            reasoning_effort: source.original_launch.effort });
          process.nextTick(() => {
            fs.appendFileSync(source.native_file, serialize([context, message('user', turn, prompt.trim()), event('task_started', turn),
              message('assistant', turn, result), event('task_complete', turn, { last_agent_message: result })]));
            child.stdout.emit('data', Buffer.from(serialize([cliThread(source.session_id), ...cliCompletion(result)])));
            child.emit('close', 0, null);
          });
        } };
        return child;
      } });
    const adapter = adapterModule.createCodexDispatchAdapter({ agentsDir: origin.agents, agentManifest: origin.agentManifest,
      capabilities: origin.capabilities, host: { requireRuntimeEvidence: true, launchStatic(applied, context) {
        return host.resumeCompletedSource(applied, { source: origin.source, dispatch_id: context.dispatch_id, role,
          onCompleted() { completions++; } });
      } } });
    const dispatch = () => boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true })
      .dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: origin.dispatchId }, { ticket: origin.scope.ticket });
    const result = await dispatch();
    assert.equal(spawns, 1); assert.equal(completions, 1); assert.equal(result.receipt.dispatch_id, origin.dispatchId);
    assert.equal(result.receipt.runtime_evidence.session_id, source.session_id);
    assert.equal(result.receipt.runtime_evidence.completed_source.semantic_credit, false);
    assert.deepEqual(fs.readFileSync(source.native_file).subarray(0, originalNative.length), originalNative);
    assert.equal(stable(recorder.getVerifiedRecord(source.probe_dispatch_id)), originalProbe);
    assert.equal(recorder.getReservation(origin.dispatchId).reserved_at, reservation.reserved_at);
    const retained = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    assert.equal(authority.readReviewSourceAttempts(retained).at(-1).prelaunch_failures.length, 1);
    assert.throws(dispatch, { code: 'RECOVERY_ALREADY_RECORDED' }); assert.equal(spawns, 1);
  } finally { os.homedir = previousHome; fs.rmSync(origin.root, { recursive: true, force: true }); }
}

async function coldCompletedRecordingFixture(role, reconciliationExit = false) {
  const header = fs.readFileSync(__filename, 'utf8').split('async function recordedBatchApplication')[0];
  const script = header + '\ncompletedSourceBaselines.set(true, ' + JSON.stringify(copyCompletedSourceRepository()) + ');\n'
    + completedSourceFixture.toString()
    + '\ncompletedSourceFixture(' + JSON.stringify(role) + ', false, ' + JSON.stringify(reconciliationExit ? 'recover-reconciliation-host-exit' : 'recover-host-exit')
    + ').catch(error => { console.error(error); process.exitCode = 1; });';
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(__filename), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const previousHome = os.homedir; os.homedir = () => origin.root;
  try {
    const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const adapterModule = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
    const recorder = boundaryModule.createDurableRecorder(path.join(origin.root, 'receipts'));
    const source = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    assert.notEqual(source.state.resume.owner_pid, process.pid);
    assert.throws(() => process.kill(source.state.resume.owner_pid, 0), { code: 'ESRCH' });
    assert.equal(source.state.resume.status, 'completed');
    if (reconciliationExit) {
      assert.equal(source.state.resume.reconciliations.length, 1);
      assert.equal(source.state.resume.reconciliations[0].status, 'pending');
      assert.equal(source.state.resume.reconciliations[0].owner_pid, source.state.resume.owner_pid);
    } else assert.equal(source.state.resume.completion_failures, undefined, 'host exited before any callback failure handler or durable recording');
    assert.equal(recorder.getVerifiedRecord(origin.dispatchId), null);
    const native = fs.readFileSync(source.native_file), costs = stable(authority.readReviewSourceAttempts(source));
    const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, agentDir: origin.agents,
      agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home },
      spawn() { assert.fail('cold reconciliation must not launch another model turn'); },
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities } });
    const adapter = adapterModule.createCodexDispatchAdapter({ agentsDir: origin.agents, agentManifest: origin.agentManifest,
      capabilities: origin.capabilities, host: { requireRuntimeEvidence: true, launchStatic(applied, context) {
        return host.resumeCompletedSource(applied, { source: origin.source, dispatch_id: context.dispatch_id, role,
          onNativeCompleted() { assert.fail('cold reconciliation cannot replay the native callback'); },
          onTranscriptWritten() { assert.fail('cold reconciliation cannot replay the transcript callback'); },
          onCompleted() { assert.fail('cold reconciliation cannot replay completion'); } });
      } } });
    const dispatch = () => boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true })
      .dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: origin.dispatchId }, { ticket: origin.scope.ticket });
    const originalKill = process.kill;
    process.kill = () => { const error = new Error('Original claimant custody is unknown'); error.code = 'EPERM'; throw error; };
    try {
      await assert.rejects(dispatch, { code: 'REVIEW_SOURCE_CLAIMED' });
      assert.equal(stable(authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source }).state), stable(source.state));
      assert.equal(recorder.getVerifiedRecord(origin.dispatchId), null);
    } finally { process.kill = originalKill; }
    const result = await dispatch();
    host.completeCompletedSourceRecording(origin.source);
    assert.equal(result.receipt.launch_id, source.state.resume.completion.application.launch_id);
    assert.equal(stable(result.receipt.runtime_evidence), stable(source.state.resume.completion.application.runtime_evidence));
    assert.deepEqual(fs.readFileSync(source.native_file), native);
    const restored = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    assert.equal(stable(authority.readReviewSourceAttempts(restored)), costs);
    assert.equal(restored.state.resume.launch_started, true);
    assert.equal(restored.state.resume.reconciliations.length, reconciliationExit ? 2 : 1);
    assert.equal(restored.state.resume.reconciliations.at(-1).status, 'recorded');
    const accounting = runtime.verifyCompletedReviewConsumption({ worktree: origin.worktree, source: origin.source,
      receipt_store: recorder.storeDir, dispatch_id: origin.dispatchId });
    assert.equal(accounting.all_attempt_denominator, 2);
    assert.equal(accounting.attempts.at(-1).successful_calls, 0);
    const originalRecord = stable(recorder.getVerifiedRecord(origin.dispatchId));
    assert.throws(dispatch, { code: 'RECOVERY_ALREADY_RECORDED', details: { dispatch_id: origin.dispatchId } });
    assert.equal(stable(recorder.getVerifiedRecord(origin.dispatchId)), originalRecord, 'replay preserves the original durable record');
    assert.deepEqual(fs.readFileSync(source.native_file), native, 'replay cannot append another native turn');
    assert.equal(stable(authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source }).state),
      stable(restored.state), 'replay preserves original completed source state');
  } finally { os.homedir = previousHome; fs.rmSync(origin.root, { recursive: true, force: true }); }
}

async function completedSourceReceiptRecoveryFixture(role, cold, fault, mutation = null) {
  if (!cold) return completedSourceFixture(role, false, fault.startsWith('initial-') ? null : 'recover-record-gap', null, false, false, false, false, { fault, initial: fault.startsWith('initial-') });
  const header = fs.readFileSync(__filename, 'utf8').split('async function recordedBatchApplication')[0];
  const script = header + '\ncompletedSourceBaselines.set(true, ' + JSON.stringify(copyCompletedSourceRepository()) + ');\n'
    + completedSourceFixture.toString()
    + '\ncompletedSourceFixture(' + JSON.stringify(role) + ', false, ' + JSON.stringify(fault.startsWith('initial-') ? null : 'recover-record-gap')
    + ', null, false, false, false, false, ' + JSON.stringify({ fault, exit: true, initial: fault.startsWith('initial-') }) + ').catch(error => { console.error(error); process.exitCode = 1; });';
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(__filename), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const previousHome = os.homedir, originalKill = process.kill, originalLink = fs.linkSync;
  os.homedir = () => origin.root;
  try {
    assert.notEqual(origin.producer_pid, process.pid);
    assert.throws(() => process.kill(origin.producer_pid, 0), { code: 'ESRCH' });
    const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const recorder = boundary.createDurableRecorder(path.join(origin.root, 'receipts'));
    const source = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    const native = fs.readFileSync(source.native_file), attempts = stable(authority.readReviewSourceAttempts(source));
    const file = path.join(recorder.storeDir, 'record-' + sha(origin.dispatchId) + '.json');
    const bytes = fs.readFileSync(file), originalRecord = recorder.getVerifiedRecord(origin.dispatchId);
    const cli = fs.readFileSync(source.state.resume.completion.application.runtime_evidence.transcript.path);
    const selected = { model: source.original_launch.model, effort: source.original_launch.effort, sandbox_mode: 'read-only',
      agent_file: source.original_launch.agent_file, agent_file_digest: source.original_launch.agent_file_digest,
      agent_file_content: fs.readFileSync(path.join(origin.agents, source.original_launch.agent_file), 'utf8') };
    const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, agentDir: origin.agents,
      agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home }, spawn() { assert.fail('recorded recovery cannot launch'); },
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities } });
    const context = { source: origin.source, dispatch_id: origin.dispatchId, role,
      onCompleted() { assert.fail('recorded recovery cannot repeat native completion'); } };
    const recover = () => host.recoverCompletedSourceRecording(selected, context);
    if (mutation === 'tampered-receipt') {
      const value = JSON.parse(bytes); value.payload.receipt.applied_model = 'foreign-model'; fs.writeFileSync(file, JSON.stringify(value));
    }
    if (mutation === 'foreign-receipt') fs.copyFileSync(path.join(recorder.storeDir, 'record-' + sha(source.probe_dispatch_id) + '.json'), file);
    if (mutation === 'source') fs.writeFileSync(path.join(origin.worktree, 'source.txt'), 'moved current source\n');
    if (mutation === 'base') execFileSync('git', ['-C', origin.worktree, 'update-ref', '-d', 'refs/heads/review-base']);
    if (mutation === 'agent') fs.appendFileSync(path.join(origin.agents, selected.agent_file), '\nchanged instructions\n');
    if (mutation === 'native') fs.writeFileSync(source.native_file, '{}\n');
    if (['unknown-pid', 'live-pid'].includes(mutation)) process.kill = () => {
      if (mutation === 'live-pid') return true;
      const error = new Error('Original owner custody is unknown'); error.code = 'EPERM'; throw error;
    };
    if (mutation) {
      await assert.rejects(recover);
      assert.equal(stable(authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source }).state), stable(source.state));
      assert.equal(stable(authority.readReviewSourceAttempts(source)), attempts);
      return;
    }
    let recordLinks = 0;
    fs.linkSync = (from, to) => { if (to === file) recordLinks++; return originalLink(from, to); };
    const result = await recover();
    host.completeCompletedSourceDelivery(origin.source);
    assert.equal(recordLinks, 0);
    assert.equal(stable(result), stable(originalRecord));
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readFileSync(source.native_file), native);
    assert.deepEqual(fs.readFileSync(source.state.resume.completion.application.runtime_evidence.transcript.path), cli);
    const restored = authority.readCompletedReviewSource({ worktree: origin.worktree, reference: origin.source });
    assert.equal(restored.state.resume.reconciliations.at(-1).status, 'recorded');
    assert.equal(restored.state.resume.delivered, true);
    assert.equal(restored.state.resume.reconciliations.at(-1).owner_pid, process.pid);
    if (source.state.resume.reconciliations?.length)
      assert.equal(restored.state.resume.reconciliations.at(-1).recoveries[0].owner_pid, origin.producer_pid);
    else {
      assert.equal(source.state.resume.completion_failures, undefined);
      assert.equal(origin.record_links, 1);
    }
    assert.equal(stable(authority.readReviewSourceAttempts(restored)), attempts);
    await assert.rejects(recover, { code: 'REVIEW_SOURCE_CLAIMED' });
    assert.deepEqual(fs.readFileSync(file), bytes);
    const accounting = runtime.verifyCompletedReviewConsumption({ worktree: origin.worktree, source: origin.source,
      receipt_store: recorder.storeDir, dispatch_id: origin.dispatchId });
    assert.equal(accounting.all_attempt_denominator, 2);
    assert.equal(accounting.attempts.at(-1).successful_calls, 0);
  } finally {
    process.kill = originalKill; fs.linkSync = originalLink; os.homedir = previousHome;
    fs.rmSync(origin.root, { recursive: true, force: true });
  }
}

async function automaticCompletedReviewFixture(role, cold, ordinary = false, moveBase = false, recordingFailure = null, beforeRecovery = null) {
  const helper = require('./helpers/codex-arch-review-fixtures.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const f = helper.fixture();
  const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-completed-review-')));
  const previousHome = os.homedir; os.homedir = () => store;
  const originalLink = fs.linkSync, originalWrite = fs.writeFileSync, originalFsync = fs.fsyncSync, originalRename = fs.renameSync;
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
        const retainedPath = 'plugins/delivery-pipeline/scripts/' + name + '.cjs';
        const retainedRevision = 'b3eab6c12ecebed1b14947fe5e037f93b549c524:' + retainedPath;
        const previous = helper.git(fixtureRoot, ['show', retainedRevision]) + '\n';
        const previousBytes = Buffer.from(previous);
        assert.equal(crypto.createHash('sha1').update(Buffer.from('blob ' + previousBytes.length + '\0'))
          .update(previousBytes).digest('hex'), helper.git(fixtureRoot, ['rev-parse', retainedRevision]),
        'complete retained baseline module bytes: ' + retainedPath);
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
      const completeDiff = helper.git(f.root, ['diff', '--no-ext-diff', '--unified=50', 'HEAD~1...HEAD']) + '\n';
      assert.ok(Buffer.byteLength(completeDiff) > 850 * 1024, 'complete fixture Git diff remains large');
      assert.ok(Buffer.byteLength(completeDiff) < 1024 * 1024, 'complete fixture Git diff retains the integration bound');
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
        const material = index === 1 ? manifest.assets.map(asset => fs.readFileSync(asset.path)) : [];
        const reads = index === 1 ? manifest.batches.map(batch => {
          physicalReads++;
          const bundle = { manifest_path: manifestPath, transport: manifest.transport };
          const args = ['--read-batch', manifestPath, String(batch.index), manifest.transport.profile_sha256];
          const output = collector.readBatchCli(args);
          assert.ok(Buffer.byteLength(output) <= 252 * 1024);
          assert.equal(output, collector.batchOutput(manifest, manifestBytes, material, batch.index));
          if (batch.index === 0 || batch.index === manifest.batches.length - 1)
            assert.equal(output, execFileSync(process.execPath, [manifest.transport.module_path, ...args],
              { encoding: 'utf8', maxBuffer: 252 * 1024 }));
          return { command: collector.batchCommand(bundle, batch.index), output };
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
    const controller = { assertOwner(runId) { assert.equal(runId, scope.run_id); },
      markUnavailable() { assert.fail('authenticated completed native recording failure cannot schedule another model dispatch'); } };
    const hostOptions = { scope, agentDir: agents, agentManifest, recorder, controller, env: { CODEX_HOME: home }, spawn,
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities } };
    const nativeHost = runtime.createCodexRuntimeHost(hostOptions);
    let probeCallbacks = 0, finalCallbacks = 0;
    let coldHost;
    const host = { ...nativeHost,
      completeCompletedSourceRecording(reference) {
        return (coldHost || nativeHost).completeCompletedSourceRecording(reference);
      },
      completeCompletedSourceDelivery(reference) {
        return (coldHost || nativeHost).completeCompletedSourceDelivery(reference);
      },
      retainCompletedSourceRecordingFailure(reference, error) {
        return (coldHost || nativeHost).retainCompletedSourceRecordingFailure(reference, error);
      },
      recoverCompletedSourceRecording(applied, context) {
        return (coldHost || nativeHost).recoverCompletedSourceRecording(applied, context);
      },
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
          if (recordingFailure === 'callback') throw new Error('Original automatic completed callback failed');
          return originalCompleted?.(completion);
        } };
        if (!cold) return nativeHost.resumeCompletedSource(applied, observed);
        const { input_prepared: _privateInput, ...selectors } = observed;
        coldHost = runtime.createCodexRuntimeHost(hostOptions);
        return coldHost.resumeCompletedSource(applied, selectors);
      },
    };
    const options = { ...canonicalOptions, scope, storageRoot: store, host, agentDir: agents, agentManifest,
      env: { CODEX_HOME: home } };
    let request = { role, context: ordinary ? { prompt: ordinaryMaterial } : { review_contract: 'shipyard.integration-review.v2' }, signals: {}, dispatch_id: 'automatic-final-' + crypto.randomUUID() };
    if (role === 'arch-review') {
      const selected = selectedFiles[0];
      const readerProfile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 3,
        candidate: { source_sha256: sha(fs.readFileSync(path.join(fixtureRoot, 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
          instructions_sha256: sha(runtime.generatedInstructions(contents.get(selected.agent_file))),
          model: selected.model, effort: selected.effort, provider: 'openai' } });
      const preparation = collector.prepare(scope, { role, context: {}, signals: {} }, {
        ...canonicalOptions, readerProfile, inflightDispatchId: request.dispatch_id, storageRoot: path.join(store, 'inputs') });
      assert.equal(preparation.prepared.packet.review_contract, undefined, 'this retained probe recovery fixture selects legacy architecture');
      options.archReviewContext = preparation;
      request = { ...preparation.launch, signals: { ...preparation.launch.signals }, context: { ...preparation.launch.context }, dispatch_id: request.dispatch_id };
    }
    const run = () => delivery.createCodexDeliveryHost(options).run(request);
    let failedWrites = 0;
    if (['record', 'record-repeat'].includes(recordingFailure)) fs.linkSync = (from, to) => {
      if (failedWrites < (recordingFailure === 'record-repeat' ? 2 : 1) && to === path.join(recorder.storeDir, 'record-' + sha(request.dispatch_id) + '.json')) {
        failedWrites++;
        const error = new Error('Original automatic durable receipt write failed'); error.code = 'EIO'; throw error;
      }
      return originalLink(from, to);
    };
    let outcomeFaults = 0;
    const outcomeFault = recordingFailure?.startsWith('outcome-');
    if (recordingFailure === 'record-link-response' || outcomeFault) {
      fs.linkSync = (from, to) => {
        const target = to === path.join(recorder.storeDir, 'record-' + sha(request.dispatch_id) + '.json');
        if (outcomeFault && target && !failedWrites) {
          failedWrites++; throw new Error('Original automatic recording before outcome fault failed');
        }
        const value = originalLink(from, to);
        if (recordingFailure === 'record-link-response' && target && !failedWrites) {
          failedWrites++; throw new Error('Original automatic record acknowledgement lost');
        }
        return value;
      };
      fs.writeFileSync = (file, bytes, ...args) => {
        let payload;
        try { payload = JSON.parse(String(bytes)).payload; } catch {}
        if (outcomeFault && !outcomeFaults && typeof file === 'number'
            && payload?.schema === 'shipyard.completed-review-source-tip.v1'
            && payload.resume?.reconciliations?.at(-1)?.status === 'recorded') {
          outcomeFaults++;
          if (recordingFailure.startsWith('outcome-write')) throw new Error('Original automatic outcome persistence failed');
          fs.fsyncSync = fd => {
            assert.ok(fs.fstatSync(fd).isFile()); fs.fsyncSync = originalFsync;
            throw new Error('Original automatic outcome file fsync failed');
          };
        }
        return originalWrite(file, bytes, ...args);
      };
    }
    if (outcomeFault) {
      await assert.rejects(run, /Original automatic outcome/);
      assert.equal(outcomeFaults, 1); assert.equal(failedWrites, 1);
      const retained = authority.readCompletedReviewSource({ worktree: f.root, dispatch_id: request.dispatch_id });
      assert.equal(retained.state.resume.reconciliations.at(-1).status, 'pending');
      assert.ok(recorder.getVerifiedRecord(request.dispatch_id));
      assert.equal(launches, 2); assert.equal(probeCallbacks, 1); assert.equal(finalCallbacks, 1);
      if (recordingFailure.endsWith('-host-exit')) {
        fs.writeFileSync(1, JSON.stringify({ root: f.root, pr: f.pr, scope, store, agents, agentManifest, home, capabilities,
          graphDir, request, role, source: retained.state.reference, producer_pid: process.pid }));
        process.exit(0);
      }
      fs.writeFileSync = originalWrite; fs.fsyncSync = originalFsync;
    }
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
    if (recordingFailure?.startsWith('seal-')) {
      fs.linkSync = (from, to) => {
        if (!failedWrites && path.basename(to).startsWith(recordingFailure === 'seal-envelope' ? 'review-progress-' : 'review-tip-')
            && JSON.parse(fs.readFileSync(from)).payload.schema === (recordingFailure === 'seal-envelope'
              ? 'shipyard.completed-review-source.v1' : 'shipyard.completed-review-source-tip.v1')) {
          failedWrites++; throw new Error('Original automatic post-measure source seal failed');
        }
        return originalLink(from, to);
      };
      await assert.rejects(run, /Original automatic post-measure source seal failed/);
      assert.equal(launches, 1); assert.equal(probeCallbacks, 1); assert.equal(finalCallbacks, 0);
      assert.ok(recorder.getVerifiedRecord(originalProbeCompletion.runtime_evidence.dispatch_id));
      assert.equal(recorder.getVerifiedRecord(request.dispatch_id), null);
    }
    if (recordingFailure === 'record-repeat') {
      await assert.rejects(run, { code: 'RECORD_FAILED' });
      const retained = authority.readCompletedReviewSource({ worktree: f.root, dispatch_id: request.dispatch_id });
      assert.equal(retained.state.resume.reconciliations.length, 1);
      assert.equal(retained.state.resume.reconciliations[0].status, 'failed');
      assert.equal(launches, 2); assert.equal(probeCallbacks, 1); assert.equal(finalCallbacks, 1);
      assert.equal(recorder.getVerifiedRecord(request.dispatch_id), null);
    }
    if (beforeRecovery) await beforeRecovery({ root: f.root, agents, recorder, request,
      statistics: () => ({ launches, probeCallbacks, finalCallbacks }) });
    const final = await run();
    fs.linkSync = originalLink; fs.writeFileSync = originalWrite; fs.fsyncSync = originalFsync;
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
    if (['callback', 'record', 'record-repeat'].includes(recordingFailure)) {
      const source = authority.readCompletedReviewSource({ worktree: f.root, reference: final.receipt.runtime_evidence.completed_source.source });
      assert.equal(source.state.resume.status, 'completed');
      assert.equal(source.state.resume.launch_started, true);
      assert.equal(source.state.resume.reconciliations.length, recordingFailure === 'record-repeat' ? 2 : 1);
      assert.equal(source.state.resume.reconciliations.at(-1).status, 'recorded');
      assert.ok(source.state.resume.completion_failures.some(failure => failure.original_exit.error.includes(
        recordingFailure === 'callback' ? 'Original automatic completed callback failed' : 'Original automatic durable receipt write failed')));
      assert.equal(failedWrites, recordingFailure === 'record-repeat' ? 2 : recordingFailure === 'record' ? 1 : 0);
      assert.equal(stable(source.state.resume.completion.application.runtime_evidence), stable(final.receipt.runtime_evidence));
    }
    if (recordingFailure === 'record-link-response' || outcomeFault) {
      const source = authority.readCompletedReviewSource({ worktree: f.root,
        reference: final.receipt.runtime_evidence.completed_source.source });
      assert.equal(source.state.resume.delivered, true);
      assert.equal(source.state.resume.reconciliations.at(-1).status, 'recorded');
      assert.equal(failedWrites, 1);
      assert.equal(stable(source.state.resume.completion.application.runtime_evidence), stable(final.receipt.runtime_evidence));
    }
  } finally { fs.linkSync = originalLink; fs.writeFileSync = originalWrite; fs.fsyncSync = originalFsync; fs.renameSync = originalRename; os.homedir = previousHome; fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); }
}

async function coldRecordedSourceControllerFixture(role) {
  const header = fs.readFileSync(__filename, 'utf8').split('async function recordedBatchApplication')[0];
  const script = header + '\n' + automaticCompletedReviewFixture.toString()
    + '\nautomaticCompletedReviewFixture(' + JSON.stringify(role)
    + ", false, false, false, 'outcome-write-host-exit').catch(error => { console.error(error); process.exitCode = 1; });";
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(__filename), encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const previousHome = os.homedir; os.homedir = () => origin.store;
  try {
    assert.throws(() => process.kill(origin.producer_pid, 0), { code: 'ESRCH' });
    const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
    const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const recorder = boundary.createDurableRecorder(path.join(origin.store, 'receipts'));
    const source = authority.readCompletedReviewSource({ worktree: origin.root, reference: origin.source });
    assert.equal(source.state.resume.owner_pid, origin.producer_pid);
    const record = recorder.getVerifiedRecord(origin.request.dispatch_id);
    assert.ok(record);
    const recordFile = path.join(recorder.storeDir, 'record-' + sha(origin.request.dispatch_id) + '.json');
    const recordBytes = fs.readFileSync(recordFile), native = fs.readFileSync(source.native_file);
    const attempts = stable(authority.readReviewSourceAttempts(source));
    const canonical = { graphDir: origin.graphDir, refreshGit: false, getPullRequest: () => origin.pr,
      listPullRequests: () => [origin.pr], execFileSync(program, args, options) {
        if (program === 'git' && args.includes('fetch')) return '';
        if (program === 'gh') return JSON.stringify(origin.pr);
        return execFileSync(program, args, options);
      } };
    const controller = { assertOwner(id) { assert.equal(id, origin.scope.run_id); },
      markUnavailable() { assert.fail('recorded cold recovery cannot create another dispatch'); } };
    const host = runtime.createCodexRuntimeHost({ scope: origin.scope, recorder, controller,
      agentDir: origin.agents, agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home },
      spawn() { assert.fail('recorded cold controller cannot launch a model'); },
      probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities: origin.capabilities } });
    const options = { ...canonical, scope: origin.scope, storageRoot: origin.store, host,
      agentDir: origin.agents, agentManifest: origin.agentManifest, env: { CODEX_HOME: origin.home } };
    let request = origin.request;
    if (role === 'arch-review') {
      const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
      const selected = policy.resolveDispatch({ runtime: 'codex', role, signals: {} });
      const readerProfile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 3,
        candidate: { source_sha256: sha(fs.readFileSync(path.join(fixtureRoot, 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs'))),
          instructions_sha256: sha(runtime.generatedInstructions(fs.readFileSync(path.join(origin.agents, selected.agent_file), 'utf8'))),
          model: selected.model, effort: selected.effort, provider: 'openai' } });
      const prepared = collector.prepare(origin.scope, { role, context: {}, signals: {} }, {
        ...canonical, readerProfile, inflightDispatchId: request.dispatch_id, storageRoot: path.join(origin.store, 'inputs') });
      assert.equal(prepared.prepared.packet.review_contract, undefined, 'cold recovery preserves the original legacy architecture contract');
      options.archReviewContext = prepared;
      request = { ...prepared.launch, signals: { ...prepared.launch.signals }, context: { ...prepared.launch.context },
        dispatch_id: request.dispatch_id };
    } else options.integrationContext = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
      .prepareIntegratorContext(canonical, { worktree: origin.root, phase: '38' });
    const recovered = await delivery.createCodexDeliveryHost(options).run(request);
    assert.equal(stable(recovered.receipt), stable(record.receipt));
    assert.ok(recovered.artifact);
    assert.deepEqual(fs.readFileSync(recordFile), recordBytes);
    assert.deepEqual(fs.readFileSync(source.native_file), native);
    const restored = authority.readCompletedReviewSource({ worktree: origin.root, reference: origin.source });
    assert.equal(restored.state.resume.delivered, true);
    assert.equal(restored.state.resume.reconciliations.at(-1).status, 'recorded');
    assert.equal(restored.state.resume.reconciliations.at(-1).recoveries[0].owner_pid, origin.producer_pid);
    assert.equal(stable(authority.readReviewSourceAttempts(restored)), attempts);
    await assert.rejects(() => delivery.createCodexDeliveryHost(options).run(request), { code: 'REVIEW_SOURCE_CLAIMED' });
    assert.deepEqual(fs.readFileSync(recordFile), recordBytes);
    assert.deepEqual(fs.readFileSync(source.native_file), native);
  } finally {
    os.homedir = previousHome; fs.rmSync(origin.root, { recursive: true, force: true });
    fs.rmSync(origin.store, { recursive: true, force: true });
  }
}

async function partialFailedSourceFixture(role, fault) {
  await completedSourceFixture(role, false, null, async original => {
    const { recorder, root } = original;
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const boundary = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
    const adapterModule = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
    const firstSource = authority.readCompletedReviewSource({ worktree: original.input.manifest.snapshot.worktree, reference: original.source });
    const scope = { worktree: firstSource.identity.worktree, run_id: firstSource.identity.run_id,
      ticket: firstSource.identity.ticket, phase: firstSource.identity.phase, repository: 'fixture/repository', runtime: 'codex', provider: 'openai' };
    const home = path.join(root, 'codex'), agents = path.join(home, 'agents'), agentManifest = path.join(agents, '.shipyard-manifest.json');
    const selected = policy.resolveDispatch({ runtime: 'codex', role, signals: {} });
    const capabilities = { supportedModels: [selected.model], supportedEfforts: [selected.effort] };
    const content = fs.readFileSync(path.join(agents, selected.agent_file), 'utf8'), instructions = runtime.generatedInstructions(content);
    const originalPins = [original.native, original.final.receipt.runtime_evidence.transcript.path,
      recorder.getVerifiedRecord(original.capacity.contract.application_dispatch_id).receipt.runtime_evidence.transcript.path]
      .map(file => ({ file, bytes: fs.readFileSync(file) }));
    let failedEntry, failedPin, failedSource;
    for (const failed of [true, false]) {
      const dispatchId = 'partial-cost-final-' + crypto.randomUUID(), reviewer = crypto.randomUUID();
      const native = path.join(path.dirname(original.native), reviewer + '.jsonl');
      const profile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 8,
        candidate: { ...original.input.manifest.transport.candidate } });
      let input = collector.prepareFileInput(scope, 'Complete current source, including multibyte € material.\n'.repeat(20), {
        role, dispatchId, readerProfile: profile, storageRoot: path.join(root, 'inputs'),
        generatedInstructionBytes: Buffer.byteLength(instructions) + 2, binding: original.input.manifest.binding });
      let spawns = 0;
      const host = runtime.createCodexRuntimeHost({ scope, recorder, agentDir: agents, agentManifest, env: { CODEX_HOME: home },
        probe: { status: 'available', executable: 'codex', runtime_version: 'isolated-native-fixture', capabilities },
        spawn(_program, args) {
          spawns++;
          const probing = !args.includes('resume'), turn = crypto.randomUUID();
          const child = new EventEmitter(); child.pid = 45789;
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          let prompt = '';
          child.stdin = { write(bytes) { prompt += String(bytes); }, end() {
            const context = nativeContext(turn, scope.worktree);
            Object.assign(context.payload, { model: selected.model, effort: selected.effort });
            Object.assign(context.payload.collaboration_mode.settings, { model: selected.model, reasoning_effort: selected.effort });
            const result = JSON.stringify({ input_manifest_sha256: input.input_bundle.manifest_sha256,
              input_material_bytes: input.input_bundle.total_bytes, input_asset_count: input.input_bundle.asset_count,
              input_chunk_reads: input.manifest.ranges.length, input_batch_reads: input.manifest.batches.length,
              input_profile_sha256: input.manifest.transport.profile_sha256, judgment: probing ? 'obsolete probe' : 'fresh judgment' });
            if (!probing && failed && fault === 'missing-cli') {
              fs.appendFileSync(native, serialize([context, message('user', turn, prompt.trim()), event('task_started', turn)]));
              throw new Error('Original process exited before CLI output');
            }
            process.nextTick(() => {
              if (probing) fs.writeFileSync(native, serialize([nativeMetadata(reviewer, scope.worktree), context,
                message('developer', turn, instructions), message('user', turn, input.prompt), event('task_started', turn),
                ...nativeReads(readRecords(input), turn), ...finish(turn, result)]), { mode: 0o600 });
              else fs.appendFileSync(native, serialize([context, message('user', turn, prompt.trim()), event('task_started', turn),
                ...(failed ? [] : finish(turn, result))]) + (failed && fault !== 'missing-cli'
                  ? JSON.stringify({ type: template(childRecords, record => record.type === 'response_item').type,
                    payload: null }).slice(0, -5) : ''));
              if (!probing && failed && fault === 'missing-cli') child.emit('error', new Error('Original process exited before CLI output'));
              else {
                child.stdout.emit('data', Buffer.from(serialize([cliThread(reviewer), ...(failed && !probing
                  ? [{ type: 'turn.failed', error: { message: 'Original partial native output' } }] : cliCompletion(result))])));
                child.emit('close', failed && !probing ? 1 : 0, null);
              }
            });
          } };
          return child;
        } });
      input = host.reserveCompletedSourceCandidate(input);
      const capacity = await host.measureBatchReaderCapacity({ ...selected, sandbox_mode: 'read-only' }, input);
      input = collector.admitReaderBatchInput(input, capacity);
      const reference = runtime.prepareCompletedSource(capacity, input);
      const adapter = adapterModule.createCodexDispatchAdapter({ agentsDir: agents, agentManifest, capabilities,
        host: { requireRuntimeEvidence: true, launchStatic(applied, context) {
          return host.resumeCompletedSource(applied, { source: reference, dispatch_id: context.dispatch_id, role, input_prepared: input });
        } } });
      const launch = () => boundary.createDispatchBoundary({ adapters: { codex: adapter }, recorder, recoverReserved: true })
        .dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: dispatchId });
      if (failed) {
        await assert.rejects(launch);
        failedSource = authority.readCompletedReviewSource({ worktree: scope.worktree, reference });
        failedEntry = authority.readReviewSourceAttempts(failedSource).at(-1);
        assert.equal(failedEntry.status, 'failed');
        assert.ok(failedEntry.physical.native_snapshot.bytes > 0);
        if (fault === 'missing-cli') assert.equal(failedEntry.physical.transcript, null);
        failedPin = { file: failedEntry.physical.native_snapshot.path, bytes: fs.readFileSync(failedEntry.physical.native_snapshot.path) };
      } else {
        const result = await launch(); host.completeCompletedSourceRecording(reference);
        const accounting = runtime.verifyCompletedReviewConsumption({ worktree: scope.worktree, source: reference,
          receipt_store: recorder.storeDir, dispatch_id: dispatchId });
        assert.equal(accounting.all_attempt_denominator, 6);
        const attempt = accounting.attempts.find(entry => entry.dispatch_id === failedEntry.dispatch_id);
        for (const key of ['delivered_raw_bytes', 'delivered_base64_bytes', 'observed_nested_bytes', 'observed_outer_bytes']) {
          assert.equal(attempt[key], null); assert.ok(attempt.unavailable_reasons[key]);
        }
        assert.equal(attempt.successful_calls, null);
        assert.equal(accounting.physical_bytes.raw, null);
        assert.equal(accounting.semantic_credit, false); assert.equal(accounting.current_verdict_authority, false);
        assert.equal(accounting.successful_physical_calls, input.manifest.batches.length);
        assert.equal(authority.readReviewSourceAttempts(failedSource).find(entry => entry.dispatch_id === failedEntry.dispatch_id).status, 'failed');
        for (const pin of [...originalPins, failedPin]) assert.deepEqual(fs.readFileSync(pin.file), pin.bytes);
        if (fault === 'tampered-snapshot') {
          fs.appendFileSync(failedPin.file, 'changed');
          assert.throws(() => runtime.verifyCompletedReviewConsumption({ worktree: scope.worktree, source: reference,
            receipt_store: recorder.storeDir, dispatch_id: dispatchId }), { code: 'REVIEW_SOURCE_INVALID' });
        }
        assert.ok(result.receipt.runtime_evidence.completed_source);
      }
      assert.equal(spawns, 2);
    }
  });
}

module.exports = { coldRecordedSourceControllerFixture, completedSourceReceiptRecoveryFixture, assert, fs, path, runtime, authority, completedSourceFixture, coldMeasuredSourceFixture, coldPrelaunchFixture, coldCompletedRecordingFixture, automaticCompletedReviewFixture, partialFailedSourceFixture };

if (require.main === module) {
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
      let originalSource, snapshot;
      if (name === 'changed worktree source') {
        originalSource = fs.readFileSync(path.join(f.worktree, 'source.txt'));
        snapshot = collector.verifyFileInput(f.input).manifest.snapshot;
        assert.equal(snapshot.head, execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
        assert.equal(snapshot.head_tree, execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
        assert.equal(snapshot.common, fs.realpathSync(execFileSync('git', ['-C', f.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()));
      }
      mutate(f);
      if (name === 'changed worktree source') {
        assert.throws(() => collector.verifyFileInput(f.input), { code: 'STALE_CONTEXT' });
        assert.throws(() => collector.verifyFileInput(f.input), { code: 'STALE_CONTEXT' });
        fs.writeFileSync(path.join(f.worktree, 'source.txt'), originalSource);
        assert.deepEqual(collector.verifyFileInput(f.input).manifest.snapshot, snapshot);
        const movedHead = execFileSync('git', ['-C', f.worktree, '-c', 'user.name=Fixture',
          '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
          'commit-tree', snapshot.head_tree, '-p', snapshot.head], { encoding: 'utf8', input: 'changed snapshot HEAD\n' }).trim();
        execFileSync('git', ['-C', f.worktree, 'update-ref', 'HEAD', movedHead, snapshot.head]);
        try { assert.throws(() => collector.verifyFileInput(f.input), { code: 'STALE_CONTEXT' }); }
        finally { execFileSync('git', ['-C', f.worktree, 'update-ref', 'HEAD', snapshot.head, movedHead]); }
        assert.deepEqual(collector.verifyFileInput(f.input).manifest.snapshot, snapshot);
        mutate(f);
        assert.throws(() => collector.verifyFileInput(f.input), { code: 'STALE_CONTEXT' });
      }
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


test('four continuation entries preserve the exact original registration names and callback bodies', () => {
  const entries = ['phase49-review-continuation.test.cjs', 'phase49-review-continuation-completed.test.cjs',
    'phase49-review-continuation-source.test.cjs', 'phase49-review-continuation-recovery.test.cjs'];
  const collect = `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const crypto = require('node:crypto'), children = require('node:child_process');
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
      children[key] = () => { throw new Error('registration inventory must not launch children'); };
    const cases = [], load = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'node:test') return { test(name, ...rest) {
        const callback = rest.at(-1);
        if (typeof callback !== 'function' || rest.slice(0, -1).some(value =>
          value && (value.skip || value.todo || value.concurrent || value.concurrency)))
          throw new Error('every registration must contain an ordinary sequential callback');
        cases.push([name, crypto.createHash('sha256').update(callback.toString()).digest('hex')]);
      } };
      return load.call(this, name, ...args);
    };
    const filename = path.resolve(process.argv[1]), entry = new Module(filename);
    entry.filename = filename; entry.paths = Module._nodeModulePaths(path.dirname(filename));
    process.mainModule = entry; require.cache[filename] = entry;
    entry._compile(fs.readFileSync(filename, 'utf8'), filename);
    process.stdout.write(JSON.stringify(cases));
  `;
  const inventories = entries.map(entry => JSON.parse(execFileSync(process.execPath,
    ['-e', collect, path.join(__dirname, entry)], { encoding: 'utf8', maxBuffer: 1024 * 1024 })));
  assert.deepEqual(inventories[0].slice(-2).map(record => record[0]), [
    'four continuation entries preserve the exact original registration names and callback bodies',
    'continuation helper import registers zero genuine tests and launches zero children',
  ]);
  const groups = [inventories[0].slice(0, -2), ...inventories.slice(1)];
  assert.deepEqual(groups.map(group => group.length), [90, 100, 93, 91]);
  const original = groups.flat(), names = original.map(record => record[0]);
  assert.equal(original.length, 374);
  assert.equal(new Set(names).size, 374);
  assert.equal(sha(JSON.stringify(names)), '9eb654b2db7b57316a6f6a4da8b14196f2b1e05048cefd367877866074b0ef93');
  assert.equal(sha(JSON.stringify(original)), '8b313921e2eb04d543380430a345f1ba3b7b938e8acb1108833955355d3be371');
});

test('continuation helper import registers zero genuine tests and launches zero children', () => {
  const probe = `
    require('node:test');
    const children = require('node:child_process'), fs = require('node:fs');
    for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
      children[key] = () => { throw new Error('helper import must not launch children'); };
    fs.mkdtempSync = () => { throw new Error('helper import must not create test state'); };
    require(process.argv[1]);
    process.stdout.write('import-ok\\n');
  `;
  const result = require('node:child_process').spawnSync(process.execPath,
    ['-e', probe, __filename], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'import-ok\n');
});

}
