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
const { newDispatchId, createDurableRecorder } = require('./dispatch-boundary.cjs');
const { createVerificationRunner } = require('./command-runner.cjs');
const { createRunScope } = require('./run-scope.cjs');
const { createRunController, DEFAULT_LEASE_TTL_MS } = require('./run-controller.cjs');
const { formatHint } = require('./refusal-hints.cjs');
const { acquire: acquireLock, DEFAULT_TTL_MS: LOCK_TTL_MS } = require('./lock.cjs');

const SCHEMA = 'shipyard.codex-delivery-host.v1';
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const SCRATCH_STATUS = new Set(['?? .shipyard-pr-body.md', '?? .shipyard-evidence.md']);
const CANDIDATE_SCHEMA = 'shipyard.finalization-candidate.v1';
const VERIFICATION_SCHEMA = 'shipyard.verification-record.v1';
const FINALIZATION_SCHEMA = 'shipyard.finalization-record.v1';
const ENVELOPE_FORMAT = 'shipyard.host-authenticated.v1';
const KEY_BYTES = 32;
const MAX_STATE_BYTES = 1024 * 1024;
const DOWNSTREAM_GATES = Object.freeze(['ci', 'review']);
const RESUME_SCOPE_FIELDS = Object.freeze(['run_id', 'repository', 'worktree', 'phase', 'ticket']);
const PLAN_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_COMMAND_OUTPUT_BYTES = 1024 * 1024;

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hostStateRoot(options, scope) {
  const root = stateRootOutsideWorktree(scope, options.storageRoot
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex'));
  return privateDirectory(root, 'finalization', sha256(fs.realpathSync(scope.worktree)));
}

function storageRootOf(options, scope) {
  return stateRootOutsideWorktree(scope, options.storageRoot
    || path.join(os.homedir(), '.local', 'state', 'shipyard', 'codex'));
}

function privateDirectory(root, ...parts) {
  const directory = path.join(root, ...parts);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function fsyncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch {}
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function atomicWrite(file, value, { exclusive }) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      try { fs.linkSync(temp, file); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } else {
      fs.renameSync(temp, file);
    }
    fsyncDirectory(path.dirname(file));
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
  }
}

function hostKey(root) {
  const file = path.join(privateDirectory(root, 'finalization-authority'), 'hmac.key');
  atomicWrite(file, crypto.randomBytes(KEY_BYTES), { exclusive: true });
  const stat = fs.lstatSync(file);
  const key = fs.readFileSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || key.length !== KEY_BYTES || (stat.mode & 0o077) !== 0) {
    fail('STATE_KEY_INVALID', 'host finalization key is invalid or too broadly accessible');
  }
  return key;
}

function seal(payload, key) {
  return { format: ENVELOPE_FORMAT, payload,
    integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', key).update(canonical(payload)).digest('hex') } };
}

function readSealed(file, key) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0) {
    fail('STATE_RECORD_INVALID', 'host state record is not a private bounded file: ' + path.basename(file));
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { fail('STATE_RECORD_INVALID', 'host state record is corrupt: ' + path.basename(file)); }
  if (!object(raw) || raw.format !== ENVELOPE_FORMAT || !object(raw.payload) || !object(raw.integrity)
      || raw.integrity.algorithm !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(raw.integrity.mac || '')) {
    fail('STATE_RECORD_INVALID', 'host state record has no authenticated envelope: ' + path.basename(file));
  }
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(canonical(raw.payload)).digest('hex'), 'hex');
  if (!crypto.timingSafeEqual(expected, Buffer.from(raw.integrity.mac, 'hex'))) {
    fail('STATE_RECORD_INVALID', 'host state record failed authentication: ' + path.basename(file));
  }
  return raw.payload;
}

