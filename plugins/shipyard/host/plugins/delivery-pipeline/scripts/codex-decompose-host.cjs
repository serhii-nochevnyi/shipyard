#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexRuntimeHost, installedGsdAgent, normalizeScope } = require('./codex-runtime-host.cjs');
const { launchAgent } = require('./codex-agent.cjs');
const policy = require('./model-policy.cjs');
const { newDispatchId } = require('./dispatch-boundary.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { createRunController, DEFAULT_LEASE_TTL_MS } = require('./run-controller.cjs');
const { formatHint } = require('./refusal-hints.cjs');

const SCHEMA = 'shipyard.codex-decompose-host.v1';
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const ROLES = Object.freeze({
  'gsd-phase-researcher': Object.freeze({ role: 'research', sandbox: 'read-only' }),
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

function createCodexDecomposeHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  if (!path.isAbsolute(scope.worktree)) fail('INVALID_INPUT', 'worktree path must be absolute');
  let stat;
  try { stat = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!stat.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
  const env = options.env || process.env;
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
    async run(rawRequest) {
      const request = requestValue(rawRequest);
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
          const applied = await runtimeHost.launchTypedGsd(selected, { ...context, prompt });
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
      return launchAgent(chosen.role, {
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

async function runCli(argv = process.argv.slice(2), stdout = process.stdout, options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  const parsed = readRequestFile(parseCliArguments(argv));
  const scope = normalizeScope(parsed.scope);
  let worktree;
  try { worktree = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!worktree.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
  const request = parsed.launch;
  const dispatchId = request.dispatch_id || newDispatchId();
  const resolution = policy.resolveDispatch({
    runtime: 'codex', role: ROLES[request.gsd_role].role,
    signals: request.signals, dispatch_id: dispatchId,
  });
  const runStoreDir = options.testRunStoreDir || defaultRunStoreDir(scope, options.testStateRoot);
  const hostStateDir = path.dirname(runStoreDir);
  const controller = createRunController({
    storeDir: runStoreDir,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
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
  let heartbeatError = null;
  const heartbeat = setInterval(() => {
    try { controller.heartbeat(scope.run_id); }
    catch (error) { heartbeatError = error; clearInterval(heartbeat); }
  }, heartbeatMs);
  heartbeat.unref?.();
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
    });
    result = await host.run({ ...request, dispatch_id: dispatchId });
    clearInterval(heartbeat);
    if (heartbeatError) throw heartbeatError;
    controller.assertOwner(scope.run_id);
    controller.complete(scope.run_id, { reason: 'verified typed GSD receipt ' + result.receipt.dispatch_id });
  } catch (error) {
    clearInterval(heartbeat);
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
  }
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = Object.freeze({
  SCHEMA,
  MAX_ARGS_BYTES,
  ROLES,
  defaultRunStoreDir,
  requestValue,
  createCodexDecomposeHost,
  parseCliArguments,
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
