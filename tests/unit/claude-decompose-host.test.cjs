'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { transcriptEvidence } = require('./claude-test-evidence.cjs');
const { ROLES, canonicalRequest, inlineReferences, trustedAgent, parseArguments, runDecomposition, recoverDecomposition } = require('../../plugins/delivery-pipeline/scripts/claude-decompose-host.cjs');
const { createPlanningWriterLease } = require('../../plugins/delivery-pipeline/scripts/planning-writer-lease.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createClaudeCliLauncher, createClaudeRuntimeHost, verifyCompletedClaudeLaunch } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-decompose-host-'));
  const worktree = path.join(root, 'project');
  const config = path.join(root, 'claude');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(config, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(config, 'gsd-core', 'references'), { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  for (const role of Object.keys(ROLES)) {
    fs.writeFileSync(path.join(config, 'agents', `${role}.md`),
      `---\nname: ${role}\ndescription: Test agent\ntools: Bash, Read, Edit, Write, Glob, Grep\nmodel: claude-sonnet-5\neffort: xhigh\n---\nUse @gsd-core/references/required.md\n`);
  }
  fs.writeFileSync(path.join(config, 'gsd-core', 'references', 'required.md'), 'Required GSD instruction.\n');
  return { root, worktree, config, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function request(worktree, role) {
  return { phase: 38, worktree, role, prompt: 'Create the phase plan.' };
}

function preparedPhaseFixture() {
  const f = fixture();
  execFileSync('git', ['-C', f.worktree, 'config', 'user.name', 'Decompose Host Test']);
  execFileSync('git', ['-C', f.worktree, 'config', 'user.email', 'decompose-host@example.test']);
  fs.writeFileSync(path.join(f.worktree, 'README.md'), '# test\n');
  execFileSync('git', ['-C', f.worktree, 'add', 'README.md']);
  execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  const phaseDir = path.join(fs.realpathSync(f.worktree), '.planning', 'phases', '38-test-phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Context\n');
  fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Plan\n');
  return { ...f, phaseDir };
}

function successDependencies(f, { store, writerLease, onLaunch, mutateEvidence } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      configRoot: f.config,
      store,
      ...(writerLease ? { writerLease } : {}),
      resolveDispatch: ({ runtime, role: boundaryRole, dispatch_id }) => ({
        runtime, role: boundaryRole, dispatch_id, model: 'claude-opus-5-5', effort: 'medium',
      }),
      probe: () => ({ status: 'available', executable: 'claude', runtime_version: 'test' }),
      runtimeHostFactory: ({ recorder, controller, scope }) => ({
        recorder, controller, scope,
        capabilities: { supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true },
        typedGsdCallback: async (prompt, options, launchedRole) => {
          calls.push({ prompt, options, launchedRole });
          if (onLaunch) await onLaunch();
          const evidence = transcriptEvidence({
            launch_id: `launch-${launchedRole}`, applied_model: options.model,
            applied_effort: options.effort, observed_model: options.model,
            observed_effort: options.effort, gsd_role: launchedRole,
            gsd_launch_mechanism: options.gsd_launch_mechanism,
          });
          if (mutateEvidence) mutateEvidence(evidence);
          return evidence;
        },
        applicationEvidence: ({ result }) => result,
      }),
    },
  };
}

const HELP_MARKERS = [
  '--model', '--effort', '--output-format', 'stream-json', '--session-id',
  '--permission-mode', '--permission-prompts', '--allowedTools', '--tools',
  '--restricted', '--strict-mcp-config', '--settings', '--agent', '--agents',
];

function fakeAvailableClaudeBin(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const script = path.join(bin, 'claude');
  fs.writeFileSync(script, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('claude 1.0.0 (fake)\\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(${JSON.stringify(HELP_MARKERS.join(' '))} + '\\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n'); process.exit(0); }
process.exit(1);
`);
  fs.chmodSync(script, 0o755);
  return bin;
}

test('accepts exactly three canonical typed roles and rejects injected request authority', () => {
  const f = fixture();
  try {
    for (const role of Object.keys(ROLES)) {
      const scope = canonicalRequest(request(f.worktree, role));
      assert.equal(scope.ticket, 'T-38-DECOMPOSE');
      assert.equal(scope.role, role);
      assert.equal(scope.worktree, fs.realpathSync(f.worktree));
    }
    assert.equal(canonicalRequest({ ...request(f.worktree, 'gsd-planner'),
      prompt: 'Read CONTEXT.md\nPlan the phase.\n' }).prompt,
    'Read CONTEXT.md\nPlan the phase.\n');
    assert.throws(() => canonicalRequest(request(f.worktree, 'claude')), { code: 'UNSUPPORTED_ROLE' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), model: 'sonnet' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), effort: 'low' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), agentFile: '/tmp/evil' }), { code: 'INVALID_INPUT' });
    assert.throws(() => canonicalRequest({ ...request(f.worktree, 'gsd-planner'), signals: { critical: 'true' } }), { code: 'INVALID_SIGNAL' });
    assert.deepEqual(parseArguments(['--capability-only']), { capabilityOnly: true });
    assert.deepEqual(parseArguments(['recover', '--dispatch', 'decompose-test']), { recoverDispatch: 'decompose-test' });
    assert.throws(() => parseArguments(['--host-module', 'evil.js']), { code: 'INVALID_INPUT' });
  } finally { f.clean(); }
});

test('inlines only bounded trusted GSD references and refuses missing or symlinked sources', () => {
  const f = fixture();
  try {
    const prompt = trustedAgent('gsd-planner', f.config);
    assert.match(prompt, /Required GSD instruction/);
    assert.doesNotMatch(prompt, /@gsd-core\/references\/required\.md/);
    assert.throws(() => inlineReferences('@gsd-core/references/../secrets.md', path.join(f.config, 'gsd-core')), { code: 'REFERENCE_UNAVAILABLE' });
    fs.rmSync(path.join(f.config, 'gsd-core', 'references', 'required.md'));
    fs.symlinkSync('/etc/hosts', path.join(f.config, 'gsd-core', 'references', 'required.md'));
    assert.throws(() => trustedAgent('gsd-planner', f.config), { code: 'REFERENCE_UNAVAILABLE' });
  } finally { f.clean(); }
});

test('removes inert source model and effort fields before building the explicit typed agent', () => {
  const f = fixture();
  try {
    for (const role of Object.keys(ROLES)) {
      const agent = trustedAgent(role, f.config);
      assert.doesNotMatch(agent, /^model:/m);
      assert.doesNotMatch(agent, /^effort:/m);
      assert.match(agent, new RegExp(`name: ${role}`));
      assert.match(agent, /Required GSD instruction/);
    }
  } finally { f.clean(); }
});

test('routes each role through the boundary and durably records exact-role evidence', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['-C', f.worktree, 'config', 'user.name', 'Decompose Host Test']);
    execFileSync('git', ['-C', f.worktree, 'config', 'user.email', 'decompose-host@example.test']);
    fs.writeFileSync(path.join(f.worktree, 'README.md'), '# test\n');
    execFileSync('git', ['-C', f.worktree, 'add', 'README.md']);
    execFileSync('git', ['-C', f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    const phaseDir = path.join(fs.realpathSync(f.worktree), '.planning', 'phases', '38-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), '# Context\n');
    fs.writeFileSync(path.join(phaseDir, '38-01-PLAN.md'), '# Plan\n');
    for (const role of Object.keys(ROLES)) {
      const calls = [];
      const output = await runDecomposition(request(f.worktree, role), {
        configRoot: f.config,
        store: path.join(f.root, `store-${role}`),
        resolveDispatch: ({ runtime, role: boundaryRole, dispatch_id }) => ({
          runtime, role: boundaryRole, dispatch_id, model: 'claude-opus-5-5', effort: 'medium',
        }),
        probe: () => ({ status: 'available', executable: 'claude', runtime_version: 'test' }),
        runtimeHostFactory: ({ recorder, controller, scope, gsdAgentRoot }) => ({
          recorder, controller, scope,
          capabilities: { supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true },
          typedGsdCallback: async (prompt, options, launchedRole) => {
            const agent = fs.readFileSync(path.join(gsdAgentRoot, `${launchedRole}.md`), 'utf8');
            assert.doesNotMatch(agent, /^(model|effort):/m);
            calls.push({ prompt, options, launchedRole, gsdAgentRoot });
            return transcriptEvidence({
              launch_id: `launch-${launchedRole}`, applied_model: options.model,
              applied_effort: options.effort, observed_model: options.model,
              observed_effort: options.effort, gsd_role: launchedRole,
              gsd_launch_mechanism: options.gsd_launch_mechanism,
            });
          },
          applicationEvidence: ({ result }) => result,
        }),
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].launchedRole, role);
      assert.equal(calls[0].options.model, 'claude-opus-5-5');
      assert.equal(calls[0].options.effort, 'medium');
      assert.equal(output.receipt.compliance, 'verified');
      assert.equal(output.receipt.gsd_role, role);
      assert.equal(output.receipt.applied_model, 'claude-opus-5-5');
      assert.equal(output.receipt.applied_effort, 'medium');
      const launchFiles = fs.readdirSync(path.join(f.root, `store-${role}`, 'launches'));
      assert.equal(launchFiles.length, 1);
      const launchPath = path.join(f.root, `store-${role}`, 'launches', launchFiles[0]);
      const savedLaunch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
      assert.equal(savedLaunch.dispatch_id, output.dispatch_id);
      assert.equal(savedLaunch.run_id, output.run_id);
      assert.equal(typeof savedLaunch.session_id, 'string');
      assert.ok(savedLaunch.tree_snapshot.digests);
      assert.equal(fs.statSync(launchPath).mode & 0o077, 0);
      assert.equal(fs.existsSync(calls[0].gsdAgentRoot), false);
      const files = fs.readdirSync(path.join(f.root, `store-${role}`, 'receipts'));
      assert.ok(files.some((file) => file.startsWith('record-')));
      const state = JSON.parse(fs.readFileSync(path.join(f.root, `store-${role}`, 'runs', 'runs.json'), 'utf8'));
      assert.equal(state.runs[output.run_id].run.state, 'completed');
      if (ROLES[role] === 'decomposition') {
        assert.equal(output.envelope.schema, 'shipyard.decomposition-result.v1');
        assert.equal(output.envelope.role, 'decomposition');
        assert.equal(output.envelope.plan_count, 2);
        assert.ok(fs.existsSync(output.envelope.artifact_index.path));
        const manifest = JSON.parse(fs.readFileSync(output.envelope.artifact_index.path, 'utf8'));
        assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), [
          path.join(phaseDir, '38-01-PLAN.md'),
          path.join(phaseDir, 'CONTEXT.md'),
        ].sort());
      } else {
        assert.equal(output.envelope, undefined);
      }
    }
  } finally { f.clean(); }
});

test('executable entrypoint rejects unsupported role before invoking Claude', () => {
  const f = fixture();
  try {
    const input = path.join(f.root, 'request.json');
    fs.writeFileSync(input, JSON.stringify(request(f.worktree, 'general-purpose')));
    const result = require('node:child_process').spawnSync(process.execPath,
      ['plugins/delivery-pipeline/scripts/claude-decompose-host.cjs', '--request-file', input],
      { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UNSUPPORTED_ROLE/);
    assert.equal(result.stdout, '');
    const lines = result.stderr.split('\n');
    assert.match(lines[0], /UNSUPPORTED_ROLE/);
    assert.match(lines[1], /^hint\[UNSUPPORTED_ROLE\]: /);
  } finally { f.clean(); }
});

test('capability-only failure JSON keeps every existing key and adds a hint', () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.config, 'agents', 'gsd-phase-researcher.md'));
    fs.symlinkSync('/etc/hosts', path.join(f.config, 'agents', 'gsd-phase-researcher.md'));
    const bin = fakeAvailableClaudeBin(f.root);
    const childEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: f.config };
    for (const key of ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'SHIPYARD_RUNTIME',
      'GSD_RUNTIME', 'SHIPYARD_GSD_TOOLS', 'GSD_TOOLS', 'GSD_CORE_HOME']) delete childEnv[key];
    const result = require('node:child_process').spawnSync(process.execPath,
      ['plugins/delivery-pipeline/scripts/claude-decompose-host.cjs', '--capability-only'],
      {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000,
        env: childEnv,
      });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'unavailable');
    assert.equal(payload.reason, 'REFERENCE_UNAVAILABLE');
    assert.equal(typeof payload.detail, 'string');
    assert.equal(payload.live_execution, 'not_run');
    assert.match(payload.hint, /^hint\[REFERENCE_UNAVAILABLE\]: .+ — remedy: .+$/);
  } finally { f.clean(); }
});

test('refuses missing, wrong, or cross-session typed role evidence', async () => {
  const f = preparedPhaseFixture();
  try {
    for (const invalid of [
      (evidence) => { delete evidence.gsd_agent_evidence; },
      (evidence) => { evidence.gsd_agent_evidence.session_start_agent_type = 'gsd-planner'; },
      (evidence) => { evidence.gsd_agent_evidence.transcript_agent_setting = 'gsd-planner'; },
      (evidence) => { evidence.gsd_agent_evidence.session_id = 'other-session'; },
      (evidence) => { evidence.observed_effort = 'high'; },
      (evidence) => { evidence.applied_effort = 'high'; },
      (evidence) => { evidence.observed_model = 'claude-sonnet-5'; },
    ]) {
      const store = path.join(f.root, `invalid-${crypto.randomUUID()}`);
      await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), {
        configRoot: f.config, store,
        resolveDispatch: ({ runtime, role, dispatch_id }) => ({ runtime, role, dispatch_id,
          model: 'claude-opus-5-5', effort: 'medium' }),
        probe: () => ({ status: 'available' }),
        runtimeHostFactory: ({ recorder }) => ({
          recorder,
          capabilities: { supportedModels: ['claude-opus-5-5'], supportedEfforts: ['medium'], observedModel: true, observedEffort: true },
          typedGsdCallback: async (prompt, options, role) => {
            const evidence = transcriptEvidence({ launch_id: `launch-${crypto.randomUUID()}`,
              applied_model: options.model, applied_effort: options.effort,
              observed_model: options.model, observed_effort: options.effort,
              gsd_role: role, gsd_launch_mechanism: options.gsd_launch_mechanism });
            invalid(evidence);
            return evidence;
          },
          applicationEvidence: ({ result }) => result,
        }),
      }));
      const receiptFiles = fs.existsSync(path.join(store, 'receipts'))
        ? fs.readdirSync(path.join(store, 'receipts')).filter((file) => file.startsWith('record-')) : [];
      assert.equal(receiptFiles.length, 0);
    }
  } finally { f.clean(); }
});

test('a second session planning the same worktree and phase is refused with WRITER_LEASED before any model launch', async () => {
  const f = preparedPhaseFixture();
  try {
    const stateRoot = fs.mkdtempSync(path.join(f.root, 'lease-state-'));
    const writerLease = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir, stateRoot });
    writerLease.acquire({ owner: 'other-session', base_revision: 'deadbeef' });
    const { deps, calls } = successDependencies(f, { store: path.join(f.root, 'store-second-session'), writerLease });
    await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), deps),
      (error) => error.code === 'WRITER_LEASED');
    assert.equal(calls.length, 0);
  } finally { f.clean(); }
});

test('different phases in the same worktree do not contend for the planning writer lease', async () => {
  const f = preparedPhaseFixture();
  try {
    const otherPhaseDir = path.join(fs.realpathSync(f.worktree), '.planning', 'phases', '39-other-phase');
    fs.mkdirSync(otherPhaseDir, { recursive: true });
    fs.writeFileSync(path.join(otherPhaseDir, 'CONTEXT.md'), '# Context\n');
    fs.writeFileSync(path.join(otherPhaseDir, '39-01-PLAN.md'), '# Plan\n');
    const stateRoot = fs.mkdtempSync(path.join(f.root, 'lease-state-'));
    const leaseA = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir, stateRoot });
    leaseA.acquire({ owner: 'holder-of-phase-38', base_revision: 'deadbeef' });
    const leaseB = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: otherPhaseDir, stateRoot });
    const otherRequest = { phase: 39, worktree: f.worktree, role: 'gsd-plan-checker', prompt: 'Check the other phase.' };
    const { deps } = successDependencies(f, { store: path.join(f.root, 'store-phase-39'), writerLease: leaseB });
    const output = await runDecomposition(otherRequest, deps);
    assert.equal(output.receipt.compliance, 'verified');
  } finally { f.clean(); }
});

test('a lease takeover before sealing refuses with WRITER_FENCED and seals nothing', async () => {
  const f = preparedPhaseFixture();
  try {
    let clock = 1_000;
    const stateRoot = fs.mkdtempSync(path.join(f.root, 'lease-state-'));
    const writerLease = createPlanningWriterLease({
      worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir, stateRoot, now: () => clock, ttlMs: 100,
    });
    const store = path.join(f.root, 'store-takeover');
    const { deps } = successDependencies(f, {
      store, writerLease,
      onLaunch: () => { clock += 500; writerLease.acquire({ owner: 'intruder', base_revision: 'deadbeef' }); },
    });
    await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), deps),
      (error) => error.code === 'WRITER_FENCED');
    assert.equal(fs.existsSync(path.join(store, 'decomposition-index')), false);
  } finally { f.clean(); }
});

test('a foreign edit to the phase directory mid-run refuses with FOREIGN_EDIT, naming the path', async () => {
  const f = preparedPhaseFixture();
  try {
    const store = path.join(f.root, 'store-foreign-edit');
    const { deps } = successDependencies(f, {
      store,
      onLaunch: () => { fs.writeFileSync(path.join(f.phaseDir, 'stray.md'), 'stray\n'); },
    });
    await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), deps),
      (error) => error.code === 'FOREIGN_EDIT' && /stray\.md/.test(error.message)
        && error.message.includes(`dispatch_id=${error.dispatch_id}`)
        && error.message.includes(`run_id=${error.run_id}`));
    assert.equal(fs.existsSync(path.join(store, 'decomposition-index')), false);
  } finally { f.clean(); }
});

test('the planning writer lease releases on success and on failure so a following run acquires immediately', async () => {
  const f = preparedPhaseFixture();
  try {
    const successStateRoot = fs.mkdtempSync(path.join(f.root, 'lease-state-success-'));
    const successLease = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir, stateRoot: successStateRoot });
    const { deps: successDeps } = successDependencies(f, { store: path.join(f.root, 'store-release-success'), writerLease: successLease });
    const output = await runDecomposition(request(f.worktree, 'gsd-plan-checker'), successDeps);
    assert.equal(output.receipt.compliance, 'verified');
    assert.doesNotThrow(() => successLease.acquire({ owner: 'a-following-run', base_revision: 'deadbeef' }));

    const failureStateRoot = fs.mkdtempSync(path.join(f.root, 'lease-state-failure-'));
    const failureLease = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir, stateRoot: failureStateRoot });
    const { deps: failureDeps } = successDependencies(f, {
      store: path.join(f.root, 'store-release-failure'), writerLease: failureLease,
      mutateEvidence: (evidence) => { delete evidence.gsd_agent_evidence; },
    });
    await assert.rejects(runDecomposition(request(f.worktree, 'gsd-plan-checker'), failureDeps),
      (error) => error.code === 'NONCOMPLIANT_RECEIPT');
    assert.doesNotThrow(() => failureLease.acquire({ owner: 'a-following-run', base_revision: 'deadbeef' }));
  } finally { f.clean(); }
});

function recoveryFixture(role, { cli = false } = {}) {
  const f = preparedPhaseFixture();
  const worktree = fs.realpathSync(f.worktree);
  const repository = fs.realpathSync(path.resolve(worktree, execFileSync('git',
    ['-C', worktree, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()));
  const store = cli ? path.join(f.root, '.local', 'state', 'shipyard', 'claude-decompose',
    digestValue(`${repository}\n${worktree}\n38`)) : path.join(f.root, 'recovery-store');
  const dispatchId = `decompose-${crypto.randomUUID()}`;
  const runId = `decompose-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const resolution = { model: 'claude-opus-5-5', effort: 'medium',
    ...(cli ? { policy_hash: require('../../plugins/delivery-pipeline/scripts/model-policy.cjs').POLICY_HASH,
      policy_version: 'adr-014.v6', rung: 'base' } : {}) };
  const writerLease = createPlanningWriterLease({ worktree: fs.realpathSync(f.worktree), phaseDir: f.phaseDir,
    stateRoot: path.join(store, 'writer') });
  const head = execFileSync('git', ['-C', f.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const handle = writerLease.acquire({ owner: 'completed-host', base_revision: head });
  const snapshot = writerLease.snapshotTree();
  writerLease.release({ token: handle.token, epoch: handle.epoch });
  fs.writeFileSync(path.join(f.phaseDir, '38-01-PLAN.md'), '# Completed plan\n');
  const transcripts = path.join(store, 'transcripts');
  const nativeProject = path.join(f.config, 'projects', 'project-a');
  fs.mkdirSync(transcripts, { recursive: true, mode: 0o700 });
  fs.mkdirSync(nativeProject, { recursive: true });
  const nativeFile = path.join(nativeProject, `${sessionId}.jsonl`);
  const nativeRecords = [
    { type: 'agent-setting', sessionId, agentSetting: role },
    { type: 'assistant', sessionId, agentSetting: role, effort: resolution.effort,
      message: { role: 'assistant', model: resolution.model, content: 'completed' } },
  ];
  fs.writeFileSync(nativeFile, nativeRecords.map((item) => JSON.stringify(item)).join('\n') + '\n');
  const savedProject = path.join(transcripts, 'projects', 'project-a');
  fs.mkdirSync(savedProject, { recursive: true, mode: 0o700 });
  const savedNativeFile = path.join(savedProject, `${sessionId}.jsonl`);
  fs.copyFileSync(nativeFile, savedNativeFile);
  const startFile = path.join(transcripts, `${runId}-${sessionId}.session-start.json`);
  fs.writeFileSync(startFile, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
    session_id: sessionId, transcript_path: nativeFile, agent_type: role,
    cwd: fs.realpathSync(f.worktree) }), { mode: 0o600 });
  const streamFile = path.join(transcripts, `${runId}-${sessionId}.jsonl`);
  fs.writeFileSync(streamFile, [
    { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: 'completed' } },
    { type: 'result', session_id: sessionId, result: 'completed',
      structured_output: { changed_paths: ['38-01-PLAN.md'] } },
  ].map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const record = { dispatch_id: dispatchId, run_id: runId, session_id: sessionId,
    lease_epoch: handle.epoch, tree_snapshot: snapshot, request: request(f.worktree, role),
    resolution, child_pid: 99999999, start_evidence_file: startFile, transcript_path: streamFile,
    native_transcript_path: nativeFile, saved_native_transcript: savedNativeFile,
    saved_native_transcript_sha256: digest(savedNativeFile),
    saved_native_transcript_bytes: fs.statSync(savedNativeFile).size,
    start_evidence_sha256: digest(startFile),
    binding: { repository, worktree, phase: 38, ticket: 'T-38-DECOMPOSE', run_id: runId,
      role, request_sha256: digestValue(JSON.stringify({ role, phase: 38, worktree,
        prompt: 'Create the phase plan.', signals: {} })), model: resolution.model,
      effort: resolution.effort, policy_hash: resolution.policy_hash ?? null,
      policy_version: cli ? 'adr-014.v6' : null, policy_id: null,
      policy_rung: cli ? 'base' : null },
    completed: { stream_sha256: digest(streamFile), selection_sha256: digest(savedNativeFile),
      start_sha256: digest(startFile), declared_paths: ['38-01-PLAN.md'], changed_paths: ['38-01-PLAN.md'],
      artifact_digests: { '38-01-PLAN.md': digest(path.join(f.phaseDir, '38-01-PLAN.md')) } } };
  const launchFile = path.join(store, 'launches', `${digestValue(dispatchId)}.launch.json`);
  fs.mkdirSync(path.dirname(launchFile), { recursive: true, mode: 0o700 });
  const save = () => fs.writeFileSync(launchFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  save();
  const recorder = createDurableRecorder(path.join(store, 'receipts'));
  recorder.reserve(dispatchId);
  record.completed.reservation_at = recorder.getReservation(dispatchId).reserved_at;
  save();
  const priorConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.config;
  const deps = { store, writerLease,
    resolveDispatch: ({ runtime, role: boundaryRole, dispatch_id }) => ({
      runtime, role: boundaryRole, dispatch_id, ...resolution,
    }),
    runtimeHostFactory: () => { throw new Error('recovery launched Claude'); },
  };
  return { ...f, store, dispatchId, runId, sessionId, nativeFile: savedNativeFile, originalNativeFile: nativeFile,
    streamFile, record, save,
    recorder, deps, finish: () => {
      if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorConfig;
      f.clean();
    } };
}

function digestValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('a live Claude launcher saves evidence that verifies identically after the native transcript disappears', async () => {
  const f = preparedPhaseFixture();
  try {
    const role = 'gsd-planner';
    const sessionId = crypto.randomUUID();
    const runId = `decompose-${crypto.randomUUID()}`;
    const store = path.join(f.root, 'live-evidence');
    const transcriptDir = path.join(store, 'transcripts');
    const startFile = path.join(transcriptDir, `${runId}-${sessionId}.session-start.json`);
    const nativeDir = path.join(f.config, 'projects', 'project-a');
    fs.mkdirSync(nativeDir, { recursive: true });
    const nativeFile = path.join(nativeDir, `${sessionId}.jsonl`);
    fs.writeFileSync(nativeFile, [
      { type: 'agent-setting', sessionId, agentSetting: role },
      { type: 'assistant', sessionId, effort: 'medium', agentSetting: role,
        message: { role: 'assistant', model: 'claude-opus-5-5' } },
    ].map(JSON.stringify).join('\n') + '\n');
    const stream = [
      { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: 'completed' } },
      { type: 'result', session_id: sessionId, result: 'completed',
        structured_output: { changed_paths: ['38-01-PLAN.md'] } },
    ].map(JSON.stringify).join('\n') + '\n';
    let spawned = 0;
    let completed = 0;
    const launch = createClaudeCliLauncher({
      scope: { run_id: runId, ticket: 'T-38-DECOMPOSE', phase: 38, worktree: f.worktree,
        runtime: 'claude', provider: 'anthropic' },
      gsdAgentRoot: path.join(f.config, 'agents'),
      transcriptDir, startEvidenceFile: startFile,
      env: { CLAUDE_CONFIG_DIR: f.config }, transcriptPollMs: 1,
      onChildSpawn: (pid) => { assert.equal(pid, 24038); spawned++; },
      onCompleted: () => { completed++; },
      spawn: (executable, args) => {
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
        assert.equal(hookArgs[hookArgs.indexOf('--evidence-file') + 1], startFile);
        fs.writeFileSync(startFile, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
          session_id: sessionId, transcript_path: nativeFile, agent_type: role,
          cwd: path.resolve(f.worktree) }), { mode: 0o600 });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write() {}, end() {} };
        child.pid = 24038;
        process.nextTick(() => { child.stdout.emit('data', Buffer.from(stream)); child.emit('close', 0, null); });
        return child;
      },
    });
    const live = await launch('Create the plan.', { model: 'claude-opus-5-5', effort: 'medium',
      session_id: sessionId, gsd_role: role });
    assert.equal(spawned, 1);
    assert.equal(completed, 1);
    assert.ok(fs.existsSync(path.join(transcriptDir, 'projects', 'project-a', `${sessionId}.jsonl`)));
    fs.rmSync(nativeFile);
    const recovered = await verifyCompletedClaudeLaunch({ session_id: sessionId,
      start_evidence_file: startFile, transcript_path: live.applicationEvidence.transcript.path,
      model: 'claude-opus-5-5', effort: 'medium', gsd_role: role, worktree: f.worktree });
    assert.deepEqual(recovered.result, { status: live.status, summary: live.summary, output: live.output });
    assert.deepEqual(recovered.applicationEvidence.selection_evidence, live.applicationEvidence.selection_evidence);
    assert.deepEqual(recovered.applicationEvidence.gsd_agent_evidence, live.applicationEvidence.gsd_agent_evidence);
    assert.deepEqual(recovered.applicationEvidence.stream_evidence, live.applicationEvidence.stream_evidence);
  } finally { f.clean(); }
});

