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

suite('role-artifact — judgment evidence bound parity');

test('judgment evidence bound parity role/runtime descriptor thresholds', () => {
  const Module = require('node:module');
  const isolated = new Module(ROLE_ARTIFACT, module);
  isolated.filename = ROLE_ARTIFACT;
  isolated.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
  isolated._compile(fs.readFileSync(ROLE_ARTIFACT, 'utf8')
    + '\nmodule.exports = { judgmentEvidenceMaximum, readImmutableFile };', ROLE_ARTIFACT);
  const { judgmentEvidenceMaximum, readImmutableFile } = isolated.exports;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'judgment-bound-')));
  const file = path.join(root, 'evidence.md');
  try {
    for (const [role, runtime, maximum] of [
      ['arch-review', 'codex', 96 * 1024],
      ['integrator', 'codex', 96 * 1024],
      ['integrator', 'claude', 96 * 1024],
      ['arch-review', 'claude', 4 * 1024 * 1024],
      ['pr-sentinel', 'codex', 4 * 1024 * 1024],
      ['pr-sentinel', 'claude', 4 * 1024 * 1024],
    ]) {
      assert.equal(judgmentEvidenceMaximum(role, runtime), maximum);
      fs.writeFileSync(file, Buffer.alloc(maximum, 120));
      assert.equal(readImmutableFile(fs, file, 'complete judgment evidence',
        judgmentEvidenceMaximum(role, runtime)).length, maximum);
      fs.appendFileSync(file, 'x');
      assert.throws(() => readImmutableFile(fs, file, 'complete judgment evidence',
        judgmentEvidenceMaximum(role, runtime)), error => error.code === 'INVALID_ARTIFACT'
          && error.message === 'complete judgment evidence exceeds its authenticated complete-byte bound');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const size of [96 * 1024, 96 * 1024 + 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1]) {
  test('judgment evidence bound parity Claude complete bytes ' + size, () => {
    const value = judgmentFixture('T-47-26-bound-' + size);
    try {
      const evidencePath = path.join(value.root, '.shipyard-arch-review-evidence.md');
      const content = 'é'.repeat(Math.floor(size / 2)) + (size % 2 ? 'x' : '');
      fs.writeFileSync(evidencePath, content);
      const input = { worktreePath: value.root, base: 'main', role: 'arch-review',
        ticket: value.ticket, pr: 404, recorder: value.recorder,
        dispatchId: value.dispatch.receipt.dispatch_id, evidencePath,
        result: archReviewResult(value, { verdict: 'conform', blocking_count: 0 }) };
      if (size > 4 * 1024 * 1024) {
        assert.throws(() => roleArtifact.seal(input), error => error.code === 'INVALID_ARTIFACT'
          && error.message === 'complete judgment evidence exceeds its authenticated complete-byte bound');
        assert.equal(fs.existsSync(path.join(value.root, '.shipyard-role-artifacts')), false);
        return;
      }
      const sealed = roleArtifact.seal(input);
      const validation = { ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest };
      const read = roleArtifact.read(validation);
      assert.equal(read.evidence, content);
      assert.equal(read.evidence_index.bytes, size);
      assert.equal(read.findings.verdict, 'conform');
      fs.appendFileSync(evidencePath, 'x'.repeat(4 * 1024 * 1024 + 1 - size));
      assert.throws(() => roleArtifact.validate(validation), error => error.code === 'INVALID_ARTIFACT'
        && error.message === 'complete judgment evidence exceeds its authenticated complete-byte bound');
    } finally { clean(value); }
  });
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

function phaseScopeFixture({ second = false, empty = false, repo = null, mixed = false } = {}) {
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
    { phase: '47', repo, epic: 'epic/47-scope', plan: '.planning/phases/47-scope/' + id + '-PLAN.md' }]));
  if (mixed) tickets.foreign = {...tickets['T-47-01'],repo:repo === null ? 'acme/foreign' : null,epic:'epic/foreign',plan:'.planning/phases/47-foreign/foreign-PLAN.md'};
  fs.writeFileSync(path.join(graphDir, 'tickets.json'), JSON.stringify({ tickets }));
  fs.writeFileSync(path.join(graphDir, 'delivery-state.json'), '{}');
  git(value.root, ['switch', '-c', 'epic/47-scope']);
  git(value.root, ['add', '.planning']); git(value.root, ['commit', '-m', 'fixture: current phase graph']);
  const binding = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({
    graph: { tickets }, state: {}, phase: 47, repo,
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
    mutateFixtureCatalogue(value, payload => { payload.records.forged = {
      dispatch_id: 'forged', ticket: value.input.binding.subject, receipt: { role: 'arch-review' }, pins: [],
    }; });
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
test('phase-local archive scope: foreign volume and unselected families do not affect literal selection in ' +
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
    assert.deepEqual(value.select(), selected);
    assert.equal(scannedForeign, 0);
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
test('phase-local archive scope: unselected missing producer is not opened in ' +
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
      assert.deepEqual(value.select(options), selected);
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

test('phase-local archive scope: total selected judgment bound precedes all candidate manifests', () => {
  const value = phaseScopeFixture({ second: true });
  const previousOpen = fs.openSync;
  try {
    for (const row of value.rows) mutateFixtureCatalogue({ root: row.worktree }, payload => {
      for (let i = 0; i < 501; i++) payload.records['candidate-' + i] = {
        dispatch_id: 'candidate-' + i, ticket: value.input.binding.subject,
        receipt: { role: 'arch-review' }, pins: [],
      };
    });
    fs.openSync = function(file, ...args) {
      if (String(file).includes('candidate-')) throw new Error('candidate opened before total bound');
      return previousOpen.call(this, file, ...args);
    };
    assert.throws(value.select, { code: 'ARCHIVE_AUTHORITY_INVALID',
      message: /selected phase judgments exceed their total bound/ });
  } finally { fs.openSync = previousOpen; cleanPhaseScope(value); }
});

test('phase-local archive scope: 10000 registered foreign worktree hints never open archive bodies or authority', () => {
  const value = phaseScopeFixture();
  const foreign = path.join(path.dirname(value.root), 'foreign-' + Date.now());
  const gitShim = path.join(targetBin, 'git');
  const previousOpen = fs.openSync, previousReaddir = fs.readdirSync;
  try {
    execFileSync('git', ['-C', value.root, 'worktree', 'add', '--detach', foreign, 'HEAD'], { stdio: 'ignore' });
    addForeignPhaseFamilies(foreign);
    const authority = roleArtifact.archiveAuthorityDirectory(foreign);
    const expected = value.select();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(gitShim, '#!/usr/bin/env node\n' +
      'const cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
      'process.stdout.write(cp.execFileSync(' + JSON.stringify(realGit) + ', args));\n' +
      'if (args.includes("worktree") && args.includes("list")) for (let i = 0; i < 10000; i++) ' +
      'process.stdout.write("worktree " + ' + JSON.stringify('/tmp/t4716-unselected-') + ' + i + "\\n\\n");\n',
      { mode: 0o755 });
    fs.openSync = function(file, ...args) {
      if (String(file).startsWith(foreign + path.sep) || String(file).startsWith(authority + path.sep))
        throw new Error('foreign body or key opened');
      return previousOpen.call(this, file, ...args);
    };
    fs.readdirSync = function(file, ...args) {
      if (String(file).endsWith(roleArtifact.ARTIFACT_ARCHIVE_DIR)) throw new Error('archive enumerated');
      return previousReaddir.call(this, file, ...args);
    };
    assert.deepEqual(value.select(), expected);
    const subject = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').PHASE_SUBJECT.exec(value.input.binding.subject);
    assert.equal(roleArtifact.currentArchitectureVerdict({ worktreePath: value.root,
      graphDir: value.input.graphDir, pr: 404, head: subject[5], baseCommit: subject[6],
      baseName: 'main', headBranch: 'epic/47-scope' }), null);
  } finally {
    fs.openSync = previousOpen; fs.readdirSync = previousReaddir;
    if (fs.existsSync(gitShim)) fs.unlinkSync(gitShim);
    execFileSync('git', ['-C', value.root, 'worktree', 'remove', '--force', foreign], { stdio: 'ignore' });
    cleanPhaseScope(value);
  }
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

function containmentAuthorityFixture(value = fixture(), leaseEpoch = 1) {
  const crypto = require('node:crypto');
  const root = fs.realpathSync(value.root);
  const binding = { launch: { scope: { worktree: root, run_id: 'original-run', ticket: value.ticket, phase: 47, runtime: 'codex', provider: 'openai' },
    dispatch_id: 'original-dispatch', gsd_role: 'gsd-planner', role: 'decomposition',
    request_sha256: '1'.repeat(64), policy_hash: '2'.repeat(64), policy_version: 'original-policy',
    model: 'gpt-6.1-sol', effort: 'low', rung: 'base',
    agent: { file: path.join(root, 'agent.toml'), sha256: '3'.repeat(64), instructions_sha256: '6'.repeat(64) } },
    launched_at: '2026-10-08T00:00:00.000Z', reservation: { dispatch_id: 'original-dispatch', reserved_at: 'original-reservation' },
    source_revision: git(root, ['rev-parse', 'HEAD']), writer_lease_file: path.join(root, 'lease.json'),
    lease_epoch: leaseEpoch, lease_identity_sha256: '4'.repeat(64), tree_snapshot_sha256: '5'.repeat(64) };
  const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
  const token = sealer.captureContainmentBaseline({ worktree: root });
  const reference = sealer.persistContainmentBaseline({ worktree: root, baseline: token, binding });
  const directory = roleArtifact.archiveAuthorityDirectory(root);
  const file = path.join(directory, reference.reference);
  const read = (overrides = {}) => roleArtifact.readPlanningContainmentBaseline({ worktree: root, binding, reference, ...overrides });
  const snapshot = read();
  const register = (overrides = {}) => roleArtifact.registerPlanningContainmentBaseline({ worktree: root, binding, snapshot, ...overrides });
  return { value, root, binding, sealer, token, reference, directory, file, read, register, snapshot, crypto };
}

suite('original protected planning containment');

test('phase47 original containment recovery preserves a pre-existing deleted tracked parent directory', () => {
  const value = fixture();
  try {
    const directory = path.join(value.root, 'src', 'nested');
    const relative = 'src/nested/tracked.cjs';
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(value.root, relative), 'original tracked source\n');
    git(value.root, ['add', relative]);
    git(value.root, ['commit', '-m', 'tracked parent fixture']);
    fs.rmSync(path.join(value.root, 'src'), { recursive: true });
    const c = containmentAuthorityFixture(value);
    assert.deepEqual(c.snapshot.sources.find(([key]) => key === relative), [relative, null]);
    assert.deepEqual(c.snapshot.status.find(([key]) => key === relative), [relative, ' D']);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(value.root, relative), 'original tracked source\n');
    assert.throws(() => c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored }),
      { code: 'CONTAINMENT_VIOLATION' });
  } finally { clean(value); }
});

for (const kind of ['ENOTDIR', 'EACCES', 'symlink', 'file', 'movement']) {
  test('phase47 original containment recovery deleted tracked parent inspection ' + kind, () => {
    const value = fixture();
    const lstat = fs.lstatSync;
    try {
      const root = fs.realpathSync(value.root);
      const directory = path.join(root, 'src', 'nested');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'tracked.cjs'), 'tracked source\n');
      git(root, ['add', 'src/nested/tracked.cjs']);
      git(root, ['commit', '-m', 'tracked parent inspection fixture']);
      fs.rmSync(directory, { recursive: true });
      if (kind === 'symlink') fs.symlinkSync(root, directory);
      if (kind === 'file') fs.writeFileSync(directory, 'physical file');
      let inspected = false;
      fs.lstatSync = function(target, ...args) {
        if (target === directory) {
          inspected = true;
          if (kind === 'ENOTDIR' || kind === 'EACCES')
            throw Object.assign(new Error('injected parent inspection error'), { code: kind });
          if (kind === 'movement') fs.writeFileSync(path.join(root, 'src', 'changed'), 'changed parent');
        }
        return lstat.call(this, target, ...args);
      };
      const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
      if (kind === 'ENOTDIR') {
        const baseline = sealer.captureContainmentBaseline({ worktree: root });
        sealer.assertContained({ worktree: root, allowed: [], baseline });
      } else assert.throws(() => sealer.captureContainmentBaseline({ worktree: root }),
        { code: kind === 'EACCES' ? 'EACCES' : kind === 'movement' ? 'CONTAINMENT_VIOLATION' : 'CONTAINMENT_STATUS_FAILED' });
      assert.equal(inspected, true);
    } finally { fs.lstatSync = lstat; clean(value); }
  });
}

