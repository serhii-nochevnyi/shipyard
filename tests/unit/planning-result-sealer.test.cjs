'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  sealResearch,
  sealDecomposition,
  researchLineFailure,
  assertContained,
} = require('../../plugins/delivery-pipeline/scripts/planning-result-sealer.cjs');

function git(worktree, ...args) {
  return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
}

function researchFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sealer-research-'));
  const worktree = fs.realpathSync(root);
  git(worktree, 'init', '-q', '-b', 'main');
  git(worktree, 'config', 'user.name', 'Sealer Test');
  git(worktree, 'config', 'user.email', 'sealer-test@example.test');
  fs.writeFileSync(path.join(worktree, 'base.txt'), 'base\n');
  git(worktree, 'add', 'base.txt');
  git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const sourceRevision = git(worktree, 'rev-parse', 'HEAD');
  const invPath = path.join(worktree, '.planning', 'investigations', 'INV-SEAL');
  const artifactDir = path.join(invPath, 'research');
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, 'system-state.md');
  const content = '# system-state\n\nComplete command-backed evidence.\n';
  fs.writeFileSync(artifactPath, content);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sealer-archive-'));
  const policyHash = 'b'.repeat(64);
  const lines = {
    artifact: {
      role: 'research', subject: 'INV-SEAL:system-state', ticket: 'INV-SEAL:system-state',
      worktreePath: worktree, sourceRevision, repository: 'acme/shipyard', policyHash,
      artifactPath,
    },
    result: {
      id: 'system-state', status: 'completed', summary: 'completed system-state',
      artifact: { path: artifactPath, bytes: content.length, content_bytes: content.length, sha256, digest: sha256 },
    },
    record: { receipt: { compliance: 'verified', dispatch_id: 'dispatch-seal', policy_hash: policyHash } },
  };
  return {
    root, worktree, archiveRoot, lines, content, sha256,
    clean() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    },
  };
}

function sealFixtureLines(fixture, overrides = {}) {
  return sealResearch({
    root: fixture.archiveRoot, scope: { worktree: fixture.worktree },
    lines: fixture.lines, ...overrides,
  });
}

suite('T-40-10 — shared research and decomposition sealer');

test('sealResearch reproduces the pre-extraction research-result envelope', () => {
  const fixture = researchFixture();
  try {
    const sealed = sealFixtureLines(fixture);
    assert.equal(sealed.schema, 'shipyard.role-artifact.v1');
    assert.equal(sealed.envelope.schema, 'shipyard.research-result.v1');
    assert.equal(sealed.envelope.version, 1);
    assert.equal(sealed.envelope.role, 'research');
    assert.equal(sealed.envelope.subject, 'INV-SEAL:system-state');
    assert.equal(sealed.envelope.source_revision, fixture.lines.artifact.sourceRevision);
    assert.equal(sealed.envelope.repository, 'acme/shipyard');
    assert.equal(sealed.envelope.policy_hash, 'b'.repeat(64));
    assert.equal(sealed.envelope.status, 'completed');
    assert.equal(sealed.envelope.summary, 'completed system-state');
    assert.equal(sealed.envelope.artifact_index.sha256, fixture.sha256);
    assert.equal(sealed.envelope.evidence_index, sealed.envelope.artifact_index);
    assert.equal(sealed.artifact_index, sealed.envelope.artifact_index);
    assert.ok(fs.existsSync(sealed.artifact_index.path));
    assert.equal(fs.readFileSync(sealed.artifact_index.path, 'utf8'), fixture.content);
    assert.ok(Object.isFrozen(sealed));
    assert.ok(Object.isFrozen(sealed.envelope));
  } finally { fixture.clean(); }
});

