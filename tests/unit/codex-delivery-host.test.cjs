'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');
const { createDeliveryFixture } = require('./helpers/phase53-delivery-fixture.cjs');
const { createRuntimeLifecycle } = require('./helpers/phase53-runtime-fixture.cjs');

function validateSelection(selectionArgs) {
if (selectionArgs.some(value => !['--code-review-entry-only', '--integrator-default-only', '--integrator-legacy-compatibility-only'].includes(value))
    || selectionArgs.length > 1)
  throw new Error('Unknown or conflicting delivery-host selection');
}

function registerTests(runTest, context = createDeliveryFixture(), options = {}) {
const suite = options.suite || (() => {});
const selectionArgs = options.selectionArgs || [];
validateSelection(selectionArgs);
if (selectionArgs.length) return registerSelectedTests(runTest, context, options);
const test = (name, callback) => runTest(name, callback, { module: 'D', family: 'delivery' });
const { codeReviewEntryFixture, codexPartitionHelpers, captured, agentManifestFor, git, writeShipyardManifest, fixture, configureMergedParentBase, hostRunner, application, delivery, clean, runStatus, cliOptions, stateRoot, candidatePath, recovery, liveScope, failedFinalization, assertRecoveryPolicy, resealCandidate, approvedPlan, repairAuthorFromQuery, policy, createDurableRecorder, createPlanningWriterLease, runBounded, createCodexDeliveryHost, createFinalizationRecoveryHost, parseResumeArguments, parseRepairActionResumeArguments, readResumeScope, parseCliArguments, readRequestFile, requestValue, completeRepairFeedback, shareRepairTransitions, repairCoverageTransition, recheckHistoricalRepair, runCli, validateArgs, verificationFailureContext, verificationFailureReason, createRunController, createRunScope, SCRATCH_FILES, codexCapabilities, capabilities, finalizeCommit, withGraphDirEnv, temporary, signer } = context;

suite('codex-delivery-host — scoped production dispatch');

test('executor leaves every shared scratch file outside the signed tree', async () => {
  const f = fixture();
  try {
    for (const name of SCRATCH_FILES) fs.writeFileSync(path.join(f.root, name), 'scratch\n');
    const result = await delivery(f).run({ role: 'executor', dispatch_id: 'all-scratch',
      context: { prompt: 'Implement the scoped ticket.' } });
    assert.equal(result.artifact.status, 'committed');
    assert.deepEqual(result.artifact.changed, ['src/owned.txt']);
    assert.equal(git(f.root, 'ls-tree', '--name-only', 'HEAD', ...SCRATCH_FILES), '');
  } finally { clean(f); }
});

test('executor refuses an untracked file outside the shared scratch set', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, '.shipyard-x.js'), 'agent content\n');
    await assert.rejects(delivery(f).run({ role: 'executor', dispatch_id: 'other-untracked',
      context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => error.code === 'WORKTREE_NOT_READY');
  } finally { clean(f); }
});

test('dynamic executor resolves Sol/low through the boundary with worktree write access', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({
      role: 'executor',
      dispatch_id: 'codex-delivery-executor',
      context: { prompt: 'Implement the scoped ticket.' },
    });
    const call = f.calls[0];
    assert.equal(call.method, 'dynamic');
    assert.equal(call.selection.model, 'gpt-6.1-sol');
    assert.equal(call.selection.reasoning_effort, 'low');
    assert.equal(call.context.sandbox_mode, 'workspace-write');
    assert.equal(call.context.run_id, f.scope.run_id);
    assert.equal(call.context.worktreePath, f.scope.worktree);
    assert.match(call.context.prompt, /active coordinator-owned Shipyard delivery loop/);
    assert.match(call.context.prompt, /Do not restart shipyard-route, bootstrap, marketplace installation/);
    assert.match(call.context.prompt, /^Implement the scoped ticket\.\n\nYou are an executor already dispatched/);
    assert.match(call.context.prompt,
      /Leave changes uncommitted\. The trusted host will stage, sign, and verify the commit\.\n\n<TICKET-CONTRACT path="\.planning\/PLAN\.md"/);
    assert.match(call.context.prompt, /# approved plan/);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.applied_model, 'gpt-6.1-sol');
    assert.equal(result.receipt.applied_effort, 'low');
    assert.equal(result.artifact.status, 'committed');
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(result.artifact.signer, signer);
    assert.deepEqual(result.artifact.changed, ['src/owned.txt']);
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(git(f.root, 'show', '-s', '--format=%G?%x00%GF', 'HEAD'), `G\0${signer}`);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
  } finally { clean(f); }
});

test('target-project executor finalizes a conventional, id-free subject from the canonical graph title', async () => {
  const f = fixture({ target: true });
  try {
    await withGraphDirEnv(f.graphDir, async () => {
      let refusal;
      await assert.rejects(() => delivery(f).run({ role: 'executor', dispatch_id: 'codex-target-untitled',
        context: { prompt: 'Implement the scoped ticket.' } }), (error) => { refusal = error; return true; });
      assert.match(refusal.message, /no canonical graph title/);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      const graphFile = path.join(f.graphDir, 'tickets.json');
      const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
      Object.assign(graph.tickets['T-38-04'], { title: 'Retry the flaky upload', type: 'bugfix' });
      fs.writeFileSync(graphFile, JSON.stringify(graph));
      git(f.root, 'checkout', '-q', '--', 'src/owned.txt');
      const result = await delivery(f).run({ role: 'executor', dispatch_id: 'codex-target-titled',
        context: { prompt: 'Implement the scoped ticket.' } });
      assert.equal(result.artifact.status, 'committed');
      assert.equal(git(f.root, 'log', '-1', '--format=%s', 'HEAD'), 'fix: retry the flaky upload');
      assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    });
  } finally { clean(f); }
});

test('production runtime host receives the scoped prompt and records native model evidence', async () => {
  const f = fixture();
  const codeHome = path.join(temporary, 'codex-home-' + path.basename(f.root));
  const session = '44444444-4444-4444-8444-444444444444';
  const received = [];
  let capturedArgs;
  const transcript = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
    .split('\n').filter(Boolean).map((line) => {
      const record = JSON.parse(line);
      if (record.type === 'turn_context') Object.assign(record.payload, { model: 'gpt-6.1-sol', effort: 'low' });
      if (record.payload?.type === 'task_complete') record.payload.last_agent_message = 'OK';
      if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
        record.payload.content.forEach(block => { block.text = 'OK'; });
      return JSON.stringify(record);
    }).join('\n') + '\n';
  const output = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session });
  try {
    const result = await createCodexDeliveryHost({
      scope: f.scope,
      graphDir: f.graphDir,
      storageRoot: f.storageRoot,
      finalizeCommit,
      capabilities,
      probe: {
        status: 'available', executable: 'codex', runtime_version: '0.157.1',
        capabilities: { ...capabilities, cliVersion: '0.157.1' },
      },
      env: { CODEX_HOME: codeHome, GNUPGHOME: process.env.GNUPGHOME, SSH_AUTH_SOCK: '/tmp/ssh.sock' },
      agentDir: f.agentDir,
      agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
      verification: f.verification,
      verificationRunner: hostRunner(),
      spawn: (_executable, args, options) => {
        capturedArgs = args;
        assert.equal(options.env.GNUPGHOME, undefined);
        assert.equal(options.env.SSH_AUTH_SOCK, undefined);
        fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'changed\n');
        const date = new Date();
        const directory = path.join(options.env.CODEX_HOME, 'sessions', String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'rollout-' + Date.now() + '-' + session + '.jsonl'), transcript);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write(value) { received.push(String(value)); }, end() {} };
        child.pid = 45678;
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(output));
          child.emit('close', 0, null);
        });
        return child;
      },
    }).run({ role: 'executor', context: { prompt: 'Edit the scoped file.' } });
    assert.ok(received.join('').includes('Edit the scoped file.'));
    assert.equal(result.receipt.applied_model, 'gpt-6.1-sol');
    assert.equal(result.receipt.applied_effort, 'low');
    assert.equal(result.receipt.runtime_evidence.native_session_evidence.session_id, session);
    assert.equal(result.artifact.status, 'committed');
    assert.ok(result.receipt.runtime_evidence.transcript.path.startsWith(fs.realpathSync(f.storageRoot)));
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    const filesystemArg = capturedArgs.find((value) => value.startsWith('permissions.shipyard-runtime.filesystem='));
    assert.ok(filesystemArg.includes(JSON.stringify(stateRoot(f)) + '="deny"'));
    const archiveAuthority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs')
      .archiveAuthorityDirectory(f.root);
    assert.ok(filesystemArg.includes(JSON.stringify(archiveAuthority) + '="deny"'));
    assert(result.receipt.runtime_evidence.sandbox_evidence.protected_paths.includes(archiveAuthority));
  } finally { clean(f); }
});

test('generated static role uses its immutable file and declared read-only sandbox', async () => {
  const f = fixture();
  try {
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Inspect the scoped plan.' } });
    const call = f.calls[0];
    assert.equal(call.method, 'static');
    assert.equal(call.selection.agent_file, f.file);
    assert.equal(call.selection.model, 'gpt-6.1-sol');
    assert.equal(call.selection.reasoning_effort, 'high');
    assert.equal(call.selection.sandbox_mode, 'read-only');
    assert.equal(result.receipt.agent_file_digest, f.fileDigest);
    assert.equal(result.receipt.compliance, 'verified');
  } finally { clean(f); }
});

test('typed GSD delivery goes through the host-owned typed callback', async () => {
  const f = fixture();
  try {
    const actualPhaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    fs.mkdirSync(actualPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(actualPhaseDir, '38-01-PLAN.md'), '# baseline\n');
    fs.mkdirSync(f.storageRoot, { recursive: true });
    const phaseDir = path.join(f.storageRoot, 'phase-alias');
    fs.symlinkSync(actualPhaseDir, phaseDir, 'dir');
    assert.notEqual(path.resolve(phaseDir), fs.realpathSync(phaseDir));
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    const result = await delivery(f, { writerSession }).run({
      role: 'decomposition',
      gsd_role: 'gsd-planner',
      context: { prompt: 'Create the approved phase plan.' },
    });
    assert.equal(f.calls[0].method, 'typed');
    assert.equal(f.calls[0].selection.model, 'gpt-6.1-sol');
    assert.equal(f.calls[0].selection.reasoning_effort, 'high');
    assert.equal(result.receipt.gsd_launch_mechanism, 'typed-gsd-callback');
    assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
    lease.release(handle);
  } finally { clean(f); }
});

for (const [role, gsdRole] of [
  ['research', 'gsd-phase-researcher'],
  ['decomposition', 'gsd-planner'],
  ['decomposition', 'gsd-plan-checker'],
]) {
  test(`typed delivery CLI acquires and releases its own shared writer for ${gsdRole}`, async () => {
    const f = fixture();
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    const writerRoot = path.join(f.storageRoot, 'shared-writer');
    const requestFile = path.join(f.graphDir, `request-${gsdRole}.json`);
    try {
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing plan\n');
      fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Existing context\n');
      if (gsdRole === 'gsd-phase-researcher') {
        fs.writeFileSync(path.join(phaseDir, '38-RESEARCH.md'), '# Existing research\n');
      }
      fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role, gsd_role: gsdRole,
        context: { prompt: 'Complete the typed phase role.' } }));
      const result = await runCli(['--args-file', requestFile], { write() {} }, {
        ...cliOptions(f), testWriterStateRoot: writerRoot,
      });
      assert.equal(result.receipt.compliance, 'verified');
      assert.equal(result.receipt.gsd_role, gsdRole);
      assert.equal(f.calls.filter((call) => call.method === 'typed').length, 1);
      assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
      const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
      assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    } finally { clean(f); }
  });
}

for (const mode of ['valid-subset', 'omitted-old-plan', 'extra-edit', 'old-plan-tamper', 'missing-completion']) {
  test(`typed delivery CLI planner completion ${mode}`, async () => {
    const f = fixture();
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
    const writerRoot = path.join(f.storageRoot, 'shared-writer');
    const requestFile = path.join(f.graphDir, `planner-${mode}.json`);
    try {
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing first plan\n');
      fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Existing second plan\n');
      fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Existing context\n');
      fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role: 'decomposition',
        gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }));
      f.host.launchTypedGsd = (selection, context) => {
        f.calls.push({ method: 'typed', selection, context });
        fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Edited first plan\n');
        if (mode === 'omitted-old-plan') fs.rmSync(path.join(phaseDir, '38-02-PLAN.md'));
        if (mode === 'extra-edit') fs.writeFileSync(path.join(phaseDir, 'stray.md'), '# Unreported\n');
        if (mode !== 'missing-completion') {
          context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
            last_agent_message: JSON.stringify({ schema: 'shipyard.codex-decompose-output.v1',
              artifact_paths: ['.planning/phases/38-typed-delivery/38-01-PLAN.md'] }) });
        }
        if (mode === 'old-plan-tamper') fs.writeFileSync(path.join(phaseDir, '38-02-PLAN.md'), '# Late edit\n');
        return application(selection, context);
      };
      const run = runCli(['--args-file', requestFile], { write() {} }, {
        ...cliOptions(f), testWriterStateRoot: writerRoot,
      });
      if (mode === 'valid-subset') {
        const result = await run;
        assert.equal(result.receipt.compliance, 'verified');
        assert.ok(f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id));
        assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 1);
      } else {
        const code = mode === 'old-plan-tamper' ? 'FOREIGN_EDIT'
          : mode === 'missing-completion' ? 'WRITER_FENCED' : 'ARTIFACT_DECLARATION_INVALID';
        await assert.rejects(run, { code });
        assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
      }
      assert.equal(f.calls.filter((call) => call.method === 'typed').length, 1);
      const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
      assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    } finally { clean(f); }
  });
}

for (const ownerName of ['claude-decompose', 'codex-decompose']) {
test(`typed delivery CLI refuses a ${ownerName} shared writer before launch and reacquires after release`, async () => {
  const f = fixture();
  const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
  const writerRoot = path.join(f.storageRoot, 'shared-writer');
  const requestFile = path.join(f.graphDir, 'typed-overlap.json');
  try {
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Existing plan\n');
    fs.writeFileSync(requestFile, JSON.stringify({ scope: f.scope, role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }));
    const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
    const first = lease.acquire({ owner: ownerName, base_revision: f.base });
    const original = fs.readFileSync(lease.file, 'utf8');
    await assert.rejects(runCli(['--args-file', requestFile], { write() {} }, {
      ...cliOptions(f), testWriterStateRoot: writerRoot,
    }), { code: 'WRITER_LEASED' });
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(lease.file, 'utf8'), original);
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(first);
    const result = await runCli(['--args-file', requestFile], { write() {} }, {
      ...cliOptions(f), testWriterStateRoot: writerRoot,
    });
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
  } finally { clean(f); }
});
}

