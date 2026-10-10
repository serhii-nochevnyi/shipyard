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

function readerSubject(manifest) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical([manifest.snapshot, manifest.run_id, manifest.ticket, manifest.phase,
    manifest.role, manifest.dispatch_id, manifest.binding, manifest.accounting?.generated_instruction_bytes || 0,
    manifest.assets.map(asset => [asset.ordinal, asset.bytes, asset.sha256])]));
}

function readerCapacityContract(capacity, manifest) {
  const measured = readerCapacities.get(capacity);
  if (!measured || measured.subject !== readerSubject(manifest))
    fail('READER_CAPACITY_UNSUPPORTED', 'reader capacity lacks original measured current-subject authority');
  readNativeParentRaw(measured.launch.session, measured.verified.native_session_evidence, measured.launch.env, measured.launch.now);
  return measured.contract;
}

function measureReaderCapacity(verified, prepared) {
  const launch = measuredLaunches.get(verified);
  if (!launch) fail('READER_CAPACITY_UNSUPPORTED', 'capacity requires original verified native launch');
  if (readNativeParentRaw(launch.session, verified.native_session_evidence, launch.env, launch.now) !== launch.raw)
    fail('READER_CAPACITY_UNSUPPORTED', 'original measured output changed');
  const checked = require('./codex-arch-review-context.cjs').verifyFileInput(prepared);
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
  const chunkBytes = measurement?.chunk_bytes || prepared.input_bundle.chunk_bytes;
  const v2 = Boolean(measurement || prepared.input_bundle.transport);
  let outputBytes = 0, encodedBytes = 0, nestedBytes = 0, largestEnvelope = 0;
  if (typeof nativeRaw !== 'string' || Buffer.byteLength(nativeRaw) > 128 * 1024 * 1024)
    fail('READER_CAPACITY_UNSUPPORTED', 'native reader transcript exceeds its bounded output budget');
  const records = nativeRaw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (prepared.input_bundle.transport && !measurement) {
    const selection = prepared.input_bundle.transport.selection;
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
  const reads = expected.flatMap(asset => Array.from({ length: Math.ceil(asset.bytes.length / chunkBytes) }, (_, index) => ({
    command: 'dd if=' + quote(asset.path) + ' bs=' + chunkBytes
      + ' skip=' + index + ' count=1 2>/dev/null | base64',
    bytes: asset.bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes),
  })));
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
      if (!object(args)) continue;
      if (typeof args.cmd !== 'string' || !expected.some(asset => args.cmd.startsWith('dd if=' + quote(asset.path) + ' '))) continue;
      if ((prefix || item.internal_chat_message_metadata_passthrough?.turn_id !== undefined)
          && item.internal_chat_message_metadata_passthrough?.turn_id !== records[starts[0]].payload.turn_id)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native read belongs to a foreign task');
      if (index <= starts[0] || index >= boundary) fail('RUNTIME_EVIDENCE_MISMATCH', 'native read is outside the original task input boundary');
      if (args.cmd !== reads[at]?.command || at >= prepared.input_bundle.max_chunk_reads)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read is reordered, duplicated or exceeds its budget');
      if (pending.size) fail('RUNTIME_EVIDENCE_MISMATCH', 'ordered file read did not finish before the next read');
      if (typeof item.call_id !== 'string' || !item.call_id || calls.has(item.call_id))
        fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read repeats a call identity');
      if ((v2 || prefix) && (!custom || args.max_output_tokens !== 10000))
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
        output = results[0].output;
      } else {
        let parsed; try { parsed = JSON.parse(output); } catch {}
        if (!object(parsed)) fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read lacks a successful output envelope');
        if (object(parsed)) {
          if (parsed.exit_code !== 0 || parsed.session_id !== undefined)
            fail('RUNTIME_EVIDENCE_MISMATCH', 'native file read did not complete successfully');
          nestedBytes += Buffer.byteLength(output);
          output = parsed.output ?? parsed.stdout;
        }
      }
      const encoded = read.bytes.toString('base64');
      if (typeof output !== 'string' || (v2 && !/^[A-Za-z0-9+/=\r\n]*$/.test(output))
          || output.replace(v2 ? /[\r\n]/g : /\s/g, '') !== encoded)
        fail('RUNTIME_EVIDENCE_MISMATCH', 'original native file read is incomplete or truncated');
      encodedBytes += Buffer.byteLength(output);
      credited.add(item.call_id);
      pending.delete(item.call_id); at++;
      if (prefix) completedRanges.push({ ordinal: at - 1, command: read.command,
        sha256: crypto.createHash('sha256').update(read.bytes).digest('hex'), bytes: read.bytes.length,
        call_id: item.call_id, native_bytes: nativeBytes, native_sha256: prefixHasher.copy().digest('hex') });
    }
  }
  if (!prefix && (at !== reads.length || pending.size)) fail('RUNTIME_EVIDENCE_MISMATCH', 'complete original native file consumption is unproven');
  return { ...checked, chunk_reads: at, output_bytes: outputBytes, encoded_bytes: encodedBytes, largest_envelope_bytes: largestEnvelope,
    ...(prefix ? { completed_ranges: completedRanges, pending_reads: pending.size } : {}),
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

function verifyProtectedReviewPrefix(progress, prepared, raw) {
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
  const checked = verifyFileConsumption(prepared, prefix, progress.identity.dispatch_id, null, null,
    { turn_id: progress.turn_id });
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

function verifyResumedReview(progress, prepared, nativeRaw, resultText) {
  const identity = require('./codex-arch-review-context.cjs').reviewProgressIdentity(prepared);
  if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(progress.identity[key])))
    fail('REVIEW_RESTART_REQUIRED', 'current subject changed before fresh final admission');
  verifyProtectedReviewPrefix(progress, prepared, nativeRaw);
  const resume = progress.state.resume;
  const bytes = Buffer.from(nativeRaw);
  if (bytes.length <= resume.native_bytes || reviewHash(bytes.subarray(0, resume.native_bytes)) !== resume.native_sha256)
    fail('REVIEW_RESTART_REQUIRED', 'original conversation differs from the protected pre-resume context');
  const newRaw = bytes.subarray(resume.native_bytes).toString('utf8');
  const turn = freshReviewTurn(newRaw, resultText);
  if (turn === progress.turn_id) fail('RUNTIME_EVIDENCE_MISMATCH', 'historical turn cannot become a fresh judgment');
  const contexts = newRaw.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(record => record.type === 'turn_context');
  if (!contexts.length || contexts.some(record => record.payload?.turn_id !== undefined && record.payload.turn_id !== turn))
    fail('REVIEW_RESTART_REQUIRED', 'resumed turn lacks native selection attestation');
  const checked = verifyFileConsumption(prepared, newRaw, progress.identity.dispatch_id, resultText, null,
    { turn_id: turn, start: progress.completed_ranges });
  if (checked.pending_reads || checked.chunk_reads !== require('./codex-arch-review-context.cjs').verifyFileInput(prepared).chunk_reads)
    fail('RUNTIME_EVIDENCE_MISMATCH', 'fresh review has incomplete total current coverage');
  return { ...checked, turn_id: turn };
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
      const checked = collector.verifyFileInput(fileInput, { association: { dispatch_id: resumeReview ? resumeReview.progress.identity.dispatch_id : launchOptions.dispatch_id,
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
    const observeReview = fileTransport && !resumeReview && (launchOptions.review_progress === true
      || (fileInput.manifest.binding?.ticket_set && fileInput.manifest.binding?.merge_base))
      ? createReviewObserver(fileInput, { model, effort, sandbox_mode: sandbox,
        agent_file: agent?.file || launchOptions.agent_file || null,
        agent_file_digest: agent?.sha256 || launchOptions.agent_file_digest || null,
        ...(agent ? { agent, task } : {}), runtime_launch: runtimeLaunch }, env, launchOptions.onReviewProgress, () => child?.pid) : null;
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
    const stdout = [];
    const stderr = [];
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
      if (typeof launchOptions.onSessionStarted !== 'function' && !observeReview && !resumeReview) return;
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
      const input = agent ? taskRelayInput(agent.role, model, effort, task) : launchPrompt(prompt, content);
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
    if (observerTimer) clearInterval(observerTimer);
    inspectSessionRecords(Buffer.alloc(0), true);
    observe();
    const rawStdout = Buffer.concat(stdout).toString('utf8');
    const rawStderr = Buffer.concat(stderr).toString('utf8');
    const transcriptScope = resumeReview || observeReview ? { ...scope, run_id: scope.run_id + '-' + launchOptions.dispatch_id } : scope;
    if ((observeReview || resumeReview) && announcedSessionId) {
      const historical = writeTranscript(transcriptDir, transcriptScope, announcedSessionId, rawStdout);
      if (observeReview) observeReview.finish(exit, historical);
    }
    if (sessionCallbackError) throw sessionCallbackError;
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
        resumedConsumption = verifyResumedReview(resumeReview.progress, fileInput, raw, parsed.records[cliFinal]?.item.text);
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
        const consumed = resumedConsumption || verifyFileConsumption(fileInput, semanticRaw, launchOptions.dispatch_id,
          agent ? verified.last_agent_message : resultText);
        let result;
        try { result = JSON.parse(resultText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
        for (const [key, expected] of Object.entries({ input_manifest_sha256: fileInput.input_bundle.manifest_sha256,
          input_material_bytes: fileInput.input_bundle.total_bytes, input_asset_count: fileInput.input_bundle.asset_count,
          input_chunk_reads: consumed.chunk_reads })) {
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
        ...(resumeReview ? { review_continuation: { schema: 'shipyard.review-continuation.v1',
          progress: resumeReview.reference, original_dispatch_id: resumeReview.progress.identity.dispatch_id,
          original_launch: resumeReview.progress.original_launch.runtime_launch,
          original_exit: resumeReview.progress.state.original_exit,
          original_process_id: resumeReview.progress.original_launch.process_id,
          original_session_id: resumeReview.progress.session_id, original_turn_id: resumeReview.progress.turn_id,
          fresh_turn_id: resumedConsumption.turn_id, semantic_context: 'exact-native-session',
          inherited_ranges: resumeReview.progress.completed_ranges,
          newly_completed_ranges: resumedConsumption.chunk_reads - resumeReview.progress.completed_ranges } } : {}),
        ...(typedEvidence ? { native_child_evidence: typedEvidence } : {}),
        ...(fileTransport ? { input_transport: 'host-files', input_bundle: fileInput.input_bundle,
          input_accounting: fileInput.manifest.accounting,
          input_consumption: { native_session_sha256: nativeEvidence.sha256,
            manifest_sha256: fileInput.input_bundle.manifest_sha256, chunk_reads: require('./codex-arch-review-context.cjs').verifyFileInput(fileInput).chunk_reads } } : {}),
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
      if (resumeReview) {
        const token = reviewObservation({ worktree: scope.worktree, reference: resumeReview.reference,
          evidence: runtimeEvidence, turn_id: resumedConsumption.turn_id }, () => {
          const identity = require('./codex-arch-review-context.cjs').reviewProgressIdentity(fileInput);
          if (Object.keys(identity).some(key => JSON.stringify(identity[key]) !== JSON.stringify(resumeReview.progress.identity[key])))
            fail('REVIEW_RESTART_REQUIRED', 'current subject changed before protected final admission');
          const raw = readReviewNativeFile(resumeReview.progress.native_file, scope.worktree);
          if (reviewHash(raw) !== nativeEvidence.sha256) fail('REVIEW_RESTART_REQUIRED', 'fresh final changed before protected admission');
        });
        require('./role-artifact.cjs').completeReviewContinuation(token);
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
      const transcript = writeTranscript(transcriptDir, transcriptScope, parsed.session_id, rawStdout);
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
      return freeze(evidence);
    } catch (error) {
      if (error && error.name === 'CodexRuntimeHostError') throw error;
      fail('RUNTIME_EVIDENCE_INVALID', error.message);
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
    transcriptDir: options.transcriptDir || path.join(scope.worktree, '.planning', 'graph', 'transcripts', 'codex'),
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
      if (controller && UNAVAILABLE_CODES.has(error && error.code)
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
      + 'INPUT_MANIFEST_SHA256=' + prepared.input_bundle.manifest_sha256;
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
    const raw = readReviewNativeFile(progress.native_file, progress.identity.worktree);
    const { records } = validateReviewNative(raw, progress.session_id, { ...progress.original_launch, worktree: progress.identity.worktree });
    const starts = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'task_started');
    if (progress.state.resume || starts.length !== 1 || starts[0].payload.turn_id !== progress.turn_id)
      fail('REVIEW_RESTART_REQUIRED', 'original conversation has intervening or claimed review turns');
    verifyFileConsumption(prepared, raw, progress.identity.dispatch_id, null, null, { turn_id: progress.turn_id });
    return verifyProtectedReviewPrefix(progress, prepared, raw);
  },
  reviewObservationData,
  freezeReviewProgress: freeze,
  verifyCompletedNativeLaunch,
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
