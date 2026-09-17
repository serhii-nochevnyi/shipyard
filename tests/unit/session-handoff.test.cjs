'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  createSessionHandoff,
  resolveRepositoryIdentity,
  ownershipStorePath,
} = require('../../plugins/delivery-pipeline/scripts/session-handoff.cjs');
const {
  createDispatchBoundary,
  createDurableRecorder,
} = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  createCodexDispatchAdapter,
  CODEX_MODEL_IDS,
} = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');
const {
  CLAUDE_MODEL_ALIASES,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const {
  registerClaudeWorkflowHost,
  runClaudeWorkflow,
} = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-session-handoff-'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Shipyard Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return root;
}

function receiptFor(resolution) {
  return {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    launch_id: `launch-${resolution.dispatch_id}`,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.requested_model,
    applied_effort: resolution.requested_effort,
    observed_model: resolution.requested_model,
    observed_effort: resolution.requested_effort,
    policy_hash: resolution.policy_hash,
    backend: resolution.backend,
    mechanism: resolution.mechanism,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: `launch-${resolution.dispatch_id}`,
    },
  };
}

function adapter(calls, recorder) {
  return {
    runtime: 'codex',
    capabilities: { observedModel: true, observedEffort: true },
    supports: () => true,
    validate: () => true,
    launch(resolution, context) {
      calls.push({ resolution, context });
      return receiptFor(resolution);
    },
  };
}