test('typed GSD delivery refuses a phase symlink escaping the scoped worktree', async () => {
  const f = fixture();
  try {
    const outsidePhaseDir = path.join(f.storageRoot, 'outside-phase');
    fs.mkdirSync(outsidePhaseDir, { recursive: true });
    const phaseDir = path.join(f.root, '.planning', 'phase-link');
    fs.symlinkSync(outsidePhaseDir, phaseDir, 'dir');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a different phase lease before recording', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '39-foreign');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-phase', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a lease keyed to a foreign directory', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-current');
    const foreignDir = path.join(f.root, '.planning', 'phases', '39-foreign');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    fs.mkdirSync(foreignDir, { recursive: true });
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir: foreignDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-lease', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    await assert.rejects(async () => delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a declaration unlike its completed native output', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-current');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'typed-output', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: lease.snapshotTree(), declaredPaths: [] };
    f.host.launchTypedGsd = (selection, context) => {
      context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
        last_agent_message: JSON.stringify({ schema: 'shipyard.codex-decompose-output.v1',
          artifact_paths: ['.planning/phases/38-current/CONTEXT.md'] }) });
      return application(selection, context);
    };
    await assert.rejects(delivery(f, { writerSession }).run({ role: 'decomposition',
      gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }), { code: 'ARTIFACT_DECLARATION_INVALID' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery refuses a snapshot from another phase', async () => {
  const f = fixture();
  try {
    const phaseDir = path.join(f.root, '.planning', 'phases', '38-current');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
    const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
      stateRoot: path.join(f.storageRoot, 'writer') });
    const handle = lease.acquire({ owner: 'foreign-snapshot', base_revision: f.base });
    const writerSession = { lease, handle, base_revision: f.base, phaseDir,
      snapshot: { ...lease.snapshotTree(), digests: { 'foreign.md': 'a'.repeat(64) } },
      declaredPaths: [] };
    await assert.rejects(Promise.resolve().then(() => delivery(f, { writerSession }).run({
      role: 'decomposition', gsd_role: 'gsd-planner', context: { prompt: 'Plan.' },
    })), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    lease.release(handle);
  } finally { clean(f); }
});

test('typed GSD delivery rejects request writer authority and a missing host lease', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'decomposition', gsd_role: 'gsd-planner',
      context: { prompt: 'Plan.', preRecordValidation: () => true } }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, 0);
    await assert.rejects(delivery(f).run({ role: 'decomposition', gsd_role: 'gsd-planner',
      context: { prompt: 'Plan.' } }), { code: 'WRITER_FENCED' });
    assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
  } finally { clean(f); }
});

test('typed GSD delivery checks host lease takeover and foreign edits before recording', async () => {
  for (const mode of ['takeover', 'foreign']) {
    const f = fixture();
    try {
      const phaseDir = path.join(f.root, '.planning', 'phases', '38-typed-delivery');
      fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# baseline\n');
      const lease = createPlanningWriterLease({ worktree: f.root, phaseDir,
        stateRoot: path.join(f.storageRoot, 'writer') });
      const handle = lease.acquire({ owner: 'typed-delivery', base_revision: f.base });
      const writerSession = { lease, handle, base_revision: f.base, phaseDir,
        snapshot: lease.snapshotTree(), declaredPaths: [] };
      f.host.launchTypedGsd = (selection, context) => {
        f.calls.push({ method: 'typed', selection, context });
        context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'typed-fixture-session',
          last_agent_message: JSON.stringify({ schema: 'shipyard.codex-decompose-output.v1', artifact_paths: [] }) });
        if (mode === 'takeover') { lease.release(handle); lease.acquire({ owner: 'new-owner', base_revision: f.base }); }
        else fs.writeFileSync(path.join(phaseDir, 'stray.md'), 'foreign');
        return application(selection, context);
      };
      await assert.rejects(delivery(f, { writerSession }).run({ role: 'decomposition',
        gsd_role: 'gsd-planner', context: { prompt: 'Plan.' } }),
      { code: mode === 'takeover' ? 'WRITER_FENCED' : 'FOREIGN_EDIT' });
      assert.equal(fs.readdirSync(f.host.recorder.storeDir).filter((name) => name.startsWith('record-')).length, 0);
    } finally { clean(f); }
  }
});

test('executor without a worktree delta fails closed before calling the signer', async () => {
  const f = fixture();
  let signerCalls = 0;
  f.host.launch = (selection, context) => application(selection, context);
  try {
    await assert.rejects(() => createCodexDeliveryHost({
      ...cliOptions(f), scope: { ...f.scope, worktree: fs.realpathSync(f.root) },
      finalizeCommit() { signerCalls++; throw new Error('should not sign'); },
    }).run({ role: 'executor', context: { prompt: 'Inspect only.' } }),
    (error) => error.code === 'NO_PUBLISHABLE_DELTA');
    assert.equal(signerCalls, 0);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('host finalizer refuses an out-of-scope delta without moving HEAD', async () => {
  const f = fixture();
  f.host.launch = (selection, context) => {
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'out of scope\n');
    return application(selection, context);
  };
  try {
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Make the change.' },
    }), /out-of-scope paths/);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('missing host signer refuses before launching the child', async () => {
  const f = fixture();
  try {
    git(f.root, 'config', '--unset', 'user.signingkey');
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Make the change.' },
    }), (error) => error.code === 'COMMIT_PREFLIGHT_FAILED' || error.code === 'SIGNER_UNAVAILABLE');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('CLI owns a durable run through signed artifact completion', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  const output = [];
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    const result = await runCli(['--args-file', file], { write: (chunk) => output.push(chunk) }, cliOptions(f));
    assert.equal(result.artifact.status, 'committed');
    assert.equal(JSON.parse(output.join('')).artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    const status = runStatus(f);
    assert.equal(status.state, 'completed');
    assert.equal(status.owner.status, 'completed');
    assert.equal(status.scope.repository.repository_id,
      'git-common:' + crypto.createHash('sha256').update(fs.realpathSync(path.join(f.root, '.git'))).digest('hex'));
    assert.ok(!status.scope.worktree.path.startsWith(f.storageRoot));
  } finally { clean(f); }
});

test('CLI heartbeats its out-of-worktree lease while a launch remains active', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  let during;
  f.host.launchStatic = async (selection, context) => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    during = runStatus(f);
    return application(selection, context);
  };
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'research', context: { prompt: 'Inspect.' },
    }));
    await runCli(['--args-file', file], { write() {} }, { ...cliOptions(f), heartbeatMs: 5 });
    assert.ok(during.owner.heartbeat_at > during.owner.acquired_at);
    assert.equal(runStatus(f).state, 'completed');
  } finally { clean(f); }
});

test('typed CLI renews its planning writer lease without changing ownership', async () => {
  const f = fixture();
  const phaseDir = path.join(f.root, '.planning', 'phases', '38-heartbeat');
  const writerRoot = path.join(f.storageRoot, 'heartbeat-' + crypto.randomUUID());
  const file = path.join(f.graphDir, 'request.json');
  let before;
  let after;
  try {
    fs.mkdirSync(phaseDir, { recursive: true });
    const lease = createPlanningWriterLease({ stateRoot: writerRoot, worktree: f.root, phaseDir });
    const launch = f.host.launchTypedGsd;
    f.host.launchTypedGsd = async function (selection, context) {
      before = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
      return launch.call(this, selection, context);
    };
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'decomposition', gsd_role: 'gsd-plan-checker',
      context: { prompt: 'Check the fixture plan.' },
    }));
    const result = await runCli(['--args-file', file], { write() {} }, {
      ...cliOptions(f), heartbeatMs: 5, testWriterStateRoot: writerRoot,
    });
    assert.ok(after.heartbeat_at > before.heartbeat_at);
    assert.ok(after.expires_at > before.expires_at);
    assert.equal(after.token, before.token);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.pid, before.pid);
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(JSON.parse(fs.readFileSync(lease.file, 'utf8')).status, 'released');
    assert.equal(runStatus(f).state, 'completed');
  } finally { clean(f); }
});

function inflightRows(graphDir) {
  try { return JSON.parse(fs.readFileSync(path.join(graphDir, 'dispatches.json'), 'utf8')).inflight || {}; }
  catch { return {}; }
}

for (const outcome of ['success', 'failure']) {
  test(`CLI holds a pid in-flight record during the run and clears it after ${outcome}`, async () => {
    const f = fixture();
    const file = path.join(f.graphDir, 'request.json');
    let during;
    f.host.launchStatic = async (selection, context) => {
      during = Object.values(inflightRows(f.graphDir));
      if (outcome === 'failure') throw new Error('stubbed runtime launch failed');
      return application(selection, context);
    };
    try {
      fs.writeFileSync(file, JSON.stringify({
        scope: f.scope, role: 'research', context: { prompt: 'Inspect.' },
      }));
      const running = runCli(['--args-file', file], { write() {} }, cliOptions(f));
      if (outcome === 'failure') await assert.rejects(() => running, /stubbed runtime launch failed/);
      else await running;
      assert.equal(during.length, 1);
      assert.equal(during[0].ticket, f.scope.ticket);
      assert.equal(during[0].pid, process.pid);
      assert.equal(during[0].host, 'codex');
      assert.deepEqual(inflightRows(f.graphDir), {});
    } finally { clean(f); }
  });
}

test('validateArgs accepts the canonical request and surfaces unknown keys and UNSUPPORTED_SIGNAL unchanged', () => {
  const valid = validateArgs({ role: 'executor', context: { prompt: 'Run.' } });
  assert.equal(valid.request.role, 'executor');
  assert.ok(valid.resolution.model);
  assert.throws(() => validateArgs({ role: 'executor', model: 'gpt-6-luna' }),
    (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateArgs({ role: 'research', signals: { type: 'implementation' } }),
    (error) => error.code === 'UNSUPPORTED_SIGNAL');
});

test('CLI records failed ownership when executor makes no publishable delta', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  f.host.launch = (selection, context) => application(selection, context);
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Inspect only.' },
    }));
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, cliOptions(f)),
      (error) => error.code === 'NO_PUBLISHABLE_DELTA');
    assert.equal(runStatus(f).state, 'failed');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('CLI rejects contradictory caller repository identity before starting a run', async () => {
  const f = fixture();
  const file = path.join(f.graphDir, 'request.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      scope: { ...f.scope, repository: 'caller-controlled-repository' },
      role: 'research', context: { prompt: 'Inspect.' },
    }));
    await assert.rejects(() => runCli(['--args-file', file], { write() {} }, cliOptions(f)),
      (error) => error.code === 'SCOPE_MISMATCH');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('scope, provider crossover, inherited selection, and stale static output refuse before launch', async () => {
  const f = fixture();
  try {
    const host = delivery(f);
    await assert.rejects(() => host.run({ role: 'executor', context: { prompt: 'Do work', model: 'gpt-6-sol' } }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
    await assert.rejects(() => host.run({ role: 'executor', model: 'gpt-6-luna', context: { prompt: 'Do work' } }),
      (error) => error.code === 'INVALID_INPUT');
    await assert.rejects(() => host.run({ role: 'executor', context: { prompt: 'Do work', sandbox_mode: 'read-only' } }),
      (error) => error.code === 'CONFLICTING_OVERRIDE');
    fs.appendFileSync(path.join(f.agentDir, f.file), '# changed after manifest\n');
    await assert.rejects(() => host.run({ role: 'research', context: { prompt: 'Inspect.' } }),
      (error) => error.code === 'STALE_GENERATED_AGENT');
    assert.equal(f.calls.length, 0);
    assert.throws(() => createCodexDeliveryHost({
      scope: { ...f.scope, provider: 'anthropic' }, host: f.host,
    }), (error) => error.code === 'RUNTIME_PROVIDER_MISMATCH');
  } finally { clean(f); }
});

test('CLI request parsing accepts only a bounded args file and explicit scope', () => {
  const f = fixture();
  const argsFile = path.join(f.root, 'request.json');
  try {
    assert.equal(parseCliArguments(['--args-file', argsFile]), argsFile);
    assert.throws(() => parseCliArguments(['--args-file', argsFile, '--role', 'executor']),
      (error) => error.code === 'INVALID_INPUT');
    fs.writeFileSync(argsFile, JSON.stringify({ scope: f.scope, role: 'executor', context: { prompt: 'Run.' } }));
    const parsed = readRequestFile(argsFile);
    assert.deepEqual(parsed.launch, { role: 'executor', signals: {}, context: { prompt: 'Run.' } });
    assert.throws(() => requestValue({ role: 'executor', model: 'gpt-6-luna' }),
      (error) => error.code === 'INVALID_INPUT');
  } finally { clean(f); }
});

test('spawning with bad argv exits 1, keeps the first stderr line, and appends a hint line', () => {
  const scriptPath = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.split('\n');
  assert.equal(lines[0], 'codex-delivery-host: codex-delivery-host: usage: codex-delivery-host.cjs --args-file <json>');
  assert.match(lines[1], /^hint\[INVALID_INPUT\]: /);
});

suite('codex-delivery-host — REQ-158 trusted finalization recovery');

test('completed executor work persists a private authenticated candidate before signed finalization', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    assert.equal(error.code, 'SIGNING_FAILED');
    assert.match(error.candidate_id, /^[0-9a-f]{64}$/);
    assert.deepEqual(error.gates.downstream, { ci: 'pending', review: 'pending' });
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    const file = candidatePath(f, error.candidate_id);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    const candidate = JSON.parse(raw).payload;
    assert.equal(candidate.ticket, 'T-38-04');
    assert.equal(candidate.expected_head, f.base);
    assert.equal(candidate.signer, signer);
    assert.equal(candidate.plan_path, '.planning/PLAN.md');
    assert.match(candidate.receipt_sha256, /^[0-9a-f]{64}$/);
    assert.match(candidate.scoped_tree, /^[0-9a-f]{40}$/);
    assert.equal(candidate.gates.pre_commit, 'passed');
    assert.deepEqual(candidate.gates.downstream, { ci: 'pending', review: 'pending' });
    assert.equal(candidate.verification.records[0].outcome, 'passed');
    const key = fs.readFileSync(path.join(stateRoot(f), 'finalization-authority', 'hmac.key'));
    assert.ok(!raw.includes(key.toString('hex')));
    assert.ok(!fs.realpathSync(file).startsWith(fs.realpathSync(f.root)));
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('recovery resumes the unchanged candidate without an executor launch and repeats idempotently', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const scope = liveScope(f);
    const first = await recovery(f).resumeFinalization(error.candidate_id, scope);
    assert.equal(first.status, 'committed');
    assert.equal(first.idempotent, false);
    assert.equal(first.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assert.equal(git(f.root, 'rev-parse', 'HEAD^{tree}'), first.artifact.tree);
    assert.deepEqual(first.artifact.gates.downstream, { ci: 'pending', review: 'pending' });
    const second = await recovery(f).resumeFinalization(error.candidate_id, scope);
    assert.equal(second.idempotent, true);
    assert.equal(second.artifact.commit, first.artifact.commit);
    assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '2');
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('executor and recovery use the live board base after the recorded primary parent is merged', async () => {
  const f = fixture();
  try {
    configureMergedParentBase(f);
    assert.equal(spawnSync('git', ['-C', f.root, 'show-ref', '--verify', '--hash',
      'refs/heads/ticket/T-38-03-merged-parent'], { encoding: 'utf8' }).status !== 0, true);
    const error = await failedFinalization(f);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8')).payload;
    assert.equal(candidate.base_ref, 'main');
    assert.equal(candidate.expected_base, f.base);
    const result = await recovery(f).resumeFinalization(error.candidate_id, liveScope(f));
    assert.equal(result.status, 'committed');
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
  } finally { clean(f); }
});

test('executor refuses a changed live base that is not justified by a merged parent', async () => {
  const f = fixture();
  try {
    configureMergedParentBase(f);
    const boardFile = path.join(f.graphDir, 'delivery-state.json');
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    board['T-38-03'].status = 'pr-open';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    await assert.rejects(() => delivery(f).run({ role: 'executor', dispatch_id: 'unproved-live-base',
      context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => error.code === 'BASE_MISMATCH' && /neither its open primary parent nor its merged destination/.test(error.message));
    assert.equal(f.calls.length, 0, 'the executor must not launch on an unproved base');
  } finally { clean(f); }
});

test('verification failures, missing specs and tree-changing checks refuse before any candidate', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f, { verification: undefined }).run({
      role: 'executor', context: { prompt: 'Implement.' } }), (error) => error.code === 'VERIFICATION_SPEC_MISSING');
    assert.equal(f.calls.length, 0);
    let signed = 0;
    const failing = { commands: [{ ...f.verification.commands[0], argv: ['-e', 'process.exit(4)'] }] };
    await assert.rejects(() => delivery(f, { verification: failing, finalizeCommit() { signed++; } }).run({
      role: 'executor', context: { prompt: 'Implement.' } }),
    (error) => error.code === 'VERIFICATION_FAILED' && /failed unit/.test(error.message)
      && error.gates.downstream.ci === 'pending');
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'base\n');
    const mutating = { commands: [{ ...f.verification.commands[0], argv: ['-e',
      "require('fs').writeFileSync('src/owned.txt', 'verification rewrote it\\n')"] }] };
    await assert.rejects(() => delivery(f, { verification: mutating, finalizeCommit() { signed++; } }).run({
      role: 'executor', context: { prompt: 'Implement.' } }),
    (error) => error.code === 'VERIFICATION_FAILED' && /changed scoped tree/.test(error.message));
    assert.equal(signed, 0);
    assert.equal(fs.existsSync(path.join(stateRoot(f), 'candidates'))
      ? fs.readdirSync(path.join(stateRoot(f), 'candidates')).length : 0, 0);
  } finally { clean(f); }
});

test('Codex host verification refuses an admitted failure without finalizing', async () => {
  const f = fixture();
  let finalized = 0;
  try {
    approvedPlan(f, ['node check.cjs']);
    const result = await delivery(f, { verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() { return { status: 3, stdout: '', stderr: 'failed', backend: { kind: 'host' } }; } },
      finalizeCommit() { finalized++; },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } });
    assert.equal(result.status, 'verification_failed');
    assert.deepEqual(result.command, ['node', 'check.cjs']);
    assert.match(result.evidence_digest, /^[0-9a-f]{64}$/);
    assert.equal(result.retryable, true);
    assert.deepEqual(result.receipt, f.host.recorder.getVerifiedRecord(result.receipt.dispatch_id).receipt);
    assert.equal(finalized, 0);
  } finally { clean(f); }
});

