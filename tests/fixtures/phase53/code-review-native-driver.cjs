'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const scripts = path.resolve(__dirname, '../../../plugins/delivery-pipeline/scripts');
const root = path.resolve(__dirname, '../../..');
const authority = require(path.join(scripts, 'role-artifact.cjs'));
const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
function boundaryRegistry(boundary) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/captured/boundaries', boundary + '.json')));
}
function registered(boundary, suffix) {
  const registry = boundaryRegistry(boundary);
  const file = registry.fixtures.find(file => file.endsWith('/' + suffix));
  assert.ok(file, 'native template must be registered');
  return fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n').map(JSON.parse).filter(row => !row.shipyard_fixture);
}
function template(rows, predicate) {
  const row = rows.find(predicate);
  assert.ok(row, 'registered native template must contain the requested record');
  return structuredClone(row);
}
function payloadFor(input, worktree) {
  const payload = JSON.parse(input.match(/<AUTHENTICATED_SEMANTIC_REVIEW>\s*([\s\S]*?)\s*<\/AUTHENTICATED_SEMANTIC_REVIEW>/)[1]);
  if (payload.input_transport === 'host-files') {
    for (const source of payload.material) source.content = fs.readFileSync(path.resolve(worktree, source.read_path), 'utf8');
    payload.originals = payload.originals.map(item => {
      const original_text = fs.readFileSync(path.resolve(worktree, item.read_path), 'utf8');
      return { reference: item.reference, native: item.native, original_text, result: JSON.parse(original_text) };
    });
  }
  if (payload.stage === 'final') {
    assert.equal(payload.originals.length, 2);
    for (const original of payload.originals) assert.deepEqual(authority.readSemanticOriginal({ worktreePath: worktree,
      snapshot_sha256: payload.snapshot_sha256, assignment_id: original.reference.assignment_id }), original);
  }
  return payload;
}
function answer(payload, runtime) {
  const id = payload.reviewed_identity;
  const result = { schema: 'shipyard.semantic-review.v1', review_contract: 'shipyard.semantic-review.v1',
    role: 'code-review', stage: payload.stage, runtime, subject: payload.subject,
    snapshot_sha256: payload.snapshot_sha256, assignment_id: payload.assignment?.id || null,
    binding_sha256: payload.binding_sha256, reviewed_identity: id,
    completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], limitations: [],
    required_context: [], unread: [], conclusions: ['Fixture inspected the supplied product material.'],
    coverage: payload.assignment?.primary_obligation_ids || payload.obligation_ids,
    seams: payload.seams.map(seam => ({ id: seam.id, disposition: 'resolved', rationale: 'Fixture read both source endpoints.' })),
    originals: payload.originals.map(item => item.reference), evidence_markdown: 'Complete code review fixture evidence.\n' };
  if (payload.stage === 'final') Object.assign(result, { phase: id.phase, id: payload.subject, repository: id.repository,
    pr: id.pr, head: id.head, head_tree: id.head_tree, base: id.base_ref, base_commit: id.base,
    merge_base: id.merge_base, base_tree: id.merge_base_tree, ticket_set: id.ticket_set,
    ticket_set_digest: id.ticket_set_digest, dispositions: [], summary: 'Independent fixture final.' });
  return result;
}
function semanticNativeDriver({ runtime, worktree, storageRoot, agentDir, agentManifest, controls = {} }) {
  const launches = [];
  const runtimeVersion = boundaryRegistry(runtime === 'codex' ? 'codex-agent-stream' : 'claude-stream').cli_version;
  const nativeRows = registered(runtime === 'codex' ? 'codex-agent-stream' : 'claude-stream',
    runtime === 'codex' ? 'codex-agent-stream-parent.jsonl' : 'claude-stream-research.jsonl');
  const cli = runtime === 'codex' ? registered('codex-agent-stream', 'codex-agent-stream-exec.jsonl') : nativeRows;
  const spawn = (_executable, args) => {
    const child = new EventEmitter(); child.pid = process.pid;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let framed = '';
    child.stdin = { write(raw) { framed += raw; }, end() { process.nextTick(() => {
      try {
        const user = runtime === 'claude' ? JSON.parse(framed.trimEnd()) : null;
        const input = runtime === 'claude' ? user.message.content : framed.replace(/\n$/, '');
        const payload = payloadFor(input, worktree), result = answer(payload, runtime);
        const session = runtime === 'claude' ? args[args.indexOf('--session-id') + 1] : crypto.randomUUID();
        const launch = { input, payload, result, session, args };
        launches.push(launch);
        controls.onLaunch?.(launch, launches);
        controls.result?.(result, payload, launch);
        const text = JSON.stringify(result); launch.text = text;
        let rows, stream;
        if (runtime === 'codex') {
          const manifest = JSON.parse(fs.readFileSync(agentManifest));
          const agentFile = manifest.agent_files.find(file => {
            const content = fs.readFileSync(path.join(agentDir, file), 'utf8');
            return args.includes(/^model = "(.+)"$/m.exec(content)?.[1])
              && args.includes('model_reasoning_effort=' + JSON.stringify(/^model_reasoning_effort = "(.+)"$/m.exec(content)?.[1]));
          });
          assert.ok(agentFile, 'physical arguments must select an installed native template');
          const agentText = fs.readFileSync(path.join(agentDir, agentFile), 'utf8');
          const model = /^model = "(.+)"$/m.exec(agentText)[1], effort = /^model_reasoning_effort = "(.+)"$/m.exec(agentText)[1];
          launch.selection = { agent_file: agentFile, model, reasoning_effort: effort };
          const meta = template(nativeRows, row => row.type === 'session_meta');
          Object.assign(meta.payload, { id: session, session_id: session, cwd: worktree, runtime_workspace_roots: [worktree] });
          const context = template(nativeRows, row => row.type === 'turn_context');
          Object.assign(context.payload, { model, effort, cwd: worktree, workspace_roots: [worktree] });
          context.payload.sandbox_policy.type = 'read-only';
          Object.assign(context.payload.collaboration_mode.settings, { model, reasoning_effort: effort });
          const start = template(nativeRows, row => row.payload?.type === 'task_started');
          context.payload.turn_id = start.payload.turn_id;
          const developer = template(nativeRows, row => row.payload?.role === 'developer');
          developer.payload.content = [{ type: 'input_text', text: require(path.join(scripts, 'codex-runtime-host.cjs')).generatedInstructions(agentText) }];
          const request = template(nativeRows, row => row.payload?.role === 'user');
          request.payload.content = [{ type: 'input_text', text: input }];
          const final = template(nativeRows, row => row.payload?.phase === 'final_answer');
          final.payload.content.forEach(block => { block.text = text; });
          final.payload.internal_chat_message_metadata_passthrough.turn_id = start.payload.turn_id;
          const complete = template(nativeRows, row => row.payload?.type === 'task_complete');
          Object.assign(complete.payload, { turn_id: start.payload.turn_id, last_agent_message: text });
          rows = [meta, context, start, developer, request, template(nativeRows, row => row.payload?.type === 'token_count'), final, complete];
          const now = new Date(), directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true });
          launch.nativePath = path.join(directory, session + '.jsonl');
          stream = ['thread.started', 'turn.started', 'item.completed', 'turn.completed'].map(type => template(cli, row => row.type === type));
          stream[0].thread_id = session; stream[2].item.text = text;
        } else {
          const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
          const init = template(nativeRows, row => row.type === 'system' && row.subtype === 'init');
          Object.assign(init, { session_id: session, model, cwd: worktree });
          const assistant = template(nativeRows, row => row.type === 'assistant');
          Object.assign(assistant, { session_id: session, sessionId: session, effort });
          assistant.message.model = model; delete assistant.message.usage;
          assistant.message.content = [{ type: 'tool_use', id: 'structured-' + session, name: 'StructuredOutput', input: result }];
          const final = template(nativeRows, row => row.type === 'result');
          Object.assign(final, { session_id: session, subtype: 'success', is_error: false, structured_output: result, result: text });
          delete final.modelUsage;
          rows = [{ ...user, sessionId: session }, assistant];
          launch.nativePath = path.join(storageRoot, 'native/project', session + '.jsonl');
          fs.mkdirSync(path.dirname(launch.nativePath), { recursive: true });
          stream = [init, assistant, final];
        }
        controls.native?.(rows, payload, launch);
        fs.writeFileSync(launch.nativePath, serialize(rows));
        if (runtime === 'claude') {
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
          const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
          require(path.join(scripts, 'claude-agent-start-hook.cjs')).capture({ hook_event_name: 'SessionStart',
            source: 'startup', session_id: session, transcript_path: launch.nativePath, cwd: worktree }, {
            evidenceFile: hookArgs[hookArgs.indexOf('--evidence-file') + 1], expectedSession: session });
        }
        controls.afterNative?.(launch);
        child.stdout.emit('data', Buffer.from(serialize(stream))); child.emit('close', 0, null);
      } catch (error) { child.emit('error', error); }
    }); } };
    return child;
  };
  return { launches, spawn, runtimeVersion, createRuntimeHost(input) {
    return require(path.join(scripts, 'claude-runtime-host.cjs')).createClaudeRuntimeHost({ ...input, spawn,
      uuid: () => crypto.randomUUID(), startEvidenceFile: path.join(input.transcriptDir, 'session-start.json'),
      sessionTranscriptRoot: path.join(storageRoot, 'native'),
      probe: { status: 'available', executable: 'claude-fixture', runtime_version: runtimeVersion,
        capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } } });
  } };
}