function clean(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function checkpointPayload(root, overrides = {}) {
  return {
    plan_digest: 'a'.repeat(64),
    adr_digest: 'b'.repeat(64),
    policy_digest: 'c'.repeat(64),
    head: 'd'.repeat(40),
    base: 'e'.repeat(40),
    worktrees: [root],
    current_snapshot: { id: 'snapshot-1' },
    pending_wait_ids: [],
    pending_action_ids: [],
    dispatch_reservations: [],
    dispatch_receipts: [],
    artifact_refs: [{
      path: 'README.md',
      digest: crypto.createHash('sha256').update('fixture\n').digest('hex'),
    }],
    treatment: { wait: 'baseline', context: 'baseline' },
    budgets: { max_tokens: 1000 },
    next_action: 'resume checkpoint',
    ...overrides,
  };
}

function runChild(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: env.REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

suite('session handoff — durable owner fencing and dispatch boundary');

test('checkpoint, competing resumes, and one atomic acknowledgement fence the predecessor', () => {
  const root = repoFixture();
  try {
    const identity = resolveRepositoryIdentity(root);
    assert.equal(identity.common_dir, fs.realpathSync(path.join(root, '.git')));
    assert.equal(ownershipStorePath(identity), path.join(identity.common_dir, 'shipyard', 'ownership'));

    const handoff = createSessionHandoff({ cwd: root });
    const predecessor = handoff.begin({
      runId: 'run-predecessor', sessionId: 'session-predecessor',
      phase: '33', tickets: ['T-33-08'], runtime: 'claude',
    });
    assert.equal(predecessor.status, 'acknowledged');
    handoff.checkpoint(predecessor, checkpointPayload(root, {
      pending_wait_ids: ['wait-1'],
    }));
    assert.throws(() => handoff.assertOwner(predecessor), (error) => error.code === 'SESSION_CHECKPOINTED');

    const successorA = handoff.resume({
      runId: 'run-successor-a', sessionId: 'session-successor-a',
      phase: '33', tickets: ['T-33-08'], runtime: 'claude',
    });
    const successorB = handoff.resume({
      runId: 'run-successor-b', sessionId: 'session-successor-b',
      phase: '33', tickets: ['T-33-08'], runtime: 'claude',
    });
    assert.equal(successorA.status, 'preparing');
    assert.equal(successorB.status, 'preparing');
    const acknowledged = handoff.acknowledge(successorA, {
      revalidate: () => ({ valid: true, clean: true, children: [] }),
    });
    assert.equal(acknowledged.status, 'acknowledged');
    assert.ok(acknowledged.epoch > predecessor.epoch);
    assert.throws(() => handoff.acknowledge(successorB), (error) => error.code === 'HANDOFF_LOST');
    assert.throws(() => handoff.assertOwner(predecessor), (error) => error.code === 'SESSION_FENCED');
    assert.doesNotThrow(() => handoff.assertOwner(acknowledged));
  } finally {
    clean(root);
  }
});

test('two successor processes race through acknowledgement, then the winner dispatches at the real boundary', async () => {
  const root = repoFixture();
  const script = path.join(root, 'handoff-child.cjs');
  const childSource = `'use strict';
const { createSessionHandoff } = require(process.env.SESSION_HANDOFF_MODULE);
const { createDispatchBoundary, createDurableRecorder } = require(process.env.DISPATCH_BOUNDARY_MODULE);
function output(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
try {
  const [mode, scopeId, runId, sessionOrToken, receiptsDir] = process.argv.slice(2);
  const handoff = createSessionHandoff({ cwd: process.env.REPO_ROOT });
  if (mode === 'resume') {
    const value = handoff.resume({ scopeId, runId, sessionId: sessionOrToken, runtime: 'codex' });
    output({ ...value, token: value.token });
  } else if (mode === 'ack') {
    const candidate = handoff.attach({ scope_id: scopeId, candidate_id: runId, token: sessionOrToken }, 'candidate');
    const value = handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: true, children: [] }) });
    output({ ...value, token: value.token });
  } else if (mode === 'dispatch') {
    const owner = handoff.attach({ scope_id: scopeId, run_id: runId, token: sessionOrToken }, 'owner');
    const recorder = createDurableRecorder(receiptsDir);
    const adapter = {
      runtime: 'codex',
      capabilities: { observedModel: true, observedEffort: true },
      supports: () => true,
      validate: () => true,
      launch(resolution) {
        return {
          receipt_type: 'adr-014.application', runtime: resolution.runtime, role: resolution.role,
          dispatch_id: resolution.dispatch_id, launch_id: 'child-launch-' + resolution.dispatch_id,
          requested_model: resolution.requested_model, requested_effort: resolution.requested_effort,
          applied_model: resolution.requested_model, applied_effort: resolution.requested_effort,
          observed_model: resolution.requested_model, observed_effort: resolution.requested_effort,
          policy_hash: resolution.policy_hash, backend: resolution.backend, mechanism: resolution.mechanism,
          compliance: 'verified', compliance_proof: { status: 'verified', boundary: 'adr-014.dispatch-boundary',
            policy_hash: resolution.policy_hash, dispatch_id: resolution.dispatch_id,
            launch_id: 'child-launch-' + resolution.dispatch_id },
        };
      },
    };
    const boundary = createDispatchBoundary({ adapters: { codex: adapter }, recorder, handoff: owner });
    const result = boundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' });
    output({ dispatch_id: result.dispatch_id, session_handoff: result.session_handoff, receipt: result.receipt });
  } else {
    throw Object.assign(new Error('unknown mode'), { code: 'INVALID_INPUT' });
  }
} catch (error) {
  output({ error: { code: error.code || 'ERROR', message: error.message } });
  process.exitCode = 1;
}`;
  fs.writeFileSync(script, childSource);
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const predecessor = handoff.begin({
      runId: 'run-multiprocess-predecessor', sessionId: 'session-multiprocess-predecessor',
      phase: '33', tickets: ['T-33-08'], runtime: 'codex',
    });
    handoff.checkpoint(predecessor, checkpointPayload(root));
    const env = {
      REPO_ROOT: root,
      SESSION_HANDOFF_MODULE: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/session-handoff.cjs'),
      DISPATCH_BOUNDARY_MODULE: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs'),
    };
    const resumeArgs = [
      ['resume', 'phase=33;tickets=T-33-08', 'run-process-a', 'session-process-a'],
      ['resume', 'phase=33;tickets=T-33-08', 'run-process-b', 'session-process-b'],
    ];
    const resumes = [];
    for (const args of resumeArgs) resumes.push(await runChild(script, args, env));
    assert.equal(resumes[0].status, 0, `${resumes[0].stdout}${resumes[0].stderr}`);
    assert.equal(resumes[1].status, 0, `${resumes[1].stdout}${resumes[1].stderr}`);
    const candidates = resumes.map((result) => JSON.parse(result.stdout));
    assert.notEqual(candidates[0].candidate_id, candidates[1].candidate_id);

    const acknowledgements = await Promise.all(candidates.map((candidate) => runChild(
      script,
      ['ack', 'phase=33;tickets=T-33-08', candidate.candidate_id, candidate.token],
      env,
    )));
    const winners = acknowledgements.filter((result) => result.status === 0);
    const losers = acknowledgements.filter((result) => result.status !== 0);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const loserIndex = acknowledgements.findIndex((result) => result.status !== 0);
    const loserError = JSON.parse(losers[0].stdout).error.code;
    assert.ok(['HANDOFF_LOST', 'OWNERSHIP_LOCKED'].includes(loserError));
    const loserRetry = await runChild(
      script,
      ['ack', 'phase=33;tickets=T-33-08', candidates[loserIndex].candidate_id, candidates[loserIndex].token],
      env,
    );
    assert.notEqual(loserRetry.status, 0);
    assert.equal(JSON.parse(loserRetry.stdout).error.code, 'HANDOFF_LOST');
    const winner = JSON.parse(winners[0].stdout);
    const dispatch = await runChild(
      script,
      ['dispatch', 'phase=33;tickets=T-33-08', winner.run_id, winner.token, path.join(root, 'receipts')],
      { ...env, RECEIPTS_DIR: path.join(root, 'receipts') },
    );
    assert.equal(dispatch.status, 0);
    const result = JSON.parse(dispatch.stdout);
    assert.equal(result.session_handoff.scope_id, 'phase=33;tickets=T-33-08');
    assert.equal(result.session_handoff.run_id, winner.run_id);
    assert.ok(result.session_handoff.epoch > predecessor.epoch);
    assert.equal(handoff.inspect().pending_launch, null);
  } finally {
    clean(root);
  }
});

test('pinned references and live revalidation fail closed before a successor can take ownership', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const predecessor = handoff.begin({ runId: 'run-revalidation', sessionId: 'session-revalidation', phase: '33', tickets: ['T-33-08'] });
    handoff.checkpoint(predecessor, checkpointPayload(root));
    const candidate = handoff.resume({ runId: 'run-revalidation-successor', sessionId: 'session-revalidation-successor', phase: '33', tickets: ['T-33-08'] });
    assert.throws(() => handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: false, children: [] }) }),
      (error) => error.code === 'DIRTY_WORK');
    assert.throws(() => handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: true, children: ['child-1'] }) }),
      (error) => error.code === 'ACTIVE_CHILDREN');
    assert.throws(() => handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: true, children: [], head: 'f'.repeat(40) }) }),
      (error) => error.code === 'LIVE_STATE_STALE');
    fs.unlinkSync(path.join(root, 'README.md'));
    assert.throws(() => handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: true, children: [] }) }),
      (error) => error.code === 'MISSING_REFERENCE');
  } finally {
    clean(root);
  }
});

