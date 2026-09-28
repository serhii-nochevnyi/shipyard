'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { transcriptEvidence: testTranscriptEvidence } = require('./claude-test-evidence.cjs');
const {
  CLAUDE_MODEL_ALIASES,
} = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
const {
  createDispatchBoundary,
  createDurableRecorder,
} = require('../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs');
const {
  registerClaudeWorkflowHost,
} = require('../../plugins/delivery-pipeline/scripts/claude-workflow-host.cjs');
const {
  NEUTRAL_PR_BODY_GUIDE,
} = require('../../plugins/delivery-pipeline/scripts/pr-hygiene.cjs');

const ROLE_ARTIFACT = path.join(
  __dirname,
  '../../plugins/delivery-pipeline/scripts/role-artifact.cjs',
);
const roleArtifact = require(ROLE_ARTIFACT);

const CAPABILITIES = Object.freeze({
  supportedModels: [CLAUDE_MODEL_ALIASES.sonnet],
  supportedEfforts: ['max'],
  observedModel: true,
  observedEffort: true,
});

function transcriptEvidence(value) {
  return testTranscriptEvidence(value);
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

const SHIPYARD_MANIFEST_RELATIVE = 'plugins/delivery-pipeline/.claude-plugin/plugin.json';

function writeShipyardManifest(root) {
  const file = path.join(root, ...SHIPYARD_MANIFEST_RELATIVE.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: 'shipyard' }));
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-role-artifact-'));
  const receipts = path.join(root, 'receipts');
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'role-artifact@example.test']);
  git(root, ['config', 'user.name', 'Role Artifact Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  const baseFiles = ['tracked.txt'];
  if (options.exempt !== false) {
    writeShipyardManifest(root);
    baseFiles.push(SHIPYARD_MANIFEST_RELATIVE);
  }
  git(root, ['add', ...baseFiles]);
  git(root, ['commit', '--quiet', '-m', 'fixture base']);

  const ticket = options.ticket || 'T-33-artifact';
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  if (options.uncommittedManifest) writeShipyardManifest(root);
  const recorder = createDurableRecorder(receipts);
  const evidence = new WeakMap();
  let agentResult;
  const host = registerClaudeWorkflowHost({
    agent: async (_prompt, launchOptions) => {
      fs.writeFileSync(
        path.join(root, '.shipyard-pr-body.md'),
        options.prBody === undefined ? `Ticket: ${ticket}\n\nProblem\n\nScope\n` : options.prBody,
      );
      fs.writeFileSync(path.join(root, '.shipyard-evidence.md'), 'node tests/unit/role-artifact.test.cjs\n\ncomplete evidence\n');
      fs.writeFileSync(path.join(root, 'implemented.txt'), 'implemented\n');
      git(root, ['add', 'implemented.txt']);
      git(root, ['commit', '--quiet', '-m', `feat(${ticket}): fixture implementation`]);
      agentResult = {
        id: ticket,
        status: options.status || 'committed',
        summary: options.summary || 'executor completed',
        actionable_delta: options.actionableDelta,
        blocking_count: options.blockingCount === undefined ? 0 : options.blockingCount,
        ...(options.forgedReceipt ? { receipt: { dispatch_id: 'agent-forged' } } : {}),
      };
      evidence.set(agentResult, transcriptEvidence({
        launch_id: `role-artifact-${ticket}`,
        applied_model: launchOptions.model,
        applied_effort: launchOptions.effort,
        observed_model: launchOptions.model,
        observed_effort: launchOptions.effort,
      }));
      return agentResult;
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    capabilities: CAPABILITIES,
    recorder,
    applicationEvidence: ({ result }) => evidence.get(result),
  });
  const args = {
    tickets: [{
      id: ticket,
      title: 'artifact fixture',
      planPath: path.join(root, 'PLAN.md'),
      branch: `ticket/${ticket}`,
      worktreePath: root,
      prBase: 'main',
      model: 'sonnet',
      effort: 'max',
    }],
  };
  return {
    root,
    receipts,
    ticket,
    recorder,
    host,
    args,
    get agentResult() { return agentResult; },
  };
}

async function runFixture(options = {}) {
  const value = fixture(options);
  try {
    const result = await value.host.run('executors', { args: value.args });
    return { ...value, result };
  } catch (error) {
    error.fixture = value;
    throw error;
  }
}

function clean(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

function judgmentReceipt(resolution) {
  const launchId = `judgment-launch-${resolution.dispatch_id}`;
  return {
    receipt_type: 'adr-014.application',
    runtime: resolution.runtime,
    role: resolution.role,
    dispatch_id: resolution.dispatch_id,
    launch_id: launchId,
    requested_model: resolution.requested_model,
    requested_effort: resolution.requested_effort,
    applied_model: resolution.model,
    applied_effort: resolution.effort,
    observed_model: resolution.model,
    observed_effort: resolution.effort,
    policy_hash: resolution.policy_hash,
    compliance: 'verified',
    compliance_proof: {
      status: 'verified',
      boundary: 'adr-014.dispatch-boundary',
      policy_hash: resolution.policy_hash,
      dispatch_id: resolution.dispatch_id,
      launch_id: launchId,
    },
  };
}

function judgmentFixture(ticket = 'T-43-05-role-artifact-judgment') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-role-artifact-judgment-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'role-artifact-judgment@example.test']);
  git(root, ['config', 'user.name', 'Role Artifact Judgment Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment base']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'main'])]);
  git(root, ['switch', '--quiet', '-c', `ticket/${ticket}`]);
  fs.writeFileSync(path.join(root, 'change.txt'), 'change\n');
  git(root, ['add', 'change.txt']);
  git(root, ['commit', '--quiet', '-m', 'judgment change']);

  const recorder = createDurableRecorder(path.join(root, 'receipts'));
  const boundary = createDispatchBoundary({
    adapters: { claude: { launch: judgmentReceipt } },
    recorder,
  });
  const dispatch = boundary.dispatch(
    { runtime: 'claude', role: 'arch-review', signals: {} },
    { ticket },
  );
  return { root, ticket, recorder, dispatch };
}

