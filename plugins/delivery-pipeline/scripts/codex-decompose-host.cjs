#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCodexRuntimeHost, installedGsdAgent, normalizeScope, parseCodexStream, verifyCompletedNativeLaunch,
} = require('./codex-runtime-host.cjs');
const { launchAgent, selectAgent } = require('./codex-agent.cjs');
const { createCodexDispatchAdapter } = require('./codex-dispatch-adapter.cjs');
const policy = require('./model-policy.cjs');
const { newDispatchId, createDispatchBoundary, createDurableRecorder } = require('./dispatch-boundary.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { createRunController, DEFAULT_LEASE_TTL_MS } = require('./run-controller.cjs');
const { formatHint } = require('./refusal-hints.cjs');
const { sealDecomposition, assertContained, captureContainmentBaseline } = require('./planning-result-sealer.cjs');
const { createPlanningWriterLease, sharedPlanningWriterRoot, legacyPlanningWriterRoots,
  assertNoLegacyPlanningWriter, captureSealManifest, assertSealManifest } = require('./planning-writer-lease.cjs');
const orchestrationOverhead = require('./orchestration-overhead.cjs');

const SCHEMA = 'shipyard.codex-decompose-host.v1';
const LAUNCH_SCHEMA = 'shipyard.codex-decompose-launch.v1';
const OUTPUT_SCHEMA = 'shipyard.codex-decompose-output.v1';
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const ROLES = Object.freeze({
  'gsd-phase-researcher': Object.freeze({ role: 'research', sandbox: 'workspace-write' }),
  'gsd-planner': Object.freeze({ role: 'decomposition', sandbox: 'workspace-write' }),
  'gsd-plan-checker': Object.freeze({ role: 'decomposition', sandbox: 'read-only' }),
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  const error = new Error('codex-decompose-host: ' + message);
  error.code = code;
  throw error;
}

function requestValue(input) {
  if (!object(input)) fail('INVALID_INPUT', 'request must be an object');
  for (const key of Object.keys(input)) {
    if (!['gsd_role', 'prompt', 'signals', 'dispatch_id'].includes(key)) {
      fail('INVALID_INPUT', 'unsupported request field ' + key);
    }
  }
  if (!Object.hasOwn(ROLES, input.gsd_role)) fail('UNSUPPORTED_ROLE', 'unsupported typed GSD role');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) fail('INVALID_INPUT', 'prompt is required');
  if (input.signals !== undefined && !object(input.signals)) fail('INVALID_INPUT', 'signals must be an object');
  if (input.dispatch_id !== undefined
      && (typeof input.dispatch_id !== 'string' || !input.dispatch_id.trim())) {
    fail('INVALID_INPUT', 'dispatch_id must be non-empty text');
  }
  return Object.freeze({
    gsd_role: input.gsd_role,
    prompt: input.prompt,
    signals: policy.normalizeSignals(input.signals || {}),
    ...(input.dispatch_id === undefined ? {} : { dispatch_id: input.dispatch_id }),
  });
}

function researchInstructions(content) {
  if (typeof content !== 'string') fail('STALE_GENERATED_AGENT', 'research handoff is missing');
  const field = content.match(/(?:^|\n)developer_instructions\s*=\s*([\s\S]*)$/);
  if (!field) fail('STALE_GENERATED_AGENT', 'research handoff has no instructions');
  const literal = field[1].match(/^'''\r?\n([\s\S]*?)\r?\n'''\s*$/);
  let instructions;
  if (literal) instructions = literal[1];
  else {
    try { instructions = JSON.parse(field[1].trim()); }
    catch (_) { fail('STALE_GENERATED_AGENT', 'research instructions are invalid'); }
  }
  if (typeof instructions !== 'string' || !instructions.trim()) {
    fail('STALE_GENERATED_AGENT', 'research handoff has no instructions');
  }
  return instructions.trim();
}

function defaultRunStoreDir(scope, stateRoot = path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex-decompose')) {
  const worktree = fs.realpathSync(scope.worktree);
  let root = path.resolve(stateRoot);
  const missing = [];
  while (!fs.existsSync(root)) {
    missing.unshift(path.basename(root));
    const parent = path.dirname(root);
    if (parent === root) fail('INVALID_STATE_DIR', 'run controller state root cannot be resolved');
    root = parent;
  }
  root = path.join(fs.realpathSync(root), ...missing);
  const relative = path.relative(worktree, root);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    fail('INVALID_STATE_DIR', 'run controller state must be outside the model worktree');
  }
  const key = crypto.createHash('sha256').update(worktree).digest('hex');
  return path.join(root, key, 'runs');
}

function phaseDirectory(worktree, phase) {
  const root = path.join(fs.realpathSync(worktree), '.planning', 'phases');
  let names;
  try { names = fs.readdirSync(root); }
  catch (error) { fail('PHASE_DIRECTORY_MISSING', 'phase directory root is unavailable: ' + error.message); }
  if (fs.realpathSync(root) !== root) fail('PHASE_DIRECTORY_MISSING', 'phase directory root is not canonical');
  const matches = names.filter((name) => /^\d+-/.test(name) && Number(name.split('-')[0]) === Number(phase)
    && fs.lstatSync(path.join(root, name)).isDirectory());
  if (matches.length !== 1) {
    fail('PHASE_DIRECTORY_MISSING', 'expected exactly one phase directory for phase ' + phase + ', found ' + matches.length);
  }
  const directory = path.join(root, matches[0]);
  if (fs.realpathSync(directory) !== directory) fail('PHASE_DIRECTORY_MISSING', 'phase directory is not canonical');
  return directory;
}

function researchArtifact(worktree, phase) {
  const directory = phaseDirectory(worktree, phase);
  return path.join(directory, path.basename(directory).split('-')[0] + '-RESEARCH.md');
}

function sourceRevision(worktree) {
  try {
    return execFileSync('git', ['-C', worktree, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  } catch (error) {
    fail('SOURCE_REVISION_UNAVAILABLE', 'worktree HEAD cannot be resolved: ' + String(error.stderr || error.message).trim());
  }
}

function sealScope(scope, output, summary) {
  const repository = typeof scope.repository === 'string' ? scope.repository
    : object(scope.repository) ? scope.repository.repository_id || scope.repository.id : fs.realpathSync(scope.worktree);
  const result = object(output.result) ? output.result : {};
  return {
    worktree: scope.worktree,
    subject: 'phase=' + scope.phase + ';repository=' + repository,
    sourceRevision: sourceRevision(scope.worktree),
    repository,
    policyHash: output.receipt.policy_hash,
    status: result.status === 'blocked' ? 'blocked' : 'completed',
    summary: typeof result.summary === 'string' ? result.summary : summary,
  };
}

function assertNoForeignEdit(leaseCtx, scope, directory, declaredAbsolutePaths) {
  if (!leaseCtx) return;
  leaseCtx.writerLease.assertFence({ token: leaseCtx.token, epoch: leaseCtx.epoch, base_revision: sourceRevision(scope.worktree) });
  const declared = new Set(declaredAbsolutePaths.map((full) => path.relative(directory, full).split(path.sep).join('/')));
  const { changed, lease } = leaseCtx.writerLease.changedSince(leaseCtx.snapshot);
  const foreign = changed.filter((relPath) => !declared.has(relPath));
  if (foreign.length) {
    fail('FOREIGN_EDIT', "phase directory path(s) changed outside this run's own paths: " + foreign.join(', ')
      + ' (lease owner ' + lease.owner + ', epoch ' + lease.epoch + ')');
  }
}

function sealResearchArtifact(scope, root, output, leaseCtx) {
  const artifact = researchArtifact(scope.worktree, scope.phase);
  assertContained({ worktree: scope.worktree, allowed: [path.relative(scope.worktree, artifact)],
    baseline: leaseCtx?.containmentBaseline });
  let stat;
  try { stat = fs.lstatSync(artifact); }
  catch (_) { fail('MISSING_ARTIFACT', 'phase research artifact is missing: ' + artifact); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('MISSING_ARTIFACT', 'phase research artifact is not a regular file: ' + artifact);
  assertNoForeignEdit(leaseCtx, scope, phaseDirectory(scope.worktree, scope.phase), [artifact]);
  const sealed = sealDecomposition({
    root: path.join(root, 'research-index'),
    scope: sealScope(scope, output, 'researched phase ' + scope.phase),
    plans: [artifact],
  });
  return Object.freeze({
    schema: 'shipyard.research-result.v1', version: 1, role: 'research',
    subject: sealed.subject, source_revision: sealed.source_revision, repository: sealed.repository,
    policy_hash: sealed.policy_hash, status: sealed.status, summary: sealed.summary,
    artifact_path: artifact, artifact_index: sealed.artifact_index, evidence_index: sealed.evidence_index,
    receipt: output.receipt,
  });
}

function sealPlans(scope, root, output, leaseCtx) {
  const directory = phaseDirectory(scope.worktree, scope.phase);
  const names = fs.readdirSync(directory).filter((name) => new RegExp(`^0*${scope.phase}-[0-9]+-PLAN\\.md$`).test(name)).sort();
  if (!names.length) fail('MISSING_ARTIFACT', 'no materialized PLAN.md files were found in ' + directory);
  const plans = [...(fs.existsSync(path.join(directory, 'CONTEXT.md')) ? ['CONTEXT.md'] : []), ...names]
    .map((name) => path.join(directory, name));
  assertContained({ worktree: scope.worktree,
    allowed: leaseCtx?.containmentBaseline === undefined ? [path.relative(scope.worktree, directory)]
      : plans.map((file) => path.relative(scope.worktree, file)),
    baseline: leaseCtx?.containmentBaseline });
  assertNoForeignEdit(leaseCtx, scope, directory, plans);
  return sealDecomposition({
    root: path.join(root, 'decomposition-index'),
    scope: sealScope(scope, output, 'materialized plans for phase ' + scope.phase),
    plans,
    extra: { receipt: output.receipt },
  });
}

function launchFile(directory, dispatchId) {
  return path.join(directory, crypto.createHash('sha256').update(String(dispatchId)).digest('hex') + '.launch.json');
}

function writeLaunchRecord(directory, record) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = launchFile(directory, record.dispatch_id);
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: LAUNCH_SCHEMA, version: 1, ...record }) + '\n', { mode: 0o600 });
    const handle = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    const directoryHandle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
  return file;
}