const RESEARCH_REFUSAL_CASES = [
  ['RESEARCH_SUBJECT_INVALID', (f) => { f.lines.artifact.subject = 'not-a-subject'; }],
  ['RESEARCH_ROLE_INVALID', (f) => { f.lines.artifact.role = 'executor'; }],
  ['RESEARCH_TICKET_MISMATCH', (f) => { f.lines.artifact.ticket = 'INV-OTHER:system-state'; }],
  ['RESEARCH_LINE_MISSING', (f) => { f.lines.result = undefined; }],
  ['RESEARCH_LINE_MISMATCH', (f) => { f.lines.result.id = 'alternatives'; }],
  ['RESEARCH_STATUS_INVALID', (f) => { f.lines.result.status = 'in-progress'; }],
  ['RESEARCH_SUMMARY_TYPE_INVALID', (f) => { f.lines.result.summary = 42; }],
  ['RESEARCH_RECEIPT_MISSING', (f) => { f.lines.record.receipt = undefined; }],
  ['RESEARCH_RECEIPT_UNVERIFIED', (f) => { f.lines.record.receipt.compliance = 'pending'; }],
  ['RESEARCH_DISPATCH_ID_TYPE_INVALID', (f) => { f.lines.record.receipt.dispatch_id = 42; }],
  ['RESEARCH_DISPATCH_ID_MISSING', (f) => { f.lines.record.receipt.dispatch_id = ''; }],
  ['RESEARCH_WORKTREE_MISMATCH', (f) => { f.lines.artifact.worktreePath = fs.realpathSync(os.tmpdir()); }],
  ['RESEARCH_REVISION_MISMATCH', (f) => { f.lines.artifact.sourceRevision = 'f'.repeat(40); }],
  ['RESEARCH_POLICY_MISMATCH', (f) => { f.lines.artifact.policyHash = 'c'.repeat(64); }],
  ['RESEARCH_ARTIFACT_PATH_ESCAPE', (f) => { f.lines.artifact.artifactPath = path.join(f.worktree, 'base.txt'); }],
  ['RESEARCH_ARTIFACT_NOT_REGULAR', (f) => { f.lines.artifact.artifactPath = path.dirname(f.lines.artifact.artifactPath); }],
  ['RESEARCH_PRODUCER_MISMATCH', (f) => { f.lines.result.artifact.sha256 = 'a'.repeat(64); }],
];

test('each former folded research condition refuses with its own named code', () => {
  for (const [code, mutate] of RESEARCH_REFUSAL_CASES) {
    const fixture = researchFixture();
    try {
      mutate(fixture);
      assert.throws(
        () => sealFixtureLines(fixture),
        (error) => error.code === code,
        `expected code ${code}`,
      );
    } finally { fixture.clean(); }
  }
});

test('a symlinked research artifact refuses RESEARCH_ARTIFACT_SYMLINK', () => {
  const fixture = researchFixture();
  try {
    fs.unlinkSync(fixture.lines.artifact.artifactPath);
    fs.symlinkSync('/etc/hosts', fixture.lines.artifact.artifactPath);
    assert.throws(() => sealFixtureLines(fixture), (error) => error.code === 'RESEARCH_ARTIFACT_SYMLINK');
  } finally { fixture.clean(); }
});

test('an oversized research artifact refuses RESEARCH_ARTIFACT_TOO_LARGE', () => {
  const fixture = researchFixture();
  try {
    assert.throws(
      () => sealFixtureLines(fixture, { limits: { artifactMaxBytes: 4 } }),
      (error) => error.code === 'RESEARCH_ARTIFACT_TOO_LARGE',
    );
  } finally { fixture.clean(); }
});

test('an over-long research summary is bounded instead of refused', () => {
  const fixture = researchFixture();
  const said = [];
  const original = process.stderr.write.bind(process.stderr);
  try {
    fixture.lines.result.summary = 'x'.repeat(600);
    process.stderr.write = (chunk) => { said.push(String(chunk)); return true; };
    const sealed = sealFixtureLines(fixture);
    assert.equal(Array.from(sealed.envelope.summary).length, 500);
    assert.ok(said.some((line) => line.includes('RESEARCH_SUMMARY_TOO_LONG')));
  } finally {
    process.stderr.write = original;
    fixture.clean();
  }
});

test('researchLineFailure freezes the blocked partial-failure shape', () => {
  const sealedLines = [{ id: 'system-state' }, { id: 'alternatives' }];
  const failure = researchLineFailure({
    scope: { worktree: '/tmp/x' },
    sealed: sealedLines,
    failed: { line: 'constraints', code: 'RESEARCH_LINE_MISSING', cause: 'no result returned' },
  });
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.failed_line, 'constraints');
  assert.equal(failure.code, 'RESEARCH_LINE_MISSING');
  assert.equal(failure.cause, 'no result returned');
  assert.deepEqual(failure.sealed_lines, sealedLines);
  assert.ok(Object.isFrozen(failure));
  assert.ok(Object.isFrozen(failure.sealed_lines));
});

function decompositionFixture(fileCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sealer-decompose-'));
  const worktree = fs.realpathSync(root);
  const phaseDir = path.join(worktree, 'phase');
  fs.mkdirSync(phaseDir, { recursive: true });
  const files = [path.join(phaseDir, 'CONTEXT.md')];
  fs.writeFileSync(files[0], '# Context\n');
  for (let i = 1; i <= fileCount; i++) {
    const file = path.join(phaseDir, `40-0${i}-PLAN.md`);
    fs.writeFileSync(file, `# Plan ${i}\n`);
    files.push(file);
  }
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sealer-decompose-archive-'));
  const scope = {
    worktree, subject: 'phase=40;repository=acme/shipyard',
    sourceRevision: 'a'.repeat(40), repository: 'acme/shipyard', policyHash: 'b'.repeat(64),
    status: 'completed', summary: 'plans materialized',
  };
  return {
    root, worktree, archiveRoot, scope, files,
    clean() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    },
  };
}