test('fixture launcher and no-relaunch recovery produce identical authenticated boundary receipt fields for one dispatch', async () => {
  const f = preparedPhaseFixture();
  const store = path.join(f.root, 'same-dispatch-store');
  const role = 'gsd-planner';
  const nativeDir = path.join(f.config, 'projects', 'fixture-project');
  fs.mkdirSync(nativeDir, { recursive: true });
  let launches = 0;
  let originalNativeFile;
  try {
    const deps = {
      configRoot: f.config, store,
      resolveDispatch: ({ runtime, role: boundaryRole, dispatch_id }) => ({
        runtime, role: boundaryRole, dispatch_id, model: 'claude-opus-5-5', effort: 'medium',
      }),
      probe: () => ({ status: 'available', executable: 'claude-fixture', runtime_version: 'fixture' }),
      runtimeHostFactory: (options) => createClaudeRuntimeHost({
        ...options, env: { CLAUDE_CONFIG_DIR: f.config }, transcriptPollMs: 1,
        spawn: (_executable, args) => {
          launches++;
          const sessionId = args[args.indexOf('--session-id') + 1];
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
          const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
          const startFile = hookArgs[hookArgs.indexOf('--evidence-file') + 1];
          originalNativeFile = path.join(nativeDir, `${sessionId}.jsonl`);
          fs.writeFileSync(originalNativeFile, [
            { type: 'agent-setting', sessionId, agentSetting: role },
            { type: 'assistant', sessionId, effort: 'medium', agentSetting: role,
              message: { role: 'assistant', model: 'claude-opus-5-5', content: 'completed' } },
          ].map(JSON.stringify).join('\n') + '\n');
          fs.writeFileSync(startFile, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
            session_id: sessionId, transcript_path: originalNativeFile, agent_type: role,
            cwd: fs.realpathSync(f.worktree) }), { mode: 0o600 });
          fs.writeFileSync(path.join(f.phaseDir, '38-01-PLAN.md'), '# Completed plan\n');
          const stream = [
            { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: 'completed' } },
            { type: 'result', session_id: sessionId, result: 'completed',
              structured_output: { changed_paths: ['38-01-PLAN.md'] } },
          ].map(JSON.stringify).join('\n') + '\n';
          const child = new EventEmitter();
          child.pid = 99999999;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = { write() {}, end() {} };
          process.nextTick(() => { child.stdout.emit('data', Buffer.from(stream)); child.emit('close', 0, null); });
          return child;
        },
      }),
    };
    const live = await runDecomposition(request(f.worktree, role), deps);
    assert.equal(launches, 1);
    const recorder = createDurableRecorder(path.join(store, 'receipts'));
    const originalReservation = recorder.getReservation(live.dispatch_id);
    assert.ok(originalReservation?.reserved_at);
    const liveRecord = recorder.getVerifiedRecord(live.dispatch_id);
    assert.ok(liveRecord, 'launcher receipt must come from the authenticated boundary record');
    assert.deepEqual(liveRecord.receipt, live.receipt);
    const launchFile = path.join(store, 'launches', `${digestValue(live.dispatch_id)}.launch.json`);
    const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    assert.equal(launch.native_transcript_path, originalNativeFile);
    assert.equal(launch.completed.reservation_at, originalReservation.reserved_at);
    const recordFile = path.join(store, 'receipts', `record-${digestValue(live.dispatch_id)}.json`);
    fs.rmSync(recordFile);
    assert.deepEqual(recorder.getReservation(live.dispatch_id), { ...originalReservation, recorded: false });
    fs.rmSync(originalNativeFile);
    const recoveryDeps = { ...deps,
      runtimeHostFactory: () => { throw new Error('recovery relaunched Claude'); },
    };
    const recovered = await recoverDecomposition(live.dispatch_id, recoveryDeps);
    assert.equal(launches, 1, 'recovery must make zero additional launcher calls');
    assert.equal(recovered.recovered, true);
    assert.equal(live.recovered, undefined);
    assert.equal(recovered.dispatch_id, live.dispatch_id);
    assert.equal(recovered.run_id, live.run_id);
    const recoveredRecord = recorder.getVerifiedRecord(live.dispatch_id);
    assert.ok(recoveredRecord, 'recovered receipt must be authenticated by the boundary recorder');
    assert.deepEqual(recoveredRecord.receipt, recovered.receipt);
    assert.deepEqual(recoveredRecord.resolution, liveRecord.resolution);
    assert.deepEqual(Object.keys(recovered.receipt).sort(), Object.keys(live.receipt).sort());
    for (const field of Object.keys(live.receipt)) {
      assert.deepEqual(recovered.receipt[field], live.receipt[field], `same-dispatch receipt field ${field}`);
    }
    assert.equal(recovered.receipt.dispatch_id, originalReservation.dispatch_id);
    assert.equal(recovered.receipt.gsd_role, role);
    assert.equal(recovered.receipt.applied_model, 'claude-opus-5-5');
    assert.equal(recovered.receipt.applied_effort, 'medium');
    assert.equal(recovered.receipt.selection_evidence.source, 'claude-session-assistant-transcript');
    assert.equal(recovered.receipt.gsd_agent_evidence.session_start_agent_type, role);
    assert.equal(recovered.receipt.gsd_agent_evidence.transcript_agent_setting, role);
    assert.ok(recovered.receipt.stream_evidence.records >= 2);
    assert.equal(recovered.receipt.transcript.sha256, live.receipt.transcript.sha256);
    assert.equal(recovered.receipt.policy_hash, live.receipt.policy_hash);
    assert.equal(recovered.receipt.policy_version, live.receipt.policy_version);
    assert.equal(recovered.receipt.compliance_proof.dispatch_id, originalReservation.dispatch_id);
    assert.equal(recorder.getReservation(live.dispatch_id).reserved_at, originalReservation.reserved_at);
  } finally { f.clean(); }
});

