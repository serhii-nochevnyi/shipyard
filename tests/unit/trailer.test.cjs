'use strict';

// The `gate_status:` trailer gained a second key — `degenerate-green=clean|<n>`,
// the detector's report — and the whole point of the change is that NOTHING
// merges differently because of it.
//
// That compatibility holds BY CONSTRUCTION: the trailer reader takes the last
// line matching `^gate_status:` and splits it on commas into key=value parts, so
// an unknown part is simply another entry in the map and the merge gate only
// ever asks for `arch-review`. A compatibility that holds by construction is the
// kind nobody notices breaking — which is exactly why it is pinned here rather
// than asserted in a comment. This repository's standing lesson is that prose
// rules get skipped and mechanical gates hold; "reporting only" written above a
// function is the claim, not the guarantee.
//
// The decisive assertion is EQUIVALENCE, not "does not throw": the verdict
// computed from a body carrying the new key must EQUAL the verdict from a body
// without it. Two properties keep that from being vacuous:
//
//   1. Every equivalence test first asserts that the BASELINE actually reaches
//      the verdict under test (`would_merge`, `action: 'merge'`). Two runs that
//      both refuse for the same unrelated reason — a stub that answered wrongly,
//      say — are deep-equal too, and would pass an unguarded comparison while
//      comparing nothing.
//   2. A negative control drives the same comparison to `notDeepStrictEqual`
//      with a body the gate must refuse. If the comparison could not tell two
//      different verdicts apart, that control fails.
//
// `gh` is stubbed: this is about our parsing and our verdicts, not about GitHub.
// The merge path is driven with `--dry-run --json`, which returns the verdict
// object the guard would have acted on without touching a real PR.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SENTINEL = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'sentinel.cjs');

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-trailer-'));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── a stub gh that answers exactly the calls the merge gate and duty make ────
// The PR view is served from a FILE whose path arrives by environment variable,
// never interpolated into the stub as text: a PR body is multi-line by
// definition, and hand-escaping one into JSON inside a shell heredoc breaks
// silently — which would corrupt the very input under test.
const BIN = path.join(W, 'bin');
fs.mkdirSync(BIN, { recursive: true });
const GH = path.join(BIN, 'gh');
fs.writeFileSync(GH, [
  '#!/usr/bin/env bash',
  'argv="$*"',
  'case "$argv" in',
  '  "repo view --json defaultBranchRef"*) echo "main" ;;',
  // reviewers.cjs resolves the repo slug before it can read any thread.
  '  "repo view --json owner,name"*) echo \'{"owner":{"login":"acme"},"name":"demo"}\' ;;',
  '  "api graphql"*) echo \'{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\' ;;',
  // The merge gate re-reads the PR from live GitHub by design — this IS the body
  // under test.
  '  "pr view 9 --json"*) cat "$SHIPYARD_TRAILER_PRVIEW" ;;',
  '  "pr checks 9"*) echo \'[{"name":"build","state":"SUCCESS"}]\' ;;',
  // behindBy(): head...base, zero means the base has not moved.
  '  "api repos/{owner}/{repo}/compare/"*) echo 0 ;;',
  '  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;',
  'esac',
  '',
].join('\n'));
fs.chmodSync(GH, 0o755);

const PRVIEW = path.join(W, 'pr-view.json');

const GREEN_STATE = {
  status: 'pr-open',
  pr: 9,
  draft: false,
  checks: { total: 1, failing: 0, pending: 0, none_reported: false },
  merge_scope: 'stacked',
  pr_base: 'epic/01-x',
  epic: 'epic/01-x',
  branch: 'ticket/T-01-01-x',
};

