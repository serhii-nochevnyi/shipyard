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
const REQUIRED_HELP_MARKERS = Object.freeze(['--json', '--model', '--config', '--cd', '--ignore-user-config']);
const NATIVE_SESSION_MAX_BYTES = 128 * 1024 * 1024;
const NATIVE_SESSION_WAIT_MS = 5000;
const REVIEW_AGENT_ROLES = Object.freeze({ 'shipyard-arch-review': 'arch-review',
  'shipyard-arch-review-critical': 'arch-review', 'shipyard-integrator': 'integrator' });
const GSD_ROLES = new Set(['gsd-phase-researcher', 'gsd-planner', 'gsd-plan-checker', ...Object.keys(REVIEW_AGENT_ROLES)]);
const GSD_AGENT_MAX_BYTES = 256 * 1024;
const PERMISSION_PROFILE = 'shipyard-runtime';
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
  do {
    const candidates = nativeSessionCandidates(sessionsRoot, sessionId, options.now || new Date());
    if (candidates.length > 1) fail('RUNTIME_EVIDENCE_INVALID', 'Codex session identity matched multiple native transcripts');
    if (candidates.length === 1) { file = candidates[0]; break; }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  } while (Date.now() <= deadline);
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

async function readNativeCodexChild(parentId, role, model, effort, agent, spawnEvidence, options = {}) {
  const env = options.env && object(options.env) ? options.env : {};
  const home = path.resolve(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const root = path.join(home, 'sessions');
  const deadline = Date.now() + (options.waitMs === undefined ? NATIVE_SESSION_WAIT_MS : options.waitMs);
  do {
    const matches = [];
    const now = options.now || new Date();
    for (const offset of [-1, 0, 1]) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      const directory = sessionDirectory(root, date);
      let files;
      try { files = fs.readdirSync(directory); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        fail('RUNTIME_EVIDENCE_INVALID', 'cannot inspect Codex child session directory');
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(directory, name);
        let stat;
        try { stat = fs.lstatSync(file); }
        catch (_) { continue; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NATIVE_SESSION_MAX_BYTES
            || stat.mtimeMs < (options.startedAt || 0) - 5000) continue;
        const descriptor = fs.openSync(file, 'r');
        let prefix;
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024));
          prefix = buffer.subarray(0, fs.readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8');
        } finally { fs.closeSync(descriptor); }
        const first = prefix.slice(0, prefix.indexOf('\n') < 0 ? prefix.length : prefix.indexOf('\n'));
        let record;
        try { record = JSON.parse(first); }
        catch (_) { continue; }
        if (record.type === 'session_meta' && record.payload && record.payload.parent_thread_id === parentId) {
          matches.push({ file, stat, id: record.payload.id });
        }
      }
    }
    if (matches.length > 1) fail('RUNTIME_EVIDENCE_INVALID', 'native parent has duplicate child sessions');
    if (matches.length === 1) {
      const child = matches[0];
      const raw = fs.readFileSync(child.file, 'utf8');
      const after = fs.lstatSync(child.file);
      if (after.size !== child.stat.size || after.mtimeMs !== child.stat.mtimeMs
          || Buffer.byteLength(raw, 'utf8') !== after.size) {
        fail('RUNTIME_EVIDENCE_INVALID', 'native child transcript changed during verification');
      }
      const evidence = parseNativeChildTranscript(raw, child.id, parentId, role, model, effort, agent, spawnEvidence);
      if (options.includeCompletion === true) {
        return freeze({
          ...evidence,
          last_agent_message: completionMessage(raw),
          ...(options.task ? { task_relay: verifyTaskRelay(raw, options.task, spawnEvidence,
            options.allowMissingTaskFile === true) } : {}),
        });
      }
      return options.task ? freeze({ ...evidence, task_relay: verifyTaskRelay(raw, options.task, spawnEvidence,
        options.allowMissingTaskFile === true) }) : evidence;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() <= deadline);
  fail('RUNTIME_EVIDENCE_MISSING', 'native typed GSD child transcript was not found');
}

function transcriptEvidence(directory, scope, sessionId, stdout) {
  if (directory === undefined || directory === null) return null;
  const root = path.resolve(text(directory, 'transcriptDir', 4096));
  const safeRun = scope.run_id.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(root, safeRun + '-' + safeSession + '.jsonl');
  const bytes = Buffer.from(stdout, 'utf8');
  return Object.freeze({
    path: file,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function writeTranscript(directory, scope, sessionId, stdout) {
  const evidence = transcriptEvidence(directory, scope, sessionId, stdout);
  if (!evidence) return null;
  const root = path.dirname(evidence.path);
  const file = evidence.path;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const bytes = Buffer.from(stdout, 'utf8');
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
  return evidence;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrResolved(entry) {
  let current = path.resolve(entry);
  const tail = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...tail); }
    catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function taskStateDir(options, scope) {
  const explicit = options.taskDir !== undefined;
  let candidate;
  if (explicit) candidate = text(options.taskDir, 'taskDir', 4096);
  else if (options.transcriptDir) candidate = path.join(path.dirname(path.resolve(options.transcriptDir)), 'tasks');
  const worktree = realOrResolved(scope.worktree);
  if (candidate && pathInside(worktree, realOrResolved(candidate))) {
    if (explicit) fail('INVALID_STATE_DIR', 'Codex task directory must resolve outside the worktree');
    candidate = undefined;
  }
  if (!candidate) {
    candidate = path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex-runtime',
      scope.run_id.replace(/[^A-Za-z0-9._-]/g, '_'), 'tasks');
  }
  if (pathInside(worktree, realOrResolved(candidate))) {
    fail('INVALID_STATE_DIR', 'Codex task directory must resolve outside the worktree');
  }
  return path.resolve(candidate);
}

function writeTaskFile(directory, scope, id, body) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safe = String(id || scope.run_id + '-' + crypto.randomBytes(8).toString('hex')).replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(fs.realpathSync(directory), safe + '.md');
  if (pathInside(realOrResolved(scope.worktree), file)) {
    fail('INVALID_STATE_DIR', 'Codex task file must resolve outside the worktree');
  }
  const bytes = Buffer.from(body, 'utf8');
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
  return Object.freeze({
    path: file, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function taskRelayInput(role, model, effort, task) {
  return 'Call spawn_agent exactly once with agent_type ' + role
    + ', model ' + model + ', reasoning_effort ' + effort
    + ', fork_turns none, and task_name gsd_task. Give that child exactly this message:\n'
    + 'TASK_FILE=' + task.path + '\nTASK_SHA256=' + task.sha256 + '\n'
    + 'Your FIRST tool call must read TASK_FILE and every mandatory GSD/AGENTS initial source required by your role in that same call. If those sources must come first, read them before TASK_FILE.\n'
    + 'Make this first read/hash filesystem read-only using inline python -c or node -e. Do not use shell heredocs, create temporary files, or use shell features that require temporary files.\n'
    + 'In that same call, compute SHA-256 from the TASK_FILE bytes; do not print the supplied expected digest without reading and hashing those bytes. Emit TASK_SHA256=<computed digest> as the first small standalone output, before any source bodies, task text, or tool inventory. Reading mandatory sources first does not require printing them first.\n'
    + 'When using functions.exec, explicitly forward that computed marker as a separate FIRST text item with text(marker), then emit the remaining output. Preserve it through BOTH the nested command output budget and the outer functions.exec output budget; increasing only the nested budget is insufficient. Then follow TASK_FILE exactly.\n'
    + 'Wait for that child to finish. Do not perform the task yourself.';
}

function messageText(payload) {
  if (!Array.isArray(payload.content)) return typeof payload.content === 'string' ? payload.content : '';
  return payload.content.filter((entry) => object(entry) && typeof entry.text === 'string')
    .map((entry) => entry.text).join('\n');
}

function plaintextRelay(text, task) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(TASK_FILE|TASK_SHA256)=(.*?)\s*$/.exec(line);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  return values.get('TASK_FILE') === task.path && values.get('TASK_SHA256') === task.sha256;
}

function readsExactPath(command, file) {
  let index = command.indexOf(file);
  while (index >= 0) {
    const next = command.charAt(index + file.length);
    if (!/[A-Za-z0-9._\/-]/.test(next)) return true;
    index = command.indexOf(file, index + 1);
  }
  return false;
}

function toolCommand(item) {
  if (item.type === 'custom_tool_call' && typeof item.input === 'string') return item.input;
  if (item.type === 'function_call' && typeof item.arguments === 'string') return item.arguments;
  return null;
}

function toolOutput(item) {
  if (typeof item.output === 'string') return item.output;
  return Array.isArray(item.output) ? messageText({ content: item.output }) : '';
}

function verifyTaskRelay(childRaw, task, relay = {}, allowMissingTaskFile = false) {
  if (!object(task) || typeof task.path !== 'string' || !path.isAbsolute(task.path)
      || path.normalize(task.path) !== task.path || !Number.isSafeInteger(task.bytes) || task.bytes < 0
      || !/^[a-f0-9]{64}$/.test(task.sha256 || '')) {
    fail('TASK_RELAY_UNVERIFIED', 'native child relay has an invalid task-file binding');
  }
  const missing = [];
  let parentBound = false;
  let delivered = false;
  let plaintext = false;
  let firstCall = null;
  const outputs = new Map();
  for (const line of String(childRaw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    if (!object(record) || !object(record.payload)) continue;
    const item = record.payload;
    if (record.type === 'session_meta') {
      parentBound = typeof relay.parent_thread_id === 'string' && item.parent_thread_id === relay.parent_thread_id;
      continue;
    }
    if (record.type !== 'response_item') continue;
    if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
      if (typeof item.call_id === 'string' && !outputs.has(item.call_id)) outputs.set(item.call_id, toolOutput(item));
      continue;
    }
    if (firstCall) continue;
    if (item.type === 'agent_message' && item.author === '/root'
        && typeof relay.task_path === 'string' && item.recipient === relay.task_path) delivered = true;
    if (item.type === 'message' && (item.role === 'user' || item.role === 'developer')
        && plaintextRelay(messageText(item), task)) plaintext = true;
    if (toolCommand(item) !== null) firstCall = item;
  }
  if (!parentBound) missing.push('child session parent');
  if (!delivered && !plaintext) missing.push('/root agent_message to ' + (relay.task_path || 'child task'));
  if (!plaintext) {
    if (!firstCall || !readsExactPath(toolCommand(firstCall), task.path)) missing.push('first tool call reading TASK_FILE');
    else if (!String(outputs.get(firstCall.call_id) || '').includes(task.sha256)) missing.push('TASK_SHA256 in child tool output');
  }
  let taskFileMissing = false;
  try {
    const stat = fs.lstatSync(task.path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
      missing.push('private regular task file');
    } else {
      const bytes = fs.readFileSync(task.path);
      if (bytes.length !== task.bytes
          || crypto.createHash('sha256').update(bytes).digest('hex') !== task.sha256) {
        missing.push('unchanged task file');
      }
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') taskFileMissing = true;
    else throw error;
  }
  if (taskFileMissing && !allowMissingTaskFile) missing.push('unchanged task file');
  if (missing.length) {
    fail('TASK_RELAY_UNVERIFIED', 'native child relay is missing ' + missing.join(', '), { missing });
  }
  return Object.freeze({ path: task.path, bytes: task.bytes, sha256: task.sha256 });
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

function installedGsdAgent(role, env = {}) {
  if (!GSD_ROLES.has(role)) fail('INVALID_INPUT', 'unsupported typed GSD role');
  const home = path.resolve(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const file = path.join(home, 'agents', role + '.toml');
  let stat;
  let content;
  try {
    stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GSD_AGENT_MAX_BYTES) {
      fail('STALE_GSD_AGENT', 'installed GSD role must be a bounded regular file');
    }
    if (fs.realpathSync(file) !== path.join(fs.realpathSync(path.dirname(file)), path.basename(file))) {
      fail('STALE_GSD_AGENT', 'installed GSD role must not resolve through a different file');
    }
    content = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(content, 'utf8') !== stat.size) fail('STALE_GSD_AGENT', 'installed GSD role changed during validation');
  } catch (error) {
    if (error && error.name === 'CodexRuntimeHostError') throw error;
    fail('STALE_GSD_AGENT', 'cannot read the installed GSD role: ' + error.message);
  }
  const fields = new Map();
  let multiline = null;
  let instructionLines = [];
  let instructions = null;
  for (const source of content.split(/\r?\n/)) {
    const line = source.trim();
    if (multiline) {
      if (line === multiline) {
        instructions = instructionLines.join('\n') + '\n';
        multiline = null;
      } else instructionLines.push(source);
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/);
    if (!match) fail('STALE_GSD_AGENT', 'installed GSD role has unsupported TOML outside its instructions');
    if (fields.has(match[1])) fail('STALE_GSD_AGENT', 'installed GSD role has duplicate configuration');
    fields.set(match[1], match[2]);
    if (match[1] === 'developer_instructions') {
      if (match[2] !== "'''") {
        fail('STALE_GSD_AGENT', 'installed GSD instructions must use literal multiline TOML');
      }
      multiline = match[2];
      instructionLines = [];
    }
  }
  if (multiline) fail('STALE_GSD_AGENT', 'installed GSD instructions are unterminated');
  for (const key of ['model', 'model_reasoning_effort', 'model_provider', 'forced_login_method', 'config_file']) {
    if (fields.has(key)) fail('CONFLICTING_OVERRIDE', 'installed GSD role overrides ' + key);
  }
  let name;
  let description;
  let sandbox;
  try {
    name = JSON.parse(fields.get('name'));
    description = JSON.parse(fields.get('description'));
    sandbox = JSON.parse(fields.get('sandbox_mode'));
  } catch (_) {
    fail('STALE_GSD_AGENT', 'installed GSD role has invalid identity or sandbox');
  }
  if (name !== role || typeof description !== 'string' || !description.trim()
      || !['read-only', 'workspace-write'].includes(sandbox)
      || typeof instructions !== 'string' || !instructions.trim()) {
    fail('STALE_GSD_AGENT', 'installed GSD role identity or instructions do not match');
  }
  if (role === 'gsd-plan-checker' && sandbox !== 'read-only') {
    fail('STALE_GSD_AGENT', 'installed plan checker is not read-only');
  }
  return freeze({
    role, file, description, sandbox, instructions,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    instructions_sha256: crypto.createHash('sha256').update(instructions).digest('hex'),
  });
}

function parseNativeParentSpawn(raw, parentId, role, model, effort, live = false) {
  parseNativeCodexTranscript(raw, parentId);
  const calls = [];
  const waits = [];
  const outputs = new Map();
  let metadataCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch (error) { fail('RUNTIME_EVIDENCE_INVALID', 'parent transcript contains invalid JSON: ' + error.message); }
    if (record.type === 'session_meta') metadataCount++;
    if (record.type !== 'response_item' || !object(record.payload)) continue;
    const item = record.payload;
    if (item.type === 'function_call' && item.name === 'spawn_agent') calls.push(item);
    if (item.type === 'function_call' && item.name === 'wait_agent') waits.push(item);
    if (item.type === 'function_call_output' && typeof item.call_id === 'string') {
      if (outputs.has(item.call_id)) fail('RUNTIME_EVIDENCE_INVALID', 'duplicate parent tool output');
      outputs.set(item.call_id, item.output);
    }
  }
  if (metadataCount !== 1 || calls.length !== 1) {
    fail('RUNTIME_EVIDENCE_MISSING', 'parent did not provide one session and one native spawn_agent call');
  }
  const call = calls[0];
  let args;
  try { args = JSON.parse(call.arguments); }
  catch (_) { fail('RUNTIME_EVIDENCE_INVALID', 'parent spawn arguments are invalid'); }
  if (!object(args) || args.agent_type !== role || args.model !== model
      || args.reasoning_effort !== effort || args.fork_turns !== 'none'
      || typeof args.task_name !== 'string'
      || !/^[A-Za-z0-9_-]{1,80}$/.test(args.task_name)) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native spawn request did not select the exact role, model, effort and task');
  }
  if (typeof call.call_id !== 'string' || !outputs.has(call.call_id)) {
    fail('RUNTIME_EVIDENCE_MISSING', 'native spawn request has no matching output');
  }
  let output;
  try { output = JSON.parse(outputs.get(call.call_id)); }
  catch (_) { fail('RUNTIME_EVIDENCE_INVALID', 'native spawn output is invalid'); }
  if (!object(output) || typeof output.task_name !== 'string'
      || !path.isAbsolute(output.task_name)
      || path.normalize(output.task_name) !== output.task_name
      || path.basename(output.task_name) !== args.task_name) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native spawn output does not identify the requested task');
  }
  if (!live && !waits.length) fail('RUNTIME_EVIDENCE_MISSING', 'native parent did not wait for its child');
  const waitResults = waits.map((wait) => {
    if (live && !outputs.has(wait.call_id)) return { timed_out: true };
    if (typeof wait.call_id !== 'string' || !outputs.has(wait.call_id)) {
      fail('RUNTIME_EVIDENCE_MISSING', 'native parent has an unfinished child wait');
    }
    try { return JSON.parse(outputs.get(wait.call_id)); }
    catch (_) { fail('RUNTIME_EVIDENCE_INVALID', 'native wait output is invalid'); }
  });
  if (!waitResults.every((waited) => object(waited) && typeof waited.timed_out === 'boolean')) {
    fail('RUNTIME_EVIDENCE_INVALID', 'native wait output has no boolean timeout status');
  }
  return freeze({
    parent_thread_id: parentId, call_id: call.call_id,
    task_name: args.task_name, task_path: output.task_name,
    timed_out: waitResults.some((waited) => waited.timed_out),
  });
}

function completionMessage(raw) {
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === 'event_msg' && object(record.payload) && record.payload.type === 'task_complete') {
      messages.push(record.payload.last_agent_message);
    }
  }
  if (messages.length !== 1 || typeof messages[0] !== 'string') {
    fail('RUNTIME_EVIDENCE_INVALID', 'native child has no single task_complete agent message');
  }
  return messages[0];
}

function readNativeParentRaw(sessionId, evidence, env, now) {
  const home = path.resolve(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const files = nativeSessionCandidates(path.join(home, 'sessions'), sessionId, now);
  if (files.length !== 1 || path.basename(files[0]) !== evidence.file) {
    fail('RUNTIME_EVIDENCE_MISSING', 'native parent transcript cannot be rebound to session evidence');
  }
  const raw = fs.readFileSync(files[0], 'utf8');
  if (crypto.createHash('sha256').update(raw).digest('hex') !== evidence.sha256) {
    fail('RUNTIME_EVIDENCE_INVALID', 'native parent transcript changed after selection verification');
  }
  return raw;
}

function parseNativeChildTranscript(raw, childId, parentId, role, model, effort, agent, spawnEvidence, live = false) {
  const native = parseNativeCodexTranscript(raw, childId);
  if (native.selections.some((value) => value.model !== model || value.effort !== effort)) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native child used a different model or reasoning effort');
  }
  const metadata = [];
  const developer = [];
  let completed = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === 'session_meta') metadata.push(record.payload);
    if (record.type === 'event_msg' && record.payload && record.payload.type === 'task_complete') completed++;
    if (record.type === 'response_item' && record.payload
        && record.payload.type === 'message' && record.payload.role === 'developer') {
      developer.push(record.payload);
    }
  }
  if (metadata.length !== 1 || !object(metadata[0]) || (!live && completed !== 1)) {
    fail('RUNTIME_EVIDENCE_INVALID', 'native child has incomplete or duplicate execution evidence');
  }
  const meta = metadata[0];
  const spawned = meta.source && meta.source.subagent && meta.source.subagent.thread_spawn;
  if (meta.parent_thread_id !== parentId || meta.agent_role !== role
      || !object(spawned) || spawned.parent_thread_id !== parentId
      || spawned.agent_role !== role) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native child is not bound to the exact parent and GSD role');
  }
  if (!object(spawnEvidence) || spawnEvidence.parent_thread_id !== parentId
      || typeof spawnEvidence.task_path !== 'string'
      || !path.isAbsolute(spawnEvidence.task_path)
      || path.basename(spawnEvidence.task_path) !== spawnEvidence.task_name) {
    fail('RUNTIME_EVIDENCE_MISSING', 'native child lacks validated parent spawn task evidence');
  }
  for (const observedPath of [meta.agent_path, spawned.agent_path]) {
    if (observedPath !== spawnEvidence.task_path) {
      fail('RUNTIME_EVIDENCE_MISMATCH', 'native child agent_path does not match the spawned task path');
    }
  }
  const matchingInstructions = developer.flatMap((message) => Array.isArray(message.content)
    ? message.content.filter((entry) => object(entry)
      && entry.type === 'input_text' && entry.text === agent.instructions)
    : []);
  if (typeof agent.instructions !== 'string' || matchingInstructions.length !== 1) {
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native child did not load the exact installed GSD developer instructions');
  }
  return freeze({
    schema: 'shipyard.codex-native-child-evidence.v1', version: 1,
    session_id: childId, parent_thread_id: parentId, agent_role: role,
    agent_file: agent.file, agent_file_digest: agent.sha256,
    agent_instructions_digest: agent.instructions_sha256,
    task_path: spawnEvidence.task_path,
    provider: native.provider, models: native.models, efforts: native.efforts,
    selections: native.selections, sha256: native.sha256,
  });
}

const measuredLaunches = new WeakMap();
const readerCapacities = new WeakMap();
const readerCapacityProbes = new WeakMap();
const recordedCapacityLaunches = new WeakMap();

function recordCapacityApplication(verified, manifest, application) {
  const boundary = require('./dispatch-boundary.cjs');
  if (!object(application) || !boundary.isDurableRecorder(application.recorder))
    fail('READER_CAPACITY_UNSUPPORTED', 'batch measurement requires original boundary receipt custody');
  const { recorder, receipt } = application;
  let record, authenticated;
  try {
    authenticated = boundary.createDispatchBoundary({ recorder }).reconcile(receipt.dispatch_id,
      { ticket: manifest.ticket, subject_kind: readerSubjectKind(manifest) });
    record = recorder.getVerifiedRecord(receipt.dispatch_id);
  } catch (error) {
    fail('READER_CAPACITY_UNSUPPORTED', 'batch application receipt authentication failed', { cause: error.code });
  }
  const stable = require('./model-policy-internal.cjs').stableStringify;
  if (stable(authenticated.application_receipt) !== stable(receipt))
    fail('READER_CAPACITY_UNSUPPORTED', 'batch measurement differs from its authenticated application receipt');
  validateCapacityApplicationRecord(verified, manifest, record, receipt);
  recordedCapacityLaunches.set(verified, { recorder, receipt, record_sha256: reviewHash(stable(record)),
    subject: readerSubject(manifest) });
}

