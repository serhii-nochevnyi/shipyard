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

function laterRelease() {
  const Module = require('node:module');
  const file = path.join(scripts, 'role-artifact.cjs');
  const reference = path.join(fs.realpathSync(os.tmpdir()), 'later-code-review-' + process.pid + '.md');
  fs.writeFileSync(reference, fs.readFileSync(path.join(scripts, '../references/code-review.md'), 'utf8') + '\nA later instruction.\n');
  const source = fs.readFileSync(file, 'utf8');
  const marker = "path.join(__dirname, '../references/code-review.md')";
  assert.ok(source.includes(marker));
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(source.split(marker).join(JSON.stringify(reference)), file);
  return loaded.exports;
}

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
    const input = retainPlanningInput(f, f.input(f.advance(1)), f.root, null, { runtime });
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