function readLaunchRecord(directory, dispatchId) {
  const file = launchFile(directory, dispatchId);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (_) { fail('RECOVERY_EVIDENCE_MISSING', 'no launch record exists for dispatch ' + dispatchId); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > MAX_ARGS_BYTES) {
    fail('RECOVERY_EVIDENCE_MISSING', 'launch record is not a private bounded file');
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail('RECOVERY_EVIDENCE_MISSING', 'launch record is not valid JSON'); }
  if (!object(record) || record.schema !== LAUNCH_SCHEMA || record.dispatch_id !== dispatchId
      || !object(record.tree_snapshot) || !object(record.tree_snapshot.digests)) {
    fail('RECOVERY_EVIDENCE_MISSING', 'launch record does not belong to dispatch ' + dispatchId);
  }
  return record;
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (_) { return null; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (object(value)) {
    return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scopeIdentity(scope) {
  const identity = {};
  for (const key of ['run_id', 'ticket', 'phase', 'worktree', 'runtime', 'provider', 'repository']) {
    if (scope[key] !== undefined) identity[key] = scope[key];
  }
  return identity;
}

function launchBinding(scope, request, dispatchId, resolution, agent, generatedAgent) {
  const identity = scopeIdentity(scope);
  return Object.freeze({
    scope: identity,
    request_sha256: sha256Text(canonicalJson({
      scope: identity,
      request: {
        dispatch_id: dispatchId,
        gsd_role: request.gsd_role,
        prompt: request.prompt,
        signals: request.signals,
      },
    })),
    dispatch_id: dispatchId,
    gsd_role: request.gsd_role,
    role: resolution.role,
    model: resolution.model,
    effort: resolution.effort,
    policy_version: resolution.policy_version,
    policy_hash: resolution.policy_hash,
    rung: resolution.rung,
    agent: {
      file: agent.file,
      sha256: agent.sha256,
      instructions_sha256: agent.instructions_sha256,
    },
    ...(generatedAgent ? {
      generated_agent: { file: generatedAgent.file, sha256: generatedAgent.sha256 },
    } : {}),
  });
}

function validTaskRelay(value) {
  return object(value) && typeof value.path === 'string' && path.isAbsolute(value.path)
    && path.normalize(value.path) === value.path && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && /^[a-f0-9]{64}$/.test(value.sha256 || '');
}

function completionInstructions(prompt, gsdRole) {
  const artifactRule = gsdRole === 'gsd-plan-checker'
    ? 'Use an empty artifact_paths array.'
    : 'List every worktree-relative file you created or changed inside the current phase directory.';
  return prompt + '\n\nShipyard recovery completion format: finish with exactly one JSON object as your final message, '
    + 'using schema "' + OUTPUT_SCHEMA + '" and an artifact_paths array. ' + artifactRule;
}

function declaredArtifactPaths(message, scope, gsdRole, code = 'RECOVERY_EVIDENCE_INCOMPLETE') {
  let output;
  try { output = JSON.parse(message); }
  catch (_) { fail(code, 'authenticated child completion does not contain the required artifact declaration'); }
  if (!object(output) || output.schema !== OUTPUT_SCHEMA || !Array.isArray(output.artifact_paths)
      || output.artifact_paths.length > 256) {
    fail(code, 'authenticated child completion has an invalid artifact declaration');
  }
  const directory = phaseDirectory(scope.worktree, scope.phase);
  const declared = output.artifact_paths.map((value) => {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
        || path.posix.normalize(value) !== value || value.split('/').includes('..')) {
      fail(code, 'authenticated child declared an invalid artifact path');
    }
    const full = path.resolve(scope.worktree, ...value.split('/'));
    const relativeToWorktree = path.relative(scope.worktree, full);
    const relativeToPhase = path.relative(directory, full);
    if (!relativeToWorktree || relativeToWorktree.startsWith('..') || path.isAbsolute(relativeToWorktree)
        || relativeToPhase.startsWith('..') || path.isAbsolute(relativeToPhase)) {
      fail(code, 'authenticated child declared an artifact outside the current phase directory');
    }
    const phaseRelative = relativeToPhase.split(path.sep).join('/');
    if (gsdRole === 'gsd-planner' && phaseRelative !== 'CONTEXT.md' && !/^\d+-\d+-PLAN\.md$/.test(phaseRelative)) {
      fail(code, 'planner declared a path that the decomposition sealer will not seal');
    }
    return phaseRelative;
  }).sort();
  if (new Set(declared).size !== declared.length) fail(code, 'authenticated child declared duplicate artifact paths');
  if (gsdRole === 'gsd-phase-researcher') {
    const expected = path.relative(directory, researchArtifact(scope.worktree, scope.phase)).split(path.sep).join('/');
    if (declared.length > 1 || (declared.length === 1 && declared[0] !== expected)) {
      fail(code, 'researcher may declare only the phase research artifact it wrote');
    }
  }
  if (gsdRole === 'gsd-plan-checker' && declared.length !== 0) {
    fail(code, 'read-only plan checker cannot declare modified artifacts');
  }
  return declared;
}

function artifactDigests(scope, writerLease, snapshot, declared, code, containmentBaseline) {
  const changed = writerLease.changedSince(snapshot).changed;
  if (changed.length !== declared.length || changed.some((relPath, index) => relPath !== declared[index])) {
    fail(code, 'planning tree delta differs from the authenticated child artifact declaration');
  }
  const directory = phaseDirectory(scope.worktree, scope.phase);
  try {
    assertContained({ worktree: scope.worktree,
      allowed: containmentBaseline === undefined ? [path.relative(scope.worktree, directory)]
        : declared.map((relative) => path.relative(scope.worktree, path.join(directory, relative))),
      baseline: containmentBaseline });
  } catch (error) {
    fail(code, 'planning tree containment refused: ' + error.message);
  }
  let worktreeReal;
  let directoryReal;
  try {
    worktreeReal = fs.realpathSync(scope.worktree);
    directoryReal = fs.realpathSync(directory);
  } catch (_) {
    fail(code, 'planning phase directory does not resolve within the current worktree');
  }
  const directoryFromWorktree = path.relative(worktreeReal, directoryReal);
  if (directoryFromWorktree === '..' || directoryFromWorktree.startsWith('..' + path.sep)
      || path.isAbsolute(directoryFromWorktree)) {
    fail(code, 'planning phase directory resolves outside the current worktree');
  }
  const digests = {};
  for (const relative of declared) {
    const full = path.join(directory, ...relative.split('/'));
    let stat;
    try { stat = fs.lstatSync(full); }
    catch (_) { fail(code, 'declared artifact is missing: ' + relative); }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(code, 'declared artifact is not a regular file: ' + relative);
    let real;
    try {
      real = fs.realpathSync(full);
    } catch (_) { fail(code, 'declared artifact cannot be resolved within the current worktree: ' + relative); }
    const artifactFromWorktree = path.relative(worktreeReal, real);
    const artifactFromDirectory = path.relative(directoryReal, real);
    if (artifactFromWorktree === '..' || artifactFromWorktree.startsWith('..' + path.sep)
        || path.isAbsolute(artifactFromWorktree)
        || artifactFromDirectory === '..' || artifactFromDirectory.startsWith('..' + path.sep)
        || path.isAbsolute(artifactFromDirectory)) {
      fail(code, 'declared artifact resolves outside the current worktree phase: ' + relative);
    }
    const digest = sha256File(full);
    if (!digest) fail(code, 'declared artifact cannot be digested: ' + relative);
    digests[relative] = digest;
  }
  return digests;
}

function runtimeTranscriptPath(directory, scope, sessionId) {
  const safeRun = scope.run_id.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.resolve(directory), safeRun + '-' + safeSession + '.jsonl');
}

function verifyRuntimeEvidence(record, scope, binding, transcriptDir) {
  const completed = record.completed;
  const started = record.session_started;
  const evidence = completed && completed.runtime_evidence;
  const sessionId = started && started.session_id;
  const runtimeLaunch = started && started.runtime_launch;
  if (object(evidence) && object(evidence.native_child_evidence) && validTaskRelay(runtimeLaunch && runtimeLaunch.task_relay)
      && canonicalJson(evidence.native_child_evidence.task_relay) !== canonicalJson(runtimeLaunch.task_relay)) {
    fail('RECOVERY_ARTIFACT_ALTERED', 'completed task relay differs from the bound session-start task file');
  }
  if (!object(completed) || !object(evidence) || !object(runtimeLaunch) || !sessionId
      || completed.parent_session_id !== sessionId || evidence.session_id !== sessionId
      || evidence.run_id !== scope.run_id || evidence.ticket !== scope.ticket || evidence.phase !== scope.phase
      || evidence.worktree !== scope.worktree || evidence.dispatch_id !== binding.dispatch_id
      || evidence.runtime !== 'codex' || evidence.provider !== 'openai'
      || evidence.applied_model !== binding.model || evidence.observed_model !== binding.model
      || evidence.applied_effort !== binding.effort || evidence.observed_effort !== binding.effort
      || runtimeLaunch.run_id !== scope.run_id || runtimeLaunch.ticket !== scope.ticket
      || runtimeLaunch.phase !== scope.phase || runtimeLaunch.worktree !== scope.worktree
      || runtimeLaunch.dispatch_id !== binding.dispatch_id || runtimeLaunch.gsd_role !== binding.gsd_role
      || runtimeLaunch.applied_model !== binding.model || runtimeLaunch.applied_effort !== binding.effort
      || runtimeLaunch.observed_model !== binding.model || runtimeLaunch.observed_effort !== binding.effort
      || runtimeLaunch.agent_file !== binding.agent.file
      || runtimeLaunch.agent_file_digest !== binding.agent.sha256
      || runtimeLaunch.agent_instructions_digest !== binding.agent.instructions_sha256
      || completed.launch_id !== 'codex-' + sessionId
      || !/^[a-f0-9]{64}$/.test(completed.completion_message_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(runtimeLaunch.command_digest || '')
      || evidence.command_digest !== runtimeLaunch.command_digest
      || canonicalJson(evidence.command) !== canonicalJson(runtimeLaunch.command)
      || canonicalJson(evidence.sandbox_evidence) !== canonicalJson(runtimeLaunch.sandbox_evidence)
      || evidence.selection_source !== runtimeLaunch.selection_source
      || completed.pid !== started.process_id
      || typeof completed.parent_wait_timed_out !== 'boolean'
      || !object(evidence.native_session_evidence) || !object(evidence.native_child_evidence)
      || !validTaskRelay(runtimeLaunch.task_relay)
      || !validTaskRelay(evidence.native_child_evidence.task_relay)
      || evidence.native_session_evidence.session_id !== sessionId
      || evidence.native_child_evidence.parent_thread_id !== sessionId
      || evidence.native_child_evidence.agent_role !== binding.gsd_role
      || evidence.native_child_evidence.agent_file_digest !== binding.agent.sha256
      || !object(evidence.stream_evidence) || evidence.stream_evidence.format !== 'jsonl'
      || !Number.isSafeInteger(evidence.stream_evidence.records) || evidence.stream_evidence.records < 1
      || !Number.isSafeInteger(evidence.stream_evidence.turns) || evidence.stream_evidence.turns < 1
      || !object(evidence.transcript) || !Number.isSafeInteger(evidence.transcript.bytes)
      || evidence.transcript.bytes < 1 || !/^[a-f0-9]{64}$/.test(evidence.transcript.sha256 || '')
      || (completed.transcript_saved !== undefined && typeof completed.transcript_saved !== 'boolean')) {
    fail('RECOVERY_EVIDENCE_INCOMPLETE', 'completed runtime evidence does not bind the original scope and selection');
  }
  const expectedTranscript = runtimeTranscriptPath(transcriptDir, scope, sessionId);
  if (path.resolve(evidence.transcript.path || '') !== expectedTranscript) {
    fail('RECOVERY_EVIDENCE_MISSING', 'the host transcript path does not match this dispatch session');
  }
  let stat = null;
  try { stat = fs.lstatSync(expectedTranscript); }
  catch (error) {
    if (!error || error.code !== 'ENOENT' || completed.transcript_saved !== false) {
      fail('RECOVERY_EVIDENCE_MISSING', 'the host transcript is missing for the completed launch');
    }
  }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)) {
    fail('RECOVERY_EVIDENCE_MISSING', 'the host transcript is not a private regular file');
  }
  if (completed.parent_sha256 !== evidence.native_session_evidence.sha256
      || completed.child_sha256 !== evidence.native_child_evidence.sha256
      || completed.child_session_id !== evidence.native_child_evidence.session_id) {
    fail('RECOVERY_ARTIFACT_ALTERED', 'completed runtime evidence does not match the native transcripts');
  }
  if (!stat) return;
  const raw = fs.readFileSync(expectedTranscript, 'utf8');
  const digest = sha256Text(raw);
  if (stat.size !== evidence.transcript.bytes || digest !== evidence.transcript.sha256) {
    fail('RECOVERY_ARTIFACT_ALTERED', 'the host transcript differs from its completed launch digest');
  }
  let stream;
  try { stream = parseCodexStream(raw); }
  catch (error) { fail('RECOVERY_EVIDENCE_INCOMPLETE', 'the host transcript cannot be re-verified: ' + error.message); }
  if (stream.session_id !== sessionId || stream.records.length !== evidence.stream_evidence.records
      || stream.turns !== evidence.stream_evidence.turns
      || stream.usage_records !== evidence.stream_evidence.usage_records) {
    fail('RECOVERY_ARTIFACT_ALTERED', 'completed runtime evidence does not match the host transcript');
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || error.code !== 'ESRCH'; }
}