function capacityProbeAssociation(manifest, probeDispatchId) {
  return freeze({ schema: 'shipyard.reader-capacity-association.v1', probe_dispatch_id: probeDispatchId,
    review_dispatch_id: manifest.dispatch_id,
    manifest_sha256: reviewHash(require('./model-policy-internal.cjs').stableStringify(manifest) + '\n'),
    profile_sha256: manifest.transport.profile_sha256, binding_sha256: reviewHash(readerSubject(manifest)) });
}

function readerSubjectKind(manifest) {
  return manifest.role === 'arch-review' && require('./architecture-target.cjs').PHASE_SUBJECT.test(manifest.ticket)
    ? 'phase' : 'ticket';
}

function validateCapacityApplicationRecord(verified, manifest, record, receipt) {
  const stable = require('./model-policy-internal.cjs').stableStringify;
  const evidence = receipt?.runtime_evidence;
  const candidate = manifest.transport.candidate;
  const association = evidence?.reader_capacity_probe;
  const dispatchId = association ? association.probe_dispatch_id : manifest.dispatch_id;
  if (association && (typeof dispatchId !== 'string' || !/^capacity-probe-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(dispatchId)
      || dispatchId === manifest.dispatch_id
      || stable(association) !== stable(capacityProbeAssociation(manifest, dispatchId))))
    fail('READER_CAPACITY_UNSUPPORTED', 'capacity probe changed its protected final candidate association');
  if (!record || stable(record.receipt) !== stable(receipt)
      || record.dispatch_id !== dispatchId || record.ticket !== manifest.ticket
      || (record.subject_kind || 'ticket') !== readerSubjectKind(manifest)
      || receipt.dispatch_id !== dispatchId || receipt.runtime !== 'codex' || receipt.role !== manifest.role
      || receipt.policy_hash !== manifest.transport.policy_hash || receipt.compliance !== 'verified'
      || receipt.requested_model !== record.resolution?.requested_model
      || receipt.requested_effort !== record.resolution?.requested_effort
      || receipt.applied_model !== candidate.model || receipt.observed_model !== candidate.model
      || receipt.applied_effort !== candidate.effort || receipt.observed_effort !== candidate.effort
      || evidence?.schema !== 'shipyard.codex-runtime-evidence.v1' || evidence.provider !== 'openai'
      || evidence.selection_source !== 'codex-native-session-transcript'
      || evidence?.run_id !== manifest.run_id || evidence.ticket !== manifest.ticket || evidence.phase !== manifest.phase
      || evidence.worktree !== manifest.snapshot.worktree || evidence.dispatch_id !== dispatchId
      || evidence.session_id !== verified.native_session_evidence.session_id
      || stable(evidence.native_session_evidence) !== stable(verified.native_session_evidence)
      || evidence.input_bundle?.manifest_sha256 !== reviewHash(stable(manifest) + '\n')
      || evidence.input_consumption?.manifest_sha256 !== evidence.input_bundle.manifest_sha256)
    fail('READER_CAPACITY_UNSUPPORTED', 'batch application receipt differs from its original measured launch or candidate');
  const transcript = evidence.transcript;
  if (!transcript || typeof transcript.path !== 'string')
    fail('READER_CAPACITY_UNSUPPORTED', 'batch application receipt lacks its original CLI transcript');
  const cliRaw = readReviewNativeFile(transcript.path, manifest.snapshot.worktree);
  const cli = parseCodexStream(cliRaw);
  const args = evidence.command?.args;
  const starts = cli.records.flatMap((record, index) => record.type === 'turn.started' ? [index] : []);
  const finals = cli.records.flatMap((record, index) => record.item?.type === 'agent_message' ? [index] : []);
  const ends = cli.records.flatMap((record, index) => record.type === 'turn.completed' ? [index] : []);
  if (Buffer.byteLength(cliRaw) !== transcript.bytes || reviewHash(cliRaw) !== transcript.sha256
      || cli.session_id !== evidence.session_id || starts.length !== 1 || finals.length !== 1 || ends.length !== 1
      || starts[0] >= finals[0] || finals[0] >= ends[0]
      || cli.records[finals[0]].item.text !== verified.last_agent_message
      || !Array.isArray(args) || evidence.command_digest !== reviewHash(JSON.stringify(args)))
    fail('READER_CAPACITY_UNSUPPORTED', 'batch application receipt changed its original CLI completion or command');
  observedSelection(cli, candidate.model, candidate.effort, {
    model: args[args.indexOf('--model') + 1],
    effort: (args.find(value => value.startsWith('model_reasoning_effort=')) || '').match(/^model_reasoning_effort="([^"]+)"$/)?.[1],
  }, verified.native_session_evidence);
}

function capacityApplication(verified, manifest) {
  const authorization = recordedCapacityLaunches.get(verified);
  const boundary = require('./dispatch-boundary.cjs');
  if (!authorization || !boundary.isDurableRecorder(authorization.recorder)
      || authorization.subject !== readerSubject(manifest))
    fail('READER_CAPACITY_UNSUPPORTED', 'batch capacity requires its original durably recorded application receipt');
  let record;
  try { record = authorization.recorder.getVerifiedRecord(authorization.receipt.dispatch_id); }
  catch (error) { fail('READER_CAPACITY_UNSUPPORTED', 'batch application receipt authentication failed', { cause: error.code }); }
  const stable = require('./model-policy-internal.cjs').stableStringify;
  if (!record || reviewHash(stable(record)) !== authorization.record_sha256
      || stable(record.receipt) !== stable(authorization.receipt))
    fail('READER_CAPACITY_UNSUPPORTED', 'original batch application receipt is missing or changed');
  recordCapacityApplication(verified, manifest, authorization);
  return authorization;
}

function readerSubject(manifest) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical([manifest.snapshot, manifest.run_id, manifest.ticket, manifest.phase,
    manifest.role, manifest.dispatch_id, manifest.binding, manifest.accounting?.generated_instruction_bytes || 0,
    manifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256])]));
}

function readerCapacityContract(capacity, manifest) {
  const measured = readerCapacities.get(capacity);
  if (!measured || measured.subject !== readerSubject(manifest)
      || (measured.contract.schema === 'shipyard.native-reader-transport.v3'
        && (measured.profile !== manifest.transport?.profile_sha256
          || measured.contract.manifest_sha256 !== reviewHash(require('./model-policy-internal.cjs').stableStringify(manifest) + '\n'))))
    fail('READER_CAPACITY_UNSUPPORTED', 'reader capacity lacks original measured current-subject authority');
  const source = measured.completedSource;
  if (source) completedSourceSnapshot(source);
  else readNativeParentRaw(measured.launch.session, measured.verified.native_session_evidence, measured.launch.env, measured.launch.now);
  if (measured.contract.schema === 'shipyard.native-reader-transport.v3') capacityApplication(measured.verified, manifest);
  return measured.contract;
}

function measureReaderCapacity(verified, prepared, application) {
  const launch = measuredLaunches.get(verified);
  if (!launch) fail('READER_CAPACITY_UNSUPPORTED', 'capacity requires original verified native launch');
  if (!recordedCapacityLaunches.get(verified)?.completedSource && readNativeParentRaw(launch.session, verified.native_session_evidence, launch.env, launch.now) !== launch.raw)
    fail('READER_CAPACITY_UNSUPPORTED', 'original measured output changed');
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
  if (checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3') {
    if (application !== undefined) recordCapacityApplication(verified, checked.manifest, application);
    const recorded = capacityApplication(verified, checked.manifest);
    const candidate = checked.manifest.transport.candidate;
    const originalRecords = launch.raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const instructions = originalRecords.flatMap(record => record.type === 'response_item' && record.payload?.role === 'developer'
      ? (record.payload.content || []).filter(block => block.type === 'input_text' && typeof block.text === 'string'
        && reviewHash(block.text) === candidate.instructions_sha256) : []);
    const inputs = originalRecords.flatMap(record => record.type === 'response_item' && record.payload?.role === 'user'
      ? (record.payload.content || []).filter(block => block.type === 'input_text' && block.text === prepared.prompt) : []);
    if (instructions.length !== 1 || inputs.length !== 1
        || checked.manifest.accounting.generated_instruction_bytes !== Buffer.byteLength(instructions[0].text) + 2)
      fail('READER_CAPACITY_UNSUPPORTED', 'batch measurement lacks exact original instructions and candidate relay');

    validateReviewNative(launch.raw, launch.session, { ...candidate, sandbox_mode: 'read-only', worktree: checked.manifest.snapshot.worktree });
    const selections = verified.native_session_evidence.selections;
    if (!selections.length || selections.some(value => value.model !== candidate.model || value.effort !== candidate.effort)
        || checked.manifest.transport.policy_hash !== require('./model-policy.cjs').POLICY_HASH)
      fail('READER_CAPACITY_UNSUPPORTED', 'batch candidate differs from original native selection or policy');
    const observed = verifyCheckedFileConsumption(checked, prepared, launch.raw, verified.last_agent_message,
      { chunk_bytes: checked.manifest.chunk_bytes, output_tokens: 10000 });
    const contract = freeze({ schema: 'shipyard.native-reader-transport.v3',
      profile_sha256: checked.manifest.transport.profile_sha256,
      manifest_sha256: prepared.input_bundle.manifest_sha256, schedule_sha256: reviewHash(JSON.stringify(checked.manifest.batches)),
      native_sha256: verified.native_session_evidence.sha256, native_session_id: launch.session,
      native_file: originalReviewFile(launch.session, launch.env, checked.manifest.snapshot.worktree),
      native_bytes: Buffer.byteLength(launch.raw),
      binding_sha256: reviewHash(readerSubject(checked.manifest)), selection: selections[0], sandbox_mode: 'read-only',
      application_dispatch_id: recorded.receipt.dispatch_id,
      ...(recorded.receipt.runtime_evidence.reader_capacity_probe ? {
        probe_association: recorded.receipt.runtime_evidence.reader_capacity_probe } : {}),
      application_receipt_store: recorded.recorder.storeDir,
      application_record_sha256: recorded.record_sha256,
      application_receipt_sha256: reviewHash(require('./model-policy-internal.cjs').stableStringify(recorded.receipt)),
      output_tokens: 10000, largest_envelope_bytes: observed.largest_envelope_bytes,
      largest_nested_bytes: observed.largest_nested_bytes, physical_calls: observed.physical_calls,
      logical_ranges: observed.chunk_reads, encoded_bytes: observed.encoded_bytes, semantic_credit: false });
    const capacity = freeze({ contract });
    readerCapacities.set(capacity, { contract, subject: readerSubject(checked.manifest),
      profile: checked.manifest.transport.profile_sha256, launch, verified });
    return capacity;
  }
  if (!checked.material.some(bytes => bytes.length >= 128 * 1024))
    fail('READER_CAPACITY_UNSUPPORTED', 'capacity requires a complete 128 KiB observed range');
  const measurement = { chunk_bytes: 128 * 1024, output_tokens: 10000 };
  const observed = verifyFileConsumption(prepared, launch.raw, checked.manifest.dispatch_id,
    verified.last_agent_message, measurement);
  const contract = freeze({ schema: 'shipyard.native-reader-transport.v2', chunk_bytes: measurement.chunk_bytes,
    encoding: 'base64', range_schedule: 'manifest-first/ordinal-offset/v1', output_tokens: 10000, nested_envelope: 'exec-command.v1',
    outer_envelope: 'functions-exec.v1', native_sha256: verified.native_session_evidence.sha256,
    native_session_id: verified.native_session_evidence.session_id,
    policy_hash: checked.manifest.snapshot.policy_hash,
    selection: verified.native_session_evidence.selections[0],
    binding_sha256: crypto.createHash('sha256').update(readerSubject(checked.manifest)).digest('hex'),
    output_budget_bytes: observed.largest_envelope_bytes + 4096, encoded_bytes: observed.encoded_bytes });
  const capacity = freeze({ contract });
  readerCapacities.set(capacity, { contract, subject: readerSubject(checked.manifest), launch, verified });
  return capacity;
}

async function verifyCompletedNativeLaunch(input = {}) {
  if (!object(input)) fail('INVALID_INPUT', 'native verification input must be an object');
  const env = object(input.env) ? input.env : {};
  const selection = object(input.selection) ? input.selection : {};
  const model = text(selection.model, 'model', 256);
  const effort = text(selection.effort || selection.reasoning_effort, 'effort', 32);
  const timing = {
    ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  const nativeEvidence = await readNativeCodexSession(input.session_id, { env, ...timing });
  if (nativeEvidence.provider !== 'openai' || nativeEvidence.selections.some(value => value.model !== model || value.effort !== effort))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native launch changed the selected model or reasoning effort');
  if (!input.agent) {
    const raw = readNativeParentRaw(input.session_id, nativeEvidence, env, input.now);
    const records = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const indices = predicate => records.flatMap((record, index) => predicate(record) ? [index] : []);
    const starts = indices(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
    const finals = indices(record => record.type === 'response_item' && record.payload?.type === 'message'
      && record.payload.role === 'assistant' && record.payload.phase === 'final_answer');
    const completions = indices(record => record.type === 'event_msg' && record.payload?.type === 'task_complete');
    if (starts.length !== 1 || finals.length !== 1 || completions.length !== 1
        || starts[0] >= finals[0] || finals[0] >= completions[0]) {
      fail('RUNTIME_EVIDENCE_MISMATCH', 'native launch lacks one ordered start, final and completion');
    }
    const turn = records[starts[0]].payload.turn_id;
    const final = records[finals[0]].payload;
    const completion = records[completions[0]].payload;
    const message = completionMessage(raw);
    if (typeof turn !== 'string' || !turn || completion.turn_id !== turn
        || final.internal_chat_message_metadata_passthrough?.turn_id !== turn
        || !Array.isArray(final.content) || !final.content.length
        || final.content.some(block => block.type !== 'output_text' || typeof block.text !== 'string')
        || final.content.map(block => block.text).join('') !== message
        || input.resultText !== message) {
      fail('RUNTIME_EVIDENCE_MISMATCH', 'native final differs from its original turn or CLI result');
    }
    const verified = freeze({ native_session_evidence: nativeEvidence, last_agent_message: message });
    measuredLaunches.set(verified, { raw, session: input.session_id, env, now: input.now });
    return verified;
  }
  const agent = input.agent;
  const parentRaw = readNativeParentRaw(input.session_id, nativeEvidence, env, input.now);
  const spawnEvidence = parseNativeParentSpawn(parentRaw, input.session_id, agent.role, model, effort);
  const child = await readNativeCodexChild(input.session_id, agent.role, model, effort, agent, spawnEvidence, {
    env, ...timing, startedAt: input.startedAt,
    includeCompletion: true,
    ...(input.task ? { task: input.task, allowMissingTaskFile: input.allowMissingTaskFile === true } : {}),
  });
  // @invariant: timed_out describes the parent wait; only the child's bound task_complete proves completion.
  if (child.parent_thread_id !== input.session_id || child.agent_role !== agent.role
      || typeof child.last_agent_message !== 'string') {
    fail('RUNTIME_EVIDENCE_INVALID', 'native child did not complete for this parent and role');
  }
  const { last_agent_message: lastAgentMessage, ...childEvidence } = child;
  return freeze({
    native_session_evidence: nativeEvidence,
    native_child_evidence: freeze(childEvidence),
    spawn_evidence: spawnEvidence,
    last_agent_message: lastAgentMessage,
  });
}

function verifyFileConsumption(prepared, nativeRaw, dispatchId, resultText, measurement, prefix) {
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared, {
    association: { dispatch_id: dispatchId },
  });
  const source = completedSourceInputs.get(prepared);
  if (source && !measurement && !prefix) return verifyCompletedSourceTurn(source, prepared, nativeRaw, resultText, checked);
  return verifyCheckedFileConsumption(checked, prepared, nativeRaw, resultText, measurement, prefix);
}

function verifyCheckedFileConsumption(checked, prepared, nativeRaw, resultText, measurement, prefix) {
  const chunkBytes = measurement?.chunk_bytes || prepared.input_bundle.chunk_bytes;
  const v3 = checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3';
  const v2 = Boolean(measurement || prepared.input_bundle.transport);
  if (v3 && !measurement && !prepared.input_bundle.reader_capacity)
    fail('READER_CAPACITY_UNSUPPORTED', 'batch review requires original matching capacity');
  let physicalCalls = 0, largestNested = 0, failedDeliveries = 0;
  const successfulCallIds = [];
  const successfulRangeOrdinals = [];
  let outputBytes = 0, encodedBytes = 0, nestedBytes = 0, largestEnvelope = 0, rawBytes = 0;
  if (typeof nativeRaw !== 'string' || Buffer.byteLength(nativeRaw) > 128 * 1024 * 1024)
    fail('READER_CAPACITY_UNSUPPORTED', 'native reader transcript exceeds its bounded output budget');
  const records = nativeRaw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (prepared.input_bundle.transport && !measurement) {
    const selection = v3 ? checked.manifest.transport.candidate : prepared.input_bundle.transport.selection;
    if (!object(selection) || records.some(record => record.type === 'turn_context'
        && (record.payload?.model !== selection.model || record.payload?.effort !== selection.effort))
        || records.some(record => record.type === 'session_meta' && record.payload?.model_provider !== 'openai'))
      fail('READER_CAPACITY_UNSUPPORTED', 'native reader differs from its measured model or provider');
  }
  const starts = records.map((record, index) => record.type === 'event_msg' && record.payload?.type === 'task_started' ? index : -1).filter(index => index >= 0);
  const completions = records.map((record, index) => record.type === 'event_msg' && record.payload?.type === 'task_complete' ? index : -1).filter(index => index >= 0);
  if (starts.length !== 1 || (prefix && records[starts[0]].payload.turn_id !== prefix.turn_id)
      || (!prefix && (completions.length !== 1 || completions[0] <= starts[0]
      || records[completions[0]].payload.turn_id !== records[starts[0]].payload.turn_id
      || records[completions[0]].payload.last_agent_message !== resultText)))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'file consumption is not bound to the original native completion');
  const finalIndex = records.findIndex((record, index) => index > starts[0] && record.type === 'response_item'
    && record.payload?.type === 'message' && record.payload.role === 'assistant' && record.payload.phase === 'final_answer');
  if (!prefix && (finalIndex < 0 || records[finalIndex].payload.content?.map(block => block.text || '').join('') !== resultText))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'native final response differs from the returned result');
  const emittedFinal = records.findIndex(record => record.type === 'event_msg'
    && record.payload?.type === 'item_completed' && record.payload.item?.phase === 'final_answer');
  const interrupted = prefix ? records.findIndex(record => record.type === 'event_msg'
    && ['task_aborted', 'task_failed'].includes(record.payload?.type)) : -1;
  const boundary = Math.min(...[finalIndex, completions[0], emittedFinal, interrupted].filter(index => index >= 0), records.length);
  const expected = [{ path: prepared.input_bundle.manifest_path,
    bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let reads = expected.flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / chunkBytes) }, (_, index) => ({
    command: 'dd if=' + quote(asset.path) + ' bs=' + chunkBytes
      + ' skip=' + index + ' count=1 2>/dev/null | base64',
    bytes: asset.bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes),
  })));
  if (v3) {
    const collector = require('./codex-arch-review-context.cjs');
    reads = checked.manifest.batches.flatMap(batch => {
      const frames = collector.batchFrames(checked.manifest, checked.manifest_bytes, checked.material, batch.index);
      const command = collector.batchCommand(prepared.input_bundle, batch.index);
      const output = collector.batchOutput(checked.manifest, checked.manifest_bytes, checked.material, batch.index);
      return frames.map((frame, frame_index) => ({ command, bytes: Buffer.from(frame.base64, 'base64'),
        output, frames, frame_index, batch_index: batch.index, frame_count: batch.count, batch_start: batch.start }));
    });
    const start = prefix?.start || 0;
    if (reads[start] && reads[start].frame_index !== 0) fail('REVIEW_RESTART_REQUIRED', 'resume is inside an atomic batch');
  }
  let at = prefix?.start || 0;
  const completedRanges = [];
  const lines = nativeRaw.split('\n').filter(Boolean);
  const prefixHasher = crypto.createHash('sha256');
  let nativeBytes = 0;
  const pending = new Map();
  const calls = new Set();
  const credited = new Set();
  const customArguments = item => {
    if (!['exec', 'functions.exec'].includes(item.name) || typeof item.input !== 'string') return null;
    const match = /^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(([\s\S]+)\)\s*\)\s*;?\s*$/.exec(item.input);
    if (!match) return null;
    let args; try { args = JSON.parse(match[1]); } catch { return null; }
    if (!object(args) || !Object.keys(args).every(key => ['cmd', 'max_output_tokens'].includes(key))
        || (args.max_output_tokens !== undefined && (!Number.isInteger(args.max_output_tokens)
          || args.max_output_tokens < 1 || args.max_output_tokens > 10000))) return null;
    return args;
  };
  for (const [index, record] of records.entries()) {
    if (prefix) {
      const line = lines[index] + '\n';
      nativeBytes += Buffer.byteLength(line); prefixHasher.update(line);
    }
    const item = record.payload;
    if (record.type !== 'response_item' || !item) continue;
    const custom = item.type === 'custom_tool_call';
    if (custom || (item.type === 'function_call' && /(?:^|[._])exec_command$/.test(item.name || ''))) {
      let args;
      if (custom) args = customArguments(item);
      else { try { args = JSON.parse(item.arguments); } catch { continue; } }
      if (!object(args)) {
        if (v3 && custom && item.input?.includes('--read-batch') && !prefix)
          fail('RUNTIME_EVIDENCE_MISMATCH', 'batch is not one exact physical wrapper');
        continue;
      }
      if (typeof args.cmd !== 'string' || !(v3
        ? args.cmd.includes('--read-batch')
        : expected.some(asset => args.cmd.startsWith('dd if=' + quote(asset.path) + ' ')))) continue;
      if ((prefix || item.internal_chat_message_metadata_passthrough?.turn_id !== undefined)
          && item.internal_chat_message_metadata_passthrough?.turn_id !== records[starts[0]].payload.turn_id)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native read belongs to a foreign task');
      if (index <= starts[0] || index >= boundary) fail('RUNTIME_EVIDENCE_MISMATCH', 'native read is outside the original task input boundary');
      if (args.cmd !== reads[at]?.command || at >= prepared.input_bundle.max_chunk_reads)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read is reordered, duplicated or exceeds its budget');
      if (pending.size) fail('RUNTIME_EVIDENCE_MISMATCH', 'ordered file read did not finish before the next read');
      if (typeof item.call_id !== 'string' || !item.call_id || calls.has(item.call_id))
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read repeats a call identity');
      if ((v2 || prefix) && ((!custom && !v3) || args.max_output_tokens !== 10000
          || Object.keys(args).some(key => !['cmd', 'max_output_tokens'].includes(key))))
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native reader changed its supported output policy');
      calls.add(item.call_id);
      pending.set(item.call_id, { ...reads[at], custom });
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type) && credited.has(item.call_id))
      fail('RUNTIME_EVIDENCE_MISMATCH', 'native range received repeated output credit');
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type) && pending.has(item.call_id)) {
      if (index >= boundary) fail('RUNTIME_EVIDENCE_MISMATCH', 'native read completed after the result');
      if ((prefix || item.internal_chat_message_metadata_passthrough?.turn_id !== undefined)
          && item.internal_chat_message_metadata_passthrough?.turn_id !== records[starts[0]].payload.turn_id)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native read output belongs to a foreign task');
      const read = pending.get(item.call_id);
      if (read.custom !== (item.type === 'custom_tool_call_output'))
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read output has a foreign transport');
      try {
        const envelopeBytes = Buffer.byteLength(JSON.stringify(item.output));
        largestEnvelope = Math.max(largestEnvelope, envelopeBytes);
        if (envelopeBytes > 252 * 1024) fail('READER_CAPACITY_UNSUPPORTED', 'native reader envelope exceeds its bound');
        if (!measurement && prepared.input_bundle.transport && envelopeBytes > prepared.input_bundle.transport.output_budget_bytes)
          fail('READER_CAPACITY_UNSUPPORTED', 'reader exceeded its measured output envelope');
        outputBytes += envelopeBytes;
        if (outputBytes > 128 * 1024 * 1024) fail('READER_CAPACITY_UNSUPPORTED', 'reader output budget exceeded');
        let output = item.output;
        if (read.custom) {
          if (!Array.isArray(output) || output.some(block => !['text', 'input_text'].includes(block?.type) || typeof block.text !== 'string'))
            fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read output is not the original text response');
          if (output.length !== 2 || !/^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/.test(output[0].text))
            fail('RUNTIME_EVIDENCE_MISMATCH', 'native read output has surplus or unsupported text');
          const results = output.slice(1).flatMap(block => {
            try { const result = JSON.parse(block.text); return object(result) && typeof result.output === 'string' ? [result] : []; }
            catch { return []; }
          });
          if (results.length !== 1 || results[0].exit_code !== 0 || results[0].session_id !== undefined)
            fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read did not complete successfully');
          nestedBytes += Buffer.byteLength(output[1].text);
          largestNested = Math.max(largestNested, Buffer.byteLength(output[1].text));
          if (v3 && (Buffer.byteLength(output[1].text) > 252 * 1024
              || /(?:truncated|original token count|original_token_count)/i.test(output[0].text)
              || results[0].original_token_count !== undefined || results[0].truncated === true))
            fail('RUNTIME_EVIDENCE_MISMATCH', 'batch nested envelope is incomplete');
          output = results[0].output;
        } else {
          let parsed; try { parsed = JSON.parse(output); } catch {}
          if (!object(parsed)) fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read lacks a successful output envelope');
          if (object(parsed)) {
            if (parsed.exit_code !== 0 || parsed.session_id !== undefined)
              fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read did not complete successfully');
            nestedBytes += Buffer.byteLength(output);
            largestNested = Math.max(largestNested, Buffer.byteLength(output));
            if (v3 && (typeof output !== 'string' || typeof parsed.output !== 'string' || Buffer.byteLength(output) > 252 * 1024
                || parsed.original_token_count !== undefined || parsed.truncated === true))
              fail('RUNTIME_EVIDENCE_MISMATCH', 'batch direct envelope is incomplete');
            output = parsed.output ?? parsed.stdout;
          }
        }
        const encoded = read.bytes.toString('base64');
        if (v3) {
          if (output !== read.output) fail('RUNTIME_EVIDENCE_MISMATCH', 'batch header, ordered frames or terminal differs from complete source');
          if (!measurement && (envelopeBytes > prepared.input_bundle.reader_capacity.largest_envelope_bytes
              || Buffer.byteLength(read.custom ? item.output[1].text : item.output) > prepared.input_bundle.reader_capacity.largest_nested_bytes))
            fail('READER_CAPACITY_UNSUPPORTED', 'batch exceeded original measured envelopes');
          encodedBytes += read.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.base64), 0);
          rawBytes += read.frames.reduce((sum, frame) => sum + frame.bytes, 0);
        } else {
          if (typeof output !== 'string' || (v2 && !/^[A-Za-z0-9+/=\r\n]*$/.test(output))
              || output.replace(v2 ? /[\r\n]/g : /\s/g, '') !== encoded)
            fail('RUNTIME_EVIDENCE_MISMATCH', 'original native file read is incomplete or truncated');
          encodedBytes += Buffer.byteLength(output);
          rawBytes += read.bytes.length;
        }
        physicalCalls++; successfulCallIds.push(item.call_id);
        credited.add(item.call_id);
        pending.delete(item.call_id);
        const count = v3 ? read.frame_count : 1;
        for (let frameIndex = 0; frameIndex < count; frameIndex++) {
          const range = reads[at + frameIndex];
          successfulRangeOrdinals.push(at + frameIndex);
          if (prefix) completedRanges.push({ ordinal: at + frameIndex, command: range.command,
            sha256: crypto.createHash('sha256').update(range.bytes).digest('hex'), bytes: range.bytes.length,
            call_id: item.call_id, native_bytes: nativeBytes, native_sha256: prefixHasher.copy().digest('hex'),
            ...(v3 ? { batch_index: read.batch_index, batch_count: checked.manifest.batches.length, frame_index: frameIndex, frame_count: count,
              batch_start: read.batch_start, profile_sha256: checked.manifest.transport.profile_sha256 } : {}) });
        }
        at += count;
      } catch (error) {
        if (!v3 || !prefix || !['RUNTIME_EVIDENCE_MISMATCH', 'READER_CAPACITY_UNSUPPORTED'].includes(error.code)) throw error;
        pending.delete(item.call_id); credited.add(item.call_id); failedDeliveries++;
      }
    }
  }
  if (!prefix && (at !== reads.length || pending.size)) fail('RUNTIME_EVIDENCE_MISMATCH', 'complete original native file consumption is unproven');
  return { ...checked, chunk_reads: at,
    ...(v3 ? { physical_calls: physicalCalls, failed_deliveries: failedDeliveries, largest_nested_bytes: largestNested,
      successful_call_ids: successfulCallIds, successful_range_ordinals: successfulRangeOrdinals } : {}), output_bytes: outputBytes, encoded_bytes: encodedBytes, largest_envelope_bytes: largestEnvelope,
    ...(prefix ? { completed_ranges: completedRanges, pending_reads: pending.size } : {}),
    observed_raw_bytes: rawBytes,
    transport_accounting: { raw_bytes: expected.reduce((sum, asset) => sum + asset.bytes.length, 0),
      encoded_bytes: encodedBytes, nested_output_bytes: nestedBytes, outer_output_bytes: outputBytes } };
}