test('a missing child pid or failed synchronous pid persistence kills Claude before stdin', async () => {
  const f = preparedPhaseFixture();
  try {
    for (const pid of [undefined, -1, 24038]) {
      let stdinWrites = 0;
      let kills = 0;
      let persisted = 0;
      const launch = createClaudeCliLauncher({
        scope: { run_id: `decompose-${crypto.randomUUID()}`, ticket: 'T-38-DECOMPOSE',
          phase: 38, worktree: f.worktree, runtime: 'claude', provider: 'anthropic' },
        gsdAgentRoot: path.join(f.config, 'agents'), env: { CLAUDE_CONFIG_DIR: f.config },
        onChildSpawn: () => { persisted++; throw new Error('synchronous pid write failed'); },
        spawn: () => {
          const child = new EventEmitter();
          child.pid = pid;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = { write() { stdinWrites++; }, end() {} };
          child.kill = () => { kills++; return true; };
          return child;
        },
      });
      await assert.rejects(launch('Create the plan.', { model: 'claude-opus-5-5',
        effort: 'medium', session_id: crypto.randomUUID(), gsd_role: 'gsd-planner' }),
      { code: 'RUNTIME_UNAVAILABLE' });
      assert.equal(stdinWrites, 0);
      assert.equal(kills, 1);
      assert.equal(persisted, pid === 24038 ? 1 : 0);
    }
  } finally { f.clean(); }
});