test('cancel-before-ack removes only the preparing successor and keeps the fence monotonic', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const predecessor = handoff.begin({ runId: 'run-cancel-predecessor', sessionId: 'session-cancel-predecessor', phase: '33', tickets: ['T-33-08'] });
    handoff.checkpoint(predecessor, checkpointPayload(root));
    const candidate = handoff.resume({ runId: 'run-cancelled', sessionId: 'session-cancelled', phase: '33', tickets: ['T-33-08'] });
    handoff.cancelBeforeAck(candidate);
    assert.equal(handoff.inspect().scopes[0].candidates.length, 0);
    assert.throws(() => handoff.acknowledge(candidate, { revalidate: () => ({ valid: true, clean: true, children: [] }) }),
      (error) => error.code === 'HANDOFF_LOST');
    const successor = handoff.resume({ runId: 'run-after-cancel', sessionId: 'session-after-cancel', phase: '33', tickets: ['T-33-08'] });
    const owner = handoff.acknowledge(successor, { revalidate: () => ({ valid: true, clean: true, children: [] }) });
    assert.ok(owner.epoch > predecessor.epoch);
  } finally {
    clean(root);
  }
});

test('the Claude workflow host and Codex adapter both enforce the host-held owner', async () => {
  const claudeRoot = repoFixture();
  const codexRoot = repoFixture();
  try {
    const claudeHandoff = createSessionHandoff({ cwd: claudeRoot });
    const claudeOwner = claudeHandoff.begin({ runId: 'run-claude-owner', sessionId: 'session-claude-owner', phase: '33', tickets: ['T-33-08'], runtime: 'claude' });
    const workflow = path.join(claudeRoot, 'workflow.mjs');
    fs.writeFileSync(workflow, "return await __createClaudeWorkflowDispatch({ agent, prompt: 'handoff test', role: 'executor', model: 'sonnet', effort: 'max', context: { ticket: 'T-33-08' } })");
    const recorder = createDurableRecorder(path.join(claudeRoot, 'receipts'));
    const evidence = new WeakMap();
    let claudeCalls = 0;
    const claudeResult = await runClaudeWorkflow({
      scriptPath: workflow,
      agent: async (prompt, options) => {
        claudeCalls++;
        const result = { prompt };
        evidence.set(result, { launch_id: 'claude-owner-launch', applied_model: options.model, applied_effort: options.effort, observed_model: options.model, observed_effort: options.effort });
        return result;
      },
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: { supportedModels: [CLAUDE_MODEL_ALIASES.sonnet], supportedEfforts: ['max'], observedModel: true, observedEffort: true },
      recorder,
      applicationEvidence: ({ result }) => evidence.get(result),
      handoff: claudeOwner,
    });
    assert.equal(claudeResult.receipt.compliance, 'verified');
    assert.equal(claudeCalls, 1);
    const registered = registerClaudeWorkflowHost({
      agent: async () => ({ launch_id: 'unused' }),
      parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      capabilities: { supportedModels: [CLAUDE_MODEL_ALIASES.sonnet], supportedEfforts: ['max'], observedModel: true, observedEffort: true },
      recorder,
      applicationEvidence: ({ result }) => evidence.get(result),
      handoff: claudeOwner,
    });
    assert.throws(() => registered.run('executors', { owner: { token: 'forged' } }), (error) => error.code === 'INVALID_HOST');
    claudeHandoff.checkpoint(claudeOwner, checkpointPayload(claudeRoot));
    await assert.rejects(
      () => runClaudeWorkflow({
        scriptPath: workflow,
        agent: async () => { claudeCalls++; },
        parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
        capabilities: { supportedModels: [CLAUDE_MODEL_ALIASES.sonnet], supportedEfforts: ['max'], observedModel: true, observedEffort: true },
        recorder,
        applicationEvidence: ({ result }) => evidence.get(result),
        handoff: claudeOwner,
      }),
      (error) => error.code === 'SESSION_CHECKPOINTED',
    );
    assert.equal(claudeCalls, 1);

    const codexHandoff = createSessionHandoff({ cwd: codexRoot });
    const codexOwner = codexHandoff.begin({ runId: 'run-codex-owner', sessionId: 'session-codex-owner', phase: '33', tickets: ['T-33-08'], runtime: 'codex' });
    const codexRecorder = createDurableRecorder(path.join(codexRoot, 'receipts'));
    const codexAdapter = createCodexDispatchAdapter({
      handoff: codexOwner,
      host: {
        capabilities: { supportedModels: Object.values(CODEX_MODEL_IDS), supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], observedModel: false, observedEffort: false },
        launch: (selection) => ({ launch_id: 'codex-owner-launch', applied_model: selection.model, applied_effort: selection.reasoning_effort }),
      },
    });
    const codexBoundary = createDispatchBoundary({ adapters: { codex: codexAdapter }, recorder: codexRecorder, handoff: codexOwner });
    const codexResult = codexBoundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' });
    assert.equal(codexResult.receipt.compliance, 'verified');
    assert.throws(() => codexBoundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08', owner: { token: 'forged' } }),
      (error) => error.code === 'INVALID_HANDOFF');
    codexHandoff.checkpoint(codexOwner, checkpointPayload(codexRoot));
    assert.throws(() => codexBoundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' }),
      (error) => error.code === 'SESSION_CHECKPOINTED');
  } finally {
    clean(claudeRoot);
    clean(codexRoot);
  }
});