test('Codex host verification passes sealed evidence digest to trusted finalizer', async () => {
  const f = fixture();
  let digest;
  let coverage;
  try {
    approvedPlan(f, ['node check.cjs']);
    await assert.rejects(() => delivery(f, { verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() { return { status: 0, stdout: '', stderr: '', backend: { kind: 'host' } }; } },
      finalizeCommit(input) { digest = input.verificationEvidenceDigest; coverage = input.coverage;
        throw new Error('stop after evidence'); },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } }), /stop after evidence/);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(coverage.kind, 'executor');
    assert.match(coverage.dispatch_id, /^dispatch-/);
    assert.match(coverage.receipt_digest, /^[0-9a-f]{64}$/);
    assert.equal(coverage.verification_digest, digest);
    assert.equal(coverage.receipt_store, f.host.recorder.storeDir);
  } finally { clean(f); }
});

test('Codex retries one failed plan command with sealed diagnostics and binds the passing digest', async () => {
  const f = fixture();
  const controllerOwner = 'verification-retry-owner';
  const controller = createRunController({ storeDir: path.join(f.storageRoot, 'retry-controller'), ownerId: controllerOwner });
  controller.begin(createRunScope({
    run_id: f.scope.run_id, repository_id: 'shipyard/test', phase: f.scope.phase,
    ticket: f.scope.ticket, worktree: f.root, runtime: 'codex', provider: 'openai',
    owner_id: controllerOwner,
    dispatch: { dispatch_id: 'verification-retry-initial', role: 'executor', model: 'gpt-6.1-sol', effort: 'low' },
  }));
  let checks = 0;
  try {
    approvedPlan(f, ['node check.cjs']);
    const launch = f.host.launch.bind(f.host);
    f.host.launch = (selection, context) => ({ ...launch(selection, context), launch_id: `codex-delivery-${f.calls.length}` });
    const result = await delivery(f, {
      controller,
      verification: undefined,
      verificationAllowList: [{ argv: ['node', 'check.cjs'], profile: 'host' }],
      hostVerificationRunner: { run() {
        checks++;
        return { status: checks === 1 ? 7 : 0, stdout: '', stderr: checks === 1 ? 'failed' : '', backend: { kind: 'host' } };
      } },
    }).run({ role: 'executor', dispatch_id: 'verification-retry-initial', context: { prompt: 'Implement.' } });
    assert.equal(result.artifact.status, 'committed');
    assert.equal(checks, 2);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.match(call.context.prompt, /Do not run or retry the host-assigned commands in the sandbox/);
      assert.deepEqual(call.context.verification_assignment.commands[0].argv, ['node', 'check.cjs']);
      assert.equal(call.context.verification_assignment.commands[0].profile, 'host');
      assert.equal(call.context.verification_assignment.expected_head, f.base);
    }
    assert.deepEqual(f.calls[1].context.verification_assignment, f.calls[0].context.verification_assignment);
    assert.match(f.calls[1].context.prompt, /<HOST-VERIFICATION-FAILURE>/);
    assert.match(f.calls[1].context.prompt, /"attempt":1/);
    assert.equal(controller.status(f.scope.run_id).retry.attempts, 1);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, result.artifact.candidate_id), 'utf8')).payload;
    assert.match(candidate.verification.allow_list_sha256, /^[0-9a-f]{64}$/);
    assert.match(git(f.root, 'show', '-s', '--format=%B', 'HEAD'),
      new RegExp(`Shipyard-Verification-Evidence: ${candidate.verification.evidence_digest}`));
  } finally { clean(f); }
});

test('changed tree, graph, base, plan, verification or receipt refuses and keeps the candidate visible', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const id = error.candidate_id;
    const refused = async (expected, overrides = {}) => {
      await assert.rejects(() => recovery(f, overrides).resumeFinalization(id, liveScope(f)),
        (refusal) => refusal.code === expected.code && expected.names.every((name) => refusal.invalidated.includes(name))
          && refusal.gates.downstream.review === 'pending');
    };
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'edited after verification\n');
    await refused({ code: 'IDENTITY_CHANGED', names: ['tree'] });
    fs.writeFileSync(path.join(f.root, 'src', 'owned.txt'), 'changed\n');
    const graphFile = path.join(f.graphDir, 'tickets.json');
    const graph = fs.readFileSync(graphFile, 'utf8');
    fs.writeFileSync(graphFile, graph.replace('"pr_base"', '"note":"x","pr_base"'));
    await refused({ code: 'IDENTITY_CHANGED', names: ['graph'] });
    fs.writeFileSync(graphFile, graph);
    const plan = fs.readFileSync(f.plan);
    fs.appendFileSync(f.plan, 'amended\n');
    await refused({ code: 'IDENTITY_CHANGED', names: ['plan'] });
    fs.writeFileSync(f.plan, plan);
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification-spec'],
    }, { verification: { commands: [{ ...f.verification.commands[0], argv: ['-e', '1'] }] } });
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification-allow-list'] },
      { verificationAllowList: [] });
    const records = path.join(stateRoot(f), 'verification');
    const pinned = JSON.parse(fs.readFileSync(candidatePath(f, id), 'utf8')).payload.verification.records[0];
    const recordFile = path.join(records, pinned.record_sha256 + '.json');
    const original = fs.readFileSync(recordFile, 'utf8');
    fs.writeFileSync(recordFile, original.replace('"outcome":"passed"', '"outcome":"failed"'));
    await refused({ code: 'IDENTITY_CHANGED', names: ['verification:unit'] });
    fs.writeFileSync(recordFile, original);
    await refused({ code: 'MISSING_RECEIPT', names: ['receipt'] },
      { recorder: createDurableRecorder(fs.mkdtempSync(path.join(temporary, 'empty-receipts-'))) });
    git(f.root, 'stash', 'push', '-q', '-m', 'req158-base-move');
    git(f.root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(f.root, 'outside.txt'), 'moved base\n');
    git(f.root, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'move base');
    git(f.root, 'checkout', '-q', 'ticket/T-38-04');
    git(f.root, 'stash', 'pop', '-q');
    await refused({ code: 'IDENTITY_CHANGED', names: ['base'] });
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    assert.ok(fs.existsSync(candidatePath(f, id)));
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('tampered candidate and wrong scope refuse; commit without a finalization record needs reconciliation', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const id = error.candidate_id;
    await assert.rejects(() => recovery(f).resumeFinalization(id, { ...liveScope(f), ticket: 'T-38-05' }),
      (refusal) => refusal.code === 'IDENTITY_CHANGED' && refusal.invalidated.includes('ticket'));
    const file = candidatePath(f, id);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace(f.base, '0'.repeat(40)));
    await assert.rejects(() => recovery(f).resumeFinalization(id, liveScope(f)),
      (refusal) => refusal.code === 'STATE_RECORD_INVALID');
    fs.writeFileSync(file, original);
    await assert.rejects(() => recovery(f).resumeFinalization('f'.repeat(64), liveScope(f)),
      (refusal) => refusal.code === 'CANDIDATE_MISSING');
    const candidate = JSON.parse(original).payload;
    const receiptStore = f.host.recorder.storeDir;
    finalizeCommit({ ticket: candidate.ticket, worktree: candidate.worktree, expectedBranch: candidate.branch,
      expectedBase: candidate.expected_base, expectedHead: candidate.expected_head, expectedSigner: signer,
      files_modified: candidate.files_modified, expectedTree: candidate.scoped_tree,
      verificationEvidenceDigest: candidate.verification.evidence_digest,
      coverage: { kind: 'executor', repo: candidate.repo, dispatch_id: candidate.dispatch_id,
        receipt_digest: candidate.receipt_sha256, verification_digest: candidate.verification.evidence_digest,
        receipt_store: receiptStore } });
    const head = git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(() => recovery(f).resumeFinalization(id, liveScope(f)),
      (refusal) => refusal.code === 'RECONCILIATION_REQUIRED');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  } finally { clean(f); }
});

test('recovery-only CLI returns the signed artifact with zero executor launches and a bounded scope file', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const launchesBefore = f.calls.length;
    const scopeFile = path.join(f.graphDir, 'recovery-scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify({ ...liveScope(f), role: 'executor' }));
    assert.throws(() => readResumeScope(scopeFile), (refusal) => refusal.code === 'INVALID_INPUT');
    for (const field of ['prompt', 'dispatch_id', 'verification', 'candidate_path', 'gates']) {
      fs.writeFileSync(scopeFile, JSON.stringify({ ...liveScope(f), [field]: 'x' }));
      assert.throws(() => readResumeScope(scopeFile), (refusal) => refusal.code === 'INVALID_INPUT');
    }
    assert.throws(() => parseResumeArguments(['--resume-finalization', error.candidate_id, '--scope-file', scopeFile, '--role', 'executor']),
      (refusal) => refusal.code === 'INVALID_INPUT');
    assert.throws(() => parseResumeArguments(['--resume-finalization', 'not-an-id', '--scope-file', scopeFile]),
      (refusal) => refusal.code === 'INVALID_INPUT');
    const recoveryScope = liveScope(f);
    fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
    const candidateBytes = fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8');
    const output = [];
    const result = await runCli(['--resume-finalization', error.candidate_id, '--scope-file', scopeFile],
      { write: (chunk) => output.push(chunk) }, {
        storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, verification: f.verification,
        recorder: f.host.recorder,
      });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(JSON.parse(output.join('')).artifact.candidate_id, error.candidate_id);
    assertRecoveryPolicy(f, error.candidate_id, recoveryScope);
    assert.equal(fs.readFileSync(candidatePath(f, error.candidate_id), 'utf8'), candidateBytes);
    assert.equal(f.calls.length, launchesBefore);
  } finally { clean(f); }
});

test('recovery CLI derives a legacy candidate version only from bound authenticated authority and refuses conflicts', async () => {
  for (const variant of ['legacy', 'conflict', 'null', 'missing-authority', 'historical']) {
    const f = fixture();
    try {
      const error = await failedFinalization(f);
      const id = resealCandidate(f, error.candidate_id, (candidate) => {
        if (variant === 'legacy') delete candidate.policy_version;
        if (variant === 'conflict') candidate.policy_version = 'adr-014.v6';
        if (variant === 'null') candidate.policy_version = null;
      });
      const scope = liveScope(f);
      const file = path.join(f.graphDir, 'recovery-scope.json');
      fs.writeFileSync(file, JSON.stringify(scope));
      const before = fs.readFileSync(candidatePath(f, id), 'utf8');
      let recorder = f.host.recorder;
      if (variant === 'missing-authority') recorder = { getVerifiedRecord(dispatchId) {
        const record = structuredClone(f.host.recorder.getVerifiedRecord(dispatchId));
        delete record.policy_version;
        delete record.resolution.policy_version;
        delete record.receipt.policy_version;
        return record;
      } };
      const action = () => runCli(['--resume-finalization', id, '--scope-file', file], { write() {} },
        { storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, verification: f.verification, recorder });
      if (variant === 'historical') {
        const candidate = JSON.parse(before).payload;
        const record = structuredClone(f.host.recorder.getVerifiedRecord(candidate.dispatch_id));
        const hash = '30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968';
        record.policy_version = record.resolution.policy_version = 'adr-014.v6';
        record.policy_hash = record.resolution.policy_hash = record.receipt.policy_hash = hash;
        record.receipt.compliance_proof.policy_hash = hash;
        if (Object.hasOwn(record.receipt, 'policy_version')) record.receipt.policy_version = 'adr-014.v6';
        const sorted = (value) => Array.isArray(value) ? value.map(sorted)
          : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
        const historicalId = resealCandidate(f, id, (value) => {
          value.policy_version = 'adr-014.v6';
          value.policy_hash = hash;
          value.receipt_sha256 = crypto.createHash('sha256').update(JSON.stringify(sorted(record.receipt))).digest('hex');
        });
        await assert.rejects(() => recovery(f, { recorder: { getVerifiedRecord() { return record; } } })
          .resumeFinalization(historicalId, scope), (error) => error.code === 'IDENTITY_CHANGED' && error.invalidated.includes('policy'));
      } else if (variant === 'legacy') {
        await action();
        assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
      } else {
        await assert.rejects(action, (error) => error.code === (variant === 'missing-authority' ? 'MISSING_RECEIPT' : 'IDENTITY_CHANGED'));
        assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
      }
      assert.equal(fs.readFileSync(candidatePath(f, id), 'utf8'), before);
      assert.equal(f.calls.length, 1);
    } finally { clean(f); }
  }
});