function archReviewResult(value, extra = {}) {
  const head = git(value.root, ['rev-parse', 'HEAD']);
  const mergeBase = git(value.root, ['merge-base', 'main', 'HEAD']);
  const baseTree = git(value.root, ['rev-parse', `${mergeBase}^{tree}`]);
  return {
    id: value.ticket,
    pr: 404,
    verdict: 'violation',
    head,
    base_tree: baseTree,
    blocking_count: 1,
    summary: 'architecture review summary',
    findings: [],
    ...extra,
  };
}

function sealArchReview(value, result) {
  const evidencePath = path.join(value.root, '.shipyard-arch-review-evidence.md');
  fs.writeFileSync(evidencePath, 'complete architecture review evidence\n');
  return roleArtifact.seal({
    worktreePath: value.root,
    base: 'main',
    role: 'arch-review',
    ticket: value.ticket,
    pr: 404,
    recorder: value.recorder,
    dispatchId: value.dispatch.receipt.dispatch_id,
    result,
    evidencePath,
  });
}

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code, `expected ${code}`);
}

suite('role-artifact — bounded executor evidence');

test('exposes the trusted seal, validate, and read boundary', () => {
  // Keep the first RED assertion about the intended behavior. A missing module
  // must not turn the RED run into an import/fixture failure.
  assert.ok(fs.existsSync(ROLE_ARTIFACT), 'trusted role-artifact helper is required');
  assert.equal(typeof roleArtifact.seal, 'function');
  assert.equal(typeof roleArtifact.validate, 'function');
  assert.equal(typeof roleArtifact.read, 'function');
});

