'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { CLAUDE_MODEL_ALIASES } = require('./runtime-adapters.cjs');
const { createDurableRecorder } = require('./dispatch-boundary.cjs');
const { registerClaudeWorkflowHost } = require('./claude-workflow-host.cjs');

const SCHEMA = 'shipyard.claude-runtime-host.v1';
const VERSION = 1;
const STREAM_FORMAT = 'stream-json';
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REQUIRED_HELP_MARKERS = Object.freeze(['--model', '--effort', '--output-format', 'stream-json', '--session-id']);
const UNAVAILABLE_CODES = new Set([
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_EVIDENCE_MISSING',
  'RUNTIME_CAPABILITY_MISSING',
  'RUNTIME_AUTH_UNAVAILABLE',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hostError(code, message, details = {}) {
  const error = new Error(`claude-runtime-host: ${message}`);
  error.name = 'ClaudeRuntimeHostError';
  error.code = code;
  error.details = details;
  return error;
}

function fail(code, message, details = {}) {
  throw hostError(code, message, details);
}

function text(value, field, max = 2048) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_INPUT', `${field} must be non-empty text`, { field });
  }
  const result = value.trim();
  if (result.length > max) fail('INVALID_INPUT', `${field} exceeds ${max} characters`, { field });
  return result;
}

function bounded(value, max = 4096) {
  const result = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return result.length > max ? result.slice(0, max) : result;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
}

function freeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function authorityFree(value, field = 'scope', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('INVALID_INPUT', `${field} contains a cycle`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'authority' || key === 'host_authority' || key === 'owner_token'
      || key === 'session_token' || key === 'launch_token'
      || /(?:serialized|host)[_-]?authority/i.test(key)) {
      fail('SERIALIZED_AUTHORITY', `${field}.${key} cannot cross the runtime host boundary`);
    }
    authorityFree(child, `${field}.${key}`, seen);
  }
  seen.delete(value);
}

function scopeValue(scope, names) {
  for (const name of names) {
    if (scope[name] !== undefined && scope[name] !== null) return scope[name];
  }
  return undefined;
}

function normalizeScope(input = {}) {
  if (!object(input)) fail('INVALID_INPUT', 'run scope must be an object');
  authorityFree(input);
  const runId = text(scopeValue(input, ['run_id', 'runId']), 'run_id', 512);
  const ticket = text(scopeValue(input, ['ticket', 'ticket_id']), 'ticket', 512);
  const worktreeValue = scopeValue(input, ['worktree', 'worktreePath', 'worktree_path']);
  const worktree = text(object(worktreeValue) ? scopeValue(worktreeValue, ['path', 'worktree']) : worktreeValue, 'worktree', 4096);
  const phaseValue = scopeValue(input, ['phase', 'phase_id']);
  const phase = object(phaseValue) ? scopeValue(phaseValue, ['phase', 'id', 'number']) : phaseValue;
  if (!Number.isInteger(Number(phase)) || Number(phase) < 1) fail('INVALID_INPUT', 'phase must be a positive integer');
  const runtimeValue = scopeValue(input, ['runtime']);
  const providerValue = scopeValue(input, ['provider']);
  const runtime = runtimeValue === undefined ? 'claude' : text(runtimeValue, 'runtime', 64);
  const provider = providerValue === undefined ? 'anthropic' : text(providerValue, 'provider', 64);
  if (runtime !== 'claude' || provider !== 'anthropic') {
    fail('RUNTIME_PROVIDER_MISMATCH', 'Claude runtime scope must use provider anthropic', { runtime, provider });
  }
  return freeze({
    schema: 'shipyard.claude-run-scope.v1',
    version: 1,
    run_id: runId,
    ticket,
    phase: Number(phase),
    worktree,
    runtime,
    provider,
    ...(scopeValue(input, ['repository', 'repository_id']) !== undefined
      ? { repository: clone(scopeValue(input, ['repository', 'repository_id'])) }
      : {}),
  });
}