test('phase47 original containment recovery preserves an unchanged untracked nested repository directory', () => {
  const value = fixture();
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor);
    git(vendor, ['init']);
    fs.writeFileSync(path.join(vendor, 'nested.txt'), 'original nested repository content\n');
    assert.ok(git(value.root, ['status', '--porcelain=v1', '--untracked-files=all']).includes('?? vendor/'));
    const c = containmentAuthorityFixture(value);
    assert.deepEqual(c.snapshot.status.find(([key]) => key === 'vendor/'), ['vendor/', '??']);
    assert.match(c.snapshot.sources.find(([key]) => key === 'vendor/')[1], /^\d+:directory-sha256:[a-f0-9]{64}$/);
    assert.equal(c.snapshot.sources.some(([key]) => key === 'vendor'), false);
    const bytes = fs.readFileSync(c.file);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    assert.deepEqual(c.read(), c.snapshot);
    assert.deepEqual(c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: restored,
      binding: c.binding }), c.reference);
    assert.deepEqual(fs.readFileSync(c.file), bytes);
    assert.equal(fs.readFileSync(path.join(vendor, 'nested.txt'), 'utf8'), 'original nested repository content\n');
  } finally { clean(value); }
});

test('phase47 original containment recovery refuses authenticated legacy directory-only restoration', () => {
  const value = fixture();
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor); git(vendor, ['init']);
    const c = containmentAuthorityFixture(value);
    const envelope = JSON.parse(fs.readFileSync(c.file));
    const entry = envelope.payload.snapshot.sources.find(([key]) => key === 'vendor/');
    entry[1] = entry[1].split(':')[0] + ':directory';
    const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
      : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
        : JSON.stringify(value);
    const payload = stable(envelope.payload);
    envelope.mac = c.crypto.createHmac('sha256', fs.readFileSync(path.join(c.directory, 'hmac.key'))).update(payload).digest('hex');
    fs.writeFileSync(c.file, JSON.stringify(envelope));
    const reference = { ...c.reference, sha256: c.crypto.createHash('sha256').update(payload).digest('hex') };
    const bytes = fs.readFileSync(c.file);
    assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference, recoveredEpoch: 2 }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(value); }
});

