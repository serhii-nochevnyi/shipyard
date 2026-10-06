'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

// Load every producer/consumer from one isolated candidate, never a mixture.
const selectedRoot = process.env.SHIPYARD_TEST_PACKAGE_ROOT;
if (selectedRoot !== undefined && (!path.isAbsolute(selectedRoot)
    || !fs.existsSync(selectedRoot) || !fs.statSync(selectedRoot).isDirectory())) {
  throw new Error('SHIPYARD_TEST_PACKAGE_ROOT must be an absolute existing package root');
}
const packageRoot = fs.realpathSync(selectedRoot || path.resolve(__dirname, '../../plugins/delivery-pipeline'));
const load = (name) => require(path.join(packageRoot, 'scripts', name + '.cjs'));
const builder = load('deliver-dispatch');
const delivery = load('codex-delivery-host');
const planning = load('codex-planning-context-host');
const decompose = load('codex-decompose-host');
const contract = load('run-contract');
const { createRunScope } = load('run-scope');
const { createRunController } = load('run-controller');
const { createPlanningWriterLease } = load('planning-writer-lease');
const policy = load('model-policy');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ADR = '---\nstatus: accepted\n---\n# ADR-TEST\n\n## Decision\n\n- Use the supported planning hosts.\n';
const capabilities = {
  supportedModels: ['gpt-6.1-sol'], supportedEfforts: ['high', 'xhigh'],
  supportedSelections: [{ model: 'gpt-6.1-sol', effort: 'high' }, { model: 'gpt-6.1-sol', effort: 'xhigh' }],
};

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-launch-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const write = (relative, bytes) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  fs.mkdirSync(root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Launch Contract Test');
  git('config', 'user.email', 'launch@example.test');
  write('plugins/delivery-pipeline/.claude-plugin/plugin.json', '{"name":"shipyard"}');
  write('.planning/graph/tickets.json', JSON.stringify({ tickets: {
    'T-47-99': { phase: 47, files: [], branch: 'main' },
  } }));
  write('.planning/graph/delivery-state.json', '{}');
  write('.planning/investigations/INV-TEST/PROBLEM.md', '---\nadr: .planning/architecture/ADR-TEST.md\n---\n# Problem\n');
  write('.planning/investigations/INV-TEST/RESEARCH-CONTRACT.md', '# Research contract\n');
  write('.planning/investigations/INV-TEST/DECISIONS.md', '# Decisions\n');
  write('.planning/architecture/ADR-TEST.md', ADR);
  write('.planning/phases/47-test/47-CONTEXT.md', '# Phase context\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const graphDir = path.join(root, '.planning/graph');
  const buildArgs = (role = 'research', input = 'INV-TEST', runtime = 'codex') => [
    role, input, ...(role === 'decomposition' ? ['--phase', '47'] : []), '--runtime', runtime,
  ];
  const build = (...args) => builder.build(buildArgs(...args), { cwd: root, graphDir });
  const buildBytes = async (...args) => {
    let bytes = '';
    const code = await builder.main(['build', ...buildArgs(...args)], {
      write(value) { bytes += value; },
    }, { cwd: root, graphDir });
    assert.equal(code, 0);
    return bytes;
  };
  let requestNumber = 0;
  const requestFile = (request) => {
    const file = path.join(temp, `request-${++requestNumber}.json`);
    fs.writeFileSync(file, typeof request === 'string' ? request : JSON.stringify(request));
    return file;
  };
  const controller = createRunController({ storeDir: path.join(temp, 'runs') });
  const runScope = ({ repository, ...scope }, role) => createRunScope({
    ...scope, repository_id: repository || root, owner_id: controller.owner_id,
    dispatch: { ...policy.resolveDispatch({ runtime: 'codex', role }), dispatch_id: `dispatch-${scope.run_id}` },
  });
  const agentDir = path.join(temp, 'agents');
  fs.mkdirSync(agentDir);
  const selection = policy.resolveDispatch({ runtime: 'codex', role: 'research' });
  const content = [
    ...Object.entries({ id: policy.POLICY.id, version: selection.policy_version,
      hash: selection.policy_hash, runtime: 'codex', role: 'research', rung: selection.rung })
      .map(([key, value]) => `# shipyard-policy-${key} = "${value}"`),
    `name = "${selection.agent_file.replace(/\.toml$/, '')}"`,
    `model = "${selection.model}"`, `model_reasoning_effort = "${selection.effort}"`,
    'sandbox_mode = "read-only"', "developer_instructions = '''Research the scoped input.'''", '',
  ].join('\n');
  fs.writeFileSync(path.join(agentDir, selection.agent_file), content);
  const agentManifest = path.join(agentDir, '.shipyard-manifest.json');
  fs.writeFileSync(agentManifest, JSON.stringify({ policy_id: policy.POLICY.id,
    policy_version: selection.policy_version, policy_hash: selection.policy_hash,
    agent_files: [selection.agent_file], agent_digests: { [selection.agent_file]: digest(content) } }));
  const calls = [];
  const hostOptions = { storageRoot: path.join(temp, 'host'), agentDir, agentManifest,
    probe: { status: 'available', executable: 'controlled-codex', capabilities },
    env: { CODEX_HOME: path.join(temp, 'codex') },
    spawn(executable, argv, options) {
      calls.push({ executable, argv, options });
      throw new Error('controlled native launch boundary reached');
    } };
  const admitResearch = async (request, overrides = {}) => {
    const file = requestFile(request);
    const original = fs.readFileSync(file);
    const parsed = delivery.readRequestFile(file);
    const run = runScope(parsed.scope, parsed.launch.role);
    controller.begin(run);
    try {
      const host = delivery.createCodexDeliveryHost({ ...hostOptions, ...overrides,
        scope: parsed.scope, controller });
      return await host.run(parsed.launch);
    } finally {
      controller.fail(run.run_id, { reason: 'controlled boundary fixture' });
      assert.deepEqual(fs.readFileSync(file), original, 'host must consume unchanged builder bytes');
    }
  };
  return { temp, root, git, write, build, buildBytes, requestFile, controller, runScope, calls, hostOptions, admitResearch };
}

test('candidate selection refuses relative and nonexistent package roots', () => {
  for (const selected of ['plugins/delivery-pipeline', path.join(os.tmpdir(), `missing-package-${crypto.randomUUID()}`)]) {
    const result = spawnSync(process.execPath, [__filename], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, SHIPYARD_TEST_PACKAGE_ROOT: selected },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /SHIPYARD_TEST_PACKAGE_ROOT must be an absolute existing package root/);
  }
});