function authenticatedReceipt(recorder, dispatchId) {
  if (!recorder || typeof recorder.getVerifiedRecord !== 'function') {
    fail('MISSING_RECEIPT', 'host recorder cannot authenticate the original dispatch receipt');
  }
  let record;
  try { record = recorder.getVerifiedRecord(dispatchId); }
  catch (error) { fail('MISSING_RECEIPT', 'original dispatch receipt could not be authenticated: ' + error.message); }
  const receipt = object(record) ? record.receipt : null;
  const proof = object(receipt) ? receipt.compliance_proof : null;
  if (!object(receipt) || record.dispatch_id !== dispatchId || receipt.dispatch_id !== dispatchId
      || receipt.compliance !== 'verified' || receipt.role !== 'executor' || !object(proof)
      || proof.boundary !== 'adr-014.dispatch-boundary' || proof.dispatch_id !== dispatchId
      || proof.launch_id !== receipt.launch_id || proof.policy_hash !== receipt.policy_hash
      || typeof receipt.launch_id !== 'string' || !receipt.launch_id) {
    fail('MISSING_RECEIPT', 'original executor dispatch has no authenticated verified receipt');
  }
  return Object.freeze({ receipt, digest: sha256(canonical(receipt)) });
}

function planSnapshot(graph, row) {
  if (typeof row.plan !== 'string' || !row.plan || path.isAbsolute(row.plan) || row.plan.split('/').includes('..')) {
    fail('VERIFICATION_SPEC_MISSING', 'canonical graph names no approved source PLAN; re-run decomposition');
  }
  const file = path.resolve(path.dirname(graph), '..', '..', row.plan);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (_) { fail('VERIFICATION_SPEC_MISSING', 'approved source PLAN is missing: ' + row.plan); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GRAPH_BYTES) {
    fail('VERIFICATION_SPEC_MISSING', 'approved source PLAN is not a bounded regular file');
  }
  const content = fs.readFileSync(file);
  return Object.freeze({ path: row.plan, sha256: sha256(content), text: content.toString('utf8') });
}