function recoverAgent(role, options) {
  const selection = selectAgent(role, {
    cwd: options.cwd, flags: new Map(), signals: options.signals, dispatch_id: options.dispatch_id,
    capabilities: options.capabilities, agentDir: options.agentDir, agentManifest: options.agentManifest,
    env: options.env,
  });
  const adapter = createCodexDispatchAdapter({
    agentsDir: path.resolve(options.agentDir || path.join(options.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents')),
    agentManifest: options.agentManifest,
    capabilities: options.capabilities,
    host: options.host,
  });
  const boundary = createDispatchBoundary({
    adapters: { codex: adapter }, recorder: options.recorder, requireGsdRole: true, recoverReserved: true,
  });
  return boundary.dispatch({
    runtime: 'codex', role: selection.role, signals: options.signals || {},
    dispatch_id: selection.dispatch_id, model: selection.model, effort: selection.effort,
    gsd_role: options.gsd_role,
  }, options.context);
}

function createCodexDecomposeHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  if (!path.isAbsolute(scope.worktree)) fail('INVALID_INPUT', 'worktree path must be absolute');
  let stat;
  try { stat = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!stat.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
  const env = options.env || process.env;
  const sealRoot = options.sealRoot || path.join(path.dirname(defaultRunStoreDir(scope)), 'sealed');
  const runtimeHost = options.host || createCodexRuntimeHost({
    scope,
    controller: options.controller,
    capabilities: options.capabilities,
    capabilitiesFile: options.capabilitiesFile,
    executable: options.executable,
    probe: options.probe,
    recorder: options.recorder,
    recorderDir: options.recorderDir,
    transcriptDir: options.transcriptDir,
    env,
    spawn: options.spawn,
  });
  if (!runtimeHost || !object(runtimeHost.capabilities) || !runtimeHost.recorder
      || typeof runtimeHost.launchTypedGsd !== 'function' || !object(runtimeHost.scope)) {
    fail('MISSING_ADAPTER', 'scoped Codex runtime host lacks typed launch, capabilities, or durable recorder');
  }
  for (const field of ['run_id', 'ticket', 'phase', 'worktree', 'runtime', 'provider']) {
    if (runtimeHost.scope[field] !== scope[field]) fail('SCOPE_MISMATCH', 'runtime host scope differs at ' + field);
  }

  return Object.freeze({
    schema: SCHEMA,
    version: 1,
    scope,
    async run(rawRequest, runOptions = {}) {
      const request = requestValue(rawRequest);
      const recovering = object(runOptions.recovered);
      const suppliedLease = recovering ? runOptions.lease : options.lease;
      const leaseCtx = suppliedLease ? Object.freeze({ ...suppliedLease }) : null;
          const chosen = ROLES[request.gsd_role];
          const agent = installedGsdAgent(request.gsd_role, env);
          let launched = false;
          const host = Object.freeze({
        ...runtimeHost,
        async launchTypedGsd(selection, context) {
          if (launched) fail('DUPLICATE_LAUNCH', 'typed callback may launch only once');
          launched = true;
            if (context.gsd_role !== request.gsd_role || context.gsd_launch_mechanism !== 'typed-gsd-callback') {
              fail('SCOPE_MISMATCH', 'typed callback role differs from the requested GSD role');
            }
            const resolution = policy.resolveDispatch({
              runtime: 'codex', role: chosen.role, signals: request.signals, dispatch_id: context.dispatch_id,
            });
            let prompt = context.prompt;
          let selected = {
            model: selection.model,
            reasoning_effort: selection.reasoning_effort,
            sandbox_mode: chosen.sandbox,
          };
          if (chosen.role === 'research') {
            if (selection.agent_file !== resolution.agent_file
                || selection.agent_file_digest !== crypto.createHash('sha256')
                  .update(selection.agent_file_content || '').digest('hex')) {
              fail('STALE_GENERATED_AGENT', 'research handoff digest changed');
            }
            prompt = researchInstructions(selection.agent_file_content) + '\n\n' + prompt;
          }
          const generatedAgent = chosen.role === 'research'
            ? { file: selection.agent_file, sha256: selection.agent_file_digest } : null;
          const binding = launchBinding(scope, request, context.dispatch_id, resolution, agent, generatedAgent);
          if (recovering && canonicalJson(binding) !== canonicalJson(runOptions.recovered.binding)) {
            fail('RECOVERY_EVIDENCE_INCOMPLETE', 'recovery generated agent selection differs from the original launch');
          }
          const reservation = options.launchDir && leaseCtx && !recovering
            && typeof runtimeHost.recorder.getReservation === 'function'
            ? runtimeHost.recorder.getReservation(context.dispatch_id) : null;
          if (options.launchDir && leaseCtx && !recovering) {
            if (!reservation || typeof reservation.reserved_at !== 'string' || !reservation.reserved_at.trim()) {
              fail('RECOVERY_NO_RESERVATION', 'typed launch has no durable reservation to bind');
            }
            if (reservation.recorded) fail('RECOVERY_ALREADY_RECORDED', 'typed launch reservation is already recorded');
          }
          const launchRecord = options.launchDir && leaseCtx && !recovering ? {
            dispatch_id: context.dispatch_id,
            gsd_role: request.gsd_role,
            binding,
            reservation: { dispatch_id: reservation.dispatch_id, reserved_at: reservation.reserved_at },
            lease_epoch: leaseCtx.epoch,
            writer_lease_file: leaseCtx.writerLease.file,
            tree_snapshot: leaseCtx.snapshot,
            launched_at: new Date().toISOString(),
          } : null;
          if (launchRecord) writeLaunchRecord(options.launchDir, launchRecord);
          const captureProcessSpawned = launchRecord ? (pid) => {
            if (!Number.isSafeInteger(pid) || pid <= 0) {
              fail('RUNTIME_EVIDENCE_MISSING', 'native process has no positive original pid');
            }
            writeLaunchRecord(options.launchDir, { ...launchRecord, process_spawned: { pid } });
          } : undefined;
          let startedSession = null;
          const captureSessionStarted = launchRecord ? (started) => {
            const runtimeLaunch = started && started.runtime_launch;
            if (!object(started) || typeof started.session_id !== 'string' || !started.session_id
                || !Number.isSafeInteger(started.process_id) || started.process_id <= 0
                || readLaunchRecord(options.launchDir, context.dispatch_id).process_spawned?.pid !== started.process_id
                || !object(runtimeLaunch) || runtimeLaunch.run_id !== scope.run_id
                || runtimeLaunch.ticket !== scope.ticket || runtimeLaunch.phase !== scope.phase
                || runtimeLaunch.worktree !== scope.worktree
                || runtimeLaunch.dispatch_id !== context.dispatch_id
                || runtimeLaunch.gsd_role !== request.gsd_role
                || runtimeLaunch.applied_model !== binding.model || runtimeLaunch.applied_effort !== binding.effort
                || runtimeLaunch.agent_file !== agent.file || runtimeLaunch.agent_file_digest !== agent.sha256
                || !validTaskRelay(runtimeLaunch.task_relay)) {
              fail('RUNTIME_EVIDENCE_MISMATCH', 'native session start does not bind the original typed launch');
            }
            if (startedSession && (startedSession.session_id !== started.session_id
                || startedSession.process_id !== started.process_id)) {
              fail('RUNTIME_EVIDENCE_INVALID', 'native session start reported conflicting identities');
            }
            startedSession = { session_id: started.session_id, process_id: started.process_id, runtime_launch: runtimeLaunch };
            writeLaunchRecord(options.launchDir, {
              ...readLaunchRecord(options.launchDir, context.dispatch_id), session_started: startedSession,
            });
          } : undefined;
          const completedRecordFrom = (completed) => {
            const runtimeEvidence = completed && completed.runtime_evidence;
            if (!startedSession || !object(completed) || completed.session_id !== startedSession.session_id
                || !Number.isSafeInteger(completed.process_id) || completed.process_id <= 0
                || completed.process_id !== startedSession.process_id || !object(runtimeEvidence)
                || runtimeEvidence.session_id !== startedSession.session_id
                || runtimeEvidence.run_id !== scope.run_id || runtimeEvidence.ticket !== scope.ticket
                || runtimeEvidence.phase !== scope.phase || runtimeEvidence.worktree !== scope.worktree
                || runtimeEvidence.dispatch_id !== context.dispatch_id
                || runtimeEvidence.command_digest !== startedSession.runtime_launch.command_digest
                || canonicalJson(runtimeEvidence.command) !== canonicalJson(startedSession.runtime_launch.command)
                || canonicalJson(runtimeEvidence.sandbox_evidence) !== canonicalJson(startedSession.runtime_launch.sandbox_evidence)
                || runtimeEvidence.selection_source !== startedSession.runtime_launch.selection_source
                || runtimeEvidence.applied_model !== binding.model || runtimeEvidence.observed_model !== binding.model
                || runtimeEvidence.applied_effort !== binding.effort || runtimeEvidence.observed_effort !== binding.effort
                || !object(runtimeEvidence.native_session_evidence) || !object(runtimeEvidence.native_child_evidence)
                || runtimeEvidence.native_session_evidence.session_id !== startedSession.session_id
                || runtimeEvidence.native_child_evidence.parent_thread_id !== startedSession.session_id
                || runtimeEvidence.native_child_evidence.agent_role !== request.gsd_role
                || runtimeEvidence.native_child_evidence.agent_file_digest !== agent.sha256
                || canonicalJson(runtimeEvidence.native_child_evidence.task_relay)
                  !== canonicalJson(startedSession.runtime_launch.task_relay)
                || typeof completed.last_agent_message !== 'string'
                || !object(completed.spawn_evidence)
                || completed.spawn_evidence.parent_thread_id !== startedSession.session_id
                || typeof completed.spawn_evidence.timed_out !== 'boolean') {
              fail('RUNTIME_EVIDENCE_MISMATCH', 'completed native launch does not match its durable session start');
            }
            const declared = declaredArtifactPaths(completed.last_agent_message, scope, request.gsd_role,
              'ARTIFACT_DECLARATION_INVALID');
            const digests = artifactDigests(scope, leaseCtx.writerLease, leaseCtx.snapshot, declared,
              'ARTIFACT_DECLARATION_INVALID', leaseCtx.containmentBaseline);
            const fullOutputManifest = captureSealManifest({ role: request.gsd_role,
              phaseDir: phaseDirectory(scope.worktree, scope.phase), snapshot: leaseCtx.snapshot,
              declared, changed: Object.keys(digests).sort() });
            const completedRecord = {
              launch_id: completed.launch_id,
              parent_session_id: completed.session_id,
              pid: completed.process_id,
              parent_sha256: runtimeEvidence.native_session_evidence.sha256,
              child_session_id: runtimeEvidence.native_child_evidence.session_id,
              child_sha256: runtimeEvidence.native_child_evidence.sha256,
              completion_message_sha256: sha256Text(completed.last_agent_message),
              parent_wait_timed_out: completed.spawn_evidence.timed_out,
              declared_paths: declared,
              changed_paths: Object.keys(digests).sort(),
              artifact_digests: digests,
              full_output_manifest: fullOutputManifest,
              runtime_evidence: runtimeEvidence,
            };
            return completedRecord;
          };
          const captureNativeCompleted = launchRecord ? (completed) => {
            const completedRecord = completedRecordFrom(completed);
            writeLaunchRecord(options.launchDir, {
              ...readLaunchRecord(options.launchDir, context.dispatch_id),
              session_started: startedSession,
              completed: { ...completedRecord, transcript_saved: false },
            });
          } : undefined;
          const captureTranscriptWritten = launchRecord ? (saved) => {
            const durable = readLaunchRecord(options.launchDir, context.dispatch_id);
            const expected = durable.completed && durable.completed.runtime_evidence
              && durable.completed.runtime_evidence.transcript;
            if (!object(saved) || saved.session_id !== startedSession.session_id
                || !object(saved.transcript) || !object(expected)
                || canonicalJson(saved.transcript) !== canonicalJson(expected)
                || !object(durable.completed) || durable.completed.transcript_saved !== false) {
              fail('RUNTIME_EVIDENCE_MISMATCH', 'saved host transcript does not match pending native completion evidence');
            }
            writeLaunchRecord(options.launchDir, {
              ...durable,
              completed: { ...durable.completed, transcript_saved: true },
            });
          } : undefined;
          const captureCompleted = launchRecord ? (completed) => {
            const completedRecord = completedRecordFrom(completed);
            const durable = readLaunchRecord(options.launchDir, context.dispatch_id);
            if (!object(durable.completed) || durable.completed.transcript_saved !== true) {
              fail('RUNTIME_EVIDENCE_MISSING', 'native completion or transcript evidence was not durable before launch completion');
            }
            const prepared = { ...durable.completed };
            delete prepared.transcript_saved;
            if (canonicalJson(prepared) !== canonicalJson(completedRecord)) {
              fail('RUNTIME_EVIDENCE_MISMATCH', 'saved host transcript does not match the native completion evidence');
            }
          } : undefined;
          const applied = recovering
            ? runOptions.recovered.applied
            : await runtimeHost.launchTypedGsd(selected, {
              ...context,
              prompt: launchRecord ? completionInstructions(prompt, request.gsd_role) : prompt,
              ...(captureProcessSpawned ? { onProcessSpawned: captureProcessSpawned } : {}),
              ...(captureSessionStarted ? { onSessionStarted: captureSessionStarted } : {}),
              ...(captureNativeCompleted ? { onNativeCompleted: captureNativeCompleted } : {}),
              ...(captureTranscriptWritten ? { onTranscriptWritten: captureTranscriptWritten } : {}),
              ...(captureCompleted ? { onCompleted: captureCompleted } : {}),
            });
          const evidence = applied && applied.runtime_evidence;
          if (launchRecord) {
            const durable = readLaunchRecord(options.launchDir, context.dispatch_id);
            if (!durable.completed || durable.completed.launch_id !== applied.launch_id
                || durable.completed.parent_session_id !== applied.session_id
                || durable.completed.transcript_saved !== true) {
              fail('RUNTIME_EVIDENCE_MISSING', 'typed launch completion was not durable before its callback returned');
            }
          }
          if (runtimeHost.requireRuntimeEvidence === true) {
            const child = applied && applied.runtime_evidence && applied.runtime_evidence.native_child_evidence;
            if (!child || child.agent_role !== request.gsd_role || child.agent_file !== agent.file
                || child.agent_file_digest !== agent.sha256
                || child.parent_thread_id !== applied.session_id
                || child.provider !== 'openai') {
              fail('RUNTIME_EVIDENCE_MISMATCH', 'native child does not prove the prevalidated GSD role');
            }
          }
          const current = installedGsdAgent(request.gsd_role, env);
          if (current.file !== agent.file || current.sha256 !== agent.sha256) {
            fail('STALE_GSD_AGENT', 'installed GSD role changed during launch');
          }
          return chosen.role === 'research'
            ? { ...applied, agent_file_digest: selection.agent_file_digest }
            : applied;
        },
      });
      const output = await (recovering ? recoverAgent : launchAgent)(chosen.role, {
        cwd: scope.worktree,
        flags: new Map(),
        signals: request.signals,
        ...(request.dispatch_id ? { dispatch_id: request.dispatch_id } : {}),
        gsd_role: request.gsd_role,
        requireGsdRole: true,
        scope,
        host,
        capabilities: runtimeHost.capabilities,
        recorder: runtimeHost.recorder,
        controller: runtimeHost.controller,
        agentDir: options.agentDir,
        agentManifest: options.agentManifest,
        env,
        context: {
          prompt: request.prompt,
          run_id: scope.run_id,
          ticket: scope.ticket,
          phase: scope.phase,
          worktreePath: scope.worktree,
          runtime: 'codex',
          provider: 'openai',
          sandbox_mode: chosen.sandbox,
          preRecordValidation: ({ dispatch_id: recordedDispatchId }) => {
            if (typeof options.preRecordValidation === 'function') {
              return options.preRecordValidation({ lease: leaseCtx, scope, role: request.gsd_role,
                dispatch_id: recordedDispatchId });
            }
            if (!leaseCtx || !options.launchDir) fail('WRITER_FENCED', 'typed dispatch has no writer lease checkpoint');
            const durable = readLaunchRecord(options.launchDir, recordedDispatchId);
            const completed = durable.completed;
            if (!object(completed) || !object(completed.artifact_digests)
                || !object(completed.full_output_manifest)
                || !Array.isArray(completed.declared_paths) || !Array.isArray(completed.changed_paths)
                || !object(durable.process_spawned)
                || durable.process_spawned.pid !== durable.session_started?.process_id
                || completed.pid !== durable.process_spawned.pid) {
              fail('RECOVERY_EVIDENCE_INCOMPLETE', 'typed dispatch lacks its original process and completion checkpoint');
            }
            const directory = phaseDirectory(scope.worktree, scope.phase);
            const declared = Object.keys(completed.artifact_digests).sort();
            if (canonicalJson(declared) !== canonicalJson(completed.declared_paths)
                || canonicalJson(declared) !== canonicalJson(completed.changed_paths)) {
              fail('RECOVERY_EVIDENCE_INCOMPLETE', 'typed dispatch completion path sets disagree');
            }
            assertNoForeignEdit(leaseCtx, scope, directory,
              declared.map((item) => path.join(directory, item)));
            const current = artifactDigests(scope, leaseCtx.writerLease, leaseCtx.snapshot,
              declared, 'RECOVERY_ARTIFACT_ALTERED', leaseCtx.containmentBaseline);
            if (canonicalJson(current) !== canonicalJson(completed.artifact_digests)) {
              fail('RECOVERY_ARTIFACT_ALTERED', 'completed artifact bytes changed before recorder mutation');
            }
            assertSealManifest({ role: request.gsd_role, phaseDir: directory,
              snapshot: leaseCtx.snapshot, declared: completed.declared_paths,
              changed: completed.changed_paths, outputs: completed.full_output_manifest,
              lease: leaseCtx.writerLease });
          },
        },
      });
      const recoveredFields = recovering ? { recovered: true, recovered_output: runOptions.recovered.output } : null;
      if (leaseCtx && options.launchDir) {
        const completed = readLaunchRecord(options.launchDir, output.receipt.dispatch_id).completed;
        assertSealManifest({ role: request.gsd_role,
          phaseDir: phaseDirectory(scope.worktree, scope.phase), snapshot: leaseCtx.snapshot,
          declared: completed.declared_paths, changed: completed.changed_paths,
          outputs: completed.full_output_manifest, lease: leaseCtx.writerLease });
      }
      if (request.gsd_role === 'gsd-phase-researcher') {
        const sealed = sealResearchArtifact(scope, sealRoot, output, leaseCtx);
        return recoveredFields ? Object.freeze({ ...sealed, ...recoveredFields }) : sealed;
      }
      if (request.gsd_role === 'gsd-planner') {
        const sealed = sealPlans(scope, sealRoot, output, leaseCtx);
        return recoveredFields ? Object.freeze({ ...sealed, ...recoveredFields }) : sealed;
      }
      return recoveredFields ? Object.freeze({ ...output, ...recoveredFields }) : output;
    },
  });
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--args-file'
      || typeof argv[1] !== 'string' || !argv[1].trim()) {
    fail('INVALID_INPUT', 'usage: codex-decompose-host.cjs --args-file <json>');
  }
  return path.resolve(argv[1]);
}

function parseDetachArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== '--detach'
      || argv[1] !== '--args-file' || typeof argv[2] !== 'string' || !argv[2].trim()) {
    fail('INVALID_INPUT', 'usage: codex-decompose-host.cjs --detach --args-file <json>');
  }
  return path.resolve(argv[2]);
}

function readRequestFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { fail('INVALID_INPUT', 'cannot stat request: ' + error.message); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARGS_BYTES) {
    fail('INVALID_INPUT', 'request must be a bounded regular file');
  }
  let request;
  try { request = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('INVALID_INPUT', 'request is invalid JSON: ' + error.message); }
  if (!object(request) || !object(request.scope)) fail('INVALID_INPUT', 'request requires a scope');
  for (const key of Object.keys(request.scope)) {
    if (!['run_id', 'ticket', 'phase', 'worktree', 'runtime', 'provider', 'repository'].includes(key)) {
      fail('INVALID_INPUT', 'unsupported scope field ' + key);
    }
  }
  const { scope, ...launch } = request;
  return { scope, launch: requestValue(launch) };
}

const DEFAULT_HEARTBEAT_SCHEDULER = Object.freeze({
  start(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  },
});

function parseRecoverArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 5 || argv[0] !== 'recover' || argv[1] !== '--dispatch'
      || typeof argv[2] !== 'string' || !argv[2].trim() || argv[3] !== '--args-file'
      || typeof argv[4] !== 'string' || !argv[4].trim()) {
    fail('INVALID_INPUT', 'usage: codex-decompose-host.cjs recover --dispatch <id> --args-file <json>');
  }
  return { dispatchId: argv[2], file: path.resolve(argv[4]) };
}

