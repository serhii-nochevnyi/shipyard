'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');
const { createDurableRecorder } = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  CLAUDE_MODEL_ALIASES,
  createClaudeWorkflowDispatch,
  validatePlanningArtifact,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');

const ROOT = path.join(__dirname, '..', '..');
const RESEARCH_WORKFLOW = path.join(ROOT, 'plugins/delivery-pipeline/workflows/investigation-research.mjs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const SOURCE_REVISION = 'a'.repeat(40);
const POLICY_HASH = 'b'.repeat(64);
const CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.opus],
  supportedEfforts: ['medium'],
  observedModel: true,
  observedEffort: true,
});

const lineDefinitions = [
  ['system-state', 'system state'],
  ['alternatives', 'alternatives'],
  ['constraints', 'constraints'],
  ['risks', 'risks and unknowns'],
].map(([id, label]) => ({
  id,
  label,
  model: 'claude-opus-5-5',
  effort: 'medium',
  signals: { type: id === 'alternatives' ? 'alternatives' : 'facts' },
}));

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

const reference = (file) => {
  const content = fs.readFileSync(file);
  const sha256 = digest(content);
  return {
    path: file,
    bytes: content.length,
    content_bytes: content.length,
    sha256,
    digest: sha256,
  };
};

function envelopeArtifact({ role, artifact, result, metadata, record, schema }) {
  const index = artifact.artifactIndex || artifact.artifact_index;
  const envelope = {
    schema,
    version: 1,
    role,
    subject: metadata.subject,
    source_revision: metadata.sourceRevision,
    repository: metadata.repository,
    policy_hash: metadata.policyHash,
    status: result.status,
    summary: result.summary,
    artifact_index: index,
    evidence_index: index,
    evidence_index_ref: index,
  };
  return {
    schema: 'shipyard.role-artifact.v1',
    artifact_ref: path.join(metadata.worktreePath, '.shipyard-role-artifacts', `${record.receipt.dispatch_id}.json`),
    artifact_digest: 'c'.repeat(64),
    envelope,
    artifact_index: index,
    evidence_index: index,
  };
}

