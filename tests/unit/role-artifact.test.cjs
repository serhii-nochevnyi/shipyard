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
const { suite, test: runTest, done, assert } = require('./assert-harness.cjs');
let pendingCase = Promise.resolve();
function test(name, callback) {
  runTest(name, () => {
    const current = pendingCase.then(callback);
    pendingCase = current.catch(() => {});
    return current;
  });
}
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
    ...(value.ticketSet ? { ticketSet: value.ticketSet } : {}),
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

for (const mutation of ['progress', 'duplicate-contract', 'duplicate-item', 'corrupt-terminal', 'failed-turn', 'incomplete-turn', 'foreign-session'])
test('original focused CLI retains progress and rejects invalid terminal results: ' + mutation, async () => {
  const f = codexJudgmentFixtures.fixture();
  const prototype = require('node:events').EventEmitter.prototype;
  const emit = prototype.emit;
  let observed = false;
  prototype.emit = function(event, bytes, ...args) {
    if (event === 'data' && Buffer.isBuffer(bytes) && bytes.toString().includes('shipyard.focused-architecture-review.v1')) {
      const rows = bytes.toString().trim().split('\n').map(JSON.parse);
      const index = rows.findIndex(row => row.item?.type === 'agent_message');
      if (index >= 0 && rows[index].item.text.includes('shipyard.focused-architecture-review.v1')) {
        observed = true;
        const progress = structuredClone(rows[index]);
        progress.item.id += '-progress'; progress.item.text = 'Inspecting the current diff and governing ADRs.';
        rows.splice(index, 0, progress);
        if (mutation === 'duplicate-contract') {
          const duplicate = structuredClone(rows[index + 1]); duplicate.item.id += '-duplicate';
          rows.splice(index + 1, 0, duplicate);
        }
        if (mutation === 'duplicate-item') progress.item.id = rows[index + 1].item.id;
        if (mutation === 'corrupt-terminal') {
          const corrupt = structuredClone(progress); corrupt.item.id += '-corrupt'; corrupt.item.text = '{"review_contract":';
          rows.splice(index + 2, 0, corrupt);
        }
        if (mutation === 'failed-turn') rows.splice(rows.length - 1, 0, { type: 'turn.failed', error: { message: 'original failed turn' } });
        if (mutation === 'incomplete-turn') rows.splice(rows.findIndex(row => row.type === 'turn.completed'), 1);
        if (mutation === 'foreign-session') rows.unshift({ ...rows[0], thread_id: 'foreign-session' });
        bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      }
    }
    return emit.call(this, event, bytes, ...args);
  };
  try {
    if (mutation === 'progress') {
      const { validationInput } = await codexJudgmentFixtures.unitJudgment(f);
      assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
      assert.equal(roleArtifact.read(validationInput).envelope.verdict, 'conform');
      assert.equal(roleArtifact.currentArchitectureVerdict({ worktreePath: f.root, pr: f.pr.number,
        head: f.head, baseName: 'main', baseCommit: f.base, headBranch: f.pr.headRefName,
        graphDir: path.join(f.root, '.planning/graph') })?.dispatch_id, validationInput.dispatchId);
    } else await assert.rejects(() => codexJudgmentFixtures.unitJudgment(f));
    assert.ok(observed, 'original registered native CLI boundary was exercised');
  } finally { prototype.emit = emit; codexJudgmentFixtures.cleanupJudgment(f); }
});

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
    assert.throws(() => roleArtifact.trustedBookkeepingMutation(root, () => {}),
      error => error.code === 'LEGACY_HISTORY_UNKNOWN_MEMBER' && /unknown host provenance/.test(error.message));
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

async function aggregateNativeDispatch(value, selected) {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { createClaudeRuntimeHost } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { createClaudeDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
  const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered original Claude stream is required');
  const templates = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(record => !record.shipyard_fixture);
  const template = predicate => structuredClone(templates.find(predicate));
  const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const session = crypto.randomUUID();
  const subject = value.input.binding.subject;
  const aggregate = { ...value, ticket: subject, ticketSet: value.input.binding.ticketSet };
  const result = archReviewResult(aggregate, { verdict: 'conform', blocking_count: 0,
    ticket_set: aggregate.ticketSet,
    host_context: { phase_archive_selection: selected.selection, graph_dir: value.input.graphDir,
      phase_repo: null, phase_evidence_digest: roleArtifact.phaseArchitectureEvidenceDigest(selected.evidence) } });
  const original = { ...result, evidence_markdown: 'complete architecture review evidence\n' };
  const requiredRefs = ['.planning/graph/tickets.json', '.planning/graph/delivery-state.json',
    path.relative(value.root, value.input.inventoryPath), ...selected.pins.map(pin => pin.path)];
  const base = git(value.root, ['rev-parse', 'main']);
  const packet = packets.buildContextPacket({ root: value.root, role: 'arch-review', subject,
    sourceRevision: result.head, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
    scope: { files_modified: requiredRefs }, requiredRefs, uniqueContent: true,
    roleContext: { adr_refs: [], exact_diff: { base, head: result.head,
      content: git(value.root, ['diff', base, 'HEAD', '--']) },
      integration_base: { ref: 'main', commit: base, tree: result.base_tree },
      ticket_set: aggregate.ticketSet, ticket_set_digest: value.input.binding.membership,
      phase_archive_roster: { identity: selected.selection.identity, roster_digest: selected.selection.roster_digest,
        inventory_digest: selected.selection.inventory_digest } } });
  packets.validateContextPacket(packet, { root: value.root, role: 'arch-review', subject,
    sourceRevision: result.head, policyHash: policy.POLICY_HASH });
  const prompt = '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packet) + '\n</AUTHENTICATED_CONTEXT_PACKET>';
  const transcriptDir = path.join(value.root, 'aggregate-transcripts');
  let suppliedUserInput;
  const runtime = createClaudeRuntimeHost({
    scope: { run_id: 'archive-aggregate-' + session, ticket: subject, phase: 47, worktree: value.root },
    recorder: value.recorder, transcriptDir, uuid: () => session,
    startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
    sessionTranscriptRoot: path.join(value.root, 'aggregate-native'),
    probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
      capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
    spawn(_file, args) {
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let framedInput = '';
      child.stdin = { write(bytes) { framedInput += bytes; }, end() {
        process.nextTick(() => {
          try {
            assert.ok(framedInput.endsWith('\n'));
            suppliedUserInput = JSON.parse(framedInput.slice(0, -1));
            assert.equal(suppliedUserInput.type, 'user');
            assert.equal(suppliedUserInput.message.role, 'user');
            assert.equal(suppliedUserInput.message.content, prompt);
            const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
            const init = template(row => row.type === 'system' && row.subtype === 'init');
            Object.assign(init, { session_id: session, model, cwd: value.root });
            const assistant = template(row => row.type === 'assistant');
            assistant.session_id = session;
            assistant.message.model = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
            assistant.message.content[0].input = original;
            const final = template(row => row.type === 'result');
            Object.assign(final, { session_id: session, is_error: false, structured_output: original, result: JSON.stringify(original) });
            const nativeFile = path.join(value.root, 'aggregate-native/project', session + '.jsonl');
            fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
            fs.writeFileSync(nativeFile, serialize([{ ...suppliedUserInput, sessionId: session },
              { ...structuredClone(assistant), sessionId: session, effort }]));
            const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
            const hookArgs = settings.hooks.SessionStart[0].hooks[0].args;
            const hookValue = name => hookArgs[hookArgs.indexOf(name) + 1];
            capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: session,
              transcript_path: nativeFile, cwd: value.root }, {
              evidenceFile: hookValue('--evidence-file'), expectedSession: hookValue('--expected-session') });
            child.stdout.emit('data', Buffer.from(serialize([init, assistant, final])));
            child.emit('close', 0, null);
          } catch (error) { child.emit('error', error); }
        });
      } };
      return child;
    },
  });
  const adapter = createClaudeDispatchAdapter({ capabilities: runtime.capabilities, host: {
    async launch(selection) {
      const completed = await runtime.agent(prompt, selection);
      assert.deepEqual(completed.output, original);
      return runtime.applicationEvidence({ result: completed });
    },
  } });
  const dispatch = await createDispatchBoundary({ adapters: { claude: adapter }, recorder: value.recorder })
    .dispatch({ runtime: 'claude', role: 'arch-review', signals: {} }, { ticket: subject, subject_kind: 'phase', phase: 47 });
  const receipt = dispatch.receipt;
  assert.equal(receipt.compliance, 'verified');
  assert.equal(receipt.session_id, session);
  assert.deepEqual(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt, receipt);
  const stream = fs.readFileSync(receipt.transcript.path);
  const nativePath = path.join(path.dirname(receipt.transcript.path), 'projects', receipt.selection_evidence.transcript.path);
  const native = fs.readFileSync(nativePath);
  for (const [bytes, pin] of [[stream, receipt.transcript], [native, receipt.selection_evidence.transcript]]) {
    assert.equal(bytes.length, pin.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.sha256);
    assert.ok(bytes.toString('utf8').endsWith('\n'));
  }
  assert.notEqual(receipt.transcript.sha256, receipt.selection_evidence.transcript.sha256);
  const users = native.toString('utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.type === 'user' && row.sessionId === session);
  assert.equal(users.length, 1);
  assert.deepEqual(users[0].message, suppliedUserInput.message);
  return { aggregate: { ...aggregate, dispatch }, result, nativePath };
}

for (const conflict of [null, 'ticket', 'receipt.ticket', 'runtime_evidence.ticket'])
test('phase-local archive scope: batch catalogue aggregate identities ' + (conflict || 'discover current verdict'), async () => {
  const value = phaseScopeFixture();
  try {
    const graphPath = path.join(value.input.graphDir, 'tickets.json');
    const graph = JSON.parse(fs.readFileSync(graphPath));
    graph.tickets['T-47-02'] = { ...graph.tickets[value.ticket], repo: 'acme/foreign' };
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const originalSubject = target.PHASE_SUBJECT.exec(value.input.binding.subject);
    const bindingInput = { graph, state: {}, phase: 47, repository: originalSubject[2],
      branch: 'epic/47-scope', pr: 404, head: originalSubject[5], base: originalSubject[6] };
    assert.deepEqual(target.phaseBinding(bindingInput), value.input.binding);
    const foreignBinding = target.phaseBinding({ ...bindingInput, repo: 'acme/foreign' });
    assert.deepEqual(foreignBinding.ticketSet.map(member => member.id), ['T-47-02']);
    assert.notEqual(foreignBinding.subject, value.input.binding.subject);
    const selected = value.select();
    assert.deepEqual(selected.selection.records, value.roster.records);
    const subject = value.input.binding.subject;
    const { aggregate, result, nativePath } = await aggregateNativeDispatch(value, selected);
    const { dispatch } = aggregate;
    sealArchReview(aggregate, result);
    mutateFixtureCatalogue(value, payload => {
      const record = payload.records[dispatch.receipt.dispatch_id];
      delete record.ticket;
      record.receipt.ticket = subject;
      record.receipt.runtime_evidence = { ...record.receipt.runtime_evidence, ticket: subject };
      if (conflict === 'ticket') record.ticket = 'T-47-conflict';
      if (conflict === 'receipt.ticket') record.receipt.ticket = 'T-47-conflict';
      if (conflict === 'runtime_evidence.ticket') record.receipt.runtime_evidence.ticket = 'T-47-conflict';
    });
    const parsed = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').PHASE_SUBJECT.exec(subject);
    const lookup = extra => roleArtifact.currentArchitectureVerdict({ worktreePath: value.root,
      graphDir: value.input.graphDir, pr: 404, head: parsed[5], baseCommit: parsed[6],
      baseName: 'main', headBranch: 'epic/47-scope', ...extra });
    if (conflict) {
      for (const check of [value.select, lookup]) assert.throws(check,
        { code: 'ARCHIVE_AUTHORITY_INVALID', message: /original receipt identity differs/ });
    } else {
      assert.equal(value.select().candidates[0].dispatch_id, dispatch.receipt.dispatch_id);
      assert.equal(lookup().dispatch_id, dispatch.receipt.dispatch_id);
      assert.equal(lookup({ pr: 405 }), null);
      assert.equal(lookup({ head: parsed[6] }), null);
      assert.equal(lookup({ baseName: 'develop' }), null);
      assert.equal(lookup({ baseCommit: parsed[5] }), null);
      assert.equal(lookup({ repo: 'acme/foreign' }), null);
      const originalReceipt = JSON.stringify(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt);
      for (const file of [dispatch.receipt.transcript.path, nativePath]) {
        const bytes = fs.readFileSync(file);
        const mode = fs.statSync(file).mode & 0o777;
        for (const malformed of [null, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('altered\n')])]) {
          try {
            if (malformed === null) fs.unlinkSync(file);
            else fs.writeFileSync(file, malformed);
            assert.equal(lookup(), null, 'missing, truncated or altered original evidence must refuse current admission');
          } finally { fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); }
          assert.equal(lookup().dispatch_id, dispatch.receipt.dispatch_id);
          assert.equal(JSON.stringify(value.recorder.getVerifiedRecord(dispatch.dispatch_id).receipt), originalReceipt);
        }
      }
    }
  } finally { cleanPhaseScope(value); }
});

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
  const value = phaseScopeFixture({ mixed: true });
  const graphPath = path.join(value.input.graphDir, 'tickets.json');
  const graph = JSON.parse(fs.readFileSync(graphPath));
  graph.tickets.foreign.epic = 'epic/47-scope';
  fs.writeFileSync(graphPath, JSON.stringify(graph));
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