const reviewObservations = new WeakMap();
const reviewResumptions = new WeakMap();
const reviewHash = value => crypto.createHash('sha256').update(value).digest('hex');

function reviewObservation(data, validate) {
  const token = Object.freeze({});
  reviewObservations.set(token, { data: freeze(data), validate });
  return token;
}

function reviewObservationData(token) {
  const observation = reviewObservations.get(token);
  if (!observation) fail('REVIEW_PROGRESS_INVALID', 'caller bytes cannot mint original native progress');
  observation.validate();
  return observation.data;
}

function readReviewNativeFile(file, worktree, live = false) {
  if (typeof file !== 'string' || fs.realpathSync(file) !== file || pathInside(worktree, file))
    fail('REVIEW_RESTART_REQUIRED', 'native semantic context must be original and outside the writer tree');
  let ancestor = path.dirname(file);
  for (;;) {
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid() && stat.uid !== 0)
        || ((stat.mode & 0o002) && !(stat.mode & 0o1000)))
      fail('REVIEW_RESTART_REQUIRED', 'native context has an untrusted ancestor');
    if (path.dirname(ancestor) === ancestor) break;
    ancestor = path.dirname(ancestor);
  }
  const physical = fs.lstatSync(file);
  if (!physical.isFile() || physical.isSymbolicLink() || physical.uid !== process.getuid()
      || (physical.mode & 0o022) || physical.size > NATIVE_SESSION_MAX_BYTES)
    fail('REVIEW_RESTART_REQUIRED', 'native context is not a bounded original regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const bytes = Buffer.alloc(before.size);
    let at = 0;
    while (at < bytes.length) {
      const count = fs.readSync(fd, bytes, at, bytes.length - at, at);
      if (!count) fail('REVIEW_OBSERVATION_BUSY', 'native context changed during observation');
      at += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if ([before, after, current].some(stat => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
      .some(key => stat[key] !== physical[key])))
      fail('REVIEW_OBSERVATION_BUSY', 'native context changed during observation');
    const complete = live ? bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1) : bytes;
    return new TextDecoder('utf-8', { fatal: true }).decode(complete);
  } finally { fs.closeSync(fd); }
}

function originalReviewFile(sessionId, env, worktree, live = false) {
  const home = path.resolve(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const matches = nativeSessionCandidates(path.join(home, 'sessions'), sessionId);
  if (!matches.length) return null;
  if (matches.length !== 1) fail('REVIEW_RESTART_REQUIRED', 'original review session is ambiguous');
  readReviewNativeFile(matches[0], worktree, live);
  return matches[0];
}

function validateReviewNative(raw, sessionId, selection) {
  const parsed = parseNativeCodexTranscript(raw, sessionId);
  const records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)
      || records.filter(record => record.type === 'session_meta').length !== 1
      || parsed.selections.some(value => value.model !== selection.model || value.effort !== selection.effort))
    fail('REVIEW_RESTART_REQUIRED', 'native review UUID, provider or selection changed');
  if (records.some(record => ['compacted', 'context_compaction'].includes(record.type)
      || record.payload?.type === 'context_compacted'))
    fail('REVIEW_RESTART_REQUIRED', 'native semantic context requires an authenticated handoff or full review');
  for (const record of records.filter(record => record.type === 'turn_context')) {
    const context = record.payload;
    if ((context.cwd !== undefined && context.cwd !== selection.worktree)
        || (context.sandbox_policy?.type !== undefined && context.sandbox_policy.type !== selection.sandbox_mode))
      fail('REVIEW_RESTART_REQUIRED', 'native review changed worktree or sandbox');
  }
  return { parsed, records };
}

function verifyBatchCapacityReference(prepared, checked, raw) {
  if (checked.manifest.transport?.schema !== 'shipyard.native-reader-transport.v3') return;
  const capacity = prepared.input_bundle.reader_capacity;
  if (capacity?.schema !== 'shipyard.native-reader-transport.v3'
      || capacity.profile_sha256 !== checked.manifest.transport.profile_sha256
      || capacity.manifest_sha256 !== prepared.input_bundle.manifest_sha256 || capacity.output_tokens !== 10000
      || capacity.binding_sha256 !== reviewHash(readerSubject(checked.manifest))
      || capacity.schedule_sha256 !== reviewHash(JSON.stringify(checked.manifest.batches))
      || !Number.isSafeInteger(capacity.native_bytes) || capacity.native_bytes < 1 || capacity.native_bytes > NATIVE_SESSION_MAX_BYTES)
    fail('READER_CAPACITY_UNSUPPORTED', 'protected capacity differs from this exact finite input');
  const source = completedSourceInputs.get(prepared);
  const original = raw || (source ? completedSourceSnapshot(source).raw
    : readReviewNativeFile(capacity.native_file, checked.manifest.snapshot.worktree));
  if (Buffer.byteLength(original) !== capacity.native_bytes || reviewHash(original) !== capacity.native_sha256)
    fail('READER_CAPACITY_UNSUPPORTED', 'original measured batch evidence changed');
  validateReviewNative(original, capacity.native_session_id, { ...capacity.selection, sandbox_mode: capacity.sandbox_mode, worktree: checked.manifest.snapshot.worktree });
  const records = original.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const completions = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_complete');
  if (completions.length !== 1) fail('READER_CAPACITY_UNSUPPORTED', 'capacity no longer has its original completed output');
  const record = require('./role-artifact.cjs').authenticateReaderCapacityReferences({
    worktree: checked.manifest.snapshot.worktree, receipt_store: capacity.application_receipt_store,
    dispatch_id: capacity.application_dispatch_id,
  });
  const stable = require('./model-policy-internal.cjs').stableStringify;
  const association = record.receipt.runtime_evidence?.reader_capacity_probe;
  if ((association ? stable(capacity.probe_association) !== stable(association)
        || association.review_dispatch_id !== checked.manifest.dispatch_id
        || association.probe_dispatch_id !== capacity.application_dispatch_id
      : capacity.application_dispatch_id !== checked.manifest.dispatch_id || capacity.probe_association !== undefined)
      || reviewHash(stable(record)) !== capacity.application_record_sha256
      || reviewHash(stable(record.receipt)) !== capacity.application_receipt_sha256
      || record.receipt.runtime_evidence?.native_session_evidence?.sha256 !== capacity.native_sha256
      || record.receipt.runtime_evidence?.native_session_evidence?.bytes !== capacity.native_bytes
      || record.receipt.runtime_evidence?.session_id !== capacity.native_session_id)
    fail('READER_CAPACITY_UNSUPPORTED', 'protected capacity differs from its original recorded application');
  validateCapacityApplicationRecord({ native_session_evidence: record.receipt.runtime_evidence.native_session_evidence,
    last_agent_message: completions[0].payload.last_agent_message }, checked.manifest, record, record.receipt);
  const measured = verifyCheckedFileConsumption(checked, prepared, original, completions[0].payload.last_agent_message,
    { chunk_bytes: checked.manifest.chunk_bytes, output_tokens: 10000 });
  if (measured.largest_envelope_bytes !== capacity.largest_envelope_bytes || measured.largest_nested_bytes !== capacity.largest_nested_bytes
      || measured.physical_calls !== capacity.physical_calls || measured.chunk_reads !== capacity.logical_ranges)
    fail('READER_CAPACITY_UNSUPPORTED', 'protected capacity output bounds changed');
}

const completedSourceInputs = new WeakMap();
const completedSourceCapacities = new WeakMap();
const completedSourceCandidates = new Map();
const completedSourceOperations = new Set();
function fileCapacityForSource(prepared) { return completedSourceCapacities.get(prepared); }
function completedSourceSnapshot(source) {
  const raw = readReviewNativeFile(source.snapshot.path, source.identity.worktree);
  if (Buffer.byteLength(raw) !== source.snapshot.bytes || reviewHash(raw) !== source.snapshot.sha256)
    fail('REVIEW_SOURCE_INVALID', 'immutable measured source snapshot changed');
  const live = readReviewNativeFile(source.native_file, source.identity.worktree);
  const bytes = Buffer.from(live);
  if (bytes.length < source.snapshot.bytes || reviewHash(bytes.subarray(0, source.snapshot.bytes)) !== source.snapshot.sha256)
    fail('REVIEW_SOURCE_INVALID', 'live original reviewer context lost its exact measured prefix');
  validateReviewNative(live, source.session_id, { ...source.original_launch, worktree: source.identity.worktree });
  return { raw, live };
}

function prepareCompletedSource(capacity, prepared, finalPrompt = prepared.prompt) {
  const collector = require('./codex-arch-review-context.cjs'), authority = require('./role-artifact.cjs');
  const measured = readerCapacities.get(capacity), checked = collector.verifyFileInput(prepared);
  collector.reviewProgressIdentity(prepared);
  if (!measured || measured.contract.schema !== 'shipyard.native-reader-transport.v3'
      || !prepared.input_bundle.reader_capacity || readerSubject(checked.manifest) !== measured.subject)
    fail('REVIEW_SOURCE_REQUIRED', 'completed source requires private exact candidate measurement and capacity admission');
  readerCapacityContract(capacity, checked.manifest);
  const original = capacityApplication(measured.verified, checked.manifest);
  const evidence = original.receipt.runtime_evidence;
  const raw = measured.launch.raw;
  const turn = freshReviewTurn(raw, measured.verified.last_agent_message);
  const consumed = verifyCheckedFileConsumption(checked, prepared, raw, measured.verified.last_agent_message,
    { chunk_bytes: checked.manifest.chunk_bytes, output_tokens: 10000 });
  if (evidence.native_child_evidence || evidence.reader_capacity_probe?.review_dispatch_id !== checked.manifest.dispatch_id
      || evidence.dispatch_id === checked.manifest.dispatch_id || consumed.failed_deliveries)
    fail('REVIEW_SOURCE_INVALID', 'original static complete probe lacks applicable reviewer attribution');
  const candidate = completedSourceCandidates.get(checked.manifest.dispatch_id);
  if (!candidate || candidate.recorder !== original.recorder.storeDir
      || reviewHash(require('./model-policy-internal.cjs').stableStringify(completedReviewIdentity(checked, prepared.input_bundle))) !== candidate.identity_sha256)
    fail('REVIEW_SOURCE_REQUIRED', 'completed source requires its private pre-measurement final reservation and all-attempt ledger');
  const finalReservation = original.recorder.getReservation(checked.manifest.dispatch_id);
  if (!finalReservation || finalReservation.recorded) fail('REVIEW_SOURCE_CLAIMED', 'final lacks its unused original reservation');
  const source = { identity: completedReviewIdentity(checked, prepared.input_bundle), final_reservation: finalReservation,
    final_prompt: finalPrompt,
    input: { prompt: prepared.prompt, input_bundle: prepared.input_bundle, input_bytes: prepared.input_bytes,
      inputTokens: prepared.inputTokens }, native_file: measured.contract.native_file, native_raw: raw,
    session_id: measured.contract.native_session_id, turn_id: turn, completed_ranges: checked.chunk_reads,
    probe_dispatch_id: evidence.dispatch_id, receipt_store: original.recorder.storeDir,
    record_sha256: original.record_sha256, probe_evidence: evidence,
    original_launch: { model: evidence.applied_model, effort: evidence.applied_effort, sandbox_mode: 'read-only',
      agent_file: checked.manifest.binding.agent_file, agent_file_digest: original.receipt.agent_file_digest,
      process_id: evidence.process_id, runtime_launch: evidence }, semantic_context: 'exact-native-session',
    source_consumption: { chunk_reads: consumed.chunk_reads, physical_calls: consumed.physical_calls,
      call_ids: consumed.successful_call_ids, range_ordinals: consumed.successful_range_ordinals } };
  const observation = reviewObservation(source, () => {
    collector.verifyFileInput(prepared);
    if (readReviewNativeFile(source.native_file, source.identity.worktree) !== raw)
      fail('REVIEW_SOURCE_INVALID', 'original completed reviewer changed before snapshot sealing');
    capacityApplication(measured.verified, checked.manifest);
  });
  const reference = authority.sealCompletedReviewSource(observation);
  measured.completedSource = authority.readCompletedReviewSource({ worktree: source.identity.worktree, reference });
  completedSourceCapacities.set(prepared, measured);
  return reference;
}

function verifyCompletedSourceTurn(source, prepared, nativeRaw, resultText, material) {
  const authority = require('./role-artifact.cjs');
  if (!authority.isAuthenticatedCompletedSource(source)) fail('REVIEW_SOURCE_REQUIRED', 'source consumption needs original protected capability');
  const checked = material || require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
  if (require('./model-policy-internal.cjs').stableStringify(completedReviewIdentity(checked, prepared.input_bundle))
      !== require('./model-policy-internal.cjs').stableStringify(source.identity))
    fail('REVIEW_SOURCE_INVALID', 'final changed original subject, material or finalized profile');
  const { raw } = completedSourceSnapshot(source);
  verifyBatchCapacityReference(prepared, checked, raw);
  const rows = raw.split('\n').filter(Boolean).map(JSON.parse);
  const originalResult = rows.find(record => record.type === 'event_msg' && record.payload?.type === 'task_complete')?.payload.last_agent_message;
  const prefix = verifyCheckedFileConsumption(checked, prepared, raw, originalResult,
    { chunk_bytes: checked.manifest.chunk_bytes, output_tokens: 10000 });
  const bytes = Buffer.from(nativeRaw), resume = source.state.resume;
  if (!resume || resume.native_bytes !== source.snapshot.bytes || resume.native_sha256 !== source.snapshot.sha256
      || bytes.length <= resume.native_bytes || reviewHash(bytes.subarray(0, resume.native_bytes)) !== resume.native_sha256)
    fail('REVIEW_SOURCE_INVALID', 'final is not an immediate append to its immutable measured context');
  const append = bytes.subarray(resume.native_bytes).toString('utf8');
  const turn = freshReviewTurn(append, resultText);
  if (turn === source.turn_id || resultText === originalResult)
    fail('REVIEW_SOURCE_INVALID', 'old probe verdict cannot become a fresh final result');
  const fresh = append.split('\n').filter(Boolean).map(JSON.parse);
  if (fresh.some(record => record.type === 'turn_context'
      && record.payload.model_provider !== undefined && record.payload.model_provider !== 'openai'))
    fail('REVIEW_SOURCE_INVALID', 'fresh final changed its original provider');
  const users = fresh.filter(record => record.type === 'response_item' && record.payload?.role === 'user');
  if (users.length !== 1 || users[0].payload.content?.map(block => block.text).join('') !== completedSourcePrompt(source, prepared, checked)
      || fresh.some(record => record.type === 'response_item'
        && ['function_call', 'custom_tool_call'].includes(record.payload?.type)))
    fail('REVIEW_SOURCE_INVALID', 'final added an intervening prompt, old conclusions or duplicate physical source reads');
  const suffix = verifyCheckedFileConsumption(checked, prepared, append, resultText, null,
    { turn_id: turn, start: source.completed_ranges });
  if (suffix.pending_reads || suffix.physical_calls || suffix.chunk_reads !== checked.chunk_reads)
    fail('REVIEW_SOURCE_INVALID', 'final source consumption differs from its authenticated complete original schedule');
  return { ...prefix, turn_id: turn, newly_completed_ranges: 0, source_dispatch_id: source.probe_dispatch_id,
    new_physical_calls: 0 };
}

