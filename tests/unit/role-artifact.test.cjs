'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const testAuthorityHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-authority-')));
const testAuthorityModule = path.join(testAuthorityHome, 'fixture.cjs');
fs.writeFileSync(testAuthorityModule, "require('node:os').homedir = () => " + JSON.stringify(testAuthorityHome) + ";\n");
const testAuthorityArgs = ['--require', testAuthorityModule];
const testOriginalHomedir = os.homedir;
os.homedir = () => testAuthorityHome;
process.on('exit', () => { os.homedir = testOriginalHomedir; fs.rmSync(testAuthorityHome, {recursive:true,force:true}); });
const { execFileSync, spawnSync } = require('node:child_process');

const targetBin = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-gh-'));
fs.writeFileSync(path.join(targetBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const git = args => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write('main');
else if (args[0] === 'pr' && args[1] === 'view') {
  let base = 'main';
  try { base = JSON.parse(fs.readFileSync('.planning/config.json')).git?.base_branch || base; } catch {}
  let oid; try { oid = git(['rev-parse','refs/remotes/origin/' + base]); } catch { oid = git(['rev-parse','HEAD']); }
  process.stdout.write(JSON.stringify({number:Number(args[2]),state:'OPEN',headRefName:git(['branch','--show-current']),
    headRefOid:git(['rev-parse','HEAD']),baseRefName:base,baseRefOid:oid}));
} else process.exit(2);
`, {mode:0o755});
const targetOldPath = process.env.PATH;
process.env.PATH = targetBin + path.delimiter + targetOldPath;
process.on('exit', () => { process.env.PATH = targetOldPath; fs.rmSync(targetBin, {recursive:true,force:true}); });
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
  supportedEfforts: ['medium'],
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
      model: 'claude-sonnet-5-5',
      effort: 'medium',
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
    const sealing = spawnSync(process.execPath, [...testAuthorityArgs,
      ROLE_ARTIFACT, 'seal', '--worktree', value.root, '--base', 'main',
      '--role', 'executor', '--ticket', value.ticket, '--boundary-store', value.receipts,
      '--dispatch-id', artifact.receipt.dispatch_id, '--result-file', resultFile,
    ], { encoding: 'utf8' });
    assert.equal(sealing.status, 0, sealing.stderr);
    assert.equal(JSON.parse(sealing.stdout).artifact_digest, artifact.artifact_digest);

    const validation = spawnSync(process.execPath, [...testAuthorityArgs,
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

    const read = spawnSync(process.execPath, [...testAuthorityArgs,
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

suite('role-artifact — Codex sealed architecture context');

const codexJudgmentFixtures = require('./helpers/codex-arch-review-fixtures.cjs');

test('fresh Codex architecture artifact remains valid after CLI inflight cleanup', async () => {
  const f = codexJudgmentFixtures.fixture();
  try {
    const { validationInput } = await codexJudgmentFixtures.unitJudgment(f);
    assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
    const child = `
      const fs = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const input = JSON.parse(process.argv[1]);
      input.recorder = require(input.boundary).createDurableRecorder(input.store);
      input.io = { execFileSync(executable, args, options) {
        if (executable === 'gh') return JSON.stringify(input.fixturePr);
        if (executable === 'git' && args.includes('fetch')) return '';
        return execFileSync(executable, args, options);
      } };
      const validated = require(input.consumer).validateJudgmentManifest(input);
      process.stdout.write(JSON.stringify({ verdict: validated.envelope.verdict }));
    `;
    const childInput = { ...validationInput, recorder: undefined, io: undefined,
      fixturePr: f.pr, store: path.join(f.storage, 'receipts'),
      boundary: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/dispatch-boundary.cjs'),
      consumer: path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/role-artifact.cjs') };
    assert.equal(JSON.parse(execFileSync(process.execPath, [...testAuthorityArgs, '-e', child, JSON.stringify(childInput)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).verdict, 'conform');

  } finally { codexJudgmentFixtures.cleanupJudgment(f); }
});

for (const [name, mutate] of [
  ['ADR content', f => fs.appendFileSync(path.join(f.root,
    '.planning/architecture/ADR-014-host-bound-review.md'), '\nChanged authority.\n')],
  ['draft lifecycle', f => { f.pr.isDraft = !f.pr.isDraft; }],
  ['live head', f => { f.pr.headRefOid = 'a'.repeat(40); }],
  ['live base', f => { f.pr.baseRefOid = 'b'.repeat(40); }],
  ['plan authority', f => fs.appendFileSync(path.join(f.root,
    '.planning/phases/38-codex-arch-review/38-01-PLAN.md'), '\nChanged acceptance.\n')],
  ['graph authority', f => fs.appendFileSync(path.join(f.root,
    '.planning/graph/tickets.json'), ' ')],
  ['corpus membership', f => fs.writeFileSync(path.join(f.root,
    '.planning/architecture/ADR-099-new.md'), '# New architecture authority\n')],
  ['original transcript', (f, sealed) => fs.appendFileSync(sealed.transcript, '\n')],
  ['complete evidence', (f, sealed) => {
    const manifest = JSON.parse(fs.readFileSync(sealed.validationInput.artifactPath, 'utf8'));
    fs.appendFileSync(path.join(f.root, manifest.files.evidence.path), '\nChanged evidence.\n');
  }],
]) test('shared consumer refuses post-seal changed ' + name, async () => {
  const f = codexJudgmentFixtures.fixture();
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    mutate(f, sealed);
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput),
      /changed|local changes|STALE|digest|transcript|head|base|identity differs/);
  } finally { codexJudgmentFixtures.cleanupJudgment(f); }
});


test('shared consumer refuses atomic source replacement while its original descriptor is open', async () => {
  const f = codexJudgmentFixtures.fixture();
  const originalOpen = fs.openSync;
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    const target = path.join(f.root, '.planning/architecture/ADR-014-host-bound-review.md');
    let replaced = false;
    fs.openSync = function (filePath, ...args) {
      const fd = originalOpen.call(fs, filePath, ...args);
      if (String(filePath) === target && !replaced) {
        replaced = true;
        const replacement = path.join(f.storage, 'replacement.md');
        fs.writeFileSync(replacement, '# Replaced complete architecture authority\n');
        fs.renameSync(replacement, target);
      }
      return fd;
    };
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput), /changed/);
    assert.equal(replaced, true);
  } finally {
    fs.openSync = originalOpen;
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});

test('public sealer cannot rebind an original native receipt to another canonical context', async () => {
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const f = codexJudgmentFixtures.fixture();
  const canonical = f.root + '-canonical';
  try {
    const { result, recorder, validationInput, transcript } = await codexJudgmentFixtures.unitJudgment(f);
    const originalRecordDigest = sha(JSON.stringify(recorder.getVerifiedRecord(result.receipt.dispatch_id)));
    const originalTranscriptDigest = sha(fs.readFileSync(transcript));
    const manifest = JSON.parse(fs.readFileSync(result.artifact.ref));
    const archived = JSON.parse(fs.readFileSync(path.join(f.root, manifest.files.findings.path)));
    const evidence = fs.readFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'));
    execFileSync('git', ['-C', f.root, 'worktree', 'add', canonical, 'main'], { stdio: 'pipe' });
    fs.appendFileSync(path.join(canonical, '.planning/architecture/ADR-014-host-bound-review.md'),
      '\nNEW AUTHORITY NEVER REVIEWED BY ORIGINAL TRANSCRIPT.\n');
    fs.rmSync(path.join(f.root, '.shipyard-role-artifacts'), { recursive: true });
    fs.rmSync(path.join(f.root, '.planning/graph/dispatches.json'));
    fs.rmSync(path.join(f.root, '.planning/graph/provenance'), { recursive: true });
    const graphDir = path.join(canonical, '.planning/graph');
    assert.throws(() => context.prepare({ worktree: f.root, ticket: result.subject, phase: 38 },
      { role: 'arch-review', context: {}, signals: {} },
      { graphDir, getPullRequest: () => f.pr, refreshGit: false }), /historical archive.*missing|ENOENT/);
    fs.rmSync(roleArtifact.archiveAuthorityDirectory(f.root), { recursive: true, force: true });
    execFileSync('git', ['-C', canonical, 'add', '.planning/architecture/ADR-014-host-bound-review.md'], { stdio: 'pipe' });
    execFileSync('git', ['-C', canonical, 'commit', '-m', 'fixture: commit distinct canonical authority'], { stdio: 'pipe' });
    const fresh = context.prepare({ worktree: f.root, ticket: result.subject, phase: 38 },
      { role: 'arch-review', context: {}, signals: {} },
      { graphDir, getPullRequest: () => f.pr, refreshGit: false });
    const forged = { ...archived, host_context: { ...archived.host_context,
      graph_dir: graphDir, packet_digest: fresh.prepared.packet.digest,
      selected_refs: fresh.evidence.selected_refs, bookkeeping: [] } };
    fs.writeFileSync(path.join(f.root, '.shipyard-arch-review-evidence.md'), evidence);
    let rejection;
    try { roleArtifact.sealJudgment({ ...validationInput, result: forged }); }
    catch (error) { rejection = error; }
    assert.equal(sha(JSON.stringify(recorder.getVerifiedRecord(result.receipt.dispatch_id))), originalRecordDigest);
    assert.equal(sha(fs.readFileSync(transcript)), originalTranscriptDigest);
    assert.notEqual(forged.host_context.packet_digest, archived.host_context.packet_digest);
    assert(rejection, 'forged context was accepted with original receipt and transcript');
    assert.match(rejection.message, /original authenticated launch identity/);

  } finally {
    try { execFileSync('git', ['-C', f.root, 'worktree', 'remove', '--force', canonical], { stdio: 'pipe' }); } catch {}
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});


test('shared consumer refuses corpus membership added during recursive inventory', async () => {
  const f = codexJudgmentFixtures.fixture();
  const originalRead = fs.readdirSync;
  try {
    const sealed = await codexJudgmentFixtures.unitJudgment(f);
    const directory = path.join(f.root, '.planning/architecture');
    let added = false;
    fs.readdirSync = function (filePath, ...args) {
      const entries = originalRead.call(fs, filePath, ...args);
      if (String(filePath) === directory && !added) {
        added = true;
        fs.writeFileSync(path.join(directory, 'ADR-099-added-during-inventory.md'), '# New authority\n');
      }
      return entries;
    };
    assert.throws(() => roleArtifact.validateJudgmentManifest(sealed.validationInput), /membership changed/);
    assert.equal(added, true);
  } finally {
    fs.readdirSync = originalRead;
    codexJudgmentFixtures.cleanupJudgment(f);
  }
});

suite('role-artifact — protected archive lifecycle');

test('Claude archives retain authenticated history and stale catalogue locks recover', () => {
  const value = judgmentFixture('T-47-14-claude-retention');
  try {
    const directory = roleArtifact.archiveAuthorityDirectory(value.root, true);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, 'catalogue.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner', at: '2000-01-01T00:00:00Z' }));
    const sealed = sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    const pins = roleArtifact.authenticatedArchivePins(value.root);
    assert.equal(pins.length, 3);
    assert.ok(pins.some(pin => pin.sha256 === sealed.artifact_digest));
    assert.equal(fs.existsSync(lock), false);
    fs.writeFileSync(path.join(value.root, '.shipyard-role-artifacts', 'unknown.log'), 'unauthenticated');
    assert.throws(() => roleArtifact.assertArchiveInventory(value.root, pins), /membership/);
  } finally { clean(value); }
});

test('oversized findings fail before any archive directory or member is published', () => {
  const value = judgmentFixture('T-47-14-oversized-findings');
  try {
    assert.throws(() => sealArchReview(value, archReviewResult(value, {
      verdict: 'conform', blocking_count: 0, detail: 'x'.repeat(4 * 1024 * 1024 + 1),
    })), /complete-byte bound/);
    assert.equal(fs.existsSync(path.join(value.root, '.shipyard-role-artifacts')), false);
  } finally { clean(value); }
});

test('failed late validation rolls back only this attempt and preserves retained history', () => {
  const value = judgmentFixture('T-47-14-publication-rollback');
  const originalLink = fs.linkSync;
  try {
    const first = sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    const existingPins = roleArtifact.authenticatedArchivePins(value.root);
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder: value.recorder });
    value.dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    const next = archReviewResult(value, { verdict: 'conform', blocking_count: 0 });
    let changed = false;
    fs.linkSync = function (source, target) {
      const result = originalLink.call(fs, source, target);
      if (String(target).endsWith('.shipyard-role-artifact.json') && !changed) {
        changed = true;
        fs.writeFileSync(path.join(value.root, '.shipyard-arch-review-evidence.md'), 'changed during sealing');
      }
      return result;
    };
    assert.throws(() => sealArchReview(value, next), /evidence|complete/);
    assert.equal(changed, true);
    assert.deepEqual(roleArtifact.authenticatedArchivePins(value.root), existingPins);
    assert.equal(fs.existsSync(first.artifact_ref), true);
  } finally { fs.linkSync = originalLink; clean(value); }
});

test('trusted bookkeeping updates remain mutable while changed bytes and unknown provenance are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-bookkeeping-authority-'));
  const store = path.join(root, '.planning/graph/dispatches.json');
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    roleArtifact.trustedBookkeepingMutation(root, () => fs.writeFileSync(store, '{"one":1}'));
    roleArtifact.trustedBookkeepingMutation(root, () => fs.writeFileSync(store, '{"two":2}'));
    const provenance = path.join(root, '.planning/graph/provenance/dispatch-one.json');
    roleArtifact.trustedBookkeepingMutation(root, () => {
      fs.mkdirSync(path.dirname(provenance), { recursive: true }); fs.writeFileSync(provenance, '{"dispatch":"one"}');
    }, ['.planning/graph/provenance/dispatch-one.json']);
    assert.equal(roleArtifact.historicalBookkeepingPins(root).length, 2);
    const catalogue = path.join(roleArtifact.archiveAuthorityDirectory(root), 'catalogue.json');
    const before = fs.readFileSync(catalogue);
    assert.throws(() => roleArtifact.trustedBookkeepingMutation(root, () => {
      fs.writeFileSync(store, '{"three":3}');
      fs.writeFileSync(provenance, '{"dispatch":"bad"}');
    }, ['.planning/graph/dispatches.json']), /undeclared authenticated bookkeeping.*(changed|differs)/);
    assert.deepEqual(fs.readFileSync(catalogue), before);
    fs.writeFileSync(store, '{"two":2}');
    fs.writeFileSync(provenance, '{"dispatch":"one"}');
    fs.writeFileSync(store, '{"bad":9}');
    let invoked = false;
    assert.throws(() => roleArtifact.trustedBookkeepingMutation(root, () => { invoked = true; }), /bookkeeping.*changed|authenticated.*pin/);
    assert.equal(invoked, false);
    fs.writeFileSync(store, '{"two":2}');
    fs.writeFileSync(path.join(path.dirname(provenance), 'forged.json'), '{}');
    assert.throws(() => roleArtifact.trustedBookkeepingMutation(root, () => {}), /unknown host provenance/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('complete multi-archive Claude legacy admission is atomic and rejects unknown physical members', () => {
  const crypto = require('node:crypto');
  const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  const sha = content => crypto.createHash('sha256').update(content).digest('hex');
  const value = judgmentFixture('T-47-14-multi-archive');
  try {
    const first = sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    const firstId = value.dispatch.receipt.dispatch_id;
    const firstReceipt = value.recorder.getVerifiedRecord(firstId).receipt;
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder: value.recorder });
    value.dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    const second = sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    const pins = roleArtifact.authenticatedArchivePins(value.root);
    const archives = [[first, firstId, firstReceipt], [second, value.dispatch.receipt.dispatch_id, value.dispatch.receipt]].map(([sealed, dispatchId, receipt]) => ({
      dispatchId, recorder: value.recorder, expectedManifestDigest: sealed.artifact_digest,
      expectedReceiptDigest: sha(stable(receipt)), expectedArchivePins: pins.filter(pin => pin.path.startsWith(path.relative(fs.realpathSync(value.root), path.dirname(sealed.artifact_ref)) + '/')),
    }));
    assert.deepEqual(archives.map(archive => archive.expectedArchivePins.length), [3, 3]);
    fs.rmSync(roleArtifact.archiveAuthorityDirectory(value.root), { recursive: true, force: true });
    const unknown = path.join(value.root, '.shipyard-role-artifacts', 'unknown.log');
    fs.writeFileSync(unknown, 'unknown');
    assert.throws(() => roleArtifact.admitHistoricalArchive({ worktreePath: value.root, archives }), /unknown archive membership/);
    const catalogue = path.join(roleArtifact.archiveAuthorityDirectory(value.root), 'catalogue.json');
    assert.equal(fs.existsSync(catalogue), false);
    fs.unlinkSync(unknown);
    roleArtifact.admitHistoricalArchive({ worktreePath: value.root, archives });
    assert.deepEqual(roleArtifact.authenticatedArchivePins(value.root), pins);
  } finally { clean(value); }
});

test('live catalogue lock timeout never invokes a writer or changes retained bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-live-archive-lock-'));
  const store = path.join(root, '.planning/graph/dispatches.json');
  let held;
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    roleArtifact.trustedBookkeepingMutation(root, () => fs.writeFileSync(store, '{"original":1}'));
    const directory = roleArtifact.archiveAuthorityDirectory(root);
    const catalogue = path.join(directory, 'catalogue.json');
    const originalCatalogue = fs.readFileSync(catalogue);
    const originalStore = fs.readFileSync(store);
    held = require('../../plugins/delivery-pipeline/scripts/lock.cjs').acquire(directory, 'catalogue', { waitMs: 0 });
    assert(held);
    const ownerFile = path.join(held.path, 'owner.json');
    const originalOwner = fs.readFileSync(ownerFile);
    const agedOwner = { ...JSON.parse(originalOwner), at: '2000-01-01T00:00:00Z' };
    fs.writeFileSync(ownerFile, JSON.stringify(agedOwner));
    let invoked = false;
    assert.throws(() => roleArtifact.trustedBookkeepingMutation(root, () => {
      invoked = true; fs.writeFileSync(store, '{"bad":2}');
    }), error => error?.code === 'ARCHIVE_AUTHORITY_BUSY');
    assert.equal(invoked, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile)), agedOwner);
    assert.deepEqual(fs.readFileSync(catalogue), originalCatalogue);
    assert.deepEqual(fs.readFileSync(store), originalStore);
    assert.equal(fs.existsSync(path.join(root, '.shipyard-role-artifacts')), false);
  } finally { held?.release(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('lost catalogue owner before publication refuses new archive bytes and preserves successor lock', () => {
  const value = judgmentFixture('T-47-14-lost-owner-before-publication');
  const originalOpen = fs.openSync;
  let directory;
  try {
    sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    const pins = roleArtifact.authenticatedArchivePins(value.root);
    directory = roleArtifact.archiveAuthorityDirectory(value.root);
    const catalogue = path.join(directory, 'catalogue.json');
    const ownerFile = path.join(directory, 'catalogue.lock/owner.json');
    const originalCatalogue = fs.readFileSync(catalogue);
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder: value.recorder });
    value.dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    let successor;
    fs.openSync = function (file, ...args) {
      const fd = originalOpen.call(fs, file, ...args);
      if (String(file) === catalogue && fs.existsSync(ownerFile) && !successor) {
        successor = { ...JSON.parse(fs.readFileSync(ownerFile)), token: 'replacement-owner-before-publication' };
        fs.writeFileSync(ownerFile, JSON.stringify(successor));
      }
      return fd;
    };
    assert.throws(() => sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 })), /ownership|owner|lock/i);
    assert(successor);
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile)), successor);
    assert.deepEqual(fs.readFileSync(catalogue), originalCatalogue);
    assert.deepEqual(roleArtifact.authenticatedArchivePins(value.root), pins);
  } finally {
    fs.openSync = originalOpen;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    clean(value);
  }
});

test('lost catalogue owner before rollback leaves successor-owned archive files untouched', () => {
  const value = judgmentFixture('T-47-14-lost-owner-before-rollback');
  const originalLink = fs.linkSync;
  let directory;
  try {
    sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
    directory = roleArtifact.archiveAuthorityDirectory(value.root);
    const catalogue = path.join(directory, 'catalogue.json');
    const ownerFile = path.join(directory, 'catalogue.lock/owner.json');
    const originalCatalogue = fs.readFileSync(catalogue);
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder: value.recorder });
    value.dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    let successor, published, publishedBytes;
    fs.linkSync = function (source, target) {
      const result = originalLink.call(fs, source, target);
      if (String(target).endsWith('.shipyard-role-artifact.json') && !successor) {
        published = target; publishedBytes = fs.readFileSync(target);
        successor = { ...JSON.parse(fs.readFileSync(ownerFile)), token: 'replacement-owner-before-rollback' };
        fs.writeFileSync(ownerFile, JSON.stringify(successor));
        fs.writeFileSync(path.join(value.root, '.shipyard-arch-review-evidence.md'), 'changed before validation');
      }
      return result;
    };
    assert.throws(() => sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 })), /evidence|ownership|owner|lock/i);
    assert(successor);
    assert.deepEqual(fs.readFileSync(published), publishedBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile)), successor);
    assert.deepEqual(fs.readFileSync(catalogue), originalCatalogue);
  } finally {
    fs.linkSync = originalLink;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    clean(value);
  }
});

function phaseScopeFixture({ second = false, empty = false } = {}) {
  const value = judgmentFixture('T-47-01');
  value.originalReceiptStore = path.join(value.root, 'receipts');
  value.root = fs.realpathSync(value.root);
  const rows = [];
  const retain = item => {
    sealArchReview(item, archReviewResult(item, { verdict: 'conform', blocking_count: 0 }));
    rows.push({ worktree: fs.realpathSync(item.root), ticket: item.ticket,
      dispatch_id: item.dispatch.receipt.dispatch_id, receipt: item.dispatch.receipt,
      receipt_store: item.originalReceiptStore || path.join(item.root, 'receipts'), pins: roleArtifact.authenticatedArchivePins(item.root) });
  };
  if (!empty) retain(value);
  if (second) {
    value.second = value.root + '-second';
    git(value.root, ['worktree', 'add', '--detach', value.second, 'HEAD']);
    const recorder = createDurableRecorder(path.join(value.second, 'receipts'));
    const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder });
    const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: 'T-47-02' });
    retain({ root: value.second, ticket: 'T-47-02', recorder, dispatch });
  }
  const graphDir = path.join(value.root, '.planning/graph');
  fs.mkdirSync(graphDir, { recursive: true });
  const tickets = Object.fromEntries((second ? ['T-47-01', 'T-47-02'] : ['T-47-01']).map(id => [id,
    { phase: '47', epic: 'epic/47-scope', plan: '.planning/phases/47-scope/' + id + '-PLAN.md' }]));
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), '{}');
  git(value.root, ['switch', '-c', 'epic/47-scope']);
  git(value.root, ['add', '.planning']); git(value.root, ['commit', '-m', 'fixture: current phase graph']);
  const binding = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({
    graph: { tickets }, state: {}, phase: 47,
    repository: git(value.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    branch: 'epic/47-scope', pr: 404, head: git(value.root, ['rev-parse', 'HEAD']), base: git(value.root, ['rev-parse', 'main']) });
  const inventoryPath = path.join(value.root, 'retained-inventory.json');
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows }), { mode: 0o600 });
  const input = { worktreePath: value.root, graphDir, binding, inventoryPath,
    expectedInventoryDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(inventoryPath)).digest('hex') };
  const roster = roleArtifact.registerPhaseArchiveRoster(input);
  return { ...value, input, rows, roster,
    select: extra => roleArtifact.selectPhaseArchives(value.root, binding, { graphDir, ...extra }) };
}

function cleanPhaseScope(value) {
  if (value.second) fs.rmSync(value.second, { recursive: true, force: true });
  clean(value);
}

test('phase-local archive scope: two original current tickets and older source receipts remain complete', () => {
  const value = phaseScopeFixture({ second: true });
  try {
    const selected = value.select();
    assert.equal(selected.evidence.length, 2);
    for (const row of selected.evidence) {
      assert.equal(row.files.length, 3);
      const manifest = JSON.parse(row.files.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).content);
      assert.notEqual(manifest.head, value.input.binding.subject.split(';head=')[1].split(';')[0]);
      assert.deepEqual(row.receipt, value.rows.find(original => original.dispatch_id === row.dispatch_id).receipt);
    }
    assert.deepEqual(roleArtifact.readPhaseArchiveRoster(value.input), value.roster);
    assert.deepEqual(roleArtifact.registerPhaseArchiveRoster(value.input), value.roster);
    assert.throws(() => roleArtifact.selectPhaseArchives(value.root, value.input.binding,
      { graphDir: value.input.graphDir, phaseArchiveSelection: { ...selected.selection, records: [] } }), /frozen/);
    const foreign = path.join(value.root, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'foreign');
    fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: 'T-38-01' }));
    fs.writeFileSync(path.join(foreign, 'findings.json'), 'changed foreign findings');
    assert.equal(roleArtifact.phaseArchitectureEvidenceDigest(value.select().evidence), roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence));
    assert.throws(() => roleArtifact.authenticatedArchivePins(value.root), /membership/);
  } finally { cleanPhaseScope(value); }
});

function mutateFixtureCatalogue(value, mutate) {
  const directory = roleArtifact.archiveAuthorityDirectory(value.root);
  const file = path.join(directory, 'catalogue.json');
  const envelope = JSON.parse(fs.readFileSync(file)); mutate(envelope.payload);
  envelope.mac = require('node:crypto').createHmac('sha256', fs.readFileSync(path.join(directory, 'hmac.key')))
    .update(stableTestValue(envelope.payload)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope));
}

function stableTestValue(value) {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  return JSON.stringify(normalize(value));
}

for (const registered of [false, true])
for (const [name, mutate] of [
  ['missing selected manifest', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path))],
  ['missing selected evidence', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith('.md')).path))],
  ['missing selected findings', value => fs.unlinkSync(path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith('/findings.json')).path))],
  ['removed entire selected family', value => fs.rmSync(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), { recursive: true })],
  ['changed selected bytes', value => fs.appendFileSync(path.join(value.root, value.rows[0].pins[0].path), 'changed')],
  ['changed selected mode', value => fs.chmodSync(path.join(value.root, value.rows[0].pins[0].path), 0o644)],
  ['extra selected member', value => fs.writeFileSync(path.join(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), 'extra'), 'extra')],
  ['nonregular selected member', value => fs.symlinkSync('missing', path.join(path.dirname(path.join(value.root, value.rows[0].pins[0].path)), 'extra'))],
  ['removed protected selected record', value => mutateFixtureCatalogue(value, payload => { delete payload.records[value.rows[0].dispatch_id]; })],
  ['changed protected original receipt', value => mutateFixtureCatalogue(value, payload => { payload.records[value.rows[0].dispatch_id].receipt.ticket = 'T-38-forged'; })],
  ['changed protected original pin', value => mutateFixtureCatalogue(value, payload => { payload.records[value.rows[0].dispatch_id].pins[0].sha256 = '0'.repeat(64); })],
  ['missing selected catalogue', value => fs.unlinkSync(path.join(roleArtifact.archiveAuthorityDirectory(value.root), 'catalogue.json'))],
  ['missing protected roster', value => fs.unlinkSync(value.roster.record_path)],
  ['tampered protected roster', value => fs.appendFileSync(value.roster.record_path, 'changed')],
  ['missing original recorder record', value => fs.rmSync(path.join(value.root, 'receipts'), { recursive: true })],
  ['relabelled manifest and removed authority before discovery', value => {
    const manifest = path.join(value.root, value.rows[0].pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path);
    fs.writeFileSync(manifest, JSON.stringify({ ticket: 'T-38-01', boundary_subject: 'T-38-01' }));
    fs.unlinkSync(path.join(roleArtifact.archiveAuthorityDirectory(value.root), 'catalogue.json'));
  }],
  ['forged current family', value => {
    const family = path.join(value.root, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'forged'); fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: value.ticket }));
  }],
  ['changed actual membership', value => {
    const file = path.join(value.input.graphDir, 'tickets.json'); const graph = JSON.parse(fs.readFileSync(file));
    graph.tickets['T-47-extra'] = { ...graph.tickets[value.ticket] }; fs.writeFileSync(file, JSON.stringify(graph));
  }],
]) test('phase-local archive scope: ' + name + ' refuses against independent retained membership in ' + (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  try {
    const frozen = value.select().selection;
    const row = value.rows[registered ? 1 : 0];
    mutate({ ...value, root: row.worktree, ticket: row.ticket, rows: [row] });
    assert.throws(() => value.select({ phaseArchiveSelection: frozen }));
  } finally { cleanPhaseScope(value); }
});

function addForeignPhaseFamilies(root) {
  const directory = path.join(root, roleArtifact.ARTIFACT_ARCHIVE_DIR);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 1001; index++) {
    const family = path.join(directory, 'foreign-volume-' + String(index).padStart(4, '0'));
    fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({
      ticket: 'T-38-01', boundary_subject: 'T-38-01' }));
    fs.writeFileSync(path.join(family, 'evidence.md'), 'foreign evidence');
    fs.writeFileSync(path.join(family, 'findings.json'), 'foreign findings');
  }
  return directory;
}

for (const registered of [false, true])
test('phase-local archive scope: foreign volume preserves evidence and late current omission refuses in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  const previousReaddir = fs.readdirSync;
  try {
    const selected = value.select();
    const row = value.rows[registered ? 1 : 0];
    const directory = addForeignPhaseFamilies(row.worktree);
    const after = value.select();
    assert.deepEqual(after, selected);
    assert.equal(roleArtifact.phaseArchitectureEvidenceDigest(after.evidence),
      roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence));
    for (const name of previousReaddir(directory).filter(name => name.startsWith('foreign-volume-'))) {
      fs.appendFileSync(path.join(directory, name, 'evidence.md'), 'changed');
      fs.appendFileSync(path.join(directory, name, 'findings.json'), 'changed');
    }
    assert.deepEqual(value.select(), selected);
    const omitted = 'zz-current-omitted';
    fs.mkdirSync(path.join(directory, omitted));
    fs.writeFileSync(path.join(directory, omitted, roleArtifact.MANIFEST_NAME), JSON.stringify({ ticket: row.ticket }));
    let scannedForeign = 0;
    fs.readdirSync = function(file, ...args) {
      const names = previousReaddir.call(this, file, ...args);
      if (file !== directory) return names;
      const foreign = names.filter(name => name.startsWith('foreign-volume-')).sort();
      scannedForeign = foreign.length;
      return [...names.filter(name => !foreign.includes(name) && name !== omitted), ...foreign, omitted];
    };
    assert.throws(() => value.select(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /possible current family is absent from independently retained roster/ });
    assert.equal(scannedForeign, 1001);
  } finally { fs.readdirSync = previousReaddir; cleanPhaseScope(value); }
});

function fixtureAggregateHint(value, row, boundary) {
  const subject = value.input.binding.subject;
  const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} },
    { ticket: subject, subject_kind: 'phase', phase: 47 });
  const id = dispatch.receipt.dispatch_id;
  const familyName = require('node:crypto').createHash('sha256').update(id).digest('hex');
  const family = path.join(roleArtifact.ARTIFACT_ARCHIVE_DIR, familyName);
  fs.mkdirSync(path.join(row.worktree, family));
  const pins = row.pins.filter(pin => !pin.path.endsWith(roleArtifact.MANIFEST_NAME)).map(pin => {
    const relative = path.join(family, path.basename(pin.path));
    fs.copyFileSync(path.join(row.worktree, pin.path), path.join(row.worktree, relative));
    fs.chmodSync(path.join(row.worktree, relative), 0o600);
    return { ...pin, path: relative };
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(row.worktree,
    row.pins.find(pin => pin.path.endsWith(roleArtifact.MANIFEST_NAME)).path)));
  Object.assign(manifest, { producer_dispatch: id, producer_dispatch_id: id, dispatch_id: id,
    producer_launch: dispatch.receipt.launch_id, boundary_subject: subject, policy_hash: dispatch.receipt.policy_hash,
    runtime: dispatch.receipt.runtime, role: dispatch.receipt.role });
  for (const field of ['evidence', 'findings']) {
    const pin = pins.find(pin => path.basename(pin.path) === path.basename(manifest.files[field].path));
    manifest.files[field] = { ...manifest.files[field], ...pin };
  }
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = path.join(family, roleArtifact.MANIFEST_NAME);
  fs.writeFileSync(path.join(row.worktree, manifestPath), bytes, { mode: 0o600 });
  pins.push({ path: manifestPath, bytes: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') });
  return { familyName, id, record: { dispatch_id: id, ticket: subject, receipt: dispatch.receipt, pins } };
}

for (const registered of [false, true])
test('phase-local archive scope: missing producer without current dispatch refuses in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  try {
    const selected = value.select();
    assert.deepEqual(selected.selection.records, value.roster.records);
    const row = value.rows[registered ? 1 : 0];
    const family = path.join(row.worktree, roleArtifact.ARTIFACT_ARCHIVE_DIR, 'missing-producer');
    fs.mkdirSync(family);
    fs.writeFileSync(path.join(family, roleArtifact.MANIFEST_NAME), JSON.stringify({
      boundary_subject: value.input.binding.subject }));
    for (const options of [{}, { currentDispatchId: '' }]) {
      assert.throws(() => value.select(options), { code: 'ARCHIVE_AUTHORITY_INVALID',
        message: /aggregate candidate lacks original protected authority/ });
    }
  } finally { cleanPhaseScope(value); }
});

for (const registered of [false, true])
for (const target of ['catalogue.json', 'hmac.key'])
test('phase-local archive scope: changed ' + target + ' during selection refuses in ' +
    (registered ? 'another registered worktree' : 'review worktree'), () => {
  const value = phaseScopeFixture({ second: registered });
  const previousReaddir = fs.readdirSync;
  const row = value.rows[registered ? 1 : 0];
  const family = path.dirname(path.join(row.worktree, row.pins[0].path));
  let changed = false;
  try {
    fs.readdirSync = function(file, ...args) {
      const names = previousReaddir.call(this, file, ...args);
      if (file === family && !changed) {
        changed = true;
        const authority = path.join(roleArtifact.archiveAuthorityDirectory(row.worktree), target);
        if (target === 'catalogue.json') fs.appendFileSync(authority, ' ');
        else fs.chmodSync(authority, 0o400);
      }
      return names;
    };
    assert.throws(() => value.select(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /archive authority changed during phase selection/ });
    assert.equal(changed, true);
  } finally { fs.readdirSync = previousReaddir; cleanPhaseScope(value); }
});

test('phase-local archive scope: relevant 1000 boundary is independent of foreign volume and resets per worktree', () => {
  const value = phaseScopeFixture({ second: true });
  const previousReaddir = fs.readdirSync;
  try {
    const populations = value.rows.map(row => {
      const directory = addForeignPhaseFamilies(row.worktree);
      const recorder = createDurableRecorder(path.join(row.worktree, 'aggregate-receipts'));
      const boundary = createDispatchBoundary({ adapters: { claude: { launch: judgmentReceipt } }, recorder });
      const hints = Array.from({ length: 1001 }, () => fixtureAggregateHint(value, row, boundary));
      mutateFixtureCatalogue({ root: row.worktree }, payload => {
        for (const hint of hints) payload.records[hint.id] = hint.record;
      });
      return { directory, hints };
    });
    const missingProducer = 'missing-producer';
    fs.mkdirSync(path.join(populations[0].directory, missingProducer));
    fs.writeFileSync(path.join(populations[0].directory, missingProducer, roleArtifact.MANIFEST_NAME),
      JSON.stringify({ boundary_subject: value.input.binding.subject }));
    let overflow = false, malformedOverflow = false;
    fs.readdirSync = function(file, ...args) {
      const names = previousReaddir.call(this, file, ...args);
      const population = populations.find(item => item.directory === file);
      if (!population) return names;
      const aggregateNames = population.hints.map(hint => hint.familyName);
      return [...names.filter(name => !aggregateNames.includes(name) && name !== missingProducer),
        ...aggregateNames.slice(0, overflow && population === populations[0] ? 1001 : 1000),
        ...(malformedOverflow && population === populations[0] ? [missingProducer] : [])];
    };
    const previousOpen = fs.openSync;
    const catalogues = new Set(value.rows.map(row => path.join(roleArtifact.archiveAuthorityDirectory(row.worktree), 'catalogue.json')));
    let catalogueReads = 0;
    const measuredSelect = options => {
      catalogueReads = 0;
      fs.openSync = function(file, ...args) {
        if (catalogues.has(file)) catalogueReads++;
        return previousOpen.call(this, file, ...args);
      };
      try { return value.select(options); }
      finally { fs.openSync = previousOpen; assert.equal(catalogueReads, 2); }
    };
    const selected = measuredSelect();
    assert.equal(selected.candidates.length, 2000);
    assert.equal(new Set(selected.candidates.map(candidate => candidate.dispatch_id)).size, 2000);
    assert.deepEqual(selected.selection.records, value.roster.records);
    malformedOverflow = true;
    assert.throws(() => measuredSelect(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /archive identity hints exceed their bound/ });
    malformedOverflow = false;
    overflow = true;
    assert.throws(() => measuredSelect(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /archive identity hints exceed their bound/ });
    assert.equal(measuredSelect({ currentDispatchId: populations[0].hints[1000].id }).candidates.length, 2000);
  } finally { fs.readdirSync = previousReaddir; cleanPhaseScope(value); }
});

test('phase-local archive scope: authenticated empty history differs from missing history', () => {
  const value = phaseScopeFixture({ empty: true });
  try {
    assert.deepEqual(value.select().evidence, []);
    fs.unlinkSync(value.roster.record_path);
    assert.throws(value.select, /roster is missing/);
  } finally { cleanPhaseScope(value); }
});

test('phase-local archive scope: retained inventory cannot invent receipts, pins or roster replacements', () => {
  const value = phaseScopeFixture();
  try {
    for (const mutate of [rows => { rows[0].receipt.ticket = 'T-38-forged'; },
      rows => { rows[0].pins.pop(); }, rows => { rows[0].ticket = 'T-38-forged'; },
      rows => { rows.length = 0; }]) {
      const rows = structuredClone(value.rows); mutate(rows);
      fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
      const expectedInventoryDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
      assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }));
      assert.deepEqual(value.select().selection.records, value.roster.records);
    }
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest: '0'.repeat(64) }), /inventory differs/);
  } finally { cleanPhaseScope(value); }
});

test('phase-local archive scope: independent inventory and authenticated roster retain their 1000 limits', () => {
  const value = phaseScopeFixture();
  const original = fs.readFileSync(value.roster.record_path);
  try {
    const rows = Array.from({ length: 1001 }, () => value.rows[0]);
    fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
    const expectedInventoryDigest = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }),
      { code: 'ARCHIVE_AUTHORITY_INVALID', message: /complete retained current inventory rows are required/ });
    const envelope = JSON.parse(original);
    envelope.payload.records = Array.from({ length: 1001 }, () => value.roster.records[0]);
    envelope.mac = require('node:crypto').createHmac('sha256',
      fs.readFileSync(path.join(path.dirname(value.roster.record_path), 'hmac.key')))
      .update(stableTestValue(envelope.payload)).digest('hex');
    fs.writeFileSync(value.roster.record_path, JSON.stringify(envelope));
    assert.throws(() => value.select(), { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /current phase roster authentication or membership differs/ });
  } finally { fs.writeFileSync(value.roster.record_path, original); cleanPhaseScope(value); }
});

test('phase-local archive scope: independently authenticated original record with conflicting receipt ticket refuses', () => {
  const value = phaseScopeFixture();
  try {
    const recorder = createDurableRecorder(path.join(value.root, 'conflicting-receipts'));
    const boundary = createDispatchBoundary({ adapters: { claude: { launch(resolution) {
      return { ...judgmentReceipt(resolution), ticket: 'T-38-conflicting' };
    } } }, recorder });
    const dispatch = boundary.dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: value.ticket });
    const original = recorder.getVerifiedRecord(dispatch.receipt.dispatch_id);
    assert.equal(original.ticket, value.ticket);
    assert.equal(original.receipt.ticket, 'T-38-conflicting');
    const rows = [{ ...value.rows[0], dispatch_id: dispatch.receipt.dispatch_id,
      receipt: original.receipt, receipt_store: path.join(value.root, 'conflicting-receipts') }];
    fs.writeFileSync(value.input.inventoryPath, JSON.stringify({ rows }));
    const expectedInventoryDigest = require('node:crypto').createHash('sha256').update(fs.readFileSync(value.input.inventoryPath)).digest('hex');
    assert.throws(() => roleArtifact.registerPhaseArchiveRoster({ ...value.input, expectedInventoryDigest }), /ticket identities conflict/);
  } finally { cleanPhaseScope(value); }
});

done();