test('CLI pins verification from the approved PLAN when no spec is injected', async () => {
  const f = fixture();
  const spy = [];
  const file = path.join(f.graphDir, 'request.json');
  try {
    approvedPlan(f, ['node --version']);
    fs.writeFileSync(file, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    const { verification: _unused, ...options } = cliOptions(f);
    const result = await runCli(['--args-file', file], { write() {} }, { ...options, verificationRunner: hostRunner(spy) });
    assert.equal(result.artifact.status, 'committed');
    assert.deepEqual(spy.map((spec) => [spec.id, spec.executable, spec.argv]), [['plan-1', process.execPath, ['--version']]]);
    const candidate = JSON.parse(fs.readFileSync(candidatePath(f, result.artifact.candidate_id), 'utf8')).payload;
    assert.deepEqual(candidate.verification.required, ['plan-1']);
  } finally { clean(f); }
});

test('CLI holds an unmatched PLAN command before executor launch and does not retry it', async () => {
  const f = fixture();
  const requestFile = path.join(f.graphDir, 'request-empty-allow-list.json');
  const output = [];
  try {
    approvedPlan(f, ['node check.cjs']);
    fs.writeFileSync(requestFile, JSON.stringify({
      scope: f.scope, role: 'executor', context: { prompt: 'Implement scoped work.' },
    }));
    await assert.rejects(() => runCli(['--args-file', requestFile], { write(chunk) { output.push(chunk); } }, {
      ...cliOptions(f), verification: undefined, verificationAllowList: [],
      hostVerificationRunner: { run() { assert.fail('an empty allow-list must not launch a command'); } },
    }), (error) => error.code === 'VERIFICATION_FAILED' && error.status === 'hold'
      && error.command.join(' ') === 'node check.cjs' && error.retryable === false);
    assert.equal(runStatus(f).state, 'failed');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(output, [], 'a pre-dispatch HOLD must not fabricate executor or assertion evidence');
  } finally { clean(f); }
});

test('verification failure reason safely handles an absent command', () => {
  assert.match(verificationFailureReason({ command: null, summary: 'no command matched' }),
    /no allow-listed verification command matched/);
});

test('Codex retry diagnostic remains within its byte limit for oversized Unicode evidence', () => {
  const diagnostic = verificationFailureContext({
    command: Array(64).fill('💥'.repeat(256)), evidence_digest: 'a'.repeat(64), summary: '⚠'.repeat(500),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') <= 2048);
  assert.equal(diagnostic.attempt, 1);
  assert.equal(Object.isFrozen(diagnostic.command), true);
});

test('recovery-only CLI reuses the PLAN-pinned verification spec without an injected spec', async () => {
  const f = fixture();
  try {
    approvedPlan(f, ['node --version']);
    let captured;
    await assert.rejects(() => delivery(f, { verification: undefined,
      finalizeCommit() { throw Object.assign(new Error('gpg: signing failed'), { code: 'SIGNING_FAILED' }); },
    }).run({ role: 'executor', context: { prompt: 'Implement the scoped ticket.' } }),
    (error) => { captured = error; return error.code === 'SIGNING_FAILED'; });
    const scopeFile = path.join(f.graphDir, 'recovery-scope.json');
    const recoveryScope = liveScope(f);
    fs.writeFileSync(scopeFile, JSON.stringify(recoveryScope));
    const result = await runCli(['--resume-finalization', captured.candidate_id, '--scope-file', scopeFile], { write() {} },
      { storageRoot: f.storageRoot, graphDir: f.graphDir, finalizeCommit, recorder: f.host.recorder });
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(git(f.root, 'rev-parse', 'HEAD^'), f.base);
    assertRecoveryPolicy(f, captured.candidate_id, recoveryScope);
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

test('PLAN verification with shell syntax or a non-allowlisted bare program refuses before launch', async () => {
  for (const command of ['node a.cjs && rm -rf x', 'sh test.sh', 'npm test', 'bash -c "true"']) {
    const f = fixture();
    try {
      approvedPlan(f, [command]);
      await assert.rejects(() => delivery(f, { verification: undefined }).run({
        role: 'executor', context: { prompt: 'Implement.' } }),
      (error) => /^(sh|npm)\s/.test(command)
        ? error.code === 'VERIFICATION_FAILED' && error.status === 'hold'
        : error.code === 'VERIFICATION_SPEC_UNSUPPORTED');
      assert.equal(f.calls.length, 0);
    } finally { clean(f); }
  }
});

test('PLAN verification resolves bash and make bullets to fixed absolute executables with unchanged argv', async () => {
  const f = fixture();
  const spy = [];
  try {
    approvedPlan(f, ['bash tests/smoke/x.sh', 'bash -n x.sh', 'make test-docs']);
    await assert.rejects(() => delivery(f, { verification: undefined,
      verificationRunner: { run(spec) { spy.push(spec); return { status: 0 }; } },
      finalizeCommit() { throw new Error('stop after pinned executable verification'); },
    }).run({ role: 'executor', context: { prompt: 'Implement.' } }), /stop after pinned executable verification/);
    const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) => fs.existsSync(candidate));
    const make = ['/usr/bin/make', '/bin/make'].find((candidate) => fs.existsSync(candidate));
    assert.deepEqual(spy.map((spec) => [spec.executable, spec.argv]), [
      [bash, ['tests/smoke/x.sh']],
      [bash, ['-n', 'x.sh']],
      [make, ['test-docs']],
    ]);
  } finally { clean(f); }
});

test('recovery takes over a stale fence left by a dead holder and refuses a live one', async () => {
  const f = fixture();
  try {
    const error = await failedFinalization(f);
    const lockPath = path.join(stateRoot(f), 'recovery', error.candidate_id + '.lock');
    const hold = (at) => {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, label: 'crashed', at, token: 'dead' }));
    };
    hold(new Date().toISOString());
    await assert.rejects(() => recovery(f).resumeFinalization(error.candidate_id, liveScope(f)),
      (refusal) => refusal.code === 'RECOVERY_IN_PROGRESS' && refusal.gates.downstream.ci === 'pending');
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
    hold(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    const result = await recovery(f).resumeFinalization(error.candidate_id, liveScope(f));
    assert.equal(result.artifact.commit, git(f.root, 'rev-parse', 'HEAD'));
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(f.calls.length, 1);
  } finally { clean(f); }
});

suite('codex-delivery-host — T-40-12 investigation research consumer');

function baseInvestigation(f, overrides = {}) {
  return {
    invId: 'INV-100',
    sourceRevision: f.base,
    repository: 'acme/shipyard',
    policyHash: policy.resolveDispatch({ runtime: 'codex', role: 'research' }).policy_hash,
    lines: ['system-state', 'alternatives', 'constraints', 'risks'].map((id) => ({ id, signals: {} })),
    ...overrides,
  };
}

function researchLaunchStub(f, { skip = new Set(), rogueWrite } = {}) {
  return (selection, context) => {
    f.calls.push({ method: 'static', selection, context });
    if (rogueWrite && context.research_line === rogueWrite.line) {
      fs.writeFileSync(rogueWrite.path, rogueWrite.content || 'rogue write\n');
    } else if (!skip.has(context.research_line)) {
      fs.writeFileSync(context.artifactPath, `# ${context.research_line}\n\nfinding for ${context.research_line}\n`);
    }
    const bytes = Buffer.from(`# ${context.research_line}\n\nfinding for ${context.research_line}\n`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    context.onCompleted({ launch_id: 'codex-delivery-test', session_id: 'research-fixture-session',
      last_agent_message: JSON.stringify({ id: context.research_line, status: 'completed',
        summary: 'Research line completed.', artifact: { path: context.artifactPath,
          bytes: bytes.length, content_bytes: bytes.length, sha256: digest, digest } }) });
    return application(selection, context);
  };
}

test('a clean four-line investigation run seals every line through the shared sealer', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({
      role: 'research', context: { prompt: 'Investigate the scoped topic.', investigation },
    });
    assert.deepEqual(result.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
    for (const entry of result) {
      assert.equal(entry.schema, 'shipyard.role-artifact.v1');
      assert.equal(entry.envelope.schema, 'shipyard.research-result.v1');
      assert.equal(entry.envelope.subject, `INV-100:${entry.id}`);
      assert.equal(entry.envelope.status, 'completed');
      assert.equal(entry.envelope.source_revision, f.base);
      assert.equal(entry.envelope.repository, 'acme/shipyard');
      assert.equal(entry.envelope.policy_hash, investigation.policyHash);
      assert.match(entry.artifact_digest, /^[a-f0-9]{64}$/);
      assert.ok(fs.existsSync(entry.artifact_index.path));
    }
    assert.equal(f.calls.length, 4);
  } finally { clean(f); }
});

test('a line writing outside its artifact refuses CONTAINMENT_VIOLATION naming the line', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f, {
      rogueWrite: { line: 'alternatives', path: path.join(f.root, 'outside.txt') },
    });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'alternatives');
    assert.equal(result.code, 'CONTAINMENT_VIOLATION');
    assert.deepEqual(result.sealed_lines.map((entry) => entry.id).sort(), ['constraints', 'risks', 'system-state']);
  } finally { clean(f); }
});

test('a missing artifact names the line and RESEARCH_LINE_MISSING', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f, { skip: new Set(['risks']) });
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'risks');
    assert.equal(result.code, 'RESEARCH_LINE_MISSING');
    assert.equal(result.sealed_lines.length, 3);
  } finally { clean(f); }
});

test('a request with a ticket type value in signals is still refused by the boundary (Pitfall 1 guard)', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f, {
      lines: [
        { id: 'system-state', signals: { type: 'implementation' } },
        { id: 'alternatives', signals: {} },
        { id: 'constraints', signals: {} },
        { id: 'risks', signals: {} },
      ],
    });
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failed_line, 'system-state');
    assert.equal(result.code, 'UNSUPPORTED_SIGNAL');
    assert.equal(result.sealed_lines.length, 0);
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a single-line re-dispatch launches only the failed line and leaves its sealed siblings unchanged', async () => {
  const f = fixture();
  try {
    const skip = new Set(['alternatives']);
    f.host.launchStatic = researchLaunchStub(f, { skip });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const failure = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(failure.status, 'blocked');
    assert.equal(failure.failed_line, 'alternatives');
    assert.equal(failure.code, 'RESEARCH_LINE_MISSING');
    assert.equal(failure.sealed_lines.length, 3);
    const digestsBefore = Object.fromEntries(failure.sealed_lines.map((entry) => [entry.id, entry.artifact_digest]));

    skip.delete('alternatives');
    const callsBefore = f.calls.length;
    const redispatch = await delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: investigation.repository, policyHash: investigation.policyHash,
          lines: [{ id: 'alternatives', signals: {} }],
          sealedLines: failure.sealed_lines,
        },
      },
    });
    assert.equal(f.calls.length, callsBefore + 1);
    assert.deepEqual(redispatch.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
    for (const id of ['system-state', 'constraints', 'risks']) {
      assert.equal(redispatch.find((entry) => entry.id === id).artifact_digest, digestsBefore[id]);
    }
    assert.equal(redispatch.find((entry) => entry.id === 'alternatives').envelope.status, 'completed');
  } finally { clean(f); }
});

test('a re-dispatch verifies siblings sealed under the older owner/repo form with the physical repository identity', async () => {
  const f = fixture();
  try {
    git(f.root, 'remote', 'add', 'origin', 'https://github.com/Acme/Shipyard.git');
    f.host.launchStatic = researchLaunchStub(f, { skip: new Set(['alternatives']) });
    const investigation = baseInvestigation(f, {
      lines: ['system-state', 'constraints', 'risks', 'alternatives'].map((id) => ({ id, signals: {} })),
    });
    const failure = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    assert.equal(failure.sealed_lines.length, 3);
    f.host.launchStatic = researchLaunchStub(f);
    const redispatch = await delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: fs.realpathSync(path.join(f.root, '.git')), policyHash: investigation.policyHash,
          lines: [{ id: 'alternatives', signals: {} }],
          sealedLines: failure.sealed_lines,
        },
      },
    });
    assert.deepEqual(redispatch.map((entry) => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
  } finally { clean(f); }
});

test('a single-line request whose sibling artifact is missing refuses naming the sibling', async () => {
  const f = fixture();
  try {
    f.host.launchStatic = researchLaunchStub(f);
    const investigation = baseInvestigation(f);
    const result = await delivery(f).run({ role: 'research', context: { prompt: 'Investigate.', investigation } });
    const broken = result.find((entry) => entry.id === 'alternatives');
    fs.rmSync(broken.artifact_ref);
    const siblings = result.filter((entry) => entry.id !== 'system-state');

    await assert.rejects(() => delivery(f).run({
      role: 'research',
      context: {
        prompt: 'Investigate.',
        investigation: {
          invId: investigation.invId, sourceRevision: investigation.sourceRevision,
          repository: investigation.repository, policyHash: investigation.policyHash,
          lines: [{ id: 'system-state', signals: {} }],
          sealedLines: siblings,
        },
      },
    }), (error) => error.code === 'RESEARCH_VERIFY_MANIFEST_MISSING' && error.message.includes('alternatives'));
  } finally { clean(f); }
});

suite('codex-delivery-host — T-40-28 plan delivery (D-43)');