test('unchanged research builder bytes reach the actual parser, controller and protected native launcher', async (t) => {
  const f = fixture(t);
  const bytes = await f.buildBytes();
  const request = JSON.parse(bytes);
  const result = await f.admitResearch(bytes);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].executable, 'controlled-codex');
  assert.ok(f.calls[0].argv.includes('--ignore-user-config'));
  assert.ok(f.calls[0].argv.some((arg) => arg.includes('permissions')));
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'RUNTIME_UNAVAILABLE');
  assert.match(result.cause, /controlled native launch boundary reached/);
  assert.equal(request.scope.ticket, 'INV-TEST');
  assert.equal(request.scope.phase, 47);
  assert.notEqual(f.build().scope.run_id, request.scope.run_id);
});

test('missing scope, wrong execution role and foreign repository refuse before native launch', async (t) => {
  const f = fixture(t);
  for (const field of ['run_id', 'ticket', 'phase', 'worktree']) {
    const request = f.build();
    delete request.scope[field];
    await assert.rejects(() => delivery.runCli(['--args-file', f.requestFile(request)], { write() {} }, f.hostOptions),
      { code: 'INVALID_INPUT' });
  }
  const executor = f.build();
  executor.role = 'executor';
  await assert.rejects(() => f.admitResearch(executor), { code: 'INVALID_INPUT' });
  const foreign = f.build();
  foreign.scope.repository = 'foreign/repository';
  await assert.rejects(() => delivery.runCli(['--args-file', f.requestFile(foreign)], { write() {} }, f.hostOptions),
    { code: 'SCOPE_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('missing capability or installed role evidence and altered packet bindings refuse pre-launch', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.admitResearch(f.build(), {
    probe: { status: 'unavailable', reason: 'capability_evidence_missing' },
  }), { code: 'RUNTIME_UNAVAILABLE' });
  const noCapabilities = await f.admitResearch(f.build(), {
    probe: { status: 'available', capabilities: { supportedModels: [], supportedEfforts: [] } },
  });
  assert.equal(noCapabilities.status, 'blocked');
  const noAgent = await f.admitResearch(f.build(), { agentDir: path.join(f.temp, 'missing-agents') });
  assert.equal(noAgent.status, 'blocked');
  for (const [field, value] of [['policy_hash', 'f'.repeat(64)], ['source_revision', 'f'.repeat(40)],
    ['role', 'decomposition'], ['canonical_root', f.temp]]) {
    const request = f.build();
    request.context.contextPacket[field] = value;
    const result = await f.admitResearch(request);
    assert.equal(result.status, 'blocked', field);
    assert.equal(result.code, 'CONTEXT_PACKET_IDENTITY', field);
  }
  const stale = f.build();
  fs.appendFileSync(path.join(f.root, '.planning/investigations/INV-TEST/PROBLEM.md'), 'altered\n');
  const result = await f.admitResearch(stale);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'STALE_CONTEXT_PACKET');
  assert.equal(f.calls.length, 0);
});

