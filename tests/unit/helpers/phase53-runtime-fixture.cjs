'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createRequire } = require('node:module');
const UNIT = path.resolve(__dirname, '..');
const unitRequire = createRequire(path.join(UNIT, 'codex-runtime-host.test.cjs'));

function createRuntimeFixture(options = {}) {
const __dirname = UNIT;
const require = options.scripts ? Object.assign(request =>
  request.startsWith('../../plugins/delivery-pipeline/scripts/')
    ? unitRequire(path.join(options.scripts, path.basename(request))) : unitRequire(request),
  { resolve: request => request.startsWith('../../plugins/delivery-pipeline/scripts/')
    ? unitRequire.resolve(path.join(options.scripts, path.basename(request))) : unitRequire.resolve(request) }) : unitRequire;
const assert = require('node:assert');
const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const crypto = require('node:crypto');

const { EventEmitter } = require('node:events');

const originalRuntimeCases = [];

const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');

const {
  EFFORTS,
  createCodexCliLauncher,
  createCodexRuntimeHost,
  observedSelection,
  parseNativeCodexTranscript,
  parseNativeParentSpawn,
  parseNativeChildTranscript,
  installedGsdAgent,
  signerProtectionPaths,
  signerPermissionProfileArgs,
  parseCodexStream,
  probeCodexRuntime,
} = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');

const { launchAgent } = require('../../plugins/delivery-pipeline/scripts/codex-agent.cjs');

const { createCodexDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');

const SCOPE = {
  run_id: 'run-37-04',
  ticket: 'T-37-04',
  phase: 37,
  worktree: '/tmp/shipyard-t3704',
  runtime: 'codex',
  provider: 'openai',
};

const capabilities = {
  supportedModels: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'],
  supportedEfforts: EFFORTS,
  observedModel: true,
  observedEffort: true,
};

const EXEC_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-exec.jsonl';

const PARENT_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';

const CHILD_FIXTURE = 'tests/fixtures/captured/codex-agent-stream-child.jsonl';

const PARENT_ID = '01a0e224-6642-7f20-b2a3-68b283d429b9';

const CHILD_ID = '01a0e224-80bb-7d33-b57d-8c44061ac85d';

const CAPTURED_TASK = 'Reply with the single word OK and take no other action.';

const CAPTURED_SHA256 = 'de94a486861cedd3587db16ba051e5c5bf80e0ab05fa44ed50ad48688e6f8b4c';

function captured(rel, values = {}) {
  return fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('{"shipyard_fixture"'))
    .map((line) => line.replace(/<SESSION-\d+>|<TMP>/g,
      (token) => (values[token] === undefined ? token : JSON.stringify(values[token]).slice(1, -1))))
    .join('\n') + '\n';
}

function stream(session = '11111111-1111-4111-8111-111111111111') {
  return captured(EXEC_FIXTURE, { '<SESSION-1>': session });
}

function sessionTranscript(session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  return transformJsonl(captured(PARENT_FIXTURE, { '<SESSION-2>': session }), (record) => {
    if (record.type === 'session_meta') record.payload.model_provider = provider;
    if (record.type === 'turn_context') Object.assign(record.payload, { model, effort });
    if (record.payload?.type === 'task_complete') record.payload.last_agent_message = 'OK';
    if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
      record.payload.content.forEach(block => { block.text = 'OK'; });
    return record;
  });
}

function writeSession(codeHome, session, model = 'gpt-6-luna', effort = 'max', provider = 'openai') {
  const date = new Date();
  const directory = path.join(codeHome, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-' + Date.now() + '-' + session + '.jsonl');
  fs.writeFileSync(file, sessionTranscript(session, model, effort, provider));
  return file;
}

function childFor(output, code = 0, pid = 24037, input = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write(value) { input.push(String(value)); },
    end() {},
  };
  child.pid = pid;
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  });
  return child;
}

function probe() {
  return {
    schema: 'shipyard.codex-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable: 'codex',
    runtime_version: '0.155.1',
    capabilities,
  };
}

function staticContent(resolution = { model: 'gpt-6.1-sol', effort: 'high' }) {
  return [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"',
    '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
    '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"',
    '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "research"',
    '# shipyard-policy-rung = "base"',
    'name = "shipyard-inv-research"',
    'model = "' + resolution.model + '"',
    'model_reasoning_effort = "' + resolution.effort + '"',
    'sandbox_mode = "read-only"',
    "developer_instructions = '''",
    'Follow the scoped research contract.',
    "'''",
    '',
  ].join('\n');
}

function recordedTypedSession() {
  const ids = { '<SESSION-2>': PARENT_ID, '<SESSION-6>': CHILD_ID };
  const parentRaw = captured(PARENT_FIXTURE, ids);
  const recorded = captured(CHILD_FIXTURE, ids);
  const elided = recorded.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((record) => record.type === 'response_item' && record.payload.role === 'developer')
    .payload.content[0].text;
  const instructions = elided + '\n';
  const childRaw = recorded.replace(JSON.stringify(elided), JSON.stringify(instructions));
  return { parentRaw, childRaw, parent: PARENT_ID, child: CHILD_ID, instructions };
}

