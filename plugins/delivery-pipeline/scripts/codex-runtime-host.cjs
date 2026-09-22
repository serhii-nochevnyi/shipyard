'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { CODEX_MODEL_IDS } = require('./runtime-adapters.cjs');
const { createDurableRecorder } = require('./dispatch-boundary.cjs');

const SCHEMA = 'shipyard.codex-runtime-host.v1';
const VERSION = 1;
const STREAM_FORMAT = 'jsonl';
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REQUIRED_HELP_MARKERS = Object.freeze(['--json', '--model', '--config', '--cd', '--sandbox']);
const NATIVE_SESSION_MAX_BYTES = 128 * 1024 * 1024;
const NATIVE_SESSION_WAIT_MS = 5000;
const UNAVAILABLE_CODES = new Set([
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_EVIDENCE_MISSING',
  'RUNTIME_EVIDENCE_INVALID',
  'RUNTIME_EVIDENCE_MISMATCH',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hostError(code, message, details = {}) {
  const error = new Error('codex-runtime-host: ' + message);
  error.name = 'CodexRuntimeHostError';
  error.code = code;
  error.details = details;
  return error;
}

function fail(code, message, details = {}) {
  throw hostError(code, message, details);
}

function text(value, field, max = 2048) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_INPUT', field + ' must be non-empty text', { field });
  }
  const result = value.trim();
  if (result.length > max) fail('INVALID_INPUT', field + ' exceeds ' + max + ' characters', { field });
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
  if (seen.has(value)) fail('INVALID_INPUT', field + ' contains a cycle');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'authority' || key === 'host_authority' || key === 'owner_token'
      || key === 'session_token' || key === 'launch_token'
      || /(?:serialized|host)[_-]?authority/i.test(key)) {
      fail('SERIALIZED_AUTHORITY', field + '.' + key + ' cannot cross the runtime host boundary');
    }
    authorityFree(child, field + '.' + key, seen);
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
  const runtime = text(scopeValue(input, ['runtime']) || 'codex', 'runtime', 64);
  const provider = text(scopeValue(input, ['provider']) || 'openai', 'provider', 64);
  if (runtime !== 'codex' || provider !== 'openai') {
    fail('RUNTIME_PROVIDER_MISMATCH', 'Codex runtime scope must use provider openai', { runtime, provider });
  }
  const repository = scopeValue(input, ['repository', 'repository_id']);
  return freeze({
    schema: 'shipyard.codex-run-scope.v1',
    version: 1,
    run_id: runId,
    ticket,
    phase: Number(phase),
    worktree,
    runtime,
    provider,
    ...(repository !== undefined ? { repository: clone(repository) } : {}),
  });
}

function spawnResultText(result) {
  return (result && result.stdout ? result.stdout : '') + '\n'
    + (result && result.stderr ? result.stderr : '');
}

function parseJsonOutput(value) {
  try { return JSON.parse(String(value || '').trim()); } catch (_) { return null; }
}

function unavailableProbe(executable, reason, extra = {}) {
  return Object.freeze({
    schema: 'shipyard.codex-runtime-probe.v1',
    version: 1,
    status: 'unavailable',
    executable,
    reason,
    ...extra,
  });
}

function readCapabilities(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    fail('RUNTIME_CAPABILITY_MISSING', 'cannot read Codex capability evidence: ' + error.message);
  }
  if (!object(parsed)
      || !Array.isArray(parsed.supportedModels) || !parsed.supportedModels.length
      || !Array.isArray(parsed.supportedEfforts) || !parsed.supportedEfforts.length) {
    fail('RUNTIME_CAPABILITY_MISSING', 'Codex capability evidence must list supportedModels and supportedEfforts');
  }
  if (parsed.supportedSelections !== undefined && !Array.isArray(parsed.supportedSelections)) {
    fail('RUNTIME_CAPABILITY_MISSING', 'Codex supportedSelections must be an array');
  }
  return parsed;
}

