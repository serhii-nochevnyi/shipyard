'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodexRuntimeHost, normalizeScope } = require('./codex-runtime-host.cjs');
const { launchAgent, ROLE_ALIASES } = require('./codex-agent.cjs');
const { repoRootOf, resolveBaseRef } = require('./graph-dir.cjs');
const policy = require('./model-policy.cjs');
const { newDispatchId } = require('./dispatch-boundary.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { createRunController, DEFAULT_LEASE_TTL_MS } = require('./run-controller.cjs');

const SCHEMA = 'shipyard.codex-delivery-host.v1';
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const SCRATCH_STATUS = new Set(['?? .shipyard-pr-body.md', '?? .shipyard-evidence.md']);

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

function git(worktree, args) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  } catch (error) {
    fail('COMMIT_PREFLIGHT_FAILED', 'Git preflight failed: ' + String(error.stderr || error.message).trim());
  }
}

function graphFile(options, worktree) {
  const common = repoRootOf(worktree);
  const directory = path.resolve(options.graphDir || process.env.SHIPYARD_GRAPH_DIR
    || path.join(common || worktree, '.planning', 'graph'));
  let parent;
  let file;
  try {
    parent = fs.lstatSync(directory);
    file = fs.lstatSync(path.join(directory, 'tickets.json'));
  } catch (_) {
    fail('GRAPH_UNAVAILABLE', 'canonical ticket graph is unavailable');
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || !file.isFile() || file.isSymbolicLink() || file.size > MAX_GRAPH_BYTES) {
    fail('GRAPH_UNAVAILABLE', 'canonical ticket graph must be a bounded real file');
  }
  return path.join(fs.realpathSync(directory), 'tickets.json');
}

function graphSnapshot(file, ticket) {
  let raw;
  let graph;
  try {
    raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_GRAPH_BYTES) throw new Error('graph exceeds size limit');
    graph = JSON.parse(raw);
  } catch (error) {
    fail('GRAPH_UNAVAILABLE', 'cannot read canonical ticket graph: ' + error.message);
  }
  const row = graph && graph.tickets && graph.tickets[ticket];
  if (!object(row) || typeof row.branch !== 'string' || !row.branch
      || typeof row.pr_base !== 'string' || !row.pr_base
      || !Array.isArray(row.files) || !row.files.length
      || row.files.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('GRAPH_UNAVAILABLE', 'canonical graph has no complete scoped ticket entry');
  }
  return Object.freeze({ row, sha256: crypto.createHash('sha256').update(raw).digest('hex') });
}

function signerFingerprint(worktree) {
  const key = git(worktree, ['config', '--get', 'user.signingkey']);
  if (!key) fail('SIGNER_UNAVAILABLE', 'host signing key is not configured');
  let output;
  try {
    output = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys', key], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
  } catch (error) {
    fail('SIGNER_UNAVAILABLE', 'host signing key is unavailable: ' + String(error.stderr || error.message).trim());
  }
  const lines = output.split(/\r?\n/);
  const fingerprint = lines.find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (lines.filter((line) => line.startsWith('sec:')).length !== 1
      || !/^[0-9A-F]{40}$/i.test(fingerprint || '')) {
    fail('SIGNER_UNAVAILABLE', 'host signing key has no unique full fingerprint');
  }
  return fingerprint;
}

function finalizer(options) {
  if (options.finalizeCommit !== undefined) {
    if (typeof options.finalizeCommit !== 'function') fail('INVALID_INPUT', 'finalizeCommit must be a function');
    return options.finalizeCommit;
  }
  try { return require('./delivery-commit-finalizer.cjs').finalizeDeliveryCommit; }
  catch (_) { fail('MISSING_FINALIZER', 'trusted delivery commit finalizer is unavailable'); }
}