function spawnResultText(result) {
  return `${result && result.stdout ? result.stdout : ''}\n${result && result.stderr ? result.stderr : ''}`;
}

function parseJsonOutput(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch (_) {
    return null;
  }
}

function unavailableProbe(executable, reason, extra = {}) {
  return Object.freeze({
    schema: 'shipyard.claude-runtime-probe.v1',
    version: 1,
    status: 'unavailable',
    executable,
    reason,
    ...extra,
  });
}

function probeClaudeRuntime(options = {}) {
  const executable = typeof options.executable === 'string' && options.executable.trim()
    ? options.executable.trim() : 'claude';
  const runner = options.spawnSync || spawnSync;
  if (typeof runner !== 'function') fail('INVALID_INPUT', 'spawnSync must be a function');
  let version;
  try {
    version = runner(executable, ['--version'], { encoding: 'utf8', timeout: options.timeoutMs || 10000 });
  } catch (error) {
    return unavailableProbe(executable, 'runtime_missing', { detail: bounded(error.message) });
  }
  if (!version || version.error || version.status !== 0) {
    return unavailableProbe(executable, 'runtime_missing', { detail: bounded(spawnResultText(version) || version && version.error && version.error.message) });
  }
  let help;
  try {
    help = runner(executable, ['--help'], { encoding: 'utf8', timeout: options.timeoutMs || 10000 });
  } catch (error) {
    return unavailableProbe(executable, 'capability_help_unavailable', { detail: bounded(error.message) });
  }
  const helpText = spawnResultText(help);
  const missing = REQUIRED_HELP_MARKERS.filter((marker) => !helpText.includes(marker));
  if (!help || help.error || help.status !== 0 || missing.length) {
    return unavailableProbe(executable, 'runtime_capability_missing', {
      detail: bounded(spawnResultText(help) || help && help.error && help.error.message), missing,
    });
  }
  let auth = null;
  if (options.checkAuth !== false) {
    try {
      auth = runner(executable, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: options.timeoutMs || 10000 });
    } catch (error) {
      return unavailableProbe(executable, 'runtime_auth_unavailable', { detail: bounded(error.message) });
    }
    const authJson = parseJsonOutput(auth && auth.stdout);
    if (!auth || auth.error || auth.status !== 0 || !authJson || authJson.loggedIn !== true) {
      return unavailableProbe(executable, 'runtime_auth_unavailable', {
        detail: bounded(spawnResultText(auth) || auth && auth.error && auth.error.message),
      });
    }
  }
  const versionText = bounded(version.stdout || version.stderr, 256);
  return Object.freeze({
    schema: 'shipyard.claude-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable,
    runtime_version: versionText,
    auth_method: auth && parseJsonOutput(auth.stdout) && parseJsonOutput(auth.stdout).authMethod,
    capabilities: Object.freeze({
      supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
      supportedEfforts: EFFORTS,
      observedModel: true,
      observedEffort: true,
      streamFormat: STREAM_FORMAT,
    }),
  });
}

function nestedValues(record, names, output = []) {
  if (!object(record)) return output;
  for (const name of names) {
    if (typeof record[name] === 'string' && record[name].trim()) output.push(record[name].trim());
  }
  for (const key of ['message', 'result', 'response', 'data', 'metadata']) {
    if (object(record[key])) nestedValues(record[key], names, output);
  }
  return output;
}

