'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createClaudeRuntimeHost, probeClaudeRuntime } = require('./claude-runtime-host.cjs');
const { registerClaudeWorkflowHost } = require('./claude-workflow-host.cjs');
const { loadClaudeReferenceContent } = require('./claude-reference-content.cjs');
const { finalizeDeliveryCommit } = require('./delivery-commit-finalizer.cjs');
const { isDurableRecorder } = require('./dispatch-boundary.cjs');
const { createRunController } = require('./run-controller.cjs');
const { createRunScope } = require('./run-scope.cjs');
const roleArtifact = require('./role-artifact.cjs');
const { resolveBaseRef } = require('./graph-dir.cjs');
const { sealResearch } = require('./planning-result-sealer.cjs');

const WORKFLOWS = Object.freeze(['executors', 'fix-round', 'drift-gate', 'investigation-research']);
const REQUEST_SCHEMA = 'shipyard.claude-delivery-request.v1';
const REQUEST_MAX_BYTES = 1024 * 1024;
const REVIEW_FEEDBACK_MAX_BYTES = 32768;
const REVIEW_DISPOSITIONS_MAX_BYTES = 65536;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(message) {
  const error = new Error(`claude-delivery-host: ${message}`);
  error.code = 'INVALID_HOST';
  throw error;
}

function parallel(jobs) {
  if (!Array.isArray(jobs) || jobs.length > 32 || jobs.some((job) => typeof job !== 'function')) {
    reject('parallel jobs must be a bounded array of functions');
  }
  return Promise.all(jobs.map((job) => job()));
}

function prepareArgs(name, args, reviewFeedback, scope) {
  if (name === 'executors') {
    return {
      ...args,
      deliveryRulesHint: 'Work only within files_modified. The trusted host stages and signs the commit after verification.',
      hostFinalizesCommit: true,
    };
  }
  if (name === 'investigation-research') {
    const { referencePath, ...rest } = args;
    if (referencePath === undefined) reject('investigation reference is required');
    if (Object.hasOwn(rest, 'runTicket')) reject('investigation run ticket is host-owned');
    return { ...rest, runTicket: scope.ticket,
      referenceContent: loadClaudeReferenceContent(referencePath) };
  }
  if (name === 'drift-gate') {
    const { driftRefPath, recordCmd, ...rest } = args;
    if (driftRefPath === undefined) reject('drift reference is required');
    return { ...rest, driftRefContent: loadClaudeReferenceContent(driftRefPath), hostRecordDrift: recordCmd !== undefined };
  }
  if (name === 'fix-round') {
    const forbidden = [
      'ciFixRefPath', 'reviewFixRefPath', 'reinitScript',
      'ciFixRefContent', 'reviewFixRefContent', 'reviewFeedback', 'hostFinalizesCommit',
    ];
    if (forbidden.some((key) => Object.hasOwn(args, key))) {
      reject('repair references, feedback, and finalization mode are host-owned');
    }
    return {
      ...args,
      ciFixRefContent: loadClaudeReferenceContent('ci-fix'),
      reviewFixRefContent: loadClaudeReferenceContent('review-fix'),
      reviewFeedback,
      hostFinalizesCommit: true,
    };
  }
  return args;
}

function assertScopedWork(name, args, scope) {
  if (!object(scope) || typeof scope.run_id !== 'string' || !scope.run_id.trim()
      || typeof scope.ticket !== 'string' || !scope.ticket.trim()
      || typeof scope.worktree !== 'string' || !scope.worktree.trim()) {
    reject('runtime scope requires run_id, ticket, and worktree');
  }
  const entries = name === 'executors' || name === 'drift-gate' ? args.tickets
    : name === 'fix-round' ? args.prs : null;
  if (Array.isArray(entries)) {
    if (entries.length > 1) reject('one scoped runtime host may launch only one ticket or PR');
    for (const entry of entries) {
      if (!object(entry) || entry.id !== scope.ticket
          || path.resolve(entry.worktreePath || '') !== path.resolve(scope.worktree || '')) {
        reject('workflow entry contradicts the runtime ticket or worktree scope');
      }
    }
  }
  if (name === 'investigation-research'
      && path.resolve(args.worktreePath || '') !== path.resolve(scope.worktree || '')) {
    reject('investigation contradicts the runtime ticket or worktree scope');
  }
}