function capabilitiesFrom(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'capabilities')
      && options.capabilities !== undefined) {
    if (!object(options.capabilities)) fail('RUNTIME_CAPABILITY_MISSING', 'Codex capabilities must be an object');
    return clone(options.capabilities);
  }
  const file = options.capabilitiesFile
    || process.env.SHIPYARD_CODEX_CAPABILITIES_FILE
    || (process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'shipyard', 'codex-capabilities.json'));
  if (!file) fail('RUNTIME_CAPABILITY_MISSING', 'explicit Codex capability evidence is required');
  return readCapabilities(file);
}

function probeCodexRuntime(options = {}) {
  const executable = typeof options.executable === 'string' && options.executable.trim()
    ? options.executable.trim() : 'codex';
  const runner = options.spawnSync || spawnSync;
  if (typeof runner !== 'function') fail('INVALID_INPUT', 'spawnSync must be a function');
  let capabilities;
  try {
    capabilities = capabilitiesFrom(options);
  } catch (error) {
    return unavailableProbe(executable, 'capability_evidence_missing', { detail: bounded(error.message) });
  }
  let version;
  try {
    version = runner(executable, ['--version'], { encoding: 'utf8', timeout: options.timeoutMs || 10000 });
  } catch (error) {
    return unavailableProbe(executable, 'runtime_missing', { detail: bounded(error.message) });
  }
  if (!version || version.error || version.status !== 0) {
    return unavailableProbe(executable, 'runtime_missing', {
      detail: bounded(spawnResultText(version) || version && version.error && version.error.message),
    });
  }
  let help;
  try {
    help = runner(executable, ['exec', '--help'], { encoding: 'utf8', timeout: options.timeoutMs || 10000 });
  } catch (error) {
    return unavailableProbe(executable, 'capability_help_unavailable', { detail: bounded(error.message) });
  }
  const helpText = spawnResultText(help);
  const missing = REQUIRED_HELP_MARKERS.filter((marker) => !helpText.includes(marker));
  if (!help || help.error || help.status !== 0 || missing.length) {
    return unavailableProbe(executable, 'runtime_capability_missing', {
      detail: bounded(spawnResultText(help) || help && help.error && help.error.message),
      missing,
    });
  }
  const runtimeCapabilities = {
    ...capabilities,
    supportedModels: [...capabilities.supportedModels],
    supportedEfforts: [...capabilities.supportedEfforts],
    observedModel: true,
    observedEffort: true,
    jsonl: true,
    explicitModel: true,
    explicitReasoningEffort: true,
  };
  if (Array.isArray(capabilities.supportedSelections)) {
    runtimeCapabilities.supportedSelections = capabilities.supportedSelections.map(clone);
  }
  return freeze({
    schema: 'shipyard.codex-runtime-probe.v1',
    version: 1,
    status: 'available',
    executable,
    runtime_version: bounded(version.stdout || version.stderr, 256),
    capabilities: runtimeCapabilities,
  });
}

function parseCodexStream(raw) {
  if (typeof raw !== 'string') fail('RUNTIME_EVIDENCE_INVALID', 'Codex JSONL output must be text');
  const records = [];
  const sessions = new Set();
  let turnCount = 0;
  let usageCount = 0;
  let failure = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch (error) { fail('RUNTIME_EVIDENCE_INVALID', 'Codex output contains invalid JSON: ' + error.message); }
    if (!object(record)) fail('RUNTIME_EVIDENCE_INVALID', 'Codex JSONL records must be objects');
    if (records.length >= 10000) fail('RUNTIME_EVIDENCE_INVALID', 'Codex JSONL output exceeds 10000 records');
    records.push(record);
    if (record.type === 'thread.started' && typeof record.thread_id === 'string' && record.thread_id.trim()) {
      sessions.add(record.thread_id.trim());
    }
    if (record.type === 'turn.completed') {
      turnCount++;
      if (object(record.usage)) usageCount++;
    }
    if (record.type === 'turn.failed' || record.type === 'error') {
      failure = record.error && record.error.message || record.message || 'Codex turn failed';
    }
  }
  if (!records.length) fail('RUNTIME_EVIDENCE_MISSING', 'Codex output contained no JSON records');
  if (!sessions.size) fail('RUNTIME_EVIDENCE_MISSING', 'Codex output did not report a thread identity');
  if (sessions.size > 1) fail('RUNTIME_EVIDENCE_INVALID', 'Codex output reported conflicting thread identities');
  if (!turnCount || !usageCount) fail('RUNTIME_EVIDENCE_MISSING', 'Codex output did not report a completed turn with usage');
  if (failure) fail('RUNTIME_EVIDENCE_INVALID', failure);
  return freeze({
    records: freeze(records),
    session_id: [...sessions][0],
    turns: turnCount,
    usage_records: usageCount,
  });
}