test('ownership is shared by worktrees but independent repositories do not share the fence', () => {
  const root = repoFixture();
  const other = repoFixture();
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  try {
    git(root, 'worktree', 'add', '--quiet', worktree, '-b', 'handoff-test-worktree');
    const first = createSessionHandoff({ cwd: root }).begin({
      runId: 'run-root', sessionId: 'session-root', phase: '33', tickets: ['T-33-08'],
    });
    const fromWorktree = createSessionHandoff({ cwd: worktree });
    assert.throws(() => fromWorktree.begin({
      runId: 'run-worktree', sessionId: 'session-worktree', phase: '33', tickets: ['T-33-08'],
    }), (error) => error.code === 'ACTIVE_SCOPE');
    assert.equal(fromWorktree.status().scopes[0].owner.run_id, first.run_id);
    assert.doesNotThrow(() => createSessionHandoff({ cwd: other }).begin({
      runId: 'run-other-repo', sessionId: 'session-other-repo', phase: '33', tickets: ['T-33-08'],
    }));
  } finally {
    try { git(root, 'worktree', 'remove', '--force', worktree); } catch (_) { /* fixture cleanup */ }
    clean(root);
    clean(other);
  }
});

test('the live dispatch boundary requires the acknowledged host capability and clears its launch reservation only after recording', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const owner = handoff.begin({
      runId: 'run-dispatch', sessionId: 'session-dispatch', phase: '33', tickets: ['T-33-08'], runtime: 'codex',
    });
    const calls = [];
    const receipts = createDurableRecorder(path.join(root, 'receipts'));
    const boundary = createDispatchBoundary({
      adapters: { codex: adapter(calls, receipts) }, recorder: receipts, handoff: owner,
    });
    const result = boundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' });
    assert.equal(calls.length, 1);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(handoff.inspect().pending_launch, null);

    const legacyCalls = [];
    const legacyBoundary = createDispatchBoundary({
      cwd: root,
      adapters: { codex: adapter(legacyCalls, receipts) }, recorder: receipts,
    });
    assert.throws(() => legacyBoundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' }),
      (error) => error.code === 'SESSION_FENCED');
    assert.equal(legacyCalls.length, 0);

    const forged = { ...owner, token: 'forged' };
    assert.throws(() => createDispatchBoundary({
      adapters: { codex: adapter([], receipts) }, recorder: receipts, handoff: forged,
    }), (error) => error.code === 'INVALID_HANDOFF');
  } finally {
    clean(root);
  }
});

