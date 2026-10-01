#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeGsdAgentDirectory } = require('./gsd-agent-root.cjs');
const { execFileSync } = require('node:child_process');
const { createClaudeRuntimeHost, probeClaudeRuntime, verifyCompletedClaudeLaunch } = require('./claude-runtime-host.cjs');
const { createClaudeWorkflowDispatch, createClaudeDispatchAdapter } = require('./claude-dispatch-adapter.cjs');
const { createDurableRecorder, createDispatchBoundary } = require('./dispatch-boundary.cjs');
const { createRunController } = require('./run-controller.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { matchesModelObservation } = require('./runtime-adapters.cjs');
const pipelineConfig = require('./pipeline-config.cjs');
const { formatHint } = require('./refusal-hints.cjs');
const { sealDecomposition } = require('./planning-result-sealer.cjs');
const { createPlanningWriterLease, sharedPlanningWriterRoot, legacyPlanningWriterRoots,
  assertNoLegacyPlanningWriter, captureSealManifest, assertSealManifest } = require('./planning-writer-lease.cjs');

const ROLES = Object.freeze({
  'gsd-phase-researcher': 'research',
  'gsd-planner': 'decomposition',
  'gsd-plan-checker': 'decomposition',
});
const REFERENCE = /@(?:~\/\.claude\/gsd-core|gsd-core)\/([A-Za-z0-9_./-]+\.md)/g;
const MAX_SOURCE = 256 * 1024;
const MAX_PROMPT = 256 * 1024;
const MAX_LAUNCH = 4 * 1024 * 1024;

function refuse(code, message) {
  const error = new Error(`claude-decompose-host: ${message}`);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max
      || /[\u0000-\u001f\u007f]/.test(value)) {
    refuse('INVALID_INPUT', `${label} must be bounded non-empty text`);
  }
  return value;
}

function realFile(file, directory, max = MAX_SOURCE) {
  const root = fs.realpathSync(directory);
  const target = path.resolve(directory, file);
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) refuse('REFERENCE_UNAVAILABLE', 'reference escaped its trusted root');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || fs.realpathSync(target) !== path.join(root, file)) {
    refuse('REFERENCE_UNAVAILABLE', 'reference is not a bounded regular file');
  }
  return fs.readFileSync(target, 'utf8');
}

function inlineReferences(source, root) {
  const included = new Set();
  function expand(text, stack) {
    return text.replace(REFERENCE, (reference, relative) => {
      if (!/^(references|templates|workflows)\/[A-Za-z0-9_./-]+\.md$/.test(relative)
          || relative.split('/').includes('..') || relative.split('/').includes('.')) {
        refuse('REFERENCE_UNAVAILABLE', `unsupported GSD reference ${reference}`);
      }
      if (stack.includes(relative)) refuse('REFERENCE_UNAVAILABLE', `cyclic GSD reference ${relative}`);
      if (included.has(relative)) return `\n<GSD reference ${relative} included above>\n`;
      included.add(relative);
      const content = expand(realFile(relative, root), [...stack, relative]);
      return `\n<gsd-reference source="${relative}">\n${content}\n</gsd-reference>\n`;
    });
  }
  const output = expand(source, []);
  if (Buffer.byteLength(output) > MAX_SOURCE) refuse('REFERENCE_UNAVAILABLE', 'expanded GSD role exceeds the 256 KiB limit');
  return output;
}

function trustedAgent(role, configRoot) {
  const agents = claudeGsdAgentDirectory(configRoot, role);
  const source = realFile(`${role}.md`, agents);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!match) refuse('REFERENCE_UNAVAILABLE', 'GSD agent definition is malformed');
  const field = (name) => match[1].split(/\r?\n/).find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  if (field('name') !== role || !field('description') || !field('tools')) {
    refuse('REFERENCE_UNAVAILABLE', 'GSD agent identity is invalid');
  }
  const frontmatter = match[1].split(/\r?\n/)
    .filter((line) => !/^(model|effort):(?:\s|$)/.test(line)).join('\n');
  const prompt = inlineReferences(match[2], path.join(configRoot, 'gsd-core'));
  return `---\n${frontmatter}\n---\n${prompt}`;
}

function git(worktree, ...args) {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', timeout: 10000 }).trim();
}