function parseNativeCodexTranscript(raw, expectedSessionId) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > NATIVE_SESSION_MAX_BYTES) {
    fail('RUNTIME_EVIDENCE_INVALID', 'Codex native session transcript is missing or exceeds the size limit');
  }
  const pairs = new Set();
  const models = new Set();
  const efforts = new Set();
  let provider = null;
  let sessionMetaId = null;
  let turnContexts = 0;
  let recordCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (++recordCount > 200000) fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript exceeds the record limit');
    let record;
    try { record = JSON.parse(line); }
    catch (error) { fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript contains invalid JSON: ' + error.message); }
    if (!object(record)) fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript records must be objects');
    if (record.type === 'session_meta') {
      const payload = record.payload;
      if (!object(payload)) fail('RUNTIME_EVIDENCE_INVALID', 'Codex session metadata has no payload');
      const candidateId = typeof payload.id === 'string' ? payload.id : payload.session_id;
      if (typeof candidateId !== 'string' || candidateId !== expectedSessionId) {
        fail('RUNTIME_EVIDENCE_MISMATCH', 'Codex native transcript belongs to a different session', {
          expected: expectedSessionId, observed: candidateId,
        });
      }
      if (sessionMetaId && sessionMetaId !== candidateId) {
        fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript contains conflicting session identities');
      }
      sessionMetaId = candidateId;
      const candidateProvider = payload.model_provider || payload.modelProvider;
      if (typeof candidateProvider === 'string' && candidateProvider.trim()) {
        if (provider && provider !== candidateProvider) fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript contains conflicting providers');
        provider = candidateProvider;
      }
    }
    if (record.type === 'turn_context' && object(record.payload)) {
      const model = record.payload.model;
      const effort = record.payload.effort || record.payload.reasoning_effort;
      if (model === undefined && effort === undefined) continue;
      if (typeof model !== 'string' || !model.trim() || typeof effort !== 'string' || !effort.trim()) {
        fail('RUNTIME_EVIDENCE_MISSING', 'Codex turn context does not identify both model and reasoning effort');
      }
      models.add(model.trim());
      efforts.add(effort.trim());
      pairs.add(JSON.stringify({ model: model.trim(), effort: effort.trim() }));
      turnContexts++;
    }
  }
  if (!sessionMetaId) fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript has no session metadata');
  if (provider !== 'openai') fail('RUNTIME_EVIDENCE_MISMATCH', 'Codex native transcript did not attest the OpenAI provider', { observed: provider });
  if (!turnContexts) fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript has no model/effort turn context');
  return freeze({
    session_id: sessionMetaId,
    provider,
    models: [...models],
    efforts: [...efforts],
    selections: [...pairs].map((pair) => JSON.parse(pair)),
    turn_contexts: turnContexts,
    records: recordCount,
    sha256: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
  });
}

function observedSelection(parsed, expectedModel, expectedEffort, invocation = {}, nativeEvidence = {}) {
  if (invocation.model !== expectedModel || invocation.effort !== expectedEffort) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'Codex invocation did not carry the resolved model and reasoning effort', {
      expected: { model: expectedModel, effort: expectedEffort },
      actual: invocation,
    });
  }
  if (!object(nativeEvidence)
      || nativeEvidence.session_id !== parsed.session_id
      || nativeEvidence.provider !== 'openai'
      || !Array.isArray(nativeEvidence.selections)
      || !nativeEvidence.selections.length) {
    fail('RUNTIME_EVIDENCE_MISSING', 'Codex native session evidence is not bound to the completed CLI session');
  }
  const mismatches = nativeEvidence.selections.filter((selection) => !object(selection)
    || selection.model !== expectedModel || selection.effort !== expectedEffort);
  if (mismatches.length) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'Codex native transcript reported a different model or reasoning effort', {
      expected: { model: expectedModel, effort: expectedEffort }, observed: mismatches,
    });
  }
  return Object.freeze({
    model: expectedModel,
    effort: expectedEffort,
    source: 'codex-native-session-transcript',
  });
}