function project(gate) {
  const root = fs.mkdtempSync(path.join(W, 'proj-'));
  const graph = path.join(root, '.planning', 'graph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'tickets.json'), JSON.stringify({
    epics: { 1: { branch: 'epic/01-x', repos: [null] } },
    tickets: {
      'T-01-01': {
        phase: '1', epic: 'epic/01-x', branch: 'ticket/T-01-01-x',
        title: 'root', depends_on: [], risk: 'low',
      },
    },
  }));
  fs.writeFileSync(
    path.join(graph, 'delivery-state.json'),
    JSON.stringify({ 'T-01-01': gate === undefined ? { ...GREEN_STATE } : { ...GREEN_STATE, gate } })
  );
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ pipeline: {} }));
  return root;
}

function run(root, args) {
  const r = spawnSync(process.execPath, [SENTINEL, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, SHIPYARD_TRAILER_PRVIEW: PRVIEW },
  });
  assert.strictEqual(r.status, 0, `sentinel ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`sentinel ${args.join(' ')} printed unparseable JSON (${e.message})\n${r.stdout}\n${r.stderr}`);
  }
}

// The merge verdict the guard would have acted on, for one PR body.
function mergeVerdict(body) {
  fs.writeFileSync(PRVIEW, JSON.stringify({
    number: 9,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'epic/01-x',
    headRefName: 'ticket/T-01-01-x',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    body,
  }));
  return run(project({ 'arch-review': 'conform' }), ['merge', 'T-01-01', '--dry-run', '--json']).results[0];
}

// `gate` is the PARSED trailer, so it legitimately differs between the two body
// forms — it is the thing being added. The VERDICT is everything else: whether
// the PR would land, and every refusal reason. That is what must be identical.
const verdictOf = (r) => { const { gate, ...rest } = r; return rest; };

const PREAMBLE = 'Ticket: T-01-01\n\nProblem: the trailer grew a key.\n\n';
const BARE = `${PREAMBLE}gate_status: arch-review=conform, drift-check=fresh, checks=green`;
const FINDINGS = `${PREAMBLE}gate_status: arch-review=conform, drift-check=fresh, degenerate-green=3, checks=green`;
const CLEAN = `${PREAMBLE}gate_status: arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green`;
// An extra part with no `=` at all — the shape a hand-written trailer produces.
const MALFORMED = `${PREAMBLE}gate_status: arch-review=conform, drift-check=fresh, degenerate-green, checks=green`;
const VIOLATION = `${PREAMBLE}gate_status: arch-review=violation, drift-check=fresh, degenerate-green=3, checks=green`;
// The key appended as its OWN trailer line instead of into the existing one.
const SECOND_LINE = `${BARE}\n\ngate_status: degenerate-green=3`;

suite('the merge gate: the degenerate-green key changes no verdict');

test('baseline — a conform trailer with no extra key would merge', () => {
  const bare = mergeVerdict(BARE);
  // Anti-vacuity for every equivalence test below: if the baseline does not
  // actually reach `would_merge`, two identical refusals would compare equal and
  // the comparison would be measuring nothing.
  assert.deepStrictEqual(bare.blockers, [], 'the baseline must not be refused');
  assert.strictEqual(bare.would_merge, true, 'the baseline must reach the merge verdict');
  assert.strictEqual(bare.gate['arch-review'], 'conform');
});

test('degenerate-green=<n> yields exactly the verdict of a body without it', () => {
  const bare = mergeVerdict(BARE);
  const withFindings = mergeVerdict(FINDINGS);
  assert.strictEqual(bare.would_merge, true, 'baseline must reach the verdict being compared');
  assert.deepStrictEqual(
    verdictOf(withFindings), verdictOf(bare),
    'reported findings must not change what the guard does'
  );
  assert.strictEqual(withFindings.gate['arch-review'], 'conform', 'the architecture verdict still reads');
  assert.strictEqual(withFindings.gate['degenerate-green'], '3', 'the new key is parsed, not swallowed');
});

test('degenerate-green=clean yields exactly the same verdict too', () => {
  const bare = mergeVerdict(BARE);
  const clean = mergeVerdict(CLEAN);
  assert.strictEqual(bare.would_merge, true, 'baseline must reach the verdict being compared');
  assert.deepStrictEqual(verdictOf(clean), verdictOf(bare), 'a clean report must not change the verdict either');
  assert.strictEqual(clean.gate['degenerate-green'], 'clean');
});

test('a malformed extra part is skipped and arch-review still reads conform', () => {
  const bare = mergeVerdict(BARE);
  const malformed = mergeVerdict(MALFORMED);
  assert.strictEqual(bare.would_merge, true, 'baseline must reach the verdict being compared');
  assert.deepStrictEqual(verdictOf(malformed), verdictOf(bare), 'a malformed extra part must not break the merge');
  assert.strictEqual(malformed.gate['arch-review'], 'conform');
  assert.ok(
    !('degenerate-green' in malformed.gate),
    'a part with no `=` is dropped, not recorded with an empty value'
  );
});

test('negative control — the comparison DOES separate two different verdicts', () => {
  // Without this the equivalence assertions above could be satisfied by a
  // comparison that cannot tell any two verdicts apart. `arch-review=violation`
  // carries the new key as well, so what changes the outcome is the
  // architecture verdict and nothing else.
  const bare = mergeVerdict(BARE);
  const violation = mergeVerdict(VIOLATION);
  assert.strictEqual(violation.would_merge, undefined, 'a non-conform trailer must not merge');
  assert.ok(
    violation.blockers.some((b) => b.includes('arch-review=conform')),
    `expected the missing-verdict refusal, got: ${violation.blockers.join('; ')}`
  );
  assert.notDeepStrictEqual(
    verdictOf(violation), verdictOf(bare),
    'the equivalence comparison must be able to fail'
  );
});

test('a SECOND gate_status line loses the architecture verdict and is refused', () => {
  // The reader takes the LAST matching line, so appending the report as its own
  // trailer line hides the one the gate reads. This is the mistake the writing
  // instruction exists to prevent: the key goes INTO the existing line.
  const second = mergeVerdict(SECOND_LINE);
  assert.strictEqual(second.would_merge, undefined, 'a shadowed trailer must not merge');
  assert.ok(
    second.blockers.some((b) => b.includes('arch-review=conform')),
    `expected the missing-verdict refusal, got: ${second.blockers.join('; ')}`
  );
  // `res.gate` is assigned only AFTER the conform check passes, so a refusal
  // reports no gate at all. Asserting the absence of a key inside `|| {}` would
  // pass against that empty object while claiming to be about last-line
  // parsing — which the two assertions above already pin: had the reader taken
  // the FIRST matching line, `arch-review=conform` would have been found and
  // this body would have merged.
  assert.strictEqual(second.gate, undefined, 'a refused merge reports no parsed gate');
});

suite('duty: the same key changes no action either');

test('baseline — a conform gate is a merge, with or without the extra key', () => {
  const bare = run(project({ 'arch-review': 'conform', 'drift-check': 'fresh' }), ['duty', '--json']);
  const withFindings = run(
    project({ 'arch-review': 'conform', 'drift-check': 'fresh', 'degenerate-green': '3' }),
    ['duty', '--json']
  );
  assert.strictEqual(bare.items[0].action, 'merge', 'baseline must reach the action being compared');
  assert.deepStrictEqual(withFindings, bare, 'the extra key must not change any duty');
});

test('negative control — duty DOES change when the architecture verdict does', () => {
  const bare = run(project({ 'arch-review': 'conform', 'drift-check': 'fresh' }), ['duty', '--json']);
  const violation = run(
    project({ 'arch-review': 'violation', 'drift-check': 'fresh', 'degenerate-green': '0' }),
    ['duty', '--json']
  );
  assert.strictEqual(violation.items[0].action, 'arch-review', 'a non-conform gate is unrecorded work');
  assert.notDeepStrictEqual(violation, bare, 'the duty comparison must be able to fail');
});

done();