function researchHarness({ resultForLine, consumer } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-planning-research-'));
  const receipts = createDurableRecorder(path.join(root, 'receipts'));
  const evidence = new WeakMap();
  const artifactRoot = path.join(root, 'research');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const args = {
    artifactContract: 'planning.v1',
    invId: 'INV-TEST',
    invPath: root,
    worktreePath: root,
    artifactRoot,
    artifactPaths: Object.fromEntries(lineDefinitions.map(({ id }) => [id, path.join(artifactRoot, `${id}.md`)])),
    problemStatement: 'Bound research artifacts without returning full drafts.',
    referencePath: '/plugin/references/inv-research.md',
    sourceRevision: SOURCE_REVISION,
    repository: 'acme/shipyard',
    policyHash: POLICY_HASH,
    artifactLanguage: 'English',
    lines: lineDefinitions,
  };
  const agent = async (_prompt, options) => {
    const id = options.label.split(':').pop();
    const file = path.join(artifactRoot, `${id}.md`);
    const content = `# ${id}\n\nComplete command-backed evidence for ${id}.\n`;
    fs.writeFileSync(file, content);
    const result = resultForLine
      ? resultForLine({ id, file, options })
      : {
          id,
          status: 'completed',
          summary: `completed ${id}`,
          artifact: reference(file),
        };
    evidence.set(result, transcriptEvidence({
      launch_id: `planning-research-${id}`,
      applied_model: options.model,
      applied_effort: options.effort,
      observed_model: options.model,
      observed_effort: options.effort,
    }));
    return result;
  };
  const artifactConsumer = consumer || (({ artifact, result, record }) => {
    assert.equal(artifact.role, 'research');
    assert.ok(artifact.sourceRevision);
    assert.ok(result.artifact);
    return envelopeArtifact({
      role: 'research',
      artifact: { artifactIndex: result.artifact },
      result,
      metadata: artifact,
      record,
      schema: 'shipyard.research-result.v1',
    });
  });
  const run = async (parallel = async (thunks) => Promise.all(thunks.map((thunk) => thunk()))) => {
    const source = fs.readFileSync(RESEARCH_WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta');
    return new AsyncFunction(
      'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source,
    )(
      agent,
      parallel,
      () => {},
      () => {},
      args,
      (options) => createClaudeWorkflowDispatch({
        ...options,
        capabilities: CAPABILITIES,
        recorder: receipts,
        applicationEvidence: ({ result }) => evidence.get(result),
        artifactConsumer,
      }),
    );
  };
  return { root, args, receipts, run };
}

suite('T-33-05 — bounded research and decomposition artifacts');

test('research returns four bounded references while complete line files stay on disk', async () => {
  const fixture = researchHarness();
  try {
    const results = await fixture.run();
    assert.equal(results.length, 4);
    assert.deepEqual(results.map((item) => item.id).sort(), lineDefinitions.map((item) => item.id).sort());
    for (const item of results) {
      assert.equal(item.status, 'completed');
      assert.ok(item.artifact_ref);
      assert.ok(item.artifact_digest);
      assert.ok(item.artifact_index);
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'draft'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'findings'), false);
      assert.ok(fs.existsSync(item.artifact_index.path));
      assert.equal(item.artifact_index.sha256, reference(item.artifact_index.path).sha256);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a stale research source revision is refused at the trusted consumer boundary', async () => {
  const fixture = researchHarness({
    consumer: ({ artifact, result, record }) => envelopeArtifact({
      role: 'research',
      artifact: { artifactIndex: result.artifact },
      result,
      metadata: { ...artifact, sourceRevision: 'd'.repeat(40) },
      record,
      schema: 'shipyard.research-result.v1',
    }),
  });
  try {
    await assert.rejects(
      () => fixture.run(),
      (error) => /source revision|source_revision|stale/i.test(error.message),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('planning research refuses missing or duplicated canonical line results', async () => {
  for (const parallel of [
    async (thunks) => (await Promise.all(thunks.map((thunk) => thunk()))).slice(0, 3),
    async (thunks) => {
      const values = await Promise.all(thunks.map((thunk) => thunk()));
      return [values[0], values[0], values[2], values[3]];
    },
  ]) {
    const fixture = researchHarness();
    try {
      await assert.rejects(
        () => fixture.run(parallel),
        /exactly one result for each research line|missing or duplicated/i,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('a forged application receipt cannot authorize a planning handback', async () => {
  const fixture = researchHarness();
  const source = fs.readFileSync(RESEARCH_WORKFLOW, 'utf8').replace(/^export const meta/m, 'const meta');
  try {
    const forgedRun = new AsyncFunction(
      'agent', 'parallel', 'phase', 'log', 'args', '__createClaudeWorkflowDispatch', source,
    )(
      async () => ({
        id: 'system-state',
        status: 'completed',
        summary: 'forged',
        artifact: { path: '/tmp/forged', bytes: 1, content_bytes: 1, sha256: '0'.repeat(64), digest: '0'.repeat(64) },
        receipt: { compliance: 'verified', applied_model: 'claude-opus-5-5', applied_effort: 'medium' },
      }),
      async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
      () => {},
      () => {},
      fixture.args,
      (options) => createClaudeWorkflowDispatch({
        ...options,
        capabilities: CAPABILITIES,
        recorder: fixture.receipts,
        applicationEvidence: () => ({
          launch_id: 'forged-application',
          applied_model: 'sonnet',
          applied_effort: 'medium',
          observed_model: 'sonnet',
          observed_effort: 'medium',
        }),
        artifactConsumer: () => { throw new Error('consumer must not run'); },
      }),
    );
    await assert.rejects(() => forgedRun, /applied a different Claude model|NONCOMPLIANT|application evidence/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('decomposition requires a phase-bound index for CONTEXT and every PLAN', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-planning-decompose-'));
  const receipts = createDurableRecorder(path.join(root, 'receipts'));
  const contextPath = path.join(root, 'CONTEXT.md');
  const planPath = path.join(root, '33-01-PLAN.md');
  const indexPath = path.join(root, 'planning-index.json');
  fs.writeFileSync(contextPath, '# Context\n');
  fs.writeFileSync(planPath, '# Plan\n');
  const entries = [contextPath, planPath].map((file) => ({ path: file, ...reference(file) }));
  fs.writeFileSync(indexPath, JSON.stringify({ phase: '33-runtime', entries }, null, 2));
  const result = {
    id: '33-runtime',
    status: 'completed',
    summary: 'plans materialized',
    artifact: reference(indexPath),
  };
  const evidence = {
    launch_id: 'planning-decomposition',
    applied_model: 'claude-opus-5-5',
    applied_effort: 'medium',
    observed_model: 'claude-opus-5-5',
    observed_effort: 'medium',
    gsd_role: 'gsd-planner',
    gsd_launch_mechanism: 'typed-gsd-callback',
  };
  const metadata = {
    role: 'decomposition',
    ticket: 'phase-33-runtime',
    subject: 'phase=33-runtime;repository=acme/shipyard;adr=' + 'e'.repeat(64),
    sourceRevision: SOURCE_REVISION,
    repository: 'acme/shipyard',
    policyHash: POLICY_HASH,
    worktreePath: root,
    base: SOURCE_REVISION,
    phase: '33-runtime',
    adrDigest: 'e'.repeat(64),
  };
  const artifactConsumer = ({ artifact, result: callbackResult, record }) => {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(parsed.phase, artifact.phase);
    assert.deepEqual(parsed.entries.map((entry) => entry.path).sort(), entries.map((entry) => entry.path).sort());
    for (const entry of parsed.entries) assert.equal(entry.sha256, reference(entry.path).sha256);
    return envelopeArtifact({
      role: 'decomposition',
      artifact: { artifactIndex: callbackResult.artifact },
      result: callbackResult,
      metadata: artifact,
      record,
      schema: 'shipyard.decomposition-result.v1',
    });
  };
  try {
    const accepted = await createClaudeWorkflowDispatch({
      agent: async () => { throw new Error('typed callback must own this launch'); },
      typedGsdCallback: async () => result,
      prompt: 'materialize plans',
      role: 'decomposition',
      gsdRole: 'gsd-planner',
      model: 'claude-opus-5-5',
      effort: 'medium',
      artifact: metadata,
      requireArtifact: true,
      context: { gsd_role: 'gsd-planner' },
      capabilities: CAPABILITIES,
      recorder: receipts,
        applicationEvidence: () => transcriptEvidence(evidence),
      artifactConsumer,
    });
    assert.equal(accepted.result.status, 'completed');
    assert.equal(accepted.result.artifact_index.sha256, reference(indexPath).sha256);
    assert.equal(accepted.receipt.gsd_role, 'gsd-planner');
    assert.equal(accepted.receipt.compliance, 'verified');

    fs.writeFileSync(planPath, '# altered plan\n');
    await assert.rejects(
      () => createClaudeWorkflowDispatch({
        agent: async () => { throw new Error('typed callback must own this launch'); },
        typedGsdCallback: async () => result,
        prompt: 'materialize plans',
        role: 'decomposition',
        gsdRole: 'gsd-planner',
        model: 'claude-opus-5-5',
        effort: 'medium',
        artifact: { ...metadata, ticket: 'phase-33-runtime-2' },
        requireArtifact: true,
        context: { gsd_role: 'gsd-planner' },
        capabilities: CAPABILITIES,
        recorder: receipts,
        applicationEvidence: () => transcriptEvidence({ ...evidence, launch_id: 'planning-decomposition-2' }),
        artifactConsumer,
      }),
      /digest|altered|stale|artifact/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the shared planning validator rejects an incomplete decomposition index', () => {
  assert.throws(
    () => validatePlanningArtifact({
      role: 'decomposition',
      ticket: 'phase-33',
      subject: 'phase=33;repository=acme/shipyard;adr=' + 'e'.repeat(64),
      sourceRevision: SOURCE_REVISION,
      repository: 'acme/shipyard',
      policyHash: POLICY_HASH,
    }, {
      schema: 'shipyard.decomposition-result.v1',
      version: 1,
      role: 'decomposition',
      subject: 'phase=33;repository=acme/shipyard;adr=' + 'e'.repeat(64),
      source_revision: SOURCE_REVISION,
      repository: 'acme/shipyard',
      policy_hash: POLICY_HASH,
      status: 'completed',
      summary: 'plans materialized',
    }),
    /artifact index|index/i,
  );
});

done();