function planVerification(plan) {
  const lines = plan.text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Verification commands\s*$/.test(line));
  if (start === -1) return null;
  const commands = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const match = /^\s*[-*]\s+`([^`]+)`\s*$/.exec(line);
    if (!match) continue;
    if (/[|&;<>()$\\"'*?~{}[\]!#]/.test(match[1])) {
      fail('VERIFICATION_SPEC_UNSUPPORTED', 'PLAN verification command must be a plain argv without shell syntax: ' + match[1]
        + '; split it into separate bullets under "## Verification commands"');
    }
    const [program, ...argv] = match[1].trim().split(/\s+/);
    const executable = program === 'node' ? process.execPath : program;
    if (!path.isAbsolute(executable)) {
      fail('VERIFICATION_SPEC_UNSUPPORTED', 'PLAN verification command must start with node or an absolute executable: ' + match[1]);
    }
    commands.push({ id: 'plan-' + (commands.length + 1), executable, argv,
      timeoutMs: PLAN_COMMAND_TIMEOUT_MS, maxOutputBytes: PLAN_COMMAND_OUTPUT_BYTES });
  }
  return { commands };
}

function pinnedVerification(options, worktree, plan) {
  const spec = options.verification !== undefined ? options.verification : planVerification(plan);
  if (!object(spec) || !Array.isArray(spec.commands) || !spec.commands.length) {
    fail('VERIFICATION_SPEC_MISSING', 'approved PLAN ' + plan.path + ' lists no "## Verification commands"; add them to the PLAN');
  }
  const ids = new Set();
  const commands = spec.commands.map((command) => {
    if (!object(command) || typeof command.id !== 'string' || !command.id || ids.has(command.id)
        || typeof command.executable !== 'string' || !path.isAbsolute(command.executable)
        || !Array.isArray(command.argv) || command.argv.some((value) => typeof value !== 'string')
        || (command.cwd !== undefined && (typeof command.cwd !== 'string' || path.isAbsolute(command.cwd)
          || command.cwd.split('/').includes('..')))
        || !Number.isSafeInteger(command.timeoutMs) || !Number.isSafeInteger(command.maxOutputBytes)) {
      fail('VERIFICATION_SPEC_UNSUPPORTED', 'verification command needs unique id, absolute executable, argv, relative cwd and bounds');
    }
    ids.add(command.id);
    return Object.freeze({ id: command.id, executable: command.executable, argv: Object.freeze([...command.argv]),
      cwd: command.cwd || '.', timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes });
  });
  const required = Array.isArray(spec.required) ? [...spec.required] : commands.map((command) => command.id);
  if (!required.length || required.some((id) => !ids.has(id))) {
    fail('VERIFICATION_SPEC_UNSUPPORTED', 'every required pre-commit gate must name a configured command');
  }
  const pinned = Object.freeze({ commands: Object.freeze(commands), required: Object.freeze(required) });
  return Object.freeze({ spec: pinned, digest: sha256(canonical(pinned)), worktree });
}

function verificationRunner(options, prepared) {
  if (options.verificationRunner !== undefined) {
    if (!object(options.verificationRunner) || typeof options.verificationRunner.run !== 'function') {
      fail('INVALID_INPUT', 'verificationRunner must expose run(spec)');
    }
    return options.verificationRunner;
  }
  const commonDir = git(prepared.commit.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  try {
    return createVerificationRunner({
      readOnlyPaths: [prepared.commit.worktree, commonDir, path.dirname(process.execPath)],
      deniedPaths: [prepared.stateRoot, path.join(os.homedir(), '.gnupg'), path.join(os.homedir(), '.ssh'),
        ...(process.env.GNUPGHOME ? [process.env.GNUPGHOME] : []), ...(process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [])],
      envAllowlist: ['PATH', 'LANG', 'LC_ALL'],
    });
  } catch (error) {
    fail(error.code || 'SANDBOX_UNAVAILABLE', error.message);
  }
}

function scopedTreeOf(prepared, options) {
  const { scopedTree } = options.scopedTree ? { scopedTree: options.scopedTree }
    : require('./delivery-commit-finalizer.cjs');
  try {
    return scopedTree({ worktree: prepared.commit.worktree, expectedHead: prepared.commit.expectedHead,
      files_modified: prepared.commit.files_modified });
  } catch (error) {
    fail('SCOPED_TREE_UNAVAILABLE', error.message);
  }
}

function collectVerificationEvidence(prepared, verificationSpec, options = {}) {
  const runner = verificationRunner(options, prepared);
  const directory = privateDirectory(prepared.stateRoot, 'verification');
  const records = [];
  const failed = [];
  for (const command of verificationSpec.spec.commands) {
    const before = scopedTreeOf(prepared, options).tree;
    let result;
    try {
      result = runner.run({ ...command, cwd: path.join(prepared.commit.worktree, command.cwd) });
    } catch (error) {
      result = { status: null, signal: null, error_code: error.code || 'RUNNER_FAILED', timed_out: false,
        stdout_sha256: sha256(''), stderr_sha256: sha256(String(error.message)), backend: null, profile_sha256: null };
    }
    const after = scopedTreeOf(prepared, options).tree;
    const passed = result.status === 0 && !result.signal && !result.error_code && !result.timed_out && before === after;
    const payload = {
      schema: VERIFICATION_SCHEMA, version: 1,
      run_id: prepared.identity.run_id, dispatch_id: prepared.identity.dispatch_id,
      launch_id: prepared.identity.launch_id, ticket: prepared.commit.ticket,
      command_id: command.id, command_sha256: sha256(canonical(command)), spec_sha256: verificationSpec.digest,
      plan_sha256: prepared.plan.sha256, graph_sha256: prepared.graphDigest, policy_hash: prepared.identity.policy_hash,
      tree_before: before, tree_after: after,
      status: result.status === undefined ? null : result.status, signal: result.signal || null,
      error_code: result.error_code || null, timed_out: Boolean(result.timed_out),
      stdout_sha256: result.stdout_sha256 || null, stderr_sha256: result.stderr_sha256 || null,
      backend: object(result.backend) ? { kind: result.backend.kind, path: result.backend.path, digest: result.backend.digest } : null,
      profile_sha256: result.profile_sha256 || null,
      outcome: passed ? 'passed' : 'failed',
    };
    const envelope = seal(payload, prepared.key);
    const digest = sha256(canonical(envelope));
    atomicWrite(path.join(directory, digest + '.json'), JSON.stringify(envelope) + '\n', { exclusive: true });
    records.push(Object.freeze({ id: command.id, record_sha256: digest, outcome: payload.outcome }));
    if (!passed) failed.push(command.id + (before !== after ? ' (changed scoped tree)' : ''));
  }
  const missing = verificationSpec.spec.required.filter((id) => !records.some((record) => record.id === id));
  if (failed.length || missing.length) {
    const error = new Error('codex-delivery-host: pre-commit verification refused finalization: '
      + [...failed.map((id) => 'failed ' + id), ...missing.map((id) => 'missing ' + id)].join(', '));
    error.code = 'VERIFICATION_FAILED';
    error.gates = { pre_commit: records, downstream: pendingGates() };
    throw error;
  }
  return Object.freeze(records);
}

function pendingGates() {
  return Object.fromEntries(DOWNSTREAM_GATES.map((gate) => [gate, 'pending']));
}

function candidateFile(root, id) {
  return path.join(privateDirectory(root, 'candidates'), id + '.json');
}

function finalizationFile(root, id) {
  return path.join(privateDirectory(root, 'finalized'), id + '.json');
}

function admitCandidate(prepared, verification, records, tree) {
  const body = {
    schema: CANDIDATE_SCHEMA, version: 1,
    repository: prepared.repository, worktree: prepared.commit.worktree,
    phase: prepared.identity.phase, ticket: prepared.commit.ticket, branch: prepared.commit.expectedBranch,
    files_modified: [...prepared.commit.files_modified],
    run_id: prepared.identity.run_id, dispatch_id: prepared.identity.dispatch_id, launch_id: prepared.identity.launch_id,
    receipt_sha256: prepared.identity.receipt_sha256,
    graph_sha256: prepared.graphDigest, plan_path: prepared.plan.path, plan_sha256: prepared.plan.sha256,
    policy_hash: prepared.identity.policy_hash, model: prepared.identity.model, effort: prepared.identity.effort,
    signer: prepared.commit.expectedSigner, expected_head: prepared.commit.expectedHead,
    expected_base: prepared.commit.expectedBase, base_ref: prepared.baseRef,
    scoped_tree: tree.tree, changed: [...tree.changed],
    verification: { spec_sha256: verification.digest, required: [...verification.spec.required],
      records: records.map((record) => ({ ...record })) },
    gates: { pre_commit: 'passed', downstream: pendingGates() },
  };
  const id = sha256(canonical(body));
  const payload = { ...body, candidate_id: id };
  atomicWrite(candidateFile(prepared.stateRoot, id), JSON.stringify(seal(payload, prepared.key)) + '\n', { exclusive: true });
  return Object.freeze(payload);
}

function signedArtifact(worktree, candidate, committed) {
  if (!object(committed) || committed.ticket !== candidate.ticket
      || committed.previousHead !== candidate.expected_head || committed.signer !== candidate.signer
      || (committed.tree !== undefined && committed.tree !== candidate.scoped_tree)
      || !Array.isArray(committed.changed) || !committed.changed.length
      || committed.changed.some((entry) => typeof entry !== 'string' || !entry)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(committed.commit || '')
      || git(worktree, ['rev-parse', 'HEAD']) !== committed.commit) {
    fail('COMMIT_FINALIZATION_FAILED', 'trusted finalizer did not return the expected signed commit');
  }
  verifySignedCommit(worktree, candidate, committed.commit);
  return Object.freeze({
    schema: 'shipyard.codex-delivery-artifact.v1', status: 'committed',
    ticket: committed.ticket, commit: committed.commit, signer: committed.signer,
    changed: Object.freeze([...committed.changed]),
    candidate_id: candidate.candidate_id, tree: candidate.scoped_tree,
    gates: Object.freeze({ pre_commit: 'passed', downstream: Object.freeze(pendingGates()) }),
  });
}

function verifySignedCommit(worktree, candidate, commit) {
  git(worktree, ['verify-commit', commit]);
  const [code, fingerprint, parents, tree] = git(worktree, ['show', '-s', '--format=%G?%x00%GF%x00%P%x00%T', commit]).split('\0');
  if (!['G', 'U'].includes(code) || fingerprint !== candidate.signer) {
    fail('COMMIT_FINALIZATION_FAILED', 'host commit signature does not match the scoped signer');
  }
  if (parents !== candidate.expected_head || tree !== candidate.scoped_tree) {
    fail('COMMIT_FINALIZATION_FAILED', 'signed commit parent or tree differs from the verified candidate');
  }
}

function finalizeCandidate(candidate, stateRoot, key, options) {
  const finalizeCommit = finalizer(options);
  const committed = finalizeCommit({
    ticket: candidate.ticket, worktree: candidate.worktree, expectedBranch: candidate.branch,
    expectedBase: candidate.expected_base, expectedHead: candidate.expected_head,
    expectedSigner: candidate.signer, files_modified: [...candidate.files_modified],
    expectedTree: candidate.scoped_tree,
  });
  const artifact = signedArtifact(candidate.worktree, candidate, committed);
  atomicWrite(finalizationFile(stateRoot, candidate.candidate_id), JSON.stringify(seal({
    schema: FINALIZATION_SCHEMA, version: 1, candidate_id: candidate.candidate_id,
    commit: artifact.commit, signer: artifact.signer, parent: candidate.expected_head,
    tree: candidate.scoped_tree, changed: [...artifact.changed],
  }, key)) + '\n', { exclusive: true });
  return artifact;
}

function candidateRefusal(code, message, candidate, invalidated) {
  const error = new Error('codex-delivery-host: ' + message);
  error.code = code;
  if (candidate) {
    error.candidate_id = candidate.candidate_id;
    error.gates = { pre_commit: candidate.gates.pre_commit, downstream: { ...candidate.gates.downstream } };
  }
  if (invalidated) error.invalidated = [...invalidated];
  return error;
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
  const plan = planSnapshot(file, snapshot.row);
  const verification = pinnedVerification(options, worktree, plan);
  const commit = Object.freeze({
    ticket: scope.ticket,
    worktree,
    expectedBranch: snapshot.row.branch,
    expectedBase: git(worktree, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
    expectedHead: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    expectedSigner: signerFingerprint(worktree),
    files_modified: Object.freeze([...snapshot.row.files]),
  });
  const stateRoot = hostStateRoot(options, scope);
  const commonDir = fs.realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return Object.freeze({ commit, graphFile: file, graphDigest: snapshot.sha256, plan, verification, baseRef,
    stateRoot, key: hostKey(stateRoot), repository: 'git-common:' + sha256(commonDir) });
}

function finalizedArtifact(result, prepared, options) {
  if (!object(result) || !object(result.receipt) || result.receipt.compliance !== 'verified') {
    fail('MISSING_RECEIPT', 'executor has no verified dispatch receipt');
  }
  const original = authenticatedReceipt(options.recorder, result.receipt.dispatch_id);
  if (original.receipt.launch_id !== result.receipt.launch_id) {
    fail('MISSING_RECEIPT', 'executor result does not match its authenticated durable receipt');
  }
  const after = graphSnapshot(prepared.graphFile, prepared.commit.ticket);
  if (after.sha256 !== prepared.graphDigest) fail('GRAPH_CHANGED', 'canonical ticket graph changed during executor launch');
  const delta = git(prepared.commit.worktree, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter(Boolean).filter((entry) => !SCRATCH_STATUS.has(entry));
  if (!delta.length) fail('NO_PUBLISHABLE_DELTA', 'executor produced no worktree changes to finalize');
  const tree = scopedTreeOf(prepared, options);
  const identity = Object.freeze({
    run_id: options.scope.run_id, phase: options.scope.phase,
    dispatch_id: original.receipt.dispatch_id, launch_id: original.receipt.launch_id,
    receipt_sha256: original.digest, policy_hash: original.receipt.policy_hash,
    model: original.receipt.applied_model || null, effort: original.receipt.applied_effort || null,
  });
  const staged = { ...prepared, identity };
  const records = collectVerificationEvidence(staged, prepared.verification, options);
  const candidate = admitCandidate(staged, prepared.verification, records, tree);
  options.controller?.assertOwner(options.scope.run_id);
  let artifact;
  try {
    artifact = finalizeCandidate(candidate, prepared.stateRoot, prepared.key, options);
  } catch (error) {
    const refusal = candidateRefusal(error.code || 'COMMIT_FINALIZATION_FAILED',
      'finalization failed; candidate ' + candidate.candidate_id + ' is preserved for --resume-finalization: '
        + String(error.message).replace(/^codex-delivery-host: /, ''), candidate);
    throw refusal;
  }
  return Object.freeze({ ...result, artifact });
}

function liveGraph(options, worktree, ticket) {
  try {
    const file = graphFile(options, worktree);
    return { file, snapshot: graphSnapshot(file, ticket) };
  } catch (_) {
    return null;
  }
}

async function resumeFinalization(options, candidateId, liveScopeInput) {
  if (typeof candidateId !== 'string' || !/^[0-9a-f]{64}$/.test(candidateId)) {
    fail('INVALID_INPUT', 'candidate id must be a 64-character hex digest');
  }
  const liveScope = normalizeScope({ ...liveScopeInput, runtime: 'codex', provider: 'openai' });
  const worktree = fs.realpathSync(liveScope.worktree);
  const stateRoot = hostStateRoot(options, { worktree });
  const key = hostKey(stateRoot);
  const candidate = readSealed(candidateFile(stateRoot, candidateId), key);
  if (!candidate) throw candidateRefusal('CANDIDATE_MISSING', 'no authenticated finalization candidate ' + candidateId);
  if (candidate.schema !== CANDIDATE_SCHEMA || candidate.candidate_id !== candidateId) {
    throw candidateRefusal('STATE_RECORD_INVALID', 'candidate identity does not match its id', candidate);
  }
  const { candidate_id: _id, ...body } = candidate;
  if (sha256(canonical(body)) !== candidateId) {
    throw candidateRefusal('STATE_RECORD_INVALID', 'candidate content does not match its id', candidate);
  }
  const scopeMismatch = [];
  if (candidate.worktree !== worktree) scopeMismatch.push('worktree');
  if (candidate.ticket !== liveScope.ticket) scopeMismatch.push('ticket');
  if (candidate.phase !== liveScope.phase) scopeMismatch.push('phase');
  if (liveScope.repository !== undefined && liveScope.repository !== candidate.repository) scopeMismatch.push('repository');
  if (scopeMismatch.length) {
    throw candidateRefusal('IDENTITY_CHANGED', 'recovery scope differs from the candidate at ' + scopeMismatch.join(', '),
      candidate, scopeMismatch);
  }
  const recorder = options.recorder || createDurableRecorder(path.join(storageRootOf(options, { worktree }),
    sha256(`${candidate.run_id}\0${worktree}`), 'receipts'));
  let original;
  try { original = authenticatedReceipt(recorder, candidate.dispatch_id); }
  catch (error) { throw candidateRefusal('MISSING_RECEIPT', error.message.replace(/^codex-delivery-host: /, ''), candidate, ['receipt']); }
  if (original.digest !== candidate.receipt_sha256 || original.receipt.launch_id !== candidate.launch_id) {
    throw candidateRefusal('IDENTITY_CHANGED', 'original dispatch receipt differs from the candidate', candidate, ['receipt']);
  }

  const lock = acquireLock(privateDirectory(stateRoot, 'recovery'), candidateId,
    { ttlMs: LOCK_TTL_MS, waitMs: 0, label: 'resume-finalization:' + liveScope.run_id });
  if (!lock) throw candidateRefusal('RECOVERY_IN_PROGRESS', 'another recovery holds candidate ' + candidateId, candidate);
  try {
    options.controller?.assertOwner(liveScope.run_id);
    const finalized = readSealed(finalizationFile(stateRoot, candidateId), key);
    if (finalized) {
      const changed = git(worktree, ['diff', '--name-only', '--no-renames', candidate.expected_head, finalized.commit])
        .split('\n').filter(Boolean);
      if (finalized.candidate_id !== candidateId || git(worktree, ['rev-parse', 'HEAD']) !== finalized.commit
          || finalized.parent !== candidate.expected_head || finalized.tree !== candidate.scoped_tree
          || finalized.signer !== candidate.signer
          || canonical([...changed].sort()) !== canonical([...finalized.changed].sort())) {
        throw candidateRefusal('RECONCILIATION_REQUIRED', 'finalization record no longer matches HEAD; reconcile by hand', candidate);
      }
      verifySignedCommit(worktree, candidate, finalized.commit);
      return Object.freeze({ schema: SCHEMA, status: 'committed', resumed: true, idempotent: true,
        candidate_id: candidateId, artifact: Object.freeze({
          schema: 'shipyard.codex-delivery-artifact.v1', status: 'committed', ticket: candidate.ticket,
          commit: finalized.commit, signer: finalized.signer, changed: Object.freeze([...finalized.changed]),
          candidate_id: candidateId, tree: candidate.scoped_tree,
          gates: Object.freeze({ pre_commit: 'passed', downstream: Object.freeze(pendingGates()) }) }) });
    }

    const liveHead = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (liveHead !== candidate.expected_head
        && git(worktree, ['rev-list', '--parents', '-n', '1', liveHead]).split(' ')[1] === candidate.expected_head) {
      throw candidateRefusal('RECONCILIATION_REQUIRED', 'HEAD moved past the candidate without a trusted finalization record; reconcile by hand',
        candidate, ['head']);
    }
    const invalidated = [];
    const check =(name, fn) => {
      try { if (!fn()) invalidated.push(name); } catch (_) { invalidated.push(name); }
    };
    const graph = liveGraph(options, worktree, candidate.ticket);
    check('branch', () => git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) === candidate.branch);
    check('head', () => git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) === candidate.expected_head);
    check('base', () => git(worktree, ['rev-parse', '--verify', `${resolveBaseRef(worktree, graph.snapshot.row.pr_base)}^{commit}`])
      === candidate.expected_base);
    check('graph', () => graph && graph.snapshot.sha256 === candidate.graph_sha256);
    check('plan', () => planSnapshot(graph.file, graph.snapshot.row).sha256 === candidate.plan_sha256);
    check('policy', () => policy.resolveDispatch({ runtime: 'codex', role: 'executor', dispatch_id: candidate.dispatch_id })
      .policy_hash === candidate.policy_hash);
    check('signer', () => signerFingerprint(worktree) === candidate.signer);
    check('tree', () => scopedTreeOf({ commit: { worktree, expectedHead: candidate.expected_head,
      files_modified: candidate.files_modified } }, options).tree === candidate.scoped_tree);
    check('verification-spec', () => pinnedVerification(options, worktree, planSnapshot(graph.file, graph.snapshot.row))
      .digest === candidate.verification.spec_sha256);
    for (const pinned of candidate.verification.records) {
      check('verification:' + pinned.id, () => {
        const file = path.join(stateRoot, 'verification', pinned.record_sha256 + '.json');
        const record = readSealed(file, key);
        return record && pinned.outcome === 'passed' && record.outcome === 'passed'
          && sha256(canonical(JSON.parse(fs.readFileSync(file, 'utf8')))) === pinned.record_sha256
          && record.command_id === pinned.id && record.dispatch_id === candidate.dispatch_id
          && record.tree_after === candidate.scoped_tree && record.spec_sha256 === candidate.verification.spec_sha256;
      });
    }
    for (const id of candidate.verification.required) {
      if (!candidate.verification.records.some((record) => record.id === id)) invalidated.push('verification:' + id);
    }
    if (invalidated.length) {
      throw candidateRefusal('IDENTITY_CHANGED', 'candidate ' + candidateId + ' is stale; invalidated checks: '
        + invalidated.join(', '), candidate, invalidated);
    }
    options.controller?.assertOwner(liveScope.run_id);
    const artifact = finalizeCandidate(candidate, stateRoot, key, options);
    return Object.freeze({ schema: SCHEMA, status: 'committed', resumed: true, idempotent: false,
      candidate_id: candidateId, artifact });
  } finally {
    lock.release();
  }
}

function createFinalizationRecoveryHost(options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  return Object.freeze({
    schema: SCHEMA,
    version: 1,
    resumeFinalization: (candidateId, liveScope) => resumeFinalization(options, candidateId, liveScope),
  });
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
  const stateRoot = hostStateRoot(options, scope);
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
    additionalProtectedPaths: [stateRoot],
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
    resumeFinalization: (candidateId, liveScope) => resumeFinalization(options, candidateId, liveScope),
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
      return committing ? finalizedArtifact(result, prepared, { ...options, scope, recorder: runtimeHost.recorder }) : result;
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

function parseResumeArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== '--resume-finalization' || argv[2] !== '--scope-file'
      || typeof argv[1] !== 'string' || !/^[0-9a-f]{64}$/.test(argv[1])
      || typeof argv[3] !== 'string' || !argv[3].trim()) {
    fail('INVALID_INPUT', 'usage: codex-delivery-host.cjs --resume-finalization <candidate-id> --scope-file <json>');
  }
  return { candidateId: argv[1], scopeFile: path.resolve(argv[3]) };
}

function readResumeScope(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { fail('INVALID_INPUT', 'cannot stat recovery scope: ' + error.message); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    fail('INVALID_INPUT', 'recovery scope is not a bounded regular file');
  }
  let scope;
  try { scope = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('INVALID_INPUT', 'recovery scope is invalid JSON: ' + error.message); }
  if (!object(scope)) fail('INVALID_INPUT', 'recovery scope must be an object');
  for (const key of Object.keys(scope)) {
    if (!RESUME_SCOPE_FIELDS.includes(key)) fail('INVALID_INPUT', 'unsupported recovery scope field ' + key);
  }
  return scope;
}

async function runResumeCli(argv, stdout, options) {
  const parsed = parseResumeArguments(argv);
  const scope = canonicalCliScope(readResumeScope(parsed.scopeFile));
  const stateDir = storageDirectory(options, scope);
  const controller = createRunController({
    storeDir: path.join(stateDir, 'runs'),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const stateRoot = hostStateRoot(options, scope);
  const candidate = readSealed(candidateFile(stateRoot, parsed.candidateId), hostKey(stateRoot));
  if (!candidate) throw candidateRefusal('CANDIDATE_MISSING', 'no authenticated finalization candidate ' + parsed.candidateId);
  controller.begin(createRunScope({
    run_id: scope.run_id, repository_id: scope.repository, phase: scope.phase, ticket: scope.ticket,
    worktree: scope.worktree, runtime: 'codex', provider: 'openai', owner_id: controller.owner_id,
    dispatch: { dispatch_id: 'recovery-' + parsed.candidateId.slice(0, 32), role: 'executor',
      model: candidate.model, effort: candidate.effort, policy_hash: candidate.policy_hash },
  }));
  let result;
  try {
    const host = createFinalizationRecoveryHost({
      controller, graphDir: options.graphDir, storageRoot: options.storageRoot,
      finalizeCommit: options.finalizeCommit, verification: options.verification,
      recorder: options.recorder, scopedTree: options.scopedTree,
    });
    result = await host.resumeFinalization(parsed.candidateId, scope);
    controller.complete(scope.run_id, { reason: 'recovered signed commit ' + result.artifact.commit });
  } catch (error) {
    try {
      controller.fail(scope.run_id, {
        reason: String(error && error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400),
      });
    } catch {}
    throw error;
  }
  stdout.write(JSON.stringify(result) + '\n');
  return result;
}

async function runCli(argv = process.argv.slice(2), stdout = process.stdout, options = {}) {
  if (!object(options)) fail('INVALID_INPUT', 'host options must be an object');
  if (Array.isArray(argv) && argv[0] === '--resume-finalization') return runResumeCli(argv, stdout, options);
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
      verification: options.verification,
      verificationRunner: options.verificationRunner,
      scopedTree: options.scopedTree,
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
  collectVerificationEvidence,
  createCodexDeliveryHost,
  createFinalizationRecoveryHost,
  parseCliArguments,
  parseResumeArguments,
  readResumeScope,
  readRequestFile,
  runCli,
});

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write('codex-delivery-host: ' + (error && error.message ? error.message : error) + '\n');
    process.stderr.write(formatHint(error && error.code) + '\n');
    process.exitCode = 1;
  });
}