test('phase47 original containment recovery refuses movement during directory inspection', () => {
  const value = fixture();
  const read = fs.readSync;
  try {
    const vendor = path.join(value.root, 'vendor');
    fs.mkdirSync(vendor); git(vendor, ['init']);
    const file = path.join(vendor, 'nested.txt');
    fs.writeFileSync(file, 'original');
    const inode = fs.statSync(file).ino;
    let mutated = false;
    fs.readSync = function(fd, ...args) {
      const result = read.call(this, fd, ...args);
      if (!mutated && fs.fstatSync(fd).ino === inode) {
        mutated = true; fs.appendFileSync(file, 'changed during inspection');
      }
      return result;
    };
    const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
    assert.throws(() => sealer.captureContainmentBaseline({ worktree: value.root }), { code: 'CONTAINMENT_VIOLATION' });
    assert.equal(mutated, true);
  } finally { fs.readSync = read; clean(value); }
});

for (const kind of ['symlink', 'unsupported', 'depth', 'entries', 'bytes', 'gitPointer'])
  test('phase47 original containment recovery bounds rooted directory ' + kind, () => {
    const value = fixture();
    try {
      const vendor = path.join(value.root, 'vendor');
      fs.mkdirSync(vendor);
      git(vendor, ['init']);
      if (kind === 'unsupported') require('node:child_process').execFileSync('mkfifo', [path.join(vendor, 'pipe')]);
      if (kind === 'symlink') fs.symlinkSync(path.dirname(value.root), path.join(vendor, 'escape'));
      if (kind === 'depth') {
        let current = vendor;
        for (let i = 0; i < 33; i++) { current = path.join(current, 'd'); fs.mkdirSync(current); }
      }
      if (kind === 'entries') for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(vendor, 'f' + i), '');
      if (kind === 'bytes') {
        const fd = fs.openSync(path.join(vendor, 'large'), 'w');
        try { fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
      }
      const sealer = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');
      if (kind === 'gitPointer') {
        const linked = path.join(vendor, 'linked');
        fs.mkdirSync(linked);
        fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /outside/root\n');
        const c = containmentAuthorityFixture(value);
        sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.token });
        fs.appendFileSync(path.join(linked, '.git'), 'changed pointer bytes\n');
        assert.throws(() => sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.token }),
          { code: 'CONTAINMENT_VIOLATION' });
      } else assert.throws(() => sealer.captureContainmentBaseline({ worktree: value.root }),
        { code: 'CONTAINMENT_STATUS_FAILED' });
    } finally { clean(value); }
  });