test('completed reference authentication rejects caller authority with no filesystem mutation', () => {
  const authority = require('../../plugins/delivery-pipeline/scripts/role-artifact.cjs');
  for (const selectors of [null, {}, { worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing',
    evidence: {} }, { worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing',
    completed: true }, ...['gsd_role', 'gsd_launch_mechanism', 'native_child_evidence', 'task_relay'].map(key => ({
      worktree: '/missing', progress: {}, receipt_store: '/missing', dispatch_id: 'missing', [key]: {} }))]) {
    assert.throws(() => authority.authenticateCompletedReviewReferences(selectors),
      error => error.code === 'REVIEW_PROGRESS_REQUIRED');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completed-reference-refusal-'));
  try {
    git(root, ['init', '--quiet']);
    const store = path.join(root, 'absent-original-store');
    const source = `
      const fs = require('node:fs');
      const authority = require(process.env.REFERENCE_MODULE);
      const selectors = JSON.parse(process.env.REFERENCE_SELECTORS);
      for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'appendFileSync', 'fsyncSync'])
        fs[name] = () => { throw new Error('unexpected authority mutation: ' + name); };
      const original = fs.openSync;
      fs.openSync = (file, flags, ...args) => {
        if (typeof flags === 'string' ? flags !== 'r' : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT))
          throw new Error('unexpected authority write-open');
        return original(file, flags, ...args);
      };
      try { authority.authenticateCompletedReviewReferences(selectors); process.exit(2); }
      catch (error) {
        if (error.message.includes('unexpected authority')) throw error;
        process.stdout.write('REFUSED_WITHOUT_WRITES');
      }
    `;
    const output = execFileSync(process.execPath, [...testAuthorityArgs, '-e', source], { encoding: 'utf8',
      env: { ...process.env, REFERENCE_MODULE: require.resolve('../../plugins/delivery-pipeline/scripts/role-artifact.cjs'),
        REFERENCE_SELECTORS: JSON.stringify({ worktree: root, receipt_store: store, dispatch_id: 'missing-original',
          progress: { reference: 'review-progress-' + '0'.repeat(64) + '.json', sha256: '0'.repeat(64) } }) } });
    assert.equal(output, 'REFUSED_WITHOUT_WRITES');
    assert.equal(fs.existsSync(store), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});



test('focused completeness and subject declarations fail closed without consumption inference', () => {
  const context = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const binding = { review_contract: context.FOCUSED_CONTRACT, repository: '/repo/.git', id: 'T-49-20',
    pr: 473, head: 'a'.repeat(40), base_commit: 'b'.repeat(40), merge_base: 'c'.repeat(40),
    base_tree: 'd'.repeat(40), ticket_set_digest: 'e'.repeat(64), context_digest: 'f'.repeat(64) };
  const result = { ...binding, launch_digest: '1'.repeat(64), review_completeness: 'complete', limitations: [], unresolved_sources: [] };
  assert.equal(context.validateFocusedResult(result, binding), true);
  for (const edit of [{ review_contract: 'forged' }, { review_completeness: 'maybe' },
    { unresolved_sources: ['src/missing.cjs'] }, { limitations: ['unresolved boundary'] },
    { limitations: ['x'.repeat(1025)] }, { base_commit: '9'.repeat(40) }])
    assert.throws(() => context.validateFocusedResult({ ...result, ...edit }, binding));
  assert.equal(context.validateFocusedResult({ ...result, review_completeness: 'incomplete',
    unresolved_sources: ['src/missing.cjs'] }, binding), true);
});


for (const corrupt of [false, true]) test('current integration excludes foreign catalogue before authority reads: ' + corrupt, () => {
  const value = phaseScopeFixture({ second: true });
  const read = fs.readFileSync;
  try {
    const foreign = path.join(roleArtifact.archiveAuthorityDirectory(fs.realpathSync(value.second)), 'catalogue.json');
    if (corrupt) fs.writeFileSync(foreign, 'corrupt foreign catalogue'.repeat(800000));
    let opened = 0;
    fs.readFileSync = function(file, ...args) {
      if (String(file) === foreign) { opened++; throw new Error('foreign catalogue must not be opened'); }
      return read.call(this, file, ...args);
    };
    const head = git(value.root, ['rev-parse', 'HEAD']);
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: value.root, head,
      baseName: 'main', baseCommit: git(value.root, ['rev-parse', 'main']),
      graphDir: value.input.graphDir, headBranch: 'epic/47-scope' }), null);
    assert.equal(opened, 0);
  } finally { fs.readFileSync = read; cleanPhaseScope(value); }
});

for (const runtime of ['codex', 'claude']) test('aggregate original subject reconciles retained and legacy ' + runtime, () => {
  const value = judgmentFixture();
  try {
    const subject = 'phase=47-scope;repository=/fixture;tickets=' + 'a'.repeat(64);
    const launch = resolution => ({ ...judgmentReceipt(resolution),
      ...(resolution.agent_file ? { agent_file: resolution.agent_file,
        agent_file_digest: resolution.agent_file_digest } : {}) });
    const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
    const selected = policy.resolveDispatch({ runtime, role: 'integrator', signals: {} });
    const agentsDir = path.join(value.root, 'agents');
    if (runtime === 'codex') {
      fs.mkdirSync(agentsDir);
      const content = [
        '# shipyard-policy-id = "' + policy.POLICY.id + '"',
        '# shipyard-policy-version = "' + selected.policy_version + '"',
        '# shipyard-policy-hash = "' + selected.policy_hash + '"',
        '# shipyard-policy-runtime = "codex"',
        '# shipyard-policy-role = "' + selected.role + '"',
        '# shipyard-policy-rung = "' + selected.rung + '"',
        'name = "' + selected.agent_file.replace(/\.toml$/, '') + '"',
        'model = "' + selected.model + '"',
        'model_reasoning_effort = "' + selected.effort + '"',
        "developer_instructions = '''\nAuthenticate the original integration subject.\n'''", '',
      ].join('\n');
      fs.writeFileSync(path.join(agentsDir, selected.agent_file), content);
      fs.writeFileSync(path.join(agentsDir, '.shipyard-manifest.json'), JSON.stringify({
        policy_id: policy.POLICY.id, policy_version: selected.policy_version, policy_hash: selected.policy_hash,
        agent_files: [selected.agent_file], agent_digests: {
          [selected.agent_file]: require('node:crypto').createHash('sha256').update(content).digest('hex'),
        },
      }));
    }
    const boundary = createDispatchBoundary({ adapters: { [runtime]: {
      ...(runtime === 'codex' ? { agentsDir } : {}), launch, launchStatic: launch,
    } }, recorder: value.recorder });
    const dispatch = boundary.dispatch({ runtime, role: 'integrator', signals: {} }, { ticket: subject });
    if (runtime === 'codex') {
      assert.equal(dispatch.receipt.agent_file, selected.agent_file);
      assert.equal(dispatch.receipt.agent_file_digest,
      require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(agentsDir, selected.agent_file))).digest('hex'));
    }
    const Module = require('node:module');
    const isolated = new Module(ROLE_ARTIFACT, module);
    isolated.filename = ROLE_ARTIFACT;
    isolated.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
    isolated._compile(fs.readFileSync(ROLE_ARTIFACT, 'utf8')
      + '\nmodule.exports = { authenticatedRecordSubject };', ROLE_ARTIFACT);
    const record = { dispatch_id: dispatch.receipt.dispatch_id, receipt: dispatch.receipt,
      review_current: { receipt_store: value.recorder.storeDir } };
    const read = isolated.exports.authenticatedRecordSubject;
    assert.equal(read(record), subject);
    assert.equal(read({ ...record, review_current: undefined, receipt_store: value.recorder.storeDir }), subject);
    assert.equal(read({ ...record, ticket: subject }), subject);
    assert.throws(() => read({ ...record, ticket: subject + '-foreign' }));
    assert.throws(() => read({ ...record, receipt: { ...record.receipt, ticket: 'foreign' } }));
    assert.throws(() => read({ ...record, review_current: {} }));
    assert.throws(() => read({ ...record, dispatch_id: 'missing-original' }));
  } finally { clean(value); }
});

function roleArtifactInternals(names) {
  const Module = require('node:module');
  const isolated = new Module(ROLE_ARTIFACT, module);
  isolated.filename = ROLE_ARTIFACT;
  isolated.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
  isolated._compile(fs.readFileSync(ROLE_ARTIFACT, 'utf8') + `\nmodule.exports = { ${names.join(', ')} };`, ROLE_ARTIFACT);
  return isolated.exports;
}

test('integrator subject round-trips through the producer and every consumer for every repository form', () => {
  const { judgmentSubject, phaseSubjectFields } = roleArtifactInternals(['judgmentSubject', 'phaseSubjectFields']);
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const { recordInflight, clearInflight } = require('../../plugins/delivery-pipeline/scripts/dispatch-record.cjs');
  const scratchRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'integrator-subject-')));
  const digestValue = 'c'.repeat(64);
  try {
    const project = path.join(scratchRoot, 'project');
    fs.mkdirSync(path.join(project, '.planning', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(project, '.planning', 'graph', 'tickets.json'), JSON.stringify({ tickets: {} }));
    const graphDir = path.join(project, '.planning', 'graph');
    let count = 0;
    for (const name of ['plain', 'with space', 'репо']) {
      const worktree = path.join(scratchRoot, name);
      fs.mkdirSync(worktree);
      execFileSync('git', ['init', '-q', worktree]);
      const expected = target.repositoryIdentity(worktree);
      const identity = { worktree, repository: { root: worktree, identity: '/decoy/not-the-git-common-dir' } };
      const subject = judgmentSubject('integrator', {}, identity, { phase: '47-scope' }, { digest: digestValue });
      assert.equal(subject, `phase=47-scope;repository=${expected};tickets=${digestValue}`, name);
      for (const parsed of [phaseSubjectFields(subject), target.parseSubject('integrator', subject)]) {
        assert.equal(parsed.phase, '47-scope');
        assert.equal(parsed.repository, expected);
        assert.equal(parsed.tickets, digestValue);
      }
      for (const role of ['integrator', 'pr-sentinel']) {
        const input = { graphDir, ticket: subject, role, dispatch_id: 'round-trip-' + count++, pid: process.pid, host: 'codex' };
        recordInflight(input);
        assert.equal(clearInflight(input), true);
      }
    }
    const semicolon = path.join(scratchRoot, 'semi;colon');
    fs.mkdirSync(semicolon);
    execFileSync('git', ['init', '-q', semicolon]);
    assert.throws(() => judgmentSubject('integrator', {}, { worktree: semicolon, repository: { identity: '/ok/.git' } },
      { phase: '47-scope' }, { digest: digestValue }), { code: 'REPOSITORY_IDENTITY_INVALID' });
    const plain = path.join(scratchRoot, 'plain');
    assert.throws(() => judgmentSubject('integrator', {}, { worktree: plain, repository: { identity: '/ok/.git' } },
      { phase: 'no-number' }, { digest: digestValue }), { code: 'INVALID_RESULT' });
    assert.throws(() => judgmentSubject('integrator', {}, { worktree: plain, repository: { identity: '/ok/.git' } },
      { phase: '47 scope' }, { digest: digestValue }), { code: 'INVALID_RESULT' });
  } finally { fs.rmSync(scratchRoot, { recursive: true, force: true }); }
});

test('phase subject consumers accept the shared repository class and refuse a semicolon or control character', () => {
  const { phaseSubjectFields } = roleArtifactInternals(['phaseSubjectFields']);
  const digestValue = 'd'.repeat(64), head = 'a'.repeat(40), base = 'b'.repeat(40);
  for (const repository of ['/work/my repo/.git', '/work/дім/.git', 'owner/repo', '/plain/.git']) {
    const integrator = `phase=47-scope;repository=${repository};tickets=${digestValue}`;
    const aggregate = `${integrator};pr=3;head=${head};base=${base}`;
    for (const subject of [integrator, aggregate]) {
      const parsed = phaseSubjectFields(subject);
      assert.ok(parsed, subject);
      assert.equal(parsed.repository, repository);
      assert.equal(parsed.phase, '47-scope');
      assert.equal(parsed.tickets, digestValue);
    }
  }
  for (const repository of ['/a;b/.git', '/a\tb/.git', '/a\nb/.git', '']) {
    const integrator = `phase=47-scope;repository=${repository};tickets=${digestValue}`;
    assert.equal(phaseSubjectFields(integrator), null, JSON.stringify(repository));
    assert.equal(phaseSubjectFields(`${integrator};pr=3;head=${head};base=${base}`), null, JSON.stringify(repository));
  }
  assert.equal(phaseSubjectFields(`phase=47-scope;repository=/r/.git;tickets=${digestValue};extra=1`), null);
  assert.equal(phaseSubjectFields(undefined), null);
});

