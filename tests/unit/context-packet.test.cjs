'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');
const {
  CONTEXT_PACKET_SCHEMA,
  CONTEXT_PACKET_VERSION,
  DEFAULT_TOKEN_CEILING,
  estimateTokens,
  buildContextPacket,
  validateContextPacket,
} = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
const modelPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs');
const { createDispatchBoundary, createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const { createClaudeDispatchAdapter, createClaudeWorkflowDispatch, CLAUDE_MODEL_ALIASES } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const { createCodexDispatchAdapter, CODEX_MODEL_IDS } = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-context-packet-'));
  fs.mkdirSync(path.join(root, '.planning', 'backlog'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'phases', '999-parking'), { recursive: true });
  const policy = 'Required delivery policy: preserve scope, evidence, and live gates.\n';
  const plan = [
    '# T-33-06',
    '',
    '## Files modified',
    '- `src/packet.js`',
    '',
    '## Acceptance',
    '- The child receives the complete policy and selected backlog.',
    '',
    '## Verification',
    '- `node tests/unit/context-packet.test.cjs`',
  ].join('\n');
  const note = [
    '# Important backlog item',
    '',
    'This is a complete selected source section. '.repeat(30),
  ].join('\n');
  fs.writeFileSync(path.join(root, 'POLICY.md'), policy);
  fs.writeFileSync(path.join(root, 'PLAN.md'), plan);
  fs.writeFileSync(path.join(root, '.planning', 'backlog', 'notes.md'), note);
  fs.writeFileSync(path.join(root, 'src-packet.js'), 'export const packet = true;\n');
  return { root, policy, plan, note };
}

function options(f, extra = {}) {
  return {
    root: f.root,
    role: 'executor',
    subject: 'T-33-06',
    sourceRevision: 'a'.repeat(40),
    policyHash: sha256(f.policy),
    policy: { path: path.join(f.root, 'POLICY.md'), content: f.policy },
    planPath: path.join(f.root, 'PLAN.md'),
    scope: {
      files_modified: ['src-packet.js'],
      acceptance: ['The child receives the complete policy and selected backlog.'],
      verification: ['node tests/unit/context-packet.test.cjs'],
    },
    requiredRefs: [path.join(f.root, 'PLAN.md')],
    backend: 'claude',
    selectedBacklogIds: [],
    ...extra,
  };
}

suite('T-33-06 — targeted launch context packets');