function storageDirectory(options, scope) {
  const identity = crypto.createHash('sha256').update(`${scope.run_id}\0${scope.worktree}`).digest('hex');
  const root = stateRootOutsideWorktree(scope, options.storageRoot
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex'));
  const directory = path.join(root, identity);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function stateRootOutsideWorktree(scope, stateRoot) {
  const worktree = fs.realpathSync(scope.worktree);
  let root = path.resolve(stateRoot);
  const missing = [];
  while (!fs.existsSync(root)) {
    missing.unshift(path.basename(root));
    const parent = path.dirname(root);
    if (parent === root) fail('INVALID_STATE_DIR', 'host state root cannot be resolved');
    root = parent;
  }
  root = path.join(fs.realpathSync(root), ...missing);
  const relative = path.relative(worktree, root);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    fail('INVALID_STATE_DIR', 'host state must be outside the model worktree');
  }
  return root;
}

function canonicalCliScope(input) {
  const scope = normalizeScope(input);
  if (!path.isAbsolute(scope.worktree)) fail('INVALID_INPUT', 'worktree path must be absolute');
  let worktree;
  let commonDir;
  try {
    worktree = fs.realpathSync(scope.worktree);
    commonDir = fs.realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch (error) {
    fail('SCOPE_MISMATCH', 'run scope worktree is not a canonical Git worktree: ' + error.message);
  }
  if (fs.realpathSync(git(worktree, ['rev-parse', '--show-toplevel'])) !== worktree) {
    fail('SCOPE_MISMATCH', 'run scope worktree must be the Git root');
  }
  const repositoryId = 'git-common:' + crypto.createHash('sha256').update(commonDir).digest('hex');
  const supplied = scope.repository;
  if (supplied !== undefined) {
    const id = typeof supplied === 'string' ? supplied
      : object(supplied) ? supplied.repository_id || supplied.id : null;
    const suppliedWorktree = object(supplied) ? supplied.worktree : undefined;
    const suppliedPath = object(suppliedWorktree) ? suppliedWorktree.path : suppliedWorktree;
    if (id !== repositoryId || (suppliedPath !== undefined && suppliedPath !== worktree)) {
      fail('SCOPE_MISMATCH', 'caller repository identity contradicts canonical Git identity');
    }
  }
  return Object.freeze({ ...scope, worktree, repository: repositoryId });
}

function executorPreflight(options, scope) {
  if (!/^T-\d{2}-\d{2}$/.test(scope.ticket)) fail('SCOPE_MISMATCH', 'executor needs a ticket scope');
  const worktree = fs.realpathSync(scope.worktree);
  if (git(worktree, ['rev-parse', '--show-toplevel']) !== worktree) {
    fail('SCOPE_MISMATCH', 'executor worktree must be the repository root');
  }
  const file = graphFile(options, worktree);
  const snapshot = graphSnapshot(file, scope.ticket);
  if (git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== snapshot.row.branch) {
    fail('SCOPE_MISMATCH', 'executor branch differs from canonical ticket graph');
  }
  const dirty = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter(Boolean).filter((entry) => !SCRATCH_STATUS.has(entry));
  if (dirty.length) fail('WORKTREE_NOT_READY', 'executor worktree already has changes');
  const baseRef = resolveBaseRef(worktree, snapshot.row.pr_base);
  const commit = Object.freeze({
    ticket: scope.ticket,
    worktree,
    expectedBranch: snapshot.row.branch,
    expectedBase: git(worktree, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
    expectedHead: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    expectedSigner: signerFingerprint(worktree),
    files_modified: Object.freeze([...snapshot.row.files]),
  });
  return Object.freeze({ commit, graphFile: file, graphDigest: snapshot.sha256 });
}

function finalizedArtifact(result, prepared, options) {
  if (!object(result) || !object(result.receipt) || result.receipt.compliance !== 'verified') {
    fail('MISSING_RECEIPT', 'executor has no verified dispatch receipt');
  }
  const after = graphSnapshot(prepared.graphFile, prepared.commit.ticket);
  if (after.sha256 !== prepared.graphDigest) fail('GRAPH_CHANGED', 'canonical ticket graph changed during executor launch');
  const delta = git(prepared.commit.worktree, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter(Boolean).filter((entry) => !SCRATCH_STATUS.has(entry));
  if (!delta.length) fail('NO_PUBLISHABLE_DELTA', 'executor produced no worktree changes to finalize');
  options.controller?.assertOwner(options.scope.run_id);
  const finalizeCommit = finalizer(options);
  const committed = finalizeCommit(prepared.commit);
  if (!object(committed) || committed.ticket !== prepared.commit.ticket
      || committed.previousHead !== prepared.commit.expectedHead
      || committed.signer !== prepared.commit.expectedSigner
      || !Array.isArray(committed.changed) || !committed.changed.length
      || committed.changed.some((entry) => typeof entry !== 'string' || !entry)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(committed.commit || '')
      || git(prepared.commit.worktree, ['rev-parse', 'HEAD']) !== committed.commit) {
    fail('COMMIT_FINALIZATION_FAILED', 'trusted finalizer did not return the expected signed commit');
  }
  git(prepared.commit.worktree, ['verify-commit', committed.commit]);
  const signature = git(prepared.commit.worktree, ['show', '-s', '--format=%G?%x00%GF', committed.commit]).split('\0');
  if (!['G', 'U'].includes(signature[0]) || signature[1] !== prepared.commit.expectedSigner) {
    fail('COMMIT_FINALIZATION_FAILED', 'host commit signature does not match the scoped signer');
  }
  return Object.freeze({ ...result, artifact: Object.freeze({
    schema: 'shipyard.codex-delivery-artifact.v1', status: 'committed',
    ticket: committed.ticket, commit: committed.commit, signer: committed.signer,
    changed: Object.freeze([...committed.changed]),
  }) });
}

function createCodexDeliveryHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  const scope = normalizeScope(options.scope || options.runScope || {});
  if (!path.isAbsolute(scope.worktree)) fail('INVALID_INPUT', 'worktree path must be absolute');
  let worktree;
  try { worktree = fs.statSync(scope.worktree); }
  catch (error) { fail('INVALID_INPUT', 'worktree path cannot be inspected: ' + error.message); }
  if (!worktree.isDirectory()) fail('INVALID_INPUT', 'worktree path must be a directory');
  const storage = storageDirectory(options, scope);
  const runtimeHost = options.host || createCodexRuntimeHost({
    scope,
    controller: options.controller,
    capabilities: options.capabilities,
    capabilitiesFile: options.capabilitiesFile,
    executable: options.executable,
    probe: options.probe,
    recorder: options.recorder,
    recorderDir: options.recorderDir || path.join(storage, 'receipts'),
    transcriptDir: options.transcriptDir || path.join(storage, 'transcripts'),
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
      options.controller?.assertOwner(scope.run_id);
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
      const committing = request.role === 'executor';
      const prepared = committing ? executorPreflight(options, scope) : null;
      if (committing) {
        context.prompt = prompt.trim() + '\n\nLeave changes uncommitted. The trusted host will stage, sign, and verify the commit.';
      }
      const result = await launchAgent(request.role, {
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
      options.controller?.assertOwner(scope.run_id);
      return committing ? finalizedArtifact(result, prepared, { ...options, scope }) : result;
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
  try { stat = fs.lstatSync(file); }
  catch (error) { fail('INVALID_INPUT', 'cannot stat delivery request: ' + error.message); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARGS_BYTES) {
    fail('INVALID_INPUT', 'delivery request is not a bounded regular file');
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { fail('INVALID_INPUT', 'cannot read delivery request: ' + error.message); }
  let request;
  try { request = JSON.parse(raw); }
  catch (error) { fail('INVALID_INPUT', 'delivery request is invalid JSON: ' + error.message); }
  if (!object(request) || !object(request.scope)) fail('INVALID_INPUT', 'delivery request requires a scope and request fields');
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
  const scope = canonicalCliScope(parsed.scope);
  const request = parsed.launch;
  const dispatchId = request.dispatch_id || newDispatchId();
  const resolution = policy.resolveDispatch({
    runtime: 'codex', role: request.role,
    signals: request.signals, dispatch_id: dispatchId,
  });
  const stateDir = storageDirectory(options, scope);
  const controller = createRunController({
    storeDir: path.join(stateDir, 'runs'),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const run = createRunScope({
    run_id: scope.run_id,
    repository_id: scope.repository,
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
    const host = createCodexDeliveryHost({
      scope,
      controller,
      capabilities: options.capabilities,
      capabilitiesFile: options.capabilitiesFile,
      executable: options.executable,
      probe: options.probe,
      recorder: options.recorder,
      recorderDir: options.recorderDir || path.join(stateDir, 'receipts'),
      transcriptDir: options.transcriptDir || path.join(stateDir, 'transcripts'),
      env: options.env,
      spawn: options.spawn,
      ephemeral: options.ephemeral,
      approveForMe: options.approveForMe,
      agentDir: options.agentDir,
      agentManifest: options.agentManifest,
      graphDir: options.graphDir,
      storageRoot: options.storageRoot,
      finalizeCommit: options.finalizeCommit,
      host: options.host,
    });
    result = await host.run({ ...request, dispatch_id: dispatchId });
    clearInterval(heartbeat);
    if (heartbeatError) throw heartbeatError;
    controller.assertOwner(scope.run_id);
    if (request.role === 'executor' && (!result.artifact || result.artifact.status !== 'committed')) {
      fail('MISSING_ARTIFACT', 'executor produced no committed artifact');
    }
    controller.complete(scope.run_id, {
      reason: request.role === 'executor' ? 'verified signed commit ' + result.artifact.commit
        : 'verified dispatch receipt ' + result.receipt.dispatch_id,
    });
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