let originalClaude;
function originalClaudeApis() {
  if (originalClaude) return originalClaude;
  const file = path.join(scripts, 'claude-role-host.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(scripts);
  loaded._compile(fs.readFileSync(file, 'utf8').replace('module.exports = Object.freeze({',
    'module.exports = Object.freeze({ prepareInvocation, makeRuntimeScope, runtimeFor, buildBoundary, revalidateLiveInputs, validateResult, resultFrom, sealResult,'), file);
  return originalClaude = loaded.exports;
}
async function produceHistoricalClaudeReview(options, request) {
  const api = originalClaudeApis();
  const parsed = require(path.join(scripts, 'claude-role-host.cjs')).parseRequest(request);
  assert.equal(parsed.role, 'code-review');
  const { review_contract: _currentContract, ...originalRequest } = parsed;
  let prepared = api.prepareInvocation(options, originalRequest);
  const dispatchId = 'historical-code-review-' + crypto.randomUUID(), ownerId = 'historical-fixture-owner';
  const storage = path.join(options.storageRoot, dispatchId);
  prepared = api.prepareReviewInput(prepared, { runId: dispatchId, dispatchId, storageRoot: storage });
  const scope = api.makeRuntimeScope(prepared, dispatchId, dispatchId, ownerId);
  const inflight = { graphDir: prepared.graph.directory, worktree: prepared.canonical.worktree,
    dispatch_id: dispatchId, pid: process.pid };
  const tracking = require(path.join(scripts, 'dispatch-record.cjs'));
  tracking.recordInflight({ ...inflight, role: 'code-review', host: 'claude', ticket: prepared.ticket });
  try {
    const runtime = api.runtimeFor(options, scope, null, storage, prepared);
    authority.prepareRoleArtifact({ worktreePath: prepared.canonical.worktree, role: 'code-review',
      phase: prepared.phase, evidencePath: prepared.evidencePath });
    const { boundary, getLaunched, getHostOwnedFiles } = api.buildBoundary(prepared, runtime, dispatchId, ownerId, options);
    const record = await boundary.dispatch({ runtime: 'claude', role: 'code-review', signals: prepared.signals, dispatch_id: dispatchId }, {
      ticket: prepared.ticket, subject_kind: 'phase', role: 'code-review', phase: prepared.phase, pr: prepared.pr,
      worktreePath: prepared.canonical.projectRoot, sourceRevision: prepared.canonical.head, contextPacket: prepared.packet });
    api.assertEvidenceOnlyChanges(options, prepared, getHostOwnedFiles());
    api.revalidateLiveInputs(options, prepared, dispatchId);
    const { evidence_markdown, ...result } = api.validateResult(prepared, api.resultFrom(getLaunched().output));
    const { validated } = api.sealResult(prepared, result, runtime.recorder, dispatchId, evidence_markdown);
    assert.equal(result.review_contract, 'shipyard.phase-code-review.v1');
    return { schema: 'shipyard.claude-role-result.v1', role: 'code-review', subject: prepared.ticket, pr: prepared.pr,
      result, dispatch: record, artifact: { ref: validated.artifact_ref, digest: validated.artifact_digest, outcome: validated.envelope.outcome },
      context: { model: record.applied_model, effort: record.applied_effort } };
  } finally { tracking.clearInflight(inflight); }
}
function codeReviewFixtures() {
  const file = path.join(root, 'tests/unit/phase53-code-review.test.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8').split("for (const runtime of ['codex', 'claude']) {")[0]
    + '\nmodule.exports = { codex, fixture, setup, current };', file);
  return loaded.exports;
}
function historicalClaudeHost(options) {
  return { run: request => produceHistoricalClaudeReview(options, request) };
}
function semanticClaudeOptions(fixture, options, controls = {}) {
  const driver = semanticNativeDriver({ runtime: 'claude', worktree: fixture.root, storageRoot: fixture.storageRoot,
    controls: { onLaunch(launch) {
      const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
      controls.onLaunch?.(launch.input, { readOnly: settings.sandbox.filesystem.allowWrite.length === 0
        && launch.args[launch.args.indexOf('--tools') + 1] === 'Read,Glob,Grep',
        schema: JSON.parse(launch.args[launch.args.indexOf('--json-schema') + 1]) }, launch.payload);
    }, result: controls.mutateResult },
  });
  return { ...options, createRuntimeHost: driver.createRuntimeHost };
}
module.exports = { semanticNativeDriver, produceHistoricalClaudeReview, registered, template,
  codeReviewFixtures, historicalClaudeHost, semanticClaudeOptions };
