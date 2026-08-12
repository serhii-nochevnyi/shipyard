'use strict';

// `files_modified` is the conveyor's parallel-safety contract, and until now
// nothing checked it against what a branch actually did. Gate 2 validates the
// DECLARATION; the did-work gate checks that COMMITS EXIST; the question both
// are about — did this branch change what it said it would — went unasked. Run
// by hand against a live project the answer was three PRs carrying other
// people's files, two of them dangerous.
//
// The same contract decides how a moved base is merged in: a conflict in a file
// the ticket does not declare is a stale snapshot and the base wins; a conflict
// in a file it DOES declare is real work and needs judgement. Keying on the
// declaration rather than on "not my file" is what keeps a child that
// legitimately edits a shared file from having that work silently discarded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPTS = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts');
const SCOPE = path.join(SCRIPTS, 'scope-gate.cjs');
const BASE_MERGE = path.join(SCRIPTS, 'base-merge.cjs');

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const run = (script, cwd, args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

// A repo shaped like the cascade: parent branch, child branched off it, and an
// epic that has the parent's work as a SQUASH — a different SHA with the same
// content, which is exactly why the child then conflicts.
function cascade({ files, childTouchesShared = true, squashDiffers = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-files-'));
  const proj = path.join(dir, 'proj');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(proj, '.planning', 'graph'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.planning', 'graph', 'tickets.json'),
    JSON.stringify({ tickets: { 'T-01-02': { phase: '1', files } } })
  );

  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@e']);
  git(repo, ['config', 'user.name', 'T']);
  const w = (p, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), body);
  };

  w('src/parent.ts', 'base\n');
  w('shared/tools.ts', 't1\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'init']);
  git(repo, ['branch', '-q', 'epic']);

  git(repo, ['checkout', '-qb', 'parent']);
  w('src/parent.ts', 'parent-work\n');
  w('shared/tools.ts', 't1+parent\n');
  git(repo, ['commit', '-qam', 'parent']);

  git(repo, ['checkout', '-qb', 'child']);
  w('src/child.ts', 'child\n');
  if (childTouchesShared) w('shared/tools.ts', 't1+parent+child\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'child']);

  git(repo, ['checkout', '-q', 'epic']);
  git(repo, ['merge', '--squash', 'parent']);
  // A squash that differs from the branch it came from — review fixes landed in
  // the parent's PR after the child branched. This is what makes an UNDECLARED
  // file genuinely conflict rather than merge silently.
  if (squashDiffers) w('src/parent.ts', 'parent-work+review\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'squash: parent']);
  git(repo, ['checkout', '-q', 'child']);

  return { proj, repo };
}

suite('scope gate — the diff must stay inside files_modified');

test('a path outside the declaration blocks the PR', () => {
  const { proj, repo } = cascade({ files: ['src/child.ts'] });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'stray']);
  const r = run(SCOPE, proj, ['T-01-02', '--worktree', repo, '--base', 'parent']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(/package\.json/.test(r.stderr), r.stderr);
  // The remedy is a decision, and saying so is the difference between a gate and
  // an obstacle: a run told only "blocked" retries or works around it.
  assert.ok(/escalate|re-plan/i.test(r.stderr), 'the failure must name the two legitimate outcomes');
});

test('a diff wholly inside the declaration passes', () => {
  const { proj, repo } = cascade({ files: ['src/child.ts', 'shared/**'] });
  const r = run(SCOPE, proj, ['T-01-02', '--worktree', repo, '--base', 'parent']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('merging the moved base in is what narrows the diff to this ticket', () => {
  // Before the merge, a child retargeted onto the epic legitimately carries its
  // parent's commits: the merge base is still the point they both branched from,
  // so the three-dot diff includes the parent's files and the gate says so. That
  // is not a false positive — it is the stale merge base, which is the actual
  // problem a rebase is usually reached for. Merging the base in moves the merge
  // base forward and the diff narrows by itself.
  const { proj, repo } = cascade({
    files: ['src/child.ts'], childTouchesShared: false, squashDiffers: true,
  });

  const before = run(SCOPE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic']);
  assert.strictEqual(before.status, 1, 'a stale merge base shows the parent\'s work as ours');
  assert.ok(/src\/parent\.ts/.test(before.stderr), before.stderr);

  const merged = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch']);
  assert.strictEqual(merged.status, 0, merged.stdout + merged.stderr);

  const after = run(SCOPE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic']);
  assert.strictEqual(after.status, 0, 'after the merge the diff is this ticket\'s own work:\n' + after.stderr);
});

suite('base merge — the moved base comes in, and the rule resolves it');

test('an UNDECLARED conflicting file is taken from the base and the merge lands', () => {
  const { proj, repo } = cascade({
    files: ['src/child.ts'], childTouchesShared: false, squashDiffers: true,
  });
  const r = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(
    fs.readFileSync(path.join(repo, 'src/parent.ts'), 'utf8'), 'parent-work+review\n',
    'the base edition wins for a file the ticket does not own'
  );
  assert.strictEqual(git(repo, ['status', '--porcelain']).stdout.trim(), '', 'the merge is committed');
});

test('a DECLARED conflicting file is left for judgement, nothing committed', () => {
  const { proj, repo } = cascade({ files: ['src/child.ts', 'shared/tools.ts'] });
  const r = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(/shared\/tools\.ts/.test(r.stderr), r.stderr);
  // The case that makes the rule safe: a child legitimately editing a file its
  // parent also touched. "Take the base" would erase its work, so the rule keys
  // on the declaration, not on whose file it looks like.
  assert.ok(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'the merge stays in progress for a human');
});

test('refuses to start on a dirty worktree rather than merging over local work', () => {
  const { proj, repo } = cascade({ files: ['src/child.ts'] });
  fs.writeFileSync(path.join(repo, 'src/child.ts'), 'uncommitted\n');
  const r = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(/uncommitted/i.test(r.stderr), r.stderr);
});

done();