test('failed controller recovery is inspected before a coherent fresh builder attempt', (t) => {
  const f = fixture(t);
  const original = f.build();
  const parsed = delivery.readRequestFile(f.requestFile(original));
  const originalRun = f.runScope(parsed.scope, parsed.launch.role);
  const lease = createPlanningWriterLease({ worktree: f.root,
    phaseDir: path.join(f.root, '.planning/phases/47-test'), stateRoot: path.join(f.temp, 'writers') });
  const handle = lease.acquire({ owner: original.scope.run_id, base_revision: f.git('rev-parse', 'HEAD') });
  f.controller.begin(originalRun);
  f.controller.fail(originalRun.run_id, { reason: 'original runtime_unavailable refusal' });
  const recovery = f.controller.status(originalRun.run_id);
  assert.equal(recovery.state, 'failed');
  assert.equal(recovery.owner.status, 'failed');
  const before = fs.readFileSync(path.join(f.temp, 'runs', 'runs.json'));
  const mismatched = f.build();
  const mismatchedParsed = delivery.readRequestFile(f.requestFile(mismatched));
  const mismatchedRun = f.runScope(mismatchedParsed.scope, mismatchedParsed.launch.role);
  // Historical failure: fresh dispatch scope paired with the old controller id.
  assert.throws(() => f.controller.begin({ ...mismatchedRun, run_id: originalRun.run_id,
    lease: { ...mismatchedRun.lease, run_id: originalRun.run_id } }), { code: 'SCOPE_MISMATCH' });
  assert.throws(() => f.controller.begin(originalRun), { code: 'RUN_TERMINAL' });
  assert.deepEqual(fs.readFileSync(path.join(f.temp, 'runs', 'runs.json')), before);
  lease.release({ token: handle.token, epoch: handle.epoch });
  const fresh = f.build();
  const freshParsed = delivery.readRequestFile(f.requestFile(fresh));
  const freshRun = f.runScope(freshParsed.scope, freshParsed.launch.role);
  assert.notEqual(freshRun.run_id, originalRun.run_id);
  assert.notEqual(freshRun.run_id, mismatchedRun.run_id);
  const successor = lease.acquire({ owner: freshRun.run_id, base_revision: f.git('rev-parse', 'HEAD') });
  f.controller.begin(freshRun);
  assert.equal(f.controller.status(freshRun.run_id).state, 'running');
  assert.deepEqual(f.controller.status(originalRun.run_id), recovery);
  const current = JSON.parse(fs.readFileSync(path.join(f.temp, 'runs', 'runs.json')));
  assert.deepEqual(current.runs[originalRun.run_id], JSON.parse(before).runs[originalRun.run_id]);
  f.controller.fail(freshRun.run_id, { reason: 'fixture cleanup' });
  lease.release({ token: successor.token, epoch: successor.epoch });
});