function sessionDirectory(root, date) {
  return path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
}

function nativeSessionCandidates(root, sessionId, now = new Date()) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(sessionId)) {
    fail('RUNTIME_EVIDENCE_INVALID', 'Codex thread identity is not a safe session identifier');
  }
  const directories = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    directories.push(sessionDirectory(root, date));
  }
  const files = [];
  for (const directory of new Set(directories)) {
    let names;
    try { names = fs.readdirSync(directory); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      fail('RUNTIME_EVIDENCE_INVALID', 'cannot inspect Codex session directory: ' + error.message);
    }
    for (const name of names) {
      if (name === sessionId + '.jsonl' || name.endsWith('-' + sessionId + '.jsonl')) files.push(path.join(directory, name));
    }
  }
  return files;
}

async function readNativeCodexSession(sessionId, options = {}) {
  const env = options.env && object(options.env) ? options.env : {};
  const codexHome = env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsRoot = path.join(path.resolve(codexHome), 'sessions');
  const deadline = Date.now() + (options.waitMs === undefined ? NATIVE_SESSION_WAIT_MS : options.waitMs);
  let file = null;
  while (Date.now() <= deadline) {
    const candidates = nativeSessionCandidates(sessionsRoot, sessionId, options.now || new Date());
    if (candidates.length > 1) fail('RUNTIME_EVIDENCE_INVALID', 'Codex session identity matched multiple native transcripts');
    if (candidates.length === 1) { file = candidates[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  if (!file) fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript was not found for the launched session');
  let before;
  try { before = fs.statSync(file); }
  catch (error) { fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript cannot be read: ' + error.message); }
  if (!before.isFile() || before.size > NATIVE_SESSION_MAX_BYTES) {
    fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript is not a bounded regular file');
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript cannot be read: ' + error.message); }
  let after;
  try { after = fs.statSync(file); }
  catch (error) { fail('RUNTIME_EVIDENCE_MISSING', 'Codex native transcript disappeared: ' + error.message); }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== Buffer.byteLength(raw, 'utf8')) {
    fail('RUNTIME_EVIDENCE_INVALID', 'Codex native transcript changed while being verified');
  }
  const parsed = parseNativeCodexTranscript(raw, sessionId);
  return freeze({
    schema: 'shipyard.codex-native-session-evidence.v1',
    version: 1,
    session_id: parsed.session_id,
    provider: parsed.provider,
    models: parsed.models,
    efforts: parsed.efforts,
    selections: parsed.selections,
    turn_contexts: parsed.turn_contexts,
    records: parsed.records,
    bytes: after.size,
    sha256: parsed.sha256,
    file: path.basename(file),
  });
}

function writeTranscript(directory, scope, sessionId, stdout) {
  if (directory === undefined || directory === null) return null;
  const root = path.resolve(text(directory, 'transcriptDir', 4096));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const safeRun = scope.run_id.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(root, safeRun + '-' + safeSession + '.jsonl');
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
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

function generatedInstructions(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    fail('STALE_GENERATED_AGENT', 'Codex generated agent content is missing');
  }
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith('developer_instructions ='));
  if (start < 0) fail('STALE_GENERATED_AGENT', 'Codex generated agent lacks developer instructions');
  const first = lines[start].trim();
  const marker = 'developer_instructions =';
  const value = first.slice(first.indexOf(marker) + marker.length).trim();
  if (!value.startsWith("'''")) fail('STALE_GENERATED_AGENT', 'Codex generated instructions must use the emitted multiline form');
  const closing = lines.slice(start + 1).findIndex((line) => line.trim() === "'''");
  if (closing < 0) fail('STALE_GENERATED_AGENT', 'Codex generated instructions are unterminated');
  const body = lines.slice(start + 1, start + 1 + closing).join('\n').trim();
  if (!body) fail('STALE_GENERATED_AGENT', 'Codex generated instructions are empty');
  return body;
}

function launchPrompt(prompt, content) {
  if (typeof prompt !== 'string' || !prompt.trim()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    fail('INVALID_INPUT', 'prompt must be non-empty text without unsupported control characters');
  }
  const base = prompt.trim();
  if (base.length > 1024 * 1024) fail('INVALID_INPUT', 'prompt exceeds 1048576 characters');
  if (!content) return base;
  return generatedInstructions(content) + '\n\n' + base;
}

function createCodexCliLauncher(options = {}) {
  const scope = normalizeScope(options.scope || {});
  const executable = typeof options.executable === 'string' && options.executable.trim()
    ? options.executable.trim() : 'codex';
  const spawnImpl = options.spawn || spawn;
  if (typeof spawnImpl !== 'function') fail('INVALID_INPUT', 'spawn must be a function');
  const transcriptDir = options.transcriptDir;
  const environment = options.env && object(options.env) ? { ...options.env } : {};
  const capabilities = options.capabilities || {};

  return async function launch(prompt, launchOptions = {}) {
    if (!object(launchOptions)) fail('INVALID_INPUT', 'Codex launch options must be an object');
    const model = text(launchOptions.model, 'model', 256);
    const effort = text(launchOptions.effort || launchOptions.reasoning_effort, 'effort', 32);
    if (!Object.values(CODEX_MODEL_IDS).includes(model)
        || !Array.isArray(capabilities.supportedModels) || !capabilities.supportedModels.includes(model)) {
      fail('RUNTIME_CAPABILITY_MISSING', 'Codex host does not support model ' + model);
    }
    if (!EFFORTS.includes(effort)
        || !Array.isArray(capabilities.supportedEfforts) || !capabilities.supportedEfforts.includes(effort)) {
      fail('RUNTIME_CAPABILITY_MISSING', 'Codex host does not support reasoning effort ' + effort);
    }
    const content = launchOptions.agent_file_content;
    if (content !== undefined) {
      const actualDigest = crypto.createHash('sha256').update(content).digest('hex');
      if (actualDigest !== launchOptions.agent_file_digest) {
        fail('STALE_GENERATED_AGENT', 'Codex static handoff digest does not match its immutable content');
      }
    }
    const sandbox = launchOptions.sandbox_mode || launchOptions.sandbox;
    if (!['read-only', 'workspace-write'].includes(sandbox)) {
      fail('INVALID_INPUT', 'Codex launch requires an explicit read-only or workspace-write sandbox');
    }
    const args = [
      'exec', '--json', '--model', model,
      '--config', 'model_reasoning_effort="' + effort + '"',
      '--config', 'model_provider="openai"',
      '--config', 'forced_login_method="chatgpt"',
      '--cd', scope.worktree, '--ignore-user-config',
    ];
    args.push('--sandbox', sandbox);
    if (options.ephemeral === true) args.push('--ephemeral');
    if (options.approveForMe === true || launchOptions.approve_for_me === true) args.push('--approve-for-me');
    args.push('-');
    const env = { ...process.env, ...environment };
    for (const key of [
      'CODEX_MODEL', 'CODEX_MODEL_REASONING_EFFORT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
      'OPENAI_API_KEY', 'CODEX_API_KEY',
    ]) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[key];
    }
    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd: scope.worktree,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail('RUNTIME_UNAVAILABLE', 'Codex process could not start: ' + error.message);
    }
    if (!child || !child.stdout || !child.stderr || !child.stdin || typeof child.on !== 'function') {
      fail('RUNTIME_UNAVAILABLE', 'Codex launcher returned an invalid child process');
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    try {
      child.stdin.write(launchPrompt(prompt, content));
      child.stdin.end();
    } catch (error) {
      try { child.kill(); } catch (_) {}
      fail('RUNTIME_UNAVAILABLE', 'Codex process input failed: ' + error.message);
    }
    const exit = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.on('error', (error) => finish({ error }));
      child.on('close', (code, signal) => finish({ code, signal }));
      child.on('exit', (code, signal) => finish({ code, signal }));
    });
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    const rawStderr = Buffer.concat(stderr).toString('utf8');
    if (exit.error) fail('RUNTIME_UNAVAILABLE', 'Codex process failed: ' + exit.error.message);
    if (exit.code !== 0) {
      fail('RUNTIME_UNAVAILABLE', 'Codex process exited ' + (exit.code === null ? 'without a code' : exit.code), {
        stderr: bounded(rawStderr),
      });
    }
    let parsed;
    try {
      parsed = parseCodexStream(rawStdout);
      const nativeEvidence = await readNativeCodexSession(parsed.session_id, { env });
      const selection = observedSelection(parsed, model, effort, {
        model: args[args.indexOf('--model') + 1],
        effort: (args.find((value) => value.startsWith('model_reasoning_effort=')) || '').match(/^model_reasoning_effort="([^"]+)"$/)?.[1],
      }, nativeEvidence);
      const transcript = writeTranscript(transcriptDir, scope, parsed.session_id, rawStdout);
      const commandDigest = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
      const runtimeEvidence = {
        schema: 'shipyard.codex-runtime-evidence.v1',
        version: 1,
        runtime: 'codex',
        provider: 'openai',
        run_id: scope.run_id,
        ticket: scope.ticket,
        phase: scope.phase,
        worktree: scope.worktree,
        dispatch_id: launchOptions.dispatch_id,
        session_id: parsed.session_id,
        process_id: Number.isInteger(child.pid) ? child.pid : undefined,
        command_digest: commandDigest,
        command: { executable, args: [...args] },
        selection_source: selection.source,
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: selection.model,
        observed_effort: selection.effort,
        native_session_evidence: nativeEvidence,
        stream_evidence: {
          format: STREAM_FORMAT,
          records: parsed.records.length,
          turns: parsed.turns,
          usage_records: parsed.usage_records,
        },
        ...(transcript ? { transcript } : {}),
      };
      const evidence = {
        launch_id: 'codex-' + parsed.session_id,
        session_id: parsed.session_id,
        process_id: Number.isInteger(child.pid) ? child.pid : undefined,
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: selection.model,
        observed_effort: selection.effort,
        runtime_evidence: freeze(runtimeEvidence),
        ...(launchOptions.agent_file ? {
          agent_file: launchOptions.agent_file,
          agent_file_digest: launchOptions.agent_file_digest,
        } : {}),
        ...(launchOptions.gsd_role ? {
          gsd_role: launchOptions.gsd_role,
          gsd_launch_mechanism: 'typed-gsd-callback',
        } : {}),
      };
      return freeze(evidence);
    } catch (error) {
      if (error && error.name === 'CodexRuntimeHostError') throw error;
      fail('RUNTIME_EVIDENCE_INVALID', error.message);
    }
  };
}

function createCodexRuntimeHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'runtime host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  const controller = options.controller;
  const runId = options.run_id || options.runId || scope.run_id;
  const probe = options.probe || probeCodexRuntime({
    executable: options.executable,
    capabilities: options.capabilities,
    capabilitiesFile: options.capabilitiesFile,
  });
  if (!object(probe) || !['available', 'unavailable'].includes(probe.status)) {
    fail('INVALID_INPUT', 'runtime probe has an invalid status');
  }
  if (probe.status !== 'available') {
    if (controller && typeof controller.markUnavailable === 'function') {
      controller.markUnavailable(runId, { reason: probe.reason || 'Codex runtime unavailable' });
    }
    fail('RUNTIME_UNAVAILABLE', probe.detail || 'Codex runtime unavailable: ' + (probe.reason || 'unknown'), { probe });
  }
  if (controller && typeof controller.assertOwner === 'function') controller.assertOwner(runId);
  const capabilities = freeze({
    ...(probe.capabilities || {}),
    supportedModels: [...(probe.capabilities && probe.capabilities.supportedModels || [])],
    supportedEfforts: [...(probe.capabilities && probe.capabilities.supportedEfforts || [])],
    observedModel: true,
    observedEffort: true,
    jsonl: true,
    explicitModel: true,
    explicitReasoningEffort: true,
  });
  const recorder = options.recorder || createDurableRecorder(
    options.recorderDir || path.join(scope.worktree, '.planning', 'graph', 'receipts', 'codex'),
  );
  const launcher = createCodexCliLauncher({
    scope,
    executable: probe.executable || options.executable,
    spawn: options.spawn,
    env: options.env,
    capabilities,
    transcriptDir: options.transcriptDir || path.join(scope.worktree, '.planning', 'graph', 'transcripts', 'codex'),
    ephemeral: options.ephemeral,
    approveForMe: options.approveForMe,
  });
  const assertOwner = () => {
    if (controller && typeof controller.assertOwner === 'function') controller.assertOwner(runId);
  };
  const validateContext = (context) => {
    if (!object(context)) fail('INVALID_INPUT', 'Codex launch context must be an object');
    authorityFree(context, 'launch_context');
    if (context.run_id !== undefined && context.run_id !== runId) {
      fail('SCOPE_MISMATCH', 'Codex launch context belongs to another run');
    }
    if (context.runtime !== undefined && context.runtime !== 'codex') {
      fail('RUNTIME_PROVIDER_MISMATCH', 'Codex launch context has a different runtime');
    }
    if (context.provider !== undefined && context.provider !== 'openai') {
      fail('RUNTIME_PROVIDER_MISMATCH', 'Codex launch context has a different provider');
    }
    if (context.gsd_role !== undefined && context.gsd_launch_mechanism !== 'typed-gsd-callback') {
      fail('INVALID_INPUT', 'typed Codex launch context lacks its launch mechanism');
    }
    return context;
  };
  const launch = async (selection, context = {}) => {
    assertOwner();
    const input = validateContext(context);
    const prompt = input.prompt || input.task_prompt || input.input;
    try {
      const result = await launcher(prompt, {
        ...selection,
        dispatch_id: input.dispatch_id,
        sandbox_mode: selection.sandbox_mode || input.sandbox_mode,
        gsd_role: input.gsd_role,
      });
      assertOwner();
      return result;
    } catch (error) {
      if (controller && UNAVAILABLE_CODES.has(error && error.code)
          && typeof controller.markUnavailable === 'function') {
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
    requireRuntimeEvidence: true,
    launch: (selection, context) => launch(selection, context),
    launchStatic: (selection, context) => launch(selection, context),
    launchTypedGsd: (selection, context) => launch(selection, context),
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
    if (flag === '--executable' || flag === '--capabilities-file') {
      const value = argv[++index];
      if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', flag + ' requires a value');
      if (flag === '--executable') values.executable = value;
      else values.capabilitiesFile = value;
      continue;
    }
    fail('INVALID_INPUT', 'unknown CLI argument ' + JSON.stringify(flag));
  }
  if (!values.capabilityOnly) fail('INVALID_INPUT', '--capability-only is required for the capability probe');
  return Object.freeze(values);
}

if (require.main === module) {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    process.stdout.write(JSON.stringify(probeCodexRuntime(args)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      schema: 'shipyard.codex-runtime-probe.v1',
      version: 1,
      status: 'unavailable',
      reason: error.code || 'probe_failed',
      detail: error.message,
    }) + '\n');
    process.exitCode = 0;
  }
}

module.exports = Object.freeze({
  SCHEMA,
  VERSION,
  STREAM_FORMAT,
  EFFORTS,
  normalizeScope,
  probeCodexRuntime,
  parseCodexStream,
  parseNativeCodexTranscript,
  nativeSessionCandidates,
  readNativeCodexSession,
  observedSelection,
  writeTranscript,
  createCodexCliLauncher,
  createCodexRuntimeHost,
});