test('a predecessor cannot launch after checkpoint and an unresolved external launch blocks takeover', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const predecessor = handoff.begin({ runId: 'run-old', sessionId: 'session-old', phase: '33', tickets: ['T-33-08'] });
    handoff.checkpoint(predecessor, checkpointPayload(root, {
      next_action: 'dispatch',
    }));
    const staleCalls = [];
    const staleBoundary = createDispatchBoundary({
      adapters: { codex: adapter(staleCalls) }, recorder: () => true, handoff: predecessor,
    });
    assert.throws(() => staleBoundary.dispatch({ runtime: 'codex', role: 'executor' }, { ticket: 'T-33-08' }),
      (error) => error.code === 'SESSION_CHECKPOINTED');
    assert.equal(staleCalls.length, 0);

    const candidate = handoff.resume({ runId: 'run-new', sessionId: 'session-new', phase: '33', tickets: ['T-33-08'] });
    handoff.markAmbiguousLaunch(candidate, { dispatchId: 'external-dispatch', reason: 'launch-before-record' });
    assert.throws(() => handoff.acknowledge(candidate), (error) => error.code === 'AMBIGUOUS_LAUNCH');
  } finally {
    clean(root);
  }
});

test('corrupt ownership state refuses inspection and does not guess a new owner', () => {
  const root = repoFixture();
  try {
    const handoff = createSessionHandoff({ cwd: root });
    const owner = handoff.begin({ runId: 'run-corrupt', sessionId: 'session-corrupt', phase: '33', tickets: ['T-33-08'] });
    const file = path.join(ownershipStorePath(resolveRepositoryIdentity(root)), 'state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.payload.epoch = 'not-a-number';
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => handoff.inspect(), (error) => error.code === 'CORRUPT_STATE');
    assert.throws(() => handoff.resume({ runId: 'run-no-guess', sessionId: 'session-no-guess', phase: '33', tickets: ['T-33-08'] }),
      (error) => error.code === 'CORRUPT_STATE');
    assert.ok(owner);
  } finally {
    clean(root);
  }
});

done();