function parseClaudeStream(raw) {
  if (typeof raw !== 'string') fail('RUNTIME_EVIDENCE_MISSING', 'Claude stream output must be text');
  const records = [];
  const sessions = new Set();
  const models = new Set();
  const efforts = new Set();
  let result = null;
  let assistantCount = 0;
  let usageCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail('RUNTIME_EVIDENCE_INVALID', `Claude stream contains invalid JSON: ${error.message}`);
    }
    if (!object(record)) fail('RUNTIME_EVIDENCE_INVALID', 'Claude stream records must be objects');
    if (records.length >= 10000) fail('RUNTIME_EVIDENCE_INVALID', 'Claude stream exceeds 10000 records');
    records.push(record);
    for (const value of nestedValues(record, ['session_id', 'sessionId'])) sessions.add(value);
    for (const value of nestedValues(record, ['model', 'model_id', 'modelId', 'applied_model'])) models.add(value);
    for (const value of nestedValues(record, ['effort', 'reasoning_effort', 'reasoningEffort', 'applied_effort'])) efforts.add(value);
    if (record.type === 'assistant' || record.message && record.message.role === 'assistant') assistantCount++;
    if (record.usage || record.message && record.message.usage) usageCount++;
    if (record.type === 'result' || record.subtype === 'success' || record.result && !object(record.result)) result = record;
  }
  if (!records.length) fail('RUNTIME_EVIDENCE_MISSING', 'Claude stream contained no JSON records');
  if (!sessions.size) fail('RUNTIME_EVIDENCE_MISSING', 'Claude stream did not report a session identity');
  if (sessions.size > 1) fail('RUNTIME_EVIDENCE_INVALID', 'Claude stream reported conflicting session identities');
  return Object.freeze({
    records: freeze(records),
    session_id: [...sessions][0],
    models: [...models],
    efforts: [...efforts],
    result,
    assistant_count: assistantCount,
    usage_count: usageCount,
  });
}

function modelAlias(value) {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  for (const alias of Object.values(CLAUDE_MODEL_ALIASES)) {
    if (lower === alias || lower.includes(`claude-${alias}`) || lower.includes(`-${alias}-`)
      || lower.endsWith(`-${alias}`)) return alias;
  }
  return undefined;
}

function observedSelection(parsed, expectedModel, expectedEffort) {
  const observedModels = [...new Set(parsed.models.map(modelAlias).filter(Boolean))];
  if (!observedModels.length) fail('RUNTIME_EVIDENCE_MISSING', 'Claude stream did not report an observed model');
  if (observedModels.some((value) => value !== expectedModel)) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'Claude stream reported a model different from the routed selection', {
      expected: expectedModel, observed: observedModels,
    });
  }
  const observedEfforts = [...new Set(parsed.efforts.filter((value) => EFFORTS.includes(value)))];
  if (!observedEfforts.length) fail('RUNTIME_EVIDENCE_MISSING', 'Claude stream did not report an observed effort');
  if (observedEfforts.some((value) => value !== expectedEffort)) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'Claude stream reported an effort different from the routed selection', {
      expected: expectedEffort, observed: observedEfforts,
    });
  }
  return { model: expectedModel, effort: expectedEffort };
}