test('a completed saved Claude launch recovers one receipt per judgment role with its original dispatch', async () => {
  for (const role of Object.keys(ROLES)) {
    const f = recoveryFixture(role);
    try {
      if (role === 'gsd-phase-researcher') fs.rmSync(f.originalNativeFile);
      const output = await recoverDecomposition(f.dispatchId, f.deps);
      assert.equal(output.dispatch_id, f.dispatchId);
      assert.equal(output.run_id, f.runId);
      assert.equal(output.receipt.dispatch_id, f.dispatchId);
      assert.equal(output.receipt.compliance, 'verified');
      assert.equal(output.receipt.gsd_role, role);
      assert.deepEqual(output.result.output.changed_paths, ['38-01-PLAN.md']);
      assert.equal(f.recorder.getReservation(f.dispatchId).recorded, true);
      assert.equal(ROLES[role] === 'decomposition', Boolean(output.envelope));
      await assert.rejects(recoverDecomposition(f.dispatchId, f.deps), { code: 'RECOVERY_ALREADY_RECORDED' });
    } finally { f.finish(); }
  }
});

test('recover --dispatch finds the private reservation and prints the recovered receipt', () => {
  const f = recoveryFixture('gsd-planner', { cli: true });
  try {
    const env = { ...process.env, HOME: f.root, CLAUDE_CONFIG_DIR: f.config, SHIPYARD_RUNTIME: 'claude' };
    for (const key of ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'GSD_RUNTIME',
      'SHIPYARD_GSD_TOOLS', 'GSD_TOOLS', 'GSD_CORE_HOME']) delete env[key];
    const result = require('node:child_process').spawnSync(process.execPath,
      ['plugins/delivery-pipeline/scripts/claude-decompose-host.cjs', 'recover', '--dispatch', f.dispatchId],
      { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10000, env });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.receipt.dispatch_id, f.dispatchId);
    assert.equal(output.recovered, true);
    assert.equal(f.recorder.getReservation(f.dispatchId).recorded, true);
  } finally { f.finish(); }
});