function signingFreeEnvironment() {
  return Object.fromEntries([
    'GNUPGHOME', 'GPG_AGENT_INFO', 'GPG_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  ].map((name) => [name, undefined]));
}

function storageDirectory(options) {
  const scope = options.scope;
  if (!object(scope) || typeof scope.run_id !== 'string' || !scope.run_id.trim()
      || typeof scope.worktree !== 'string' || !scope.worktree.trim()) {
    reject('scope requires run_id and worktree');
  }
  const identity = crypto.createHash('sha256').update(`${scope.run_id}\0${path.resolve(scope.worktree)}`).digest('hex');
  const storage = path.join(options.storageRoot || path.join(os.homedir(), '.local', 'state', 'shipyard', 'claude'), identity);
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  return storage;
}

function runtimeOptions(options) {
  const storage = storageDirectory(options);
  const scrub = signingFreeEnvironment();
  const env = { ...(options.env || {}), ...scrub };
  const probe = options.probe || probeClaudeRuntime({ env: { ...process.env, ...env } });
  return {
    ...options,
    env,
    probe,
    recorderDir: options.recorderDir || path.join(storage, 'receipts'),
    transcriptDir: options.transcriptDir || path.join(storage, 'transcripts'),
  };
}

function git(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    }).trim();
  } catch (error) {
    reject(`Git preflight failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function graphDirectory(options) {
  const directory = path.resolve(options.graphDir || process.env.SHIPYARD_GRAPH_DIR
    || path.join(process.cwd(), '.planning', 'graph'));
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    reject('canonical graph directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    reject('canonical graph directory must be a real directory');
  }
  return fs.realpathSync(directory);
}

function readGraphFile(options, name) {
  const file = path.join(graphDirectory(options), name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    reject(`canonical ${name} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) {
    reject(`canonical ${name} must be a bounded regular file`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    reject(`canonical ${name} is invalid JSON`);
  }
}

function signingFingerprint(worktree) {
  const key = git(worktree, ['config', '--get', 'user.signingkey']);
  if (!key) reject('host Git signer is unavailable');
  let output;
  try {
    output = execFileSync('gpg', ['--batch', '--with-colons', '--list-secret-keys', key], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
  } catch (error) {
    reject(`host signing key cannot be resolved: ${String(error.stderr || error.message).trim()}`);
  }
  const lines = output.split(/\r?\n/);
  const secretKeys = lines.filter((line) => line.startsWith('sec:'));
  const fingerprint = lines.find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (secretKeys.length !== 1 || !/^[0-9A-F]{40}$/i.test(fingerprint || '')) {
    reject('host signing key has no unique full fingerprint');
  }
  return fingerprint;
}

function graphTicket(options, ticket, worktree) {
  const graph = readGraphFile(options, 'tickets.json');
  const row = graph && graph.tickets && graph.tickets[ticket];
  if (!object(row) || !Array.isArray(row.files) || !row.files.length
      || typeof row.branch !== 'string' || typeof row.pr_base !== 'string') {
    reject(`ticket ${ticket} has no complete canonical graph entry`);
  }
  if (git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== row.branch) {
    reject('ticket worktree branch differs from the canonical graph');
  }
  if (git(worktree, ['rev-parse', '--show-toplevel']) !== worktree) {
    reject('ticket worktree must be the repository root');
  }
  return row;
}

function canonicalPlan(options, row, entry) {
  const expected = path.resolve(graphDirectory(options), '..', '..', row.plan || '');
  if (typeof row.plan !== 'string' || !row.plan.trim()
      || typeof entry.planPath !== 'string' || !fs.existsSync(entry.planPath)
      || fs.realpathSync(entry.planPath) !== expected) {
    reject('workflow plan differs from the canonical graph');
  }
}

function canonicalBase(worktree, value, expected) {
  const resolved = resolveBaseRef(worktree, expected);
  if (value !== expected && value !== resolved) reject('workflow base differs from the canonical graph');
  return resolved;
}

function boardTicket(options, entry, row) {
  const state = readGraphFile(options, 'delivery-state.json');
  const board = state && state[entry.id];
  if (!object(board) || !Number.isInteger(board.pr) || board.pr !== entry.pr
      || board.branch !== row.branch || typeof board.base !== 'string' || !board.base.trim()) {
    reject('repair PR differs from the canonical delivery board');
  }
  return board;
}

function repairPreflight(options, entry) {
  const worktree = fs.realpathSync(entry.worktreePath);
  const row = graphTicket(options, entry.id, worktree);
  canonicalPlan(options, row, entry);
  const board = boardTicket(options, entry, row);
  if (entry.branch !== row.branch) reject('repair branch differs from the canonical graph');
  const baseRef = canonicalBase(worktree, entry.base || entry.prBase, board.base);
  return Object.freeze({
    ticket: entry.id,
    pr: entry.pr,
    worktree,
    branch: row.branch,
    base: board.base,
    baseRef,
    expectedBase: git(worktree, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
    expectedHead: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    files_modified: row.files,
    repo: row.repo || null,
    needsReviewFix: entry.needsReviewFix === true,
  });
}

function reconcileRepairBase(options, entry, repair) {
  const outcome = typeof options.reconcileBase === 'function'
    ? options.reconcileBase(repair) : reconcileBaseWithScript(options, repair);
  if (outcome && typeof outcome.then === 'function') {
    reject('trusted base reconciliation must finish before dispatch');
  }
  const refreshed = repairPreflight(options, entry);
  if (git(refreshed.worktree, ['merge-base', refreshed.expectedBase, refreshed.expectedHead])
      !== refreshed.expectedBase) {
    reject('trusted base reconciliation did not incorporate the canonical base');
  }
  if (refreshed.expectedHead !== repair.expectedHead) {
    git(refreshed.worktree, ['verify-commit', refreshed.expectedHead]);
    const signature = git(refreshed.worktree, ['show', '-s', '--format=%G?%x00%GF', refreshed.expectedHead]).split('\0');
    if (!['G', 'U'].includes(signature[0]) || signature[1] !== signingFingerprint(refreshed.worktree)) {
      reject('base reconciliation commit is not signed by the trusted host');
    }
  }
  return refreshed;
}

function hostCommand(options, executable, args, settings) {
  return (options.execHostCommand || execFileSync)(executable, args, settings);
}

function reconcileBaseWithScript(options, repair) {
  if (hasRepairChanges(repair.worktree)) reject('repair worktree must be clean before base reconciliation');
  git(repair.worktree, ['fetch', 'origin', '--prune']);
  const liveBaseRef = resolveBaseRef(repair.worktree, repair.base);
  const liveBase = git(repair.worktree, ['rev-parse', '--verify', `${liveBaseRef}^{commit}`]);
  if (repair.expectedHead !== liveBase
      && git(repair.worktree, ['merge-base', repair.expectedHead, liveBase]) === repair.expectedHead) {
    signingFingerprint(repair.worktree);
    git(repair.worktree, ['merge', '--ff-only', liveBaseRef]);
    git(repair.worktree, ['commit', '--allow-empty', '-S', '-m', `chore(${repair.ticket}): reconcile base`]);
    return { ticket: repair.ticket, requested_base: repair.base, base: liveBaseRef,
      result: 'fast-forward signed marker', unresolved: [], contested: [] };
  }
  const script = path.join(__dirname, 'base-merge.cjs');
  let output;
  try {
    output = hostCommand(options, process.execPath, [script, repair.ticket,
      '--worktree', repair.worktree, '--base', repair.base, '--graph', graphDirectory(options),
      '--no-fetch', '--json'], {
      cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000, maxBuffer: 65536,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'merge.gpgSign', GIT_CONFIG_VALUE_1: 'true',
      },
    });
  } catch (error) {
    reject(`trusted base reconciliation failed: ${String(error.stdout || error.stderr || error.message).trim().slice(0, 1000)}`);
  }
  let result;
  try { result = JSON.parse(output); } catch { reject('trusted base reconciliation returned invalid JSON'); }
  if (!object(result) || result.ticket !== repair.ticket || result.requested_base !== repair.base
      || result.base !== resolveBaseRef(repair.worktree, repair.base)
      || !['merged cleanly', 'resolved mechanically', 'already up to date'].includes(result.result)
      || !Array.isArray(result.unresolved) || result.unresolved.length
      || !Array.isArray(result.contested) || result.contested.length) {
    reject('trusted base reconciliation left unresolved conflicts or ambiguous evidence');
  }
  return result;
}

function driftPreflight(options, entry, args) {
  const worktree = fs.realpathSync(entry.worktreePath);
  const row = graphTicket(options, entry.id, worktree);
  canonicalPlan(options, row, entry);
  const base = entry.baseRef || args.baseRef;
  canonicalBase(worktree, base, row.pr_base);
}

function investigationPreflight(options, args) {
  const project = path.resolve(graphDirectory(options), '..', '..');
  const worktree = fs.realpathSync(args.worktreePath);
  if (git(worktree, ['rev-parse', '--show-toplevel']) !== worktree || worktree !== project) {
    reject('investigation worktree differs from the canonical graph repository');
  }
  const expected = path.join(project, '.planning', 'investigations', args.invId);
  if (!/^INV-[A-Za-z0-9-]+$/.test(args.invId || '') || !fs.existsSync(args.invPath || '')
      || fs.realpathSync(args.invPath) !== expected) {
    reject('investigation path differs from the canonical graph location');
  }
  if (args.sourceRevision !== undefined
      && args.sourceRevision !== git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])) {
    reject('investigation source revision differs from the canonical repository');
  }
}