for (const [name, bytes] of Object.entries({ truncated: '{"payload":', emptyObject: '{}', null: 'null',
  missingPayload: '{"mac":"' + '0'.repeat(64) + '"}', nullPayload: '{"payload":null}',
  malformedMac: '{"payload":{},"mac":[]}' }))
  test('phase47 original containment recovery rejects malformed protected JSON ' + name, () => {
    const c = containmentAuthorityFixture();
    try {
      fs.writeFileSync(c.file, bytes);
      assert.throws(() => c.read(), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
      assert.equal(fs.readFileSync(c.file, 'utf8'), bytes);
    } finally { clean(c.value); }
  });

test('phase47 original containment recovery authenticates initial epoch zero and requires its exact successor', () => {
  const c = containmentAuthorityFixture(fixture(), 0);
  try {
    assert.equal(c.read().head, c.binding.source_revision);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
      reference: c.reference, recoveredEpoch: 1 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    for (const recoveredEpoch of [0, 2])
      assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding,
        reference: c.reference, recoveredEpoch }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    const binding = structuredClone(c.binding);
    binding.lease_epoch = -1;
    assert.throws(() => c.register({ binding }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
  } finally { clean(c.value); }
});

test('phase47 original containment recovery private token persistence is immutable and restores only authenticated authority', () => {
  const c = containmentAuthorityFixture();
  try {
    const bytes = fs.readFileSync(c.file);
    assert.deepEqual(c.register(), c.reference);
    assert.deepEqual(c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: c.token, binding: c.binding }), c.reference);
    const restored = c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding, reference: c.reference, recoveredEpoch: 2 });
    c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: restored });
    const replacement = structuredClone(c.binding);
    replacement.launch.dispatch_id = 'replacement-dispatch';
    replacement.reservation.dispatch_id = 'replacement-dispatch';
    for (const baseline of [c.token, restored])
      assert.throws(() => c.sealer.persistContainmentBaseline({ worktree: c.root, baseline, binding: replacement }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.persistContainmentBaseline({ worktree: c.root, baseline: {}, binding: c.binding }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.assertContained({ worktree: c.root, allowed: [], baseline: c.snapshot }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    assert.throws(() => c.sealer.restoreContainmentBaseline({ worktree: c.root, binding: c.binding, reference: c.reference, recoveredEpoch: 3 }), { code: 'CONTAINMENT_BASELINE_INVALID' });
    const changed = structuredClone(c.snapshot); changed.index = '0'.repeat(64);
    assert.throws(() => c.register({ snapshot: changed }), /immutable/);
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(c.value); }
});

for (const [name, mutate] of Object.entries({
  duplicate(s) { s.sources.push(s.sources[0]); },
  escaped(s) { s.sources[0][0] = '../escape'; },
  absolute(s) { s.sources[0][0] = '/escape'; },
  repeatedSlash(s) { s.sources[0][0] = 'vendor//'; },
  interiorSlash(s) { s.sources[0][0] = 'vendor//child/'; },
  traversalSlash(s) { s.sources[0][0] = 'vendor/../'; },
  dotSlash(s) { s.sources[0][0] = 'vendor/./'; },
  absoluteSlash(s) { s.sources[0][0] = '/vendor/'; },
  backslash(s) { s.sources[0][0] = 'a\\b'; },
  unsorted(s) { s.sources.reverse(); },
  missing(s) { delete s.sources; },
  legacyDirectory(s) { s.sources[0][1] = '16877:directory'; },
  badIdentity(s) { s.sources[0][1] = 'unbound'; },
  badStatus(s) { s.status = [['absent', '??']]; },
  wrongHead(s) { s.head = '0'.repeat(40); },
  wrongRoot(s) { s.root += '-other'; },
})) test('phase47 original containment recovery rejects ' + name + ' serialized map', () => {
  const c = containmentAuthorityFixture();
  try {
    const snapshot = structuredClone(c.snapshot); mutate(snapshot);
    const bytes = fs.readFileSync(c.file);
    assert.throws(() => c.register({ snapshot }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
    assert.deepEqual(fs.readFileSync(c.file), bytes);
  } finally { clean(c.value); }
});

for (const [name, mutate] of Object.entries({
  run(b) { b.launch.scope.run_id += '-other'; },
  ticket(b) { b.launch.scope.ticket += '-other'; },
  phase(b) { b.launch.scope.phase++; },
  dispatch(b) { b.launch.dispatch_id += '-other'; },
  request(b) { b.launch.request_sha256 = '0'.repeat(64); },
  policy(b) { b.launch.policy_hash = '0'.repeat(64); },
  generatedSelection(b) { b.launch.generated_agent = { file: 'other.toml', sha256: '0'.repeat(64) }; },
  source(b) { b.source_revision = '0'.repeat(40); },
  lease(b) { b.lease_epoch++; },
  leaseIdentity(b) { b.lease_identity_sha256 = '0'.repeat(64); },
  leaseFile(b) { b.writer_lease_file += '-other'; },
  tree(b) { b.tree_snapshot_sha256 = '0'.repeat(64); },
  launchTime(b) { b.launched_at = '2026-10-08T01:00:00.000Z'; },
  reservation(b) { b.reservation.reserved_at += '-other'; },
})) test('phase47 original containment recovery rejects cross-launch ' + name + ' binding', () => {
  const c = containmentAuthorityFixture();
  try {
    const binding = structuredClone(c.binding); mutate(binding);
    assert.throws(() => c.read({ binding }), { code: 'CONTAINMENT_AUTHORITY_INVALID' });
  } finally { clean(c.value); }
});

for (const name of ['payload', 'mac', 'digest', 'reference', 'missing', 'symlink', 'oversized', 'publicSnapshot', 'otherWorktree'])
  test('phase47 original containment recovery authenticates protected ' + name, () => {
    const c = containmentAuthorityFixture();
    let other;
    try {
      const envelope = JSON.parse(fs.readFileSync(c.file));
      let overrides = {};
      if (name === 'payload') { envelope.payload.snapshot.index = '0'.repeat(64); fs.writeFileSync(c.file, JSON.stringify(envelope)); }
      if (name === 'mac') { envelope.mac = '0'.repeat(64); fs.writeFileSync(c.file, JSON.stringify(envelope)); }
      if (name === 'digest') overrides.reference = { ...c.reference, sha256: '0'.repeat(64) };
      if (name === 'reference') overrides.reference = { ...c.reference, reference: '../hmac.key' };
      if (name === 'missing') fs.unlinkSync(c.file);
      if (name === 'symlink') { fs.unlinkSync(c.file); fs.symlinkSync(path.join(c.directory, 'hmac.key'), c.file); }
      if (name === 'oversized') fs.writeFileSync(c.file, Buffer.alloc(4 * 1024 * 1024 + 1));
      if (name === 'publicSnapshot') overrides.reference = c.snapshot;
      if (name === 'otherWorktree') { other = fixture(); overrides.worktree = fs.realpathSync(other.root); }
      assert.throws(() => c.read(overrides));
    } finally { clean(c.value); if (other) clean(other); }
  });

for (const archived of [false, true]) test('phase47 original containment recovery retains missing original key with ' + (archived ? 'archive/source records' : 'baseline only'), () => {
  const value = archived ? phaseScopeFixture() : fixture();
  const c = containmentAuthorityFixture(value);
  try {
    const retained = fs.readdirSync(c.directory).filter(name => name !== 'hmac.key')
      .map(name => [name, fs.readFileSync(path.join(c.directory, name))]);
    const archivePins = archived ? value.rows.flatMap(row => row.pins.map(pin => [path.join(row.worktree, pin.path), fs.readFileSync(path.join(row.worktree, pin.path))])) : [];
    fs.unlinkSync(path.join(c.directory, 'hmac.key'));
    assert.throws(() => c.register(), /original authority key/);
    assert.throws(() => c.read());
    assert.equal(fs.existsSync(path.join(c.directory, 'hmac.key')), false);
    for (const [name, bytes] of retained) assert.deepEqual(fs.readFileSync(path.join(c.directory, name)), bytes);
    for (const [file, bytes] of archivePins) assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { if (archived) cleanPhaseScope(value); else clean(value); }
});


for (const mutation of ['missingAuthority', 'missingStore', 'missingKey', 'invalidKey', 'foreignKey', 'symlinkKey', 'symlinkStore', 'symlinkRecord', 'broadKey', 'oversizedRecord', 'tamper', 'legacy'])
  test('F2 readonly original receipt authority refuses without mutation: ' + mutation, async () => {
    const value = await runFixture();
    try {
      const crypto = require('node:crypto');
      const store = path.resolve(value.receipts);
      const key = path.join(path.dirname(store), '.shipyard-dispatch-authority-' + crypto.createHash('sha256').update(store).digest('hex') + '.key');
      const dispatchId = value.result[0].receipt.dispatch_id;
      const record = path.join(store, 'record-' + crypto.createHash('sha256').update(dispatchId).digest('hex') + '.json');
      if (mutation === 'missingAuthority') { fs.rmSync(store, {recursive:true}); fs.unlinkSync(key); }
      if (mutation === 'missingStore') fs.rmSync(store, {recursive:true});
      if (mutation === 'missingKey') fs.unlinkSync(key);
      if (mutation === 'invalidKey') fs.writeFileSync(key, 'invalid');
      if (mutation === 'foreignKey') fs.writeFileSync(key, Buffer.alloc(32, 7));
      if (mutation === 'symlinkKey') { fs.renameSync(key, key + '.original'); fs.symlinkSync(key + '.original', key); }
      if (mutation === 'symlinkStore') { fs.renameSync(store, store + '.original'); fs.symlinkSync(store + '.original', store); }
      if (mutation === 'symlinkRecord') { fs.renameSync(record, record + '.original'); fs.symlinkSync(record + '.original', record); }
      if (mutation === 'broadKey') fs.chmodSync(key, 0o644);
      if (mutation === 'oversizedRecord') fs.writeFileSync(record, Buffer.alloc(16 * 1024 * 1024 + 1));
      if (mutation === 'tamper') { const raw = JSON.parse(fs.readFileSync(record)); raw.payload.receipt.launch_id += '-tampered'; fs.writeFileSync(record, JSON.stringify(raw)); }
      if (mutation === 'legacy') { const raw = JSON.parse(fs.readFileSync(record)); fs.writeFileSync(record, JSON.stringify(raw.payload)); }
      const snapshot = () => {
        const rows = [];
        const visit = dir => { for (const name of fs.readdirSync(dir).sort()) {
          const file = path.join(dir, name), stat = fs.lstatSync(file);
          rows.push([path.relative(value.root,file), stat.mode, stat.ino, stat.mtimeMs, stat.ctimeMs,
            stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString('hex') : null]);
          if (stat.isDirectory()) visit(file);
        } }; visit(value.root); return rows;
      };
      const before = snapshot();
      const input = {worktreePath:value.root, ticket:value.ticket, base:'main', boundaryStore:store, dispatchId};
      for (const consumer of ['validate', 'read', 'seal']) {
        assert.throws(() => roleArtifact[consumer](input), error => ['MISSING_RECEIPT','RECORD_FAILED'].includes(error.code));
        assert.deepEqual(snapshot(), before);
      }
    } finally { clean(value); }
  });

test('F2 original durable receipt parity and genuine fresh-process DIRECT Codex validate/read', async () => {
  const fixtureAPI = require('./codex-arch-review-context.test.cjs');
  const f = fixtureAPI.fixture();
  try {
    const {validationInput:input} = await fixtureAPI.unitJudgment(f);
    const expected = roleArtifact.validateJudgmentManifest(input);
    const preload = path.join(f.storage, 'F2-disposable-direct-cli-io.cjs');
    fs.writeFileSync(preload, "require('node:os').homedir=()=>" + JSON.stringify(os.homedir()) + ";\n"
      + "const cp=require('node:child_process'),original=cp.execFileSync;cp.execFileSync=function(executable,args,options){"
      + "if(executable==='gh')return " + JSON.stringify(JSON.stringify(f.pr)) + ";"
      + "if(executable==='git'&&args.includes('fetch'))return '';return original(executable,args,options);};\n");
    const args = ['--worktree',input.worktreePath,'--role','arch-review','--ticket',input.ticket,
      '--pr',String(input.pr),'--base',input.base,'--boundary-store',path.join(f.storage,'receipts'),
      '--dispatch-id',input.dispatchId,'--artifact',input.artifactPath,'--artifact-digest',input.artifactDigest];
    const keyFiles = fs.readdirSync(f.storage).filter(name => name.startsWith('.shipyard-dispatch-authority-'));
    assert.equal(keyFiles.length, 1);
    const receiptDirectory = path.join(f.storage, 'receipts');
    const records = fs.readdirSync(receiptDirectory).sort().map(name => [name, fs.readFileSync(path.join(receiptDirectory,name))]);
    const keys = keyFiles.map(name => [name, fs.readFileSync(path.join(f.storage,name))]);
    for (const command of ['validate','read']) {
      const result = spawnSync(process.execPath, ['--require',preload,ROLE_ARTIFACT,command,...args],
        {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /assertArchiveInventory is not a function|circular dependency/i);
      const output = JSON.parse(result.stdout);
      assert.equal(output.envelope.verdict, expected.envelope.verdict);
      const invalid = spawnSync(process.execPath, ['--require',preload,ROLE_ARTIFACT,command,...args.slice(0,-1),'0'.repeat(64)],
        {encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /ARTIFACT_DIGEST_MISMATCH/);
      assert.equal(output.artifactDigest || output.artifact_digest, expected.artifactDigest || expected.artifact_digest);
      assert.deepEqual(fs.readdirSync(receiptDirectory).sort(), records.map(([name]) => name));
      for (const [name, bytes] of records) assert.deepEqual(fs.readFileSync(path.join(receiptDirectory,name)), bytes);
      for (const [name, bytes] of keys) assert.deepEqual(fs.readFileSync(path.join(f.storage,name)), bytes);
    }
  } finally { fixtureAPI.cleanupJudgment(f); }
});

for (const repo of [null, 'acme/selected']) test('mixed repository archive scope retains exact selected evidence: ' + repo, () => {
  const value = phaseScopeFixture({repo,mixed:true});
  try {
    const selected = value.select();
    assert.deepEqual(selected.selection.identity.tickets,['T-47-01']);
    assert.equal(selected.evidence.length,1);
    for (const edit of [{repo:'acme/missing'}, {repo:repo === null ? 'acme/foreign' : null},
      {rows:[]}, {membership:'0'.repeat(64)}])
      assert.throws(()=>roleArtifact.selectPhaseArchives(value.root,{...value.input.binding,...edit},{graphDir:value.input.graphDir}));
    const pin = value.rows[0].pins.find(pin=>pin.path.endsWith('.md'));
    fs.unlinkSync(path.join(value.root,pin.path));
    assert.throws(()=>value.select({phaseArchiveSelection:selected.selection}));
  } finally {cleanPhaseScope(value);}
});

done();