test('registered executor host returns only a bounded envelope and validated references', async () => {
  const value = fixture({ summary: 's'.repeat(700), actionableDelta: { next: 'publish' } });
  try {
    const result = await value.host.run('executors', { args: value.args });
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'committed');
    assert.equal(result[0].id, value.ticket);
    assert.ok(result[0].artifact_ref);
    assert.ok(result[0].artifact_digest);
    assert.ok(result[0].evidence_index);
    assert.ok(Array.from(result[0].summary).length <= 500);
    assert.equal(result[0].prBodyPath, path.join(value.root, '.shipyard-pr-body.md'));
    assert.equal(result[0].evidencePath, path.join(value.root, '.shipyard-evidence.md'));
    assert.ok(JSON.stringify(result[0].artifact.envelope).length <= roleArtifact.ENVELOPE_MAX_BYTES);
    const validated = roleArtifact.validate({
      worktreePath: value.root,
      base: 'main',
      role: 'executor',
      ticket: value.ticket,
      recorder: value.recorder,
      dispatchId: result[0].receipt.dispatch_id,
      artifactPath: result[0].artifact_ref,
      artifactDigest: result[0].artifact_digest,
    });
    assert.equal(validated.pr_body, fs.readFileSync(path.join(value.root, '.shipyard-pr-body.md'), 'utf8'));
    assert.equal(validated.evidence, fs.readFileSync(path.join(value.root, '.shipyard-evidence.md'), 'utf8'));
    const duplicate = roleArtifact.seal({
      worktreePath: value.root,
      base: 'main',
      role: 'executor',
      ticket: value.ticket,
      recorder: value.recorder,
      dispatchId: result[0].receipt.dispatch_id,
      result: value.agentResult,
    });
    assert.equal(duplicate.artifact_ref, result[0].artifact_ref);
    assert.equal(duplicate.artifact_digest, result[0].artifact_digest, 'duplicate result delivery is idempotent');

    const manifestBytes = fs.readFileSync(result[0].artifact_ref);
    fs.appendFileSync(result[0].artifact_ref, 'mutation\n');
    rejectsCode(() => roleArtifact.seal({
      worktreePath: value.root,
      base: 'main',
      role: 'executor',
      ticket: value.ticket,
      recorder: value.recorder,
      dispatchId: result[0].receipt.dispatch_id,
      result: value.agentResult,
    }), 'ARTIFACT_WRITE');
    fs.writeFileSync(result[0].artifact_ref, manifestBytes);
  } finally {
    clean(value);
  }
});

test('rejects wrong dispatch, stale head, digest mutation, escaped paths, missing files, and symlinks', async () => {
  const value = await runFixture();
  const artifact = value.result[0];
  try {
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: 'dispatch-that-was-not-recorded', artifactPath: artifact.artifact_ref,
    }), 'MISSING_RECEIPT');

    const evidencePath = path.join(value.root, '.shipyard-evidence.md');
    const originalEvidence = fs.readFileSync(evidencePath);
    fs.appendFileSync(evidencePath, 'tampered\n');
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest,
    }), 'ARTIFACT_DIGEST_MISMATCH');

    rejectsCode(() => roleArtifact.seal({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id,
      result: { status: 'committed', summary: 'missing id' },
    }), 'ARTIFACT_IDENTITY_MISMATCH');
    fs.writeFileSync(evidencePath, originalEvidence);

    const manifestPath = artifact.artifact_ref;
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: manifestPath,
      artifactDigest: '0'.repeat(64),
    }), 'ARTIFACT_DIGEST_MISMATCH');
    const originalManifest = fs.readFileSync(manifestPath);
    const forgedManifest = JSON.parse(originalManifest.toString('utf8'));
    forgedManifest.files.pr_body.path = '../outside.md';
    fs.writeFileSync(manifestPath, `${JSON.stringify(forgedManifest)}\n`);
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: manifestPath,
      artifactDigest: artifact.artifact_digest,
    }), 'ARTIFACT_PATH_ESCAPE');
    fs.writeFileSync(manifestPath, originalManifest);

    fs.unlinkSync(evidencePath);
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: manifestPath,
      artifactDigest: artifact.artifact_digest,
    }), 'MISSING_ARTIFACT');
    fs.symlinkSync(path.join(value.root, 'tracked.txt'), evidencePath);
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: manifestPath,
      artifactDigest: artifact.artifact_digest,
    }), 'ARTIFACT_PATH_ESCAPE');
    fs.unlinkSync(evidencePath);
    fs.writeFileSync(evidencePath, originalEvidence);

    fs.writeFileSync(path.join(value.root, 'later.txt'), 'later\n');
    git(value.root, ['add', 'later.txt']);
    git(value.root, ['commit', '--quiet', '-m', 'fixture later head']);
    rejectsCode(() => roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: manifestPath,
      artifactDigest: artifact.artifact_digest,
    }), 'STALE_ARTIFACT');
  } finally {
    clean(value);
  }
});

