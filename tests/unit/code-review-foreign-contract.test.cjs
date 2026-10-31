'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-contract-authority-')));
const homedir = os.homedir;
os.homedir = () => home;
process.on('exit', () => { os.homedir = homedir; fs.rmSync(home, { recursive: true, force: true }); });
const scripts = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const artifact = require(path.join(scripts, 'role-artifact.cjs'));
const core = require(path.join(scripts, 'code-review-core.cjs'));
const target = require(path.join(scripts, 'architecture-target.cjs'));
const { fixture, retainPlanningInput } = require('../fixtures/code-review/artifact-fixture.cjs');

function release(patches) {
  const Module = require('node:module');
  const file = path.join(scripts, 'role-artifact.cjs');
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to] of patches) {
    assert.ok(source.includes(from));
    source = source.split(from).join(to);
  }
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source, file);
  return loaded.exports;
}

function laterRelease() {
  const reference = path.join(fs.realpathSync(os.tmpdir()), 'later-code-review-' + process.pid + '.md');
  fs.writeFileSync(reference, fs.readFileSync(path.join(scripts, '../references/code-review.md'), 'utf8') + '\nA later instruction.\n');
  return release([["path.join(__dirname, '../references/code-review.md')", JSON.stringify(reference)]]);
}

const withoutCurrentAuthority = () => release([
  ['if (currentReview) manifest.current_review = currentReview;', ''],
  ['if (stable(manifest.current_review || null) !== stable(currentReview))', 'if (false)']]);

function history(reader, f) {
  return reader.priorCodeReviewVerdicts({ worktreePath: f.root, repository: target.repositoryIdentity(f.root),
    phaseDir: f.phase, graphDir: f.graphDir });
}

function current(reader, f, head) {
  return reader.currentCodeReviewVerdict({ worktreePath: f.root, pr: 52, head, baseName: 'main', baseCommit: f.base,
    graphDir: f.graphDir, headBranch: f.branch });
}

const roundsUsed = (prior, head) => core.nextRound({ priorVerdicts: prior, head, isAncestor: () => true }).rounds_used;

for (const runtime of ['claude', 'codex'])
test('a release with another contract skips a sealed ' + runtime + ' verdict: no round counts and the review is owed', () => {
  const f = fixture();
  try {
    const input = retainPlanningInput(f, f.input(f.advance(1)), f.root, null,
      { runtime, runtimeEvidence: runtime === 'codex' ? { review_continuation: { removed: true } } : undefined });
    artifact.sealJudgment(input);
    const head = input.result.head, later = laterRelease();
    assert.equal(history(artifact, f).length, 1);
    assert.equal(roundsUsed(history(artifact, f), head), 1);
    assert.ok(current(artifact, f, head));
    assert.deepEqual(history(later, f), []);
    assert.equal(roundsUsed(history(later, f), head), 0);
    assert.equal(current(later, f, head), null);
  } finally { f.cleanup(); fs.rmSync(path.join(fs.realpathSync(os.tmpdir()), 'later-code-review-' + process.pid + '.md'), { force: true }); }
});

for (const runtime of ['claude', 'codex'])
test('a verdict sealed without the current review authority is skipped: no round counts, status owed, gate closed: ' + runtime, () => {
  const flow = require(path.join(scripts, 'phase-code-review.cjs'));
  const f = fixture();
  try {
    f.graph.epics = { 52: { branch: f.branch, phaseDir: f.phase, repos: [null] } };
    Object.assign(f.graph.tickets['T-52-01'], { epic: f.branch, branch: 'feat/old-ticket', repo: null, phaseDir: f.phase });
    fs.writeFileSync(path.join(f.root, '.planning/config.json'), JSON.stringify({ git: { base_branch: 'main' } }));
    const input = retainPlanningInput(f, f.input(f.advance(1)), f.root, null, { runtime });
    const sealed = withoutCurrentAuthority().sealJudgment(input), head = input.result.head;
    assert.throws(() => artifact.validateJudgmentManifest({ ...input, artifactPath: sealed.artifact_ref,
      artifactDigest: sealed.artifact_digest }), { code: 'REVIEW_COVERAGE_INVALID' });
    assert.deepEqual(history(artifact, f), []);
    assert.equal(roundsUsed(history(artifact, f), head), 0);
    assert.equal(current(artifact, f, head), null);
    const live = { number: 52, state: 'OPEN', headRefName: f.branch, headRefOid: head, baseRefName: 'main', baseRefOid: f.base };
    const status = flow.status({ worktree: f.root, graphDir: f.graphDir, phase: 52, pr: 52, live }, { defaultBranch: 'main' });
    assert.equal(status.state, 'owed'); assert.equal(status.rounds_used, 0);
    assert.equal(flow.evaluateGate(status).ok, false);
  } finally { f.cleanup(); }
});

const changed = file => ({ status: 'M', old_path: file, new_path: file, additions: 1, deletions: 0, paths: [file] });
const reviewedPart = (ordinal, paths) => ({ id: 'part-' + ordinal, ordinal, paths, review_completeness: 'complete', limitations: [],
  unresolved_sources: [], summary: 'ok', findings: [], dispatch_id: 'd' + ordinal });

for (const runtime of ['claude', 'codex'])
test('sealing a ' + runtime + ' final refuses parts that do not cover every changed path exactly once', () => {
  const sealWith = parts => {
    const f = fixture();
    try {
      const input = retainPlanningInput(f, f.input(f.advance(1)), f.root, null,
        { runtime, parts, changes: [changed('a.js'), changed('b.js')] });
      return artifact.sealJudgment(input);
    } finally { f.cleanup(); }
  };
  assert.ok(sealWith([reviewedPart(1, ['a.js']), reviewedPart(2, ['b.js'])]).artifact_digest);
  for (const parts of [[reviewedPart(1, ['a.js'])], [reviewedPart(1, ['a.js']), reviewedPart(2, ['a.js', 'b.js'])]])
    assert.throws(() => sealWith(parts), { code: 'INVALID_RESULT' });
});