function canonicalRequest(input) {
  if (!object(input)) refuse('INVALID_INPUT', 'request must be an object');
  const keys = new Set(['role', 'phase', 'worktree', 'prompt', 'signals']);
  if (Object.keys(input).some((key) => !keys.has(key))) refuse('INVALID_INPUT', 'request has unsupported fields');
  const role = safeText(input.role, 'role', 32);
  if (!Object.hasOwn(ROLES, role)) refuse('UNSUPPORTED_ROLE', `unsupported GSD role ${role}`);
  const phase = Number(input.phase);
  if (!Number.isSafeInteger(phase) || phase < 1 || String(input.phase) !== String(phase)) {
    refuse('INVALID_INPUT', 'phase must be a positive integer');
  }
  const worktree = fs.realpathSync(safeText(input.worktree, 'worktree', 4096));
  if (path.resolve(git(worktree, 'rev-parse', '--show-toplevel')) !== worktree) {
    refuse('SCOPE_MISMATCH', 'worktree must be the canonical Git root');
  }
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    refuse('INVALID_INPUT', 'prompt must be bounded text');
  }
  const signals = input.signals === undefined ? {} : input.signals;
  if (!object(signals) || Object.keys(signals).some((key) => !['complexity', 'critical', 'checkpoint'].includes(key))) {
    refuse('INVALID_SIGNAL', 'unsupported decomposition signal');
  }
  if (signals.complexity !== undefined && !['simple', 'moderate', 'complex', 'very-complex'].includes(signals.complexity)) {
    refuse('INVALID_SIGNAL', 'invalid complexity signal');
  }
  for (const key of ['critical', 'checkpoint']) {
    if (signals[key] !== undefined && typeof signals[key] !== 'boolean') refuse('INVALID_SIGNAL', `invalid ${key} signal`);
  }
  const common = fs.realpathSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')));
  return Object.freeze({ role, phase, worktree, prompt, signals: Object.freeze({ ...signals }),
    ticket: `T-${phase}-DECOMPOSE`, repository: common });
}

function phaseDirectory(worktree, phase) {
  const phasesRoot = path.join(worktree, '.planning', 'phases');
  let names;
  try {
    names = fs.readdirSync(phasesRoot);
  } catch (error) {
    refuse('PHASE_DIRECTORY_MISSING', `phase directory root is unavailable: ${error.message}`);
  }
  if (fs.realpathSync(phasesRoot) !== phasesRoot) {
    refuse('PHASE_DIRECTORY_MISSING', 'phase directory root is not canonical');
  }
  const matches = names.filter((name) => /^\d+-/.test(name) && Number(name.split('-')[0]) === Number(phase)
    && fs.lstatSync(path.join(phasesRoot, name)).isDirectory());
  if (matches.length !== 1) {
    refuse('PHASE_DIRECTORY_MISSING', `expected exactly one phase directory for phase ${phase}, found ${matches.length}`);
  }
  const directory = path.join(phasesRoot, matches[0]);
  if (fs.realpathSync(directory) !== directory) {
    refuse('PHASE_DIRECTORY_MISSING', 'phase directory is not canonical');
  }
  return directory;
}

function decompositionPlans(directory) {
  const contextPath = path.join(directory, 'CONTEXT.md');
  if (!fs.existsSync(contextPath)) refuse('MISSING_ARTIFACT', `phase CONTEXT.md is missing: ${contextPath}`);
  const phase = Number(path.basename(directory).split('-')[0]);
  const planNames = fs.readdirSync(directory).filter((name) => new RegExp(`^${phase}-[0-9]+-PLAN\\.md$`).test(name)).sort();
  if (!planNames.length) refuse('MISSING_ARTIFACT', `no materialized PLAN.md files were found in ${directory}`);
  return [contextPath, ...planNames.map((name) => path.join(directory, name))];
}

function decompositionEnvelope(scope, store, output) {
  const plans = decompositionPlans(phaseDirectory(scope.worktree, scope.phase));
  return sealDecomposition({
    root: path.join(store, 'decomposition-index'),
    scope: {
      worktree: scope.worktree,
      subject: `phase=${scope.phase};repository=${scope.repository}`,
      sourceRevision: git(scope.worktree, 'rev-parse', 'HEAD'),
      repository: scope.repository,
      policyHash: output.receipt.policy_hash,
      status: object(output.result) && output.result.status === 'blocked' ? 'blocked' : 'completed',
      summary: object(output.result) && typeof output.result.summary === 'string'
        ? output.result.summary
        : `materialized plans for phase ${scope.phase}`,
    },
    plans,
  });
}

function privateStore(scope) {
  const key = crypto.createHash('sha256').update(`${scope.repository}\n${scope.worktree}\n${scope.phase}`).digest('hex');
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.local', 'state', 'shipyard', 'claude-decompose', key);
}

function ensurePrivateStore(store) {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(store);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('INVALID_INPUT', 'Claude decompose store is not a private directory');
  fs.chmodSync(store, 0o700);
}

function launchFile(store, dispatchId) {
  return path.join(store, 'launches', `${crypto.createHash('sha256').update(dispatchId).digest('hex')}.launch.json`);
}