test('does not accept an agent-forged receipt or an unauthenticated store', async () => {
  const forged = fixture({ forgedReceipt: true });
  try {
    await assert.rejects(
      forged.host.run('executors', { args: forged.args }),
      (error) => error && error.code === 'FORGED_RECEIPT',
    );
  } finally {
    clean(forged);
  }

  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.root, '.shipyard-pr-body.md'), 'body\n');
    fs.writeFileSync(path.join(value.root, '.shipyard-evidence.md'), 'evidence\n');
    rejectsCode(() => roleArtifact.seal({
      worktreePath: value.root,
      base: 'main',
      role: 'executor',
      ticket: value.ticket,
      boundaryStore: path.join(value.root, 'empty-receipts'),
      dispatchId: 'missing-dispatch',
      result: { id: value.ticket, status: 'committed', summary: 'no receipt' },
    }), 'MISSING_RECEIPT');
  } finally {
    clean(value);
  }
});

test('caps summaries and overflows actionable data to complete evidence', async () => {
  const value = await runFixture({
    summary: 's'.repeat(700),
    actionableDelta: 'x'.repeat(20000),
  });
  try {
    const artifact = value.result[0];
    assert.equal(artifact.status, 'committed');
    assert.ok(Array.from(artifact.summary).length <= 500);
    assert.equal(artifact.artifact.envelope.actionable_delta.type, 'reference');
    assert.ok(artifact.artifact.envelope.overflow);
    assert.ok(Buffer.byteLength(JSON.stringify(artifact.artifact.envelope), 'utf8') <= roleArtifact.ENVELOPE_MAX_BYTES);
    const validated = roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest,
    });
    assert.equal(artifact.artifact.evidence_index.sha256, validated.evidence_index.sha256);
    const targeted = roleArtifact.read({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest,
      evidenceRange: [0, 4],
    });
    assert.equal(targeted.evidence_range.content, validated.evidence.slice(0, 4));
    assert.ok(!('evidence' in targeted), 'targeted reads must not re-ingest complete evidence');
    assert.ok(!('pr_body' in targeted), 'targeted reads must not re-ingest the complete PR body');
    rejectsCode(() => roleArtifact.read({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: artifact.receipt.dispatch_id, artifactPath: artifact.artifact_ref,
      artifactDigest: artifact.artifact_digest,
      evidenceRange: [0, roleArtifact.EVIDENCE_RANGE_MAX_CHARS + 1],
    }), 'INVALID_INPUT');
  } finally {
    clean(value);
  }
});

test('blocked executor outcomes stay explicit and do not receive a publishable artifact', async () => {
  const value = await runFixture({ status: 'blocked', summary: 'blocked by a live gate' });
  try {
    assert.equal(value.result[0].status, 'blocked');
    assert.equal(value.result[0].prBodyPath, '');
    assert.equal(value.result[0].evidencePath, '');
    assert.ok(!('artifact_ref' in value.result[0]));
    assert.equal(value.result[0].summary, 'blocked by a live gate');
  } finally {
    clean(value);
  }
});