test('builds a serializable packet with complete policy, scope, refs and explicit empty backlog', () => {
  const f = fixture();
  try {
    const packet = buildContextPacket(options(f));
    assert.equal(packet.schema, CONTEXT_PACKET_SCHEMA);
    assert.equal(packet.version, CONTEXT_PACKET_VERSION);
    assert.equal(packet.canonical_root, fs.realpathSync(f.root));
    assert.equal(packet.source_revision, 'a'.repeat(40));
    assert.equal(packet.policy_hash, sha256(f.policy));
    assert.equal(packet.policy.content, f.policy);
    assert.deepEqual(packet.immutable_scope.files_modified, ['src-packet.js']);
    assert.ok(packet.required_refs.some((ref) => ref.path === 'PLAN.md'));
    assert.equal(packet.backlog.empty, true);
    assert.deepEqual(packet.backlog.selected_ids, []);
    assert.equal(packet.accounting.backend, 'claude');
    assert.ok(Number.isSafeInteger(packet.accounting.estimated_tokens));
    assert.deepEqual(JSON.parse(JSON.stringify(packet)), packet);
    validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('reads the full selected backlog section and binds its source hash', () => {
  const f = fixture();
  try {
    const first = buildContextPacket(options(f));
    const item = first.backlog.inventory.items[0];
    assert.ok(item, 'fixture must expose a backlog item');
    const packet = buildContextPacket(options(f, { selectedBacklogIds: [item.id] }));
    assert.equal(packet.backlog.empty, false);
    assert.equal(packet.backlog.selected.length, 1);
    assert.equal(packet.backlog.selected[0].id, item.id);
    assert.equal(packet.backlog.selected[0].source_hash, sha256(f.note));
    assert.ok(packet.backlog.selected[0].content.length > 600, 'selected content must not be excerpt-only');
    assert.equal(packet.backlog.selected[0].excerpt, undefined);
    validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('marks a packet that exceeds the soft ceiling instead of dropping constraints', () => {
  const f = fixture();
  try {
    const initial = buildContextPacket(options(f));
    const item = initial.backlog.inventory.items[0];
    const packet = buildContextPacket(options(f, {
      selectedBacklogIds: [item.id],
      tokenCeiling: 1,
    }));
    assert.equal(packet.accounting.soft_ceiling, 1);
    assert.equal(packet.accounting.overflow, true);
    assert.ok(packet.overflow && packet.overflow.reason);
    assert.ok(packet.policy.content, 'required policy remains in an overflow packet');
    assert.ok(packet.immutable_scope.files_modified.length, 'required scope remains in an overflow packet');
    validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('keeps optional source content complete when indexing it is enough to fit the ceiling', () => {
  const f = fixture();
  try {
    const full = buildContextPacket(options(f, {
      optionalRefs: [path.join(f.root, 'POLICY.md')],
      tokenCeiling: 999999,
    }));
    const reduced = JSON.parse(JSON.stringify(full));
    delete reduced.accounting;
    delete reduced.optional_refs[0].content;
    reduced.optional_refs[0].content_omitted = true;
    reduced.optional_refs[0].content_ref = {
      path: reduced.optional_refs[0].path,
      sha256: reduced.optional_refs[0].sha256,
      bytes: reduced.optional_refs[0].bytes,
    };
    const reducedTokens = estimateTokens(reduced);
    const packet = buildContextPacket(options(f, {
      optionalRefs: [path.join(f.root, 'POLICY.md')],
      tokenCeiling: reducedTokens,
    }));
    assert.equal(packet.accounting.overflow, false);
    assert.equal(packet.optional_refs[0].content_omitted, undefined);
    validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('refuses modified sources, selected ids that vanished, and stale verification', () => {
  const f = fixture();
  try {
    const initial = buildContextPacket(options(f));
    const item = initial.backlog.inventory.items[0];
    const packet = buildContextPacket(options(f, { selectedBacklogIds: [item.id] }));
    packet.backlog.selected[0].status = 'verified_closed';
    assert.throws(
      () => validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' }),
      (error) => error.code === 'STALE_CONTEXT_PACKET',
    );
    packet.backlog.selected[0].status = item.status;
    fs.appendFileSync(path.join(f.root, 'PLAN.md'), '\nchanged\n');
    assert.throws(
      () => validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' }),
      (error) => error.code === 'STALE_CONTEXT_PACKET',
    );
    assert.throws(
      () => buildContextPacket(options(f, { selectedBacklogIds: ['local:missing.md#deadbeefdeadbeef:1'] })),
      (error) => error.code === 'MISSING_BACKLOG_ITEM',
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('refuses symlinked roots and packet objects that try to carry model authority', () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-context-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(f.root, 'secret.md'));
    assert.throws(
      () => buildContextPacket(options(f, { requiredRefs: [path.join(f.root, 'secret.md')] })),
      (error) => error.code === 'SYMLINK_CONTEXT_SOURCE',
    );
    assert.throws(
      () => buildContextPacket(options(f, { scope: { files_modified: ['../outside.js'] } })),
      (error) => error.code === 'CONTEXT_PATH_ESCAPE',
    );
    const packet = buildContextPacket(options(f));
    packet.model = 'opus';
    assert.throws(
      () => validateContextPacket(packet, { root: f.root, role: 'executor', subject: 'T-33-06' }),
      (error) => error.code === 'CONTEXT_PACKET_AUTHORITY',
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('both runtime adapters validate the same packet before the host launch', () => {
  const f = fixture();
  const packet = buildContextPacket(options(f, {
    policy: modelPolicy.POLICY,
    policyHash: modelPolicy.POLICY_HASH,
  }));
  const context = {
    ticket: 'T-33-06',
    subject: 'T-33-06',
    worktreePath: f.root,
    contextPacket: packet,
  };
  const claudeCalls = [];
  const claudeAdapter = createClaudeDispatchAdapter({
    capabilities: {
      supportedModels: Object.values(CLAUDE_MODEL_ALIASES),
      supportedEfforts: ['high', 'medium', 'max'],
      observedModel: true,
      observedEffort: true,
    },
    host: {
      launch: (selection) => {
        claudeCalls.push(selection);
        return transcriptEvidence({
          launch_id: 'claude-packet',
          applied_model: selection.model,
          applied_effort: selection.effort,
          observed_model: selection.model,
          observed_effort: selection.effort,
        });
      },
    },
  });
  const claude = createDispatchBoundary({ adapters: { claude: claudeAdapter }, recorder: () => true });
  const claudeResult = claude.dispatch({ runtime: 'claude', role: 'executor' }, context);
  assert.equal(claudeResult.receipt.compliance, 'verified');
  assert.equal(claudeCalls.length, 1);

  const codexCalls = [];
  const codexAdapter = createCodexDispatchAdapter({
    capabilities: {
      supportedModels: Object.values(CODEX_MODEL_IDS),
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      observedModel: false,
      observedEffort: false,
    },
    host: {
      launch: (selection) => {
        codexCalls.push(selection);
        return { launch_id: 'codex-packet', applied_model: selection.model, applied_effort: selection.reasoning_effort };
      },
    },
  });
  const codex = createDispatchBoundary({ adapters: { codex: codexAdapter }, recorder: () => true });
  const codexResult = codex.dispatch({ runtime: 'codex', role: 'executor' }, context);
  assert.equal(codexResult.receipt.compliance, 'verified');
  assert.equal(codexCalls.length, 1);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('the real executor prompt carries the packet and no unrelated transcript', async () => {
  const f = fixture();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/delivery-pipeline/workflows/executors.mjs'), 'utf8')
    .replace(/^export const meta/m, 'const meta');
  const first = buildContextPacket(options(f, {
    policy: modelPolicy.POLICY,
    policyHash: modelPolicy.POLICY_HASH,
  }));
  const backlogItem = first.backlog.inventory.items[0];
  const packet = buildContextPacket(options(f, {
    policy: modelPolicy.POLICY,
    policyHash: modelPolicy.POLICY_HASH,
    selectedBacklogIds: [backlogItem.id],
    roleContext: {
      plan: path.join(f.root, 'PLAN.md'),
      scope: { files_modified: ['src-packet.js'] },
      acceptance: ['packet is complete'],
      verification: ['node tests/unit/context-packet.test.cjs'],
      backlog: [backlogItem.id],
    },
  }));
  const calls = [];
  const evidence = new WeakMap();
  const recorder = createDurableRecorder(path.join(f.root, 'receipts'));
  const capabilities = {
    supportedModels: ['sonnet'],
    supportedEfforts: ['max'],
    observedModel: true,
    observedEffort: true,
  };
  const run = new AsyncFunction(
    'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source,
  );
  try {
    const result = await run(
      async (prompt, launchOptions) => {
        calls.push({ prompt, launchOptions });
        const value = { id: 'T-33-06', status: 'blocked', summary: 'tracer only' };
        evidence.set(value, transcriptEvidence({
          launch_id: 'executor-packet',
          applied_model: launchOptions.model,
          applied_effort: launchOptions.effort,
          observed_model: launchOptions.model,
          observed_effort: launchOptions.effort,
        }));
        return value;
      },
      async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      () => {},
      () => {},
      {
        contextPacketRequired: true,
        tickets: [{
          id: 'T-33-06',
          planPath: path.join(f.root, 'PLAN.md'),
          branch: 'ticket/T-33-06',
          worktreePath: f.root,
          prBase: 'main',
          model: 'sonnet',
          effort: 'max',
          signals: {},
          contextPacket: packet,
          contextPacketRequired: true,
        }],
      },
      (dispatchOptions) => createClaudeWorkflowDispatch({
        ...dispatchOptions,
        capabilities,
        recorder,
        applicationEvidence: ({ result: value }) => evidence.get(value),
        artifactConsumer: () => ({}),
      }),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'blocked');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes('<TARGETED-CONTEXT-PACKET>'));
    assert.ok(calls[0].prompt.includes(JSON.stringify(packet)));
    assert.ok(calls[0].prompt.includes(backlogItem.id));
    assert.ok(calls[0].prompt.includes('"empty":false'));
    assert.ok(!calls[0].prompt.includes('unrelated historical transcript'));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

assert.ok(DEFAULT_TOKEN_CEILING >= 12000);
done();