function ticketWorktreeFixture(role) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-inworktree-'));
  const agentDir = fs.mkdtempSync(path.join(temporary, 'agents-'));
  const planRel = '.planning/phases/x/X-PLAN.md';
  fs.mkdirSync(path.join(root, '.planning', 'phases', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, planRel), '# plan\n\n## Context (Reads)\n\n- nothing planning-shaped here.\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'owned.txt'), 'base\n');
  fs.mkdirSync(path.join(root, '.planning', 'graph'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Delivery Test');
  git(root, 'config', 'user.email', 'delivery@example.test');
  fs.writeFileSync(path.join(root, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {
    'T-38-04': { branch: 'main', pr_base: 'main', plan: planRel, files: ['src/owned.txt'] },
  } }));
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const agentManifest = agentManifestFor(agentDir, role);
  const scope = {
    run_id: 'run-codex-inworktree', ticket: 'T-38-04', phase: 38,
    worktree: root, runtime: 'codex', provider: 'openai',
  };
  const calls = [];
  const host = {
    scope,
    capabilities,
    recorder: createDurableRecorder(fs.mkdtempSync(path.join(temporary, 'receipts-'))),
    launchStatic(selection, context) { calls.push({ method: 'static', selection, context }); return application(selection, context); },
  };
  return { root, agentDir, agentManifest, scope, host, calls, planRel };
}

function withoutShipyardGraphDirEnv(action) {
  return withGraphDirEnv(undefined, action);
}

test('requestValue accepts context.plan_sha256 and rejects every other plan* context field', () => {
  requestValue({ role: 'drift-check', context: { prompt: 'hi', plan_sha256: '0'.repeat(64) } });
  for (const bad of [{ plan_path: '/x' }, { plan: 'x' }, { plan_content: 'x' }]) {
    assert.throws(() => requestValue({ role: 'drift-check', context: { prompt: 'hi', ...bad } }),
      (error) => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => requestValue({ role: 'drift-check', context: { prompt: 'hi', plan_sha256: 'not-hex' } }),
    (error) => error.code === 'INVALID_INPUT');
});

test('a Shipyard-shaped worktree (graph tracked at HEAD, no flag or env) leaves the drift-check prompt unchanged', () =>
  withoutShipyardGraphDirEnv(async () => {
    const f = ticketWorktreeFixture('drift-check');
    try {
      await createCodexDeliveryHost({
        scope: f.scope, host: f.host, capabilities, agentDir: f.agentDir, agentManifest: f.agentManifest,
        storageRoot: fs.mkdtempSync(path.join(temporary, 'storage-')), env: {},
      }).run({ role: 'drift-check', context: { prompt: 'Judge this ticket.' } });
      assert.equal(f.calls[0].context.prompt, 'Judge this ticket.');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }));

test('review-fix caller prompts cannot acquire canonical host repair authority', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'review-fix', context: { prompt: 'Fix the review.' } }),
      error => error.code === 'REPAIR_SUBJECT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a wrong context.plan_sha256 refuses PLAN_DIGEST_MISMATCH for a ticket-delivery role', async () => {
  const f = fixture();
  const agentDir = fs.mkdtempSync(path.join(temporary, 'agents-'));
  const agentManifest = agentManifestFor(agentDir, 'ci-fix');
  try {
    await assert.rejects(() => delivery(f, { agentDir, agentManifest }).run({
      role: 'ci-fix', context: { prompt: 'Fix CI.', plan_sha256: '0'.repeat(64) },
    }), (error) => error.code === 'PLAN_DIGEST_MISMATCH');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('a wrong context.plan_sha256 refuses PLAN_DIGEST_MISMATCH for the executor before the signer runs', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f).run({
      role: 'executor', context: { prompt: 'Implement.', plan_sha256: '0'.repeat(64) },
    }), (error) => error.code === 'PLAN_DIGEST_MISMATCH');
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.base);
  } finally { clean(f); }
});