function completedSourcePrompt(source, prepared, checked) {
  // @invariant: only the reauthenticated manifest supplies the final schedule and profile after restoration.
  const manifest = checked.manifest;
  return 'Issue a genuinely fresh current judgment against this exact admitted final input. Re-evaluate the authenticated source frames already present in this native conversation. '
    + 'The completed probe result and its conclusions are obsolete and supply no semantic authority. Do not copy that result or reread authenticated source. '
    + 'Preserve the original final result contract and identity echoes. Return the complete final JSON with evidence_markdown directly; '
    + 'the host writes the final evidence. This final turn uses the already authenticated frames and makes no tool calls.\n'
    + 'INPUT_MANIFEST_SHA256=' + prepared.input_bundle.manifest_sha256
    + '\ninput_chunk_reads=' + source.completed_ranges + '\ninput_batch_reads=' + manifest.batches.length
    + '\ninput_profile_sha256=' + manifest.transport.profile_sha256
    + '\nFINAL_ADMITTED_PROMPT:\n' + source.final_prompt;
}

function validateCompletedSourceRestoration(source, prepared) {
  if (!require('./role-artifact.cjs').isAuthenticatedCompletedSource(source))
    fail('REVIEW_SOURCE_CLAIMED', 'source restoration requires an original completed reservation');
  if (source.state.resume?.status === 'completed') {
    validateCompletedSourceReconciliation(source, prepared);
    return source;
  }
  if (source.state.resume) validateCompletedSourceClaimRecovery(source);
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
  const { raw, live } = completedSourceSnapshot(source);
  if (raw !== live) fail('REVIEW_SOURCE_INVALID', 'completed reviewer has intervening native turns');
  if (require('./model-policy-internal.cjs').stableStringify(completedReviewIdentity(checked, prepared.input_bundle))
      !== require('./model-policy-internal.cjs').stableStringify(source.identity)) fail('REVIEW_SOURCE_INVALID', 'cold source subject changed');
  verifyBatchCapacityReference(prepared, checked, raw);
  return source;
}

function validateCompletedSourceReconciliation(source, prepared) {
  const authority = require('./role-artifact.cjs'), collector = require('./codex-arch-review-context.cjs');
  if (!authority.isAuthenticatedCompletedSource(source) || source.state.resume?.status !== 'completed'
      || !source.state.resume.launch_started || !Number.isSafeInteger(source.state.resume.owner_pid)
      || source.state.resume.owner_pid < 1 || completedSourceOperations.has(source.identity.dispatch_id))
    fail('REVIEW_SOURCE_CLAIMED', 'original completed final is missing or still active');
  if (source.state.resume.owner_pid !== process.pid) {
    let dead = false;
    try { process.kill(source.state.resume.owner_pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
    if (!dead) fail('REVIEW_SOURCE_CLAIMED', 'original final owner is active or its custody is unknown');
  }
  const identity = collector.reviewProgressIdentity(prepared);
  if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(source.identity[key])))
    fail('REVIEW_RESTART_REQUIRED', 'current subject changed before completed final reconciliation');
  const completion = source.state.resume.completion;
  if (completion?.schema !== 'shipyard.completed-source-completion.v1'
      || !object(completion.application) || !object(completion.application.runtime_evidence) || !object(completion.cli_snapshot)
      || reviewHash(require('./model-policy-internal.cjs').stableStringify(completion.application.runtime_evidence))
      !== source.state.resume.evidence_sha256)
    fail('REVIEW_SOURCE_INVALID', 'original completed application custody is missing');
  const cli = readReviewNativeFile(completion.cli_snapshot.path, source.identity.worktree);
  const evidence = completion.application.runtime_evidence;
  if (Buffer.byteLength(cli) !== completion.cli_snapshot.bytes || reviewHash(cli) !== completion.cli_snapshot.sha256
      || completion.cli_snapshot.bytes !== evidence.transcript?.bytes || completion.cli_snapshot.sha256 !== evidence.transcript?.sha256
      || completion.application.launch_id !== 'codex-' + source.session_id + '-' + reviewHash(source.identity.dispatch_id).slice(0, 24)
      || completion.application.session_id !== source.session_id
      || completion.application.process_id !== evidence.process_id
      || completion.application.agent_file !== source.original_launch.agent_file
      || completion.application.agent_file_digest !== source.original_launch.agent_file_digest
      || ['applied_model', 'observed_model'].some(key => completion.application[key] !== source.original_launch.model)
      || ['applied_effort', 'observed_effort'].some(key => completion.application[key] !== source.original_launch.effort))
    fail('REVIEW_SOURCE_INVALID', 'retained original application or CLI bytes changed');
  authority.validateCompletedSourceEvidence(evidence);
  return completion.application;
}

function validateCompletedSourceClaimRecovery(source) {
  if (!require('./role-artifact.cjs').isAuthenticatedCompletedSource(source)
      || source.state.resume?.status !== 'claimed' || source.state.resume.launch_started
      || !Number.isSafeInteger(source.state.resume.owner_pid))
    fail('REVIEW_SOURCE_CLAIMED', 'only a protected uncompleted claim can be restored');
  let dead = false;
  try { process.kill(source.state.resume.owner_pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
  if (!dead) fail('REVIEW_SOURCE_CLAIMED', 'original source claimant is active or its inactivity is uncertain');
  const { raw, live } = completedSourceSnapshot(source);
  if (raw !== live || source.state.resume.native_bytes !== source.snapshot.bytes
      || source.state.resume.native_sha256 !== source.snapshot.sha256)
    fail('REVIEW_SOURCE_INVALID', 'claimed source already has native output or an intervening turn');
  return source;
}

function authenticateCompletedSourceInput(prepared, dispatchId) {
  const authority = require('./role-artifact.cjs');
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
  const source = authority.readCompletedReviewSource({ worktree: checked.manifest.snapshot.worktree, dispatch_id: dispatchId });
  const record = authority.authenticateReaderCapacityReferences({ worktree: source.identity.worktree,
    receipt_store: source.receipt_store, dispatch_id: dispatchId });
  if (record.receipt.runtime_evidence?.completed_source?.source?.sha256 !== source.state.reference.sha256)
    fail('REVIEW_SOURCE_INVALID', 'original final receipt lacks the sealed completed source');
  authority.validateCompletedSourceEvidence(record.receipt.runtime_evidence);
  completedSourceInputs.set(prepared, source);
  return source;
}

function validateCompletedSourceConsumption(source, evidence) {
  const collector = require('./codex-arch-review-context.cjs');
  const checked = collector.verifyFileInput(source.input.input_bundle, { sealed: true, historical: true });
  const prepared = { ...source.input, manifest: checked.manifest };
  const raw = readReviewNativeFile(source.native_file, source.identity.worktree);
  const cli = readReviewNativeFile(evidence.transcript.path, source.identity.worktree);
  if (Buffer.byteLength(cli) !== evidence.transcript.bytes || reviewHash(cli) !== evidence.transcript.sha256
      || Buffer.byteLength(raw) !== evidence.native_session_evidence.bytes || reviewHash(raw) !== evidence.native_session_evidence.sha256)
    fail('REVIEW_SOURCE_INVALID', 'fresh original final native or CLI transcript changed');
  const parsed = parseCodexStream(cli);
  const finals = parsed.records.filter(record => record.item?.type === 'agent_message');
  if (parsed.session_id !== source.session_id || finals.length !== 1)
    fail('REVIEW_SOURCE_INVALID', 'fresh final completion changed reviewer UUID');
  const consumed = verifyCompletedSourceTurn(source, prepared, raw, finals[0].item.text, checked);
  const canonical = require('./model-policy-internal.cjs').stableStringify;
  const lineage = evidence.input_consumption;
  if (lineage?.physical_call_provenance !== 'original-completed-source'
      || lineage.source_dispatch_id !== source.probe_dispatch_id || lineage.current_turn_physical_calls !== 0
      || canonical(lineage.original_call_ids) !== canonical(consumed.successful_call_ids)
      || canonical(lineage.original_range_ordinals) !== canonical(consumed.successful_range_ordinals))
    fail('REVIEW_SOURCE_INVALID', 'fresh final changed original physical source provenance');
  return consumed;
}

function verifyProtectedReviewPrefix(progress, prepared, raw, material) {
  const parentContext = progress.original_launch.parent_context;
  if (parentContext) {
    const parent = Buffer.from(readReviewNativeFile(parentContext.file, progress.identity.worktree));
    if (reviewHash(parent.subarray(0, parentContext.bytes)) !== parentContext.sha256)
      fail('REVIEW_RESTART_REQUIRED', 'original typed parent association changed');
  }
  const bytes = Buffer.from(raw);
  const boundary = progress.range.native_bytes;
  if (bytes.length < boundary || reviewHash(bytes.subarray(0, boundary)) !== progress.range.native_sha256)
    fail('REVIEW_RESTART_REQUIRED', 'original native semantic context was replaced or truncated');
  const prefix = bytes.subarray(0, boundary).toString('utf8');
  validateReviewNative(prefix, progress.session_id, { ...progress.original_launch, worktree: progress.identity.worktree });
  const checked = material
    ? verifyCheckedFileConsumption(material, prepared, prefix, null, null, { turn_id: progress.turn_id })
    : verifyFileConsumption(prepared, prefix, progress.identity.dispatch_id, null, null, { turn_id: progress.turn_id });
  if (checked.pending_reads || checked.chunk_reads !== progress.completed_ranges
      || checked.completed_ranges.length !== progress.chain.length
      || checked.completed_ranges.some((range, index) => Object.keys(range).some(key => range[key] !== progress.chain[index].range[key])))
    fail('REVIEW_RESTART_REQUIRED', 'protected ranges differ from original native outputs');
  return checked;
}

function reviewOriginInactive(progress) {
  if (progress.state.original_exit) return;
  const pid = progress.original_launch.process_id;
  if (!Number.isSafeInteger(pid) || pid < 1) fail('REVIEW_RESTART_REQUIRED', 'original native process identity is missing');
  let dead = false;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
  if (!dead) fail('REVIEW_RESTART_REQUIRED', 'original native reviewer process is active or uncertain');
}

function readSchedule(prepared) {
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
  if (checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3') {
    const collector = require('./codex-arch-review-context.cjs');
    return checked.manifest.batches.flatMap(batch => Array.from({ length: batch.count }, () => ({
      command: collector.batchCommand(prepared.input_bundle, batch.index) })));
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return [{ path: prepared.input_bundle.manifest_path, bytes: checked.manifest_bytes },
    ...checked.manifest.assets.map((asset, index) => ({ path: asset.path, bytes: checked.material[index] }))]
    .flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / prepared.input_bundle.chunk_bytes) }, (_, index) => ({
      command: 'dd if=' + quote(asset.path) + ' bs=' + prepared.input_bundle.chunk_bytes
        + ' skip=' + index + ' count=1 2>/dev/null | base64',
    })));
}

function freshReviewTurn(raw, resultText) {
  const records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const starts = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
  const turn = starts[0]?.payload.turn_id;
  const completion = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_complete');
  const finals = records.filter(record => record.type === 'response_item' && record.payload?.type === 'message'
    && record.payload.role === 'assistant' && record.payload.phase === 'final_answer');
  if (records.some(record => record.type === 'event_msg' && ['task_failed', 'task_aborted', 'turn_failed', 'error'].includes(record.payload?.type))
      || starts.length !== 1 || completion.length !== 1 || finals.length !== 1 || typeof turn !== 'string' || !turn
      || records.indexOf(starts[0]) >= records.indexOf(finals[0]) || records.indexOf(finals[0]) >= records.indexOf(completion[0])
      || completion[0].payload.turn_id !== turn || completion[0].payload.last_agent_message !== resultText
      || finals[0].payload.internal_chat_message_metadata_passthrough?.turn_id !== turn
      || !Array.isArray(finals[0].payload.content) || !finals[0].payload.content.length
      || finals[0].payload.content.some(block => block.type !== 'output_text' || typeof block.text !== 'string')
      || finals[0].payload.content.map(block => block.text).join('') !== resultText)
    fail('RUNTIME_EVIDENCE_MISMATCH', 'continuation lacks one fresh ordered completed judgment');
  return turn;
}

function verifyResumedReview(progress, prepared, nativeRaw, resultText, material) {
  const identity = material ? completedReviewIdentity(material, prepared.input_bundle)
    : require('./codex-arch-review-context.cjs').reviewProgressIdentity(prepared);
  if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(progress.identity[key])))
    fail('REVIEW_RESTART_REQUIRED', 'current subject changed before fresh final admission');
  verifyProtectedReviewPrefix(progress, prepared, nativeRaw, material);
  const resume = progress.state.resume;
  const bytes = Buffer.from(nativeRaw);
  if (bytes.length <= resume.native_bytes || reviewHash(bytes.subarray(0, resume.native_bytes)) !== resume.native_sha256)
    fail('REVIEW_RESTART_REQUIRED', 'original conversation differs from the protected pre-resume context');
  const newRaw = bytes.subarray(resume.native_bytes).toString('utf8');
  if (prepared.input_bundle.transport?.schema === 'shipyard.native-reader-transport.v3') {
    const priorCalls = new Set(bytes.subarray(0, resume.native_bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter(record => record.type === 'response_item' && batchPhysicalArguments(record.payload || {}).some(args => args.cmd?.includes('--read-batch')))
      .map(record => record.payload.call_id));
    if (newRaw.split('\n').filter(Boolean).map(JSON.parse).some(record => record.type === 'response_item'
        && batchPhysicalArguments(record.payload || {}).some(args => args.cmd?.includes('--read-batch')) && priorCalls.has(record.payload.call_id)))
      fail('RUNTIME_EVIDENCE_MISMATCH', 'fresh batch reuses an original physical call identity');
  }

  const turn = freshReviewTurn(newRaw, resultText);
  if (turn === progress.turn_id) fail('RUNTIME_EVIDENCE_MISMATCH', 'historical turn cannot become a fresh judgment');
  const contexts = newRaw.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(record => record.type === 'turn_context');
  if (!contexts.length || contexts.some(record => record.payload?.turn_id !== undefined && record.payload.turn_id !== turn))
    fail('REVIEW_RESTART_REQUIRED', 'resumed turn lacks native selection attestation');
  const checked = material
    ? verifyCheckedFileConsumption(material, prepared, newRaw, resultText, null, { turn_id: turn, start: progress.completed_ranges })
    : verifyFileConsumption(prepared, newRaw, progress.identity.dispatch_id, resultText, null,
      { turn_id: turn, start: progress.completed_ranges });
  if (checked.pending_reads || checked.chunk_reads !== (material || require('./codex-arch-review-context.cjs').verifyFileInput(prepared)).chunk_reads)
    fail('RUNTIME_EVIDENCE_MISMATCH', 'fresh review has incomplete total current coverage');
  return { ...checked, turn_id: turn };
}

function completedReviewIdentity(checked, bundle) {
  const canonical = require('./model-policy-internal.cjs').stableStringify;
  const manifest = checked.manifest, binding = manifest.binding;
  if (!object(binding)) fail('REVIEW_RESTART_REQUIRED', 'original review binding is missing');
  const pins = checked.material.map(bytes => {
    let semantic; try { semantic = JSON.parse(bytes.toString('utf8')); } catch {}
    return typeof semantic?.schema === 'string' && semantic.schema.startsWith('shipyard.semantic-content.')
      ? { dictionary: semantic.dictionary_sha256, obligations: semantic.obligations_sha256 }
      : { dictionary: reviewHash(bytes), obligations: reviewHash(canonical(binding)) };
  });
  return { manifest_digest: reviewHash(canonical(manifest)), manifest_sha256: bundle.manifest_sha256,
    dictionary_digest: reviewHash(JSON.stringify(pins.map(pin => pin.dictionary))),
    obligation_digest: reviewHash(JSON.stringify(pins.map(pin => pin.obligations))),
    repository: manifest.snapshot.repository, worktree: manifest.snapshot.worktree, role: manifest.role,
    policy_hash: manifest.snapshot.policy_hash, contract: manifest.schema,
    head: manifest.snapshot.head, head_tree: manifest.snapshot.head_tree, base: binding.base,
    base_ref: binding.base_ref || null, merge_base: binding.merge_base,
    ticket_set: binding.ticket_set, ticket_set_digest: binding.ticket_set_digest,
    dispatch_id: manifest.dispatch_id, run_id: manifest.run_id, ticket: manifest.ticket, phase: manifest.phase };
}