test('CLI validate/read use the canonical helper and return the verified byte snapshot', async () => {
  const value = await runFixture();
  const artifact = value.result[0];
  const bodyOut = path.join(value.root, 'validated-body.md');
  const resultFile = path.join(value.root, 'trusted-result.json');
  try {
    fs.unlinkSync(artifact.artifact_ref);
    fs.writeFileSync(resultFile, JSON.stringify(value.agentResult));
    const sealing = spawnSync(process.execPath, [
      ROLE_ARTIFACT, 'seal', '--worktree', value.root, '--base', 'main',
      '--role', 'executor', '--ticket', value.ticket, '--boundary-store', value.receipts,
      '--dispatch-id', artifact.receipt.dispatch_id, '--result-file', resultFile,
    ], { encoding: 'utf8' });
    assert.equal(sealing.status, 0, sealing.stderr);
    assert.equal(JSON.parse(sealing.stdout).artifact_digest, artifact.artifact_digest);

    const validation = spawnSync(process.execPath, [
      ROLE_ARTIFACT, 'validate', '--worktree', value.root, '--base', 'main',
      '--role', 'executor', '--ticket', value.ticket, '--boundary-store', value.receipts,
      '--dispatch-id', artifact.receipt.dispatch_id, '--artifact', artifact.artifact_ref,
      '--artifact-digest', artifact.artifact_digest,
    ], { encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
    const validated = JSON.parse(validation.stdout);
    assert.equal(validated.artifact_digest, artifact.artifact_digest);
    assert.ok(!('pr_body' in validated), 'CLI validation must not print the complete PR body');
    assert.ok(!('evidence' in validated), 'CLI validation must not print complete evidence');

    const read = spawnSync(process.execPath, [
      ROLE_ARTIFACT, 'read', '--worktree', value.root, '--base', 'main',
      '--role', 'executor', '--ticket', value.ticket, '--boundary-store', value.receipts,
      '--dispatch-id', artifact.receipt.dispatch_id, '--artifact', artifact.artifact_ref,
      '--artifact-digest', artifact.artifact_digest,
      '--pr-body-out', bodyOut,
    ], { encoding: 'utf8' });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(fs.readFileSync(bodyOut, 'utf8'), fs.readFileSync(path.join(value.root, '.shipyard-pr-body.md'), 'utf8'));
    assert.ok(!('pr_body' in JSON.parse(read.stdout)), 'CLI read must keep the complete PR body in the explicit output file');
  } finally {
    clean(value);
  }
});

suite('role-artifact — PR body hygiene by committed base (D-26/REQ-142)');

test('an exempt project still accepts the ticket marker as the first line', async () => {
  const value = await runFixture({ ticket: 'T-33-exempt' });
  try {
    assert.equal(value.result[0].status, 'committed');
    const validated = roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: value.result[0].receipt.dispatch_id,
      artifactPath: value.result[0].artifact_ref, artifactDigest: value.result[0].artifact_digest,
    });
    assert.equal(validated.pr_body, `Ticket: ${value.ticket}\n\nProblem\n\nScope\n`);
  } finally {
    clean(value);
  }
});

test('a target project rejects a PR body starting with the ticket marker', async () => {
  const value = fixture({ ticket: 'T-33-target-leak', exempt: false });
  try {
    await assert.rejects(
      value.host.run('executors', { args: value.args }),
      (error) => error && error.code === 'PR_BODY_LEAK',
    );
  } finally {
    clean(value);
  }
});

test('a target project accepts a neutral PR body and validates it', async () => {
  const value = await runFixture({ ticket: 'T-33-target-clean', exempt: false, prBody: NEUTRAL_PR_BODY_GUIDE });
  try {
    assert.equal(value.result[0].status, 'committed');
    const validated = roleArtifact.validate({
      worktreePath: value.root, base: 'main', role: 'executor', ticket: value.ticket,
      recorder: value.recorder, dispatchId: value.result[0].receipt.dispatch_id,
      artifactPath: value.result[0].artifact_ref, artifactDigest: value.result[0].artifact_digest,
    });
    assert.equal(validated.pr_body, NEUTRAL_PR_BODY_GUIDE);
  } finally {
    clean(value);
  }
});

test('an uncommitted worktree shipyard manifest does not grant the exemption', async () => {
  const value = fixture({ ticket: 'T-33-target-uncommitted', exempt: false, uncommittedManifest: true });
  try {
    await assert.rejects(
      value.host.run('executors', { args: value.args }),
      (error) => error && error.code === 'PR_BODY_LEAK',
    );
  } finally {
    clean(value);
  }
});

suite('role-artifact — unknown architecture finding types');