test('sealDecomposition indexes every plan file sorted by path with correct digests', () => {
  const fixture = decompositionFixture(2);
  try {
    const envelope = sealDecomposition({ root: fixture.archiveRoot, scope: fixture.scope, plans: fixture.files });
    assert.equal(envelope.schema, 'shipyard.decomposition-result.v1');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.role, 'decomposition');
    assert.equal(envelope.subject, fixture.scope.subject);
    assert.equal(envelope.source_revision, fixture.scope.sourceRevision);
    assert.equal(envelope.repository, fixture.scope.repository);
    assert.equal(envelope.policy_hash, fixture.scope.policyHash);
    assert.equal(envelope.plan_count, 3);
    assert.equal(envelope.evidence_index, envelope.artifact_index);
    assert.ok(fs.existsSync(envelope.artifact_index.path));
    assert.ok(Object.isFrozen(envelope));
    const manifest = JSON.parse(fs.readFileSync(envelope.artifact_index.path, 'utf8'));
    assert.equal(manifest.entries.length, 3);
    assert.deepEqual(manifest.entries.map((entry) => entry.path), [...fixture.files].sort());
    for (const entry of manifest.entries) {
      assert.equal(entry.sha256, crypto.createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex'));
    }
  } finally { fixture.clean(); }
});

test('sealDecomposition rejects a symlinked plan file', () => {
  const fixture = decompositionFixture(1);
  try {
    const target = fixture.files[1];
    fs.unlinkSync(target);
    fs.symlinkSync('/etc/hosts', target);
    assert.throws(
      () => sealDecomposition({ root: fixture.archiveRoot, scope: fixture.scope, plans: fixture.files }),
      (error) => error.code === 'DECOMPOSITION_PLAN_SYMLINK',
    );
  } finally { fixture.clean(); }
});

test('sealDecomposition rejects an oversized plan file', () => {
  const fixture = decompositionFixture(1);
  try {
    fs.writeFileSync(fixture.files[1], Buffer.alloc(1024 * 1024 + 1, 'a'));
    assert.throws(
      () => sealDecomposition({ root: fixture.archiveRoot, scope: fixture.scope, plans: fixture.files }),
      (error) => error.code === 'DECOMPOSITION_PLAN_TOO_LARGE',
    );
  } finally { fixture.clean(); }
});

function containmentFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-sealer-containment-'));
  const worktree = fs.realpathSync(root);
  git(worktree, 'init', '-q', '-b', 'main');
  git(worktree, 'config', 'user.name', 'Containment Test');
  git(worktree, 'config', 'user.email', 'containment@example.test');
  fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'base\n');
  git(worktree, 'add', 'tracked.txt');
  git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  return { root, worktree, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('assertContained passes for a clean worktree and for a change at the allowed path', () => {
  const fixture = containmentFixture();
  try {
    assert.doesNotThrow(() => assertContained({
      worktree: fixture.worktree, allowed: [path.join(fixture.worktree, 'tracked.txt')],
    }));
    fs.writeFileSync(path.join(fixture.worktree, 'artifact.md'), 'ok\n');
    assert.doesNotThrow(() => assertContained({
      worktree: fixture.worktree, allowed: [path.join(fixture.worktree, 'artifact.md')],
    }));
  } finally { fixture.clean(); }
});

test('assertContained refuses CONTAINMENT_VIOLATION naming an extra changed path', () => {
  const fixture = containmentFixture();
  try {
    fs.writeFileSync(path.join(fixture.worktree, 'artifact.md'), 'ok\n');
    fs.writeFileSync(path.join(fixture.worktree, 'extra.md'), 'unexpected\n');
    assert.throws(
      () => assertContained({ worktree: fixture.worktree, allowed: [path.join(fixture.worktree, 'artifact.md')] }),
      (error) => error.code === 'CONTAINMENT_VIOLATION' && error.message.includes('extra.md'),
    );
  } finally { fixture.clean(); }
});

test('assertContained treats an allowed directory as containing every path beneath it', () => {
  const fixture = containmentFixture();
  try {
    const dir = path.join(fixture.worktree, 'phase');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'CONTEXT.md'), '# context\n');
    fs.writeFileSync(path.join(dir, 'PLAN.md'), '# plan\n');
    assert.doesNotThrow(() => assertContained({ worktree: fixture.worktree, allowed: [dir] }));
  } finally { fixture.clean(); }
});

done();