function verifyCompletedSourceAccounting(selectors) {
  const keys = ['worktree', 'source', 'receipt_store', 'dispatch_id'];
  if (!object(selectors) || Object.keys(selectors).length !== keys.length || Object.keys(selectors).some(key => !keys.includes(key)))
    fail('REVIEW_SOURCE_REQUIRED', 'completed source accounting requires only original reference selectors');
  const authority = require('./role-artifact.cjs'), collector = require('./codex-arch-review-context.cjs');
  const record = authority.authenticateReaderCapacityReferences({ worktree: selectors.worktree,
    receipt_store: selectors.receipt_store, dispatch_id: selectors.dispatch_id });
  const evidence = record.receipt.runtime_evidence;
  const source = authority.validateCompletedSourceEvidence(evidence);
  if (require('./model-policy-internal.cjs').stableStringify(selectors.source)
      !== require('./model-policy-internal.cjs').stableStringify(source.state.reference)) fail('REVIEW_SOURCE_INVALID', 'final source selector changed');
  const checked = collector.verifyFileInput(source.input.input_bundle, { sealed: true, historical: true });
  const bundle = source.input.input_bundle, prepared = { ...source.input, manifest: checked.manifest };
  const { raw, live } = completedSourceSnapshot(source);
  const finalCli = readReviewNativeFile(evidence.transcript.path, source.identity.worktree);
  const result = parseCodexStream(finalCli).records.find(row => row.item?.type === 'agent_message').item.text;
  const consumed = verifyCompletedSourceTurn(source, prepared, live, result, checked);
  const originalPin = source.probe_evidence.transcript;
  const originalCli = readReviewNativeFile(originalPin.path, source.identity.worktree);
  if (Buffer.byteLength(originalCli) !== originalPin.bytes || reviewHash(originalCli) !== originalPin.sha256)
    fail('REVIEW_SOURCE_INVALID', 'original completed probe CLI changed');
  const append = Buffer.from(live).subarray(source.snapshot.bytes).toString('utf8');
  const attempts = [completedReviewAttempt(raw, originalCli, source.probe_dispatch_id, source.session_id,
    source.turn_id, checked, bundle, 'completed'), completedReviewAttempt(append, finalCli, evidence.dispatch_id,
    source.session_id, source.state.resume.turn_id, checked, bundle, 'completed')];
  const ledger = authority.readReviewSourceAttempts(source);
  const originalEntry = ledger.find(attempt => attempt.dispatch_id === source.probe_dispatch_id);
  if (!originalEntry || originalEntry.status !== 'completed' || originalEntry.receipt_store !== source.receipt_store
      || originalEntry.receipt_sha256 !== reviewHash(require('./model-policy-internal.cjs').stableStringify(
        authority.authenticateReaderCapacityReferences({ worktree: source.identity.worktree,
          receipt_store: source.receipt_store, dispatch_id: source.probe_dispatch_id }).receipt)))
    fail('REVIEW_SOURCE_INVALID', 'original successful probe is missing from the all-attempt denominator');
  const retained = [];
  const finalEntry = ledger.find(attempt => attempt.dispatch_id === evidence.dispatch_id);
  if (finalEntry?.kind !== 'final' || finalEntry.status !== 'completed'
      || finalEntry.evidence_sha256 !== source.state.resume.evidence_sha256
      || finalEntry.source?.sha256 !== source.state.reference.sha256)
    fail('REVIEW_SOURCE_INVALID', 'fresh original final is missing from the complete attempt denominator');
  const finalSnapshot = finalEntry.physical?.native_snapshot;
  if (!finalSnapshot || finalSnapshot.bytes !== Buffer.byteLength(append) || finalSnapshot.sha256 !== reviewHash(append)
      || readReviewNativeFile(finalSnapshot.path, source.identity.worktree) !== append)
    fail('REVIEW_SOURCE_INVALID', 'fresh final immutable physical cost snapshot changed');
  for (const entry of ledger.filter(attempt => ![source.probe_dispatch_id, evidence.dispatch_id].includes(attempt.dispatch_id))) {
    const pin = entry.physical?.native_snapshot;
    if (pin) {
      const bytes = readReviewNativeFile(pin.path, source.identity.worktree);
      if (Buffer.byteLength(bytes) !== pin.bytes || reviewHash(bytes) !== pin.sha256)
        fail('REVIEW_SOURCE_INVALID', 'failed physical attempt snapshot changed');
      const cliPin = entry.physical.transcript;
      const cli = readReviewNativeFile(cliPin.path, source.identity.worktree);
      if (Buffer.byteLength(cli) !== cliPin.bytes || reviewHash(cli) !== cliPin.sha256)
        fail('REVIEW_SOURCE_INVALID', 'failed original CLI snapshot changed');
      const turn = bytes.split('\n').filter(Boolean).map(JSON.parse).find(row => row.payload?.type === 'task_started')?.payload.turn_id;
      if (!turn) fail('REVIEW_SOURCE_INVALID', 'failed physical attempt has no original turn identity');
      const originalBundle = entry.input_bundle;
      if (!originalBundle) fail('REVIEW_SOURCE_INVALID', 'failed original attempt lost its immutable input identity');
      const originalChecked = collector.verifyFileInput(originalBundle, { sealed: true, historical: true });
      if (require('./model-policy-internal.cjs').stableStringify(completedReviewIdentity(originalChecked, originalBundle))
          !== require('./model-policy-internal.cjs').stableStringify(entry.identity))
        fail('REVIEW_SOURCE_INVALID', 'failed physical attempt changed its original source or roster identity');
      let status = entry.status;
      if (entry.kind !== 'final' && entry.status === 'completed') {
        const originalRecord = authority.authenticateReaderCapacityReferences({ worktree: source.identity.worktree,
          receipt_store: entry.receipt_store, dispatch_id: entry.dispatch_id });
        const originalEvidence = originalRecord.receipt.runtime_evidence;
        if (reviewHash(require('./model-policy-internal.cjs').stableStringify(originalRecord.receipt)) !== entry.receipt_sha256
            || originalEvidence.native_session_evidence.sha256 !== pin.sha256
            || originalEvidence.reader_capacity_probe?.review_dispatch_id !== entry.identity.dispatch_id)
          fail('REVIEW_SOURCE_INVALID', 'historical completed probe differs from its original receipt');
        const originalResult = parseCodexStream(cli).records.find(row => row.item?.type === 'agent_message')?.item.text;
        validateCapacityApplicationRecord({ native_session_evidence: originalEvidence.native_session_evidence,
          last_agent_message: originalResult }, originalChecked.manifest, originalRecord, originalRecord.receipt);
        verifyCheckedFileConsumption(originalChecked, { input_bundle: originalBundle }, bytes, originalResult,
          { chunk_bytes: originalChecked.manifest.chunk_bytes, output_tokens: 10000 });
      }
      if (entry.kind === 'final') {
        const originalSource = authority.readCompletedReviewSource({ worktree: source.identity.worktree, reference: entry.source });
        if (originalSource.identity.dispatch_id !== entry.dispatch_id || originalSource.probe_dispatch_id !== entry.original_probe_dispatch_id)
          fail('REVIEW_SOURCE_INVALID', 'historical final lost its original source and dispatch lineage');
        if (entry.status === 'completed') {
          const finalRecord = require('./dispatch-boundary.cjs').createDurableRecorder(entry.receipt_store).getVerifiedRecord(entry.dispatch_id);
          if (!finalRecord) status = 'pending';
          else if (reviewHash(require('./model-policy-internal.cjs').stableStringify(
            authority.authenticateReaderCapacityReferences({ worktree: source.identity.worktree,
              receipt_store: entry.receipt_store, dispatch_id: entry.dispatch_id }).receipt.runtime_evidence)) !== entry.evidence_sha256)
            fail('REVIEW_SOURCE_INVALID', 'historical final durable receipt changed');
        }
      }
      const attempt = completedReviewAttempt(bytes, cli, entry.dispatch_id, entry.physical.native.session_id,
        turn, originalChecked, originalBundle, status, entry.physical.native.session_id,
        entry.kind !== 'final' && entry.status === 'completed', true);
      delete attempt.read_commands; delete attempt.call_ids;
      retained.push({ ...attempt, native_status: entry.native_status || entry.status, setup_costs: entry.setup_costs });
    } else retained.push({ dispatch_id: entry.dispatch_id, status: entry.status,
      started_at_ms: entry.started_at_ms, ended_at_ms: entry.ended_at_ms ?? null,
      physical_costs: null, unavailable_reasons: { physical_costs: entry.physical?.reason || 'pending original attempt has no completed physical observation' },
      setup_costs: entry.setup_costs });
  }
  if (attempts[1].call_ids.some(id => attempts[0].call_ids.includes(id))) fail('REVIEW_SOURCE_INVALID', 'fresh final reuses original physical call IDs');
  for (const attempt of attempts) { delete attempt.read_commands; delete attempt.call_ids; }
  const stable = require('./model-policy-internal.cjs').stableStringify;
  const current = completedSourceSnapshot(source);
  if (current.raw !== raw || current.live !== live || readReviewNativeFile(evidence.transcript.path, source.identity.worktree) !== finalCli
      || stable(authority.readReviewSourceAttempts(source)) !== stable(ledger)
      || stable(authority.authenticateReaderCapacityReferences({ worktree: selectors.worktree,
        receipt_store: selectors.receipt_store, dispatch_id: selectors.dispatch_id })) !== stable(record))
    fail('REVIEW_SOURCE_INVALID', 'original physical costs or completed receipts changed during accounting');
  const allAttempts = [...retained, ...attempts];
  const total = field => allAttempts.every(attempt => Number.isFinite(attempt[field]))
    ? allAttempts.reduce((sum, attempt) => sum + attempt[field], 0) : null;
  const costFields = { raw: 'delivered_raw_bytes', encoded: 'delivered_base64_bytes',
    nested: 'observed_nested_bytes', outer: 'observed_outer_bytes' };
  const physicalBytes = Object.fromEntries(Object.entries(costFields).map(([name, field]) => [name, total(field)]));
  const unavailable = Object.fromEntries(Object.entries(physicalBytes).filter(([, value]) => value === null)
    .map(([name]) => [name, 'at least one original failed, pending or completed attempt lacks this full physical observation']));
  return freeze({ schema: 'shipyard.completed-source-consumption.v1', identity: source.identity,
    probe_dispatch_id: source.probe_dispatch_id, final_dispatch_id: evidence.dispatch_id,
    source_snapshot: source.snapshot, attempts: allAttempts, all_attempt_denominator: ledger.length,
    successful_physical_calls: consumed.physical_calls,
    logical_ranges: consumed.chunk_reads, original_source_call_ids: consumed.successful_call_ids,
    original_range_ordinals: consumed.successful_range_ordinals,
    physical_bytes: physicalBytes, unavailable_reasons: unavailable,
    successful_source_bytes: { raw: consumed.observed_raw_bytes, encoded: consumed.encoded_bytes,
      nested: consumed.transport_accounting.nested_output_bytes, outer: consumed.output_bytes },
    setup_costs: { value: null, reason: 'setup outside original runtime attempt transcripts is unavailable' },
    semantic_credit: false, current_verdict_authority: false });
}

function verifyCompletedReviewConsumption(selectors) {
  if (selectors?.source !== undefined) return verifyCompletedSourceAccounting(selectors);
  const authority = require('./role-artifact.cjs');
  const collector = require('./codex-arch-review-context.cjs');
  const canonical = require('./model-policy-internal.cjs').stableStringify;
  const authenticated = authority.authenticateCompletedReviewReferences(selectors);
  const progress = authenticated.progress, evidence = authenticated.record.receipt.runtime_evidence;
  const bundle = progress.input.input_bundle;
  const checked = collector.verifyFileInput(bundle, { sealed: true, historical: true,
    association: { role: progress.identity.role, dispatch_id: progress.identity.dispatch_id } });
  const prepared = { input_bundle: bundle };
  const identity = completedReviewIdentity(checked, bundle);
  if (canonical(identity) !== canonical(progress.identity))
    fail('REVIEW_RESTART_REQUIRED', 'immutable input differs from original protected identity');
  const retained = [];
  const read = (file, pin) => {
    const stat = fs.lstatSync(file);
    if (stat.mode & 0o077) fail('RUNTIME_EVIDENCE_MISMATCH', 'completed physical evidence is not private');
    const raw = readReviewNativeFile(file, identity.worktree);
    if (!raw.endsWith('\n')) fail('RUNTIME_EVIDENCE_MISMATCH', 'physical evidence lacks a complete JSONL boundary');
    if (pin && (Buffer.byteLength(raw) !== pin.bytes || reviewHash(raw) !== pin.sha256))
      fail('RUNTIME_EVIDENCE_MISMATCH', 'physical evidence differs from its protected complete-byte pin');
    retained.push({ file, raw, stat });
    return raw;
  };
  if (bundle.transport?.schema === 'shipyard.native-reader-transport.v3') {
    const capacityRaw = read(bundle.reader_capacity?.native_file, { bytes: bundle.reader_capacity?.native_bytes,
      sha256: bundle.reader_capacity?.native_sha256 });
    verifyBatchCapacityReference(prepared, checked, capacityRaw);
  }
  const raw = read(progress.native_file);
  if (Buffer.byteLength(raw) !== evidence.native_session_evidence?.bytes
      || evidence.native_session_evidence?.file !== path.basename(progress.native_file)
      || evidence.native_session_evidence?.session_id !== progress.session_id
      || reviewHash(raw) !== evidence.native_session_evidence?.sha256
      || evidence.input_consumption?.native_session_sha256 !== reviewHash(raw))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'completed native session differs from its protected receipt');
  validateReviewNative(raw, progress.session_id, { ...progress.original_launch, worktree: identity.worktree });
  if (progress.original_launch.parent_context) read(progress.original_launch.parent_context.file);
  const cli = read(evidence.transcript?.path, evidence.transcript);
  const parsed = parseCodexStream(cli);
  const finals = parsed.records.filter(record => record.type === 'item.completed' && record.item?.type === 'agent_message');
  const starts = parsed.records.filter(record => record.type === 'turn.started');
  const completions = parsed.records.filter(record => record.type === 'turn.completed');
  if (parsed.session_id !== progress.session_id || starts.length !== 1 || finals.length !== 1 || completions.length !== 1
      || parsed.records.indexOf(starts[0]) >= parsed.records.indexOf(finals[0])
      || parsed.records.indexOf(finals[0]) >= parsed.records.indexOf(completions[0]) || typeof finals[0].item.text !== 'string')
    fail('RUNTIME_EVIDENCE_MISMATCH', 'completed CLI lacks one exact-session ordered final');
  const prefix = verifyProtectedReviewPrefix(progress, prepared, raw, checked);
  const suffix = verifyResumedReview(progress, prepared, raw, finals[0].item.text, checked);
  if (suffix.turn_id !== progress.state.resume.turn_id
      || evidence.input_consumption?.chunk_reads !== checked.chunk_reads
      || evidence.review_continuation.newly_completed_ranges !== checked.chunk_reads - progress.completed_ranges)
    fail('RUNTIME_EVIDENCE_MISMATCH', 'completed total differs from protected fresh-turn accounting');
  const originalCliPin = progress.state.original_exit.transcript;
  const originalCli = read(originalCliPin.path, originalCliPin);
  const originalRaw = Buffer.from(raw).subarray(0, progress.state.resume.native_bytes).toString('utf8');
  const freshRaw = Buffer.from(raw).subarray(progress.state.resume.native_bytes).toString('utf8');
  const originalStarts = originalRaw.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
  if (!originalRaw.endsWith('\n') || originalStarts.length !== 1 || originalStarts[0].payload.turn_id !== progress.turn_id)
    fail('REVIEW_RESTART_REQUIRED', 'pre-resume context has intervening or incomplete original turns');
  const originalObserved = verifyCheckedFileConsumption(checked, prepared, originalRaw, null, null, { turn_id: progress.turn_id });
  if (originalObserved.chunk_reads < progress.completed_ranges)
    fail('REVIEW_RESTART_REQUIRED', 'original attempt lost its already protected physical prefix');
  const v3 = checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3';
  if (v3) {
    let final; try { final = JSON.parse(finals[0].item.text); } catch {}
    const finalEcho = key => final?.[key] ?? new RegExp('(?:^|\\n)' + key + '=([^\\n]+)(?:\\n|$)').exec(finals[0].item.text)?.[1];
    if (evidence.input_consumption?.schema !== 'shipyard.native-file-consumption.v3'
        || evidence.input_consumption.physical_calls !== checked.manifest.batches.length
        || evidence.input_consumption.logical_ranges !== checked.chunk_reads
        || evidence.input_consumption.profile_sha256 !== checked.manifest.transport.profile_sha256
        || String(finalEcho('input_batch_reads')) !== String(checked.manifest.batches.length)
        || finalEcho('input_profile_sha256') !== checked.manifest.transport.profile_sha256)
      fail('RUNTIME_EVIDENCE_MISMATCH', 'completed physical accounting or fresh profile echoes changed');
  }
  const coverage = (value, reads) => ({ successful_reads: reads,
    ...(v3 ? { logical_ranges: reads, successful_physical_calls: value.physical_calls,
      call_ids: value.successful_call_ids, range_ordinals: value.successful_range_ordinals } : {}), raw_bytes: value.observed_raw_bytes,
    encoded_bytes: value.encoded_bytes, nested_bytes: value.transport_accounting.nested_output_bytes,
    outer_bytes: value.output_bytes });
  const inherited = coverage(prefix, progress.completed_ranges);
  const newly = coverage(suffix, checked.chunk_reads - progress.completed_ranges);
  const total = Object.fromEntries(Object.keys(inherited).map(key => [key,
    Array.isArray(inherited[key]) ? [...inherited[key], ...newly[key]] : inherited[key] + newly[key]]));
  if (v3 && (new Set(total.call_ids).size !== total.call_ids.length
      || new Set(total.range_ordinals).size !== checked.chunk_reads
      || total.range_ordinals.some((ordinal, index) => ordinal !== index)
      || total.successful_physical_calls !== checked.manifest.batches.length))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'completed batches and logical coverage disagree');
  const attempts = [completedReviewAttempt(originalRaw, originalCli, progress.identity.dispatch_id,
    progress.session_id, progress.turn_id, checked, bundle, 'interrupted', progress.parent_session_id || progress.session_id),
  completedReviewAttempt(freshRaw, cli, evidence.dispatch_id, progress.session_id, suffix.turn_id, checked, bundle, 'completed')];
  attempts[0].original_exit = progress.state.original_exit;
  attempts[0].accepted_historical_final = false;
  if (attempts[1].call_ids.some(call => attempts[0].call_ids.includes(call)))
    fail('RUNTIME_EVIDENCE_MISMATCH', 'fresh attempt replayed an original reader call identity');
  attempts[1].retries += attempts[1].read_commands.filter(command => attempts[0].read_commands.includes(command)).length;
  for (const attempt of attempts) { delete attempt.read_commands; delete attempt.call_ids; }
  for (const pin of retained) {
    const current = fs.lstatSync(pin.file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid'].some(key => current[key] !== pin.stat[key])
        || readReviewNativeFile(pin.file, identity.worktree) !== pin.raw)
      fail('RUNTIME_EVIDENCE_MISMATCH', 'original physical evidence changed during completed accounting');
  }
  const rechecked = collector.verifyFileInput(bundle, { sealed: true, historical: true,
    association: { role: identity.role, dispatch_id: identity.dispatch_id } });
  if (canonical(completedReviewIdentity(rechecked, bundle)) !== canonical(identity)
      || canonical(authority.authenticateCompletedReviewReferences(selectors)) !== canonical(authenticated))
    fail('REVIEW_RESTART_REQUIRED', 'protected references changed during completed accounting');
  return freeze({ schema: v3 ? 'shipyard.completed-review-consumption.v3' : 'shipyard.completed-review-consumption.v1', identity,
    evidence_pins: { progress: selectors.progress, dispatch_id: evidence.dispatch_id,
      receipt_store: fs.realpathSync(selectors.receipt_store),
      receipt_reference: 'record-' + reviewHash(evidence.dispatch_id) + '.json', native_file: progress.native_file,
      original_launch_sha256: reviewHash(canonical(progress.original_launch.runtime_launch)),
      receipt_sha256: reviewHash(canonical(authenticated.record)), completed_evidence_sha256: progress.state.resume.evidence_sha256,
      manifest_sha256: bundle.manifest_sha256, native_session_sha256: reviewHash(raw),
      original_transcript: originalCliPin, completed_transcript: evidence.transcript },
    coverage: { prefix: inherited, new: newly, total }, scheduled_reads: checked.chunk_reads,
    ...(v3 ? { scheduled_physical_calls: checked.manifest.batches.length, profile_sha256: checked.manifest.transport.profile_sha256 } : {}), attempts,
    semantic_credit: false, current_verdict_authority: false });
}

function batchPhysicalArguments(item) {
  if (item.type === 'function_call' && /(?:^|[._])exec_command$/.test(item.name || '')) {
    try { return [JSON.parse(item.arguments)]; } catch { return []; }
  }
  if (item.type !== 'custom_tool_call' || !['exec', 'functions.exec'].includes(item.name)) return [];
  const argumentsList = [];
  const operations = /tools\.exec_command\s*\(\s*(\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})\s*\)/g;
  for (const match of (item.input || '').matchAll(operations)) {
    try { argumentsList.push(JSON.parse(match[1])); } catch { return []; }
  }
  return argumentsList;
}

function completedReviewAttempt(raw, cli, dispatchId, sessionId, turnId, checked, bundle, status, cliSessionId = sessionId, originalMeasurementCosts = false, truthfulSourceCosts = false) {
  const v3 = checked.manifest.transport?.schema === 'shipyard.native-reader-transport.v3';
  const batchReads = v3 ? checked.manifest.batches.map(batch => ({
    command: require('./codex-arch-review-context.cjs').batchCommand(bundle, batch.index),
    output: require('./codex-arch-review-context.cjs').batchOutput(checked.manifest, checked.manifest_bytes, checked.material, batch.index),
    frames: require('./codex-arch-review-context.cjs').batchFrames(checked.manifest, checked.manifest_bytes, checked.material, batch.index),
  })) : [];
  let attemptRawBytes = 0, attemptEncodedBytes = 0, attemptNestedBytes = 0, attemptOuterBytes = 0, nestedUnavailable = false;
  let sourceCostUnavailable = false;
  const records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const assets = [bundle.manifest_path, ...checked.manifest.assets.map(asset => asset.path)];
  const calls = new Map(), outputs = new Set(), commands = new Map();
  let successful = 0, failed = 0, physicalOperations = 0;
  for (const record of records) {
    const item = record.type === 'response_item' ? record.payload : null;
    if (!item) continue;
    if (v3 && ['custom_tool_call', 'function_call'].includes(item.type)) {
      const operations = batchPhysicalArguments(item).filter(args => args?.cmd?.includes('--read-batch'));
      if (!operations.length) continue;
      if (item.internal_chat_message_metadata_passthrough?.turn_id !== turnId || calls.has(item.call_id)
          || typeof item.call_id !== 'string' || !item.call_id)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt call has a foreign or duplicate identity');
      for (const args of operations) {
        if (!batchReads.some(read => read.command === args.cmd) || args.max_output_tokens !== 10000
            || Object.keys(args).some(key => !['cmd', 'max_output_tokens'].includes(key)))
          fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt changed its finite physical command');
        commands.set(args.cmd, (commands.get(args.cmd) || 0) + 1);
      }
      physicalOperations += operations.length;
      const single = /^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(([^]+)\)\s*\)\s*;?\s*$/.exec(item.input || '');
      let singleArgs; try { singleArgs = single && JSON.parse(single[1]); } catch {}
      const exact = operations.length === 1 && (item.type === 'function_call'
        || (['exec', 'functions.exec'].includes(item.name) && object(singleArgs) && singleArgs.cmd === operations[0].cmd));
      calls.set(item.call_id, { operations, exact, custom: item.type === 'custom_tool_call' });
    } else if (!v3 && item.type === 'custom_tool_call') {
      const match = /^\s*text\s*\(\s*await\s+tools\.exec_command\s*\(([^]+)\)\s*\)\s*;?\s*$/.exec(item.input || '');
      let args; try { args = match && JSON.parse(match[1]); } catch {}
      if (!args || !assets.some(file => args.cmd?.startsWith("dd if='" + file.replaceAll("'", "'\\''") + "' "))) continue;
      if (item.internal_chat_message_metadata_passthrough?.turn_id !== turnId || calls.has(item.call_id))
        fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt call has a foreign or duplicate identity');
      calls.set(item.call_id, args.cmd);
      commands.set(args.cmd, (commands.get(args.cmd) || 0) + 1);
    }
    if ((item.type === 'custom_tool_call_output' || (v3 && item.type === 'function_call_output')) && calls.has(item.call_id)) {
      if (outputs.has(item.call_id) || item.internal_chat_message_metadata_passthrough?.turn_id !== turnId)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt output has a foreign or repeated identity');
      outputs.add(item.call_id);
      if (v3) {
        const outerBytes = Buffer.byteLength(JSON.stringify(item.output));
        if (outerBytes > 252 * 1024) fail('READER_CAPACITY_UNSUPPORTED', 'attempt exceeds bounded original outer envelope');
        attemptOuterBytes += outerBytes;
        const call = calls.get(item.call_id);
        const textOuter = Array.isArray(item.output)
          && item.output.every(block => ['text', 'input_text'].includes(block?.type) && typeof block.text === 'string')
          && /^Script completed\nWall time [0-9.]+ seconds\nOutput:\s*$/.test(item.output[0]?.text || '');
        const completeOuter = call.custom ? item.type === 'custom_tool_call_output' && textOuter && item.output.length === 2
          : item.type === 'function_call_output' && typeof item.output === 'string';
        const associated = textOuter && item.output.length === call.operations.length + 1
          ? item.output.slice(1).map(block => block.text)
          : item.type === 'function_call_output' && call.operations.length === 1 && typeof item.output === 'string'
          ? [item.output] : [];
        const nestedResults = associated.map(value => {
          attemptNestedBytes += Buffer.byteLength(value);
          try { return JSON.parse(value); } catch { return null; }
        });
        if (!associated.length) nestedUnavailable = true;
        const nested = nestedResults[0];
        const expected = batchReads.find(read => read.command === call.operations[0].cmd);
        if (call.exact && completeOuter && nested?.exit_code === 0 && nested.session_id === undefined
            && nested.original_token_count === undefined && nested.truncated !== true
            && outerBytes <= (bundle.reader_capacity?.largest_envelope_bytes || (status !== 'completed' || originalMeasurementCosts ? 252 * 1024 : 0))
            && Buffer.byteLength(associated[0]) <= Math.min(252 * 1024,
              bundle.reader_capacity?.largest_nested_bytes || (status !== 'completed' || originalMeasurementCosts ? 252 * 1024 : 0))
            && nested.output === expected.output) {
          successful++;
          attemptRawBytes += expected.frames.reduce((sum, frame) => sum + frame.bytes, 0);
          attemptEncodedBytes += expected.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.base64), 0);
        } else {
          // @invariant: Grouped outputs earn no credit; observed pending operations remain separate from failed delivery.
          failed += call.operations.length - nestedResults.filter(result => object(result) && result.session_id !== undefined).length;
          if (truthfulSourceCosts) {
            if (nestedResults.length !== call.operations.length) sourceCostUnavailable = true;
            call.operations.forEach((operation, index) => {
              const output = nestedResults[index], observed = batchReads.find(read => read.command === operation.cmd);
              if (observed && output?.exit_code === 0 && output.session_id === undefined && output.original_token_count === undefined
                  && output.truncated !== true && output.output === observed?.output) {
                attemptRawBytes += observed.frames.reduce((sum, frame) => sum + frame.bytes, 0);
                attemptEncodedBytes += observed.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.base64), 0);
              } else sourceCostUnavailable = true;
            });
          }
        }
      } else {
        if (!Array.isArray(item.output) || item.output.length !== 2) fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt output is incomplete');
        if (Buffer.byteLength(JSON.stringify(item.output)) > 252 * 1024)
          fail('READER_CAPACITY_UNSUPPORTED', 'attempt output exceeds its original envelope bound');
        let output; try { output = JSON.parse(item.output[1].text); } catch {}
        if (!object(output) || !Number.isSafeInteger(output.exit_code) || output.session_id !== undefined)
          fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt lacks an observed terminal call outcome');
        if (output.exit_code === 0) successful++; else failed++;
      }
    }
  }
  const cliRecords = cli.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (cliRecords.length > 10000) fail('RUNTIME_EVIDENCE_INVALID', 'attempt CLI exceeds its original record bound');
  const sessions = cliRecords.filter(record => record.type === 'thread.started').map(record => record.thread_id);
  if (sessions.length !== 1 || sessions[0] !== cliSessionId)
    fail('RUNTIME_EVIDENCE_MISMATCH', 'attempt CLI has a foreign or ambiguous session');
  const usage = cliRecords.filter(record => record.type === 'turn.completed');
  const unavailable = {};
  const tokens = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', ...(v3 ? ['reasoning_output_tokens'] : [])]) {
    const observed = usage.length === 1 ? usage[0].usage?.[key] : undefined;
    tokens[key] = Number.isSafeInteger(observed) && observed >= 0 ? observed : null;
    if (tokens[key] === null) unavailable['tokens.' + key] = 'matching original CLI has no single bounded usage observation';
  }
  const taskStart = records.findIndex(record => record.type === 'event_msg' && record.payload?.type === 'task_started'
    && record.payload.turn_id === turnId);
  const timestamps = taskStart < 0 ? [] : records.slice(taskStart).map(record => Date.parse(record.timestamp));
  const elapsed = timestamps.length > 1 && timestamps.every(Number.isFinite)
    && timestamps.every((value, index) => !index || value >= timestamps[index - 1])
    ? timestamps.at(-1) - timestamps[0] : null;
  if (nestedUnavailable) unavailable.observed_nested_bytes = 'original outer response does not expose one complete nested envelope';
  if (elapsed === null) unavailable.elapsed_ms = 'matching native attempt lacks complete monotonic timestamps';
  const pending = v3 ? physicalOperations - successful - failed : calls.size - outputs.size;
  if (truthfulSourceCosts && (sourceCostUnavailable || pending)) {
    unavailable.delivered_raw_bytes = 'at least one original failed or pending physical output lacks complete decoded source bytes';
    unavailable.delivered_base64_bytes = 'at least one original failed or pending physical output lacks complete encoded source bytes';
  }
  if (truthfulSourceCosts && pending) {
    unavailable.observed_nested_bytes = 'an original pending physical call has no complete nested output';
    unavailable.observed_outer_bytes = 'an original pending physical call has no complete outer output';
  }
  return { dispatch_id: dispatchId, session_id: sessionId, cli_session_id: cliSessionId, turn_id: turnId, status,
    successful_calls: successful, failed_calls: failed,
    pending_calls: pending,
    retries: [...commands.values()].reduce((sum, count) => sum + count - 1, 0), elapsed_ms: elapsed,
    read_commands: [...commands.keys()],
    call_ids: [...calls.keys()],
    ...(v3 ? { delivered_raw_bytes: truthfulSourceCosts && (sourceCostUnavailable || pending) ? null : attemptRawBytes,
      delivered_base64_bytes: truthfulSourceCosts && (sourceCostUnavailable || pending) ? null : attemptEncodedBytes,
      observed_nested_bytes: nestedUnavailable || (truthfulSourceCosts && pending) ? null : attemptNestedBytes,
      observed_outer_bytes: truthfulSourceCosts && pending ? null : attemptOuterBytes,
      ...(truthfulSourceCosts && (sourceCostUnavailable || pending) ? { observed_partial_raw_bytes: attemptRawBytes,
        observed_partial_base64_bytes: attemptEncodedBytes, observed_partial_nested_bytes: attemptNestedBytes,
        observed_partial_outer_bytes: attemptOuterBytes } : {}) } : {}),
    tokens, unavailable_reasons: unavailable };
}