function writeTranscript(directory, scope, sessionId, stdout) {
  if (directory === undefined || directory === null) return null;
  const root = path.resolve(text(directory, 'transcriptDir', 4096));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const safeRun = scope.run_id.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(root, `${safeRun}-${safeSession}.jsonl`);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const bytes = Buffer.from(stdout, 'utf8');
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
  return Object.freeze({
    path: file,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function streamText(parsed) {
  const candidates = [];
  for (const record of parsed.records) {
    for (const value of [record.result, record.text, record.content, record.message && record.message.content]) {
      if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
    }
  }
  return candidates.at(-1) || '';
}

function createClaudeCliLauncher(options = {}) {
  const scope = normalizeScope(options.scope || {});
  const executable = typeof options.executable === 'string' && options.executable.trim()
    ? options.executable.trim() : 'claude';
  const spawnImpl = options.spawn || spawn;
  if (typeof spawnImpl !== 'function') fail('INVALID_INPUT', 'spawn must be a function');
  const transcriptDir = options.transcriptDir;
  const environment = options.env && object(options.env) ? { ...options.env } : {};
  const uuid = typeof options.uuid === 'function' ? options.uuid : crypto.randomUUID;

  return async function launch(prompt, launchOptions = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') fail('INVALID_INPUT', 'Claude prompt must be non-empty text');
    const model = text(launchOptions.model, 'model', 128);
    const effort = text(launchOptions.effort, 'effort', 32);
    if (!Object.values(CLAUDE_MODEL_ALIASES).includes(model)) fail('RUNTIME_CAPABILITY_MISSING', `unsupported Claude model alias ${model}`);
    if (!EFFORTS.includes(effort)) fail('RUNTIME_CAPABILITY_MISSING', `unsupported Claude effort ${effort}`);
    const sessionId = text(launchOptions.session_id || launchOptions.sessionId || uuid(), 'session_id', 128);
    const args = [
      '--print', '--input-format', STREAM_FORMAT, '--output-format', STREAM_FORMAT,
      '--verbose', '--model', model, '--effort', effort, '--session-id', sessionId,
      '--permission-prompts', 'none',
    ];
    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd: scope.worktree,
        env: { ...process.env, ...environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail('RUNTIME_UNAVAILABLE', `Claude process could not start: ${error.message}`);
    }
    if (!child || !child.stdout || !child.stderr || !child.stdin || typeof child.on !== 'function') {
      fail('RUNTIME_UNAVAILABLE', 'Claude launcher returned an invalid child process');
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
      child.stdin.end();
    } catch (error) {
      try { child.kill(); } catch (_) {}
      fail('RUNTIME_UNAVAILABLE', `Claude process input failed: ${error.message}`);
    }
    const exit = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on('error', (error) => done({ error }));
      child.on('close', (code, signal) => done({ code, signal }));
      child.on('exit', (code, signal) => done({ code, signal }));
    });
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    const rawStderr = Buffer.concat(stderr).toString('utf8');
    if (exit.error) fail('RUNTIME_UNAVAILABLE', `Claude process failed: ${exit.error.message}`);
    if (exit.code !== 0) fail('RUNTIME_UNAVAILABLE', `Claude process exited ${exit.code === null ? 'without a code' : exit.code}`, { stderr: bounded(rawStderr) });
    let parsed;
    try {
      parsed = parseClaudeStream(rawStdout);
      const selection = observedSelection(parsed, model, effort);
      if (parsed.session_id !== sessionId) {
        fail('RUNTIME_EVIDENCE_MISMATCH', 'Claude stream session identity differs from the requested launch session', { expected: sessionId, observed: parsed.session_id });
      }
      const transcript = writeTranscript(transcriptDir, scope, parsed.session_id, rawStdout);
      const result = {
        status: 'completed',
        summary: bounded(streamText(parsed), 500) || 'Claude Code completed the scoped launch',
        output: parsed.result && parsed.result.structured_output !== undefined
          ? parsed.result.structured_output : streamText(parsed),
      };
      const evidence = {
        launch_id: `claude-${parsed.session_id}`,
        session_id: parsed.session_id,
        process_id: Number.isInteger(child.pid) ? child.pid : undefined,
        runtime_version: options.runtime_version || undefined,
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: selection.model,
        observed_effort: selection.effort,
        stream_evidence: {
          format: STREAM_FORMAT,
          records: parsed.records.length,
          assistant_messages: parsed.assistant_count,
          usage_records: parsed.usage_count,
          models: parsed.models,
          efforts: parsed.efforts,
        },
        ...(transcript ? { transcript } : {}),
        ...(launchOptions.gsd_role ? {
          gsd_role: launchOptions.gsd_role,
          gsd_launch_mechanism: 'typed-gsd-callback',
        } : {}),
      };
      const resultWithEvidence = Object.freeze({ ...result, applicationEvidence: freeze(evidence) });
      return resultWithEvidence;
    } catch (error) {
      if (error && error.name === 'ClaudeRuntimeHostError') throw error;
      fail('RUNTIME_EVIDENCE_INVALID', error.message);
    }
  };
}

function createClaudeRuntimeHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'runtime host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  const controller = options.controller;
  const runId = options.run_id || options.runId || scope.run_id;
  const probe = options.probe || probeClaudeRuntime({ executable: options.executable, checkAuth: options.checkAuth });
  if (!object(probe) || !['available', 'unavailable'].includes(probe.status)) fail('INVALID_INPUT', 'runtime probe has an invalid status');
  if (probe.status !== 'available') {
    if (controller && typeof controller.markUnavailable === 'function') {
      controller.markUnavailable(runId, { reason: probe.reason || 'Claude runtime unavailable' });
    }
    fail('RUNTIME_UNAVAILABLE', probe.detail || `Claude runtime unavailable: ${probe.reason || 'unknown'}`, { probe });
  }
  if (controller && typeof controller.assertOwner === 'function') controller.assertOwner(runId);
  const recorder = options.recorder || createDurableRecorder(
    options.recorderDir || path.join(scope.worktree, '.planning', 'graph', 'receipts', 'claude'),
  );
  const capabilities = freeze({
    ...(probe.capabilities || {}),
    supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
    supportedEfforts: EFFORTS,
    observedModel: true,
    observedEffort: true,
  });
  const evidence = new WeakMap();
  const launcher = createClaudeCliLauncher({
    scope,
    executable: probe.executable || options.executable,
    spawn: options.spawn,
    uuid: options.uuid,
    env: options.env,
    transcriptDir: options.transcriptDir || path.join(scope.worktree, '.planning', 'graph', 'transcripts', 'claude'),
    runtime_version: probe.runtime_version,
  });
  const launch = async (prompt, launchOptions = {}, gsdRole) => {
    if (controller && typeof controller.assertOwner === 'function') controller.assertOwner(runId);
    try {
      const result = await launcher(prompt, {
        ...launchOptions,
        ...(gsdRole ? { gsd_role: gsdRole } : {}),
      });
      evidence.set(result, result.applicationEvidence);
      return result;
    } catch (error) {
      if (controller && UNAVAILABLE_CODES.has(error && error.code) && typeof controller.markUnavailable === 'function') {
        controller.markUnavailable(runId, { reason: error.message });
      }
      throw error;
    }
  };
  const host = {
    schema: SCHEMA,
    version: VERSION,
    scope,
    runScope: scope,
    run_id: runId,
    controller,
    runtime_version: probe.runtime_version,
    capabilities,
    recorder,
    agent: (prompt, launchOptions) => launch(prompt, launchOptions),
    typedGsdCallback: (prompt, launchOptions, gsdRole) => launch(prompt, launchOptions, gsdRole),
    applicationEvidence: ({ result }) => {
      const value = evidence.get(result);
      if (!value) fail('RUNTIME_EVIDENCE_MISSING', 'Claude application evidence is not bound to the launched result');
      return value;
    },
    register() {
      return registerClaudeWorkflowHost(host);
    },
  };
  return Object.freeze(host);
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv)) fail('INVALID_INPUT', 'CLI arguments must be an array');
  const values = { capabilityOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--capability-only') {
      if (values.capabilityOnly) fail('INVALID_INPUT', '--capability-only may be provided only once');
      values.capabilityOnly = true;
      continue;
    }
    if (flag === '--executable') {
      const value = argv[++index];
      if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', '--executable requires a value');
      values.executable = value;
      continue;
    }
    fail('INVALID_INPUT', `unknown CLI argument ${JSON.stringify(flag)}`);
  }
  if (!values.capabilityOnly) fail('INVALID_INPUT', '--capability-only is required for the capability probe');
  return values;
}

if (require.main === module) {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(probeClaudeRuntime({ executable: args.executable }))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: 'shipyard.claude-runtime-probe.v1', version: 1, status: 'unavailable', reason: error.code || 'probe_failed', detail: error.message })}\n`);
    process.exitCode = 0;
  }
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  STREAM_FORMAT,
  EFFORTS,
  normalizeScope,
  probeClaudeRuntime,
  parseClaudeStream,
  observedSelection,
  writeTranscript,
  createClaudeCliLauncher,
  createClaudeRuntimeHost,
});