test('role-artifact holds no private subject grammar or home expression', () => {
  const source = fs.readFileSync(ROLE_ARTIFACT, 'utf8');
  assert.ok(!/\/\^phase=/.test(source), 'no subject regular expression is written out in role-artifact');
  assert.ok(!/process\.env\.CODEX_HOME/.test(source), 'the Codex home has one resolver');
  assert.ok(!/process\.env\.CLAUDE_CONFIG_DIR/.test(source), 'the Claude home has one resolver');
  assert.ok(!/'\.codex'/.test(source) && !/'\.claude'/.test(source), 'no private home fallback');
  assert.equal((source.match(/phaseSubjectFields\(/g) || []).length, 5, 'definition plus the architecture and code-review phase-record sites');
  assert.equal((source.match(/parseSubject\('integrator'/g) || []).length >= 3, true);
  assert.equal((source.match(/resolveCodexHome\(/g) || []).length, 3);
  assert.equal((source.match(/resolveCodexHome\(\{ scriptDir: __dirname, env: process\.env \}\)/g) || []).length, 3,
    'all three Codex session sites follow the executing bundle like every converted site');
  assert.equal((source.match(/resolveClaudeHome\(/g) || []).length, 1);
  assert.ok(!/^(?:const|let|var) [^\n]*require\(['"]\.\/runtime-context\.cjs['"]\)/m.test(source),
    'runtime-context is required lazily at each site');
});

test('the Claude semantic transcript falls back through the shared Claude home', () => {
  const { currentClaudeSemanticPin } = roleArtifactInternals(['currentClaudeSemanticPin']);
  const trusted = { receipt: { runtime: 'claude', session_id: 'session-1',
    selection_evidence: { transcript: { path: 'project-a/session-1.jsonl' } },
    transcript: { path: path.join(os.tmpdir(), 'absent-claude-store', 'transcript.jsonl') } } };
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME };
  const restore = (key, value) => value === undefined ? delete process.env[key] : (process.env[key] = value);
  try {
    process.env.HOME = '/home/isolated';
    process.env.CLAUDE_CONFIG_DIR = '/configured/claude';
    assert.equal(currentClaudeSemanticPin(trusted).path, '/configured/claude/projects/project-a/session-1.jsonl');
    process.env.CLAUDE_CONFIG_DIR = '~/relative-claude';
    assert.equal(currentClaudeSemanticPin(trusted).path, '/home/isolated/relative-claude/projects/project-a/session-1.jsonl');
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(currentClaudeSemanticPin(trusted).path, '/home/isolated/.claude/projects/project-a/session-1.jsonl');
    process.env.CLAUDE_CONFIG_DIR = '   ';
    assert.equal(currentClaudeSemanticPin(trusted).path, '/home/isolated/.claude/projects/project-a/session-1.jsonl',
      'a blank CLAUDE_CONFIG_DIR is unset, as the resolver reads it');
  } finally { restore('CLAUDE_CONFIG_DIR', saved.config); restore('HOME', saved.home); }
});

function retainPlanningInput(f, input, planningRoot = f.root, repo = null) {
  return require('../fixtures/code-review/artifact-fixture.cjs').retainPlanningInput(f, input, planningRoot, repo);
}

function withOriginalPlanning(f) {
  const input = f.input;
  f.input = (...args) => retainPlanningInput(f, input(...args));
  return f;
}

function reverseReviewKeys(value) {
  if (Array.isArray(value)) return value.map(reverseReviewKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, item]) => [key, reverseReviewKeys(item)]));
  return value;
}

for (const incomplete of [false, true]) test('legacy reordered code-review membership reads publicly: incomplete=' + incomplete, () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    f.graph.tickets['T-52-01'].files = ['source.js', 'round.txt'];
    const binding = f.advance(1);
    const input = f.input(binding, 1, null, incomplete ? {
      ...JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/code-review/review.json'))),
      review_completeness: 'incomplete', limitations: ['Unread source remains'] } : undefined);
    input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
    assert.deepEqual(input.result.ticket_set, binding.ticketSet);
    assert.notEqual(JSON.stringify(input.result.ticket_set), JSON.stringify(binding.ticketSet));
    if (incomplete) {
      input.result.review_completeness = 'incomplete';
      input.result.verdict = 'incomplete';
      input.result.limitations = ['Unread source remains'];
    }
    const sealed = roleArtifact.sealJudgment(input);
    const original = fs.readFileSync(sealed.artifact_ref);
    const retainedFiles = [sealed.artifact_ref,
      ...roleArtifact.authenticatedArchivePins(f.root).map(pin => path.join(f.root, pin.path)),
      path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json'),
      ...fs.readdirSync(f.recorder.storeDir).filter(name => name.startsWith('record-'))
        .map(name => path.join(f.recorder.storeDir, name))];
    const retainedBytes = retainedFiles.map(file => fs.readFileSync(file));
    const history = () => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
      repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir });
    const prior = history();
    assert.equal(prior.length, 1);
    assert.equal(prior[0].blocking_count, 1);
    assert.equal(prior[0].review_completeness, incomplete ? 'incomplete' : 'complete');
    assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    if (incomplete) {
      assert.equal(core.countableVerdicts({ priorVerdicts: prior, head: prior[0].head, isAncestor: () => false }).length, 0);
      const next = core.nextRound({ priorVerdicts: prior, head: input.result.head });
      assert.equal(next.rounds_used, 0);
      assert.equal(next.round, 1);
      assert.equal(next.scope, 'full');
      assert.equal(f.lookup().verdict, 'incomplete');
    }
    for (const [index, file] of retainedFiles.entries()) assert.deepEqual(fs.readFileSync(file), retainedBytes[index]);
    const manifest = JSON.parse(original);
    const findingsPath = path.join(f.root, manifest.files.findings.path);
    const findings = JSON.parse(fs.readFileSync(findingsPath));
    findings.ticket_set[0].row.files.reverse();
    fs.writeFileSync(findingsPath, JSON.stringify(findings));
    assert.throws(history);
    assert.equal(f.lookup(), null);
  } finally { f.cleanup(); }
});

for (const digestForm of ['omitted', 'alias'])
  test('legacy reordered membership preserves supported result digest form: ' + digestForm, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      const binding = f.advance(1), input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      delete input.result.ticket_set_digest;
      if (digestForm === 'alias') input.result.ticketSetDigest = '0'.repeat(64);
      else input.ticketSetDigest = '0'.repeat(64);
      assert.throws(() => roleArtifact.sealJudgment(input), { code: 'JUDGMENT_DIGEST_MISMATCH' });
      input.ticketSetDigest = binding.membership;
      if (digestForm === 'alias') input.result.ticketSetDigest = binding.membership;
      const sealed = roleArtifact.sealJudgment(input);
      const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir });
      assert.equal(prior.length, 1);
      assert.equal(prior[0].artifact_digest, sealed.artifact_digest);
      assert.equal(f.lookup().artifact_digest, sealed.artifact_digest);
    } finally { f.cleanup(); }
  });

for (const mutation of ['manifest', 'file-index', 'mac', 'receipt', 'digest', 'subject', 'nested-evidence'])
  test('public legacy code-review consumers reject authentic archive tampering: ' + mutation, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      const binding = f.advance(1), input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      const sealed = roleArtifact.sealJudgment(input);
      const manifest = JSON.parse(fs.readFileSync(sealed.artifact_ref));
      if (mutation === 'manifest') {
        manifest.head = f.base;
        fs.writeFileSync(sealed.artifact_ref, JSON.stringify(manifest));
      } else if (['file-index', 'mac'].includes(mutation)) {
        const file = path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json');
        const envelope = JSON.parse(fs.readFileSync(file));
        if (mutation === 'mac') envelope.mac = '0'.repeat(64);
        else envelope.payload.records[input.dispatchId].pins[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(file, JSON.stringify(envelope));
      } else if (mutation === 'receipt') {
        const file = 'record-' + require('node:crypto').createHash('sha256')
          .update(manifest.producer_dispatch).digest('hex') + '.json';
        assert.ok(fs.existsSync(path.join(f.recorder.storeDir, file)));
        fs.appendFileSync(path.join(f.recorder.storeDir, file), 'x');
      } else {
        const file = path.join(f.root, manifest.files.findings.path);
        const result = JSON.parse(fs.readFileSync(file));
        if (mutation === 'digest') result.ticket_set_digest = '0'.repeat(64);
        if (mutation === 'subject') result.id = binding.subject.replace('pr=52;', 'pr=53;');
        if (mutation === 'nested-evidence') result.ticket_set[0].evidence.status = 'pending';
        fs.writeFileSync(file, JSON.stringify(result));
      }
      assert.throws(() => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir }));
      assert.equal(f.lookup(), null);
    } finally { f.cleanup(); }
  });

for (const mutation of ['added', 'deleted', 'member-order', 'row', 'evidence', 'array-order', 'digest', 'subject'])
  test('fresh code-review sealing rejects changed membership: ' + mutation, () => {
    const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
    const f = withOriginalPlanning(reviewFixture());
    try {
      f.graph.tickets['T-52-01'].files = ['source.js', 'round.txt'];
      const binding = f.advance(2);
      const input = f.input(binding);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      if (mutation === 'added') input.result.ticket_set.push({ id: 'T-52-99', row: {}, evidence: {} });
      if (mutation === 'deleted') input.result.ticket_set.pop();
      if (mutation === 'member-order') input.result.ticket_set.reverse();
      if (mutation === 'row') input.result.ticket_set[0].row.epic = 'epic/forged';
      if (mutation === 'evidence') input.result.ticket_set[0].evidence.status = 'pending';
      if (mutation === 'array-order') input.result.ticket_set[0].row.files.reverse();
      if (mutation === 'digest') input.result.ticket_set_digest = input.ticketSetDigest = '0'.repeat(64);
      if (mutation === 'subject') input.result.id = binding.subject.replace('pr=52;', 'pr=53;');
      assert.throws(() => roleArtifact.sealJudgment(input));
    } finally { f.cleanup(); }
  });

test('code-review lineage survives real fix-ticket membership changes and keeps reuse exact', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const digests = [], snapshots = [], verdicts = [];
    for (let round=1; round<=3; round++) {
      const binding = f.advance(round); digests.push(binding.membership);
      snapshots.push(structuredClone({graph:f.graph,state:f.state}));
      const input = f.input(binding,round,verdicts.at(-1)?.head || null);
      input.result.ticket_set = reverseReviewKeys(binding.ticketSet);
      const sealed = roleArtifact.sealJudgment(input);
      const validated = roleArtifact.validateJudgmentManifest({...input,artifactPath:sealed.artifact_ref,artifactDigest:sealed.artifact_digest});
      assert.equal(validated.manifest.repository_identity,target.repositoryIdentity(f.root));
      const prior = roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:f.phase,graphDir:f.graphDir});
      assert.equal(prior.length,round); assert.deepEqual(prior.map(v=>v.review_round),Array.from({length:round},(_,i)=>i+1));
      verdicts.push(prior.at(-1));
      const next = core.nextRound({priorVerdicts:prior,head:input.result.head,isAncestor:(a,b)=>{try{f.git(['merge-base','--is-ancestor',a,b]);return true;}catch{return false;}}});
      assert.equal(next.rounds_used,round); assert.equal(next.round,round===3?null:round+1);
      assert.equal(next.state,round===3?'limit':'ready');
      if(round<3) assert.equal(next.scope,'delta');
      assert.equal(f.lookup().artifact_digest,sealed.artifact_digest);
    }
    const latestBinding=require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').phaseBinding({graph:f.graph,state:f.state,phase:52,repository:target.repositoryIdentity(f.root),pr:52,head:f.git(['rev-parse','HEAD']),base:f.base,branch:f.branch});
    const otherPhase={...latestBinding,subject:latestBinding.subject.replace('phase=52-review;','phase=53-other;')};
    roleArtifact.sealJudgment(f.input(otherPhase));
    const arch=f.dispatch('arch-review',latestBinding.subject);
    const archEvidence=path.join(f.root,'.shipyard-arch-review-evidence.md');fs.writeFileSync(archEvidence,'Complete architecture evidence');
    roleArtifact.sealJudgment({worktreePath:f.root,base:'main',role:'arch-review',ticket:latestBinding.subject,pr:52,ticketSet:latestBinding.ticketSet,ticketSetDigest:latestBinding.membership,recorder:f.recorder,dispatchId:arch.receipt.dispatch_id,evidencePath:archEvidence,result:{id:latestBinding.subject,pr:52,head:f.git(['rev-parse','HEAD']),base_tree:f.git(['rev-parse',f.base+'^{tree}']),ticket_set:latestBinding.ticketSet,ticket_set_digest:latestBinding.membership,verdict:'conform',blocking_count:0,findings:[]}});
    const integrationSubject=target.buildSubject('integrator',{phase:f.phase,repository:target.repositoryIdentity(f.root),tickets:latestBinding.membership});
    const integration=f.dispatch('integrator',integrationSubject);
    const integrationEvidence=path.join(f.root,'.planning/phases',f.phase,'INTEGRATION.md');fs.mkdirSync(path.dirname(integrationEvidence),{recursive:true});fs.writeFileSync(integrationEvidence,'Complete integration evidence');
    roleArtifact.sealJudgment({worktreePath:f.root,base:'main',role:'integrator',ticket:integrationSubject,phase:f.phase,ticketSet:latestBinding.ticketSet,ticketSetDigest:latestBinding.membership,recorder:f.recorder,dispatchId:integration.receipt.dispatch_id,evidencePath:integrationEvidence,result:{phase:f.phase,head:f.git(['rev-parse','HEAD']),base:'main',base_tree:f.git(['rev-parse',f.base+'^{tree}']),ticket_set:latestBinding.ticketSet,ticket_set_digest:latestBinding.membership,outcome:'passed',blocking_count:0,findings:[]}});
    assert.equal(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:f.phase}).length,3);
    assert.equal(new Set(digests).size,3);
    assert.equal(core.lineageComplete({verdict:verdicts[2],priorVerdicts:verdicts}),true);
    assert.deepEqual(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:target.repositoryIdentity(f.root),phaseDir:'54-absent'}),[]);
    assert.deepEqual(roleArtifact.priorCodeReviewVerdicts({worktreePath:f.root,repository:'/another/repository',phaseDir:f.phase}),[]);
    for(const snapshot of snapshots.slice(0,2)) {
      fs.writeFileSync(path.join(f.graphDir,'tickets.json'),JSON.stringify(snapshot.graph));
      fs.writeFileSync(path.join(f.graphDir,'delivery-state.json'),JSON.stringify({tickets:snapshot.state}));
      assert.equal(f.lookup(),null);
    }
    f.writeGraph();
    f.git(['commit','--allow-empty','--quiet','-m','moved head']); assert.equal(f.lookup(),null);
  } finally { f.cleanup(); }
});

test('sealed disagreements retain their original target through three rounds and twin ordinal shifts', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const source = name => fs.readFileSync(path.join(__dirname, '../fixtures/code-review', name), 'utf8');
  for (const lines of [[2,4,6], [4]]) {
    const f = withOriginalPlanning(reviewFixture());
    try {
      fs.writeFileSync(path.join(f.root, 'source.js'), source('twins.js'));
      f.git(['add', 'source.js']);
      const raw = JSON.parse(source('review.json'));
      const first = f.input(f.advance(1), 1, null, { ...raw, findings: lines.map((line, index) => ({
        ...raw.findings[0], id: 'CR-' + index, line, line_text: 'return null;',
      })) });
      roleArtifact.sealJudgment(first);
      const file = JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [{
        path: 'source.js', line_text: 'return null;', occurrence: 2,
        reason: 'The middle caller handles absence', recorded_by: 'operator',
      }] });
      const readSource = file => fs.readFileSync(path.join(f.root, file), 'utf8');
      let previous = first.result.head;
      for (const round of [2,3]) {
        if (round === 2) {
          fs.writeFileSync(path.join(f.root, 'source.js'), source('twins-added.js'));
          f.git(['add', 'source.js']);
        }
        const binding = f.advance(round);
        const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
          repository: target.repositoryIdentity(f.root), phaseDir: f.phase }).at(-1);
        const deltaDiff = f.git(['diff', '--unified=50', previous, 'HEAD']);
        const preCarry = core.carryPriorFindings({ priorFindings: prior, deltaDiff, readSource });
        const disagreements = core.parseDisagreements(file, { priorFindings: preCarry });
        const priorFindings = core.carryPriorFindings({ priorFindings: prior, deltaDiff, disagreements, readSource });
        assert.deepEqual(priorFindings.filter(finding => finding.disagreement).map(finding => finding.line), [5]);
        const blank = { review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [] };
        const original = { ...blank,
          findings: round === 2 ? [{ ...raw.findings[0], line: 5, line_text: 'return null;' }] : [],
          dispositions: priorFindings.filter(finding => !finding.disagreement).map(finding => ({
            ref: finding.ref, disposition: 'unresolved', justification: 'The other caller still fails',
          })),
        };
        const result = core.normalizeResult(original, { round, scope: 'delta', priorFindings, readSource });
        const input = f.input(binding, round, previous, blank);
        input.result = { ...input.result, ...result };
        require('../fixtures/code-review/artifact-fixture.cjs').setOriginalReview(input, original, priorFindings);
        retainPlanningInput(f, input);
        const sealed = roleArtifact.sealJudgment(input);
        const validated = roleArtifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref, artifactDigest: sealed.artifact_digest });
        const suppressed = validated.findings.findings.filter(finding => finding.suppressed);
        assert.deepEqual(suppressed.map(finding => finding.line), [5]);
        assert.equal(suppressed[0].occurrence, 3);
        assert.equal(suppressed[0].disagreement_identity, first.result.findings.find(finding => finding.line === 4).identity);
        assert.equal(f.lookup().disagreement_suppressed, 1);
        assert.equal(f.lookup().blocking_count, lines.length - 1);
        previous = input.result.head;
      }
    } finally { f.cleanup(); }
  }
});

