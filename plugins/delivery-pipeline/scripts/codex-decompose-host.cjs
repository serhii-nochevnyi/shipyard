#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCodexRuntimeHost, installedGsdAgent, normalizeScope, verifyCompletedNativeLaunch,
} = require('./codex-runtime-host.cjs');
const { launchAgent, selectAgent } = require('./codex-agent.cjs');
const { createCodexDispatchAdapter } = require('./codex-dispatch-adapter.cjs');
const policy = require('./model-policy.cjs');
const { newDispatchId, createDispatchBoundary, createDurableRecorder } = require('./dispatch-boundary.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { createRunController, DEFAULT_LEASE_TTL_MS } = require('./run-controller.cjs');
const { formatHint } = require('./refusal-hints.cjs');
const { sealDecomposition, assertContained } = require('./planning-result-sealer.cjs');
const { createPlanningWriterLease } = require('./planning-writer-lease.cjs');

const SCHEMA = 'shipyard.codex-decompose-host.v1';
const LAUNCH_SCHEMA = 'shipyard.codex-decompose-launch.v1';
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
  const root = path.join(worktree, '.planning', 'phases');
  let names;
  try { names = fs.readdirSync(root); }
  catch (error) { fail('PHASE_DIRECTORY_MISSING', 'phase directory root is unavailable: ' + error.message); }
  const matches = names.filter((name) => /^\d+-/.test(name) && Number(name.split('-')[0]) === Number(phase)
    && fs.lstatSync(path.join(root, name)).isDirectory());
  if (matches.length !== 1) {
    fail('PHASE_DIRECTORY_MISSING', 'expected exactly one phase directory for phase ' + phase + ', found ' + matches.length);
  }
  return path.join(root, matches[0]);
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
  assertContained({ worktree: scope.worktree, allowed: [path.relative(scope.worktree, artifact)] });
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
  assertContained({ worktree: scope.worktree, allowed: [path.relative(scope.worktree, directory)] });
  const names = fs.readdirSync(directory).filter((name) => /^\d+-\d+-PLAN\.md$/.test(name)).sort();
  if (!names.length) fail('MISSING_ARTIFACT', 'no materialized PLAN.md files were found in ' + directory);
  const plans = [...(fs.existsSync(path.join(directory, 'CONTEXT.md')) ? ['CONTEXT.md'] : []), ...names]
    .map((name) => path.join(directory, name));
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
    fs.renameSync(temporary, file);
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

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === 'EPERM'); }
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
      const leaseCtx = recovering ? runOptions.lease : options.lease || null;
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
          let prompt = context.prompt;
          let selected = {
            model: selection.model,
            reasoning_effort: selection.reasoning_effort,
            sandbox_mode: chosen.sandbox,
          };
          if (chosen.role === 'research') {
            if (selection.agent_file_digest !== crypto.createHash('sha256')
              .update(selection.agent_file_content || '').digest('hex')) {
              fail('STALE_GENERATED_AGENT', 'research handoff digest changed');
            }
            prompt = researchInstructions(selection.agent_file_content) + '\n\n' + prompt;
          }
          const launchRecord = options.launchDir && leaseCtx && !recovering ? {
            dispatch_id: context.dispatch_id, gsd_role: request.gsd_role, lease_epoch: leaseCtx.epoch,
            tree_snapshot: leaseCtx.snapshot, launched_at: new Date().toISOString(),
          } : null;
          if (launchRecord) writeLaunchRecord(options.launchDir, launchRecord);
          const applied = recovering
            ? runOptions.recovered.applied
            : await runtimeHost.launchTypedGsd(selected, { ...context, prompt });
          const evidence = applied && applied.runtime_evidence;
          if (launchRecord && evidence && evidence.native_child_evidence && evidence.native_session_evidence) {
            const completed = leaseCtx.writerLease.changedSince(leaseCtx.snapshot).changed;
            const directory = phaseDirectory(scope.worktree, scope.phase);
            writeLaunchRecord(options.launchDir, {
              ...launchRecord,
              completed: {
                launch_id: applied.launch_id,
                parent_session_id: applied.session_id,
                pid: Number.isInteger(applied.process_id) ? applied.process_id : null,
                parent_sha256: evidence.native_session_evidence.sha256,
                child_session_id: evidence.native_child_evidence.session_id,
                child_sha256: evidence.native_child_evidence.sha256,
                artifact_digests: Object.fromEntries(completed.map((rel) => [rel, sha256File(path.join(directory, rel))])),
                runtime_evidence: evidence,
              },
            });
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
        },
      });
      const recoveredFields = recovering ? { recovered: true, recovered_output: runOptions.recovered.output } : null;
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
  const writerLease = options.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: path.join(hostStateDir, 'writer'),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const leaseHandle = writerLease.acquire({
    owner: JSON.stringify({ run_id: scope.run_id, owner_id: controller.owner_id, recovery: dispatchId }),
    base_revision: sourceRevision(scope.worktree),
  });
  let runBegun = false;
  try {
    const recorder = createDurableRecorder(options.recorderDir || path.join(hostStateDir, 'receipts'));
    const reservation = recorder.getReservation(dispatchId);
    if (!reservation) fail('RECOVERY_NO_RESERVATION', 'dispatch ' + dispatchId + ' has no durable reservation');
    if (reservation.recorded) fail('RECOVERY_ALREADY_RECORDED', 'dispatch ' + dispatchId + ' already has a durable record');
    const launchDir = options.launchDir || path.join(hostStateDir, 'launches');
    const record = readLaunchRecord(launchDir, dispatchId);
    if (record.gsd_role !== request.gsd_role) fail('RECOVERY_EVIDENCE_MISSING', 'launch record belongs to another GSD role');
    const completed = record.completed;
    if (!object(completed) || typeof completed.parent_session_id !== 'string' || !object(completed.runtime_evidence)
        || !object(completed.artifact_digests)) {
      fail('RECOVERY_EVIDENCE_INCOMPLETE', 'dispatch ' + dispatchId + ' has no completed native launch to recover');
    }
    if (pidAlive(completed.pid)) fail('RECOVERY_UNKNOWN_LIVE', 'recorded launch pid ' + completed.pid + ' is still alive');
    const resolution = policy.resolveDispatch({
      runtime: 'codex', role: ROLES[request.gsd_role].role, signals: request.signals, dispatch_id: dispatchId,
    });
    const agent = installedGsdAgent(request.gsd_role, env);
    const repository = scope.repository;
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
    let verified;
    try {
      verified = await verifyCompletedNativeLaunch({
        session_id: completed.parent_session_id, selection: { model: resolution.model, effort: resolution.effort },
        agent, env, allowTimedOutWait: true, waitMs: 0, startedAt: 0, now: new Date(record.launched_at),
      });
    } catch (error) {
      fail(recoveryCode(error), 'native launch evidence cannot be re-verified: ' + error.message);
    }
    const session = verified.native_session_evidence;
    const { last_agent_message: output, ...child } = verified.native_child_evidence;
    if (session.sha256 !== completed.parent_sha256 || child.sha256 !== completed.child_sha256
        || child.session_id !== completed.child_session_id) {
      fail('RECOVERY_ARTIFACT_ALTERED', 'native transcripts differ from the digests recorded at launch');
    }
    const changed = writerLease.changedSince(record.tree_snapshot).changed;
    const declared = Object.keys(completed.artifact_digests).sort();
    const altered = changed.length !== declared.length || changed.some((rel, index) => rel !== declared[index])
      || declared.some((rel) => sha256File(path.join(phaseDir, rel)) !== completed.artifact_digests[rel]);
    if (altered) fail('RECOVERY_ARTIFACT_ALTERED', 'phase artifacts differ from the digests recorded when the child completed');
    const stored = completed.runtime_evidence;
    const applied = Object.freeze({
      launch_id: completed.launch_id,
      session_id: completed.parent_session_id,
      ...(Number.isInteger(completed.pid) ? { process_id: completed.pid } : {}),
      applied_model: resolution.model, applied_effort: resolution.effort,
      observed_model: resolution.model, observed_effort: resolution.effort,
      runtime_evidence: Object.freeze({ ...stored, native_session_evidence: session, native_child_evidence: Object.freeze(child) }),
      gsd_role: request.gsd_role, gsd_launch_mechanism: 'typed-gsd-callback',
      agent_file: agent.file, agent_file_digest: agent.sha256,
    });
    const host = createCodexDecomposeHost({
      scope, controller,
      capabilities: options.capabilities, capabilitiesFile: options.capabilitiesFile,
      executable: options.executable, probe: options.probe,
      recorder,
      transcriptDir: options.transcriptDir || path.join(hostStateDir, 'transcripts'),
      env,
      spawn: () => fail('RECOVERY_SPAWN_FORBIDDEN', 'recovery never launches a runtime process'),
      agentDir: options.agentDir, agentManifest: options.agentManifest,
      sealRoot: path.join(hostStateDir, 'sealed'),
    });
    const result = await host.run(request, {
      recovered: { applied, output },
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
  const writerLease = options.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: path.join(hostStateDir, 'writer'),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const leaseHandle = writerLease.acquire({
    owner: JSON.stringify({ run_id: scope.run_id, owner_id: controller.owner_id }),
    base_revision: sourceRevision(scope.worktree),
  });
  const leaseSnapshot = writerLease.snapshotTree();
  const request = parsed.launch;
  const dispatchId = request.dispatch_id || newDispatchId();
  const resolution = policy.resolveDispatch({
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
  let stopHeartbeat = () => {};
  stopHeartbeat = heartbeatScheduler.start(() => {
    try { controller.heartbeat(scope.run_id); }
    catch (error) { heartbeatError = error; stopHeartbeat(); }
    try { writerLease.heartbeat({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch (error) { heartbeatError = heartbeatError || error; }
  }, heartbeatMs);
  let result;
  try {
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
      lease: { writerLease, token: leaseHandle.token, epoch: leaseHandle.epoch, snapshot: leaseSnapshot },
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