function recoveryCode(error) {
  if (error && error.code === 'RUNTIME_EVIDENCE_MISSING') return 'RECOVERY_EVIDENCE_MISSING';
  return 'RECOVERY_EVIDENCE_INCOMPLETE';
}

function detachedDispatchId(request) {
  return request.dispatch_id || newDispatchId();
}

function detachCli(argv, stdout, options) {
  const parsed = readRequestFile(parseDetachArguments(argv));
  const scope = normalizeScope(parsed.scope);
  let worktree;
  try { worktree = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!worktree.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');

  const dispatchId = detachedDispatchId(parsed.launch);
  if (dispatchId === '.' || dispatchId === '..' || /[\\/]/.test(dispatchId) || path.isAbsolute(dispatchId)) {
    fail('INVALID_INPUT', 'dispatch_id must be a path-safe identifier for detached mode');
  }
  const stateRoot = path.resolve(require('./deliver-dispatch.cjs').dispatchStateDir(options));
  const directory = path.resolve(stateRoot, dispatchId);
  const relative = path.relative(stateRoot, directory);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('INVALID_INPUT', 'dispatch_id escapes the dispatch state directory');
  }
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('DISPATCH_EXISTS', 'dispatch state already exists for ' + dispatchId);
    throw error;
  }
  fs.chmodSync(directory, 0o700);

  const resultFile = path.join(directory, 'result.jsonl');
  const logFile = path.join(directory, 'host.log');
  const argsFile = path.join(directory, 'args.json');
  const childRequest = { scope: parsed.scope, ...requestValue({ ...parsed.launch, dispatch_id: dispatchId }) };
  fs.writeFileSync(argsFile, JSON.stringify(childRequest) + '\n', {
    mode: 0o600,
  });
  const environment = options.env ? { ...process.env, ...options.env } : { ...process.env };
  const graphDir = path.resolve(environment.SHIPYARD_GRAPH_DIR || path.join(scope.worktree, '.planning', 'graph'));
  environment.SHIPYARD_GRAPH_DIR = graphDir;
  const resultFd = fs.openSync(resultFile, 'a', 0o600);
  const logFd = fs.openSync(logFile, 'a', 0o600);
  const spawnFn = options.spawn || spawn;
  let child;
  try {
    child = spawnFn(process.execPath, [path.resolve(__filename), '--args-file', argsFile], {
      cwd: scope.worktree,
      detached: true,
      stdio: ['ignore', resultFd, logFd],
      env: environment,
    });
  } finally {
    fs.closeSync(resultFd);
    fs.closeSync(logFd);
  }
  if (!child || typeof child.unref !== 'function' || typeof child.on !== 'function'
      || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    fail('SPAWN_FAILED', 'detached Codex host did not return a child process');
  }
  child.on('error', (error) => {
    try { fs.appendFileSync(logFile, `codex-decompose-host: spawn error: ${error.message}\n`); }
    catch {}
  });
  child.unref();
  const record = {
    dispatch_id: dispatchId,
    ticket: scope.ticket || 'decomposition',
    role: parsed.launch.gsd_role,
    runtime: 'codex',
    graph_dir: graphDir,
    pid: child.pid,
    result: resultFile,
    log: logFile,
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(record));
  const wait = `node ${path.resolve(__dirname, 'deliver-dispatch.cjs')} wait --dispatch ${dispatchId}`;
  const response = Object.freeze({ dispatch_id: dispatchId, wait });
  stdout.write(JSON.stringify(response) + '\n');
  return response;
}