test('SHIPYARD_GRAPH_DIR pointing at an untracked graph copy in a non-main worktree refuses GRAPH_NOT_CANONICAL', () =>
  withoutShipyardGraphDirEnv(async () => {
    const f = ticketWorktreeFixture('drift-check');
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codex-other-repo-'));
    try {
      git(otherRepo, 'init', '-q', '-b', 'main');
      git(otherRepo, 'config', 'user.name', 'Delivery Test');
      git(otherRepo, 'config', 'user.email', 'delivery@example.test');
      fs.writeFileSync(path.join(otherRepo, 'README.md'), 'x\n');
      git(otherRepo, 'add', '.');
      git(otherRepo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
      git(otherRepo, 'branch', 'other');
      const linked = path.join(otherRepo, '..', 'shipyard-codex-other-linked');
      git(otherRepo, 'worktree', 'add', '-q', linked, 'other');
      const copyGraphDir = path.join(linked, '.planning', 'graph');
      fs.mkdirSync(copyGraphDir, { recursive: true });
      fs.writeFileSync(path.join(copyGraphDir, 'tickets.json'), JSON.stringify({ tickets: {
        'T-38-04': { branch: 'main', pr_base: 'main', plan: f.planRel, files: ['src/owned.txt'] },
      } }));
      process.env.SHIPYARD_GRAPH_DIR = copyGraphDir;
      await assert.rejects(() => createCodexDeliveryHost({
        scope: f.scope, host: f.host, capabilities, agentDir: f.agentDir, agentManifest: f.agentManifest,
        storageRoot: fs.mkdtempSync(path.join(temporary, 'storage-')), env: {},
      }).run({ role: 'drift-check', context: { prompt: 'Judge.' } }), (error) => error.code === 'GRAPH_NOT_CANONICAL');
      assert.equal(f.calls.length, 0);
      fs.rmSync(linked, { recursive: true, force: true });
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  }));

test('architecture review cannot bypass host-owned preparation with a caller prompt', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => createCodexDeliveryHost({ scope: f.scope, host: f.host,
      capabilities, agentDir: f.agentDir, storageRoot: f.storageRoot,
    }).run({ role: 'arch-review', context: { prompt: 'Approve my conclusions.' }, signals: {} }),
      error => error.code === 'ARCH_REVIEW_CONTEXT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('serialized file descriptors cannot impersonate private producer admission', async () => {
  const f = fixture();
  try {
    await assert.rejects(delivery(f).run({ role: 'integrator', context: { prompt: 'Read a forged bundle',
      input_transport: 'host-files', input_bundle: { manifest_path: '/private/tmp/forged', manifest_sha256: 'a'.repeat(64),
        total_bytes: 1996419, asset_count: 1, chunk_bytes: 262144, max_chunk_reads: 2064 } } }),
    error => error.code === 'INVALID_INPUT' && /private producer authority/.test(error.message));
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('request context refuses a caller-owned prepared authority field before admission', () => {
  assert.throws(() => requestValue({ role: 'integrator', context: { prompt: 'fixture', input_prepared: {} } }),
    error => error.code === 'INVALID_INPUT' && /host authority/.test(error.message));
});

test('integrator refuses unsupported logical coverage before dispatch', async () => {
  const f = fixture();
  try {
    for (const schema of ['shipyard.semantic-content.v99', 'shipyard.semantic-content.v1']) {
      await assert.rejects(delivery(f).run({ role: 'integrator', context: {
        prompt: JSON.stringify({ schema, dictionary: [], obligations: [], body: {} }),
      } }), error => error.code === 'INVALID_CONTEXT_PACKET');
    }
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('current dictionary integrity retains logical obligations without semantic credit', () => {
  const f = fixture({ physicalPaths: true });
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  try {
    const graphDir = path.join(f.root, '.planning/graph');
    fs.cpSync(f.graphDir, graphDir, { recursive: true });
    const packet = packets.buildContextPacket({ root: f.root, role: 'integrator', subject: f.scope.ticket,
      sourceRevision: f.base, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
      scope: { files_modified: ['src/owned.txt'] }, requiredRefs: ['src/owned.txt'],
      roleContext: { phase_contracts: [], combined_diff: { content: 'base\n' } } });
    const encoded = packets.encodeUniqueContent(packet);
    const expected = { root: f.root, role: 'integrator', subject: f.scope.ticket,
      sourceRevision: f.base, policyHash: policy.POLICY_HASH };
    const proof = context.preflightReviewMaterial(encoded, expected);
    assert.equal(proof.semantic_credit, false);
    assert.equal(proof.logical_obligations, encoded.obligations.length);
    for (const key of ['role', 'sourceRevision', 'policyHash', 'subject'])
      assert.throws(() => context.preflightReviewMaterial(encoded, { ...expected, [key]: 'foreign' }));
    const incomplete = structuredClone(encoded);
    incomplete.obligations.pop();
    assert.throws(() => context.preflightReviewMaterial(incomplete, expected), /logical obligations|provenance/);
    const input = context.prepareFileInput(f.scope, JSON.stringify(encoded), {
      role: 'integrator', dispatchId: 'preflight-fixture', storageRoot: f.storageRoot, graphDir });
    assert.equal(context.verifyFileInput(input).semantic_credit, false);
    fs.writeFileSync(path.join(f.root, 'src/owned.txt'), 'changed\n');
    assert.throws(() => context.verifyFileInput(input), /changed|stale/i);
  } finally { clean(f); }
});

test('unavailable measured capacity returns actionable refusal without native dispatch', () => {
  const f = fixture({ physicalPaths: true });
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  try {
    assert.throws(() => context.prepareFileInput(f.scope, 'complete input', {
      role: 'integrator', dispatchId: 'capacity-fixture', storageRoot: f.storageRoot,
      readerCapacity: { contract: { schema: 'shipyard.native-reader-transport.v2' } },
    }), error => error.code === 'READER_CAPACITY_UNSUPPORTED'
      && error.refusal.limiting_field === 'original_matching_capacity_authority'
      && error.refusal.observed === 'unavailable' && /legacy/.test(error.refusal.supported_next_action));
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('encoded schedule admission counts complete manifest, envelopes and launch instructions', () => {
  const { preflightReaderSchedule } = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const manifest = { chunk_bytes: 128 * 1024, assets: [{ ordinal: 0, bytes: 256 * 1024 }],
    accounting: { relay_bytes: 1200, generated_instruction_bytes: 2400 },
    transport: { schema: 'shipyard.native-reader-transport.v2', chunk_bytes: 128 * 1024,
      encoding: 'base64', output_tokens: 10000, range_schedule: 'manifest-first/ordinal-offset/v1',
      nested_envelope: 'exec-command.v1', outer_envelope: 'functions-exec.v1', output_budget_bytes: 252 * 1024 } };
  const result = preflightReaderSchedule(manifest, 1024);
  assert.equal(result.range_count, 3);
  assert.equal(result.launch_input_bytes, 3600);
  assert.ok(result.encoded_schedule_bytes > 4 * Math.ceil((256 * 1024 + 1024) / 3));
  assert.equal(result.semantic_credit, false);
  for (const transport of [{ ...manifest.transport, schema: 'shipyard.native-reader-transport.v99' },
    { ...manifest.transport, output_budget_bytes: 128 * 1024 }])
    assert.throws(() => preflightReaderSchedule({ ...manifest, transport }, 1024), error =>
      error.code === 'READER_CAPACITY_UNSUPPORTED' && Boolean(error.refusal.supported_next_action));
});

for (const mutation of [null, 'dirty-source', 'dirty-intake', 'new-output', 'sibling-output']) {
  test('authenticated native research seals with dirty operator inputs: ' + (mutation || 'unchanged'), async () => {
    const f = fixture();
    const home = fs.mkdtempSync(path.join(temporary, 'research-native-'));
    let launches = 0;
    const source = path.join(f.root, 'src', 'owned.txt');
    const intake = path.join(f.root, '.planning', 'intake.md');
    try {
      fs.writeFileSync(source, 'operator source\n');
      fs.writeFileSync(intake, 'operator intake\n');
      const result = await createCodexDeliveryHost({ scope: f.scope, graphDir: f.graphDir,
        storageRoot: f.storageRoot, capabilities, agentDir: f.agentDir,
        agentManifest: path.join(f.agentDir, '.shipyard-manifest.json'),
        env: { CODEX_HOME: home },
        probe: { status: 'available', executable: 'codex', runtime_version: '0.157.1', capabilities },
        spawn: (_executable, args) => {
          const ids = ['system-state', 'alternatives', 'constraints', 'risks'];
          const id = ids[launches++];
          const session = '88888888-8888-4888-8888-' + String(launches).padStart(12, '0');
          const artifactPath = path.join(fs.realpathSync(f.root), '.planning', 'investigations', 'INV-100', 'research', id + '.md');
          const bytes = Buffer.from('# ' + id + '\nNative finding.\n');
          fs.writeFileSync(artifactPath, bytes);
          if (mutation && launches === 2) {
            const target = mutation === 'dirty-source' ? source : mutation === 'dirty-intake' ? intake : mutation === 'new-output'
              ? path.join(f.root, 'rogue.txt') : path.join(path.dirname(artifactPath), 'system-state.md');
            fs.writeFileSync(target, 'unauthorized mutation\n');
          }
          const digest = crypto.createHash('sha256').update(bytes).digest('hex');
          const final = JSON.stringify({ id, status: 'completed', summary: 'Native research completed.',
            artifact: { path: artifactPath, bytes: bytes.length, content_bytes: bytes.length, sha256: digest, digest } });
          const model = args[args.indexOf('--model') + 1];
          const effort = JSON.parse(args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]);
          const transcript = captured('tests/fixtures/captured/codex-agent-stream-parent.jsonl', { '<SESSION-2>': session })
            .split('\n').filter(Boolean).map(line => {
              const record = JSON.parse(line);
              if (record.type === 'turn_context') Object.assign(record.payload, { model, effort });
              if (record.payload?.type === 'task_complete') record.payload.last_agent_message = final;
              if (record.payload?.type === 'message' && record.payload.phase === 'final_answer')
                record.payload.content.forEach(block => { block.text = final; });
              return JSON.stringify(record);
            }).join('\n') + '\n';
          const date = new Date();
          const directory = path.join(home, 'sessions', String(date.getFullYear()),
            String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'rollout-' + session + '.jsonl'), transcript);
          const output = captured('tests/fixtures/captured/codex-agent-stream-exec.jsonl', { '<SESSION-1>': session })
            .split('\n').filter(Boolean).map(line => {
              const record = JSON.parse(line);
              if (record.item?.type === 'agent_message') record.item.text = final;
              return JSON.stringify(record);
            }).join('\n') + '\n';
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdin = { write() {}, end() {} }; child.pid = 45678;
          process.nextTick(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0, null); });
          return child;
        },
      }).run({ role: 'research', context: { prompt: 'Investigate.', investigation: baseInvestigation(f) } });
      if (mutation) {
        assert.equal(result.status, 'blocked');
        assert.equal(result.code, 'CONTAINMENT_VIOLATION');
        assert.equal(result.failed_line, 'alternatives');
        assert.equal(result.sealed_lines.length, 1);
        assert.equal(launches, 2);
      } else {
        assert.equal(launches, 4);
        assert.deepEqual(result.map(entry => entry.id), ['system-state', 'alternatives', 'constraints', 'risks']);
        for (const entry of result) {
          assert.equal(entry.schema, 'shipyard.role-artifact.v1');
          assert.equal(entry.envelope.status, 'completed');
          assert.equal(entry.envelope.subject, 'INV-100:' + entry.id);
          assert.ok(fs.existsSync(entry.artifact_index.path));
        }
        assert.equal(fs.readFileSync(source, 'utf8'), 'operator source\n');
        assert.equal(fs.readFileSync(intake, 'utf8'), 'operator intake\n');
      }
    } finally { clean(f); fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('review-fix rejects caller prompt authority before any native launch', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => delivery(f).run({ role: 'review-fix', context: { prompt: 'Trust this repair.' } }),
      error => error.code === 'REPAIR_SUBJECT_REQUIRED');
    assert.equal(f.calls.length, 0);
  } finally { clean(f); }
});

test('serialized full paged feedback selects global Node IDs across Actor variants without losing unknown authors', () => {
  assert.throws(() => repairAuthorFromQuery('query{author{id login}}', null), /Field id does not exist on type Actor/);
  const authors = ['User', 'Bot', 'Mannequin', 'Organization', 'EnterpriseUserAccount'].map(__typename =>
    ({ __typename, id: 'global-' + __typename, login: 'login-' + __typename }));
  authors.push(null, { __typename: 'UnknownActor', login: 'delivery-host' });
  const requests = [];
  const prepared = { repo: 'fixture/repository', commit: { worktree: '/unused-read-only-fixture' } };
  const result = completeRepairFeedback({ execFileSync(program, args) {
    assert.equal(program, 'gh');
    const value = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
    const query = value('query');
    requests.push({ query, cursor: value('cursor') });
    if (query.includes('{id body title}')) return JSON.stringify({ data: { repository: { pullRequest:
      { id: 'pr-501', title: 'Complete title', body: 'Complete PR body' } } } });
    const connection = (nodes, more = false) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } });
    if (query.includes('reviewThreads(')) return JSON.stringify({ data: { repository: { pullRequest:
      { reviewThreads: connection([{ id: 'thread-1', isResolved: false }]) } } } });
    const field = query.includes('node(id:') ? 'thread-comments' : query.includes('reviews(') ? 'reviews' : 'comments';
    const offset = value('cursor') ? 3 : 0;
    const nodes = authors.slice(offset, offset ? undefined : 3).map((author, index) => ({
      id: field + '-' + (offset + index), body: 'Complete original body ' + field + '-' + (offset + index),
      author: repairAuthorFromQuery(query, author), ...(field === 'reviews' ? { state: 'COMMENTED' } : {}),
    }));
    const page = connection(nodes, offset === 0);
    return JSON.stringify({ data: field === 'thread-comments' ? { node: { comments: page } }
      : { repository: { pullRequest: { [field]: page } } } });
  } }, prepared, 501);
  assert.equal(result.inventory.length, 23);
  assert.equal(result.pages.length, 7);
  assert.equal(requests.filter(request => request.cursor === 'next').length, 3);
  for (const field of ['thread-comments', 'comments', 'reviews']) {
    authors.forEach((author, index) => {
      const entry = result.inventory.find(item => item.id === field + '-' + index);
      assert.equal(entry.body, 'Complete original body ' + field + '-' + index);
      assert.equal(entry.body_sha256, crypto.createHash('sha256').update(entry.body).digest('hex'));
      assert.equal(entry.author, author?.login || null);
      assert.equal(entry.author_id, index < 5 ? author.id : null);
    });
  }
  const canonicalInventory = JSON.stringify(result.inventory.map(entry =>
    Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))));
  assert.equal(result.digest, crypto.createHash('sha256').update(canonicalInventory).digest('hex'));
});


test('action-only CLI accepts a bounded original dispatch selector and refuses caller launch fields', () => {
  const id = 'dispatch-mv4c0jmr-b408925c-a4b3-439e-9509-1f8b34c00850';
  assert.deepEqual(parseRepairActionResumeArguments(['--resume-repair-actions', id, '--scope-file', '/tmp/original-scope.json']),
    { dispatchId: id, scopeFile: '/tmp/original-scope.json' });
  for (const args of [[], ['--resume-repair-actions', '../foreign', '--scope-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--args-file', '/tmp/scope.json'],
    ['--resume-repair-actions', id, '--scope-file', '/tmp/scope.json', '--force-first'],
    ['--resume-repair-actions', 'x'.repeat(161), '--scope-file', '/tmp/scope.json']])
    assert.throws(() => parseRepairActionResumeArguments(args), { code: 'INVALID_INPUT' });
});

function sharedRepairTransitionRegression() {
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const oid = index => index.toString(16).padStart(40, '0');
  const source_transition = { from: oid(1), to: oid(97), records: Array.from({ length: 96 }, (_, i) => ({
    commit: oid(i + 2), coverage_sha256: digest({ commit: oid(i + 2), original_receipt: i }),
  })) };
  const owners = Array.from({ length: 14 }, (_, i) => 'plugins/delivery-pipeline/scripts/original-source-owner-' + i + '.cjs');
  const scope_transition = { from: { base: oid(200), base_ref: 'epic/phase49',
    plan: { path: '49-18-PLAN.md', sha256: digest('original-plan') }, owners,
    allow_list: Array.from({ length: 4 }, (_, i) => ({ argv: ['node', '--test', ...owners.slice(i, i + 5)],
      profile: 'host', timeout_ms: 600000 })) },
  to: { base: oid(201), base_ref: 'epic/phase49',
    plan: { path: '49-18-PLAN.md', sha256: digest('current-plan') }, owners },
  base_transition: { from: oid(200), to: oid(201), commits: [{ commit: oid(201), signer: 'A'.repeat(40) }] } };
  const coverage = Array.from({ length: 49 }, (_, i) => {
    const reply = { id: 'reply-' + i, kind: 'thread-comment', thread_id: 'thread-' + i,
      author: 'native-fixer', author_id: 'original-author', body: 'Complete reasoning Ω ' + 'evidence '.repeat(80) };
    reply.body_sha256 = digest(reply.body);
    const response = JSON.stringify({ data: { node: reply, target: { id: 'finding-' + i },
      review: { id: 'review-' + i, body: '', state: 'COMMENTED' } } });
    return { dispatch_id: 'original-dispatch-' + Math.floor(i / 7), receipt_sha256: digest('receipt-' + i),
      artifact_ref: '/original/artifact-' + i, artifact_digest: digest('artifact-' + i),
      actions_sha256: digest('original-action-bytes-' + i), feedback_id: 'finding-' + i,
      disposition_sha256: digest('complete-disposition-' + i), reply, resolved: true,
      reply_review: { response, sha256: digest(response), created: true,
        review: { id: 'review-' + i, body: '', state: 'COMMENTED' } },
      historical: true, semantic_credit: false, source_transition, scope_transition };
  });
  const feedback = { inventory: coverage.flatMap(item => [item.reply, item.reply_review.review]), digest: digest('full-live-feedback') };
  const prior_attempts = Array.from({ length: 7 }, (_, i) => ({ dispatch_id: 'original-dispatch-' + i,
    notes: 'Complete prior notes '.repeat(180), hypothesis: 'Complete prior hypothesis '.repeat(150) }));
  const subject = { feedback, actionable_feedback: { coverage, inventory: feedback.inventory }, prior_attempts,
    hypotheses: prior_attempts.map(item => item.hypothesis) };
  const shared = shareRepairTransitions(coverage);
  const compact = { ...subject, actionable_feedback: { ...subject.actionable_feedback, ...shared } };
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  assert.ok(bytes(subject) > 512 * 1024, 'realistic repeated historical inventory exceeds unchanged subject bound');
  assert.ok(bytes(compact) < 512 * 1024, 'complete shared subject fits unchanged custody bound');
  assert.ok(bytes({ subject: compact, files_modified: owners }) < 1024 * 1024, 'complete native prompt material fits unchanged prompt bound');
  assert.equal(Object.keys(shared.historical_transitions).length, 1);
  assert.deepEqual(shared.coverage.map(item => repairCoverageTransition(item, shared)), coverage);
  assert.deepEqual(compact.feedback, subject.feedback);
  assert.deepEqual(compact.prior_attempts, prior_attempts);
  assert.deepEqual(compact.hypotheses, subject.hypotheses);
  const first = shared.coverage[0], reference = first.transition_sha256;
  for (const mutate of [value => { delete value.historical_transitions[reference]; },
    value => { value.historical_transitions[reference].source_transition.to = oid(999); },
    value => { value.historical_transitions[reference].scope_transition.to.plan.sha256 = digest('foreign-current-plan'); }]) {
    const altered = JSON.parse(JSON.stringify(shared)); mutate(altered);
    assert.throws(() => repairCoverageTransition(first, altered), { code: 'REPAIR_PREDECESSOR_INVALID' });
  }
  for (const altered of [{ ...first, semantic_credit: true }, { ...first, transition_sha256: '0'.repeat(64) },
    { ...first, source_transition }, { ...first, historical: false }])
    assert.throws(() => repairCoverageTransition(altered, shared), { code: 'REPAIR_PREDECESSOR_INVALID' });
  assert.deepEqual(repairCoverageTransition(coverage[0], {}), coverage[0], 'original sealed inline subjects remain readable');
  const sourceOnly = shareRepairTransitions([{ ...coverage[0], scope_transition: undefined }]);
  const sourcePrior = repairCoverageTransition(sourceOnly.coverage[0], sourceOnly);
  assert.throws(() => recheckHistoricalRepair({ commit: { expectedHead: oid(999) } }, sourcePrior, source_transition.from),
    { code: 'REPAIR_PREDECESSOR_INVALID' });
  const currentScope = scope_transition.to;
  const prepared = { commit: { expectedBase: currentScope.base, files_modified: currentScope.owners },
    baseRef: currentScope.base_ref, plan: currentScope.plan, verificationAllowList: currentScope.allow_list };
  assert.throws(() => recheckHistoricalRepair({ ...prepared, plan: { ...prepared.plan, sha256: digest('foreign-current-plan') } },
    repairCoverageTransition(first, shared), source_transition.from), { code: 'REPAIR_PREDECESSOR_INVALID' });

  return { inline_bytes: bytes(subject), shared_bytes: bytes(compact),
    repeated_transition_bytes: bytes(coverage.map(item => ({ source_transition: item.source_transition, scope_transition: item.scope_transition }))),
    shared_transition_bytes: bytes(shared.historical_transitions) };
}

test('49 complete historical actions share authenticated transition bytes within unchanged custody bounds',
  sharedRepairTransitionRegression);

function operationalEscalationHistoryRegression(mutation) {
  const root = fs.mkdtempSync(path.join(temporary, 'operational-history-'));
  const journalFile = path.join(root, 'delivery-log.jsonl');
  const row = { ts: '2026-10-13T12:20:09.994Z', event: 'escalation', ticket: 'T-49-18', pr: 470,
    reason: 'partial native fixer/escalated recovery', by: 'escalation-record' };
  const variants = {
    attempt: { event: 'attempt' }, 'fix-round': { event: 'fix_round' },
    'native-escalation': { role: 'review-fix', native_status: 'completed' },
    'marker-extra-fields': { model: 'gpt-6.1-sol', status: 'passed', hypothesis: 'claimed completion',
      artifact_ref: 'claimed-artifact', dispatch_id: 'claimed-dispatch' },
    'foreign-pr': { pr: 471 }, 'foreign-identity': { repository: 'foreign/repository' },
  };
  Object.assign(row, variants[mutation] || {});
  const bytes = mutation === 'corrupt-journal' ? JSON.stringify(row) + '\n{broken\n' : JSON.stringify(row) + '\n';
  fs.writeFileSync(journalFile, bytes);
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs'), 'utf8');
  const body = source.slice(source.indexOf('function repairHistory('), source.indexOf('function retainRepairAttempt('));
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const history = new Function('fs', 'path', 'sha256', 'privateDirectory', 'MAX_GRAPH_BYTES', 'fail',
    body + '; return repairHistory;')(fs, path, digest, () => root, 1024 * 1024,
    (code, message) => { throw Object.assign(new Error(message), { code }); });
  const prepared = { stateRoot: root, graphFile: path.join(root, 'tickets.json'), commit: { ticket: 'T-49-18' } };
  try {
    if (mutation) assert.throws(() => history(prepared, 470), { code: 'REPAIR_PREDECESSOR_INVALID' });
    else {
      const result = history(prepared, 470);
      assert.deepEqual(result.history, []);
      assert.equal(result.reference, null);
      assert.deepEqual(result.journal, { path: journalFile, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
    }
    assert.equal(fs.readFileSync(journalFile, 'utf8'), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('49 ordinary operator escalation is nonsemantic context in the complete bound journal',
  () => operationalEscalationHistoryRegression());
for (const mutation of ['attempt', 'fix-round', 'native-escalation', 'marker-extra-fields', 'foreign-pr', 'foreign-identity', 'corrupt-journal'])
  test('49 operational escalation classification refuses ' + mutation,
    () => operationalEscalationHistoryRegression(mutation));


test('focused prepared custody is forbidden in caller delivery request context', () => {
  const host = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'focused-request-'));
  try {
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ scope: {}, role: 'arch-review', context: { focused_prepared: {} } }));
    assert.throws(() => host.readRequestFile(request), /host authority/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


for (const full of [false, true])
for (const mutation of ['progress', 'duplicate-contract', 'duplicate-item', 'corrupt-terminal', 'incomplete-turn', 'failed-turn', 'foreign-session'])
test('original integration boundary completes and retains one terminal contract: ' + mutation + ' full=' + full, () => withGraphDirEnv(undefined, async () => {
  const Module = require('node:module');
  const file = require.resolve('./phase49-incremental-integration.test.cjs');
  const fixtureModule = new Module(file, module);
  fixtureModule.filename = file; fixtureModule.paths = Module._nodeModulePaths(path.dirname(file));
  const load = Module._load;
  const emit = require('node:events').EventEmitter.prototype.emit;
  let observed = 0, executeFixture;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test(name, callback) {
      if (name === 'owned integration original stream regression') executeFixture = callback;
    } };
    return load.call(this, name, ...args);
  };
  try {
    fixtureModule._compile(fs.readFileSync(file, 'utf8')
      + '\ntest("owned integration original stream regression", () => fixture(f => module.regression(f, runIntegration, successfulReview)));\n', file);
  } finally { Module._load = load; }
  require('node:events').EventEmitter.prototype.emit = function(event, bytes, ...args) {
    if (event === 'data' && Buffer.isBuffer(bytes) && (bytes.toString().includes('shipyard.integration-coverage-result.v1')
      || (full && bytes.toString().includes('Complete original role review.')))) {
      const rows = bytes.toString().trim().split('\n').map(JSON.parse);
      const at = rows.findIndex(row => row.item?.type === 'agent_message');
      const progress = structuredClone(rows[at]); progress.item.id += '-progress';
      progress.item.text = 'Checking complete integration membership and interactions.';
      rows.splice(at, 0, progress); observed++;
      if (['duplicate-contract', 'corrupt-terminal'].includes(mutation)) {
        const extra = structuredClone(rows[at + 1]); extra.item.id += '-extra';
        if (mutation === 'corrupt-terminal') extra.item.text = '{"coverage":';
        rows.splice(at + 2, 0, extra);
      }
      if (mutation === 'duplicate-item') rows[at].item.id = rows[at + 1].item.id;
      if (mutation === 'incomplete-turn') rows.splice(rows.findIndex(row => row.type === 'turn.completed'), 1);
      if (mutation === 'failed-turn') rows.find(row => row.type === 'turn.completed').type = 'turn.failed';
      if (mutation === 'foreign-session') rows.find(row => row.type === 'thread.started').thread_id = crypto.randomUUID();
      bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    return emit.call(this, event, bytes, ...args);
  };
  try {
    fixtureModule.regression = async (f, runIntegration, successfulReview) => {
      const run = () => full ? successfulReview(f, 'integrator', { legacy: true }) : runIntegration(f);
      if (mutation === 'progress') {
        const fresh = await run();
        const dispatched = full ? fresh.dispatched : fresh.result;
        assert.equal(dispatched.receipt.role, 'integrator');
        assert.ok(full ? fresh.artifact : fresh.result.artifact.artifact_path);
        const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
        if (full) {
          const catalogue = JSON.parse(fs.readFileSync(path.join(authority.archiveAuthorityDirectory(f.worktree), 'catalogue.json'), 'utf8'));
          assert.equal(typeof catalogue.payload.records[dispatched.dispatch_id].receipt_store, 'string');
          assert.ok(fs.statSync(catalogue.payload.records[dispatched.dispatch_id].receipt_store).isDirectory());
        }
        const currentVerdict = () => authority.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
          baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName });
        assert.equal(currentVerdict()?.dispatch_id, dispatched.dispatch_id);
        const foreign = path.join(f.root, 'foreign-current-discovery');
        execFileSync('git', ['-C', f.worktree, 'worktree', 'add', '--detach', foreign, f.base], { stdio: 'pipe' });
        const catalogue = path.join(authority.archiveAuthorityDirectory(fs.realpathSync(foreign)), 'catalogue.json');
        fs.mkdirSync(path.dirname(catalogue), { recursive: true });
        fs.writeFileSync(catalogue, 'unrelated corrupt authority');
        const read = fs.readFileSync;
        let foreignReads = 0;
        const lookup = currentVerdict;
        fs.readFileSync = function(file, ...args) {
          if (String(file) === catalogue) { foreignReads++; throw new Error('foreign catalogue was opened'); }
          return read.call(this, file, ...args);
        };
        try { assert.equal(lookup()?.dispatch_id, dispatched.dispatch_id); assert.equal(foreignReads, 0); }
        finally { fs.readFileSync = read; }
        const manifest = full ? fresh.artifact : fresh.result.artifact.artifact_path;
        fs.appendFileSync(manifest, 'changed relevant manifest');
        assert.throws(lookup);

      } else if (full && ['duplicate-contract', 'duplicate-item'].includes(mutation)) {
        const fresh = await run();
        assert.equal(fresh.dispatched.receipt.role, 'integrator');
        assert.ok(observed > 0);
        assert.equal(require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs').currentIntegrationVerdict({
          worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
          graphDir: f.graphDir, headBranch: f.pr.headRefName }), null);
      } else await assert.rejects(run);
    };
    assert.equal(typeof executeFixture, 'function');
    await executeFixture();
    assert.equal(observed, 1);
  } finally { require('node:events').EventEmitter.prototype.emit = emit; }
}));

suite('codex-delivery-host — T-50-14 shared preflight');

const scriptsSource = path.join(__dirname, '../../plugins/delivery-pipeline/scripts');
const HELP_MARKERS = '--json --model --config --cd --ignore-user-config';

function preflightFixture({ stalePolicy = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporary, 'pf-')));
  const isolated = path.join(root, 'home');
  const home = path.join(root, 'codex-home');
  const bundle = path.join(home, 'shipyard');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  for (const dir of [isolated, path.join(home, 'agents'), bin, project]) fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(scriptsSource, path.join(bundle, 'scripts'), { recursive: true });
  const evidence = Buffer.from(JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  const agent = Buffer.from('name = "x"\n');
  fs.writeFileSync(path.join(home, 'agents', 'a.toml'), agent);
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(home, 'agents', '.shipyard-manifest.json'), JSON.stringify({
    phase: 2, codexHome: home, scriptsRoot: bundle, capabilities_file: 'codex-capabilities.json',
    capabilities_digest: digest(evidence), policy_hash: stalePolicy ? 'old' : policy.POLICY_HASH,
    agent_files: ['a.toml'], agent_digests: { 'a.toml': digest(agent) },
  }));
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-test; exit 0; fi\necho "${HELP_MARKERS}"\n`,
    { mode: 0o755 });
  execFileSync('git', ['init', '-q', project]);
  fs.mkdirSync(path.join(project, '.planning', 'graph', 'provenance'), { recursive: true });
  const env = { PATH: bin + ':/usr/bin:/bin', HOME: isolated, XDG_STATE_HOME: path.join(isolated, 'state'), CODEX_HOME: home };
  return { root, home, bundle, project, isolated, env, host: path.join(bundle, 'scripts', 'codex-delivery-host.cjs') };
}

function runScript(f, args, env = f.env, cwd = f.project) {
  const result = spawnSync(process.execPath, [f.host, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function treeOf(dir) {
  const out = [];
  const walk = (entry) => {
    for (const name of fs.readdirSync(entry).sort()) {
      const file = path.join(entry, name);
      out.push(path.relative(dir, file));
      if (fs.lstatSync(file).isDirectory()) walk(file);
    }
  };
  walk(dir);
  return out;
}

function requestFor(f) {
  const file = path.join(f.root, 'request.json');
  fs.writeFileSync(file, JSON.stringify({
    scope: { run_id: 'pf-run', ticket: 'T-50-14', phase: 50, worktree: f.project, runtime: 'codex', provider: 'openai' },
    role: 'executor', context: { prompt: 'x' },
  }));
  return file;
}

test('--preflight on a healthy installed fixture exits 0 and starts nothing', () => {
  const f = preflightFixture();
  const before = treeOf(f.isolated);
  const result = runScript(f, ['--preflight']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  assert.deepEqual(treeOf(f.isolated), before);
});

test('--preflight exits 1 and names the stale generated agent', () => {
  const f = preflightFixture({ stalePolicy: true });
  const result = runScript(f, ['--preflight']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  assert.equal(JSON.parse(result.stdout.trim()).ok, false);
});

test('a launch with a disagreeing CODEX_HOME refuses before creating any state', () => {
  const f = preflightFixture();
  const other = path.join(f.root, 'other-home');
  fs.mkdirSync(other);
  const before = treeOf(f.isolated);
  const result = runScript(f, ['--args-file', requestFor(f)], { ...f.env, CODEX_HOME: other });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /hint\[ENV_CONFLICT\]/);
  assert.deepEqual(treeOf(f.isolated), before);
  assert.ok(!fs.existsSync(path.join(f.isolated, '.local')));
});

test('a launch against a stale bundle refuses before creating any state, and --preflight accepts the request', () => {
  const f = preflightFixture({ stalePolicy: true });
  const request = requestFor(f);
  const before = treeOf(f.isolated);
  const launch = runScript(f, ['--args-file', request]);
  assert.equal(launch.status, 1, launch.stderr);
  assert.match(launch.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  const check = runScript(f, ['--preflight', '--args-file', request]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  assert.deepEqual(treeOf(f.isolated), before);
});

test('a refused launch keeps stdout free of preflight JSON, throws the first finding code and prints its hint once', async () => {
  const f = preflightFixture({ stalePolicy: true });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.equal(launch.status, 1, launch.stderr);
  assert.equal(launch.stdout, '');
  assert.equal(launch.stderr.split('\n').filter((line) => line.startsWith('hint[STALE_GENERATED_AGENT]')).length, 1, launch.stderr);
  const out = [];
  const err = [];
  let refusal;
  await assert.rejects(require(f.host).runCli(['--args-file', requestFor(f)], { write() {} }, {
    env: f.env, preflightStdout: { write: (text) => out.push(text) }, preflightStderr: { write: (text) => err.push(text) },
  }), (error) => { refusal = error; return error.hintPrinted === true && /^preflight found/.test(error.message); });
  assert.deepEqual(out, []);
  assert.ok(err.join('').includes(`hint[${refusal.code}]`));
  const check = runScript(f, ['--preflight', '--args-file', requestFor(f)]);
  assert.equal(JSON.parse(check.stdout.trim()).ok, false);
});

test('--preflight reports a state directory inside the worktree and an unreadable private writer root', async () => {
  const f = preflightFixture();
  fs.mkdirSync(path.join(f.project, '.planning', 'phases', '50-launch'), { recursive: true });
  const file = path.join(f.root, 'typed-request.json');
  fs.writeFileSync(file, JSON.stringify({
    scope: { run_id: 'pf-run', ticket: 'T-50-14', phase: 50, worktree: f.project, runtime: 'codex', provider: 'openai' },
    role: 'decomposition', gsd_role: 'gsd-planner', context: { prompt: 'x' },
  }));
  const stderr = [];
  const check = (extra) => runCli(['--preflight', '--args-file', file], { write() {} }, {
    env: f.env, probe: { status: 'available' }, preflightStdout: { write() {} },
    preflightStderr: { write: (text) => stderr.push(text) }, ...extra,
  });
  const inside = await check({ storageRoot: path.join(f.project, 'state-inside') });
  assert.deepEqual(inside.findings.map((finding) => finding.code), ['INVALID_STATE_DIR']);
  assert.equal(inside.ok, false);
  const home = process.env.HOME;
  try {
    const claudeBase = path.join(f.root, 'private-home', '.local', 'state', 'shipyard', 'claude-decompose');
    fs.mkdirSync(claudeBase, { recursive: true });
    fs.symlinkSync(f.root, path.join(claudeBase, 'linked'));
    process.env.HOME = path.join(f.root, 'private-home');
    const legacy = await check({ storageRoot: path.join(f.root, 'host-state') });
    assert.deepEqual(legacy.findings.map((finding) => finding.code), ['LEGACY_WRITER_STATE']);
    assert.equal(legacy.ok, false);
    assert.match(stderr.join(''), /hint\[LEGACY_WRITER_STATE\]/);
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
  assert.strictEqual(process.env.HOME, home);
});

test('a launch that passes preflight prints warnings on stderr without a bare ok line and no preflight JSON', () => {
  const f = preflightFixture();
  const manifestFile = path.join(f.home, 'agents', '.shipyard-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, codex_cli_version: '1.0.0' }));
  fs.writeFileSync(path.join(f.root, 'bin', 'codex'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-cli 2.0.0; exit 0; fi\necho "${HELP_MARKERS}"\n`, { mode: 0o755 });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.match(launch.stderr, /preflight: warning\[CAPABILITY_SNAPSHOT_AGED\]/);
  assert.doesNotMatch(launch.stderr, /preflight: ok/);
  assert.doesNotMatch(launch.stdout, /shipyard\.host-preflight\.v1/);
});