function transformJsonl(raw, transform) {
  return raw.split('\n').filter(Boolean).map((line) => JSON.stringify(transform(JSON.parse(line)))).join('\n') + '\n';
}

function relayChild(codeHome, parentRaw, childRaw, options = {}) {
  const input = options.input || [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = options.pid || 24050;
  child.stdin = {
    write(value) { input.push(String(value)); },
    end() {
      const sent = input.join('');
      const task = { file: /^TASK_FILE=(.*)$/m.exec(sent)[1], sha256: /^TASK_SHA256=(.*)$/m.exec(sent)[1] };
      const now = new Date();
      const directory = path.join(codeHome, 'sessions', String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'rollout-' + PARENT_ID + '.jsonl'), parentRaw);
      if (childRaw !== null) {
        const replay = childRaw.split('<TMP>').join(JSON.stringify(task.file).slice(1, -1));
        fs.writeFileSync(path.join(directory, 'rollout-' + CHILD_ID + '.jsonl'),
          options.mutate ? options.mutate(replay, task) : replay);
      }
      if (options.onTask) options.onTask(task);
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(stream(PARENT_ID)));
        child.emit('close', 0, null);
      });
    },
  };
  return child;
}

const HOST_SCRIPT = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');

function runCapabilityOnly(script, env, extra = []) {
  const { spawnSync: spawn } = require('node:child_process');
  const result = spawn(process.execPath, [script, '--capability-only', ...extra], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fakeCodex(root) {
  const file = path.join(root, 'codex');
  fs.writeFileSync(file, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.155.1"; else echo "--json --model --config --cd --ignore-user-config"; fi\n', { mode: 0o755 });
  return file;
}

function installedBundle(root) {
  const { codexCapabilities } = require('../smoke/installed-launch/lib.cjs');
  const home = path.join(root, 'codex-home');
  const bundle = path.join(home, 'shipyard');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.cpSync(path.dirname(HOST_SCRIPT), path.join(bundle, 'scripts'), { recursive: true });
  const evidence = Buffer.from(JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  fs.writeFileSync(path.join(home, 'agents', '.shipyard-manifest.json'), JSON.stringify({
    phase: 2, codexHome: home, scriptsRoot: bundle, capabilities_file: 'codex-capabilities.json',
    capabilities_digest: crypto.createHash('sha256').update(evidence).digest('hex'),
  }));
  return { home, script: path.join(bundle, 'scripts', 'codex-runtime-host.cjs') };
}

const ROLE_TOML = (instructions) => 'name = "gsd-plan-checker"\ndescription = "Plan checker"\nsandbox_mode = "read-only"\ndeveloper_instructions = \'\'\'\n' + instructions + "'''\n";

const TYPED = { model: 'gpt-6-luna', effort: 'low', sandbox_mode: 'read-only', gsd_role: 'gsd-plan-checker' };

async function codeReviewRuntimeFixture(action, partitioned = false, critical = false) {
  await Promise.all(originalRuntimeCases);
  const helper = require('./helpers/codex-arch-review-fixtures.cjs');
  const code = require('../../plugins/delivery-pipeline/scripts/codex-code-review-context.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = helper.fixture();
  const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-runtime-')));
  const originalHome = os.homedir;
  os.homedir = () => storage;
  try {
    const graphDir = path.join(f.root, '.planning/graph');
    const graph = JSON.parse(fs.readFileSync(path.join(graphDir, 'tickets.json')));
    const row = Object.values(graph.tickets)[0]; row.epic = 'epic/38-code-runtime'; row.human_checkpoint = false; row.critical = critical;
    helper.write(f.root, '.planning/graph/tickets.json', JSON.stringify(graph));
    if (partitioned) helper.write(f.root, 'src/reviewed.txt', ('large line ' + 'x'.repeat(240) + '\n').repeat(5000));
    helper.git(f.root, ['add', '.']); helper.git(f.root, ['commit', '-m', 'code review runtime phase']);
    helper.git(f.root, ['switch', '-c', row.epic]);
    Object.assign(f.pr, { headRefName: row.epic, headRefOid: helper.git(f.root, ['rev-parse', 'HEAD']) });
    const scope = { run_id: 'code-runtime', phase: 38, worktree: f.root, runtime: 'codex', provider: 'openai',
      ticket: target.phaseBinding({ graph, state: JSON.parse(fs.readFileSync(path.join(graphDir, 'delivery-state.json'))),
        phase: 38, repository: target.repositoryIdentity(f.root), pr: f.pr.number,
        head: f.pr.headRefOid, base: f.pr.baseRefOid, branch: row.epic }).subject };
    const value = code.prepare(scope, { role: 'code-review', context: {}, signals: {} },
      { graphDir, storageRoot: storage, refreshGit: false, getPullRequest: () => f.pr, inflightDispatchId: 'code-runtime-dispatch' });
    const selected = policy.resolveDispatch({ runtime: 'codex', role: 'code-review', signals: value.launch.signals });
    const content = staticContent(selected).replace('shipyard-policy-role = "research"', 'shipyard-policy-role = "code-review"')
      .replace('shipyard-inv-research', 'shipyard-code-review');
    const agentDir = path.join(storage, 'agents'); fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, selected.agent_file), content);
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const agentManifest = path.join(agentDir, '.shipyard-manifest.json');
    fs.writeFileSync(agentManifest, JSON.stringify({ agent_files: [selected.agent_file], agent_digests: { [selected.agent_file]: digest } }));
    code.admitInstalledLaunch(value, { agentDir, agentFile: selected.agent_file, agentManifest, capabilities });
    const input = code.admittedFileInput(value);
    const selection = { model: selected.model, effort: selected.effort, sandbox_mode: 'read-only', agent_file: selected.agent_file,
      agent_file_content: content, agent_file_digest: digest };
    const context = { dispatch_id: value.launch.dispatch_id, prompt: code.admittedPrompt(value), code_review_prepared: value,
      ...(input ? { input_prepared: input, input_transport: 'host-files', input_bundle: input.input_bundle } : {}) };
    await action({ f, storage, scope, code, value, selection, context, input });
  } finally {
    os.homedir = originalHome;
    fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(storage, { recursive: true, force: true });
  }
}

function createRecoveryFixture() {
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

let registry;

function captured(name) {
  const file = registry.fixtures.find(file => file.endsWith('/codex-agent-stream-' + name + '.jsonl'));
  assert.ok(file, 'native record templates must come from the registered boundary');
  return fs.readFileSync(path.join(fixtureRoot, file), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(record => !record.shipyard_fixture);
}

let cliRecords;

let parentRecords;

let childRecords;

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

function directBatchReads(records) {
  return records.map(record => {
    const item = record.payload;
    if (item?.type === 'custom_tool_call' && item.input?.includes('--read-batch')) {
      const args = JSON.parse(/^text\(await tools.exec_command\((.*)\)\);$/.exec(item.input)[1]);
      return response('function_call', item.internal_chat_message_metadata_passthrough.turn_id,
        { name: 'functions.exec_command', call_id: item.call_id, arguments: JSON.stringify(args) }, parentRecords);
    }
    if (item?.type === 'custom_tool_call_output')
      return response('function_call_output', item.internal_chat_message_metadata_passthrough.turn_id,
        { call_id: item.call_id, output: item.output[1].text }, parentRecords);
    return record;
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
  const readsWithTelemetry = (reads, turn, offset = 0) => {
    const records = nativeReads(reads, turn, offset);
    if (options.telemetry !== undefined) for (const record of records) {
      if (record.payload?.type !== 'custom_tool_call_output') continue;
      const value = JSON.parse(record.payload.output[1].text);
      value.original_token_count = options.telemetry;
      record.payload.output[1].text = JSON.stringify(value);
    }
    return records;
  };
  const typedRole = options.role === 'integrator' ? 'shipyard-integrator' : 'shipyard-arch-review';
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
    const profile = options.batch ? collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: options.rangesPerBatch || 2,
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
    if (options.typed) {
      fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(home, 'agents/' + typedRole + '.toml'),
        'name = "' + typedRole + '"\ndescription = "Architecture reviewer"\nsandbox_mode = "read-only"\n' + content + '\n');
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
        event('task_started', 'capacity-turn'), ...readsWithTelemetry(reads, 'capacity-turn'), ...finish('capacity-turn', result)]));
      fs.chmodSync(probe, 0o600);
      const verified = await runtime.verifyCompletedNativeLaunch({ session_id: session, selection,
        env: { CODEX_HOME: probeHome }, resultText: result });
      assert.throws(() => runtime.measureReaderCapacity(verified, input), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      const application = await recordedBatchApplication(verified, input, root,
        serialize([cliThread(session), ...cliCompletion(result)]), options.separateProbe);
      assert.throws(() => runtime.measureReaderCapacity(verified, input,
        { recorder: {}, receipt: JSON.parse(JSON.stringify(application.receipt)) }),
      error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      const capacity = runtime.measureReaderCapacity(verified, input, application);
      assert.throws(() => collector.admitReaderBatchInput(input, JSON.parse(JSON.stringify(capacity))),
        error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      input = collector.admitReaderBatchInput(input, capacity);
    }
    const metadata = nativeMetadata(reviewerSession, worktree, options.typed);
    if (options.typed) { metadata.payload.agent_role = typedRole; metadata.payload.source.subagent.thread_spawn.agent_role = typedRole; }
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
                  arguments: JSON.stringify({ agent_type: typedRole, model: selection.model,
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
              ...readsWithTelemetry(reads.slice(0, originalCount), 'original-turn'),
              ...(options.pendingBatch ? readsWithTelemetry(reads.slice(originalCount, originalCount + 1), 'original-turn', originalCount).slice(0, 1) : []),
              ...((options.groupedBatch || options.groupedPendingBatch) ? (() => {
                const nested = readsWithTelemetry(reads.slice(originalCount, originalCount + 2), 'original-turn', originalCount);
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
                const interrupted = readsWithTelemetry(reads.slice(originalCount, originalCount + 1), 'original-turn', originalCount);
                const envelope = JSON.parse(interrupted[1].payload.output[1].text);
                envelope.output = envelope.output.split('\n').slice(0, -2).join('\n') + '\n';
                interrupted[1].payload.output[1].text = JSON.stringify(envelope);
                return interrupted;
              })() : []),
              ...(options.typed ? [event('task_aborted', 'original-turn')] : [])];
            const originalRecords = options.directBatch ? directBatchReads(prefix) : prefix;
            firstRaw = serialize(options.tamperOriginal ? options.tamperOriginal(originalRecords) : originalRecords);
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
            let remaining = readsWithTelemetry(reads.slice(originalCount), 'resumed-turn', 1);
            if (options.directBatch) remaining = directBatchReads(remaining);
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
      ...(options.typed ? { gsd_role: typedRole, gsd_launch_mechanism: 'typed-gsd-callback' } : {}),
      onReviewProgress: reference => { progress = reference; references.push(reference); liveCredit ||= !closed; } };
    const staticSelection = options.typed ? { ...selection }
      : { ...selection, agent_file_content: content, agent_file_digest: sha(content) };
    const restore = options.beforeLaunch?.({ root, worktree });
    try { await assert.rejects(host.launchStatic(staticSelection, launch)); } finally { restore?.(); }
    await action({ root, worktree, input, host, progress, calls, native, parent, reviewerSession, firstRaw, reads, result,
      selection: staticSelection, createHost, scope, stdin, references, completions,
      liveCredit, launch, get resumedCommands() { return resumedCommands; } });
  } finally { os.homedir = oldHome; fs.rmSync(root, { recursive: true, force: true }); }
}

async function completedFixture(f) {
  fs.chmodSync(f.native, 0o600);
  if (f.parent !== f.native) fs.chmodSync(f.parent, 0o600);
  const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const receiptStore = path.join(f.root, 'receipts');
  const recorder = boundaryModule.createDurableRecorder(receiptStore);
  const progress = authority.readReviewProgress({ worktree: f.worktree, reference: f.progress });
  const content = f.selection.agent_file_content || fs.readFileSync(progress.original_launch.agent.file, 'utf8');
  const adapter = {
    validateGeneratedAgent(resolution) {
      return { valid: true, exists: true, content_verified: true, policy_hash: resolution.policy_hash,
        agent_file: resolution.agent_file, agent_file_digest: sha(content), agent_file_content: content };
    },
    async launchStatic(resolution) {
      const completed = await f.host.resumeReview(f.selection, { progress: f.progress, dispatch_id: resolution.dispatch_id });
      return { ...completed, receipt_type: 'adr-014.application', runtime: resolution.runtime, role: resolution.role,
        dispatch_id: resolution.dispatch_id, requested_model: resolution.requested_model,
        requested_effort: resolution.requested_effort, policy_hash: resolution.policy_hash,
        agent_file: resolution.agent_file, agent_file_digest: resolution.agent_file_digest };
    },
  };
  const boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder });
  const completed = await boundary.dispatch({ runtime: 'codex', role: progress.identity.role,
    dispatch_id: 'completed-accounting', signals: {} }, { ticket: f.scope.ticket });
  const recorded = recorder.getVerifiedRecord(completed.dispatch_id);
  assert.ok(recorded);
  assert.deepEqual(recorded.receipt, completed.receipt);
  const evidence = recorded.receipt.runtime_evidence;
  if (progress.original_launch.agent) {
    assert.equal(recorded.receipt.gsd_role, undefined);
    assert.equal(recorded.receipt.gsd_launch_mechanism, undefined);
    assert.equal(evidence.review_continuation.original_launch.gsd_role, progress.original_launch.agent.role);
    assert.deepEqual(evidence.review_continuation.original_launch.task_relay, progress.original_launch.runtime_launch.task_relay);
    assert.equal(evidence.native_child_evidence.agent_role, progress.original_launch.agent.role);
  }
  return { selectors: { worktree: f.worktree, progress: f.progress, receipt_store: receiptStore,
    dispatch_id: completed.dispatch_id }, completed };
}

function accountingChild(f, selectors, operation = 'account') {
  const program = `
    const fs = require('node:fs');
    require('node:os').homedir = () => process.env.ACCOUNTING_FIXTURE_ROOT;
    const runtime = require(process.env.ACCOUNTING_RUNTIME);
    const authority = require(process.env.ACCOUNTING_AUTHORITY);
    const selectors = JSON.parse(process.env.ACCOUNTING_SELECTORS);
    if (process.env.ACCOUNTING_OPERATION === 'race') {
      const nativeFile = process.env.ACCOUNTING_NATIVE;
      const nativeIdentity = fs.lstatSync(nativeFile);
      const nativeBytes = fs.readFileSync(nativeFile);
      const originalRead = fs.readSync, originalWrite = fs.writeFileSync, originalRename = fs.renameSync;
      let replaced = false;
      fs.readSync = (fd, ...args) => {
        const count = originalRead(fd, ...args);
        const identity = fs.fstatSync(fd);
        if (!replaced && identity.dev === nativeIdentity.dev && identity.ino === nativeIdentity.ino) {
          replaced = true;
          originalWrite(nativeFile + '.race', nativeBytes, { mode: 0o600 });
          originalRename(nativeFile + '.race', nativeFile);
        }
        return count;
      };
    }
    for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'appendFileSync', 'fsyncSync'])
      fs[name] = () => { throw new Error('accounting attempted mutation: ' + name); };
    const originalOpen = fs.openSync;
    fs.openSync = (file, flags, ...rest) => {
      if (typeof flags === 'string' ? flags !== 'r' : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)))
        throw new Error('accounting attempted write-open');
      return originalOpen(file, flags, ...rest);
    };
    const value = process.env.ACCOUNTING_OPERATION === 'references'
      ? authority.authenticateCompletedReviewReferences(selectors) : runtime.verifyCompletedReviewConsumption(selectors);
    if (!Object.isFrozen(value) || !Object.isFrozen(value.identity || value.progress.identity)) throw new Error('mutable result');
    process.stdout.write(JSON.stringify(value));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', program], { encoding: 'utf8', env: { ...process.env,
    ACCOUNTING_FIXTURE_ROOT: f.root, ACCOUNTING_SELECTORS: JSON.stringify(selectors), ACCOUNTING_OPERATION: operation,
    ACCOUNTING_NATIVE: f.native,
    ACCOUNTING_RUNTIME: require.resolve('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs'),
    ACCOUNTING_AUTHORITY: require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs') } }));
}

async function productionBatchProbeFixture(f, mutation, role = 'arch-review', configuredTranscript = false) {
  const boundaryModule = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const root = path.join(f.root, 'production-probe'), home = path.join(root, 'codex');
  const agents = path.join(home, 'agents'); fs.mkdirSync(agents, { recursive: true });
  const resolved = policy.resolveDispatch({ runtime: 'codex', role, signals: {}, dispatch_id: 'production-capacity' });
  const content = [
    '# shipyard-policy-id = "' + policy.POLICY.id + '"', '# shipyard-policy-version = "' + policy.POLICY_VERSION + '"',
    '# shipyard-policy-hash = "' + policy.POLICY_HASH + '"', '# shipyard-policy-runtime = "codex"',
    '# shipyard-policy-role = "' + role + '"', '# shipyard-policy-rung = "' + resolved.rung + '"',
    'name = "' + resolved.agent_file.replace(/\.toml$/, '') + '"',
    'model = "' + resolved.model + '"', 'model_reasoning_effort = "' + resolved.effort + '"',
    'sandbox_mode = "read-only"', "developer_instructions = '''", 'Review all required material.', "'''", '',
  ].join('\n');
  fs.writeFileSync(path.join(agents, resolved.agent_file), content);
  fs.writeFileSync(path.join(agents, '.shipyard-manifest.json'), JSON.stringify({
    policy_id: policy.POLICY.id, policy_version: policy.POLICY_VERSION, policy_hash: policy.POLICY_HASH,
    agent_files: [resolved.agent_file], agent_digests: { [resolved.agent_file]: sha(content) },
  }));
  const profile = collector.createReaderBatchProfile({ chunk_bytes: 8192, ranges_per_batch: 3,
    candidate: f.input.manifest.transport.candidate });
  const input = collector.prepareFileInput(f.scope, collector.verifyFileInput(f.input).material, {
    readerProfile: profile, role, dispatchId: resolved.dispatch_id, storageRoot: path.join(root, 'inputs'),
    generatedInstructionBytes: f.input.manifest.accounting.generated_instruction_bytes, binding: f.input.manifest.binding,
  });
  const resultText = JSON.stringify({
    input_manifest_sha256: input.input_bundle.manifest_sha256, input_material_bytes: input.input_bundle.total_bytes,
    input_asset_count: input.input_bundle.asset_count, input_chunk_reads: input.manifest.ranges.length,
    input_batch_reads: input.manifest.batches.length, input_profile_sha256: input.manifest.transport.profile_sha256,
  });
  const receiptStore = path.join(root, 'receipts'), recorder = boundaryModule.createDurableRecorder(receiptStore);
  const date = new Date(), directory = path.join(home, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const sessionId = '55555555-5555-4555-8555-555555555555', nativeFile = path.join(directory, sessionId + '.jsonl');
  let spawned = 0, completed = 0, observedCompletion, finalInput;
  const probeOptions = { scope: f.scope, probe: { ...probe(), capabilities }, recorder,
    env: { CODEX_HOME: home },
    ...(configuredTranscript ? { transcriptDir: path.join(root, 'transcripts') } : {}),
    spawn(_executable, args) {
      spawned++;
      assert.equal(args[args.indexOf('--model') + 1], resolved.model);
      assert.ok(args.includes('model_reasoning_effort="' + resolved.effort + '"'));
      const turn = spawned === 1 ? 'production-capacity-turn' : 'production-final-turn', context = nativeContext(turn, f.worktree);
      const activeSession = spawned === 1 ? sessionId : '66666666-6666-4666-8666-666666666666';
      const activeInput = finalInput || input;
      if (mutation === 'native-model') {
        context.payload.model = 'gpt-6-luna'; context.payload.collaboration_mode.settings.model = 'gpt-6-luna';
      }
      if (mutation === 'native-effort') {
        context.payload.effort = 'low'; context.payload.collaboration_mode.settings.reasoning_effort = 'low';
      }
      let reads = nativeReads(readRecords(activeInput), turn);
      if (['outer-truncation', 'outer-second-block-truncation', 'nested-truncation', 'direct-truncation', 'malformed-output'].includes(mutation)) {
        const output = reads.find(record => record.payload?.type === 'custom_tool_call_output').payload;
        if (mutation === 'outer-truncation') {
          output.output[0].text = 'Script completed\nWall time 0.1 seconds\nOriginal token count: 12000\nWarning: output truncated\nOutput:';
          output.output[1].text = '{"exit_code":0,"output":"clipped';
        } else if (mutation === 'outer-second-block-truncation') {
          assert.match(output.output[0].text, /^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/);
          output.output[1].text = 'Warning: truncated output (original token count: 10079)\n{"exit_code":0,"output":"clipped';
        } else if (mutation === 'malformed-output') output.output[1].text = '{"exit_code":0';
        else {
          const nested = JSON.parse(output.output[1].text);
          nested.truncated = true; nested.original_token_count = 12000;
          output.output[1].text = JSON.stringify(nested);
          if (mutation === 'direct-truncation') reads = directBatchReads(reads);
        }
      }
      fs.writeFileSync(path.join(directory, activeSession + '.jsonl'), serialize([nativeMetadata(activeSession, f.worktree), context,
        message('developer', turn, runtime.generatedInstructions(content)), message('user', turn, activeInput.prompt),
        event('task_started', turn), ...reads, ...finish(turn, resultText)]), { mode: 0o600 });
      return childFor(serialize([cliThread(activeSession), ...cliCompletion(resultText)]));
    },
  };
  if (mutation === 'missing-recorder') probeOptions.recorder = () => true;
  if (mutation === 'stale-agent') fs.appendFileSync(path.join(agents, resolved.agent_file), '\n');
  const host = runtime.createCodexRuntimeHost(probeOptions);
  const requested = { ...selection,
    ...(mutation === 'requested-model' ? { model: 'gpt-6-luna' } : {}),
    ...(mutation === 'requested-effort' ? { effort: 'low' } : {}) };
  const originalFsync = fs.fsyncSync;
  let capacity;
  try {
    const run = () => host.measureBatchReaderCapacity(requested, input, {
      onCompleted(value) {
        completed++; observedCompletion = value;
        assert.equal(recorder.getVerifiedRecord(resolved.dispatch_id), null);
        assert.equal(recorder.getVerifiedRecord(value.runtime_evidence.dispatch_id), null);
        assert.notEqual(value.runtime_evidence.dispatch_id, resolved.dispatch_id);
        assert.equal(value.runtime_evidence.reader_capacity_probe.review_dispatch_id, resolved.dispatch_id);
        assert.throws(() => collector.requireReaderBatchCapacity(input), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
        if (mutation === 'recorder-failure') fs.fsyncSync = () => { throw new Error('isolated recorder fsync failure'); };
      },
    });
    if (mutation) {
      await assert.rejects(run, error => {
        if (['outer-truncation', 'outer-second-block-truncation', 'nested-truncation', 'direct-truncation', 'malformed-output'].includes(mutation)) {
          assert.equal(error.code, 'RUNTIME_EVIDENCE_MISMATCH');
          if (mutation === 'malformed-output') assert.equal(error.details.reason, undefined);
          else {
            assert.equal(error.details.reason, 'reader-output-truncation');
            assert.equal(error.details.envelope_layer, ['outer-truncation', 'outer-second-block-truncation'].includes(mutation) ? 'outer' : 'nested');
            assert.equal(error.details.original_token_count, mutation === 'outer-second-block-truncation' ? 10079 : 12000);
            assert.equal(error.details.batch_index, 0);
            assert.ok(error.details.call_id.length <= 256);
            assert.ok(JSON.stringify(error.details).length < 1024);
          }
          return true;
        }
        return mutation === 'native-model' || mutation === 'native-effort'
        ? error.code === 'RUNTIME_EVIDENCE_MISMATCH'
        : mutation === 'missing-recorder' ? error.code === 'READER_CAPACITY_UNSUPPORTED'
        : mutation === 'stale-agent' ? error.code === 'STALE_GENERATED_AGENT'
        : mutation === 'recorder-failure' ? /record|fsync/i.test(error.message)
        : ['CONFLICTING_OVERRIDE', 'UNSUPPORTED_SELECTION', 'INVALID_RESOLUTION'].includes(error.code);
      });
      assert.equal(completed, mutation === 'recorder-failure' ? 1 : 0);
      assert.equal(spawned, ['native-model', 'native-effort', 'recorder-failure', 'outer-truncation', 'outer-second-block-truncation', 'nested-truncation', 'direct-truncation', 'malformed-output'].includes(mutation) ? 1 : 0);
      assert.throws(() => collector.requireReaderBatchCapacity(input), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
      return;
    }
    capacity = await run();
  } finally { fs.fsyncSync = originalFsync; }
  assert.equal(completed, 1); assert.equal(spawned, 1);
  const record = recorder.getVerifiedRecord(capacity.contract.application_dispatch_id);
  assert.notEqual(record.dispatch_id, resolved.dispatch_id);
  assert.equal(recorder.getVerifiedRecord(resolved.dispatch_id), null);
  assert.equal(record.receipt.role, role);
  for (const field of ['requested_model', 'requested_effort']) assert.equal(record.receipt[field], resolved[field]);
  assert.equal(record.receipt.applied_model, resolved.model); assert.equal(record.receipt.applied_effort, resolved.effort);
  assert.equal(record.receipt.compliance, 'verified');
  assert.deepEqual(record.receipt.runtime_evidence, observedCompletion.runtime_evidence);
  assert.equal(record.receipt.runtime_evidence.native_session_evidence.sha256, sha(fs.readFileSync(nativeFile)));
  assert.equal(capacity.contract.application_dispatch_id, record.dispatch_id);
  assert.equal(capacity.contract.application_receipt_sha256, sha(policy.stableStringify(record.receipt)));
  assert.equal(capacity.contract.semantic_credit, false);
  const admitted = collector.admitReaderBatchInput(input, capacity);
  collector.requireReaderBatchCapacity(admitted);
  assert.equal(record.receipt.runtime_evidence.transcript.path, configuredTranscript
    ? path.join(root, 'transcripts', f.scope.run_id + '-' + record.dispatch_id + '-' + sessionId + '.jsonl')
    : path.join(home, 'shipyard', 'transcripts', sha(f.worktree), f.scope.run_id + '-' + record.dispatch_id + '-' + sessionId + '.jsonl'));
  const manifestBefore = fs.readFileSync(input.input_bundle.manifest_path);
  finalInput = admitted;
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: agents, capabilities, host });
  const finalBoundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder });
  const final = await finalBoundary.dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: resolved.dispatch_id },
    { ticket: f.scope.ticket, phase: f.scope.phase, run_id: f.scope.run_id, worktree: f.worktree,
      prompt: admitted.prompt, input_transport: 'host-files', input_bundle: admitted.input_bundle, input_prepared: admitted,
      onCompleted(value) {
        completed++;
        assert.equal(value.runtime_evidence.dispatch_id, resolved.dispatch_id);
        assert.equal(value.runtime_evidence.reader_capacity_probe, undefined);
        assert.equal(recorder.getVerifiedRecord(resolved.dispatch_id), null);
      } });
  assert.equal(spawned, 2); assert.equal(completed, 2);
  assert.notEqual(final.receipt.runtime_evidence.session_id, record.receipt.runtime_evidence.session_id);
  assert.deepEqual(final.receipt.runtime_evidence.input_bundle, admitted.input_bundle);
  assert.equal(final.receipt.runtime_evidence.input_consumption.logical_ranges, input.manifest.ranges.length);
  assert.deepEqual(recorder.getVerifiedRecord(resolved.dispatch_id).receipt, final.receipt);
  assert.deepEqual(recorder.getVerifiedRecord(record.dispatch_id), record);
  assert.deepEqual(fs.readFileSync(input.input_bundle.manifest_path), manifestBefore);
  assert.throws(() => finalBoundary.dispatch({ runtime: 'codex', role, signals: {}, dispatch_id: resolved.dispatch_id }),
    error => error.code === 'DUPLICATE_DISPATCH_ID');
  assert.equal(spawned, 2);
  const verified = await runtime.verifyCompletedNativeLaunch({ session_id: sessionId, selection,
    env: { CODEX_HOME: home }, resultText });
  assert.throws(() => runtime.measureReaderCapacity(verified, input), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
  const cliFile = record.receipt.runtime_evidence.transcript.path, cliRaw = fs.readFileSync(cliFile);
  fs.writeFileSync(cliFile, cliRaw.subarray(0, cliRaw.length - 2));
  assert.throws(() => runtime.readerCapacityContract(capacity, input.manifest));
  fs.writeFileSync(cliFile, cliRaw);
  const recordFile = path.join(receiptStore, 'record-' + sha(record.dispatch_id) + '.json'), saved = fs.readFileSync(recordFile);
  fs.unlinkSync(recordFile);
  assert.throws(() => runtime.readerCapacityContract(capacity, input.manifest), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
  fs.writeFileSync(recordFile, saved, { mode: 0o600 });
  const changed = JSON.parse(saved); changed.payload.receipt.applied_effort = 'low';
  fs.writeFileSync(recordFile, JSON.stringify(changed));
  assert.throws(() => runtime.readerCapacityContract(capacity, input.manifest), error => error.code === 'READER_CAPACITY_UNSUPPORTED');
}
let prepared = false;
function prepare() {
  if (prepared) return;
  registry = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'tests/fixtures/captured/boundaries/codex-agent-stream.json')));
cliRecords = captured('exec');
parentRecords = captured('parent');
childRecords = captured('child');
  prepared = true;
}
return { assert, fs, os, path, crypto, EventEmitter, execFileSync, collector, runtime, authority, sha, stable, session, childSession, selection, serialize, fixtureRoot, captured, template, event, response, message, nativeMetadata, nativeContext, cliThread, cliCompletion, readRecords, nativeReads, directBatchReads, finish, recordedBatchApplication, fixture, completedFixture, accountingChild, productionBatchProbeFixture, prepare,
  get registry() { return registry; }, get cliRecords() { return cliRecords; },
  get parentRecords() { return parentRecords; }, get childRecords() { return childRecords; } };
}
const recovery = createRecoveryFixture();
let serial = Promise.resolve();
let completedCases = Promise.all(originalRuntimeCases);
function runOriginal(callback) {
  const result = callback();
  if (result && typeof result.then === 'function') originalRuntimeCases.push(result.catch(() => {}));
  return result;
}
function runCompleted(callback) {
  const predecessors = Promise.all(originalRuntimeCases);
  const previous = completedCases;
  const result = predecessors.then(() => previous).then(callback);
  completedCases = result.catch(() => {});
  originalRuntimeCases.push(completedCases);
  return result;
}
function run(callback, family) {
  const result = serial.then(() => family === 'original' ? runOriginal(callback)
    : family === 'completed' ? runCompleted(callback) : callback());
  serial = result.catch(() => {});
  return result;
}
return { fs, os, path, crypto, EventEmitter, originalRuntimeCases, policy, EFFORTS, createCodexCliLauncher, createCodexRuntimeHost, observedSelection, parseNativeCodexTranscript, parseNativeParentSpawn, parseNativeChildTranscript, installedGsdAgent, signerProtectionPaths, signerPermissionProfileArgs, parseCodexStream, probeCodexRuntime, launchAgent, createCodexDispatchAdapter, SCOPE, capabilities, EXEC_FIXTURE, PARENT_FIXTURE, CHILD_FIXTURE, PARENT_ID, CHILD_ID, CAPTURED_TASK, CAPTURED_SHA256, captured, stream, sessionTranscript, writeSession, childFor, probe, staticContent, recordedTypedSession, transformJsonl, relayChild, HOST_SCRIPT, runCapabilityOnly, fakeCodex, installedBundle, ROLE_TOML, TYPED, codeReviewRuntimeFixture, assert, require, __dirname, recovery, run, runOriginal, runCompleted,
  settled: () => serial, delivery: options.delivery, prepare: () => recovery.prepare() };
}

function createRuntimeLifecycle(options = {}) {
  let context, previous, closed = false;
  const deliveryLifecycle = options.deliveryLifecycle || require('./phase53-delivery-fixture.cjs').createDeliveryLifecycle(options);
  function start() {
    if (context || closed) throw new Error('runtime fixture lifecycle already started');
    previous = { home: os.homedir, fs: Object.fromEntries(['readFileSync', 'readSync', 'openSync', 'fsyncSync']
      .map(name => [name, fs[name]])) };
    try {
      const delivery = deliveryLifecycle.start();
      context = createRuntimeFixture({ ...options, delivery, scripts: delivery.scriptsRoot });
      context.prepare();
      delivery.runtime = context;
      process.on('exit', cleanup);
      return context;
    } catch (error) { cleanup(); throw error; }
  }
  function cleanup() {
    if (closed) return;
    closed = true;
    try { deliveryLifecycle.cleanup(); } finally {
      if (previous) {
        os.homedir = previous.home;
        for (const [name, implementation] of Object.entries(previous.fs)) fs[name] = implementation;
      }
      process.removeListener('exit', cleanup);
    }
  }
  return { start, cleanup };
}

module.exports = { createRuntimeFixture, createRuntimeLifecycle };
