'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');

const overhead = require('../../plugins/delivery-pipeline/scripts/orchestration-overhead.cjs');
const roleArtifact = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
const { CLAUDE_MODEL_ALIASES } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { registerClaudeWorkflowHost } = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');
const { execFileSync } = require('node:child_process');
const {
  buildContextPacket,
} = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-'));
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(path.join(graph, '.locks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'backlog'), { recursive: true });
  const policy = 'Live delivery policy: preserve all mandatory gates.\n';
  const plan = '# T-33-07\n\n## Scope\n- src/example.js\n';
  fs.writeFileSync(path.join(root, 'POLICY.md'), policy);
  fs.writeFileSync(path.join(root, 'PLAN.md'), plan);
  fs.writeFileSync(path.join(root, 'src-example.js'), 'module.exports = true;\n');
  return { root, graph, policy, plan };
}

function identity(overrides = {}) {
  return {
    observation_id: 'startup-1',
    run_id: 'run-33-07',
    dispatch_id: 'dispatch-33-07',
    role: 'executor',
    runtime: 'claude',
    backend: 'workflow',
    policy_hash: 'a'.repeat(64),
    treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
    stage: 'startup',
    bytes: 400,
    estimated_tokens: 100,
    estimator_version: overhead.ESTIMATOR_VERSION,
    provider_tokens: null,
    ...overrides,
  };
}

function packetOptions(f, recorder, overrides = {}) {
  return {
    root: f.root,
    role: 'executor',
    subject: 'T-33-07',
    sourceRevision: 'b'.repeat(40),
    policy: { path: path.join(f.root, 'POLICY.md'), content: f.policy },
    policyHash: sha256(f.policy),
    planPath: path.join(f.root, 'PLAN.md'),
    scope: { files_modified: ['src-example.js'] },
    acceptance: ['Preserve mandatory gates.'],
    verification: ['node tests/unit/orchestration-overhead.test.cjs'],
    backend: 'workflow',
    selectedBacklogIds: [],
    dispatchId: 'dispatch-packet',
    runId: 'run-packet',
    runtime: 'claude',
    treatments: { wait_events: 'baseline', bounded_context: 'opt-07' },
    overheadRecorder: recorder,
    ...overrides,
  };
}

function git(root, args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }

suite('T-33-07 — orchestration overhead and independent treatments');

test('records metadata-only observations idempotently and rejects cross-runtime identity reuse', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const first = recorder.record(identity({
      source_refs: [{ path: 'PLAN.md', sha256: sha256(f.plan), bytes: Buffer.byteLength(f.plan) }],
    }));
    assert.equal(first.recorded.length, 1);
    const duplicate = recorder.record(identity({
      source_refs: [{ path: 'PLAN.md', sha256: sha256(f.plan), bytes: Buffer.byteLength(f.plan) }],
    }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(recorder.read().rows.length, 1, 'a retry must not double count an observation');
    assert.throws(
      () => recorder.record(identity({ runtime: 'codex' })),
      (error) => error && error.code === 'OBSERVATION_ID_CONFLICT',
    );
    const raw = fs.readFileSync(path.join(f.graph, overhead.STREAM_NAME), 'utf8');
    assert.equal(raw.includes(f.plan), false, 'the stream must not contain source or prompt bodies');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('the real packet builder records startup bytes and estimated tokens with treatment identity', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    const packet = buildContextPacket(packetOptions(f, recorder));
    const rows = recorder.read().rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'startup');
    assert.equal(rows[0].bytes, packet.accounting.estimated_bytes);
    assert.equal(rows[0].estimated_tokens, packet.accounting.estimated_tokens);
    assert.equal(rows[0].estimator_version, overhead.ESTIMATOR_VERSION);
    assert.equal(rows[0].treatment.bounded_context, 'opt-07');
    assert.ok(rows[0].source_refs.some((ref) => ref.path === 'PLAN.md'));
    assert.equal(rows[0].source_refs[0].content, undefined);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('actor defaults to null, rejects unknown values, and preserves legacy observation identity', () => {
  const normalized = overhead.normalizeObservation(identity());
  assert.equal(normalized.actor, null);
  assert.throws(() => overhead.normalizeObservation(identity({ actor: 'worker' })),
    (error) => error && error.code === 'INVALID_OBSERVATION' && /actor/.test(error.message));
  assert.equal(overhead.normalizeObservation(identity()).observation_id,
    overhead.normalizeObservation({ ...identity(), actor: null }).observation_id);
});

test('targeted role-artifact consumption records selected bytes separately from the full evidence file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-artifact-'));
  const ticket = 'T-33-07-artifact';
  const graph = path.join(root, '.planning', 'graph');
  const receipts = path.join(root, 'receipts');
  fs.mkdirSync(graph, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'overhead@example.test']);
  git(root, ['config', 'user.name', 'Overhead Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  const manifestDir = path.join(root, 'plugins', 'delivery-pipeline', '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'shipyard' }));
  git(root, ['add', 'base.txt', 'plugins']);
  git(root, ['commit', '--quiet', '-m', 'overhead base']);
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  const recorder = createDurableRecorder(receipts);
  const overheadRecorder = overhead.createRecorder(graph);
  const resultByValue = new WeakMap();
  const host = registerClaudeWorkflowHost({
    agent: async (_prompt, launchOptions) => {
      fs.writeFileSync(path.join(root, '.shipyard-pr-body.md'), `Ticket: ${ticket}\n\nsummary\n`);
      fs.writeFileSync(path.join(root, '.shipyard-evidence.md'), 'complete evidence body for targeted parent reads\n');
      fs.writeFileSync(path.join(root, 'implemented.txt'), 'implemented\n');
      git(root, ['add', 'implemented.txt']);
      git(root, ['commit', '--quiet', '-m', `feat(${ticket}): implementation`]);
      const result = { id: ticket, status: 'committed', summary: 'done', blocking_count: 0 };
      resultByValue.set(result, transcriptEvidence({
        launch_id: 'overhead-artifact-launch', applied_model: launchOptions.model,
        applied_effort: launchOptions.effort, observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      }));
      return result;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: {
      supportedModels: [CLAUDE_MODEL_ALIASES.sonnet], supportedEfforts: ['medium'],
      observedModel: true, observedEffort: true,
    },
    recorder,
    applicationEvidence: ({ result }) => resultByValue.get(result),
  });
  try {
    const [artifact] = await host.run('executors', { args: { tickets: [{
      id: ticket, title: 'artifact', planPath: path.join(root, 'PLAN.md'),
      branch: `ticket/${ticket}`, worktreePath: root, prBase: 'main', model: 'claude-sonnet-5-5', effort: 'medium',
    }] } });
    const fullEvidence = fs.readFileSync(path.join(root, '.shipyard-evidence.md'), 'utf8');
    const selected = roleArtifact.read({
      worktreePath: root, base: 'main', role: 'executor', ticket,
      recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest, run_id: 'run-artifact', runtime: 'claude',
      treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
      overheadRecorder, evidenceRange: [0, 8],
    });
    const row = overheadRecorder.latest().find((item) => item.stage === 'parent_reingestion');
    assert.equal(selected.evidence_range.content, fullEvidence.slice(0, 8));
    assert.ok(row, 'the selected consumer path must emit a measurement');
    assert.equal(row.bytes, Buffer.byteLength(selected.evidence_range.content, 'utf8'));
    assert.ok(row.bytes < Buffer.byteLength(fullEvidence, 'utf8'));
    assert.equal(row.treatment.bounded_context, 'opt-07');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid counters and sensitive bodies fail closed', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    assert.throws(() => recorder.record(identity({ bytes: -1 })), /non-negative/);
    assert.throws(() => recorder.record(identity({ prompt: 'secret' })), /metadata-only/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('TREATMENT_KEYS names exactly the two orchestration treatments, unchanged by this ticket', () => {
  assert.deepEqual(overhead.TREATMENT_KEYS, ['wait_events', 'bounded_context']);
});

test('STAGES and HANDOFF_COST_STAGES both accept the successor_reread stage', () => {
  assert.ok(overhead.STAGES.has('successor_reread'));
  assert.ok(overhead.HANDOFF_COST_STAGES.has('successor_reread'));
});

test('an observation without instruction_digest and lifecycle_class keeps its exact pre-change observation_id', () => {
  const row = overhead.normalizeObservation({
    run_id: 'r', role: 'executor', runtime: 'claude', backend: 'workflow', stage: 'startup',
    treatment: {}, bytes: 100, estimated_tokens: 25,
  }, '2026-01-01T00:00:00.000Z');
  assert.equal(row.observation_id, 'b29ead30bb9b1fa8b35cf82328bf322517bc6212fbd8b8d5');
  assert.equal(row.instruction_digest, undefined);
  assert.equal(row.lifecycle_class, undefined);
});

test('instruction_digest and lifecycle_class are validated and only change the observation_id when present', () => {
  const base = {
    run_id: 'r', role: 'executor', runtime: 'claude', backend: 'workflow', stage: 'startup',
    treatment: {}, bytes: 100, estimated_tokens: 25,
  };
  const bare = overhead.normalizeObservation(base);
  const withDigest = overhead.normalizeObservation({ ...base, instruction_digest: 'a'.repeat(64) });
  const withClass = overhead.normalizeObservation({ ...base, lifecycle_class: 'resume' });
  assert.notEqual(withDigest.observation_id, bare.observation_id);
  assert.notEqual(withClass.observation_id, bare.observation_id);
  assert.equal(withDigest.instruction_digest, 'a'.repeat(64));
  assert.equal(withClass.lifecycle_class, 'resume');
  assert.throws(() => overhead.normalizeObservation({ ...base, instruction_digest: 'not-hex' }),
    (error) => error.code === 'INVALID_OBSERVATION');
  assert.throws(() => overhead.normalizeObservation({ ...base, lifecycle_class: 'reboot' }),
    (error) => error.code === 'INVALID_OBSERVATION');
});

test('recordHandoffCost accepts successor_reread and handoffCostSummary reports four stages per lifecycle class', () => {
  const f = fixture();
  try {
    const recorder = overhead.createRecorder(f.graph);
    for (const [stage, bytes] of [
      ['checkpoint_collection', 40], ['successor_startup', 80], ['successor_reread', 20], ['cache_warmup', 12],
    ]) {
      const result = overhead.recordHandoffCost(recorder, {
        observation_id: `resume-${stage}`, run_id: 'run-lifecycle', dispatch_id: `dispatch-${stage}`,
        role: 'executor', runtime: 'claude', backend: 'workflow', policy_hash: 'a'.repeat(64),
        treatment: { wait_events: 'baseline', bounded_context: 'opt-07' },
        stage, lifecycle_class: 'resume', bytes, estimated_tokens: bytes / 4,
      });
      assert.equal(result.recorded.length, 1);
    }
    const summary = overhead.handoffCostSummary(recorder.latest());
    assert.equal(summary.schema, 'shipyard.handoff-cost-summary.v1');
    assert.equal(summary.verdict, 'inconclusive');
    assert.equal(summary.status.implemented, true);
    assert.equal(summary.status.installed, true);
    assert.equal(summary.status.behaviorally_verified, false);
    assert.equal(summary.status.efficiency_measured, false);
    const resume = summary.by_lifecycle_class.find((entry) => entry.lifecycle_class === 'resume');
    assert.deepEqual(resume.missing_stages, []);
    assert.deepEqual(Object.keys(resume.stages).sort(), [
      'cache_warmup', 'checkpoint_collection', 'successor_reread', 'successor_startup',
    ]);
    assert.equal(resume.stages.successor_reread.bytes, 20);
    const fork = summary.by_lifecycle_class.find((entry) => entry.lifecycle_class === 'fork');
    assert.deepEqual(fork.missing_stages, [
      'checkpoint_collection', 'successor_startup', 'cache_warmup', 'successor_reread',
    ]);
    assert.equal(fork.rows, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const component of ['.planning', '.planning/intervening', '.planning/graph']) {
  for (const entry of ['symlink', 'file']) {
    for (const operation of ['read', 'record']) {
      test(`recorder refuses ${component} ${entry} before public ${operation}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-ancestor-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-outside-'));
        try {
          const sentinel = path.join(outside, overhead.STREAM_NAME);
          fs.writeFileSync(sentinel, 'outside sentinel\n', { mode: 0o600 });
          fs.mkdirSync(path.join(outside, 'graph'));
          fs.writeFileSync(path.join(outside, 'graph', overhead.STREAM_NAME), 'nested sentinel\n');
          const before = fs.statSync(sentinel);
          const target = path.join(root, component);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (entry === 'symlink') fs.symlinkSync(outside, target, 'dir');
          else fs.writeFileSync(target, 'physical file\n');
          const graph = component === '.planning/intervening'
            ? path.join(target, 'graph') : path.join(root, '.planning', 'graph');
          const recorder = overhead.createRecorder(graph);
          const originalOpen = fs.openSync;
          let opened = false;
          fs.openSync = function (...args) { opened = true; return originalOpen.apply(fs, args); };
          try {
            assert.throws(() => operation === 'read' ? recorder.read() : recorder.record(identity()),
              error => error.code === 'RECORDER_ALIAS');
            assert.equal(opened, false);
          } finally { fs.openSync = originalOpen; }
          assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside sentinel\n');
          assert.equal(fs.readFileSync(path.join(outside, 'graph', overhead.STREAM_NAME), 'utf8'), 'nested sentinel\n');
          const after = fs.statSync(sentinel);
          assert.equal(after.ino, before.ino);
          assert.equal(after.mode, before.mode);
          assert.deepEqual(fs.readdirSync(outside).sort(), ['graph', overhead.STREAM_NAME].sort());
          assert.deepEqual(fs.readdirSync(path.join(outside, 'graph')), [overhead.STREAM_NAME]);
          if (entry === 'file') assert.equal(fs.readFileSync(target, 'utf8'), 'physical file\n');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
          fs.rmSync(outside, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const anchor of ['project', 'project alias', 'protected store']) {
  test(`recorder creates absent descendants under legitimate ${anchor}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-overhead-anchor-'));
    try {
      const project = path.join(root, 'project');
      fs.mkdirSync(project);
      const alias = path.join(root, 'project-alias');
      fs.symlinkSync(project, alias, 'dir');
      const store = path.join(root, 'planning-overhead');
      fs.mkdirSync(store, { mode: 0o700 });
      const graph = anchor === 'protected store' ? path.join(store, 'dispatch-identity')
        : path.join(anchor === 'project alias' ? alias : project, '.planning', 'graph');
      const recorder = overhead.createRecorder(graph);
      assert.deepEqual(recorder.read().rows, []);
      const result = recorder.record(identity());
      assert.equal(result.recorded.length, 1);
      assert.equal(recorder.read().rows[0].dispatch_id, 'dispatch-33-07');
      const physicalGraph = anchor === 'protected store' ? graph : path.join(project, '.planning', 'graph');
      assert.equal(fs.lstatSync(physicalGraph).isDirectory(), true);
      assert.equal(fs.lstatSync(path.join(physicalGraph, overhead.STREAM_NAME)).isFile(), true);
      if (anchor === 'protected store') assert.equal(fs.existsSync(path.join(project, '.planning')), false);
      else assert.equal(overhead.createRecorder(path.join(project, '.planning', 'graph')).read().rows.length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const alias of ['stream', 'locks', 'lock', 'owner']) {
  test(`recorder refuses existing ${alias} alias before writing`, () => {
    const f = fixture();
    try {
      const writer = path.join(f.root, 'writer');
      fs.mkdirSync(writer);
      const sentinel = path.join(writer, 'sentinel');
      fs.writeFileSync(sentinel, 'protected\n', { mode: 0o600 });
      const before = fs.statSync(sentinel);
      const locks = path.join(f.graph, '.locks');
      const lock = path.join(locks, 'orchestration-overhead.lock');
      if (alias === 'stream') fs.symlinkSync(sentinel, path.join(f.graph, overhead.STREAM_NAME));
      if (alias === 'locks') { fs.rmdirSync(locks); fs.symlinkSync(writer, locks); }
      if (alias === 'lock') fs.symlinkSync(writer, lock);
      if (alias === 'owner') { fs.mkdirSync(lock); fs.symlinkSync(sentinel, path.join(lock, 'owner.json')); }
      assert.throws(() => overhead.createRecorder(f.graph).record(identity()));
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'protected\n');
      const after = fs.statSync(sentinel);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode, before.mode);
      assert.deepEqual(fs.readdirSync(writer), ['sentinel']);
      if (alias === 'stream') assert.throws(() => overhead.readStream(f.graph));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('shared lock refuses a symlink owner without stale takeover', () => {
  const f = fixture();
  try {
    const { acquire } = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
    const lock = path.join(f.graph, '.locks', 'alias.lock');
    fs.mkdirSync(lock);
    const target = path.join(f.root, 'owner-target');
    fs.writeFileSync(target, JSON.stringify({ at: '2000-01-01' }));
    fs.symlinkSync(target, path.join(lock, 'owner.json'));
    assert.throws(() => acquire(path.dirname(lock), 'alias', { waitMs: 0 }));
    assert.equal(fs.lstatSync(path.join(lock, 'owner.json')).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['alias.lock']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const change of ['replace', 'disappear', 'write', 'hardlink', 'symlink']) {
  test(`shared lock handles contended owner ${change} without seizing a successor`, () => {
    const f = fixture();
    const originalRead = fs.readFileSync;
    const { acquire } = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
    const dir = path.join(f.graph, '.locks');
    const lock = path.join(dir, 'observation.lock');
    const file = path.join(lock, 'owner.json');
    let injected = false;
    try {
      fs.mkdirSync(lock);
      const stale = JSON.stringify({ at: '2000-01-01', token: 'old' });
      const successor = JSON.stringify({ at: new Date().toISOString(), token: 'successor' });
      fs.writeFileSync(file, stale);
      fs.readFileSync = function (input, ...args) {
        const result = originalRead.call(fs, input, ...args);
        if (typeof input === 'number' && !injected) {
          injected = true;
          if (change === 'write') fs.writeFileSync(file, successor);
          else if (change === 'hardlink') fs.linkSync(file, path.join(f.root, 'alias'));
          else {
            fs.unlinkSync(file);
            if (change === 'replace') fs.writeFileSync(file, successor);
            if (change === 'symlink') {
              const target = path.join(f.root, 'target');
              fs.writeFileSync(target, successor);
              fs.symlinkSync(target, file);
            }
          }
        }
        return result;
      };
      if (change === 'hardlink' || change === 'symlink')
        assert.throws(() => acquire(dir, 'observation', { waitMs: 0 }), /opened regular file/);
      else assert.equal(acquire(dir, 'observation', { waitMs: 0 }), null);
      assert.equal(injected, true);
      assert.deepEqual(fs.readdirSync(dir), ['observation.lock']);
      if (change === 'replace' || change === 'write')
        assert.equal(originalRead(file, 'utf8'), successor);
    } finally {
      fs.readFileSync = originalRead;
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}

suite('shared recorder lock — lock directory leaf identity');

test('a stale-owner directory symlink refuses acquisition without changing its target', () => {
  const f = fixture();
  const tmp = path.join(f.graph, '.locks');
  const { acquire } = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
  try {
    const target = path.join(tmp, 'alias-target');
    const leaf = path.join(tmp, 'alias.lock');
    fs.mkdirSync(target);
    const bytes = JSON.stringify({ at: new Date(0).toISOString(), token: 'target-owner' });
    fs.writeFileSync(path.join(target, 'owner.json'), bytes);
    const before = fs.lstatSync(target);
    fs.symlinkSync(target, leaf, 'dir');
    let handle;
    try {
      assert.throws(() => { handle = acquire(tmp, 'alias', { waitMs: 0 }); },
        error => error.code === 'LOCK_DIRECTORY_ALIAS');
      assert.ok(fs.lstatSync(leaf).isSymbolicLink());
      assert.strictEqual(fs.readFileSync(path.join(target, 'owner.json'), 'utf8'), bytes);
      const after = fs.lstatSync(target);
      assert.strictEqual(after.dev, before.dev);
      assert.strictEqual(after.ino, before.ino);
      assert.deepStrictEqual(fs.readdirSync(target), ['owner.json']);
    } finally { if (handle) handle.release(); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a non-directory lock leaf refuses acquisition', () => {
  const f = fixture();
  const tmp = path.join(f.graph, '.locks');
  const { acquire } = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
  try {
    const leaf = path.join(tmp, 'file-leaf.lock');
    fs.writeFileSync(leaf, 'unchanged');
    assert.throws(() => acquire(tmp, 'file-leaf', { waitMs: 0 }),
      error => error.code === 'LOCK_DIRECTORY_ALIAS');
    assert.strictEqual(fs.readFileSync(leaf, 'utf8'), 'unchanged');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const replacement of [false, true]) {
  test(`directory ${replacement ? 'replacement' : 'disappearance'} during owner read is retryable`, () => {
    const f = fixture();
    const tmp = path.join(f.graph, '.locks');
    const { acquire } = require('../../plugins/delivery-pipeline/scripts/lock.cjs');
    try {
      const name = replacement ? 'replaced-read' : 'vanished-read';
      const leaf = path.join(tmp, `${name}.lock`);
      const moved = `${leaf}.original`;
      const bytes = JSON.stringify({ at: new Date(0).toISOString(), token: 'old-owner' });
      fs.mkdirSync(leaf);
      fs.writeFileSync(path.join(leaf, 'owner.json'), bytes);
      const original = fs.readFileSync;
      const open = fs.openSync;
      let changed = false;
      fs.openSync = function(file, ...args) {
        if (file === path.join(leaf, 'owner.json') && !changed) {
          changed = true;
          fs.renameSync(leaf, moved);
          if (replacement) {
            fs.mkdirSync(leaf);
            fs.renameSync(path.join(moved, 'owner.json'), path.join(leaf, 'owner.json'));
          }
        }
        return open.call(this, file, ...args);
      };
      let handle;
      try {
        handle = acquire(tmp, name, { waitMs: 0 });
        assert.strictEqual(handle, null, 'a changed directory must retry rather than take over');
        assert.ok(changed, 'the actual owner descriptor open reached the race');
        if (replacement) {
          assert.deepStrictEqual(fs.readdirSync(moved), []);
          assert.strictEqual(original(path.join(leaf, 'owner.json'), 'utf8'), bytes);
        } else assert.strictEqual(original(path.join(moved, 'owner.json'), 'utf8'), bytes);
      } finally { fs.openSync = open; if (handle) handle.release(); }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}


done();