test('keeps an unknown arch-review type as an informational note beside a blocker', () => {
  const value = judgmentFixture();
  try {
    const result = archReviewResult(value, {
      blocking_count: 1,
      findings: [
        {
          id: 'F1', type: 'violation', blocking: true, adr: 'ADR-014', section: '§4 dispatch boundary',
          file: 'src/example.cjs', line: 1, hunk: 'src/example.cjs:1', remediation: 'preserve the boundary',
          summary: 'blocking architecture violation',
        },
        { id: 'F2', type: 'external-review-note', summary: 'informational finding from another reviewer' },
      ],
    });
    const sealed = sealArchReview(value, result);
    assert.equal(sealed.envelope.verdict, 'violation');
    assert.equal(sealed.envelope.schema, 'shipyard.judgment-result.v1');
    assert.equal(sealed.envelope.blocking_count, 1);
    const read = roleArtifact.read({
      worktreePath: value.root,
      base: 'main',
      role: 'arch-review',
      ticket: value.ticket,
      pr: 404,
      recorder: value.recorder,
      dispatchId: value.dispatch.receipt.dispatch_id,
      artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest,
    });
    assert.equal(read.findings.findings[1].type, 'informational');
    assert.equal(read.findings.findings[1].original_type, 'external-review-note');
    assert.equal(read.findings.findings[1].blocking, false);
  } finally {
    clean(value);
  }
});

test('keeps an unknown arch-review note under a conform verdict', () => {
  const value = judgmentFixture('T-43-05-conform-unknown-note');
  try {
    const result = archReviewResult(value, {
      verdict: 'conform',
      blocking_count: 0,
      findings: [{ id: 'F1', type: 'external-review-note', summary: 'informational reviewer note' }],
    });
    const sealed = sealArchReview(value, result);
    assert.equal(sealed.envelope.verdict, 'conform');
    assert.equal(sealed.envelope.outcome, 'conform');
    assert.equal(sealed.envelope.blocking_count, 0);
    assert.equal(sealed.envelope.finding_count, 1);

    const read = roleArtifact.read({
      worktreePath: value.root,
      base: 'main',
      role: 'arch-review',
      ticket: value.ticket,
      pr: 404,
      recorder: value.recorder,
      dispatchId: value.dispatch.receipt.dispatch_id,
      artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest,
    });
    assert.equal(read.envelope.verdict, 'conform');
    assert.deepEqual(read.findings.findings[0], {
      id: 'F1',
      type: 'informational',
      summary: 'informational reviewer note',
      original_type: 'external-review-note',
      blocking: false,
    });
  } finally {
    clean(value);
  }
});

test('an incomplete violation still fails and unknown notes require summary and non-blocking status', () => {
  const cases = [
    {
      ticket: 'T-43-05-missing-violation-file',
      finding: {
        id: 'F1', type: 'violation', blocking: true, adr: 'ADR-014', section: '§4 dispatch boundary',
        line: 1, hunk: 'src/example.cjs:1', remediation: 'preserve the boundary', summary: 'missing file',
      },
      blockingCount: 1,
    },
    {
      ticket: 'T-43-05-unknown-missing-summary',
      finding: { id: 'F1', type: 'external-review-note', blocking: false },
      blockingCount: 0,
    },
    {
      ticket: 'T-43-05-unknown-blocking',
      finding: { id: 'F1', type: 'external-review-note', blocking: true, summary: 'must not downgrade' },
      blockingCount: 1,
    },
  ];
  for (const item of cases) {
    const value = judgmentFixture(item.ticket);
    try {
      const result = archReviewResult(value, {
        blocking_count: item.blockingCount,
        findings: [item.finding],
      });
      assert.throws(
        () => sealArchReview(value, result),
        (error) => error && error.code === 'INCOMPLETE_FINDING',
      );
    } finally {
      clean(value);
    }
  }
});

test('blocking_count is checked after an omitted unknown-note blocking value becomes false', () => {
  const value = judgmentFixture('T-43-05-unknown-blocking-count');
  try {
    const result = archReviewResult(value, {
      blocking_count: 1,
      findings: [{ id: 'F1', type: 'external-review-note', summary: 'informational note' }],
    });
    assert.throws(
      () => sealArchReview(value, result),
      (error) => error && error.code === 'JUDGMENT_COUNT_MISMATCH',
    );
  } finally {
    clean(value);
  }
});

test('unknown arch-review normalization keeps the role artifact schema string', () => {
  assert.equal(roleArtifact.ROLE_ARTIFACT_SCHEMA, 'shipyard.role-artifact.v1');
});

done();