function fetchReviewFeedback(options, repair) {
  let value;
  if (typeof options.fetchReviewFeedback === 'function') {
    value = options.fetchReviewFeedback(Object.freeze({
      ticket: repair.ticket, pr: repair.pr, worktree: repair.worktree, repo: repair.repo,
    }));
  } else {
    const argv = [path.join(__dirname, 'reviewers.cjs'), 'feedback', String(repair.pr),
      ...(repair.repo ? ['--repo', repair.repo] : [])];
    try {
      value = JSON.parse(execFileSync(process.execPath, argv, {
        cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000, maxBuffer: REVIEW_FEEDBACK_MAX_BYTES + 1,
      }));
    } catch (error) {
      reject(`trusted review feedback could not be fetched: ${String(error.stderr || error.message).trim()}`);
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    reject('trusted review feedback must be serializable');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > REVIEW_FEEDBACK_MAX_BYTES
      || (repair.needsReviewFix && (!object(value) || value.pr !== repair.pr
        || !Array.isArray(value.threads)
        || value.threads.length > 32
        || value.threads.some((thread) => !object(thread) || typeof thread.id !== 'string'
          || !thread.id.trim() || thread.comments_truncated === true)
        || new Set(value.threads.map((thread) => thread.id)).size !== value.threads.length
        || (value.threads.length === 0
          && (!Array.isArray(value.bot_comments) || value.bot_comments.length === 0)
          && (!Array.isArray(value.reviews) || value.reviews.length === 0))
        || (Array.isArray(value.truncated_threads) && value.truncated_threads.length)))) {
    reject('trusted review feedback is missing, incomplete, or exceeds the prompt bound');
  }
  return value;
}

function reviewDispositions(result, feedback) {
  const threads = feedback.threads;
  const dispositions = result.review_dispositions;
  if (result.status === 'escalate') {
    if (dispositions !== undefined && (!Array.isArray(dispositions) || dispositions.length)) {
      reject('escalated review repair cannot request partial thread actions');
    }
    return [];
  }
  if (result.status !== 'fixed' || !threads.length) {
    reject('review repair cannot claim completion without actionable fetched threads');
  }
  const expected = new Set();
  for (const thread of threads) {
    if (!object(thread) || typeof thread.id !== 'string' || !thread.id.trim()
        || Buffer.byteLength(thread.id, 'utf8') > 256 || expected.has(thread.id)) {
      reject('host-fetched review thread IDs are incomplete or ambiguous');
    }
    expected.add(thread.id);
  }
  let serialized;
  try { serialized = JSON.stringify(dispositions); } catch { reject('review dispositions must be serializable'); }
  if (!Array.isArray(dispositions) || dispositions.length !== expected.size || !serialized
      || Buffer.byteLength(serialized, 'utf8') > REVIEW_DISPOSITIONS_MAX_BYTES) {
    reject('review dispositions must cover each fetched thread exactly once within the result bound');
  }
  const seen = new Set();
  for (const item of dispositions) {
    if (!object(item) || Object.keys(item).some((key) => !['thread_id', 'action', 'reply', 'evidence'].includes(key))
        || !expected.has(item.thread_id) || seen.has(item.thread_id)
        || item.action !== 'reply-and-resolve'
        || typeof item.reply !== 'string' || !item.reply.trim()
        || Buffer.byteLength(item.reply, 'utf8') > 800
        || !object(item.evidence)
        || Object.keys(item.evidence).some((key) => !['command', 'result'].includes(key))
        || typeof item.evidence.command !== 'string' || !item.evidence.command.trim()
        || Buffer.byteLength(item.evidence.command, 'utf8') > 300
        || typeof item.evidence.result !== 'string' || !item.evidence.result.trim()
        || Buffer.byteLength(item.evidence.result, 'utf8') > 500) {
      reject('review disposition has an unknown thread, ambiguous action, or missing bounded evidence');
    }
    seen.add(item.thread_id);
  }
  return dispositions;
}

function applyReviewActionsWithReviewers(options, { repair, dispositions, feedback }) {
  reviewDispositions({ status: 'fixed', review_dispositions: dispositions }, feedback);
  const current = fetchReviewFeedback(options, repair);
  const snapshot = (value) => JSON.stringify(value.threads.map((thread) => ({
    id: thread.id, comments: thread.comments, comment_count: thread.comment_count,
  })));
  if (snapshot(current) !== snapshot(feedback)
      || (Array.isArray(current.bot_comments) && current.bot_comments.length > 0)
      || current.changes_requested === true) {
    reject('review feedback changed after dispatch; thread actions require a fresh repair round');
  }
  for (const item of dispositions) {
    let reply;
    try {
      reply = JSON.parse(hostCommand(options, 'gh', ['api', 'graphql',
        '-f', 'query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id body}}}',
        '-f', `id=${item.thread_id}`, '-f', `body=${item.reply}`], {
        cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000, maxBuffer: 8192,
      }));
    } catch (error) {
      reject(`trusted review reply failed for ${item.thread_id}: ${String(error.stderr || error.message).trim().slice(0, 500)}`);
    }
    const posted = reply && reply.data && reply.data.addPullRequestReviewThreadReply
      && reply.data.addPullRequestReviewThreadReply.comment;
    if (!object(posted) || typeof posted.id !== 'string' || posted.body !== item.reply) {
      reject(`trusted review reply was not confirmed for ${item.thread_id}`);
    }
    let resolution;
    try {
      resolution = JSON.parse(hostCommand(options, process.execPath, [path.join(__dirname, 'reviewers.cjs'),
        'resolve', String(repair.pr), item.thread_id,
        ...(repair.repo ? ['--repo', repair.repo] : [])], {
        cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000, maxBuffer: 8192,
      }));
    } catch (error) {
      reject(`trusted review resolution failed for ${item.thread_id}: ${String(error.stderr || error.message).trim().slice(0, 500)}`);
    }
    if (!object(resolution) || resolution.pr !== repair.pr || resolution.resolved !== 1
        || !Array.isArray(resolution.failed) || resolution.failed.length) {
      reject(`trusted review resolution was not confirmed for ${item.thread_id}`);
    }
  }
  return Object.freeze({ applied: true, resolved: dispositions.length });
}

function executorCommitInput(options, entry) {
  const worktree = fs.realpathSync(entry.worktreePath);
  const row = graphTicket(options, entry.id, worktree);
  canonicalPlan(options, row, entry);
  if (entry.branch !== row.branch || entry.prBase !== row.pr_base) {
    reject('executor branch or base contradicts the canonical ticket graph');
  }
  const baseRef = resolveBaseRef(worktree, row.pr_base);
  return Object.freeze({
    ticket: entry.id,
    worktree,
    expectedBranch: row.branch,
    expectedBase: git(worktree, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
    expectedHead: git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']),
    expectedSigner: signingFingerprint(worktree),
    files_modified: row.files,
  });
}

function sealPlanningResearch(input, options, scope) {
  const root = path.join(storageDirectory({ ...options, scope }), 'planning-artifacts');
  return sealResearch({ root, scope: { worktree: scope.worktree }, lines: input });
}

function repairResult(input, repair, feedback) {
  const result = input.result;
  if (!object(result) || result.id !== repair.ticket || result.pr !== repair.pr
      || result.pushed !== false || !['fixed', 'no-op', 'escalate'].includes(result.status)) {
    reject('repair result must identify the canonical PR and report pushed=false before sealing');
  }
  for (const name of ['notes', 'hypothesis']) {
    if (typeof result[name] !== 'string' || !result[name].trim()
        || Array.from(result[name]).length > 500) {
      reject(`repair ${name} must be bounded text before sealing`);
    }
  }
  if (input.artifact.worktreePath !== repair.worktree || input.artifact.base !== repair.base
      || input.artifact.branch !== repair.branch) {
    reject('repair artifact differs from canonical worktree, branch, or base');
  }
  if (repair.needsReviewFix) reviewDispositions(result, feedback);
  else if (result.review_dispositions !== undefined) reject('CI-only repair cannot request review actions');
  return result;
}

function hasRepairChanges(worktree) {
  const status = git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return status.split('\0').some((entry) => entry.length >= 4
    && entry.slice(3) !== roleArtifact.REPAIR_EVIDENCE_NAME
    && !entry.slice(3).startsWith(`${roleArtifact.ARTIFACT_ARCHIVE_DIR}/`));
}

function withHiddenRepairArtifacts(worktree, action) {
  const temporary = fs.mkdtempSync(path.join(path.dirname(worktree), '.shipyard-repair-host-'));
  const moved = [];
  try {
    for (const name of [roleArtifact.REPAIR_EVIDENCE_NAME, roleArtifact.ARTIFACT_ARCHIVE_DIR]) {
      const source = path.join(worktree, name);
      let stat;
      try {
        stat = fs.lstatSync(source);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink() || (name === roleArtifact.REPAIR_EVIDENCE_NAME && !stat.isFile())
          || (name === roleArtifact.ARTIFACT_ARCHIVE_DIR && !stat.isDirectory())) {
        reject('repair evidence path is not a regular host-owned artifact');
      }
      const destination = path.join(temporary, name);
      fs.renameSync(source, destination);
      moved.push({ source, destination });
    }
    const result = action();
    if (result && typeof result.then === 'function') {
      reject('trusted commit finalizer must finish before repair evidence is restored');
    }
    return result;
  } finally {
    for (const { source, destination } of moved.reverse()) fs.renameSync(destination, source);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function finalizedRepair(options, repair) {
  const expectedSigner = (options.signingFingerprint || signingFingerprint)(repair.worktree);
  return withHiddenRepairArtifacts(repair.worktree, () =>
    (options.finalizeCommit || finalizeDeliveryCommit)({
      ticket: repair.ticket,
      worktree: repair.worktree,
      expectedBranch: repair.branch,
      expectedBase: repair.expectedBase,
      expectedHead: repair.expectedHead,
      expectedSigner,
      files_modified: repair.files_modified,
    }));
}

function reinitializeRepairReviewers(repair) {
  let reinit;
  try {
    reinit = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'reviewers.cjs'), 'reinit',
      String(repair.pr), '--json', ...(repair.repo ? ['--repo', repair.repo] : [])], {
      cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    }));
  } catch (error) {
    return { reviewer_reinitialized: false,
      reviewer_error: String(error.stderr || error.message).trim().slice(0, 500) };
  }
  if (!object(reinit) || reinit.pr !== repair.pr) {
    return { reviewer_reinitialized: false,
      reviewer_error: 'reviewer reinitialization returned no matching PR result' };
  }
  const errors = [reinit.coderabbit && reinit.coderabbit.error, reinit.copilot && reinit.copilot.error]
    .filter(Boolean);
  return {
    reviewer_reinitialized: errors.length === 0,
    ...(errors.length ? { reviewer_error: errors.join('; ').slice(0, 500) } : {}),
  };
}