function recordChildModelEvidence(scope, dispatchId, result, resolution, options) {
  const receipt = result && result.receipt;
  const child = receipt && receipt.runtime_evidence && receipt.runtime_evidence.native_child_evidence;
  if (!child) return;
  try {
    const env = options.env || process.env;
    const graphDir = options.graphDir || env.SHIPYARD_GRAPH_DIR;
    const recorder = options.overheadRecorder || (graphDir ? orchestrationOverhead.createRecorder(graphDir) : null);
    if (!recorder) return;
    orchestrationOverhead.recordMeasurement(recorder, {
      observation_id: `codex-decompose:${dispatchId}:child`,
      run_id: scope.run_id,
      dispatch_id: dispatchId,
      role: resolution.role,
      runtime: 'codex',
      backend: 'codex-agent',
      policy_hash: resolution.policy_hash,
      model: receipt.observed_model,
      effort: receipt.observed_effort,
      requested_model: receipt.requested_model,
      requested_effort: receipt.requested_effort,
      observed_model: receipt.observed_model,
      observed_effort: receipt.observed_effort,
      actor: 'child',
      stage: 'model_turn',
      evidence: 'none',
      counts: { polls: null, model_turns: null, tool_calls: null, retries: null },
      provider_tokens: null,
      bytes: 0,
      estimated_tokens: null,
    });
  } catch {
    (options.stderr || process.stderr).write('codex-decompose-host: child model telemetry collection failed\n');
  }
}