function writeLaunch(store, record) {
  const file = launchFile(store, record.dispatch_id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const raw = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(raw, 'utf8') > MAX_LAUNCH) refuse('INVALID_INPUT', 'private launch snapshot exceeds 4 MiB');
  try {
    fs.writeFileSync(temporary, raw, { mode: 0o600 });
    const handle = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function digestValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestBinding(scope, runId, resolution) {
  return {
    repository: scope.repository, worktree: scope.worktree, phase: scope.phase,
    ticket: scope.ticket, run_id: runId, role: scope.role,
    request_sha256: digestValue(JSON.stringify({ role: scope.role, phase: scope.phase,
      worktree: scope.worktree, prompt: scope.prompt, signals: scope.signals })),
    model: resolution.model, effort: resolution.effort,
    policy_hash: resolution.policy_hash ?? null,
    policy_version: resolution.policy_version ?? null,
    policy_id: resolution.policy_id ?? null,
    policy_rung: resolution.rung ?? resolution.policy_rung ?? null,
  };
}

function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function readLaunch(store, dispatchId) {
  const file = launchFile(store, dispatchId);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { refuse('RECOVERY_EVIDENCE_MISSING', `no launch record exists for ${dispatchId}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > MAX_LAUNCH) {
    refuse('RECOVERY_EVIDENCE_MISSING', 'launch record is not a private bounded file');
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { refuse('RECOVERY_EVIDENCE_MISSING', 'launch record is invalid JSON'); }
  if (!object(record) || record.dispatch_id !== dispatchId || !object(record.tree_snapshot)
      || !object(record.tree_snapshot.digests) || !object(record.request)
      || !/^decompose-[0-9a-f-]{36}$/i.test(record.run_id)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.session_id)) {
    refuse('RECOVERY_EVIDENCE_MISSING', 'launch record has invalid identity or snapshot');
  }
  return record;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || error.code !== 'ESRCH'; }
}

function fileDigest(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) refuse('RECOVERY_ARTIFACT_ALTERED', `saved artifact is not a regular file: ${file}`);
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}

function receiptCompliant(output, scope, resolution) {
  return output && output.receipt?.compliance === 'verified'
    && output.receipt.gsd_role === scope.role
    && output.receipt.applied_model === resolution.model
    && output.receipt.applied_effort === resolution.effort
    && matchesModelObservation('claude', output.receipt.observed_model, resolution.model)
    && output.receipt.observed_effort === resolution.effort
    && output.receipt.gsd_agent_evidence?.role === scope.role
    && output.receipt.gsd_agent_evidence?.session_id === output.receipt.session_id
    && output.receipt.gsd_agent_evidence?.session_start_agent_type === scope.role
    && output.receipt.gsd_agent_evidence?.transcript_agent_setting === scope.role
    && output.receipt.selection_evidence?.session_id === output.receipt.session_id;
}

function foreignPhaseEdits(directory, declaredAbsolutePaths, writerLease, snapshot) {
  const declared = new Set(declaredAbsolutePaths.map((full) => path.relative(directory, full).split(path.sep).join('/')));
  const { changed, lease: currentLease } = writerLease.changedSince(snapshot);
  return { foreign: changed.filter((relPath) => !declared.has(relPath)), currentLease };
}

function validateJudgmentWriter(scope, directory, writerLease, leaseHandle, snapshot, launch) {
  writerLease.assertFence({ token: leaseHandle.token, epoch: leaseHandle.epoch,
    base_revision: git(scope.worktree, 'rev-parse', 'HEAD') });
  const completed = launch.completed;
  if (!object(completed) || !Array.isArray(completed.declared_paths)
      || !Array.isArray(completed.changed_paths) || !object(completed.artifact_digests)
      || !object(completed.full_output_manifest)) {
    refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'typed Claude dispatch lacks its original completed checkpoint');
  }
  const declared = completed.declared_paths;
  const { changed, lease } = writerLease.changedSince(snapshot);
  const foreign = changed.filter((item) => !declared.includes(item));
  if (foreign.length) {
    refuse('FOREIGN_EDIT', `phase directory path(s) changed outside this run's own paths: ${foreign.join(', ')} `
      + `(lease owner ${lease.owner}, epoch ${lease.epoch})`);
  }
  if (!sameValue(changed, declared) || !sameValue(completed.changed_paths, declared)
      || !sameValue(Object.keys(completed.artifact_digests).sort(), declared)
      || declared.some((item) => fileDigest(path.join(directory, item)) !== completed.artifact_digests[item])) {
    refuse('RECOVERY_ARTIFACT_ALTERED', 'completed Claude artifact bytes changed before recorder mutation');
  }
  assertSealManifest({ role: scope.role, phaseDir: directory, snapshot,
    declared, changed: completed.changed_paths, outputs: completed.full_output_manifest,
    lease: writerLease });
}

async function runDecomposition(request, dependencies = {}) {
  const scope = canonicalRequest(request);
  const store = dependencies.store || privateStore(scope);
  ensurePrivateStore(store);
  const phaseDir = phaseDirectory(scope.worktree, scope.phase);
  const controller = (dependencies.controllerFactory || createRunController)({ storeDir: path.join(store, 'runs') });
  const runId = `decompose-${crypto.randomUUID()}`;
  const dispatchId = `decompose-${crypto.randomUUID()}`;
  assertNoLegacyPlanningWriter({ worktree: scope.worktree, phaseDir,
    roots: legacyPlanningWriterRoots({ worktree: scope.worktree, phase: scope.phase,
      repository: scope.repository, privateRoots: [path.join(store, 'writer')] }) });
  const writerLease = dependencies.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: sharedPlanningWriterRoot(dependencies.testWriterStateRoot),
  });
  let leaseHandle;
  try {
    leaseHandle = writerLease.acquire({
      owner: JSON.stringify({ run_id: runId, owner_id: controller.owner_id }),
      base_revision: git(scope.worktree, 'rev-parse', 'HEAD'),
    });
    const preLaunchSnapshot = writerLease.snapshotTree();
    const resolution = (dependencies.resolveDispatch || pipelineConfig.resolveDispatch)({
      root: scope.worktree, runtime: 'claude', role: ROLES[scope.role],
      signals: scope.signals, dispatch_id: dispatchId,
    });
    if (!object(resolution) || resolution.dispatch_id !== dispatchId || resolution.runtime !== 'claude'
        || resolution.role !== ROLES[scope.role] || typeof resolution.model !== 'string'
        || typeof resolution.effort !== 'string') {
      refuse('CONFLICTING_OVERRIDE', 'routed resolution does not match the requested GSD launch');
    }
    const configRoot = dependencies.configRoot || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
    const definition = trustedAgent(scope.role, configRoot);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-definition-'));
    fs.chmodSync(temporary, 0o700);
    try {
      fs.writeFileSync(path.join(temporary, `${scope.role}.md`), definition, { flag: 'wx', mode: 0o600 });
      const recorder = (dependencies.recorderFactory || createDurableRecorder)(path.join(store, 'receipts'));
      controller.begin(createRunScope({
        run_id: runId, repository_id: scope.repository, phase: scope.phase, ticket: scope.ticket,
        worktree: scope.worktree, runtime: 'claude', owner_id: controller.owner_id,
        dispatch: { dispatch_id: dispatchId, role: ROLES[scope.role], model: resolution.model, effort: resolution.effort },
      }));
      const sessionId = crypto.randomUUID();
      const transcriptDir = path.join(store, 'transcripts');
      const startEvidenceFile = path.join(transcriptDir, `${runId}-${sessionId}.session-start.json`);
      const transcriptFile = path.join(transcriptDir, `${runId}-${sessionId}.jsonl`);
      const launchRecord = {
        dispatch_id: dispatchId, run_id: runId, session_id: sessionId,
        lease_epoch: leaseHandle.epoch, tree_snapshot: preLaunchSnapshot,
        writer_lease_file: writerLease.file,
        request, resolution: { model: resolution.model, effort: resolution.effort,
          policy_hash: resolution.policy_hash ?? null, policy_version: resolution.policy_version ?? null,
          policy_id: resolution.policy_id ?? null, rung: resolution.rung ?? resolution.policy_rung ?? null },
        binding: requestBinding(scope, runId, resolution),
        start_evidence_file: startEvidenceFile, transcript_path: transcriptFile,
      };
      writeLaunch(store, launchRecord);
      let heartbeatFailure;
      const heartbeat = setInterval(() => {
        try { controller.heartbeat(runId); }
        catch (error) { heartbeatFailure = error; }
        try { writerLease.heartbeat({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
        catch (error) { heartbeatFailure = heartbeatFailure || error; }
      }, 60 * 1000);
      heartbeat.unref();
      try {
        const probe = (dependencies.probe || probeClaudeRuntime)();
        launchRecord.runtime_version = probe.runtime_version;
        writeLaunch(store, launchRecord);
        const host = (dependencies.runtimeHostFactory || createClaudeRuntimeHost)({
          scope: { run_id: runId, ticket: scope.ticket, phase: scope.phase, worktree: scope.worktree,
            runtime: 'claude', provider: 'anthropic', repository: scope.repository },
          recorder, controller, probe, gsdAgentRoot: temporary,
          transcriptDir,
          startEvidenceFile,
          onChildSpawn: (pid) => {
            if (!Number.isSafeInteger(pid) || pid <= 0) refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'Claude child pid is invalid');
            launchRecord.child_pid = pid;
            writeLaunch(store, launchRecord);
          },
          onCompleted: (completed) => {
            if (scope.role === 'gsd-planner') decompositionPlans(phaseDir);
            const changed = writerLease.changedSince(preLaunchSnapshot).changed;
            const declared = declaredChanges({ output: completed.output }, phaseDir);
            if (!sameValue(changed, declared)) refuse('RECOVERY_ARTIFACT_ALTERED', 'final assistant declaration differs from completed phase changes');
            const artifactDigests = Object.fromEntries(changed.map((rel) => [rel, fileDigest(path.join(phaseDir, rel))]));
            if (Object.values(artifactDigests).some((digest) => digest === null)) {
              refuse('RECOVERY_ARTIFACT_ALTERED', 'completed artifact is missing');
            }
            const fullOutputManifest = captureSealManifest({ role: scope.role, phaseDir,
              snapshot: preLaunchSnapshot, declared, changed });
            const reservation = recorder.getReservation(dispatchId);
            if (!reservation || reservation.recorded || !reservation.reserved_at) {
              refuse('RECOVERY_NO_RESERVATION', 'completed Claude launch has no original reservation');
            }
            const selectionPath = path.join(transcriptDir, 'projects',
              completed.applicationEvidence.selection_evidence.transcript.path);
            launchRecord.completed = {
              reservation_at: reservation.reserved_at,
              stream_sha256: completed.applicationEvidence.transcript.sha256,
              selection_sha256: completed.applicationEvidence.selection_evidence.transcript.sha256,
              start_sha256: fileDigest(startEvidenceFile),
              declared_paths: declared, changed_paths: changed, artifact_digests: artifactDigests,
              full_output_manifest: fullOutputManifest,
            };
            launchRecord.saved_native_transcript = selectionPath;
            launchRecord.saved_native_transcript_sha256 = launchRecord.completed.selection_sha256;
            launchRecord.saved_native_transcript_bytes = completed.applicationEvidence.selection_evidence.transcript.bytes;
            launchRecord.start_evidence_sha256 = launchRecord.completed.start_sha256;
            launchRecord.native_transcript_path = JSON.parse(fs.readFileSync(startEvidenceFile, 'utf8')).transcript_path;
            writeLaunch(store, launchRecord);
          },
        });
        const output = await createClaudeWorkflowDispatch({
          host, prompt: scope.prompt, role: ROLES[scope.role], gsdRole: scope.role,
          model: resolution.model, effort: resolution.effort, signals: scope.signals,
          dispatchId, requireGsdRole: true,
          agentOptions: { session_id: sessionId },
          context: { ticket: scope.ticket, phase: scope.phase, run_id: runId,
            worktreePath: scope.worktree, runtime: 'claude', provider: 'anthropic',
            preRecordValidation: () => typeof dependencies.preRecordValidation === 'function'
              ? dependencies.preRecordValidation({ scope, phaseDir, writerLease, leaseHandle,
                snapshot: preLaunchSnapshot, launchRecord })
              : validateJudgmentWriter(scope, phaseDir, writerLease, leaseHandle,
                preLaunchSnapshot, launchRecord) },
        });
        if (!receiptCompliant(output, scope, resolution)) {
          refuse('NONCOMPLIANT_RECEIPT', 'typed GSD dispatch has no compliant exact-role receipt');
        }
        if (heartbeatFailure) throw heartbeatFailure;
        controller.assertOwner(runId);
        if (launchRecord.completed) validateJudgmentWriter(
          scope, phaseDir, writerLease, leaseHandle, preLaunchSnapshot, launchRecord);
        let envelope = null;
        if (ROLES[scope.role] === 'decomposition') {
          writerLease.assertFence({ token: leaseHandle.token, epoch: leaseHandle.epoch,
            base_revision: git(scope.worktree, 'rev-parse', 'HEAD') });
          const directory = phaseDirectory(scope.worktree, scope.phase);
          const { foreign, currentLease } = foreignPhaseEdits(
            directory, decompositionPlans(directory), writerLease, preLaunchSnapshot);
          if (foreign.length) {
            refuse('FOREIGN_EDIT', `phase directory path(s) changed outside this run's own paths: ${foreign.join(', ')} `
              + `(lease owner ${currentLease.owner}, epoch ${currentLease.epoch})`);
          }
          envelope = decompositionEnvelope(scope, store, output);
        }
        controller.complete(runId);
        return Object.freeze({ role: scope.role, result: output.result, receipt: output.receipt,
          run_id: runId, dispatch_id: dispatchId, ...(envelope ? { envelope } : {}) });
      } catch (error) {
        if (controller.status(runId).state === 'running') controller.fail(runId, { reason: error.message });
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  } catch (error) {
    error.dispatch_id = dispatchId;
    error.run_id = runId;
    error.message += ` (dispatch_id=${dispatchId}, run_id=${runId})`;
    throw error;
  } finally {
    try { if (leaseHandle) writerLease.release({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch { /* @invariant: a fenced or expired lease has nothing left to release */ }
  }
}

function recoveryStore(dispatchId, dependencies) {
  if (dependencies.store) return dependencies.store;
  const root = path.join(process.env.HOME || os.homedir(), '.local', 'state', 'shipyard', 'claude-decompose');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { refuse('RECOVERY_NO_RESERVATION', `dispatch ${dispatchId} has no durable reservation`); }
  const stores = entries.filter((entry) => entry.isDirectory()
    && fs.existsSync(path.join(root, entry.name, 'receipts'))
    && createDurableRecorder(path.join(root, entry.name, 'receipts')).getReservation(dispatchId));
  if (stores.length === 0) refuse('RECOVERY_NO_RESERVATION', `dispatch ${dispatchId} has no durable reservation`);
  if (stores.length !== 1) refuse('RECOVERY_EVIDENCE_MISSING', `expected one private reservation for ${dispatchId}`);
  return path.join(root, stores[0].name);
}

function declaredChanges(result, phaseDir) {
  const output = result && result.output;
  const paths = object(output) ? output.changed_paths ?? output.files_modified : undefined;
  if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string' || !item.trim())) {
    refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'final assistant result has no declared changed paths');
  }
  const relative = paths.map((item) => {
    const absolute = path.resolve(phaseDir, item);
    const rel = path.relative(phaseDir, absolute).split(path.sep).join('/');
    if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', `declared path escaped the phase directory: ${item}`);
    }
    return rel;
  });
  if (new Set(relative).size !== relative.length) refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'final assistant result repeats a changed path');
  return relative.sort();
}

async function recoverDecomposition(dispatchId, dependencies = {}) {
  safeText(dispatchId, 'dispatch id', 128);
  const store = recoveryStore(dispatchId, dependencies);
  const storeStat = fs.lstatSync(store);
  if (!storeStat.isDirectory() || storeStat.isSymbolicLink() || (storeStat.mode & 0o077) !== 0) {
    refuse('RECOVERY_EVIDENCE_MISSING', 'Claude decompose store is not private');
  }
  const recorder = (dependencies.recorderFactory || createDurableRecorder)(path.join(store, 'receipts'));
  const existingReservation = recorder.getReservation?.(dispatchId);
  if (!existingReservation) refuse('RECOVERY_NO_RESERVATION', `dispatch ${dispatchId} has no durable reservation`);
  if (existingReservation.recorded) refuse('RECOVERY_ALREADY_RECORDED', `dispatch ${dispatchId} already has a durable record`);
  const launch = readLaunch(store, dispatchId);
  const scope = canonicalRequest(launch.request);
  if (!dependencies.store && privateStore(scope) !== store) refuse('RECOVERY_EVIDENCE_MISSING', 'launch record belongs to another scope');
  const phaseDir = phaseDirectory(scope.worktree, scope.phase);
  const controller = (dependencies.controllerFactory || createRunController)({ storeDir: path.join(store, 'recovery-runs') });
  assertNoLegacyPlanningWriter({ worktree: scope.worktree, phaseDir,
    roots: legacyPlanningWriterRoots({ worktree: scope.worktree, phase: scope.phase,
      repository: scope.repository, privateRoots: [path.join(store, 'writer')] }) });
  const writerLease = dependencies.writerLease || createPlanningWriterLease({
    worktree: scope.worktree, phaseDir, stateRoot: sharedPlanningWriterRoot(dependencies.testWriterStateRoot),
  });
  if (typeof writerLease.file !== 'string' || launch.writer_lease_file !== writerLease.file) {
    refuse('LEGACY_WRITER_STATE', 'original Claude dispatch used another writer namespace');
  }
  const leaseHandle = writerLease.recover({
    owner: JSON.stringify({ run_id: launch.run_id, owner_id: controller.owner_id, recovery: dispatchId }),
    reason: `recover completed Claude dispatch ${dispatchId}`,
  });
  try {
    if (!Number.isSafeInteger(launch.lease_epoch) || leaseHandle.epoch !== launch.lease_epoch + 1) {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'writer lease no longer follows the original launch epoch');
    }
    const reservation = recorder.getReservation?.(dispatchId);
    if (!reservation) refuse('RECOVERY_NO_RESERVATION', `dispatch ${dispatchId} has no durable reservation`);
    if (reservation.recorded) refuse('RECOVERY_ALREADY_RECORDED', `dispatch ${dispatchId} already has a durable record`);
    if (!Number.isSafeInteger(launch.child_pid) || launch.child_pid <= 0) {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'original Claude child pid is missing or invalid');
    }
    if (pidAlive(launch.child_pid)) refuse('RECOVERY_UNKNOWN_LIVE', `recorded Claude pid ${launch.child_pid} is still alive`);
    const expectedTranscript = path.join(store, 'transcripts', `${launch.run_id}-${launch.session_id}.jsonl`);
    const expectedStart = path.join(store, 'transcripts', `${launch.run_id}-${launch.session_id}.session-start.json`);
    if (launch.transcript_path !== expectedTranscript || launch.start_evidence_file !== expectedStart
        || !object(launch.completed) || typeof launch.completed.stream_sha256 !== 'string'
        || typeof launch.completed.selection_sha256 !== 'string'
        || typeof launch.completed.start_sha256 !== 'string'
        || !object(launch.completed.artifact_digests) || !Array.isArray(launch.completed.declared_paths)
        || !Array.isArray(launch.completed.changed_paths)
        || !object(launch.completed.full_output_manifest)
        || typeof launch.saved_native_transcript !== 'string'
        || !Number.isSafeInteger(launch.saved_native_transcript_bytes)
        || launch.saved_native_transcript_bytes <= 0
        || typeof launch.native_transcript_path !== 'string') {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'Claude launch has no completed private transcript evidence');
    }
    if (reservation.reserved_at !== launch.completed.reservation_at
        || !sameValue(launch.binding, requestBinding(scope, launch.run_id, launch.resolution))
        || launch.binding?.run_id !== launch.run_id || launch.binding?.role !== scope.role) {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'original reservation, request or scope binding changed');
    }
    if (fileDigest(expectedStart) !== launch.completed.start_sha256) {
      refuse('RECOVERY_ARTIFACT_ALTERED', 'saved SessionStart evidence changed after completion');
    }
    const resolution = (dependencies.resolveDispatch || pipelineConfig.resolveDispatch)({
      root: scope.worktree, runtime: 'claude', role: ROLES[scope.role],
      signals: scope.signals, dispatch_id: dispatchId,
    });
    if (!sameValue(requestBinding(scope, launch.run_id, resolution), launch.binding)) {
      refuse('RECOVERY_EVIDENCE_INCOMPLETE', 'saved selection differs from the routed selection');
    }
    let verified;
    try {
      verified = await verifyCompletedClaudeLaunch({ session_id: launch.session_id,
        start_evidence_file: expectedStart, transcript_path: expectedTranscript,
        saved_native_transcript: launch.saved_native_transcript,
        original_projects_root: path.join(dependencies.configRoot || process.env.CLAUDE_CONFIG_DIR
          || path.join(process.env.HOME || os.homedir(), '.claude'), 'projects'),
        model: resolution.model, effort: resolution.effort, gsd_role: scope.role,
        worktree: scope.worktree });
    } catch (error) {
      refuse(error.code === 'RUNTIME_EVIDENCE_MISSING' ? 'RECOVERY_EVIDENCE_MISSING' : 'RECOVERY_EVIDENCE_INCOMPLETE',
        `Claude launch evidence cannot be re-verified: ${error.message}`);
    }
    if (verified.applicationEvidence.transcript.sha256 !== launch.completed.stream_sha256
        || verified.applicationEvidence.selection_evidence.transcript.sha256 !== launch.completed.selection_sha256
        || verified.applicationEvidence.selection_evidence.transcript.bytes !== launch.saved_native_transcript_bytes
        || launch.saved_native_transcript_sha256 !== launch.completed.selection_sha256
        || launch.start_evidence_sha256 !== launch.completed.start_sha256
        || JSON.parse(fs.readFileSync(expectedStart, 'utf8')).transcript_path !== launch.native_transcript_path) {
      refuse('RECOVERY_ARTIFACT_ALTERED', 'saved Claude transcripts differ from the completed launch');
    }
    const changed = writerLease.changedSince(launch.tree_snapshot).changed;
    const declared = declaredChanges(verified.result, phaseDir);
    const foreign = changed.filter((item) => !declared.includes(item));
    if (foreign.length) refuse('FOREIGN_EDIT', `phase directory path(s) changed outside the original Claude declaration: ${foreign.join(', ')}`);
    const savedPaths = Object.keys(launch.completed.artifact_digests).sort();
    if (changed.length !== declared.length || changed.some((item, index) => item !== declared[index])
        || !sameValue(launch.completed.declared_paths, declared)
        || !sameValue(launch.completed.changed_paths, changed)
        || savedPaths.length !== declared.length || savedPaths.some((item, index) => item !== declared[index])
        || declared.some((item) => fileDigest(path.join(phaseDir, item)) !== launch.completed.artifact_digests[item])) {
      refuse('RECOVERY_ARTIFACT_ALTERED', 'phase artifacts differ from the final assistant result');
    }
    writerLease.assertFence({ token: leaseHandle.token, epoch: leaseHandle.epoch,
      base_revision: git(scope.worktree, 'rev-parse', 'HEAD') });
    const applied = Object.freeze({ ...verified.applicationEvidence,
      process_id: launch.child_pid,
      ...(typeof launch.runtime_version === 'string' ? { runtime_version: launch.runtime_version } : {}),
    });
    const capabilities = { supportedModels: [resolution.model], supportedEfforts: [resolution.effort],
      observedModel: true, observedEffort: true };
    const adapter = createClaudeDispatchAdapter({ capabilities, host: {
      launchTypedGsd: () => applied,
    } });
    const boundary = createDispatchBoundary({ adapters: { claude: adapter }, recorder,
      requireGsdRole: true, recoverReserved: true });
    const record = await boundary.dispatch({ runtime: 'claude', role: ROLES[scope.role],
      model: resolution.model, effort: resolution.effort, gsd_role: scope.role,
      signals: scope.signals, dispatch_id: dispatchId }, {
      ticket: scope.ticket, phase: scope.phase, run_id: launch.run_id,
      worktreePath: scope.worktree, runtime: 'claude', provider: 'anthropic',
      preRecordValidation: () => validateJudgmentWriter(
        scope, phaseDir, writerLease, leaseHandle, launch.tree_snapshot, launch),
    });
    const output = { result: verified.result, receipt: record.receipt };
    validateJudgmentWriter(scope, phaseDir, writerLease, leaseHandle, launch.tree_snapshot, launch);
    if (!receiptCompliant(output, scope, resolution)) {
      refuse('NONCOMPLIANT_RECEIPT', 'typed GSD dispatch has no compliant exact-role receipt');
    }
    const envelope = ROLES[scope.role] === 'decomposition' ? decompositionEnvelope(scope, store, output) : null;
    return Object.freeze({ role: scope.role, result: output.result, receipt: output.receipt,
      run_id: launch.run_id, dispatch_id: dispatchId, recovered: true,
      ...(envelope ? { envelope } : {}) });
  } finally {
    try { writerLease.release({ token: leaseHandle.token, epoch: leaseHandle.epoch }); }
    catch { }
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--capability-only') return { capabilityOnly: true };
  if (argv.length === 3 && argv[0] === 'recover' && argv[1] === '--dispatch') {
    return { recoverDispatch: safeText(argv[2], 'dispatch id', 128) };
  }
  if (argv.length !== 2 || argv[0] !== '--request-file') refuse('INVALID_INPUT', 'expected --request-file <bounded JSON file>');
  return { requestFile: argv[1] };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.recoverDispatch) {
    process.stdout.write(`${JSON.stringify(await recoverDecomposition(args.recoverDispatch))}\n`);
    return;
  }
  if (args.capabilityOnly) {
    const probe = probeClaudeRuntime();
    if (probe.status !== 'available') {
      process.stdout.write(`${JSON.stringify({ status: 'unavailable', reason: probe.reason || 'runtime_unavailable' })}\n`);
      return;
    }
    try {
      const configRoot = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
      for (const [role, boundaryRole] of Object.entries(ROLES)) {
        pipelineConfig.resolveDispatch({ root: process.cwd(), runtime: 'claude',
          role: boundaryRole, signals: {}, dispatch_id: `capability-${role}` });
        trustedAgent(role, configRoot);
      }
      process.stdout.write(`${JSON.stringify({ status: 'available', runtime_version: probe.runtime_version,
        roles: Object.keys(ROLES), live_execution: 'not_run' })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'unavailable', reason: error.code || 'role_unavailable',
        detail: error.message, live_execution: 'not_run', hint: formatHint(error.code) })}\n`);
    }
    return;
  }
  const stat = fs.lstatSync(args.requestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROMPT) refuse('INVALID_INPUT', 'request file is not bounded and regular');
  const request = JSON.parse(fs.readFileSync(args.requestFile, 'utf8'));
  const scope = canonicalRequest(request);
  process.chdir(scope.worktree);
  const output = await runDecomposition(request);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'FAILED'}: ${error.message}\n`);
    process.stderr.write(`${formatHint(error.code)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ ROLES, canonicalRequest, inlineReferences, trustedAgent, phaseDirectory, parseArguments, runDecomposition, recoverDecomposition, main });
