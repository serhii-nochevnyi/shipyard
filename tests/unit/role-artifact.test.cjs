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
const selectionArgs = require.main === module ? process.argv.slice(2) : [];
const d37Only = selectionArgs.includes('--code-review-d37-only');
const reuseOnly = selectionArgs.includes('--code-review-reuse-only');
if (selectionArgs.some(value => !['--code-review-d37-only', '--code-review-reuse-only'].includes(value)) || selectionArgs.length > 1)
  throw new Error('Unknown code-review D37 selection');
let d37Selected = 0, reuseSelected = 0;
const d37Case = name => [
  'code-review lineage survives real fix-ticket membership changes and keeps reuse exact',
  'sealed disagreements retain their original target through three rounds and twin ordinal shifts',
  'code-review reuse refuses a moved base or reference contract and ticket-form subject',
].includes(name) || name.startsWith('existing-format foreign native input retains original planning pins: ');
let pendingCase = Promise.resolve();
function test(name, callback) {
  if (d37Case(name)) d37Selected++;
  if (name === 'code-review reuse refuses a moved base or reference contract and ticket-form subject') reuseSelected++;
  if (d37Only && !d37Case(name) || reuseOnly && name !== 'code-review reuse refuses a moved base or reference contract and ticket-form subject') return;
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
    adapters: { claude: { launch: resolution => judgmentReceipt(resolution) } },
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

function archivedFixture() {
  const value = judgmentFixture('T-47-01');
  value.root = fs.realpathSync(value.root);
  sealArchReview(value, archReviewResult(value, { verdict: 'conform', blocking_count: 0 }));
  value.rows = [{ worktree: value.root, pins: roleArtifact.authenticatedArchivePins(value.root) }];
  return value;
}

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
  const value = archived ? archivedFixture() : fixture();
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
  } finally { clean(value); }
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
  assert.equal((source.match(/phaseSubjectFields\(/g) || []).length, 6, 'definition plus the architecture and code-review phase-record sites and authenticated lineage readers');
  assert.equal((source.match(/parseSubject\('integrator'/g) || []).length >= 2, true);
  assert.equal((source.match(/resolveCodexHome\(/g) || []).length, 2);
  assert.equal((source.match(/resolveCodexHome\(\{ scriptDir: __dirname, env: process\.env \}\)/g) || []).length, 2,
    'both Codex session sites follow the executing bundle like every converted site');
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
      fs.writeFileSync(path.join(f.root, '.planning/phases', f.phase, 'code-review-disagreements.json'), file);
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
  const f = withOriginalPlanning(reviewFixture());
  try {
    const binding=f.advance(1);
    const historicalRoot = path.join(f.root, '.planning/historical-reference');
    fs.cpSync(path.join(__dirname, '../../plugins/delivery-pipeline'), historicalRoot, { recursive: true });
    fs.appendFileSync(path.join(historicalRoot, 'references/code-review.md'), '\nChanged reference\n');
    const reference = require(path.join(historicalRoot, 'scripts/claude-reference-content.cjs')).loadClaudeReferenceContent('code-review');
    const fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
    const input = fixtures.retainPlanningInput(f, f.input(binding), f.root, null, { reference });
    const historical = require(path.join(historicalRoot, 'scripts/role-artifact.cjs'));
    const historicalRecorder = require(path.join(historicalRoot, 'scripts/dispatch-boundary.cjs')).createDurableRecorder(path.join(f.root, 'receipts'));
    const sealed = historical.sealJudgment({ ...input, recorder: historicalRecorder });
    assert.equal(historical.currentCodeReviewVerdict({ worktreePath: f.root, pr: 52, head: input.result.head,
      baseName: 'main', baseCommit: f.base, graphDir: f.graphDir, headBranch: f.branch }).artifact_digest, sealed.artifact_digest);
    assert.equal(f.lookup(),null);
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


for (const changed of ['plan', 'config', 'transcript'])
  test('existing-format foreign native input retains original planning pins: ' + changed, () => {
    const f = foreignCodeReviewArchive();
    try {
      const plan = f.graph.tickets['T-52-01'].plan;
      const fixtures = require('../fixtures/code-review/artifact-fixture.cjs');
      fixtures.retainPlanningInput(f, f.input, f.coordinator, 'acme/app', { transport: 'inline' });
      const native = f.recorder.getVerifiedRecord(f.input.dispatchId).receipt.selection_evidence.transcript;
      const transcript = native.path;
      assert.equal(f.input.result.host_context, undefined);
      const seal = roleArtifact.sealJudgment(f.input);
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

test('code-review carrier freshness authentic canonical lifecycle on both runtimes', async () => {
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
    for (const runtime of ['codex', 'claude']) for (const present of [false, true]) {
      const f = runtime === 'codex' ? codex.fixture() : claude.coordinatorOnlyPlanning('code-review');
      try {
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
        } else {
          const options = claude.hostOptions(f, { originalStream: true, onLaunch(prompt) {
            assert.ok(!prompt.includes('<AUTHENTICATED_FOCUSED_INPUT>'));
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

assert.equal(d37Selected, 6, 'exact role-artifact D37 registration');
assert.equal(reuseSelected, 1, 'exact role-artifact reuse registration');
done();