async function recoverCli(argv, stdout, options) {
  const { dispatchId, file } = parseRecoverArguments(argv);
  const parsed = readRequestFile(file);
  if (parsed.launch.dispatch_id !== undefined && parsed.launch.dispatch_id !== dispatchId) {
    fail('INVALID_INPUT', 'request dispatch_id differs from --dispatch');
  }
  const request = { ...parsed.launch, dispatch_id: dispatchId };
  const scope = normalizeScope(parsed.scope);
  const runStoreDir = options.testRunStoreDir || defaultRunStoreDir(scope, options.testStateRoot);
  const hostStateDir = path.dirname(runStoreDir);
  const env = options.env || process.env;
  const phaseDir = phaseDirectory(scope.worktree, scope.phase);
  const controller = createRunController({
    storeDir: path.join(hostStateDir, 'recovery-runs',
      crypto.createHash('sha256').update(dispatchId).digest('hex')),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  assertNoLegacyPlanningWriter({ worktree: scope.worktree, phaseDir,
    roots: legacyPlanningWriterRoots({ worktree: scope.worktree, phase: scope.phase,
      repository: scope.repository, privateRoots: [path.join(hostStateDir, 'writer')] }) });
  const writerLease = options.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: sharedPlanningWriterRoot(options.testWriterStateRoot),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const priorReservation = createDurableRecorder(options.recorderDir || path.join(hostStateDir, 'receipts'))
    .getReservation(dispatchId);
  if (!priorReservation) fail('RECOVERY_NO_RESERVATION', 'dispatch ' + dispatchId + ' has no durable reservation');
  if (priorReservation.recorded) fail('RECOVERY_ALREADY_RECORDED', 'dispatch ' + dispatchId + ' already has a durable record');
  const originalLaunch = readLaunchRecord(options.launchDir || path.join(hostStateDir, 'launches'), dispatchId);
  if (typeof writerLease.file !== 'string' || originalLaunch.writer_lease_file !== writerLease.file) {
    fail('LEGACY_WRITER_STATE', 'original dispatch used another writer namespace');
  }
  const leaseHandle = writerLease.recover({
    owner: JSON.stringify({ run_id: scope.run_id, owner_id: controller.owner_id, recovery: dispatchId }),
    reason: 'recover completed typed GSD dispatch ' + dispatchId,
  });
  let runBegun = false;
  try {
    const recorder = createDurableRecorder(options.recorderDir || path.join(hostStateDir, 'receipts'));
    const reservation = recorder.getReservation(dispatchId);
    if (!reservation) fail('RECOVERY_NO_RESERVATION', 'dispatch ' + dispatchId + ' has no durable reservation');
    if (typeof reservation.reserved_at !== 'string' || !reservation.reserved_at.trim()) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'dispatch reservation has no original timestamp');
    }
    if (reservation.recorded) fail('RECOVERY_ALREADY_RECORDED', 'dispatch ' + dispatchId + ' already has a durable record');
    const launchDir = options.launchDir || path.join(hostStateDir, 'launches');
    const record = readLaunchRecord(launchDir, dispatchId);
    if (record.gsd_role !== request.gsd_role || !object(record.reservation)
        || record.reservation.dispatch_id !== dispatchId
        || record.reservation.reserved_at !== reservation.reserved_at) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'launch record does not bind the original durable reservation and GSD role');
    }
    const resolution = policy.resolveDispatch({
      runtime: 'codex', role: ROLES[request.gsd_role].role, signals: request.signals, dispatch_id: dispatchId,
    });
    const agent = installedGsdAgent(request.gsd_role, env);
    const binding = launchBinding(scope, request, dispatchId, resolution, agent);
    const originalBinding = object(record.binding) ? { ...record.binding } : null;
    if (originalBinding) delete originalBinding.generated_agent;
    const generatedAgentValid = request.gsd_role === 'gsd-phase-researcher'
      ? object(record.binding && record.binding.generated_agent)
        && typeof record.binding.generated_agent.file === 'string'
        && /^[a-f0-9]{64}$/.test(record.binding.generated_agent.sha256 || '')
      : !record.binding || record.binding.generated_agent === undefined;
    if (!object(record.binding) || !generatedAgentValid || canonicalJson(originalBinding) !== canonicalJson(binding)) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'recovery request, run scope, policy, or installed role differs from the original launch');
    }
    if (!Number.isSafeInteger(record.lease_epoch) || leaseHandle.epoch !== record.lease_epoch + 1) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'writer lease recovery did not fence the original launch epoch');
    }
    writerLease.assertFence({ token: leaseHandle.token, epoch: leaseHandle.epoch,
      base_revision: sourceRevision(scope.worktree) });
    const sessionStarted = record.session_started;
    const completed = record.completed;
    if (!object(sessionStarted) || typeof sessionStarted.session_id !== 'string'
        || !object(sessionStarted.runtime_launch) || !validTaskRelay(sessionStarted.runtime_launch.task_relay)) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'dispatch ' + dispatchId + ' has no bound native session-start record');
    }
    if (!object(completed) || typeof completed.parent_session_id !== 'string'
        || !object(completed.runtime_evidence) || !object(completed.artifact_digests)
        || !object(completed.full_output_manifest)
        || !Array.isArray(completed.declared_paths) || !Array.isArray(completed.changed_paths)) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'dispatch ' + dispatchId + ' has no original completed checkpoint');
    }
    if (!Number.isSafeInteger(record.process_spawned?.pid) || record.process_spawned.pid <= 0
        || sessionStarted.process_id !== record.process_spawned.pid || completed.pid !== record.process_spawned.pid) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'dispatch lacks its original positive native process identity');
    }
    if (pidAlive(record.process_spawned.pid)) {
      fail('RECOVERY_UNKNOWN_LIVE', 'recorded Codex process is live or its state is unknown');
    }
    if (sessionStarted.session_id !== completed.parent_session_id) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'completed record does not bind the original native session');
    }
    const transcriptDir = options.transcriptDir || path.join(hostStateDir, 'transcripts');
    verifyRuntimeEvidence(record, scope, binding, transcriptDir);
    const repository = scope.repository;
    let verified;
    try {
      verified = await verifyCompletedNativeLaunch({
        session_id: sessionStarted.session_id, selection: { model: resolution.model, effort: resolution.effort },
        agent, env, allowTimedOutWait: true, waitMs: 0, startedAt: 0, now: new Date(record.launched_at),
        task: sessionStarted.runtime_launch.task_relay, allowMissingTaskFile: true,
      });
    } catch (error) {
      fail(recoveryCode(error), 'native launch evidence cannot be re-verified: ' + error.message);
    }
    const session = verified.native_session_evidence;
    const child = verified.native_child_evidence;
    const output = verified.last_agent_message;
    if (typeof output !== 'string' || sha256Text(output) !== completed.completion_message_sha256
        || session.sha256 !== completed.parent_sha256 || child.sha256 !== completed.child_sha256
        || child.session_id !== completed.child_session_id
        || verified.spawn_evidence.timed_out !== completed.parent_wait_timed_out) {
      fail('RECOVERY_ARTIFACT_ALTERED', 'native transcripts differ from the digests recorded at launch');
    }
    const declared = declaredArtifactPaths(output, scope, request.gsd_role);
    if (canonicalJson(declared) !== canonicalJson(completed.declared_paths)
        || canonicalJson(declared) !== canonicalJson(completed.changed_paths)
        || canonicalJson(declared) !== canonicalJson(Object.keys(completed.artifact_digests).sort())) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'original completion changed-path sets disagree');
    }
    const declaredSet = new Set(declared);
    const foreign = writerLease.changedSince(record.tree_snapshot).changed.filter((item) => !declaredSet.has(item));
    if (foreign.length) fail('FOREIGN_EDIT', 'phase directory path(s) changed outside the authenticated child declaration: ' + foreign.join(', '));
    const currentDigests = artifactDigests(scope, writerLease, record.tree_snapshot, declared,
      'RECOVERY_ARTIFACT_ALTERED');
    if (canonicalJson(currentDigests) !== canonicalJson(completed.artifact_digests)) {
      fail('RECOVERY_ARTIFACT_ALTERED', 'phase artifacts differ from the digests recorded when the child completed');
    }
    assertSealManifest({ role: request.gsd_role, phaseDir: phaseDirectory(scope.worktree, scope.phase),
      snapshot: record.tree_snapshot, declared: completed.declared_paths,
      changed: completed.changed_paths, outputs: completed.full_output_manifest, lease: writerLease });
    controller.begin(createRunScope({
      run_id: scope.run_id,
      repository_id: typeof repository === 'string' ? repository
        : object(repository) ? repository.repository_id || repository.id : scope.worktree,
      phase: scope.phase, ticket: scope.ticket, worktree: scope.worktree,
      runtime: 'codex', provider: 'openai', owner_id: controller.owner_id,
      dispatch: {
        dispatch_id: dispatchId, role: resolution.role, model: resolution.model, effort: resolution.effort,
        policy_version: resolution.policy_version, policy_hash: resolution.policy_hash,
      },
    }));
    runBegun = true;
    const stored = completed.runtime_evidence;
    let recoveredRuntimeEvidence = stored;
    if (completed.transcript_saved === false && !fs.existsSync(stored.transcript.path)) {
      const nativeEvidence = { ...stored };
      delete nativeEvidence.transcript;
      delete nativeEvidence.stream_evidence;
      recoveredRuntimeEvidence = {
        ...nativeEvidence,
        stream_evidence: {
          format: 'jsonl', records: session.records, turns: session.turn_contexts,
          source: 'native-session-transcript',
        },
      };
    }
    const applied = Object.freeze({
      launch_id: completed.launch_id,
      session_id: completed.parent_session_id,
      ...(Number.isInteger(completed.pid) ? { process_id: completed.pid } : {}),
      applied_model: resolution.model, applied_effort: resolution.effort,
      observed_model: resolution.model, observed_effort: resolution.effort,
      runtime_evidence: Object.freeze({
        ...recoveredRuntimeEvidence, native_session_evidence: session, native_child_evidence: Object.freeze(child),
      }),
      gsd_role: request.gsd_role, gsd_launch_mechanism: 'typed-gsd-callback',
      agent_file: agent.file, agent_file_digest: agent.sha256,
    });
    const host = createCodexDecomposeHost({
      scope, controller,
      capabilities: options.capabilities, capabilitiesFile: options.capabilitiesFile,
      executable: options.executable, probe: options.probe,
      recorder,
      transcriptDir,
      env,
      spawn: () => fail('RECOVERY_SPAWN_FORBIDDEN', 'recovery never launches a runtime process'),
      agentDir: options.agentDir, agentManifest: options.agentManifest,
      sealRoot: path.join(hostStateDir, 'sealed'),
      launchDir,
    });
    const result = await host.run(request, {
      recovered: { applied, output, binding: record.binding },
      lease: { writerLease, token: leaseHandle.token, epoch: leaseHandle.epoch, snapshot: record.tree_snapshot },
    });
    controller.complete(scope.run_id, { reason: 'recovered typed GSD receipt ' + dispatchId });
    stdout.write(JSON.stringify(result) + '\n');
    return result;
  } catch (error) {
    if (runBegun) {
      try {
        controller.fail(scope.run_id, {
          reason: String(error && error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400),
        });
      } catch { /* @invariant: the recovery refusal is the error that matters */ }
    }
    throw error;
  } finally {
    try { writerLease.release({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch { /* @invariant: a fenced or expired lease has nothing left to release */ }
  }
}

async function runCli(argv = process.argv.slice(2), stdout = process.stdout, options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  if (Array.isArray(argv) && argv[0] === '--detach') return detachCli(argv, stdout, options);
  if (Array.isArray(argv) && argv[0] === 'recover') return recoverCli(argv, stdout, options);
  const parsed = readRequestFile(parseCliArguments(argv));
  const scope = normalizeScope(parsed.scope);
  let worktree;
  try { worktree = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!worktree.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
  const runStoreDir = options.testRunStoreDir || defaultRunStoreDir(scope, options.testStateRoot);
  const hostStateDir = path.dirname(runStoreDir);
  const controller = createRunController({
    storeDir: runStoreDir,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const phaseDir = phaseDirectory(scope.worktree, scope.phase);
  assertNoLegacyPlanningWriter({ worktree: scope.worktree, phaseDir,
    roots: legacyPlanningWriterRoots({ worktree: scope.worktree, phase: scope.phase,
      repository: scope.repository, privateRoots: [path.join(hostStateDir, 'writer')] }) });
  const writerLease = options.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: sharedPlanningWriterRoot(options.testWriterStateRoot),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const leaseHandle = writerLease.acquire({
    owner: JSON.stringify({ run_id: scope.run_id, owner_id: controller.owner_id }),
    base_revision: sourceRevision(scope.worktree),
  });
  let result;
  let resolution;
  let dispatchId;
  let stopHeartbeat = () => {};
  try {
  const containmentBaseline = captureContainmentBaseline({ worktree: scope.worktree });
  const leaseSnapshot = writerLease.snapshotTree();
  const request = parsed.launch;
  dispatchId = request.dispatch_id || newDispatchId();
  resolution = policy.resolveDispatch({
    runtime: 'codex', role: ROLES[request.gsd_role].role,
    signals: request.signals, dispatch_id: dispatchId,
  });
  const repository = scope.repository;
  const repositoryId = typeof repository === 'string' ? repository
    : object(repository) ? repository.repository_id || repository.id : scope.worktree;
  const run = createRunScope({
    run_id: scope.run_id,
    repository_id: repositoryId,
    phase: scope.phase,
    ticket: scope.ticket,
    worktree: scope.worktree,
    runtime: 'codex',
    provider: 'openai',
    owner_id: controller.owner_id,
    dispatch: {
      dispatch_id: dispatchId,
      role: resolution.role,
      model: resolution.model,
      effort: resolution.effort,
      policy_version: resolution.policy_version,
      policy_hash: resolution.policy_hash,
    },
  });
  controller.begin(run);
  const heartbeatMs = options.heartbeatMs || Math.min(60_000,
    Math.max(1_000, Math.floor((options.leaseTtlMs || DEFAULT_LEASE_TTL_MS) / 3)));
  const heartbeatScheduler = options.heartbeat || DEFAULT_HEARTBEAT_SCHEDULER;
  let heartbeatError = null;
  stopHeartbeat = heartbeatScheduler.start(() => {
    try { controller.heartbeat(scope.run_id); }
    catch (error) { heartbeatError = error; stopHeartbeat(); }
    try { writerLease.heartbeat({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch (error) { heartbeatError = heartbeatError || error; }
  }, heartbeatMs);
    const host = createCodexDecomposeHost({
      scope,
      controller,
      capabilities: options.capabilities,
      capabilitiesFile: options.capabilitiesFile,
      executable: options.executable,
      probe: options.probe,
      recorderDir: options.recorderDir || path.join(hostStateDir, 'receipts'),
      transcriptDir: options.transcriptDir || path.join(hostStateDir, 'transcripts'),
      env: options.env,
      spawn: options.spawn,
      agentDir: options.agentDir,
      agentManifest: options.agentManifest,
      sealRoot: path.join(hostStateDir, 'sealed'),
      lease: { writerLease, token: leaseHandle.token, epoch: leaseHandle.epoch, snapshot: leaseSnapshot, containmentBaseline },
      launchDir: options.launchDir || path.join(hostStateDir, 'launches'),
    });
    result = await host.run({ ...request, dispatch_id: dispatchId });
    stopHeartbeat();
    if (heartbeatError) throw heartbeatError;
    controller.assertOwner(scope.run_id);
    controller.complete(scope.run_id, { reason: 'verified typed GSD receipt ' + result.receipt.dispatch_id });
  } catch (error) {
    stopHeartbeat();
    try {
      controller.fail(scope.run_id, {
        reason: String(error && error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400),
      });
    } catch (controllerError) {
      if (error && typeof error === 'object') {
        error.message += '; run controller failure: ' + controllerError.message;
      }
    }
    throw error;
  } finally {
    try { writerLease.release({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch { /* @invariant: a fenced or expired lease has nothing left to release */ }
  }
  recordChildModelEvidence(scope, dispatchId, result, resolution, options);
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = Object.freeze({
  SCHEMA,
  MAX_ARGS_BYTES,
  ROLES,
  defaultRunStoreDir,
  phaseDirectory,
  researchArtifact,
  requestValue,
  createCodexDecomposeHost,
  parseCliArguments,
  parseRecoverArguments,
  readRequestFile,
  runCli,
});

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write('codex-decompose-host: ' + (error && error.message ? error.message : error) + '\n');
    process.stderr.write(formatHint(error && error.code) + '\n');
    process.exitCode = 1;
  });
}
