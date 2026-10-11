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
      capacity = runtime.measureReaderCapacity(verified, input);
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
