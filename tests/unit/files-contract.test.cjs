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

// ── the command docs must name only what the scripts implement ──────────────
//
// Prose that contradicts a mechanical gate teaches the reader to ignore the
// gate, and every rule below was prose before it was code. These are string
// contracts pinned against the scripts in the SAME checkout, which is the only
// way a doc claim can be checked at all: there is no behaviour here to unit-test.

const REPO = path.join(__dirname, '..', '..');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const SENTINEL_MD = 'plugins/delivery-pipeline/references/pr-sentinel.md';
const DELIVER_MD = 'plugins/delivery-pipeline/commands/deliver.md';

suite('command docs — the prose names only what the scripts implement');

test('the guard is never told to watch one PR\'s checks', () => {
  // A watch serializes the guard on ONE of the PRs it holds, which is the
  // opportunity cost `ci-wait.cjs` exists to avoid — and that script refuses
  // unless the board has no other move, so the ban is mechanical elsewhere.
  const lines = readRepo(SENTINEL_MD).split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /gh pr checks/.test(l) && /--watch/.test(l));
  assert.strictEqual(
    lines.length, 0,
    'pr-sentinel.md still tells the guard to watch a PR: ' + lines.map(([n, l]) => `${n}: ${l.trim()}`).join(' | ')
  );
});

test('every duty action the docs name is one sentinel.cjs can emit', () => {
  // The vocabulary is the script's. A doc naming an action `duty` never returns
  // sends the reader looking for work that cannot arrive; an action the docs do
  // not name arrives with nobody told how to serve it. T-24-06 added
  // `base-merge` and `wait-human`, and both were missing from the tables.
  const sentinel = readRepo('plugins/delivery-pipeline/scripts/sentinel.cjs');
  const emitted = new Set(
    [...sentinel.matchAll(/item\.action = '([a-z-]+)'/g)].map((m) => m[1])
  );
  assert.ok(emitted.size >= 8, 'cannot read the duty vocabulary out of sentinel.cjs');

  const actionable = (sentinel.match(/const ACTIONABLE = new Set\(\[([^\]]*)\]/) || [])[1];
  assert.ok(actionable, 'cannot find the sentinel ACTIONABLE set');
  const mustAppear = actionable
    .split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

  for (const [rel, text] of [[DELIVER_MD, readRepo(DELIVER_MD)], [SENTINEL_MD, readRepo(SENTINEL_MD)]]) {
    for (const a of mustAppear) {
      assert.ok(text.includes(a), `${rel} never names the actionable duty action "${a}"`);
    }
    // The reverse direction: a duty name in the docs that the script cannot
    // emit. Checked over the words the docs present AS actions (backticked and
    // hyphenated), so ordinary prose is not scanned for a vocabulary it is not
    // using.
    for (const m of text.matchAll(/`(wait-[a-z]+|base-merge|arch-review|ci-fix|review-fix|undraft)`/g)) {
      assert.ok(emitted.has(m[1]), `${rel} names duty action "${m[1]}", which sentinel.cjs cannot emit`);
    }
  }
});

test('the plugin and its capability carry the same version', () => {
  // They ship as one product: a bumped plugin over a stale capability installs a
  // gate from one release beside commands from another. `make test-overlay`
  // checks the same drift, but that target needs Docker — this one runs in the
  // fast suite, where a version bump is actually made.
  const plugin = JSON.parse(readRepo('plugins/delivery-pipeline/.claude-plugin/plugin.json'));
  const capability = JSON.parse(readRepo('capabilities/delivery-pipeline/capability.json'));
  assert.strictEqual(
    plugin.version, capability.version,
    `plugin.json is ${plugin.version} but capability.json is ${capability.version} — bump both together`
  );
  assert.ok(/^\d+\.\d+\.\d+$/.test(plugin.version), `not a plain semver: ${plugin.version}`);
});

done();
