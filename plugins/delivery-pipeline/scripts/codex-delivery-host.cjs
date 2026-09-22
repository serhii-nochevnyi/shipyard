'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCodexRuntimeHost, normalizeScope } = require('./codex-runtime-host.cjs');
const { launchAgent, ROLE_ALIASES } = require('./codex-agent.cjs');
const policy = require('./model-policy.cjs');

const SCHEMA = 'shipyard.codex-delivery-host.v1';
const MAX_ARGS_BYTES = 4 * 1024 * 1024;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message) {
  const error = new Error('codex-delivery-host: ' + message);
  error.code = code;
  throw error;
}

function bind(context, key, value) {
  if (context[key] !== undefined && context[key] !== value) {
    fail('SCOPE_MISMATCH', 'launch context contradicts host-owned ' + key);
  }
  context[key] = value;
}

function requestValue(input) {
  if (!object(input)) fail('INVALID_INPUT', 'delivery request must be an object');
  const allowed = new Set(['role', 'signals', 'context', 'dispatch_id', 'gsd_role']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('INVALID_INPUT', 'unsupported delivery request field ' + key);
  }
  if (typeof input.role !== 'string' || !input.role.trim()) fail('INVALID_INPUT', 'role is required');
  const role = ROLE_ALIASES[input.role] || input.role;
  if (input.signals !== undefined && !object(input.signals)) fail('INVALID_INPUT', 'signals must be an object');
  if (input.context !== undefined && !object(input.context)) fail('INVALID_INPUT', 'context must be an object');
  if (input.dispatch_id !== undefined
      && (typeof input.dispatch_id !== 'string' || !input.dispatch_id.trim())) {
    fail('INVALID_INPUT', 'dispatch_id must be non-empty text');
  }
  return { role, signals: input.signals || {}, context: { ...(input.context || {}) },
    ...(input.dispatch_id ? { dispatch_id: input.dispatch_id } : {}),
    ...(input.gsd_role !== undefined ? { gsd_role: input.gsd_role } : {}) };
}

function createCodexDeliveryHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  if (!path.isAbsolute(scope.worktree)) fail('INVALID_INPUT', 'worktree path must be absolute');
  let worktree;
  try { worktree = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!worktree.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
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
    env: options.env,
    spawn: options.spawn,
    ephemeral: options.ephemeral,
    approveForMe: options.approveForMe,
  });
  if (!runtimeHost || !object(runtimeHost.capabilities) || !runtimeHost.recorder) {
    fail('MISSING_ADAPTER', 'scoped Codex runtime host lacks capabilities or durable recorder');
  }
  for (const field of ['run_id', 'ticket', 'phase', 'worktree', 'runtime', 'provider']) {
    if (runtimeHost.scope[field] !== scope[field]) fail('SCOPE_MISMATCH', 'runtime host scope differs at ' + field);
  }
  const agentDir = options.agentDir;
  const agentManifest = options.agentManifest;
  const env = options.env || process.env;

  return Object.freeze({
    schema: SCHEMA,
    version: 1,
    scope,
    async run(rawRequest) {
      const request = requestValue(rawRequest);
      const context = request.context;
      const prompt = context.prompt || context.task_prompt || context.input;
      if (typeof prompt !== 'string' || !prompt.trim()) fail('INVALID_INPUT', 'context requires a task prompt');
      if (Object.prototype.hasOwnProperty.call(context, 'sandbox_mode')) {
        if (!policy.DYNAMIC_ROLES.includes(request.role) || context.sandbox_mode !== 'workspace-write') {
          fail('CONFLICTING_OVERRIDE', 'sandbox mode is owned by the generated role or delivery host');
        }
      }
      bind(context, 'run_id', scope.run_id);
      bind(context, 'ticket', scope.ticket);
      bind(context, 'phase', scope.phase);
      bind(context, 'worktreePath', scope.worktree);
      bind(context, 'runtime', 'codex');
      bind(context, 'provider', 'openai');
      if (policy.DYNAMIC_ROLES.includes(request.role)) context.sandbox_mode = 'workspace-write';
      return launchAgent(request.role, {
        cwd: scope.worktree,
        flags: new Map(),
        signals: request.signals,
        ...(request.dispatch_id ? { dispatch_id: request.dispatch_id } : {}),
        ...(request.gsd_role !== undefined ? { gsd_role: request.gsd_role, requireGsdRole: true } : {}),
        scope,
        host: runtimeHost,
        capabilities: runtimeHost.capabilities,
        recorder: runtimeHost.recorder,
        controller: runtimeHost.controller,
        agentDir,
        agentManifest,
        env,
        context,
      });
    },
  });
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--args-file'
      || typeof argv[1] !== 'string' || !argv[1].trim()) {
    fail('INVALID_INPUT', 'usage: codex-delivery-host.cjs --args-file <json>');
  }
  return path.resolve(argv[1]);
}

function readRequestFile(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) { fail('INVALID_INPUT', 'cannot stat delivery request: ' + error.message); }
  if (!stat.isFile() || stat.size > MAX_ARGS_BYTES) fail('INVALID_INPUT', 'delivery request is not a bounded regular file');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { fail('INVALID_INPUT', 'cannot read delivery request: ' + error.message); }
  let request;
  try { request = JSON.parse(raw); }
  catch (error) { fail('INVALID_INPUT', 'delivery request is invalid JSON: ' + error.message); }
  if (!object(request) || !object(request.scope)) fail('INVALID_INPUT', 'delivery request requires a scope and request fields');
  const { scope, ...launch } = request;
  return { scope, launch };
}

async function runCli(argv = process.argv.slice(2), stdout = process.stdout) {
  const file = parseCliArguments(argv);
  const request = readRequestFile(file);
  const host = createCodexDeliveryHost({ scope: request.scope });
  const result = await host.run(request.launch);
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

module.exports = Object.freeze({
  SCHEMA,
  MAX_ARGS_BYTES,
  requestValue,
  createCodexDeliveryHost,
  parseCliArguments,
  readRequestFile,
  runCli,
});

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write('codex-delivery-host: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
