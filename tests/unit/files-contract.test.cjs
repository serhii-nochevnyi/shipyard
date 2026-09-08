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

// ── the verdict a base-merge that changed nothing does not have to buy again ──
//
// This is where "the same tree, a different sha" actually exists: the `cascade()`
// fixture holds the parent's work on the epic as a SQUASH, so the epic's commit
// is not an ancestor of the child while its CONTENT already is. Merging it in
// moves the commit graph and leaves the child's tree untouched — the exact shape
// measured on T-25-05, where the re-judgement cost ~150k tokens and changed
// nothing (ADR-006 D2).
//
// The proof is two object identities and `gate-trailer.cjs carry` computes both;
// base-merge only hands it the pre-merge head. A merge that brought content
// resolves to a different tree and is refused by construction, so this caller
// needs no judgement of its own — which is the reason it can call it at all.

const CARRY_W = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-carry-'));
process.on('exit', () => { try { fs.rmSync(CARRY_W, { recursive: true, force: true }); } catch { /* best effort */ } });

// A stub `gh` serving exactly the two calls a carry makes: read the PR, and
// rewrite its body. The body travels through FILES in both directions — it is
// multi-line by definition, and hand-escaping one through a shell would break
// the very input under test.
const CARRY_BIN = path.join(CARRY_W, 'bin');
const CARRY_VIEW = path.join(CARRY_W, 'pr-view.json');
const CARRY_EDIT = path.join(CARRY_W, 'edited-body.txt');
fs.mkdirSync(CARRY_BIN, { recursive: true });
fs.writeFileSync(path.join(CARRY_BIN, 'gh'), [
  '#!/usr/bin/env bash',
  'argv="$*"',
  'case "$argv" in',
  '  *"--json body,headRefOid"*) cat "$SHIPYARD_CARRY_VIEW" ;;',
  '  "pr edit"*)',
  '    prev=""',
  '    for a in "$@"; do',
  '      if [ "$prev" = "--body" ]; then printf \'%s\' "$a" > "$SHIPYARD_CARRY_EDIT"; fi',
  '      prev="$a"',
  '    done',
  '    echo "https://example/pr/9" ;;',
  '  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;',
  'esac',
  '',
].join('\n'));
fs.chmodSync(path.join(CARRY_BIN, 'gh'), 0o755);

const { parseGate, gateConform, gateKind } = require(path.join(SCRIPTS, 'gate-trailer.cjs'));

// The board is where the PR number comes from: no prompt has to learn a new flag
// for the carry to happen, and a project whose graph carries no delivery state
// simply gets the behaviour base-merge had before this existed.
function withBoard(proj, ticket, pr) {
  fs.writeFileSync(
    path.join(proj, '.planning', 'graph', 'delivery-state.json'),
    JSON.stringify({ [ticket]: { pr, status: 'pr-open' } })
  );
}