test('unchanged direct accepted ADR and linked INV decomposition cross real planning CLI/run admission', async (t) => {
  const f = fixture(t);
  for (const input of ['ADR-TEST', 'INV-TEST']) {
    const output = await f.buildBytes('decomposition', input);
    const request = JSON.parse(output);
    const file = f.requestFile(output);
    const bytes = fs.readFileSync(file);
    await planning.runCli(['--args-file', file], { write() {} }, {
      runHost: async (argv) => {
        const parsed = decompose.readRequestFile(argv[1]);
        assert.equal(parsed.launch.gsd_role, 'gsd-planner');
        const role = decompose.ROLES[parsed.launch.gsd_role].role;
        const run = f.runScope(parsed.scope, role);
        f.controller.begin(run);
        assert.equal(contract.normalizeRunContract(run).dispatch.role, 'decomposition');
        assert.throws(() => f.runScope({ ...parsed.scope, phase: 48 }, role), { code: 'INVALID_INPUT' });
        assert.throws(() => f.runScope({ ...parsed.scope, repository: 'foreign/repository' }, role),
          { code: 'SCOPE_MISMATCH' });
        f.controller.fail(run.run_id, { reason: 'controlled admission complete; record admission belongs to T-47-06' });
      },
    });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.notEqual(f.build('decomposition', input).scope.run_id, request.scope.run_id);
  }
  const wrongRole = f.build('decomposition', 'ADR-TEST');
  wrongRole.gsd_role = 'gsd-phase-researcher';
  await assert.rejects(() => planning.runCli(['--args-file', f.requestFile(wrongRole)], { write() {} }, {
    runHost: async (argv) => {
      const parsed = decompose.readRequestFile(argv[1]);
      f.runScope(parsed.scope, decompose.ROLES[parsed.launch.gsd_role].role);
      assert.fail('ADR research cannot enter the controller');
    },
  }), { code: 'INVALID_INPUT' });
});

test('direct ADR refuses research, malformed or unaccepted sources and changed packet bytes', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.build('research', 'ADR-TEST'), /invalid investigation id/);
  assert.throws(() => f.build('decomposition', 'ADR-INVALID/escape'), /invalid planning input id/);
  for (const source of ['# No acceptance or decision\n', ADR.replace('accepted', 'proposed'),
    ADR.replace('## Decision', '## Notes'), ADR.replace('status: accepted', 'status: accepted\nstatus: proposed # conflict')]) {
    f.write('.planning/architecture/ADR-TEST.md', source);
    assert.throws(() => f.build('decomposition', 'ADR-TEST'), /accepted|decision/i);
  }
  f.write('.planning/architecture/ADR-TEST.md', ADR);
  const request = f.build('decomposition', 'ADR-TEST');
  f.write('.planning/architecture/ADR-TEST.md', ADR.replace('accepted', 'proposed'));
  await assert.rejects(() => planning.runCli(['--args-file', f.requestFile(request)], { write() {} }, {
    runHost() { assert.fail('changed ADR must refuse before delegation'); },
  }), /changed after packet construction/);
});