test('code-review reuse refuses a moved base or reference contract and ticket-form subject', () => {
  const { fixture: reviewFixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');
  const f = withOriginalPlanning(reviewFixture());
  try {
    const binding=f.advance(1), input=f.input(binding);
    const originalReference=fs.readFileSync(path.join(__dirname,'../../plugins/delivery-pipeline/references/code-review.md'));
    const changedReference=require('node:crypto').createHash('sha256').update(originalReference).update('Changed reference').digest('hex');
    input.result.contract_digest=core.contractDigest(changedReference);
    input.result.reuse_key=core.reuseKey({head:input.result.head,baseCommit:f.base,contractDigest:input.result.contract_digest});
    roleArtifact.sealJudgment(input); assert.equal(f.lookup(),null);
    roleArtifact.sealJudgment(f.input(binding)); assert.equal(f.lookup().authenticated,true);
    const head=f.git(['rev-parse','HEAD']);
    f.git(['update-ref','refs/remotes/origin/main',head]); assert.equal(f.lookup(),null);
    f.git(['update-ref','refs/remotes/origin/main',f.base]); assert.equal(f.lookup().authenticated,true);
    const {judgmentSubject}=roleArtifactInternals(['judgmentSubject']);
    assert.throws(()=>judgmentSubject('code-review',{ticket:'T-52-01'},{repository:{identity:'/repo'},head,base_commit:f.base},{},{digest:binding.membership},52));
  } finally {f.cleanup();}
});


test('original native architecture authority reads coordinator-only planning on the reviewed epic', async () => {
  const f = codexJudgmentFixtures.fixture();
  const reviewed = f.root + '-epic';
  try {
    codexJudgmentFixtures.git(f.root, ['switch', 'main']);
    codexJudgmentFixtures.git(f.root, ['worktree', 'add', reviewed, codexJudgmentFixtures.BRANCH]);
    f.reviewRoot = fs.realpathSync(reviewed);
    codexJudgmentFixtures.git(reviewed, ['rm', '-r', '.planning']);
    codexJudgmentFixtures.git(reviewed, ['commit', '-qm', 'coordinator owns planning']);
    f.head = codexJudgmentFixtures.git(reviewed, ['rev-parse', 'HEAD']); f.pr.headRefOid = f.head;
    assert.equal(fs.existsSync(path.join(reviewed, '.planning')), false);
    const { validationInput, value } = await codexJudgmentFixtures.unitJudgment(f);
    assert.equal(value.prepared.packet.planning_reference.root, f.root);
    assert.equal(value.prepared.canonical.worktree, f.reviewRoot);
    assert.equal(roleArtifact.validateJudgmentManifest(validationInput).envelope.verdict, 'conform');
    assert.equal(roleArtifact.read(validationInput).envelope.verdict, 'conform');
    const lookup = { worktreePath: reviewed, pr: f.pr.number, head: f.head, baseName: 'main',
      baseCommit: f.base, headBranch: f.pr.headRefName, graphDir: path.join(f.root, '.planning/graph') };
    assert.equal(roleArtifact.currentArchitectureVerdict(lookup)?.dispatch_id, validationInput.dispatchId);
    fs.appendFileSync(path.join(f.root, '.planning/config.json'), ' ');
    assert.equal(roleArtifact.currentArchitectureVerdict(lookup), null);
  } finally {
    codexJudgmentFixtures.cleanupJudgment(f);
    fs.rmSync(reviewed, { recursive: true, force: true });
  }
});

function foreignCodeReviewArchive() {
  const { fixture } = require('../fixtures/code-review/artifact-fixture.cjs');
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const f = fixture();
  const coordinator = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-review-coordinator-')));
  const git = args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'Review Test']); git(['config', 'user.email', 'review@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  f.advance(1);
  f.graph.tickets['T-52-01'].repo = 'acme/app';
  f.graph.epics = { '52': { branch: f.branch, phaseDir: f.phase, repos: ['acme/app'] } };
  f.writeGraph();
  fs.renameSync(path.join(f.root, '.planning'), path.join(coordinator, '.planning'));
  fs.writeFileSync(path.join(coordinator, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' },
    delivery_pipeline: { code_review: 'hold', repos: { 'acme/app': f.root } } }));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'canonical foreign selection']);
  const graphDir = path.join(coordinator, '.planning/graph');
  const binding = target.phaseBinding({ graph: f.graph, state: f.state, phase: 52, repo: 'acme/app',
    repository: target.repositoryIdentity(f.root), pr: 52, head: f.git(['rev-parse', 'HEAD']), base: f.base, branch: f.branch });
  const input = f.input(binding, 1, null, { review_completeness: 'complete', limitations: [], unresolved_sources: [],
    summary: 'Complete foreign review', findings: [], dispositions: [] });
  const live = { number: 52, state: 'OPEN', isDraft: false, headRefName: f.branch,
    headRefOid: input.result.head, baseRefName: 'main', baseRefOid: f.base };
  return { ...f, coordinator, graphDir, binding, input, live,
    lookup: (extra = {}) => roleArtifact.currentCodeReviewVerdict({ worktreePath: f.root, graphDir, repo: 'acme/app',
      pr: 52, head: live.headRefOid, headBranch: f.branch, baseName: 'main', baseCommit: f.base, ...extra }),
    cleanup() { f.cleanup(); fs.rmSync(coordinator, { recursive: true, force: true }); } };
}

test('existing-format sealed foreign pass remains historical without original planning custody', () => {
  const f = foreignCodeReviewArchive();
  const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
  const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
  try {
    assert.notEqual(target.repositoryIdentity(f.root), target.repositoryIdentity(f.coordinator));
    assert.equal(f.input.result.host_context, undefined);
    assert.throws(() => roleArtifact.sealJudgment(f.input),
      error => error.code === 'JUDGMENT_OUTCOME_MISMATCH');
    const preCoverageRepairProducer = {
      baseline: 'ef8f03864fedd506a9dd2216e29cec97996cbaa7',
      path: 'plugins/delivery-pipeline/scripts/role-artifact.cjs',
      sha256: 'd0f5bbba03b66e3c3142c040e37fec87ece7457197ac7013db027c52fdff6428',
      gzip: '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',
    };
    const producerBytes = require('node:zlib').gunzipSync(Buffer.from(preCoverageRepairProducer.gzip, 'base64'));
    assert.equal(require('node:crypto').createHash('sha256').update(producerBytes).digest('hex'),
      preCoverageRepairProducer.sha256);
    const Module = require('node:module');
    const producer = new Module(ROLE_ARTIFACT, module);
    producer.filename = ROLE_ARTIFACT;
    producer.paths = Module._nodeModulePaths(path.dirname(ROLE_ARTIFACT));
    producer._compile(producerBytes.toString('utf8'), ROLE_ARTIFACT);
    const seal = producer.exports.sealJudgment(f.input);
    const original = fs.readFileSync(seal.artifact_ref);
    const prior = () => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
      repository: target.repositoryIdentity(f.root), phaseDir: f.phase, graphDir: f.graphDir });
    assert.equal(prior()[0].artifact_digest, seal.artifact_digest);
    assert.equal(f.lookup(), null);
    const status = () => flow.status({ worktree: f.root, graphDir: f.graphDir, repo: 'acme/app',
      phase: 52, pr: 52, live: f.live }, { execFileSync(executable, args) {
        assert.equal(executable, 'gh');
        assert.deepEqual(args, ['repo', 'view', 'acme/app', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
        return 'main\n';
      } });
    assert.equal(status().state, 'owed');
    assert.equal(flow.evaluateGate(status()).ok, false);
    assert.throws(() => f.lookup({ repo: null }));
    assert.equal(f.lookup({ repo: 'acme/wrong' }), null);
    f.graph.tickets['T-52-01'].title = 'new graph membership';
    fs.writeFileSync(path.join(f.graphDir, 'tickets.json'), JSON.stringify(f.graph));
    assert.equal(f.lookup(), null);
    assert.equal(flow.evaluateGate(status()).ok, false);
    assert.equal(prior()[0].artifact_digest, seal.artifact_digest);
    assert.deepEqual(fs.readFileSync(seal.artifact_ref), original);
  } finally { f.cleanup(); }
});

for (const changed of ['config mapping', 'epic membership', 'graph symlink', 'source', 'untracked source', 'head', 'base', 'manifest', 'index', 'receipt', 'mac'])
  test('sealed foreign current authority refuses ' + changed, () => {
    const f = foreignCodeReviewArchive();
    try {
      const seal = roleArtifact.sealJudgment(retainPlanningInput(f, f.input, f.coordinator, 'acme/app'));
      assert.equal(f.lookup().verdict, 'pass');
      if (changed === 'config mapping') fs.writeFileSync(path.join(f.coordinator, '.planning/config.json'),
        JSON.stringify({ delivery_pipeline: { repos: { 'acme/app': f.coordinator } } }));
      if (changed === 'epic membership') {
        f.graph.epics['52'].repos = ['acme/other'];
        fs.writeFileSync(path.join(f.graphDir, 'tickets.json'), JSON.stringify(f.graph));
      }
      if (changed === 'graph symlink') {
        fs.renameSync(f.graphDir, f.graphDir + '-moved'); fs.symlinkSync(f.graphDir + '-moved', f.graphDir);
      }
      if (changed === 'source') fs.appendFileSync(path.join(f.root, 'source.js'), '\nchanged source');
      if (changed === 'untracked source') fs.writeFileSync(path.join(f.root, 'unexpected.js'), 'new source');
      if (changed === 'head') f.git(['commit', '--quiet', '--allow-empty', '-m', 'moved head']);
      if (changed === 'base') f.git(['update-ref', 'refs/remotes/origin/main', f.live.headRefOid]);
      if (changed === 'manifest') fs.appendFileSync(seal.artifact_ref, ' ');
      if (changed === 'index') {
        const manifest = JSON.parse(fs.readFileSync(seal.artifact_ref));
        manifest.envelope.findings_index.sha256 = '0'.repeat(64);
        fs.writeFileSync(seal.artifact_ref, JSON.stringify(manifest));
      }
      if (changed === 'receipt') {
        const manifest = JSON.parse(fs.readFileSync(seal.artifact_ref));
        const record = 'record-' + require('node:crypto').createHash('sha256')
          .update(manifest.producer_dispatch).digest('hex') + '.json';
        assert.ok(fs.existsSync(path.join(f.recorder.storeDir, record)));
        const file = path.join(f.recorder.storeDir, record), raw = JSON.parse(fs.readFileSync(file));
        raw.integrity.mac = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(raw));
      }
      if (changed === 'mac') {
        const catalogue = path.join(roleArtifact.archiveAuthorityDirectory(f.root), 'catalogue.json');
        const raw = JSON.parse(fs.readFileSync(catalogue));
        raw.mac = '0'.repeat(64); fs.writeFileSync(catalogue, JSON.stringify(raw));
      }
      let verdict;
      try { verdict = f.lookup(); } catch { verdict = null; }
      assert.equal(verdict, null);
    } finally { f.cleanup(); }
  });