function carryFixture({ squashDiffers }) {
  const { proj, repo } = cascade({ files: ['src/child.ts'], childTouchesShared: false, squashDiffers });
  withBoard(proj, 'T-01-02', 9);
  const judgedHead = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  // What arch-review judged this branch against: the merge base with the base it
  // had at the time, which in a cascade is the PARENT's branch. Recorded as a
  // TREE, so it survives that branch being reaped.
  const mergeBase = git(repo, ['merge-base', 'parent', 'HEAD']).stdout.trim();
  const judgedBaseTree = git(repo, ['rev-parse', `${mergeBase}^{tree}`]).stdout.trim();
  const judgedTree = git(repo, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const body = 'Ticket: T-01-02\n\nProblem: a cascade step.\n\n'
    + `gate_status: arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green, `
    + `base_tree=${judgedBaseTree}, head=${judgedHead}`;
  fs.writeFileSync(CARRY_VIEW, JSON.stringify({
    number: 9, body, headRefOid: judgedHead, baseRefName: 'epic',
  }));
  try { fs.unlinkSync(CARRY_EDIT); } catch { /* not written yet */ }
  return { proj, repo, judgedHead, judgedTree, judgedBaseTree };
}

const baseMergeWithBoard = (proj, args) => spawnSync(process.execPath, [BASE_MERGE, ...args], {
  cwd: proj,
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${CARRY_BIN}${path.delimiter}${process.env.PATH}`,
    SHIPYARD_CARRY_VIEW: CARRY_VIEW,
    SHIPYARD_CARRY_EDIT: CARRY_EDIT,
  },
});
const edited = () => (fs.existsSync(CARRY_EDIT) ? fs.readFileSync(CARRY_EDIT, 'utf8') : null);

suite('base merge — a verdict survives a head move it provably covers');

test('a merge that changed nothing carries the verdict onto the new head', () => {
  const fx = carryFixture({ squashDiffers: false });

  const r = baseMergeWithBoard(fx.proj, ['T-01-02', '--worktree', fx.repo, '--base', 'epic', '--no-fetch', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);

  // The fixture must actually be the case under test: a new head sha over the
  // SAME tree. Without this the assertions below could be satisfied by a merge
  // that did nothing at all.
  const newHead = git(fx.repo, ['rev-parse', 'HEAD']).stdout.trim();
  assert.notStrictEqual(newHead, fx.judgedHead, 'the merge must move the head');
  assert.strictEqual(
    git(fx.repo, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), fx.judgedTree,
    'the merge must not move the tree'
  );

  // The body the PR carries after the merge, whether or not the carry rewrote
  // it. Read this way, the RED on base says the right thing: the trailer still
  // names the judged head, so the verdict reads `stale` for the head the branch
  // is now at and arch-review is owed again.
  const body = edited() || JSON.parse(fs.readFileSync(CARRY_VIEW, 'utf8')).body;
  const gate = parseGate(body);
  assert.ok(gate, `the PR carries no trailer at all:\n${body}`);
  assert.strictEqual(gateConform(gate, newHead), true, `the verdict does not cover the new head:\n${body}`);
  assert.strictEqual(gateKind(gate, fx.judgedHead), 'stale', 'the old head must no longer read conform');
  assert.strictEqual(gate.base_tree, fx.judgedBaseTree, 'the proof it was measured against is kept');
  assert.ok(!('checks' in gate), 'a green measured against the old base must not carry');
  assert.strictEqual(payload.carry && payload.carry.carried, true, `the carry was refused: ${r.stdout}`);
});

test('a merge that brought content refuses the carry and leaves the trailer alone', () => {
  // The same move, except the epic's squash differs from the parent branch —
  // review fixes landed in the parent's PR after the child branched. base-merge
  // takes that undeclared file from the base, so the tree moves and the verdict
  // is owed again. The refusal is by construction: the caller does not decide it.
  const fx = carryFixture({ squashDiffers: true });

  const r = baseMergeWithBoard(fx.proj, ['T-01-02', '--worktree', fx.repo, '--base', 'epic', '--no-fetch', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);

  assert.notStrictEqual(
    git(fx.repo, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), fx.judgedTree,
    'the fixture must actually bring content in'
  );
  assert.strictEqual(payload.carry && payload.carry.carried, false, `the carry was allowed: ${r.stdout}`);
  assert.ok(/tree/i.test(payload.carry.reason), `the refusal does not name the trees: ${payload.carry.reason}`);
  assert.strictEqual(edited(), null, `the trailer was rewritten anyway:\n${edited()}`);
});

test('no board, no carry — and the output the fixer reads is unchanged', () => {
  // base-merge is documented in ci-fix.md and review-fix.md and is run by hand
  // from a worktree whose project may have no delivery state at all. That path
  // must not grow a `gh` call, a failure, or a line of output it did not have.
  const { proj, repo } = cascade({ files: ['src/child.ts'], childTouchesShared: false, squashDiffers: true });
  const r = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).carry, null, 'nothing may be claimed about a verdict nobody can find');
  const human = run(BASE_MERGE, proj, ['T-01-02', '--worktree', repo, '--base', 'epic', '--no-fetch']);
  assert.ok(/already up to date|merged/.test(human.stdout), human.stdout + human.stderr);
  assert.ok(!/carr/i.test(human.stdout), `a carry was reported without one:\n${human.stdout}`);
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

  // Read the set as a BLOCK and take the quoted strings out of it, rather than
  // slicing to the first `]`. Reviewer-found on PR #46: the old
  // `\[([^\]]*)\]` broke on any formatting-only edit — a set wrapped across
  // lines, or one that grew a `// why` comment — and a contract test that a
  // reformat can silently defeat is not a contract. Line comments are stripped
  // first so a quoted word inside one cannot enter the vocabulary.
  const actionable = (sentinel.match(/const ACTIONABLE = new Set\(\[([\s\S]*?)\]\s*\)/) || [])[1];
  assert.ok(actionable, 'cannot find the sentinel ACTIONABLE set');
  const mustAppear = [
    ...actionable.replace(/\/\/[^\n]*/g, '').matchAll(/['"]([a-z][a-z-]*)['"]/g),
  ].map((m) => m[1]);
  assert.ok(mustAppear.length >= 4, 'cannot read the ACTIONABLE vocabulary out of sentinel.cjs');

  // As its own TOKEN, not as a substring. `includes('merge')` was satisfied by
  // `mergeStateStatus`, so the docs could stop naming the merge duty entirely and
  // the test would still pass — the one action it most needed to catch.
  const names = (a) => new RegExp(`(^|[^A-Za-z0-9_-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`);

  for (const [rel, text] of [[DELIVER_MD, readRepo(DELIVER_MD)], [SENTINEL_MD, readRepo(SENTINEL_MD)]]) {
    for (const a of mustAppear) {
      assert.ok(names(a).test(text), `${rel} never names the actionable duty action "${a}"`);
    }
    // The reverse direction: a duty name in the docs that the script cannot
    // emit. Checked over the words the docs present AS actions (backticked), so
    // ordinary prose is not scanned for a vocabulary it is not using — but over
    // ALL of them. The old alternation listed only the hyphenated ones, so
    // `merge`, `human`, `human-merge` and `parked` could be misspelt in the docs
    // with nothing to catch it; `human-merge` precedes `human` so the longer name
    // wins. `clear` is deliberately absent: it is `dispatch-record.cjs clear`,
    // not a duty answer.
    for (const m of text.matchAll(/`(wait-[a-z]+|base-merge|arch-review|ci-fix|review-fix|undraft|human-merge|human|merge|parked)`/g)) {
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