function liveReviewChild(parentRaw, parentId, launch, env, worktree) {
  const complete = parentRaw.slice(0, parentRaw.lastIndexOf('\n') + 1);
  const parentRecords = complete.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const spawnCall = parentRecords.find(record => record.type === 'response_item'
    && record.payload?.type === 'function_call' && record.payload.name === 'spawn_agent');
  if (!spawnCall) return null;
  const at = parentRecords.findIndex(record => record.type === 'response_item'
    && record.payload?.type === 'function_call_output' && record.payload.call_id === spawnCall.payload.call_id);
  if (at < 0) return null;
  const parentPrefix = complete.split('\n').filter(Boolean).slice(0, at + 1).join('\n') + '\n';
  const spawn = parseNativeParentSpawn(parentPrefix, parentId, launch.agent.role, launch.model, launch.effort, true);
  const home = path.resolve(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const matches = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(); date.setDate(date.getDate() + offset);
    const directory = sessionDirectory(path.join(home, 'sessions'), date);
    if (!fs.existsSync(directory)) continue;
    const names = fs.readdirSync(directory);
    if (names.length > 4096) fail('REVIEW_RESTART_REQUIRED', 'native child inventory exceeds its bound');
    for (const name of names.filter(name => name.endsWith('.jsonl'))) {
      const file = path.join(directory, name);
      const raw = readReviewNativeFile(file, worktree, true);
      let meta;
      try { meta = JSON.parse(raw.slice(0, raw.indexOf('\n'))); } catch { continue; }
      if (meta.type === 'session_meta' && meta.payload?.parent_thread_id === parentId)
        matches.push({ file, raw: raw.slice(0, raw.lastIndexOf('\n') + 1), session_id: meta.payload.id });
    }
  }
  if (matches.length > 1) fail('REVIEW_RESTART_REQUIRED', 'original parent has ambiguous semantic children');
  if (!matches.length) return null;
  const child = matches[0];
  let evidence;
  try {
    evidence = parseNativeChildTranscript(child.raw, child.session_id, parentId, launch.agent.role,
      launch.model, launch.effort, launch.agent, spawn, true);
    verifyTaskRelay(child.raw, launch.task, spawn);
    const records = child.raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const firstCall = records.find(record => record.type === 'response_item' && toolCommand(record.payload) !== null)?.payload;
    const output = records.find(record => record.type === 'response_item'
      && ['custom_tool_call_output', 'function_call_output'].includes(record.payload?.type)
      && record.payload.call_id === firstCall?.call_id)?.payload;
    const taskBytes = fs.readFileSync(launch.task.path, 'utf8');
    if (reviewHash(taskBytes) !== launch.task.sha256) fail('REVIEW_RESTART_REQUIRED', 'original reviewer task changed');
    if (!firstCall || !readsExactPath(toolCommand(firstCall), launch.task.path) || !output
        || !toolOutput(output).includes(taskBytes) || !toolOutput(output).includes('TASK_SHA256=' + launch.task.sha256)) return null;
  } catch (error) {
    if (['RUNTIME_EVIDENCE_MISSING', 'TASK_RELAY_UNVERIFIED'].includes(error.code)) return null;
    throw error;
  }
  return { ...child, evidence, parent_context: { file: originalReviewFile(parentId, env, worktree),
    bytes: Buffer.byteLength(parentPrefix), sha256: reviewHash(parentPrefix) } };
}

function createReviewObserver(prepared, launch, env, onProgress, processId) {
  const collector = require('./codex-arch-review-context.cjs');
  const identity = collector.reviewProgressIdentity(prepared);
  const authority = require('./role-artifact.cjs');
  let reference = null;
  const observer = sessionId => {
    const parentFile = originalReviewFile(sessionId, env, identity.worktree, true);
    if (!parentFile) return;
    const parentWhole = readReviewNativeFile(parentFile, identity.worktree, true);
    const semantic = launch.agent ? liveReviewChild(parentWhole, sessionId, launch, env, identity.worktree) : null;
    if (launch.agent && !semantic) return;
    const file = semantic?.file || parentFile;
    const reviewerSession = semantic?.session_id || sessionId;
    const parentSession = semantic ? sessionId : null;
    const whole = semantic?.raw || parentWhole;
    const raw = whole.slice(0, whole.lastIndexOf('\n') + 1);
    if (!raw) return;
    const pendingRecords = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!pendingRecords.some(record => record.type === 'turn_context')) return;
    const { records } = validateReviewNative(raw, reviewerSession, { ...launch, worktree: identity.worktree });
    const starts = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
    if (!starts.length) return;
    if (starts.length !== 1) fail('REVIEW_RESTART_REQUIRED', 'original reviewer has ambiguous turns');
    const turn = starts[0].payload.turn_id;
    if (typeof turn !== 'string' || !turn) fail('REVIEW_RESTART_REQUIRED', 'original reviewer has no native turn identity');
    const prefix = verifyFileConsumption(prepared, raw, identity.dispatch_id, null, null, { turn_id: turn });
    if (!prefix.completed_ranges.length) return;
    const input = { input_transport: 'host-files', input_bundle: prepared.input_bundle, prompt: prepared.prompt,
      input_bytes: prepared.input_bytes, inputTokens: prepared.inputTokens };
    const { sha256: _childHash, ...childAssociation } = semantic?.evidence || {};
    const pid = processId();
    if (!Number.isSafeInteger(pid) || pid < 1) fail('REVIEW_RESTART_REQUIRED', 'original native process lacks a positive identity');
    const savedLaunch = semantic ? { ...launch, process_id: pid, parent_context: semantic.parent_context,
      native_child_evidence: { ...childAssociation, schema: 'shipyard.codex-native-child-association.v1' } } : { ...launch, process_id: pid };
    const token = reviewObservation({ identity, input, launch: savedLaunch, session_id: reviewerSession, parent_session_id: parentSession,
      turn_id: turn, native_file: file, ranges: prefix.completed_ranges,
      stream: reviewHash(JSON.stringify([identity.manifest_sha256, launch.runtime_launch.command_digest, reviewerSession, turn])) }, () => {
      const current = readReviewNativeFile(file, identity.worktree, true);
      const last = prefix.completed_ranges.at(-1);
      if (reviewHash(Buffer.from(current).subarray(0, last.native_bytes)) !== last.native_sha256)
        fail('REVIEW_RESTART_REQUIRED', 'original observed output changed before protected persistence');
      collector.verifyFileInput(prepared);
    });
    const next = authority.persistReviewProgress(token);
    if (next && next.sha256 !== reference?.sha256) {
      reference = next;
      if (typeof onProgress === 'function') onProgress(reference);
    }
  };
  observer.finish = (exit, transcript) => {
    if (!reference) return;
    const token = reviewObservation({ worktree: identity.worktree, reference, process_id: processId(),
      exit: { code: exit.code ?? null, signal: exit.signal ?? null, transcript } }, () => {
      if (transcript) {
        const bytes = fs.readFileSync(transcript.path);
        if (bytes.length !== transcript.bytes || reviewHash(bytes) !== transcript.sha256)
          fail('REVIEW_RESTART_REQUIRED', 'original interrupted CLI transcript changed');
      }
    });
    authority.finishOriginalReviewObservation(token);
  };
  return observer;
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

function resolveProtectedPath(entry) {
  const resolved = path.resolve(entry);
  try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
}

function normalizeProtectedPaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean).map(resolveProtectedPath))];
}

function signerProtectionPaths(env, worktree) {
  const paths = [env.GNUPGHOME, process.env.GNUPGHOME, path.join(os.homedir(), '.gnupg'),
    path.join(os.homedir(), '.ssh')].filter(Boolean);
  const socket = env.SSH_AUTH_SOCK || process.env.SSH_AUTH_SOCK;
  if (socket) paths.push(socket);
  let key;
  try { key = execFileSync('git', ['-C', worktree, 'config', '--get', 'user.signingkey'], { encoding: 'utf8' }).trim(); }
  catch (_) { key = ''; }
  if (key && (path.isAbsolute(key) || key.startsWith('~/'))) {
    const file = path.resolve(key.startsWith('~/') ? path.join(os.homedir(), key.slice(2)) : key);
    paths.push(file);
  }
  return normalizeProtectedPaths(paths);
}