for (const partitioned of [false, true]) for (const changed of ['plan', 'config', 'transcript'])
  test('existing-format foreign native input retains original planning pins: partitions=' + partitioned + ', ' + changed, () => {
    const f = foreignCodeReviewArchive();
    try {
      const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
      const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
      const crypto = require('node:crypto');
      const plan = f.graph.tickets['T-52-01'].plan;
      fs.mkdirSync(path.dirname(path.join(f.coordinator, plan)), { recursive: true });
      fs.writeFileSync(path.join(f.coordinator, plan), '# Complete plan acceptance\n');
      const planning = packets.resolvePlanningReference({ worktree: f.root, graphDir: f.graphDir, repo: 'acme/app' });
      const packet = packets.buildContextPacket({ root: f.coordinator, role: 'code-review', subject: f.binding.subject,
        sourceRevision: f.live.headRefOid, policy: policy.POLICY, policyHash: policy.POLICY_HASH,
        scope: { files_modified: ['source.js'] }, requiredRefs: [plan], roleContext: {
          dispositions_digest: null, planning_reference: planning, ticket_set: f.binding.ticketSet, prior_findings: [],
          plan_acceptance: [], exact_diff: { content: f.git(['diff', '--no-ext-diff', '--no-textconv', '--unified=50',
        f.base, 'HEAD',
        ...require('../../plugins/delivery-pipeline/scripts/development-artifacts.cjs').productPathspec()]) },
          integration_base: { commit: f.base } } });
      const recorder = f.recorder;
      let transcript;
      const boundary = createDispatchBoundary({ recorder, adapters: { claude: { launch(r) {
        const session = 'native-' + r.dispatch_id;
        transcript = path.join(f.coordinator, session + '.jsonl');
        let prompt = '<AUTHENTICATED_CONTEXT_PACKET>\n' + JSON.stringify(packets.encodeUniqueContent(packet))
          + '\n</AUTHENTICATED_CONTEXT_PACKET>';
        if (partitioned) {
          const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
          const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
          const contextDigest = crypto.createHash('sha256').update(JSON.stringify(stable(packet))).digest('hex');
          const input = collector.prepareFileInput({ worktree: f.root, ticket: f.binding.subject, phase: 52 },
            JSON.stringify(packets.encodeUniqueContent(packet)), { role: 'code-review', dispatchId: r.dispatch_id,
              graphDir: f.graphDir, phaseRepo: 'acme/app', storageRoot: path.join(f.coordinator, 'inputs'),
              binding: { review_contract: collector.CODE_REVIEW_CONTRACT, packet_digest: contextDigest,
                focused: { context_digest: contextDigest } } });
          prompt = '<AUTHENTICATED_FOCUSED_INPUT>\n' + JSON.stringify(input.input_bundle)
            + '\n</AUTHENTICATED_FOCUSED_INPUT>';
        }
        const content = JSON.stringify({ type: 'user', sessionId: session, message: { content: prompt } }) + '\n';
        fs.writeFileSync(transcript, content);
        return { receipt_type: 'adr-014.application', runtime: r.runtime, role: r.role, dispatch_id: r.dispatch_id,
          launch_id: session, session_id: session, requested_model: r.requested_model, requested_effort: r.requested_effort,
          applied_model: r.model, applied_effort: r.effort, observed_model: r.model, observed_effort: r.effort,
          policy_hash: r.policy_hash, selection_evidence: { source: 'claude-session-assistant-transcript',
            session_id: session, assistant_records: 1, model: r.model, effort: r.effort,
            transcript: { path: transcript, bytes: Buffer.byteLength(content),
              sha256: crypto.createHash('sha256').update(content).digest('hex') } } };
      } } } });
      const dispatch = boundary.dispatch({ runtime: 'claude', role: 'code-review', signals: {} },
        { ticket: f.binding.subject, subject_kind: 'phase' });
      assert.equal(f.input.result.host_context, undefined);
      const seal = roleArtifact.sealJudgment({ ...f.input, recorder, dispatchId: dispatch.dispatch_id });
      assert.equal(f.lookup().artifact_digest, seal.artifact_digest);
      if (changed === 'plan') fs.appendFileSync(path.join(f.coordinator, plan), 'Changed acceptance\n');
      if (changed === 'config') fs.appendFileSync(path.join(f.coordinator, '.planning/config.json'), ' ');
      if (changed === 'transcript') fs.appendFileSync(transcript, ' ');
      let current;
      try { current = f.lookup(); } catch { current = null; }
      assert.equal(current, null);
      const prior = roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root,
        repository: require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs').repositoryIdentity(f.root),
        phaseDir: f.phase, graphDir: f.graphDir });
      assert.equal(prior[0].artifact_digest, seal.artifact_digest);
    } finally { f.cleanup(); }
  });

test('compact authentic integration proves native authority and scoped codec/rebuild policy separately from large capacity', async () => {
  const Module = require('node:module');
  const file = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return load.call(this, name, ...args);
  };
  try {
    loaded._compile(fs.readFileSync(file, 'utf8')
      + '\nmodule.exports = { fixture, runIntegration, prepareCurrentIntegration, successfulReview };\n', file);
  } finally { Module._load = load; }
  const helper = loaded.exports;
  const packets = require('../../plugins/delivery-pipeline/scripts/context-packet.cjs');
  const decode = packets.decodeUniqueContent;
  const observed = [];
  const observedPackets = { ...packets, decodeUniqueContent: function(value, maximumBytes) {
    const stack = new Error().stack;
    const result = decode.apply(this, arguments);
    if (stack.includes('/role-artifact.cjs:')) observed.push({ maximumBytes, caller: stack.split('\n')[2] });
    return result;
  } };
  Module._load = function(name, ...args) {
    const result = load.call(this, name, ...args);
    return result === packets ? observedPackets : result;
  };
  try {
    await helper.fixture(async f => {
      const completed = await helper.runIntegration(f);
      const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
      const checked = collector.verifyFileInput(completed.input);
      assert.ok(checked.material[0].length < 16 * 1024 * 1024);
      const packet = packets.decodeUniqueContent(JSON.parse(checked.material[0]));
      const source = collector.verifyFileInput(checked.manifest.binding.original_input_bundle, { sealed: true });
      const original = packets.decodeUniqueContent(JSON.parse(source.material[0]));
      assert.deepEqual(packet.required_refs, original.required_refs);
      assert.equal(packet.role_context.review_coverage.digest, completed.coverage.digest);
      const sealed = completed.result.artifact;
      const validation = { worktreePath: f.worktree, role: 'integrator', phase: f.phase,
        ticket: completed.scope.ticket, base: 'origin/main', recorder: completed.recorder,
        ticketSet: completed.input.manifest.binding.preflight.ticket_set,
        ticketSetDigest: completed.input.manifest.binding.preflight.ticket_set_digest,
        dispatchId: completed.request.dispatch_id, artifactPath: sealed.artifact_path,
        artifactDigest: sealed.artifact_digest };
      const validated = roleArtifact.validateJudgmentManifest(validation);
      const read = roleArtifact.read(validation);
      assert.equal(validated.manifest.current_review.lineage_digest, completed.coverage.digest);
      assert.deepEqual(read.manifest.current_review, validated.manifest.current_review);
      assert.equal(read.findings.coverage.lineage_digest, completed.coverage.digest);
      assert.equal(validated.manifest.current_review.original_manifest_sha256,
        checked.manifest.binding.original_input_bundle.manifest_sha256);
      assert.equal(validated.manifest.current_review.current_manifest_sha256, completed.input.input_bundle.manifest_sha256);
      assert.ok(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head,
        baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.pr.headRefName })?.authenticated);
      assert.throws(() => collector.verifyFileInput(JSON.parse(JSON.stringify(completed.input))), /private producer/);
      assert.throws(() => roleArtifact.validateJudgmentManifest({ ...validation,
        artifactDigest: '0'.repeat(64) }), /digest|SHA/i);
      fs.unlinkSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md'));
      const unsupported = helper.prepareCurrentIntegration(f);
      assert.equal(unsupported.coverage.mode, 'full');
      const baseline = await helper.successfulReview(f, 'integrator');
      const fresh = helper.prepareCurrentIntegration(f);
      assert.equal(fresh.coverage.mode, 'incremental', JSON.stringify(fresh.coverage.limitations));
      assert.equal(fresh.coverage.baseline.dispatch_id, baseline.dispatched.dispatch_id);
      assert.equal(fresh.coverage.baseline.packet_digest, baseline.input.manifest.binding.packet_digest);
      assert.equal(fresh.coverage.baseline.head, f.head);
    });
  } finally { Module._load = load; }
  for (const consumer of ['authenticateCurrentCoverage', 'rebuildReviewImpactPacket', 'selectReviewBaseline']) {
    const calls = observed.filter(call => call.caller.includes('at ' + consumer + ' '));
    assert.ok(calls.length > 0, consumer + ' must execute its original bounded decoder');
    assert.ok(calls.some(call => call.maximumBytes === 33554432), consumer + ' must select the approved bound');
  }
  assert.ok(observed.some(call => call.maximumBytes === 16777216), 'legacy authority keeps its default bound');
});