test('a launch preflight warning is printed without control characters from the recorded values', () => {
  const f = preflightFixture();
  const manifestFile = path.join(f.home, 'agents', '.shipyard-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, codex_cli_version: '1.0.0\u001b[2Jx\nforged: line' }));
  fs.writeFileSync(path.join(f.root, 'bin', 'codex'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-cli 2.0.0; exit 0; fi\necho "${HELP_MARKERS}"\n`, { mode: 0o755 });
  const launch = runScript(f, ['--args-file', requestFor(f)]);
  assert.match(launch.stderr, /preflight: warning\[CAPABILITY_SNAPSHOT_AGED\]/);
  assert.doesNotMatch(launch.stderr, /\u001b/);
  assert.doesNotMatch(launch.stderr, /^forged: line/m);
});

test('a symlinked provenance member in the host graph directory refuses the launch with no state', () => {
  const f = preflightFixture();
  const foreign = path.join(f.root, 'foreign');
  fs.mkdirSync(path.join(foreign, '.planning', 'graph', 'provenance'), { recursive: true });
  fs.writeFileSync(path.join(foreign, '.planning', 'graph', 'provenance', 'one.json'), '{}');
  fs.symlinkSync('one.json', path.join(foreign, '.planning', 'graph', 'provenance', 'link.json'));
  const before = treeOf(f.isolated);
  const env = { ...f.env, SHIPYARD_GRAPH_DIR: path.join(foreign, '.planning', 'graph') };
  const result = runScript(f, ['--args-file', requestFor(f)], env);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /hint\[LEGACY_HISTORY_UNSAFE\]/);
  assert.deepEqual(treeOf(f.isolated), before);
  fs.symlinkSync('one.json', path.join(f.project, '.planning', 'graph', 'provenance', 'link.json'));
  fs.writeFileSync(path.join(f.project, '.planning', 'graph', 'provenance', 'one.json'), '{}');
  const own = runScript(f, ['--preflight', '--args-file', requestFor(f)]);
  assert.match(own.stderr, /hint\[LEGACY_HISTORY_UNSAFE\]/);
});

test('resume modes refuse a broken environment before their controller begins', () => {
  const f = preflightFixture({ stalePolicy: true });
  const scopeFile = path.join(f.root, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ run_id: 'pf-run', worktree: f.project, phase: 50, ticket: 'T-50-14' }));
  const before = treeOf(f.isolated);
  for (const args of [['--resume-finalization', 'a'.repeat(64), '--scope-file', scopeFile],
    ['--resume-repair-actions', 'dispatch-1', '--scope-file', scopeFile]]) {
    const result = runScript(f, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /hint\[STALE_GENERATED_AGENT\]/);
  }
  assert.deepEqual(treeOf(f.isolated), before);
});

test('a malformed --preflight argv is a usage error', async () => {
  await assert.rejects(runCli(['--preflight', '--bogus'], { write() {} }, {}), (error) => error.code === 'INVALID_INPUT');
});




















test('recovery source opening refuses real FIFOs and replacement races within a bounded child', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-opening-')));
  const host = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const [host, root, mode] = process.argv.slice(1);
    const source = fs.readFileSync(host, 'utf8');
    const body = source.slice(source.indexOf('function recoveryBytes('), source.indexOf('function recoveryGraphMatches('));
    const fail = code => { const error = new Error(code); error.code = code; throw error; };
    const read = new Function('fs', 'path', 'MAX_GRAPH_BYTES', 'fail', body + '; return recoveryBytes;')(fs, path, 1024, fail);
    const file = path.join(root, mode);
    if (mode === 'fifo') execFileSync('mkfifo', [file]);
    else if (mode === 'directory') fs.mkdirSync(file);
    else if (mode === 'symlink') fs.symlinkSync(host, file);
    else fs.writeFileSync(file, 'original');
    const descriptors = new Set(), originalOpen = fs.openSync, originalClose = fs.closeSync;
    fs.openSync = function (...args) {
      const fd = originalOpen.apply(fs, args); descriptors.add(fd); return fd;
    };
    fs.closeSync = function (fd) { originalClose.call(fs, fd); descriptors.delete(fd); };
    if (mode === 'replacement') {
      const open = fs.openSync;
      fs.openSync = function (target, flags) {
        if (target === file) { fs.unlinkSync(file); execFileSync('mkfifo', [file]); }
        return open.call(fs, target, flags);
      };
    }
    if (mode === 'changed') {
      const readFile = fs.readFileSync;
      fs.readFileSync = function (target, ...args) {
        const bytes = readFile.call(fs, target, ...args);
        if (typeof target === 'number') fs.appendFileSync(file, 'changed');
        return bytes;
      };
    }
    if (mode === 'regular') assert.equal(read(file, root).toString(), 'original');
    else assert.throws(() => read(file, root), error => error.code === 'REPAIR_SUBJECT_CHANGED');
    assert.equal(descriptors.size, 0);
  `;
  try {
    for (const mode of ['fifo', 'replacement', 'directory', 'symlink', 'changed', 'regular']) {
      const result = spawnSync(process.execPath, ['-e', script, host, root, mode], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.error, undefined, mode + ': ' + String(result.error));
      assert.equal(result.signal, null, mode);
      assert.equal(result.status, 0, mode + ': ' + result.stderr);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


function codexPartitionFixture(f, helper, controls = {}) {
  const roleArtifacts = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const native = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const complete = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
    .prepareNativeIntegratorContext(helper.projectOptions(f), { worktree: f.worktree, phase: '49',
      review_contract: roleArtifacts.INTEGRATION_REVIEW_V3 });
  const a = helper.agent(f, 'integrator', complete.signals);
  const frameRows = () => {
    const meta = helper.template(helper.parent, row => row.type === 'session_meta');
    const context = helper.template(helper.parent, row => row.type === 'turn_context');
    Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort, cwd: f.worktree, workspace_roots: [f.worktree] });
    context.payload.sandbox_policy.type = 'read-only';
    Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
    const developer = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.role === 'developer');
    developer.payload.content = [{ type: 'input_text', text: native.generatedInstructions(a.text) }];
    return { meta, context, developer };
  };
  const directory = path.join(f.root, 'codex-behavior-only-capacity'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retain = proof => {
    const raw = stable({ ...proof, behavior_only: true }), file = path.join(directory, digest(raw) + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, raw, { mode: 0o600 });
    return { path: file, bytes: Buffer.byteLength(raw), sha256: digest(raw) };
  };
  const capacity = { max_input_bytes: 8 * 1024 * 1024, unit_input_bytes: 256 * 1024, segment_bytes: 16 * 1024,
    output_reserve_tokens: 32000, tool_reserve_tokens: 10000,
    output_limits: { conclusions: 1024, findings: 2048, limitations: 1024, required_context: 1024, seams: 16384 },
    recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'native-exact' } };
  const resources = { capacity, counterSource: 'codex-behavior-only-counter', windowSource: 'codex-behavior-only-window',
    renderLaunch(launch) {
      controls.render?.(launch);
      const { meta, context, developer } = frameRows(), { turn_id, ...framing } = context.payload;
      const frame = { developers: [{ role: developer.payload.role, content: developer.payload.content }], other_users: [],
        base_instructions: meta.payload.base_instructions || null, contexts: [framing] };
      const request = { schema: 'shipyard.integration-native-request.v1', runtime: 'codex', model: launch.model,
        effort: launch.effort, input: launch.input, instruction_sha256: launch.instruction_sha256,
        recipe_sha256: digest(stable(capacity.recipe)), frame, tools: [],
        native_payload: stable({ frame, tools: [], input: launch.input, model: launch.model, effort: launch.effort }) };
      controls.mutate?.(request, 'request', launch);
      return request;
    },
    readWindow(identity) {
      if (controls.noWindow) throw new Error('fixture window unavailable');
      const proof = { schema: 'shipyard.integration-runtime-window.v1', ...identity,
        source: 'codex-behavior-only-window', evidence_id: 'codex-behavior-only-window', window_tokens: 100000000 };
      controls.mutate?.(proof, 'window');
      return retain(proof);
    },
    measureInput(request, identity) {
      const payload = JSON.parse(request.input.match(/<AUTHENTICATED_INTEGRATION_PARTITION>\s*([\s\S]*?)\s*<\/AUTHENTICATED_INTEGRATION_PARTITION>/)[1]);
      (controls.measured ||= []).push(payload);
      const proof = { schema: 'shipyard.integration-input-measurement.v1', ...identity, runtime: 'codex', model: request.model,
        source: 'codex-behavior-only-counter', evidence_id: 'codex-behavior-only-count-' + identity.launch_sha256,
        input_tokens_upper_bound: 1000 };
      controls.mutate?.(proof, 'measurement', payload);
      return retain(proof);
    } };
  const options = { ...helper.projectOptions(f), scope: { worktree: f.worktree, phase: 49,
    repository: complete.canonical.commonPath, ticket: complete.ticket, run_id: 'public-codex-v3-' + ++f.count },
    storageRoot: path.join(f.root, 'public-codex-v3-' + f.count), agentDir: a.dir, agentManifest: a.manifest,
    capabilities: a.capabilities, env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
    probe: { status: 'available', executable: 'codex-fixture', runtime_version: 'fixture', capabilities: a.capabilities },
    integrationCapacity: resources,
    spawn(_file, _args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
      let input = '';
      child.stdin = { write(raw) { input += raw; }, end() { process.nextTick(() => {
        try {
          input = input.replace(/\n$/, '');
          const wire = input, readRows = [];
          assert.ok(wire.length <= 1048576, 'actual native CLI physical character ceiling');
          if (/^INPUT_MANIFEST=/m.test(wire)) {
            const manifestPath = /^INPUT_MANIFEST=(.+)$/m.exec(wire)[1];
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const bundle = { manifest_path: manifestPath, chunk_bytes: manifest.chunk_bytes };
            const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
            const material = manifest.assets.map(asset => fs.readFileSync(asset.path));
            const reads = collector.integrationTextReads(bundle, { manifest, manifest_bytes: fs.readFileSync(manifestPath), material });
            assert.equal(/^MANIFEST_READ=(.+)$/m.exec(wire)?.[1], reads[0].command,
              'actual relay and native verifier prescribe the same first manifest command');
            for (const read of reads) {
              const call = 'integration-read-' + readRows.length;
              const output = require('node:child_process').execSync(read.command, { maxBuffer: 252 * 1024 });
              assert.deepEqual(output, read.bytes);
              const invocation = helper.template(helper.parent, row => row.payload?.type === 'function_call');
              Object.assign(invocation.payload, { name: 'exec_command', call_id: call,
                arguments: JSON.stringify({ cmd: read.command, max_output_tokens: 10000 }) });
              delete invocation.payload.namespace;
              const response = helper.template(helper.parent, row => row.payload?.type === 'function_call_output');
              Object.assign(response.payload, { call_id: call,
                output: JSON.stringify({ exit_code: 0, output: output.toString('utf8') }) });
              readRows.push(invocation, response);
            }
            input = Buffer.concat(material).toString('utf8');
          }
          const payload = JSON.parse(input.match(/<AUTHENTICATED_INTEGRATION_PARTITION>\s*([\s\S]*?)\s*<\/AUTHENTICATED_INTEGRATION_PARTITION>/)[1]);
          (controls.launches ||= []).push({ input, payload, wire, readRows });
          controls.onLaunch?.(input, payload, wire, readRows);
          const identity = payload.reviewed_identity, assignment = payload.assignment;
          const result = { review_contract: roleArtifacts.INTEGRATION_REVIEW_V3, kind: payload.kind, runtime: 'codex',
            subject: payload.subject, plan_sha256: payload.plan_sha256, input_sha256: digest(input), reviewed_identity: identity,
            completeness: 'complete', outcome: 'passed', blocking_count: 0, findings: [], evidence_markdown: 'Original Codex fixture evidence; behavior only.' };
          if (payload.kind === 'unit') Object.assign(result, { schema: 'shipyard.integration-unit-result.v1', unit_id: assignment.unit_id,
            coverage: { primary_segments: assignment.primary_segments, primary_obligation_ids: assignment.primary_obligation_ids,
              support_segments: assignment.support_segments, support_obligation_ids: assignment.support_obligation_ids },
            conclusions: ['All exact primary fixture bytes and obligations evaluated.'], limitations: [], required_context: [],
            seams: assignment.seam_ids.map(id => ({ id, disposition: 'unresolved', rationale: 'Final must independently judge the interaction.' })) });
          else Object.assign(result, { phase: identity.phase, head: identity.head, head_tree: identity.head_tree,
            base: identity.base_ref.replace(new RegExp('^refs/remotes/'), ''), base_tree: identity.base_tree,
            ticket_set: identity.ticket_set, ticket_set_digest: identity.ticket_set_digest, summary: 'Separate Codex fixture final.',
            coverage: { ...payload.coverage, limitations: [], seam_dispositions: payload.seams.map(seam => ({
              id: seam.id, disposition: 'resolved', rationale: 'Independent fixture final judged complete acceptance and this seam.' })) } });
          controls.result?.(result, payload);
          const session = crypto.randomUUID(), text = JSON.stringify(result), { meta, context, developer } = frameRows();
          Object.assign(meta.payload, { id: session, session_id: session, cwd: f.worktree, runtime_workspace_roots: [f.worktree] });
          const start = helper.template(helper.parent, row => row.payload?.type === 'task_started'), turn = start.payload.turn_id;
          context.payload.turn_id = turn;
          const user = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.role === 'user');
          user.payload.content = [{ type: 'input_text', text: wire }];
          const final = helper.template(helper.parent, row => row.type === 'response_item' && row.payload?.phase === 'final_answer');
          final.payload.content.forEach(block => { block.text = text; }); final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
          const completion = helper.template(helper.parent, row => row.payload?.type === 'task_complete');
          Object.assign(completion.payload, { turn_id: turn, last_agent_message: text });
          for (const row of readRows) row.payload.internal_chat_message_metadata_passthrough = { turn_id: turn };
          const rows = [meta, context, start, developer, user, ...readRows,
            helper.template(helper.parent, row => row.payload?.type === 'token_count'), final, completion];
          controls.native?.(rows);
          const now = new Date(), root = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
          fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, session + '.jsonl'), helper.serialize(rows));
          const cli = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
            .map(type => helper.template(helper.cli, row => row.type === type));
          cli[0].thread_id = session; cli[2].item.text = text;
          child.stdout.emit('data', Buffer.from(helper.serialize(cli))); child.emit('close', 0);
        } catch (error) { child.emit('error', error); }
      }); } };
      return child;
    } };
  return { options, resources, controls };
}

function registerSelectedTests(runTest, context, options) {
const selectionArgs = options.selectionArgs;
const entryOnly = selectionArgs.includes('--code-review-entry-only');
const integratorDefaultOnly = selectionArgs.includes('--integrator-default-only');
const legacyCompatibilityOnly = selectionArgs.includes('--integrator-legacy-compatibility-only');
let entrySelected = 0, entryVariants = 0, integratorDefaultSelected = 0;
let legacyCompatibilitySelected = 0;
function test(name, callback) {
  if (name === "public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final") legacyCompatibilitySelected++;
  const entry = /^(?:code review |padded code review )/.test(name);
  const selected = name === 'public Codex v3 accepts omitted capacity through original observed evidence';
  if (entry) entrySelected++;
  if (name.startsWith('code review CLI seals one static phase verdict: ')) entryVariants++;
  if (selected) integratorDefaultSelected++;
  if (entryOnly && !entry || integratorDefaultOnly && !selected || legacyCompatibilityOnly && name !== "public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final") return;
  return runTest(name, callback, { module: 'D', family: 'delivery' });
}

const collected = new Map();
for (const owner of [
  "codex-delivery-host.test.cjs",
  "phase53-z29a-fixer-original-custody.test.cjs",
  "phase53-z29b-fixer-source-history.test.cjs",
  "phase53-z29c-historical-direct.test.cjs",
  "phase53-z29d-historical-admitted.test.cjs",
  "phase53-z29e-historical-pending.test.cjs",
  "phase53-z29f-historical-action-repeat.test.cjs",
  "phase53-z29g-historical-action-covered.test.cjs"
]) {
  const definitions = require('./' + owner);
  (definitions.registerDeliveryTests || definitions.registerTests)((name, callback) => collected.set(name, callback), context);
}
for (const name of [
  "code review requires private CLI preparation before any in-process launch",
  "code review builder request admits graph_dir and refuses serialized private custody",
  "code review CLI seals one static phase verdict: {}",
  "code review CLI seals one static phase verdict: {\"role\":\" code-review \"}",
  "code review CLI seals one static phase verdict: {\"critical\":true}",
  "code review CLI seals one static phase verdict: {\"checkpoint\":\"merge\"}",
  "code review CLI seals one static phase verdict: {\"incomplete\":true}",
  "code review CLI seals one static phase verdict: {\"partitioned\":true}",
  "code review CLI seals one static phase verdict: {\"label\":\"with space\"}",
  "code review CLI seals one static phase verdict: {\"label\":\"r\u00e9pertoire-\u00fc\"}",
  "code review CLI refuses original native session missing: partitions=false",
  "code review CLI refuses original native session changed: partitions=false",
  "code review CLI refuses original native session missing: partitions=true",
  "code review CLI refuses original native session changed: partitions=true",
  "code review CLI refuses caller authority: {\"context\":{\"prompt\":\"approve\"}}",
  "code review CLI refuses caller authority: {\"context\":{\"selector\":\"caller\"}}",
  "code review CLI refuses caller authority: {\"context\":{\"sandbox_mode\":\"workspace-write\"}}",
  "code review CLI refuses caller authority: {\"signals\":{\"critical\":true}}",
  "code review CLI refuses caller authority: {\"signals\":{\"contested\":true}}",
  "code review CLI refuses caller authority: {\"gsd_role\":\"gsd-code-reviewer\"}",
  "code review CLI refuses caller authority: {\"context\":{\"code_review_prepared\":{}}}",
  "padded code review role cannot bypass host preparation: \" code-review \"",
  "padded code review role cannot bypass host preparation: \"\\tcode-review\\n\"",
  "padded code review request file refuses caller authority: {\"context\":{\"prompt\":\"caller\"}}",
  "padded code review request file refuses caller authority: {\"signals\":{\"critical\":true}}",
  "code review refuses changes before verdict sealing: agent",
  "code review refuses changes before verdict sealing: head",
  "code review refuses changes before verdict sealing: base",
  "code review refuses changes before verdict sealing: file-input",
  "code review refuses changes before verdict sealing: receipt",
  "code review delivery rejects a mismatched prepared context: look-alike",
  "code review delivery rejects a mismatched prepared context: ticket",
  "code review delivery rejects a mismatched prepared context: phase",
  "code review delivery rejects a mismatched prepared context: worktree",
  "code review delivery rejects a mismatched prepared context: prompt",
  "code review delivery rejects a mismatched prepared context: signals",
  "code review delivery rejects a mismatched prepared context: dispatch",
  "code review delivery rejects a mismatched prepared context: sandbox",
  "code review delivery rejects a mismatched prepared context: selector",
  "code review argument validation refuses caller prompts, signals and selectors",
  "code review launch preflight refuses semicolon repository identity before preparing evidence",
  "code review wrapper refuses installed or live changes immediately before launch: agent",
  "code review wrapper refuses installed or live changes immediately before launch: head",
  "code review wrapper refuses installed or live changes immediately before launch: base",
  "public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final",
  "public Codex v3 accepts omitted capacity through original observed evidence"
]) test(name, collected.get(name));
assert.equal(entrySelected, 44, 'exact code-review entry registration');
assert.equal(entryVariants, 8, 'all original CLI variants');
assert.equal(integratorDefaultSelected, 1, 'exact integrator default registration');
assert.equal(legacyCompatibilitySelected, 1, 'exact legacy compatibility registration');
}







}

module.exports = { registerTests };

if (require.main === module) {
  const selectionArgs = process.argv.slice(2);
  validateSelection(selectionArgs);
  const lifecycle = createRuntimeLifecycle();
  const runtime = lifecycle.start();
  const context = runtime.delivery;
  const { suite, test, done } = require('./assert-harness.cjs');
  registerTests((name, callback) => test(name, () => runtime.run(callback)), context, { suite, selectionArgs });
  done();
}