test('recovery refuses missing reservations, incomplete transcripts, mismatched selection, altered artifacts and live pids', async () => {
  const cases = [
    { code: 'RECOVERY_NO_RESERVATION', mutate: (f) => fs.rmSync(path.join(f.store, 'receipts'), { recursive: true }) },
    { code: 'RECOVERY_EVIDENCE_MISSING', mutate: (f) => fs.rmSync(f.streamFile) },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => fs.rmSync(f.record.start_evidence_file) },
    { code: 'RECOVERY_EVIDENCE_MISSING', mutate: (f) => fs.rmSync(f.nativeFile) },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { delete f.record.completed; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_MISSING', mutate: (f) => {
      fs.writeFileSync(f.nativeFile, JSON.stringify({ type: 'agent-setting', sessionId: f.sessionId,
        agentSetting: 'gsd-planner' }) + '\n');
      f.record.completed.selection_sha256 = digestValue(fs.readFileSync(f.nativeFile)); f.save();
    } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => {
      const records = fs.readFileSync(f.nativeFile, 'utf8').trim().split('\n').map(JSON.parse);
      records[1].effort = 'high';
      fs.writeFileSync(f.nativeFile, records.map(JSON.stringify).join('\n') + '\n');
      f.record.completed.selection_sha256 = digestValue(fs.readFileSync(f.nativeFile)); f.save();
    } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => {
      const records = fs.readFileSync(f.nativeFile, 'utf8').trim().split('\n').map(JSON.parse);
      records[1].message.model = 'claude-sonnet-5';
      fs.writeFileSync(f.nativeFile, records.map(JSON.stringify).join('\n') + '\n');
      f.record.completed.selection_sha256 = digestValue(fs.readFileSync(f.nativeFile)); f.save();
    } },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => fs.appendFileSync(f.streamFile, '\n') },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => {
      fs.appendFileSync(f.record.start_evidence_file, ' ');
    } },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => fs.writeFileSync(path.join(f.phaseDir, 'stray.md'), 'stray\n') },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => fs.writeFileSync(path.join(f.phaseDir, '38-01-PLAN.md'), '# tampered\n') },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { delete f.record.child_pid; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.child_pid = -1; f.save(); } },
    { code: 'RECOVERY_UNKNOWN_LIVE', mutate: (f) => { f.record.child_pid = process.pid; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.request.prompt = 'Substituted'; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.binding.policy_hash = 'substituted'; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.completed.reservation_at = 'substituted'; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.lease_epoch++; f.save(); } },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => { f.record.saved_native_transcript_bytes++; f.save(); } },
    { code: 'RECOVERY_EVIDENCE_INCOMPLETE', mutate: (f) => { f.record.saved_native_transcript = f.streamFile; f.save(); } },
    { code: 'RECOVERY_ARTIFACT_ALTERED', mutate: (f) => { f.record.completed.declared_paths = []; f.save(); } },
  ];
  for (const { code, mutate } of cases) {
    const f = recoveryFixture('gsd-planner');
    try {
      mutate(f);
      await assert.rejects(recoverDecomposition(f.dispatchId, f.deps), { code });
      assert.notEqual(f.recorder.getReservation(f.dispatchId)?.recorded, true);
    } finally { f.finish(); }
  }
});