test('code-review carrier freshness authentic canonical lifecycle on both runtimes and transports', async () => {
  if (process.env.SHIPYARD_CARRIER_FRESHNESS_CHILD !== '1') {
    const selection = `(function(h,run,n){h.test=function(name,fn){if(name.startsWith("code-review carrier freshness")){n.count++;return run(name,fn)}};process.on("beforeExit",function(){if(n.count===0)throw Error("No selected tests")});require(${JSON.stringify(__filename)})})(require(${JSON.stringify(path.join(__dirname, 'assert-harness.cjs'))}),require(${JSON.stringify(path.join(__dirname, 'assert-harness.cjs'))}).test,{count:0})`;
    const child = spawnSync(process.execPath, ['-e', selection], {
      env: { ...process.env, SHIPYARD_CARRIER_FRESHNESS_CHILD: '1' }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }

  const Module = require('node:module');
  const savedHome = os.homedir, savedPath = process.env.PATH;
  const markers = new Map(['SHIPYARD_RUNTIME', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']
    .map(key => [key, process.env[key]]));
  const loadFixture = (name, exports) => {
    const file = path.join(__dirname, name);
    const loaded = new Module(file, module);
    loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'node:test') return () => {};
      return load.call(this, name, ...args);
    };
    try { loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = {' + exports + '};\n', file); }
    finally { Module._load = load; }
    return loaded.exports;
  };
  try {
    const codex = loadFixture('codex-code-review-context.test.cjs', 'fixture, review');
    const claude = loadFixture('claude-role-host.test.cjs',
      'coordinatorOnlyPlanning, hostOptions, livePr, phasePreparationRequest, cleanupFixture, PHASE');
    const context = require('../../plugins/delivery-pipeline/scripts/codex-code-review-context.cjs');
    const host = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs');
    const target = require('../../plugins/delivery-pipeline/scripts/architecture-target.cjs');
    const flow = require('../../plugins/delivery-pipeline/scripts/phase-code-review.cjs');
    const originalCarrier = Buffer.from(JSON.stringify({ schema: 'shipyard.code-review-disagreements.v1', entries: [] }) + '\n');
    for (const runtime of ['codex', 'claude']) for (const partitioned of [false, true]) for (const present of [false, true]) {
      const source = ('const captured = "' + 'x'.repeat(1024) + '";\n').repeat(1020);
      const f = runtime === 'codex' ? codex.fixture() : claude.coordinatorOnlyPlanning('code-review',
        partitioned ? { sourceContent: source } : {});
      try {
        if (runtime === 'codex' && partitioned) f.commit(() => fs.appendFileSync(path.join(f.root, 'src/reviewed.txt'), source));
        const phase = runtime === 'codex' ? path.basename(path.dirname(f.row.plan)) : claude.PHASE;
        const configFile = path.join(f.project, '.planning/config.json');
        const config = JSON.parse(fs.readFileSync(configFile));
        config.delivery_pipeline = { ...config.delivery_pipeline, code_review: 'hold' };
        fs.writeFileSync(configFile, JSON.stringify(config));
        const carrier = path.join(f.project, '.planning/phases', phase, 'code-review-disagreements.json');
        if (present) fs.writeFileSync(carrier, originalCarrier);
        const graphFile = path.join(f.graphDir, 'tickets.json');
        const graph = JSON.parse(fs.readFileSync(graphFile));
        graph.epics = { ...graph.epics, [Number(phase.match(/^\d+/)[0])]: {
          branch: Object.values(graph.tickets)[0].epic, phaseDir: phase, repos: [null],
        } };
        fs.writeFileSync(graphFile, JSON.stringify(graph));
        let result, recorder, packet, dispatchId;
        if (runtime === 'codex') {
          const review = codex.review(f);
          result = review.result; recorder = review.recorder; dispatchId = review.dispatch.dispatch_id;
          packet = review.value.prepared.packet;
          assert.equal(!!context.admittedFileInput(review.value), partitioned);
        } else {
          const options = claude.hostOptions(f, { originalStream: true, onLaunch(prompt) {
            assert.equal(prompt.includes('<AUTHENTICATED_FOCUSED_INPUT>'), partitioned);
          } });
          const factory = options.createRuntimeHost;
          options.createRuntimeHost = input => { const runtimeHost = factory(input); recorder = runtimeHost.recorder; return runtimeHost; };
          options.getPullRequest = () => ({ ...claude.livePr(f), baseRefName: 'integration' });
          result = await host.createClaudeRoleHost(options).run(claude.phasePreparationRequest(f));
          dispatchId = result.dispatch.receipt.dispatch_id;
        }
        const pr = runtime === 'codex' ? f.pr : { ...claude.livePr(f), baseRefName: 'integration' };
        const lookup = { worktreePath: f.root, graphDir: f.graphDir, headBranch: pr.headRefName,
          pr: pr.number, head: pr.headRefOid, baseName: pr.baseRefName, baseCommit: pr.baseRefOid };
        const current = () => roleArtifact.currentCodeReviewVerdict(lookup);
        const prior = () => roleArtifact.priorCodeReviewVerdicts({ worktreePath: f.root, graphDir: f.graphDir,
          repository: target.repositoryIdentity(f.root), phaseDir: phase });
        const before = prior();
        const seal = before.at(-1), original = fs.readFileSync(seal.artifact_ref);
        assert.equal(current()?.dispatch_id, dispatchId);
        assert.ok(recorder.getVerifiedRecord(dispatchId));
        const validation = { worktreePath: f.root, role: 'code-review', ticket: result.subject || result.ticket,
          pr: pr.number, phase, base: JSON.parse(original).base, recorder, dispatchId,
          ticketSet: result.result.ticket_set, ticketSetDigest: result.result.ticket_set_digest,
          artifactPath: seal.artifact_ref, artifactDigest: seal.artifact_digest };
        assert.equal(roleArtifact.validateJudgmentManifest(validation).envelope.outcome, 'pass');
        assert.equal(roleArtifact.read(validation).envelope.outcome, 'pass');
        if (packet) assert.equal(packet.role_context.dispositions_digest, present
          ? require('node:crypto').createHash('sha256').update(originalCarrier).digest('hex') : null);
        const restore = () => { fs.rmSync(carrier, { recursive: true, force: true }); if (present) fs.writeFileSync(carrier, originalCarrier); };
        const stale = () => {
          assert.equal(current(), null);
          const status = flow.status({ worktree: f.root, graphDir: f.graphDir, phase: Number(phase.match(/^\d+/)[0]),
            pr: pr.number, live: pr, defaultBranch: runtime === 'codex' ? 'main' : 'integration' });
          assert.equal(status.reuse, false);
          assert.equal(status.rounds_used, 1); assert.equal(status.round_cap, 3);
          assert.equal(flow.evaluateGate(status).ok, false);
          assert.deepEqual(prior(), before);
          assert.deepEqual(fs.readFileSync(seal.artifact_ref), original);
        };
        for (const mutate of [
          () => fs.writeFileSync(carrier, Buffer.concat([originalCarrier, Buffer.from(' ')])),
          () => { fs.rmSync(carrier, { force: true }); if (!present) fs.writeFileSync(carrier, originalCarrier); },
          () => fs.writeFileSync(carrier, '{'),
          () => fs.writeFileSync(carrier, Buffer.from([0xff])),
          () => fs.writeFileSync(carrier, 'x'.repeat(65537)),
          () => { fs.rmSync(carrier, { force: true }); fs.mkdirSync(carrier); },
          () => { fs.rmSync(carrier, { force: true }); fs.symlinkSync(path.join(f.project, '.planning/config.json'), carrier); },
        ]) {
          mutate(); stale(); restore(); assert.equal(current()?.artifact_digest, seal.artifact_digest);
        }
        const shadow = path.join(f.root, '.planning/phases', phase, 'code-review-disagreements.json');
        fs.mkdirSync(path.dirname(shadow), { recursive: true }); fs.writeFileSync(shadow, originalCarrier);
        fs.writeFileSync(carrier, Buffer.concat([originalCarrier, Buffer.from(' ')]));
        stale(); restore(); assert.equal(current()?.artifact_digest, seal.artifact_digest);
      } finally { if (runtime === 'codex') f.cleanup(); else claude.cleanupFixture(f); }
    }
  } finally {
    os.homedir = savedHome; process.env.PATH = savedPath;
    for (const [key, value] of markers) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

function partitionFixtureHelpers() {
  const Module = require('node:module');
  const filename = path.join(__dirname, 'phase49-incremental-integration.test.cjs');
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename; fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'node:test') return { test() {} };
    return load.call(this, name, ...args);
  };
  try {
    fixtureModule._compile(fs.readFileSync(filename, 'utf8')
      + '\nmodule.exports = { fixture, projectOptions, agent, commit, write, successfulReview, template, parent, child, cli, serialize };\n', filename);
  } finally { Module._load = load; }
  return fixtureModule.exports;
}
function partitionTestCapacity(changes = {}) {
  return { max_input_bytes: 8 * 1024 * 1024, unit_input_bytes: 256 * 1024, segment_bytes: 16 * 1024,
    output_reserve_tokens: 32000, tool_reserve_tokens: 10000,
    output_limits: { conclusions: 1024, findings: 2048, limitations: 1024, required_context: 1024, seams: 16384 },
    recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'native-exact' }, ...changes };
}
function partitionTestReview(f, helper, runtimeName = 'codex') {
  const delivery = require('../../plugins/delivery-pipeline/scripts/codex-delivery-host.cjs');
  const collector = require('../../plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
  const complete = require('../../plugins/delivery-pipeline/scripts/claude-role-host.cjs')
    .prepareNativeIntegratorContext(helper.projectOptions(f), { worktree: f.worktree, phase: '49' });
  const a = helper.agent(f, 'integrator', complete.signals);
  const instructions = collector.instructionEvidence(a.dir, a.selection.agent_file, a.manifest);
  const scope = { worktree: f.worktree, repository: complete.canonical.commonPath, phase: 49,
    ticket: complete.ticket, run_id: 'partition-original-' + ++f.count };
  const review = delivery.prepareIntegrationLineage(scope, complete, { ...helper.projectOptions(f), nativeRuntime: runtimeName,
    dispatchId: scope.run_id, storageRoot: path.join(f.root, 'partition-inputs'),
    generatedInstructionBytes: instructions.generated_instruction_bytes,
    instructionBinding: { agent_file: a.selection.agent_file, agent_path: path.join(a.dir, a.selection.agent_file),
      agent_sha256: instructions.sha256, installed_files: instructions.installed_files,
      policy_hash: a.selection.policy_hash } });
  return { review, a, scope };
}
async function partitionNativeFixture(f, helper, original, stage, result, dispatchId, mutateNative) {
  partitionAssertFixture(original, stage);
  if (stage.runtime === 'claude') return partitionClaudeNativeFixture(f, original, stage, result, dispatchId);
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const { a } = original;
  const prefix = runtime.generatedInstructions(a.text) + '\n\n';
  assert.ok(stage.input.startsWith(prefix), 'frozen input includes the actual static native instruction prefix');
  const scope = { ...original.scope, run_id: dispatchId };
  const session = crypto.randomUUID(), text = JSON.stringify(result);
  const pick = predicate => helper.template(helper.parent, predicate);
  const meta = pick(row => row.type === 'session_meta');
  Object.assign(meta.payload, { id: session, session_id: session, cwd: scope.worktree, runtime_workspace_roots: [scope.worktree] });
  const context = pick(row => row.type === 'turn_context');
  Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort, cwd: scope.worktree, workspace_roots: [scope.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
  const start = pick(row => row.payload?.type === 'task_started'), turn = start.payload.turn_id;
  context.payload.turn_id = turn;
  const developer = pick(row => row.type === 'response_item' && row.payload?.role === 'developer');
  developer.payload.content = [{ type: 'input_text', text: runtime.generatedInstructions(a.text) }];
  const user = pick(row => row.type === 'response_item' && row.payload?.role === 'user');
  user.payload.content = [{ type: 'input_text', text: stage.input }];
  const count = pick(row => row.payload?.type === 'token_count');
  const final = pick(row => row.type === 'response_item' && row.payload?.phase === 'final_answer');
  final.payload.content.forEach(block => { block.text = text; });
  final.payload.internal_chat_message_metadata_passthrough.turn_id = turn;
  const completion = pick(row => row.payload?.type === 'task_complete');
  Object.assign(completion.payload, { turn_id: turn, last_agent_message: text });
  const native = [meta, context, start, developer, user, count, final, completion];
  mutateNative?.(native);
  const now = new Date(), directory = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(directory, { recursive: true });
  const nativeFile = path.join(directory, session + '.jsonl');
  fs.writeFileSync(nativeFile, helper.serialize(native));
  const records = ['thread.started', 'turn.started', 'item.completed', 'turn.completed']
    .map(type => helper.template(helper.cli, row => row.type === type));
  records[0].thread_id = session; records[2].item.text = text;
  f.partitionRecorder ||= createDurableRecorder(path.join(f.root, 'partition-receipts'));
  const recorder = f.partitionRecorder;
  const host = runtime.createCodexRuntimeHost({ scope, recorder, capabilities: a.capabilities,
    env: { CODEX_HOME: process.env.CODEX_HOME }, transcriptDir: path.join(f.root, 'partition-transcripts'),
    probe: { status: 'available', executable: 'codex', runtime_version: 'fixture', capabilities: a.capabilities },
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = process.pid;
      let nativeInput = '';
      child.stdin = { write(value) { nativeInput += value; }, end() {
        assert.equal(nativeInput, stage.input, 'captured user input is the exact standard runtime stdin');
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from(helper.serialize(records))); child.emit('close', 0);
        });
      } };
      return child;
    } });
  f.partitionModelLaunches = (f.partitionModelLaunches || 0) + 1;
  const launched = await host.launchStatic({ model: a.selection.model, effort: a.selection.effort,
    sandbox_mode: 'read-only', agent_file: a.selection.agent_file, agent_file_content: a.text, agent_file_digest: hash(a.text) },
  { dispatch_id: dispatchId, prompt: stage.input.slice(prefix.length) });
  const adapter = require('../../plugins/delivery-pipeline/scripts/codex-dispatch-adapter.cjs').createCodexDispatchAdapter({
    agentsDir: a.dir, agentManifest: a.manifest,
    host: { requireRuntimeEvidence: true, launchStatic: () => launched }, capabilities: a.capabilities });
  const dispatched = createDispatchBoundary({ adapters: { codex: adapter }, recorder }).dispatch({ runtime: 'codex', role: 'integrator',
    dispatch_id: dispatchId, signals: original.review.prepared.signals }, { ticket: scope.ticket });
  return { recorder, dispatched, nativeFile, result };
}
async function partitionClaudeNativeFixture(f, original, stage, result, dispatchId) {
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { createClaudeRuntimeHost } = require('../../plugins/delivery-pipeline/scripts/claude-runtime-host.cjs');
  const { createClaudeDispatchAdapter } = require('../../plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs');
  const { capture } = require('../../plugins/delivery-pipeline/scripts/claude-agent-start-hook.cjs');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/captured/boundaries/claude-stream.json')));
  const streamPath = registry.fixtures.find(file => file.endsWith('/claude-stream-research.jsonl'));
  assert.ok(streamPath, 'registered original Claude stream is required');
  const templates = fs.readFileSync(path.resolve(__dirname, '../..', streamPath), 'utf8').trim().split('\n')
    .map(JSON.parse).filter(row => !row.shipyard_fixture);
  const template = predicate => structuredClone(templates.find(predicate));
  const serialize = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
  const session = crypto.randomUUID(), transcriptDir = path.join(f.root, 'partition-claude', dispatchId);
  const recorder = f.partitionRecorder;
  const runtime = createClaudeRuntimeHost({ scope: { ...original.scope, run_id: dispatchId }, recorder,
    transcriptDir, uuid: () => session, startEvidenceFile: path.join(transcriptDir, 'session-start.json'),
    sessionTranscriptRoot: path.join(f.root, 'partition-claude-native'),
    probe: { status: 'available', executable: 'claude-fixture', runtime_version: registry.cli_version,
      capabilities: { assistantTranscriptEvidence: true, restrictedTools: true, sandboxedBash: true } },
    spawn(_file, args) {
      f.partitionModelLaunches = (f.partitionModelLaunches || 0) + 1;
      const child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      let framed = '';
      child.stdin = { write(raw) { framed += raw; }, end() { process.nextTick(() => {
        try {
          const user = JSON.parse(framed.trim());
          assert.equal(user.message.content, stage.input);
          const model = args[args.indexOf('--model') + 1], effort = args[args.indexOf('--effort') + 1];
          const init = template(row => row.type === 'system' && row.subtype === 'init');
          Object.assign(init, { session_id: session, model, cwd: f.worktree });
          const assistant = template(row => row.type === 'assistant'); assistant.session_id = session;
          assistant.message.model = model === 'sonnet' ? 'claude-sonnet-5' : model === 'fable' ? 'claude-fable-5' : model;
          assistant.message.content[0].input = result;
          const final = template(row => row.type === 'result');
          Object.assign(final, { session_id: session, is_error: false, structured_output: result, result: JSON.stringify(result) });
          const file = path.join(f.root, 'partition-claude-native/project', session + '.jsonl');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, serialize([{ ...user, sessionId: session }, { ...structuredClone(assistant), sessionId: session, effort }]));
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
          const hook = settings.hooks.SessionStart[0].hooks[0].args;
          const value = name => hook[hook.indexOf(name) + 1];
          capture({ hook_event_name: 'SessionStart', source: 'startup', session_id: session, transcript_path: file, cwd: f.worktree },
            { evidenceFile: value('--evidence-file'), expectedSession: value('--expected-session') });
          child.stdout.emit('data', Buffer.from(serialize([init, assistant, final]))); child.emit('close', 0, null);
        } catch (error) { child.emit('error', error); }
      }); } };
      return child;
    } });
  const adapter = createClaudeDispatchAdapter({ capabilities: runtime.capabilities, host: {
    async launch(selection) { return runtime.applicationEvidence({ result: await runtime.agent(stage.input, selection) }); },
  } });
  const dispatched = await createDispatchBoundary({ adapters: { claude: adapter }, recorder }).dispatch({
    runtime: 'claude', role: 'integrator', dispatch_id: dispatchId, signals: original.review.prepared.signals }, { ticket: stage.subject });
  assert.equal(dispatched.receipt.compliance, 'verified');
  return { recorder, dispatched, result };
}
function partitionFixtureRequest(helper, original, launch) {
  const runtime = require('../../plugins/delivery-pipeline/scripts/codex-runtime-host.cjs');
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const { a } = original;
  const meta = helper.template(helper.parent, row => row.type === 'session_meta');
  const context = helper.template(helper.parent, row => row.type === 'turn_context');
  Object.assign(context.payload, { model: a.selection.model, effort: a.selection.effort,
    cwd: launch.worktree, workspace_roots: [launch.worktree] });
  context.payload.sandbox_policy.type = 'read-only';
  Object.assign(context.payload.collaboration_mode.settings, { model: a.selection.model, reasoning_effort: a.selection.effort });
  const { turn_id, ...framing } = context.payload;
  const frame = launch.runtime === 'codex' ? {
    developers: [{ role: 'developer', content: [{ type: 'input_text', text: runtime.generatedInstructions(a.text) }] }],
    other_users: [], base_instructions: meta.payload.base_instructions || null, contexts: [framing],
  } : { developers: [], other_users: [], base_instructions: null, contexts: [] };
  return { schema: 'shipyard.integration-native-request.v1', runtime: launch.runtime, model: launch.model,
    effort: launch.effort, input: launch.input, instruction_sha256: launch.instruction_sha256,
    recipe_sha256: hash(stable(original.partitionRecipes.get(launch.plan_sha256))), frame, tools: [],
    native_payload: stable({ frame, tools: [], input: launch.input }) };
}
function partitionFixtureHost(f, helper, original, partitions, mutateEvidence) {
  const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  original.partitionRecipes ||= new Map();
  original.partitionRecipes.set(partitions.plan.plan_sha256, partitions.plan.capacity.recipe);
  f.partitionRecorder ||= createDurableRecorder(path.join(f.root, 'partition-receipts'));
  const source = 'behavior-only-fixture-' + partitions.plan.runtime;
  const directory = path.join(f.root, 'behavior-only-counter'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const retain = payload => {
    const raw = stable(payload), file = path.join(directory, hash(raw) + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, raw, { mode: 0o600 });
    const pin = { path: file, bytes: Buffer.byteLength(raw), sha256: hash(raw) };
    (f.partitionCounterPins ||= []).push(pin);
    return pin;
  };
  const host = roleArtifact.createIntegrationCapacityHost({ partitions, runtime: partitions.plan.runtime, recorder: f.partitionRecorder,
    counterSource: source + '-counter', windowSource: source + '-window',
    renderLaunch: launch => {
      const request = partitionFixtureRequest(helper, original, launch);
      mutateEvidence?.(request, 'request');
      return request;
    },
    readWindow: identity => {
      const captured = helper.template(helper.parent, row => row.payload?.type === 'token_count').payload.info;
      const evidence = { schema: 'shipyard.integration-runtime-window.v1', ...identity, source: source + '-window',
        evidence_id: source + '-window', window_tokens: captured.model_context_window, behavior_only: true };
      mutateEvidence?.(evidence, 'window');
      return retain(evidence);
    },
    measureInput: (request, identity) => {
      f.partitionCounterCalls = (f.partitionCounterCalls || 0) + 1;
      const captured = helper.template(helper.parent, row => row.payload?.type === 'token_count').payload.info;
      const evidence = { schema: 'shipyard.integration-input-measurement.v1', ...identity,
        runtime: request.runtime, model: request.model, source: source + '-counter',
        evidence_id: source + '-counter-' + identity.launch_sha256,
        input_tokens_upper_bound: captured.last_token_usage.input_tokens, behavior_only: true };
      mutateEvidence?.(evidence, 'measurement');
      return retain(evidence);
    } });
  if (!mutateEvidence) {
    original.partitionHosts ||= new Map();
    original.partitionHosts.set(partitions.plan.plan_sha256, host);
  }
  return host;
}
async function partitionAdmitFixture(f, helper, original, stage, mutateEvidence, partitions = original.partitions) {
  const host = !mutateEvidence && original.partitionHosts?.get(stage.plan_sha256)
    || partitionFixtureHost(f, helper, original, partitions, mutateEvidence);
  return roleArtifact.admitIntegrationCapacity({ prepared: stage, host });
}
function partitionAssertFixture(original, prepared, launch = prepared) {
  return roleArtifact.assertIntegrationAdmission({ prepared, launch, host: original.partitionHosts.get(prepared.plan_sha256) });
}
function partitionUnitFixtureResult(stage) {
  const { payload } = stage, unit = payload.assignment;
  return { schema: 'shipyard.integration-unit-result.v1', review_contract: roleArtifact.INTEGRATION_REVIEW_V3,
    kind: 'unit', runtime: payload.runtime, subject: payload.subject, plan_sha256: payload.plan_sha256,
    unit_id: unit.unit_id, input_sha256: stage.input_sha256, reviewed_identity: payload.reviewed_identity,
    completeness: 'complete', outcome: 'passed', blocking_count: 0,
    coverage: { primary_segments: unit.primary_segments, primary_obligation_ids: unit.primary_obligation_ids,
      support_segments: unit.support_segments, support_obligation_ids: unit.support_obligation_ids },
    conclusions: ['Every assigned primary range and logical obligation reviewed in this fixture.'], findings: [], limitations: [],
    seams: unit.seam_ids.map(id => ({ id, disposition: 'unresolved', rationale: 'Independent final must judge this cross-unit interaction.' })),
    required_context: [], evidence_markdown: 'Original fixture unit evidence; no phase authority.' };
}

function partitionPhaseFixtureResult(f, original, partitions, aggregate) {
  const { plan } = partitions, { review } = original;
  return { review_contract: roleArtifact.INTEGRATION_REVIEW_V3, kind: 'phase', runtime: plan.runtime,
    subject: plan.subject, plan_sha256: plan.plan_sha256, input_sha256: aggregate.input_sha256,
    reviewed_identity: plan.identity, completeness: 'complete', outcome: 'passed', summary: 'Independent final fixture seam and acceptance judgment.',
    phase: f.phase, head: f.head, head_tree: plan.identity.head_tree, base: 'origin/main', base_tree: plan.identity.base_tree,
    ticket_set: review.prepared.ticketSet, ticket_set_digest: plan.identity.ticket_set_digest, findings: [], blocking_count: 0,
    coverage: { ...aggregate.payload.coverage, seam_dispositions: plan.seams.map(seam => ({ id: seam.id,
      disposition: 'resolved', rationale: 'Independent final fixture evaluates complete acceptance and both sides of this seam.' })), limitations: [] },
    evidence_markdown: 'Separate original fixture final judgment over complete acceptance, verification and seams.' };
}

test('D-32 frozen full inventory, protected unit custody, restart and independent phase authority', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const crypto = require('node:crypto');
    const stable = require('../../plugins/delivery-pipeline/scripts/model-policy-internal.cjs').stableStringify;
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const prior = await helper.successfulReview(f, 'integrator', { legacy: true });
    const oldReceipt = prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt;
    const longSource = '// ' + 'é😀'.repeat(52000) + '\n// final exact tail Ω\n';
    helper.write(f.worktree, 'src/consumer.cjs', longSource);
    helper.commit(f, 'oversized UTF8 line and exact diff tail');
    const original = partitionTestReview(f, helper), { review } = original;
    const capacity = partitionTestCapacity();
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review: { ...review }, capacity }), /private/);
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review, capacity });
    const { plan } = partitions;
    assert.ok(plan.units.length > 1, 'complete rendered input budgets determine the unit count');
    assert.deepEqual(plan.units.map(unit => unit.unit_id), plan.units.map((_, index) => 'u' + String(index + 1).padStart(6, '0')));
    const authorityRoot = roleArtifact.archiveAuthorityDirectory(f.worktree);
    const planFile = path.join(authorityRoot, 'integration-plan-' + plan.plan_sha256 + '.json');
    const indexFile = path.join(authorityRoot, 'integration-units-' + plan.plan_sha256 + '.json');
    const originalPlanBytes = fs.readFileSync(planFile);
    assert.equal(fs.statSync(planFile).mode & 0o777, 0o600);
    const fields = ['schema', 'version', 'review_contract', 'runtime', 'subject', 'identity', 'original_packet_sha256',
      'material', 'obligations', 'units', 'seams', 'governing', 'producer_pins', 'instruction_pins', 'capacity'];
    const domain = Object.fromEntries(fields.map(field => [field, plan[field]]));
    assert.equal(hash(stable(domain)), plan.plan_sha256);
    const arrival = structuredClone(plan);
    arrival.capacity.admissions = [{ input_sha256: '1'.repeat(64) }];
    arrival.identity.receipts = [{ outcome: 'passed' }];
    arrival.units[0].unit_index_entries = [{ result: 'future' }];
    arrival.final_result = { outcome: 'passed' };
    assert.equal(roleArtifact.integrationPartitionPlanHash(arrival), plan.plan_sha256);
    const staticSource = structuredClone(plan); staticSource.producer_pins[0].sha256 = '0'.repeat(64);
    assert.notEqual(roleArtifact.integrationPartitionPlanHash(staticSource), plan.plan_sha256);
    const sources = plan.material.filter(source => source.content === longSource);
    assert.equal(sources.length, 1, 'equal complete source content is deduplicated');
    assert.ok(plan.material.some(source => source.content.includes('diff --git') && source.content.includes('final exact tail')));
    for (const source of plan.material) {
      const assigned = plan.units.flatMap(unit => unit.primary_segments).filter(segment => segment.source_id === source.source_id)
        .sort((a, b) => a.start_byte - b.start_byte);
      let cursor = 0;
      for (const segment of assigned) {
        assert.equal(segment.start_byte, cursor);
        const raw = Buffer.from(source.content).subarray(segment.start_byte, segment.end_byte);
        assert.equal(hash(raw), segment.sha256);
        assert.equal(Buffer.from(raw.toString('utf8')).compare(raw), 0);
        cursor = segment.end_byte;
      }
      assert.equal(cursor, source.bytes);
    }
    const ids = plan.units.flatMap(unit => unit.primary_obligation_ids);
    assert.equal(new Set(ids).size, plan.obligations.length);
    assert.deepEqual([...ids].sort(), plan.obligations.map(item => item.id).sort());
    const acceptance = plan.obligations.filter(item => /\/phase_contracts\/\d+\/acceptance\/\d+$/.test(item.pointer));
    const verification = plan.obligations.filter(item => /\/phase_contracts\/\d+\/verification\/\d+$/.test(item.pointer));
    assert.ok(acceptance.length >= 2 && verification.length >= 2);
    assert.equal(new Set(acceptance.map(item => item.id)).size, acceptance.length);
    assert.ok(acceptance.some((item, index) => acceptance.some((other, otherIndex) => index !== otherIndex && item.value === other.value)),
      'identical acceptance text at separate logical pointers stays separate');
    assert.ok(plan.units.every(unit => unit.governing_ids.length && unit.support_segments.length));
    assert.ok(plan.seams.some(seam => seam.uncertain && seam.rationale.includes('continuation')));
    assert.throws(() => roleArtifact.prepareIntegrationUnit({ partitions: JSON.parse(JSON.stringify(partitions)), unit_id: plan.units[0].unit_id, dispatch_id: 'copied' }), /private/);
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'premature-final' }), /all exact frozen units/);
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: partitions.reserved_template }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    const admittedPlanHash = plan.plan_sha256;
    const unitSessions = [];
    const stages = plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'partition-unit-' + ++f.count }));
    const host = original.partitionHosts.get(plan.plan_sha256);
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stages[0], launch: stages[0], host }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await partitionAdmitFixture(f, helper, original, stages[0]);
    assert.throws(() => partitionAssertFixture(original, stages[0]), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    for (const stage of stages.slice(1)) await partitionAdmitFixture(f, helper, original, stage);
    for (const [field, value] of [['dispatch_id', 'foreign-dispatch'], ['unit_id', 'u999999'], ['kind', 'phase'],
      ['plan_sha256', '0'.repeat(64)], ['verified_index_sha256', '0'.repeat(64)]]) {
      assert.throws(() => partitionAssertFixture(original, stages[0], { ...stages[0], [field]: value }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    }
    assert.equal(f.partitionModelLaunches || 0, 0, 'all exact units and reserved final are admitted without any model launch');
    for (const [index, unit] of plan.units.entries()) {
      const stage = stages[index];
      partitionAssertFixture(original, stage);
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: { ...stage, input: stage.input + 'altered' } }), /private/);
      const result = partitionUnitFixtureResult(stage);
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      const sealArgs = { prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result };
      if (index === 0) {
        const sourcePlan = path.join(f.worktree, f.rows['T-49-01'].plan), savedPlan = fs.readFileSync(sourcePlan);
        fs.appendFileSync(sourcePlan, '\n- Changed acceptance after the original unit launch.\n');
        assert.throws(() => roleArtifact.sealIntegrationUnit(sealArgs), /pin|changed|digest|stale/i);
        fs.writeFileSync(sourcePlan, savedPlan);
      }
      const altered = structuredClone(result);
      if (altered.coverage.primary_segments.length) altered.coverage.primary_segments.at(-1).end_byte--;
      else altered.coverage.primary_obligation_ids.pop();
      assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: altered }), /coverage|identity/);
      assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: { ...result,
        conclusions: ['x'.repeat(capacity.output_limits.conclusions + 1)] } }), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
      for (const change of [
        value => { value.unit_id = 'u999999'; },
        value => { value.plan_sha256 = '0'.repeat(64); },
        value => { value.runtime = 'claude'; },
        value => { value.coverage.primary_obligation_ids.push(value.coverage.primary_obligation_ids[0] || 'foreign'); },
        value => { value.coverage.support_segments = []; },
        value => { value.required_context = ['Missing governing support']; },
      ]) {
        const swapped = structuredClone(result); change(swapped);
        assert.throws(() => roleArtifact.sealIntegrationUnit({ ...sealArgs, result: swapped }), /identity|coverage|context/);
      }
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: { ...stage, input: stage.input + 'stale' } }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
      const sealed = roleArtifact.sealIntegrationUnit(sealArgs);
      unitSessions.push({ stage, native, sealed });
      assert.equal(sealed.artifact_kind, 'integration-unit');
      assert.ok(!fs.existsSync(path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md')));
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: unit.unit_id }).reference.artifact_sha256, sealed.artifact_digest);
      assert.throws(() => roleArtifact.sealIntegrationUnit(sealArgs), /cannot be overwritten/);
      assert.throws(() => roleArtifact.sealJudgment({ worktreePath: f.worktree, role: 'integrator', phase: f.phase,
        ticket: review.prepared.ticket, base: 'origin/main', recorder: native.recorder, dispatchId: stage.dispatch_id,
        result, ticketSet: review.prepared.ticketSet }), /unit results/);
      roleArtifact.assertArchiveInventory(f.worktree, review.archivePins, { partitions });
      assert.throws(() => roleArtifact.assertArchiveInventory(f.worktree, review.archivePins), /membership/);
      const recovered = roleArtifact.prepareIntegrationPartitions({ review, plan_sha256: plan.plan_sha256, capacity });
      assert.equal(recovered.plan.plan_sha256, admittedPlanHash);
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recovered, unit_id: unit.unit_id }).reference.artifact_sha256, sealed.artifact_digest);
      if (unit.unit_id === plan.units[0].unit_id) {
        const restarted = partitionTestReview(f, helper);
        const recoveredFromFreshProducer = roleArtifact.prepareIntegrationPartitions({ review: restarted.review, plan_sha256: plan.plan_sha256, capacity });
        assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recoveredFromFreshProducer, unit_id: unit.unit_id }).reference.artifact_sha256,
          sealed.artifact_digest, 'new private preparation reuses only the protected original same-plan unit');
      }
      assert.deepEqual(fs.readFileSync(planFile), originalPlanBytes, 'admissions/index/results never move frozen hash/bytes');
    }
    const first = unitSessions[0];
    assert.deepEqual(prior.recorder.getVerifiedRecord(prior.dispatched.dispatch_id).receipt, oldReceipt);
    assert.deepEqual(fs.readFileSync(prior.artifact), prior.original);
    for (const file of [indexFile, planFile]) {
      const saved = fs.readFileSync(file), envelope = JSON.parse(saved);
      if (file === indexFile) envelope.payload.entries.reverse(); else envelope.payload.plan.units[0].primary_obligation_ids.pop();
      envelope.mac = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
      assert.throws(() => roleArtifact.validateIntegrationUnit({ partitions, unit_id: first.stage.unit_id }), /HMAC|coverage|primary/);
      fs.writeFileSync(file, saved);
    }
    const firstBytes = fs.readFileSync(first.sealed.artifact_ref);
    fs.appendFileSync(first.sealed.artifact_ref, ' ');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'tampered-parts' }), /archive|bytes|digest|pin/i);
    fs.writeFileSync(first.sealed.artifact_ref, firstBytes);
    const outputPin = first.native.dispatched.receipt.runtime_evidence.transcript;
    const savedOutput = fs.readFileSync(outputPin.path);
    fs.appendFileSync(outputPin.path, ' ');
    assert.throws(() => roleArtifact.validateIntegrationUnit({ partitions, unit_id: first.stage.unit_id }), /stream|native|changed|bound/i);
    fs.writeFileSync(outputPin.path, savedOutput);
    const extra = path.join(path.dirname(first.sealed.artifact_ref), 'uncatalogued.md');
    fs.writeFileSync(extra, 'unrelated archive addition');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'unindexed-addition' }), /membership/);
    fs.unlinkSync(extra);
    const priorBytes = fs.readFileSync(prior.artifact); fs.appendFileSync(prior.artifact, ' ');
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'changed-history' }), /archive|bytes|digest|pin/i);
    fs.writeFileSync(prior.artifact, priorBytes);
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: review }), null, 'indexed units cannot become a current phase verdict');
    const aggregate = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'partition-final-' + ++f.count });
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: aggregate }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.ok(!aggregate.input.includes(longSource), 'final carries bounded conclusions and governing/acceptance, not whole raw product sources');
    assert.deepEqual(aggregate.payload.governing.filter(item => acceptance.some(accepted => accepted.id === item.id)), acceptance);
    await partitionAdmitFixture(f, helper, original, aggregate);
    partitionAssertFixture(original, aggregate);
    const phaseResult = partitionPhaseFixtureResult(f, original, partitions, aggregate);
    const unresolvedStage = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'unresolved-final-' + ++f.count });
    await partitionAdmitFixture(f, helper, original, unresolvedStage);
    const unresolvedResult = structuredClone(phaseResult); unresolvedResult.input_sha256 = unresolvedStage.input_sha256;
    unresolvedResult.coverage.seam_dispositions[0].disposition = 'unresolved';
    const unresolvedNative = await partitionNativeFixture(f, helper, original, unresolvedStage, unresolvedResult, unresolvedStage.dispatch_id);
    const failedEvidence = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(failedEvidence, unresolvedResult.evidence_markdown);
    const { evidence_markdown: failedMarkdown, ...unresolvedSealedResult } = unresolvedResult;
    assert.throws(() => roleArtifact.sealJudgment({ worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: plan.subject,
      base: 'origin/main', recorder: unresolvedNative.recorder, dispatchId: unresolvedStage.dispatch_id, result: unresolvedSealedResult,
      ticketSet: review.prepared.ticketSet, ticketSetDigest: plan.identity.ticket_set_digest, evidencePath: failedEvidence, integrationReview: review }), /unresolved seams/);
    const finalSession = await partitionNativeFixture(f, helper, original, aggregate, phaseResult, aggregate.dispatch_id);
    assert.ok(unitSessions.every(unit => unit.native.dispatched.receipt.runtime_evidence.session_id !== finalSession.dispatched.receipt.runtime_evidence.session_id));
    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(evidencePath, phaseResult.evidence_markdown);
    const { evidence_markdown: markdown, ...finalResult } = phaseResult;
    const finalArgs = { worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: plan.subject,
      base: 'origin/main', recorder: finalSession.recorder, dispatchId: aggregate.dispatch_id, result: finalResult,
      ticketSet: review.prepared.ticketSet, ticketSetDigest: plan.identity.ticket_set_digest, evidencePath, integrationReview: review };
    assert.throws(() => roleArtifact.sealJudgment({ ...finalArgs, recorder: first.native.recorder, dispatchId: first.stage.dispatch_id }),
      /unrelated final|fresh actual final|independent final/);
    const sealedFinal = roleArtifact.sealJudgment(finalArgs);
    const validated = roleArtifact.validateJudgmentManifest({ ...finalArgs, artifactPath: sealedFinal.artifact_ref, artifactDigest: sealedFinal.artifact_digest });
    assert.equal(validated.manifest.integration_partition.kind, 'phase');
    const currentArgs = { worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: review };
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs)?.authenticated, true);
    const installed = path.join(original.a.dir, original.a.selection.agent_file), installedBytes = fs.readFileSync(installed);
    fs.appendFileSync(installed, '\n# changed after final\n');
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(installed, installedBytes);
    const planPath = path.join(f.worktree, f.rows['T-49-01'].plan), acceptedBytes = fs.readFileSync(planPath);
    fs.appendFileSync(planPath, '\n- Changed acceptance without moving source HEAD.\n');
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(planPath, acceptedBytes);
    const graphFile = path.join(f.graphDir, 'tickets.json'), graphBytes = fs.readFileSync(graphFile);
    const movedGraph = JSON.parse(graphBytes); delete movedGraph.tickets['T-49-02'];
    fs.writeFileSync(graphFile, JSON.stringify(movedGraph));
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    fs.writeFileSync(graphFile, graphBytes);
    git(f.worktree, ['update-ref', 'refs/remotes/origin/main', f.head]);
    assert.equal(roleArtifact.currentIntegrationVerdict(currentArgs), null);
    git(f.worktree, ['update-ref', 'refs/remotes/origin/main', f.base]);
    assert.deepEqual(fs.readFileSync(planFile), originalPlanBytes);
  });
});