function publishRepair(options, repair, commit, { deferReinit = false } = {}) {
  if (typeof options.publishRepair === 'function') return options.publishRepair(repair, commit, { deferReinit });
  if (git(repair.worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) !== commit.commit
      || git(repair.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== repair.branch) {
    reject('signed repair commit moved before publication');
  }
  let live;
  try {
    live = JSON.parse(execFileSync('gh', ['pr', 'view', String(repair.pr),
      ...(repair.repo ? ['--repo', repair.repo] : []),
      '--json', 'headRefName,baseRefName'], {
      cwd: repair.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    }));
  } catch (error) {
    reject(`live repair PR could not be checked: ${String(error.stderr || error.message).trim()}`);
  }
  if (!object(live) || live.headRefName !== repair.branch || live.baseRefName !== repair.base) {
    reject('live repair PR differs from the canonical branch or base');
  }
  try {
    execFileSync('git', ['-C', repair.worktree, 'push', 'origin',
      `${commit.commit}:refs/heads/${repair.branch}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (error) {
    reject(`trusted repair push failed: ${String(error.stderr || error.message).trim()}`);
  }
  return Object.freeze({
    pushed: true,
    commit: commit.commit,
    ...(deferReinit ? { reviewer_reinitialized: false }
      : reinitializeRepairReviewers(repair)),
  });
}

function boundedPublication(publication) {
  let serialized;
  try { serialized = JSON.stringify(publication); } catch { reject('trusted repair publisher returned invalid evidence'); }
  if (!object(publication) || publication.pushed !== true || !serialized
      || Buffer.byteLength(serialized, 'utf8') > 2048) {
    reject('trusted repair publisher did not prove a push');
  }
  return publication;
}

function createClaudeDeliveryHost(options = {}) {
  if (!object(options)) reject('options must be an object');
  const suppliedController = options.controller || (options.runtimeHost && options.runtimeHost.controller);
  if (!object(suppliedController) || suppliedController.schema !== 'shipyard.run-controller.v1'
      || typeof suppliedController.assertOwner !== 'function') {
    reject('a real run controller with assertOwner is required before dispatch');
  }
  const runtime = options.runtimeHost || (options.createRuntimeHost || createClaudeRuntimeHost)(runtimeOptions(options));
  if (!object(runtime) || typeof runtime.agent !== 'function'
      || typeof runtime.applicationEvidence !== 'function' || !object(runtime.capabilities)
      || !isDurableRecorder(runtime.recorder)) {
    reject('runtime host lacks agent, application evidence, capabilities, or a durable recorder');
  }
  const scope = runtime.scope || options.scope;
  assertScopedWork('executors', { tickets: [] }, scope);
  if (options.scope && (options.scope.run_id !== scope.run_id
      || options.scope.ticket !== scope.ticket
      || path.resolve(options.scope.worktree || '') !== path.resolve(scope.worktree))) {
    reject('runtime scope contradicts the requested run scope');
  }
  suppliedController.assertOwner(scope.run_id);
  const prepared = new Map();
  const repairs = new Map();
  const reviewFeedbacks = new Map();
  const reviewActions = new Map();
  const committedRepairs = new Map();
  let repairActive = false;
  const sealArtifact = options.artifactConsumer || ((input) => roleArtifact.seal({
    ...input.artifact,
    result: input.result,
    recorder: runtime.recorder,
    dispatchId: input.record.receipt.dispatch_id,
  }));
  const artifactConsumer = (input) => {
    if (!object(input) || !object(input.artifact) || !object(input.record)
        || !object(input.record.receipt)) reject('artifact consumer requires a finalized dispatch record');
    if (input.artifact.role === 'research') return sealPlanningResearch(input, options, scope);
    if (input.artifact.role === 'executor' && input.result && input.result.status === 'committed') {
      const commit = prepared.get(input.artifact.ticket);
      if (!commit) reject('executor has no trusted commit preflight');
      finalizeDeliveryCommit(commit);
    }
    if (input.artifact.role === 'ci-fix' || input.artifact.role === 'review-fix') {
      const repair = repairs.get(input.artifact.ticket);
      if (!repair) reject('repair has no canonical host preflight');
      const result = repairResult(input, repair, reviewFeedbacks.get(repair.ticket));
      if (repair.needsReviewFix && result.status === 'fixed') {
        reviewActions.set(repair.ticket, reviewDispositions(result, reviewFeedbacks.get(repair.ticket)));
      }
      if (hasRepairChanges(repair.worktree)) {
        if (result.status !== 'fixed') reject('repair changed files without reporting fixed');
        committedRepairs.set(repair.ticket, finalizedRepair(options, repair));
      }
    }
    return sealArtifact(input);
  };
  const registered = registerClaudeWorkflowHost({
    ...runtime,
    controller: suppliedController,
    runId: scope.run_id,
    parallel: options.parallel || parallel,
    artifactConsumer,
    ...(options.artifactPreparer ? { artifactPreparer: options.artifactPreparer } : {}),
  });
  return Object.freeze({
    run(name, args) {
      if (!WORKFLOWS.includes(name)) reject(`unsupported delivery workflow ${JSON.stringify(name)}`);
      if (!object(args)) reject('workflow args must be an object');
      if (Object.keys(args).some((key) => ['scriptPath', 'host', 'agent', 'parallel', '__createClaudeWorkflowDispatch'].includes(key))) {
        reject('workflow args cannot supply a script path or host resources');
      }
      suppliedController.assertOwner(scope.run_id);
      assertScopedWork(name, args, scope);
      if (name === 'executors' && Array.isArray(args.tickets) && args.tickets.length === 1) {
        prepared.set(args.tickets[0].id, executorCommitInput(options, args.tickets[0]));
      }
      if (name === 'drift-gate' && Array.isArray(args.tickets)) {
        for (const entry of args.tickets) driftPreflight(options, entry, args);
      }
      if (name === 'investigation-research') investigationPreflight(options, args);
      let feedback = [];
      let repair;
      let baseCommit;
      if (name === 'fix-round' && Array.isArray(args.prs) && args.prs.length === 1) {
        if (repairActive) reject('a repair round is already active for this host');
        repair = repairPreflight(options, args.prs[0]);
        committedRepairs.delete(repair.ticket);
        reviewActions.delete(repair.ticket);
        if (args.prs[0].needsBaseMerge) {
          const previousHead = repair.expectedHead;
          repair = reconcileRepairBase(options, args.prs[0], repair);
          if (repair.expectedHead !== previousHead) baseCommit = Object.freeze({ commit: repair.expectedHead });
        } else if (git(repair.worktree, ['merge-base', repair.expectedBase, repair.expectedHead])
            !== repair.expectedBase) {
          reject('repair base moved and requires trusted reconciliation');
        }
        feedback = repair.needsReviewFix ? fetchReviewFeedback(options, repair) : [];
        if (repair.needsReviewFix && typeof options.applyReviewActions !== 'function'
            && (feedback.threads.length === 0
              || (Array.isArray(feedback.bot_comments) && feedback.bot_comments.length > 0)
              || feedback.changes_requested === true)) {
          reject('default review actions require complete thread-only feedback; broader findings need a trusted host action handler');
        }
        repairs.set(repair.ticket, repair);
        reviewFeedbacks.set(repair.ticket, feedback);
      }
      const workflowArgs = prepareArgs(name, args, feedback, scope);
      const run = () => registered.run(name, { args: workflowArgs });
      if (!repair) return run();
      repairActive = true;
      let launched;
      try { launched = run(); } catch (error) { repairActive = false; throw error; }
      return Promise.resolve(launched).then(async (result) => {
        const bounded = result && result[0];
        if (!bounded || (bounded.status !== 'fixed' && !(bounded.status === 'no-op' && baseCommit))) return result;
        suppliedController.assertOwner(scope.run_id);
        const commit = committedRepairs.get(repair.ticket) || baseCommit;
        let publication;
        if (commit && repair.needsReviewFix) {
          publication = boundedPublication(await publishRepair(options, repair, commit, { deferReinit: true }));
        }
        if (repair.needsReviewFix) {
          const input = Object.freeze({ repair, result: bounded,
            dispositions: reviewActions.get(repair.ticket), feedback });
          try {
            const applied = await (options.applyReviewActions || ((value) =>
              applyReviewActionsWithReviewers(options, value)))(input);
            if (!object(applied) || applied.applied !== true) {
              reject('trusted review-action callback did not prove completion');
            }
          } catch (error) {
            if (publication) reject(`repair push succeeded but review actions failed: ${error.message}`);
            throw error;
          }
        }
        if (!commit) return result;
        if (!publication) publication = boundedPublication(await publishRepair(options, repair, commit));
        if (repair.needsReviewFix && typeof options.publishRepair !== 'function') {
          publication = boundedPublication(Object.freeze({
            ...publication, ...reinitializeRepairReviewers(repair),
          }));
        }
        committedRepairs.delete(repair.ticket);
        return result.map((entry) => Object.freeze({ ...entry, status: 'fixed', host_publication: publication }));
      }).finally(() => { repairActive = false; });
    },
  });
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== '--workflow'
      || argv[2] !== '--request-file' || !WORKFLOWS.includes(argv[1])
      || typeof argv[3] !== 'string' || !argv[3]) {
    reject('usage: claude-delivery-host.cjs --workflow <executors|fix-round|drift-gate|investigation-research> --request-file <json>');
  }
  return { workflow: argv[1], requestFile: argv[3] };
}

function readRequest(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REQUEST_MAX_BYTES) {
    reject('request file must be a bounded regular file');
  }
  const request = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!object(request) || request.schema !== REQUEST_SCHEMA || !object(request.scope)
      || !object(request.args) || Object.keys(request).some((key) => !['schema', 'scope', 'args'].includes(key))) {
    reject('request file must contain schema, scope, and serializable args only');
  }
  return request;
}

function cliDispatch(workflow, args) {
  const entries = workflow === 'executors' || workflow === 'drift-gate' ? args.tickets
    : workflow === 'fix-round' ? args.prs : args.lines;
  if (!Array.isArray(entries) || entries.length !== (workflow === 'investigation-research' ? 4 : 1)
      || !object(entries[0])) {
    reject('CLI request requires one scoped ticket or PR, or four investigation lines');
  }
  const first = entries[0];
  const role = workflow === 'executors' ? 'executor'
    : workflow === 'drift-gate' ? 'drift-check'
      : workflow === 'investigation-research' ? 'research'
        : first.needsCiFix === true ? 'ci-fix' : 'review-fix';
  return { dispatch_id: `dispatch-${crypto.randomUUID()}`, role, model: first.model, effort: first.effort };
}

async function runClaudeDeliveryCli(argv = process.argv.slice(2), output = process.stdout, hostOptions = {}) {
  const { workflow, requestFile } = parseCli(argv);
  const request = readRequest(requestFile);
  if (!object(hostOptions)) reject('CLI host options must be an object');
  let hostScope = request.scope;
  if (workflow === 'investigation-research') {
    if (request.scope.ticket !== request.args.invId) {
      reject('investigation scope ticket must match the investigation id');
    }
    const phase = Number(request.scope.phase);
    if (!Number.isSafeInteger(phase) || phase < 1 || phase > 99) {
      reject('investigation run phase cannot form a scoped controller ticket');
    }
    hostScope = { ...request.scope, ticket: `T-${String(phase).padStart(2, '0')}-00` };
  }
  assertScopedWork(workflow, request.args, hostScope);
  const worktree = fs.realpathSync(hostScope.worktree);
  if (worktree !== hostScope.worktree || git(worktree, ['rev-parse', '--show-toplevel']) !== worktree) {
    reject('CLI run scope must name the canonical repository root');
  }
  const ownerId = `claude-cli-${crypto.randomUUID()}`;
  const scope = createRunScope({
    run_id: hostScope.run_id,
    repository_id: worktree,
    phase: hostScope.phase,
    ticket: hostScope.ticket,
    worktree,
    runtime: 'claude',
    owner_id: ownerId,
    dispatch: cliDispatch(workflow, request.args),
  });
  const controller = createRunController({
    storeDir: path.join(storageDirectory({ ...hostOptions, scope: hostScope }), 'controller'),
    ownerId,
  });
  controller.begin(scope);
  let heartbeatError;
  const heartbeat = setInterval(() => {
    try { controller.heartbeat(scope.run_id); } catch (error) { heartbeatError = error; }
  }, 60000);
  heartbeat.unref();
  try {
    const result = await createClaudeDeliveryHost({
      ...hostOptions, scope: hostScope, controller,
    }).run(workflow, request.args);
    if (heartbeatError) throw heartbeatError;
    controller.complete(scope.run_id);
    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    try { controller.fail(scope.run_id, { reason: String(error.message || error).slice(0, 500) }); } catch {}
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = Object.freeze({ WORKFLOWS, REQUEST_SCHEMA, createClaudeDeliveryHost, runClaudeDeliveryCli });

if (require.main === module) {
  runClaudeDeliveryCli().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