function staticEvidenceWritePath(worktree, launchOptions, sandbox) {
  if (sandbox !== 'read-only' || typeof launchOptions.agent_file_content !== 'string') return null;
  const names = {
    'shipyard-drift-check.toml': '.shipyard-drift-evidence.md',
    'shipyard-arch-review.toml': '.shipyard-arch-review-evidence.md',
    'shipyard-arch-review-critical.toml': '.shipyard-arch-review-evidence.md',
  };
  const name = names[launchOptions.agent_file];
  if (!name) return null;
  const file = path.join(worktree, name);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('INVALID_INPUT', 'role evidence path must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return file;
}

function signerPermissionProfileArgs(protectedPaths, sandbox, evidenceWritePath = null) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) {
    fail('INVALID_INPUT', 'Codex launch requires an explicit read-only or workspace-write permission profile');
  }
  const paths = normalizeProtectedPaths(protectedPaths);
  if (!paths.length) fail('SIGNER_ISOLATION_UNAVAILABLE', 'Codex signer paths could not be determined');
  const rules = paths.map((entry) => JSON.stringify(entry) + '="deny"');
  if (evidenceWritePath) rules.push(JSON.stringify(evidenceWritePath) + '="write"');
  const filesystem = '{' + rules.join(',') + '}';
  const parent = sandbox === 'read-only' ? ':read-only' : ':workspace';
  return [
    '--config', 'default_permissions=' + JSON.stringify(PERMISSION_PROFILE),
    '--config', 'permissions.' + PERMISSION_PROFILE + '.extends=' + JSON.stringify(parent),
    '--config', 'permissions.' + PERMISSION_PROFILE + '.filesystem=' + filesystem,
  ];
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
  if (options.additionalProtectedPaths !== undefined && !Array.isArray(options.additionalProtectedPaths)) {
    fail('INVALID_INPUT', 'additionalProtectedPaths must be an array of host-owned paths');
  }
  const archiveAuthority = require('./role-artifact.cjs').archiveAuthorityNamespace(true);
  const hostProtectedPaths = normalizeProtectedPaths([archiveAuthority, ...(options.additionalProtectedPaths || [])]);
  const taskDir = taskStateDir(options, scope);

  return async function launch(prompt, launchOptions = {}) {
    if (!object(launchOptions)) fail('INVALID_INPUT', 'Codex launch options must be an object');
    if (['archiveAuthorityPath', 'archiveCataloguePath', 'archive_authority_path', 'archive_catalogue_path']
      .some(key => Object.hasOwn(launchOptions, key)))
      fail('INVALID_INPUT', 'archive authority paths are fixed by the trusted host');
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
    const typedRole = launchOptions.gsd_role;
    const agent = typedRole ? installedGsdAgent(typedRole, environment) : null;
    const fileInput = launchOptions.input_prepared;
    const probeState = readerCapacityProbes.get(launchOptions.reader_capacity_probe);
    const capacityProbe = probeState?.prepared;
    if (launchOptions.reader_capacity_probe && (!capacityProbe || capacityProbe !== fileInput || typedRole
        || launchOptions.review_progress || launchOptions.resume_review
        || probeState.association.probe_dispatch_id !== launchOptions.dispatch_id))
      fail('READER_CAPACITY_UNSUPPORTED', 'capacity probe lacks original host candidate custody');
    const resumeReview = launchOptions.resume_review ? reviewResumptions.get(launchOptions.resume_review) : null;
    if (launchOptions.resume_review && !resumeReview) fail('REVIEW_PROGRESS_INVALID', 'serialized continuation has no host claim');
    const fileTransport = launchOptions.input_transport !== undefined || launchOptions.input_bundle !== undefined || fileInput !== undefined;
    if (fileTransport) {
      const collector = require('./codex-arch-review-context.cjs');
      if (launchOptions.input_transport !== 'host-files' || !collector.isPreparedFileInput(fileInput)
          || JSON.stringify(fileInput.input_bundle) !== JSON.stringify(launchOptions.input_bundle)
          || (typedRole && REVIEW_AGENT_ROLES[typedRole] !== fileInput.manifest.role)) fail('INVALID_INPUT', 'file transport lacks private producer authority');
      const normalizeRelay = value => value.replace(/launch_digest=[a-f0-9]{64}/g, 'launch_digest=' + '0'.repeat(64));
      if (typeof prompt !== 'string' || normalizeRelay(prompt) !== normalizeRelay(resumeReview ? resumeReview.prompt : fileInput.prompt))
        fail('INVALID_INPUT', 'native relay differs from private prepared input');
      if (!capacityProbe) collector.requireReaderBatchCapacity(fileInput);
      if (fileInput.manifest.transport?.schema === 'shipyard.native-reader-transport.v3'
          && (fileInput.manifest.transport.candidate.instructions_sha256 !== reviewHash(agent ? agent.instructions
            : resumeReview?.progress.original_launch.agent
            ? installedGsdAgent(resumeReview.progress.original_launch.agent.role, environment).instructions : generatedInstructions(content))
            || fileInput.manifest.transport.candidate.model !== model || fileInput.manifest.transport.candidate.effort !== effort))
        fail('READER_CAPACITY_UNSUPPORTED', 'review changed its measured instructions or selection');
      const checked = collector.verifyFileInput(fileInput, { association: { dispatch_id: capacityProbe ? probeState.association.review_dispatch_id
        : resumeReview ? resumeReview.progress.identity.dispatch_id : launchOptions.dispatch_id,
        run_id: scope.run_id, ticket: scope.ticket, phase: scope.phase } });
      if (checked.manifest.snapshot.worktree !== fs.realpathSync(scope.worktree))
        fail('SCOPE_MISMATCH', 'prepared review input belongs to a different physical worktree');
      if ((checked.manifest.binding?.agent_sha256 && checked.manifest.binding.agent_sha256 !== launchOptions.agent_file_digest)
          || Buffer.byteLength(agent ? agent.instructions : resumeReview?.progress.original_launch.agent
          ? installedGsdAgent(resumeReview.progress.original_launch.agent.role, environment).instructions : generatedInstructions(content))
          + 2 !== checked.manifest.accounting.generated_instruction_bytes)
        fail('STALE_GENERATED_AGENT', 'selected generated instruction accounting changed');
    }

    if (typedRole && (content !== undefined || launchOptions.agent_file || options.ephemeral === true)) {
      fail('INVALID_INPUT', 'typed GSD launch cannot use a static handoff or ephemeral transcript');
    }
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
    const env = { ...process.env, ...environment };
    const task = agent ? writeTaskFile(taskDir, scope, launchOptions.dispatch_id, launchPrompt(prompt)) : null;
    try {
    const protectedPaths = normalizeProtectedPaths([...signerProtectionPaths(env, scope.worktree), ...hostProtectedPaths,
      ...(resumeReview?.progress.original_launch.runtime_launch.sandbox_evidence.protected_paths || [])]);
    const evidenceWritePath = staticEvidenceWritePath(scope.worktree, launchOptions, sandbox);
    for (const key of [
      'CODEX_MODEL', 'CODEX_MODEL_REASONING_EFFORT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
      'OPENAI_API_KEY', 'CODEX_API_KEY',
    ]) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') || key === 'CLAUDE_CODE_OAUTH_TOKEN'
          || key === 'GNUPGHOME' || key === 'GPG_AGENT_INFO' || key === 'GPG_TTY'
          || key === 'SSH_AUTH_SOCK' || key === 'SSH_AGENT_PID') delete env[key];
    }
    if (resumeReview && (resumeReview.prepared !== fileInput || model !== resumeReview.progress.original_launch.model
        || effort !== resumeReview.progress.original_launch.effort || sandbox !== resumeReview.progress.original_launch.sandbox_mode
        || launchOptions.agent_file_digest !== resumeReview.progress.original_launch.agent_file_digest))
      fail('REVIEW_RESTART_REQUIRED', 'continuation changed original selection, instructions or sandbox');
    const args = [
      'exec', ...(resumeReview ? ['resume'] : []), '--json', '--model', model,
      '--config', 'model_reasoning_effort="' + effort + '"',
      '--config', 'model_provider="openai"',
      '--config', 'forced_login_method="chatgpt"',
      ...(!resumeReview ? ['--cd', scope.worktree] : []), '--ignore-user-config',
    ];
    args.push(...signerPermissionProfileArgs(protectedPaths, sandbox, evidenceWritePath));
    if (agent) {
      args.push('--config', 'features.multi_agent=true');
      args.push('--config', 'features.multi_agent_v2=false');
      args.push('--config', 'agents.' + agent.role + '.description=' + JSON.stringify(agent.description));
      args.push('--config', 'agents.' + agent.role + '.config_file=' + JSON.stringify(agent.file));
    }
    if (options.ephemeral === true) args.push('--ephemeral');
    if (options.approveForMe === true || launchOptions.approve_for_me === true) args.push('--approve-for-me');
    if (resumeReview) args.push(resumeReview.progress.session_id);
    args.push('-');
    const startedAt = Date.now();
    const commandDigest = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const runtimeLaunch = freeze({
      runtime: 'codex', provider: 'openai', run_id: scope.run_id,
      ticket: scope.ticket, phase: scope.phase, worktree: scope.worktree,
      dispatch_id: launchOptions.dispatch_id,
      ...(typedRole ? {
        gsd_role: typedRole,
        agent_file: agent.file,
        agent_file_digest: agent.sha256,
        agent_instructions_digest: agent.instructions_sha256,
        task_relay: task,
      } : {}),
      command_digest: commandDigest, command: { executable, args: [...args] },
      sandbox_evidence: {
        profile: PERMISSION_PROFILE,
        base_profile: sandbox === 'read-only' ? ':read-only' : ':workspace',
        protected_paths: protectedPaths,
        ...(evidenceWritePath ? { evidence_write_path: evidenceWritePath } : {}),
      },
      selection_source: 'codex-native-session-transcript',
      applied_model: model, applied_effort: effort,
      observed_model: model, observed_effort: effort,
    });
    const observeReview = fileTransport && !resumeReview && !capacityProbe && (launchOptions.review_progress === true
      || (fileInput.manifest.binding?.ticket_set && fileInput.manifest.binding?.merge_base))
      ? createReviewObserver(fileInput, { model, effort, sandbox_mode: sandbox,
        agent_file: agent?.file || launchOptions.agent_file || null,
        agent_file_digest: agent?.sha256 || launchOptions.agent_file_digest || null,
        ...(agent ? { agent, task } : {}), runtime_launch: runtimeLaunch }, env, launchOptions.onReviewProgress, () => child?.pid) : null;
    let child, originalExit;
    const stdout = [], stderr = [];
    const retainSetupFailure = (error) => {
      if (!resumeReview?.completedSource) return;
      const raw = readReviewNativeFile(resumeReview.progress.native_file, scope.worktree);
      let nativeStatus = 'unknown';
      try {
        const append = Buffer.from(raw).subarray(resumeReview.progress.snapshot.bytes).toString('utf8');
        const events = append.split('\n').filter(Boolean).map(JSON.parse)
          .filter(row => row.type === 'event_msg').map(row => row.payload?.type);
        if (events.includes('task_complete')) nativeStatus = 'completed';
        else if (events.includes('task_aborted')) nativeStatus = 'interrupted';
        else if (events.includes('task_started')) nativeStatus = 'incomplete';
      } catch {}
      const failedTranscript = stdout.length ? writeTranscript(transcriptDir,
        { ...scope, run_id: scope.run_id + '-' + launchOptions.dispatch_id }, resumeReview.progress.session_id,
        Buffer.concat(stdout).toString('utf8')) : null;
      require('./role-artifact.cjs').retainCompletedSourceFailure(reviewObservation({ worktree: scope.worktree,
        reference: resumeReview.reference, native_raw: raw, native_status: nativeStatus,
        exit: { code: originalExit?.code ?? null, signal: originalExit?.signal ?? null,
          error: error.message, stderr: bounded(Buffer.concat(stderr).toString('utf8')), ended_at_ms: Date.now(), transcript: failedTranscript },
        cause: nativeStatus === 'completed' ? 'original completed final callback or admission failed' : 'original final native attempt failed before admission' }, () => {
        if (readReviewNativeFile(resumeReview.progress.native_file, scope.worktree) !== raw)
          fail('REVIEW_SOURCE_INVALID', 'failed launch changed during physical retention');
      }));
    };
    if (resumeReview?.completedSource) {
      require('./role-artifact.cjs').beginCompletedSourceLaunch(reviewObservation({ worktree: scope.worktree,
        reference: resumeReview.reference }, () => {
        const identity = require('./codex-arch-review-context.cjs').reviewProgressIdentity(fileInput);
        if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(resumeReview.progress.identity[key])))
          fail('REVIEW_RESTART_REQUIRED', 'current subject changed immediately before original final launch');
        if (completedSourceSnapshot(resumeReview.progress).live !== completedSourceSnapshot(resumeReview.progress).raw)
          fail('REVIEW_SOURCE_INVALID', 'source changed immediately before original final launch');
      }));
    }
    try {
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
      try { child?.kill?.(); } catch {}
      fail('RUNTIME_UNAVAILABLE', 'Codex launcher returned an invalid child process');
    }
    if (typeof launchOptions.onProcessSpawned === 'function') {
      try {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
          fail('RUNTIME_EVIDENCE_MISSING', 'Codex native process has no positive original pid');
        }
        launchOptions.onProcessSpawned(child.pid);
      } catch (error) {
        try { child.kill(); } catch (_) {}
        throw error;
      }
    }
    let sessionLineBuffer = '';
    let announcedSessionId = null;
    let sessionCallbackError = null;
    const announceSession = (record) => {
      if (!object(record) || record.type !== 'thread.started'
          || typeof record.thread_id !== 'string' || !record.thread_id.trim()) return;
      const sessionId = record.thread_id.trim();
      if (announcedSessionId && announcedSessionId !== sessionId) {
        sessionCallbackError = hostError('RUNTIME_EVIDENCE_INVALID', 'Codex output reported conflicting thread identities');
        try { child.kill(); } catch (_) {}
        return;
      }
      if (announcedSessionId) return;
      announcedSessionId = sessionId;
      if (typeof launchOptions.onSessionStarted === 'function') {
        try {
          launchOptions.onSessionStarted(freeze({
            session_id: sessionId,
            process_id: Number.isInteger(child.pid) ? child.pid : null,
            runtime_launch: runtimeLaunch,
          }));
        } catch (error) {
          sessionCallbackError = error;
          try { child.kill(); } catch (_) {}
        }
      }
    };
    const inspectSessionRecords = (chunk, flush = false) => {
      if (typeof launchOptions.onSessionStarted !== 'function' && !observeReview && !resumeReview && !capacityProbe) return;
      sessionLineBuffer += chunk.toString('utf8');
      const lines = sessionLineBuffer.split(/\r?\n/);
      sessionLineBuffer = lines.pop() || '';
      if (flush && sessionLineBuffer.trim()) {
        lines.push(sessionLineBuffer);
        sessionLineBuffer = '';
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try { announceSession(JSON.parse(line)); }
        catch (_) {}
      }
    };
    const observe = () => {
      if (!observeReview || !announcedSessionId || sessionCallbackError) return;
      try { observeReview(announcedSessionId); } catch (error) {
        if (error.code === 'REVIEW_OBSERVATION_BUSY') return;
        sessionCallbackError = error;
        try { child.kill(); } catch {}
      }
    };
    const observerTimer = observeReview ? setInterval(observe, 250) : null;
    if (observerTimer) observerTimer.unref();
    let stdoutBytes = 0, stderrBytes = 0;
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > NATIVE_SESSION_MAX_BYTES) {
        sessionCallbackError = hostError('RUNTIME_EVIDENCE_INVALID', 'Codex output exceeds its transcript bound');
        try { child.kill(); } catch (_) {}
        return;
      }
      stdout.push(bytes);
      inspectSessionRecords(bytes);
      observe();
    });
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > NATIVE_SESSION_MAX_BYTES) {
        sessionCallbackError = hostError('RUNTIME_EVIDENCE_INVALID', 'Codex stderr exceeds its transcript bound');
        try { child.kill(); } catch (_) {}
        return;
      }
      stderr.push(bytes);
    });
    try {
      const input = agent ? taskRelayInput(agent.role, model, effort, task)
        : launchPrompt(prompt, resumeReview?.completedSource ? undefined : content);
      child.stdin.write(input);
      child.stdin.end();
    } catch (error) {
      try { child.kill(); } catch (_) {}
      if (observerTimer) clearInterval(observerTimer);
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
    originalExit = exit;
    if (observerTimer) clearInterval(observerTimer);
    inspectSessionRecords(Buffer.alloc(0), true);
    observe();
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    const rawStderr = Buffer.concat(stderr).toString('utf8');
    const transcriptScope = resumeReview || observeReview || capacityProbe ? { ...scope, run_id: scope.run_id + '-' + launchOptions.dispatch_id } : scope;
    if ((observeReview || resumeReview || capacityProbe) && announcedSessionId) {
      const historical = writeTranscript(transcriptDir, transcriptScope, announcedSessionId, rawStdout);
      if (observeReview) observeReview.finish(exit, historical);
      if (capacityProbe) {
        const physical = { exit_code: exit.code ?? null, signal: exit.signal ?? null, transcript: historical,
          elapsed_ms: Date.now() - startedAt, native: null, unavailable_reasons: {} };
        try {
          const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
          const candidates = nativeSessionCandidates(path.join(home, 'sessions'), announcedSessionId, new Date());
          if (candidates.length !== 1) throw new Error('native session is missing or ambiguous');
          const raw = readReviewNativeFile(fs.realpathSync(candidates[0]), scope.worktree);
          physical.native_raw = raw;
          physical.native = { session_id: announcedSessionId, bytes: Buffer.byteLength(raw), sha256: reviewHash(raw) };
        } catch (error) { physical.unavailable_reasons.native = error.message; }
        probeState.physicalAttempt = physical;
      }
    }
    if (sessionCallbackError) throw sessionCallbackError;
    if (resumeReview?.completedSource && (exit.error || exit.code !== 0)) {
      const raw = readReviewNativeFile(resumeReview.progress.native_file, scope.worktree);
      const append = Buffer.from(raw).subarray(resumeReview.progress.snapshot.bytes).toString('utf8');
      let nativeStatus = 'unknown';
      try {
        const events = append.split('\n').filter(Boolean).map(JSON.parse)
          .filter(row => row.type === 'event_msg').map(row => row.payload?.type);
        if (events.includes('task_complete')) nativeStatus = 'completed';
        else if (events.includes('task_aborted')) nativeStatus = 'interrupted';
        else if (events.includes('task_started')) nativeStatus = 'incomplete';
      } catch {}
      require('./role-artifact.cjs').retainCompletedSourceFailure(reviewObservation({ worktree: scope.worktree,
        reference: resumeReview.reference, native_raw: raw, native_status: nativeStatus,
        exit: { code: exit.code ?? null, signal: exit.signal ?? null, error: exit.error?.message || null,
          ended_at_ms: Date.now(), transcript: writeTranscript(transcriptDir, transcriptScope, announcedSessionId || resumeReview.progress.session_id, rawStdout) },
        cause: 'original final native process did not complete successfully' }, () => {
        if (readReviewNativeFile(resumeReview.progress.native_file, scope.worktree) !== raw)
          fail('REVIEW_SOURCE_INVALID', 'failed original final changed during physical retention');
      }));
    }
    if (exit.error) fail('RUNTIME_UNAVAILABLE', 'Codex process failed: ' + exit.error.message);
    if (exit.code !== 0) {
      fail('RUNTIME_UNAVAILABLE', 'Codex process exited ' + (exit.code === null ? 'without a code' : exit.code), {
        stderr: bounded(rawStderr),
      });
    }
    let parsed;
    try {
      parsed = parseCodexStream(rawStdout);
      if (typeof launchOptions.onSessionStarted === 'function' && announcedSessionId !== parsed.session_id) {
        fail('RUNTIME_EVIDENCE_MISSING', 'Codex session identity was not durably announced while the process ran');
      }
      const cliFinal = parsed.records.findLastIndex(record => record.type === 'item.completed'
        && record.item?.type === 'agent_message');
      if (!agent) {
        const starts = parsed.records.flatMap((record, index) => record.type === 'turn.started' ? [index] : []);
        const completions = parsed.records.flatMap((record, index) => record.type === 'turn.completed' ? [index] : []);
        if (starts.length !== 1 || completions.length !== 1
            || cliFinal <= starts[0] || cliFinal >= completions[0]) {
          fail('RUNTIME_EVIDENCE_MISMATCH', 'CLI final is outside its unique completed turn');
        }
      }
      if (resumeReview && parsed.session_id !== resumeReview.progress.session_id)
        fail('REVIEW_RESTART_REQUIRED', 'CLI resumed a different reviewer session');
      let resumedConsumption;
      const verified = resumeReview ? await (async () => {
        const raw = readReviewNativeFile(resumeReview.progress.native_file, scope.worktree);
        const native = parseNativeCodexTranscript(raw, parsed.session_id);
        const nativeEvidence = freeze({ schema: 'shipyard.codex-native-session-evidence.v1', version: 1,
          ...native, bytes: Buffer.byteLength(raw), file: path.basename(resumeReview.progress.native_file) });
        validateReviewNative(raw, parsed.session_id, { model, effort, sandbox_mode: sandbox, worktree: scope.worktree });
        resumedConsumption = resumeReview.completedSource
          ? verifyCompletedSourceTurn(resumeReview.progress, fileInput, raw, parsed.records[cliFinal]?.item.text)
          : verifyResumedReview(resumeReview.progress, fileInput, raw, parsed.records[cliFinal]?.item.text);
        return { native_session_evidence: nativeEvidence, last_agent_message: parsed.records[cliFinal]?.item.text };
      })() : await verifyCompletedNativeLaunch({
        session_id: parsed.session_id, selection: { model, effort }, agent, env,
        resultText: parsed.records[cliFinal]?.item.text,
        allowTimedOutWait: false, startedAt, task,
      });
      const nativeEvidence = verified.native_session_evidence;
      if (fileTransport) {
        const message = parsed.records.filter(record => record.type === 'item.completed'
          && record.item?.type === 'agent_message').at(-1);
        if (!message || parsed.records.indexOf(message) > parsed.records.findLastIndex(record => record.type === 'turn.completed'))
          fail('RUNTIME_EVIDENCE_MISMATCH', 'file input result is outside the original completed turn');
        const resultText = agent ? verified.last_agent_message : message.item.text || '';
        const semanticRaw = resumeReview ? readReviewNativeFile(resumeReview.progress.native_file, scope.worktree)
          : agent && verified.native_child_evidence
          ? readReviewNativeFile(originalReviewFile(verified.native_child_evidence.session_id, env, scope.worktree), scope.worktree)
          : readNativeParentRaw(parsed.session_id, nativeEvidence, env);
        const consumed = resumedConsumption || verifyFileConsumption(fileInput, semanticRaw, capacityProbe ? probeState.association.review_dispatch_id : launchOptions.dispatch_id,
          agent ? verified.last_agent_message : resultText,
          capacityProbe ? { chunk_bytes: fileInput.manifest.chunk_bytes, output_tokens: 10000 } : null);
        let result;
        try { result = JSON.parse(resultText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
        for (const [key, expected] of Object.entries({ input_manifest_sha256: fileInput.input_bundle.manifest_sha256,
          input_material_bytes: fileInput.input_bundle.total_bytes, input_asset_count: fileInput.input_bundle.asset_count,
          input_chunk_reads: consumed.chunk_reads,
          ...(fileInput.manifest.transport?.schema === 'shipyard.native-reader-transport.v3' ? {
            input_batch_reads: fileInput.manifest.batches.length,
            input_profile_sha256: fileInput.manifest.transport.profile_sha256 } : {}) })) {
          const value = result?.[key] ?? new RegExp('(?:^|\\n)' + key + '=([^\\n]+)(?:\\n|$)').exec(resultText)?.[1];
          if (String(value) !== String(expected)) fail('RUNTIME_EVIDENCE_MISMATCH', 'original native result has a wrong file input identity echo');
        }
      }


      const selection = observedSelection(parsed, model, effort, {
        model: args[args.indexOf('--model') + 1],
        effort: (args.find((value) => value.startsWith('model_reasoning_effort=')) || '').match(/^model_reasoning_effort="([^"]+)"$/)?.[1],
      }, nativeEvidence);
      const typedEvidence = verified.native_child_evidence || (resumeReview?.progress.original_launch.native_child_evidence
        ? { ...resumeReview.progress.original_launch.native_child_evidence, schema: 'shipyard.codex-native-child-evidence.v1', sha256: nativeEvidence.sha256,
          fresh_turn_id: resumedConsumption.turn_id } : null);
      if (agent) {
        const current = installedGsdAgent(agent.role, environment);
        if (current.file !== agent.file || current.sha256 !== agent.sha256) {
          fail('STALE_GSD_AGENT', 'installed GSD role changed during native launch');
        }
      }
      const expectedTranscript = transcriptEvidence(transcriptDir, transcriptScope, parsed.session_id, rawStdout);
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
        ...(capacityProbe ? { reader_capacity_probe: probeState.association } : {}),
        session_id: parsed.session_id,
        process_id: Number.isInteger(child.pid) ? child.pid : undefined,
        command_digest: commandDigest,
        command: { executable, args: [...args] },
        sandbox_evidence: {
          profile: PERMISSION_PROFILE,
          base_profile: sandbox === 'read-only' ? ':read-only' : ':workspace',
          protected_paths: protectedPaths,
          ...(evidenceWritePath ? { evidence_write_path: evidenceWritePath } : {}),
        },
        selection_source: selection.source,
        applied_model: selection.model,
        applied_effort: selection.effort,
        observed_model: selection.model,
        observed_effort: selection.effort,
        native_session_evidence: nativeEvidence,
        ...(resumeReview && !resumeReview.completedSource ? { review_continuation: { schema: 'shipyard.review-continuation.v1',
          progress: resumeReview.reference, original_dispatch_id: resumeReview.progress.identity.dispatch_id,
          original_launch: resumeReview.progress.original_launch.runtime_launch,
          original_exit: resumeReview.progress.state.original_exit,
          original_process_id: resumeReview.progress.original_launch.process_id,
          original_session_id: resumeReview.progress.session_id, original_turn_id: resumeReview.progress.turn_id,
          fresh_turn_id: resumedConsumption.turn_id, semantic_context: 'exact-native-session',
          inherited_ranges: resumeReview.progress.completed_ranges,
          newly_completed_ranges: resumedConsumption.chunk_reads - resumeReview.progress.completed_ranges } } : {}),
        ...(resumeReview?.completedSource ? { completed_source: { schema: 'shipyard.completed-source-final.v1',
          source: resumeReview.reference, original_dispatch_id: resumeReview.progress.probe_dispatch_id,
          fresh_turn_id: resumedConsumption.turn_id, semantic_credit: false, new_physical_calls: 0 } } : {}),
        ...(typedEvidence ? { native_child_evidence: typedEvidence } : {}),
        ...(fileTransport ? { input_transport: 'host-files', input_bundle: fileInput.input_bundle,
          input_accounting: fileInput.manifest.accounting,
          input_consumption: { native_session_sha256: nativeEvidence.sha256,
            manifest_sha256: fileInput.input_bundle.manifest_sha256,
            ...(fileInput.manifest.transport?.schema === 'shipyard.native-reader-transport.v3' ? {
              schema: 'shipyard.native-file-consumption.v3', physical_calls: fileInput.manifest.batches.length,
              logical_ranges: fileInput.manifest.ranges.length, profile_sha256: fileInput.manifest.transport.profile_sha256 } : {}),
            ...(resumeReview?.completedSource ? {
              physical_call_provenance: 'original-completed-source',
              source_dispatch_id: resumeReview.progress.probe_dispatch_id,
              original_call_ids: resumedConsumption.successful_call_ids,
              original_range_ordinals: resumedConsumption.successful_range_ordinals,
              current_turn_physical_calls: 0 } : {}),
            chunk_reads: require('./codex-arch-review-context.cjs').verifyFileInput(fileInput).chunk_reads } } : {}),
        stream_evidence: {
          format: STREAM_FORMAT,
          records: parsed.records.length,
          turns: parsed.turns,
          usage_records: parsed.usage_records,
        },
        ...(expectedTranscript ? { transcript: expectedTranscript } : {}),
      };
      const evidence = {
        launch_id: 'codex-' + parsed.session_id + (resumeReview ? '-' + reviewHash(launchOptions.dispatch_id).slice(0, 24) : ''),
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
          agent_file: agent.file,
          agent_file_digest: agent.sha256,
        } : {}),
      };
      const retainedTranscript = resumeReview?.completedSource
        ? writeTranscript(transcriptDir, transcriptScope, parsed.session_id, rawStdout) : null;
      if (resumeReview) {
        const token = reviewObservation({ worktree: scope.worktree, reference: resumeReview.reference,
          evidence: runtimeEvidence, turn_id: resumedConsumption.turn_id,
          ...(resumeReview.completedSource ? { application: evidence, cli_raw: rawStdout } : {}) }, () => {
          const identity = require('./codex-arch-review-context.cjs').reviewProgressIdentity(fileInput);
          if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(resumeReview.progress.identity[key])))
            fail('REVIEW_RESTART_REQUIRED', 'current subject changed before protected final admission');
          const raw = readReviewNativeFile(resumeReview.progress.native_file, scope.worktree);
          if (reviewHash(raw) !== nativeEvidence.sha256) fail('REVIEW_RESTART_REQUIRED', 'fresh final changed before protected admission');
        });
        const authority = require('./role-artifact.cjs');
        if (resumeReview.completedSource) authority.completeCompletedReviewSource(token);
        else authority.completeReviewContinuation(token);
      }
      if (typeof launchOptions.onNativeCompleted === 'function') {
        launchOptions.onNativeCompleted(freeze({
          launch_id: evidence.launch_id,
          session_id: evidence.session_id,
          process_id: Number.isInteger(evidence.process_id) ? evidence.process_id : null,
          runtime_evidence: evidence.runtime_evidence,
          last_agent_message: verified.last_agent_message,
          spawn_evidence: verified.spawn_evidence,
        }));
      }
      const transcript = retainedTranscript || writeTranscript(transcriptDir, transcriptScope, parsed.session_id, rawStdout);
      if ((transcript === null) !== (expectedTranscript === null)
          || (transcript && (transcript.path !== expectedTranscript.path
            || transcript.bytes !== expectedTranscript.bytes || transcript.sha256 !== expectedTranscript.sha256))) {
        fail('RUNTIME_EVIDENCE_INVALID', 'saved host transcript differs from the verified launch stream');
      }
      if (typeof launchOptions.onTranscriptWritten === 'function') {
        launchOptions.onTranscriptWritten(freeze({ session_id: parsed.session_id, transcript }));
      }
      if (typeof launchOptions.onCompleted === 'function') {
        launchOptions.onCompleted(freeze({
          launch_id: evidence.launch_id,
          session_id: evidence.session_id,
          process_id: Number.isInteger(evidence.process_id) ? evidence.process_id : null,
          runtime_evidence: evidence.runtime_evidence,
          last_agent_message: verified.last_agent_message,
          spawn_evidence: verified.spawn_evidence,
        }));
      }
      const completedEvidence = freeze(evidence);
      if (capacityProbe) {
        probeState.verified = verified;
        probeState.evidence = completedEvidence;
      }
      return completedEvidence;
    } catch (error) {
      if (error && error.name === 'CodexRuntimeHostError') throw error;
      fail('RUNTIME_EVIDENCE_INVALID', error.message);
    }
    } catch (error) {
      try { child?.kill?.(); } catch {}
      retainSetupFailure(error);
      throw error;
    }
    } finally {
      if (task) fs.rmSync(task.path, { force: true });
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
    transcriptDir: options.transcriptDir || path.join(options.env?.CODEX_HOME || process.env.CODEX_HOME
      || path.join(os.homedir(), '.codex'), 'shipyard', 'transcripts', reviewHash(scope.worktree)),
    ephemeral: options.ephemeral,
    approveForMe: options.approveForMe,
    additionalProtectedPaths: options.additionalProtectedPaths,
    taskDir: options.taskDir,
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
        input_transport: input.input_transport,
        input_bundle: input.input_bundle,
        input_prepared: input.input_prepared,
        sandbox_mode: selection.sandbox_mode || input.sandbox_mode,
        gsd_role: input.gsd_role,
        resume_review: input.resume_review,
        review_progress: input.review_progress,
        onReviewProgress: input.onReviewProgress,
        onProcessSpawned: input.onProcessSpawned,
        onSessionStarted: input.onSessionStarted,
        onNativeCompleted: input.onNativeCompleted,
        onTranscriptWritten: input.onTranscriptWritten,
        onCompleted: input.onCompleted,
      });
      assertOwner();
      return result;
    } catch (error) {
      let completedNative = false;
      const resumed = input.resume_review && reviewResumptions.get(input.resume_review);
      if (resumed?.completedSource) {
        try {
          const authority = require('./role-artifact.cjs');
          const source = authority.readCompletedReviewSource({ worktree: scope.worktree, reference: resumed.reference });
          if (source.state.resume?.status === 'completed' && source.state.resume.completion) {
            authority.validateCompletedSourceEvidence(source.state.resume.completion.application.runtime_evidence);
            completedNative = true;
          }
        } catch {}
      }
      if (!completedNative && controller && UNAVAILABLE_CODES.has(error && error.code)
          && typeof controller.markUnavailable === 'function') {
        controller.markUnavailable(runId, { reason: error.message });
      }
      throw error;
    }
  };
  const resumeReview = async (selection, context = {}) => {
    assertOwner();
    validateContext(context);
    const allowed = new Set(['progress', 'dispatch_id', 'role', 'run_id', 'runtime', 'provider',
      'onProcessSpawned', 'onSessionStarted', 'onNativeCompleted', 'onTranscriptWritten', 'onCompleted']);
    if (Object.keys(context).some(key => !allowed.has(key)))
      fail('REVIEW_PROGRESS_INVALID', 'continuation accepts protected references and host callbacks, never caller transcript or cursor authority');
    const authority = require('./role-artifact.cjs');
    const collector = require('./codex-arch-review-context.cjs');
    const dispatchId = text(context.dispatch_id, 'dispatch_id', 256);
    const reference = context.progress;
    const progress = authority.readReviewProgress({ worktree: scope.worktree, reference });
    if ((context.role !== undefined && context.role !== progress.identity.role)
        || progress.state.resume || dispatchId === progress.identity.dispatch_id
        || progress.identity.run_id !== scope.run_id || progress.identity.ticket !== scope.ticket
        || progress.identity.phase !== scope.phase)
      fail('REVIEW_RESTART_REQUIRED', 'continuation lacks a fresh dispatch in the exact original scope');
    const original = progress.original_launch;
    reviewOriginInactive(progress);
    let nativeSelection = selection;
    if (original.agent) {
      const agent = installedGsdAgent(original.agent.role, options.env);
      if (agent.file !== original.agent.file || agent.sha256 !== original.agent.sha256)
        fail('REVIEW_RESTART_REQUIRED', 'original typed reviewer instructions changed');
      nativeSelection = { ...selection, agent_file: agent.file, agent_file_digest: agent.sha256,
        agent_file_content: fs.readFileSync(agent.file, 'utf8') };
    }
    if (nativeSelection.model !== original.model || (nativeSelection.effort || nativeSelection.reasoning_effort) !== original.effort
        || nativeSelection.sandbox_mode !== original.sandbox_mode || nativeSelection.agent_file_digest !== original.agent_file_digest
        || (nativeSelection.agent_file || null) !== original.agent_file
        || reviewHash(nativeSelection.agent_file_content || '') !== original.agent_file_digest)
      fail('REVIEW_RESTART_REQUIRED', 'continuation changed its original reviewer selection or instructions');
    const prepared = collector.restoreReviewInput(progress);
    const raw = readReviewNativeFile(progress.native_file, scope.worktree);
    verifyProtectedReviewPrefix(progress, prepared, raw);
    const nativeContext = validateReviewNative(raw, progress.session_id, { ...original, worktree: scope.worktree });
    if (original.agent && !nativeContext.records.some(record => record.type === 'event_msg'
        && ['task_aborted', 'task_complete'].includes(record.payload?.type) && record.payload.turn_id === progress.turn_id))
      fail('REVIEW_RESTART_REQUIRED', 'typed semantic reviewer is still active or lacks an authenticated interruption');
    if (!raw.endsWith('\n')) fail('REVIEW_RESTART_REQUIRED', 'original native context has unfinished serialized evidence');
    const remaining = readSchedule(prepared).slice(progress.completed_ranges);
    const prompt = 'Continue the identical review in this original native conversation. Preserve its conclusions, assumptions and limitations.\n'
      + 'The trusted host authenticated ' + progress.completed_ranges + ' ordered ranges. Do not reread those ranges.\n'
      + 'Resume at the following exact command, then continue every remaining ordered manifest/asset range under the original reader contract:\n'
      + (remaining[0]?.command || 'All required material is already authenticated; issue a fresh current judgment.') + '\n'
      + 'Use the original final judgment contract and identity echoes, with total input_chunk_reads=' + readSchedule(prepared).length + '.\n'
      + 'INPUT_MANIFEST_SHA256=' + prepared.input_bundle.manifest_sha256
      + (prepared.manifest.transport?.schema === 'shipyard.native-reader-transport.v3'
        ? '\nTotal input_batch_reads=' + prepared.manifest.batches.length + '\ninput_profile_sha256=' + prepared.manifest.transport.profile_sha256 : '');
    const claim = reviewObservation({ worktree: scope.worktree, reference, dispatch_id: dispatchId,
      native_bytes: Buffer.byteLength(raw), native_sha256: reviewHash(raw) }, () => {
      collector.verifyFileInput(prepared);
      if (readReviewNativeFile(progress.native_file, scope.worktree) !== raw)
        fail('REVIEW_RESTART_REQUIRED', 'original conversation changed before continuation claim');
    });
    const claimed = authority.claimReviewContinuation(claim);
    const token = Object.freeze({});
    reviewResumptions.set(token, { progress: claimed, reference, prepared, prompt });
    try {
      return await launch(nativeSelection, { ...context, gsd_role: undefined, resume_review: token, input_transport: 'host-files',
        input_prepared: prepared, input_bundle: prepared.input_bundle, prompt });
    } finally { reviewResumptions.delete(token); }
  };
  const resumeCompletedSource = async (selection, context = {}) => {
    assertOwner();
    validateContext(context);
    const allowed = new Set(['source', 'dispatch_id', 'role', 'run_id', 'runtime', 'provider', 'ticket', 'phase', 'subject_kind', 'worktreePath',
      'input_prepared', 'input_transport', 'input_bundle', 'prompt', 'onProcessSpawned', 'onSessionStarted', 'onNativeCompleted', 'onTranscriptWritten', 'onCompleted']);
    if (Object.keys(context).some(key => !allowed.has(key))) fail('REVIEW_SOURCE_INVALID', 'completed source accepts original selectors and callbacks only');
    const authority = require('./role-artifact.cjs'), collector = require('./codex-arch-review-context.cjs');
    const source = authority.readCompletedReviewSource({ worktree: scope.worktree, reference: context.source });
    if ((context.role !== undefined && context.role !== source.identity.role) || context.dispatch_id !== source.identity.dispatch_id
        || ['run_id', 'ticket', 'phase', 'worktree'].some(key => source.identity[key] !== scope[key]))
      fail('REVIEW_SOURCE_CLAIMED', 'final requires its unused exact original source reservation');
    if (source.state.resume && source.state.resume.status !== 'completed') validateCompletedSourceClaimRecovery(source);
    const prepared = context.input_prepared || collector.restoreCompletedSourceInput(source);
    const checked = collector.verifyFileInput(prepared);
    if (context.subject_kind !== undefined && context.subject_kind !== readerSubjectKind(checked.manifest))
      fail('REVIEW_SOURCE_INVALID', 'final changed its authenticated subject kind');
    const original = source.original_launch;
    if (selection.model !== original.model || (selection.effort || selection.reasoning_effort) !== original.effort
        || selection.sandbox_mode !== 'read-only' || selection.agent_file !== original.agent_file
        || selection.agent_file_digest !== original.agent_file_digest || reviewHash(selection.agent_file_content || '') !== original.agent_file_digest
        || require('./model-policy-internal.cjs').stableStringify(completedReviewIdentity(checked, prepared.input_bundle))
          !== require('./model-policy-internal.cjs').stableStringify(source.identity))
      fail('REVIEW_SOURCE_INVALID', 'final changed role, instructions, model, profile or subject');
    if (source.state.resume?.status === 'completed') {
      const application = validateCompletedSourceReconciliation(source, prepared);
      if (source.state.resume.owner_pid === process.pid && !source.state.resume.completion_failures?.length)
        fail('REVIEW_SOURCE_CLAIMED', 'live completed recording has no retained original failure');
      if (recorder.storeDir !== source.receipt_store || recorder.getVerifiedRecord(context.dispatch_id))
        fail('REVIEW_SOURCE_CLAIMED', 'original final receipt already exists or belongs to another recorder');
      const observation = reviewObservation({ worktree: scope.worktree, reference: context.source }, () => {
        assertOwner();
        validateCompletedSourceReconciliation(source, prepared);
      });
      authority.claimCompletedSourceReconciliation(observation);
      return application;
    }
    const { raw, live } = completedSourceSnapshot(source);
    if (live !== raw || !raw.endsWith('\n')) fail('REVIEW_SOURCE_INVALID', 'original reviewer has intervening or unfinished turns');
    verifyBatchCapacityReference(prepared, checked, raw);
    const claim = reviewObservation({ worktree: scope.worktree, reference: context.source, dispatch_id: context.dispatch_id,
      native_bytes: Buffer.byteLength(raw), native_sha256: reviewHash(raw) }, () => {
      const identity = collector.reviewProgressIdentity(prepared);
      if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(source.identity[key])))
        fail('REVIEW_RESTART_REQUIRED', 'current subject changed before atomic source claim');
      if (completedSourceSnapshot(source).live !== raw) fail('REVIEW_SOURCE_INVALID', 'source changed before atomic claim');
    });
    const claimed = authority.claimCompletedReviewSource(claim);
    completedSourceOperations.add(context.dispatch_id);
    const token = Object.freeze({});
    completedSourceInputs.set(prepared, claimed);
    const measured = fileCapacityForSource(prepared);
    if (measured) { measured.completedSource = claimed; }
    try {
      const prompt = completedSourcePrompt(claimed, prepared, checked);
      reviewResumptions.set(token, { progress: claimed, reference: context.source, prepared, prompt, completedSource: true });
      const { source: _source, ...launchContext } = context;
      return await launch(selection, { ...launchContext, resume_review: token, input_prepared: prepared,
        input_transport: 'host-files', input_bundle: prepared.input_bundle, prompt });
    } finally { reviewResumptions.delete(token); completedSourceOperations.delete(context.dispatch_id); }
  };
  const reserveCompletedSourceCandidate = (prepared) => {
    assertOwner();
    const collector = require('./codex-arch-review-context.cjs');
    const identity = collector.reviewProgressIdentity(prepared);
    if (!collector.isPreparedFileInput(prepared) || prepared.manifest.transport?.schema !== 'shipyard.native-reader-transport.v3'
        || ['worktree', 'run_id', 'ticket', 'phase'].some(key => identity[key] !== scope[key])
        || !require('./dispatch-boundary.cjs').isDurableRecorder(recorder))
      fail('REVIEW_SOURCE_REQUIRED', 'source candidate requires original private preparation and recorder');
    const hash = reviewHash(require('./model-policy-internal.cjs').stableStringify(identity));
    const previous = completedSourceCandidates.get(identity.dispatch_id);
    if (previous) {
      if (previous.identity_sha256 !== hash || previous.recorder !== recorder.storeDir)
        fail('REVIEW_SOURCE_INVALID', 'pre-measurement candidate reservation changed');
      const reservation = recorder.getReservation(identity.dispatch_id);
      if (!reservation || reservation.recorded || reservation.reserved_at !== previous.reserved_at || previous.measured)
        fail('REVIEW_SOURCE_CLAIMED', 'original candidate reservation was consumed or already measured');
      return;
    }
    if (recorder.reserve(identity.dispatch_id).reserved !== true)
      fail('REVIEW_SOURCE_CLAIMED', 'final candidate dispatch was already reserved');
    completedSourceCandidates.set(identity.dispatch_id, { identity_sha256: hash, recorder: recorder.storeDir,
      reserved_at: recorder.getReservation(identity.dispatch_id).reserved_at, measured: false });
  };
  const measureBatchReaderCapacity = async (selection, prepared, callbacks = {}) => {
    assertOwner();
    if (!object(selection)) fail('READER_CAPACITY_UNSUPPORTED', 'probe requires an explicit original selection');
    const collector = require('./codex-arch-review-context.cjs');
    const checked = collector.verifyFileInput(prepared);
    if (!collector.isPreparedFileInput(prepared) || (selection.sandbox_mode !== undefined && selection.sandbox_mode !== 'read-only')
        || checked.manifest.transport?.schema !== 'shipyard.native-reader-transport.v3'
        || checked.manifest.snapshot.worktree !== scope.worktree || checked.manifest.run_id !== scope.run_id
        || checked.manifest.ticket !== scope.ticket || checked.manifest.phase !== scope.phase)
      fail('READER_CAPACITY_UNSUPPORTED', 'probe requires the exact private host candidate and scope');
    if (!require('./dispatch-boundary.cjs').isDurableRecorder(recorder))
      fail('READER_CAPACITY_UNSUPPORTED', 'probe requires the original durable dispatch recorder');
    const callbackNames = ['onProcessSpawned', 'onSessionStarted', 'onNativeCompleted', 'onTranscriptWritten', 'onCompleted'];
    if (!object(callbacks) || Object.keys(callbacks).some(key => !callbackNames.includes(key) || typeof callbacks[key] !== 'function'))
      fail('INVALID_INPUT', 'capacity probe accepts only host completion callbacks');
    const token = Object.freeze({});
    const probeState = { prepared, association: capacityProbeAssociation(checked.manifest, 'capacity-probe-' + crypto.randomUUID()) };
    const tracked = completedSourceCandidates.has(checked.manifest.dispatch_id);
    if (tracked && completedSourceCandidates.get(checked.manifest.dispatch_id).measured)
      fail('REVIEW_SOURCE_CLAIMED', 'one original successful probe already measured this final candidate');
    const identity = tracked ? collector.reviewProgressIdentity(prepared) : null;
    const attemptStart = Date.now();
    let retainedCompletion = false;
    const retain = (status, more = {}) => {
      if (!tracked) return;
      require('./role-artifact.cjs').recordReviewSourceAttempt(reviewObservation({ identity,
        attempt: { dispatch_id: probeState.association.probe_dispatch_id, status, started_at_ms: attemptStart,
          input_bundle: prepared.input_bundle,
          setup_costs: { value: null, reason: 'external setup not present in original native transcript' }, ...more } },
      () => { collector.verifyFileInput(prepared); }));
    };
    retain('pending', { native_status: 'pending', authority_status: 'pending' });
    readerCapacityProbes.set(token, probeState);
    try {
      const boundaryModule = require('./dispatch-boundary.cjs');
      const adapter = require('./codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
        agentsDir: options.agentDir || path.join(options.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agents'),
        agentManifest: options.agentManifest, capabilities,
        host: { requireRuntimeEvidence: true, async launchStatic(applied, context) {
          assertOwner();
          return launcher(prepared.prompt, { ...applied, ...callbacks, reader_capacity_probe: token,
            dispatch_id: context.dispatch_id, input_transport: 'host-files', input_bundle: prepared.input_bundle,
            input_prepared: prepared });
        } },
      });
      const boundary = boundaryModule.createDispatchBoundary({ adapters: { codex: adapter }, recorder,
        handoff: options.handoff, cwd: scope.worktree });
      const result = await boundary.dispatch({ runtime: 'codex', role: checked.manifest.role,
        signals: selection.signals || {}, dispatch_id: probeState.association.probe_dispatch_id,
        model: selection.model, effort: selection.effort || selection.reasoning_effort },
      { ticket: scope.ticket, phase: scope.phase, subject_kind: readerSubjectKind(checked.manifest),
        run_id: scope.run_id, worktree: scope.worktree });
      assertOwner();
      const receipt = result.receipt;
      const evidence = probeState.evidence;
      const stable = require('./model-policy-internal.cjs').stableStringify;
      if (!probeState.verified || !evidence
          || receipt.launch_id !== evidence.launch_id
          || stable(receipt.runtime_evidence) !== stable(evidence.runtime_evidence))
        fail('READER_CAPACITY_UNSUPPORTED', 'probe lacks matching original completion and authenticated application receipt');
      try {
        const capacity = measureReaderCapacity(probeState.verified, prepared, { recorder, receipt });
        retain('completed', { native_status: 'completed', authority_status: 'recorded', ended_at_ms: Date.now(), receipt_store: recorder.storeDir,
          receipt_sha256: reviewHash(stable(receipt)), native: receipt.runtime_evidence.native_session_evidence,
          transcript: receipt.runtime_evidence.transcript, physical: probeState.physicalAttempt });
        retainedCompletion = true;
        if (tracked) completedSourceCandidates.get(checked.manifest.dispatch_id).measured = true;
        return capacity;
      }
      catch (error) { recordedCapacityLaunches.delete(probeState.verified); throw error; }
    } catch (error) {
      if (!retainedCompletion) {
        let nativeStatus = 'unknown', originalRecord;
        try {
          const events = probeState.physicalAttempt?.native_raw?.split('\n').filter(Boolean).map(JSON.parse)
            .filter(row => row.type === 'event_msg').map(row => row.payload?.type) || [];
          if (events.includes('task_complete')) nativeStatus = 'completed';
          else if (events.includes('task_aborted')) nativeStatus = 'interrupted';
          else if (events.includes('task_started')) nativeStatus = 'incomplete';
        } catch {}
        try { originalRecord = recorder.getVerifiedRecord(probeState.association.probe_dispatch_id); } catch {}
        retain('failed', { native_status: nativeStatus, authority_status: originalRecord ? 'recorded' : 'pending',
          ...(originalRecord ? { receipt_store: recorder.storeDir,
            receipt_sha256: reviewHash(require('./model-policy-internal.cjs').stableStringify(originalRecord.receipt)) } : {}),
          ended_at_ms: Date.now(), failure: { code: error.code || 'UNKNOWN', message: error.message },
          physical: probeState.physicalAttempt || { value: null, reason: 'native process did not provide complete physical evidence' } });
      }
      throw error;
    } finally { readerCapacityProbes.delete(token); }
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
    resumeReview,
    resumeCompletedSource,
    retainCompletedSourceRecordingFailure(reference, error) {
      assertOwner();
      const authority = require('./role-artifact.cjs'), collector = require('./codex-arch-review-context.cjs');
      const source = authority.readCompletedReviewSource({ worktree: scope.worktree, reference });
      if (['run_id', 'ticket', 'phase', 'worktree'].some(key => source.identity[key] !== scope[key]))
        fail('REVIEW_SOURCE_INVALID', 'recording failure belongs to another original review scope');
      const prepared = collector.restoreCompletedSourceInput(source);
      validateCompletedSourceReconciliation(source, prepared);
      if (source.receipt_store !== recorder.storeDir || recorder.getVerifiedRecord(source.identity.dispatch_id))
        fail('REVIEW_SOURCE_CLAIMED', 'recording failure cannot replace an original final receipt');
      const raw = readReviewNativeFile(source.native_file, scope.worktree);
      authority.retainCompletedSourceFailure(reviewObservation({ worktree: scope.worktree, reference,
        native_raw: raw, cause: 'original completed final durable recording failed',
        exit: { code: null, signal: null, boundary_error_code: error.code || 'UNKNOWN', error: error.message,
          reason: 'recording recovery has no additional native process exit', ended_at_ms: Date.now() } }, () => {
        validateCompletedSourceReconciliation(source, prepared);
      }));
    },
    reserveCompletedSourceCandidate,
    measureBatchReaderCapacity,
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
  parseNativeParentSpawn,
  parseNativeChildTranscript,
  installedGsdAgent,
  signerProtectionPaths,
  signerPermissionProfileArgs,
  nativeSessionCandidates,
  readNativeCodexSession,
  validateReviewRestoration: (progress, prepared) => {
    if (!require('./role-artifact.cjs').isAuthenticatedReviewProgress(progress))
      fail('REVIEW_PROGRESS_INVALID', 'restore lacks original protected progress');
    reviewOriginInactive(progress);
    verifyBatchCapacityReference(prepared, require('./codex-arch-review-context.cjs').verifyFileInput(prepared));
    const raw = readReviewNativeFile(progress.native_file, progress.identity.worktree);
    const { records } = validateReviewNative(raw, progress.session_id, { ...progress.original_launch, worktree: progress.identity.worktree });
    const starts = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
    if (progress.state.resume || starts.length !== 1 || starts[0].payload.turn_id !== progress.turn_id)
      fail('REVIEW_RESTART_REQUIRED', 'original conversation has intervening or claimed review turns');
    verifyFileConsumption(prepared, raw, progress.identity.dispatch_id, null, null, { turn_id: progress.turn_id });
    return verifyProtectedReviewPrefix(progress, prepared, raw);
  },
  authenticateCompletedSourceInput,
  validateCompletedSourceRestoration,
  validateCompletedSourceClaimRecovery,
  prepareCompletedSource,
  validateCompletedSourceConsumption,
  reviewObservationData,
  freezeReviewProgress: freeze,
  verifyCompletedNativeLaunch,
  verifyCompletedReviewConsumption,
  measureReaderCapacity,
  readerCapacityContract,
  verifyFileConsumption: (prepared, raw, dispatch, result) => verifyFileConsumption(prepared, raw, dispatch, result),
  observedSelection,
  writeTranscript,
  writeTaskFile,
  taskRelayInput,
  verifyTaskRelay,
  createCodexCliLauncher,
  generatedInstructions,
  createCodexRuntimeHost,
});