test('D-32 capacity refuses unknown and over-bound evidence before granting stage admission', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper);
    const capacity = partitionTestCapacity();
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity });
    const stage = roleArtifact.prepareIntegrationUnit({ partitions, unit_id: partitions.plan.units[0].unit_id, dispatch_id: 'capacity-unit' });
    await assert.rejects(partitionAdmitFixture(f, helper, original, stage, (evidence, kind) => {
      if (kind === 'window') delete evidence.window_tokens;
    }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    assert.throws(() => roleArtifact.createIntegrationCapacityHost({ partitions, runtime: 'codex', recorder: f.partitionRecorder }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stage, host: {},
      measurement: { method: 'native-exact', input_tokens_upper_bound: 1 }, window_tokens: 999999999 }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const negatives = [
      ['window', evidence => { evidence.runtime = 'claude'; }],
      ['window', evidence => { evidence.model = 'foreign'; }],
      ['window', evidence => { evidence.source = 'model-echo'; }],
      ['window', evidence => { evidence.window_tokens = 0; }],
      ['measurement', evidence => { evidence.runtime = 'claude'; }],
      ['measurement', evidence => { evidence.model = 'foreign'; }],
      ['measurement', evidence => { evidence.source = 'public-certificate'; }],
      ['measurement', evidence => { evidence.request_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.recipe_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.launch_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.plan_sha256 = '0'.repeat(64); }],
      ['measurement', evidence => { evidence.method = 'certified-upper-bound'; }],
      ['measurement', evidence => { evidence.input_tokens_upper_bound = 0; }],
      ['request', evidence => { evidence.input += 'not the original input'; }],
      ['request', evidence => { delete evidence.native_payload; }],
      ['request', evidence => { delete evidence.tools; }],
    ];
    for (const [target, mutate] of negatives) {
      await assert.rejects(partitionAdmitFixture(f, helper, original, stage, (evidence, kind) => {
        if (kind === target) mutate(evidence);
      }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN', target);
    }
    let changed = null;
    const owned = partitionFixtureHost(f, helper, original, partitions, (evidence, kind) => {
      if (kind === 'request') {
        if (changed === 'tools') evidence.tools.push({ name: 'unmeasured-tool' });
        if (changed === 'frame') evidence.frame.base_instructions = 'changed installed framing';
        if (changed === 'payload') evidence.native_payload += 'changed full payload';
      }
    });
    const admission = await roleArtifact.admitIntegrationCapacity({ prepared: stage, host: owned });
    for (const field of ['tools', 'frame', 'payload']) {
      changed = field;
      assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: stage, host: owned }),
        error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    }
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stage, host: structuredClone(owned) }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const windowFile = admission.window_evidence_pin.path, windowBytes = fs.readFileSync(windowFile);
    fs.appendFileSync(windowFile, ' ');
    changed = null;
    assert.throws(() => roleArtifact.assertIntegrationAdmission({ prepared: stage, launch: stage, host: owned }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    fs.writeFileSync(windowFile, windowBytes);
    assert.equal(f.partitionModelLaunches || 0, 0, 'unknown, foreign, stale and public evidence launches zero models');
    const over = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ output_reserve_tokens: 300000 }) });
    assert.notEqual(over.plan.plan_sha256, partitions.plan.plan_sha256, 'static reserve changes freeze a different plan');
    await assert.rejects(partitionAdmitFixture(f, helper, original, over.reserved_template, undefined, over), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
    const stale = structuredClone(stage); stale.input_sha256 = '0'.repeat(64);
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stale }), /private/);
    const changedRecipe = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'certified-upper-bound' } }) });
    assert.notEqual(changedRecipe.plan.plan_sha256, partitions.plan.plan_sha256);
    const bounded = await partitionAdmitFixture(f, helper, original, changedRecipe.reserved_template, undefined, changedRecipe);
    assert.equal(bounded.measurement.method, 'certified-upper-bound');
    assert.match(bounded.sources.counter, /behavior-only-fixture-codex-counter/);
    assert.equal(f.partitionModelLaunches || 0, 0, 'behavior-only counter transport never launches a measurement model');
    assert.throws(() => roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ unit_input_bytes: 1, segment_bytes: 1 }) }), error => error.code === 'INTEGRATION_INPUT_OVER_BOUND');
  });
});

test('D-32 Claude admits independent behavior-only non-model evidence and retains native unit/final custody', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper, 'claude');
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity: partitionTestCapacity() });
    const codex = partitionTestReview(f, helper, 'codex');
    const codexPartitions = codex.partitions = roleArtifact.prepareIntegrationPartitions({ review: codex.review, capacity: partitionTestCapacity() });
    const codexHost = partitionFixtureHost(f, helper, codex, codexPartitions);
    const stages = partitions.plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'claude-partition-' + ++f.count }));
    await assert.rejects(roleArtifact.admitIntegrationCapacity({ prepared: stages[0], host: codexHost }),
      error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    for (const target of ['window', 'measurement']) await assert.rejects(partitionAdmitFixture(f, helper, original, stages[0], (evidence, kind) => {
      if (kind === target) evidence.runtime = 'codex';
    }), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const bounded = roleArtifact.prepareIntegrationPartitions({ review: original.review,
      capacity: partitionTestCapacity({ recipe: { rendering: 'shipyard.integration-partition-render.v1', measurement: 'certified-upper-bound' } }) });
    const boundAdmission = await partitionAdmitFixture(f, helper, original, bounded.reserved_template, undefined, bounded);
    assert.equal(boundAdmission.runtime, 'claude'); assert.equal(boundAdmission.measurement.method, 'certified-upper-bound');
    const template = await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    assert.equal(template.runtime, 'claude'); assert.match(template.sources.window, /behavior-only-fixture-claude-window/);
    for (const stage of stages) await partitionAdmitFixture(f, helper, original, stage);
    assert.equal(f.partitionModelLaunches || 0, 0, 'Claude prelaunch measurement launches no native model session');
    const sessions = [];
    for (const stage of stages) {
      const result = partitionUnitFixtureResult(stage);
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      roleArtifact.sealIntegrationUnit({ prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result });
      sessions.push(native.dispatched.receipt.session_id);
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: stage.unit_id }).result.runtime, 'claude');
      const recovered = roleArtifact.prepareIntegrationPartitions({ review: original.review, plan_sha256: partitions.plan.plan_sha256 });
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions: recovered, unit_id: stage.unit_id }).result.runtime, 'claude');
      roleArtifact.assertArchiveInventory(f.worktree, original.review.archivePins, { partitions });
    }
    const aggregate = roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'claude-partition-final' });
    assert.throws(() => partitionAssertFixture(original, aggregate), error => error.code === 'INTEGRATION_CAPACITY_UNPROVEN');
    const actual = await partitionAdmitFixture(f, helper, original, aggregate);
    assert.equal(actual.verified_index_sha256, aggregate.payload.verified_index_sha256);
    assert.notEqual(actual.request_sha256, template.request_sha256, 'actual verified results require fresh final evidence');
    const result = partitionPhaseFixtureResult(f, original, partitions, aggregate);
    const native = await partitionNativeFixture(f, helper, original, aggregate, result, aggregate.dispatch_id);
    assert.ok(!sessions.includes(native.dispatched.receipt.session_id));
    assert.equal(f.partitionModelLaunches, stages.length + 1, 'exactly one native session per unit and one independent final');
    const evidencePath = path.join(f.worktree, '.planning/phases', f.phase, 'INTEGRATION.md');
    fs.writeFileSync(evidencePath, result.evidence_markdown);
    const { evidence_markdown, ...sealedResult } = result;
    const args = { worktreePath: f.worktree, role: 'integrator', phase: f.phase, ticket: partitions.plan.subject,
      base: 'origin/main', recorder: native.recorder, dispatchId: aggregate.dispatch_id, result: sealedResult,
      ticketSet: original.review.prepared.ticketSet, ticketSetDigest: partitions.plan.identity.ticket_set_digest,
      evidencePath, integrationReview: original.review };
    const sealed = roleArtifact.sealJudgment(args);
    assert.equal(roleArtifact.validateJudgmentManifest({ ...args, artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest }).manifest.integration_partition.kind, 'phase');
    assert.equal(roleArtifact.currentIntegrationVerdict({ worktreePath: f.worktree, head: f.head, baseName: 'main', baseCommit: f.base,
      graphDir: f.graphDir, headBranch: f.pr.headRefName, integrationReview: original.review })?.authenticated, true);
  });
});

for (const mode of ['incomplete', 'needs-fix']) test('D-32 authentic ' + mode + ' unit cannot supply aggregate authority', async () => {
  const helper = partitionFixtureHelpers();
  await helper.fixture(async f => {
    const original = partitionTestReview(f, helper);
    const partitions = original.partitions = roleArtifact.prepareIntegrationPartitions({ review: original.review, capacity: partitionTestCapacity() });
    await partitionAdmitFixture(f, helper, original, partitions.reserved_template);
    const stages = partitions.plan.units.map(unit => roleArtifact.prepareIntegrationUnit({ partitions,
      unit_id: unit.unit_id, dispatch_id: 'nonpassing-' + ++f.count }));
    for (const stage of stages) await partitionAdmitFixture(f, helper, original, stage);
    for (const stage of stages) {
      const result = partitionUnitFixtureResult(stage);
      if (mode === 'incomplete') {
        result.completeness = 'incomplete'; result.outcome = 'human-review-required'; result.required_context = ['Required context unavailable.'];
      } else {
        result.outcome = 'needs-fix'; result.blocking_count = 1;
        result.findings = [{ id: 'original-blocker', type: 'violation', blocking: true,
          summary: 'Fixture behavior violates acceptance.', evidence: 'Original assigned fixture source.' }];
      }
      const native = await partitionNativeFixture(f, helper, original, stage, result, stage.dispatch_id);
      roleArtifact.sealIntegrationUnit({ prepared: stage, recorder: native.recorder, dispatchId: stage.dispatch_id, result });
      assert.equal(roleArtifact.validateIntegrationUnit({ partitions, unit_id: stage.unit_id }).result.outcome, result.outcome);
    }
    assert.throws(() => roleArtifact.prepareIntegrationAggregate({ partitions, dispatch_id: 'invalid-pass' }), /incomplete, failing or context-blocked/);
  });
});

done();
